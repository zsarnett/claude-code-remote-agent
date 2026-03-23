import collections
import logging
import queue
import threading
import time
from typing import Optional

import numpy as np
import sounddevice as sd

from jarvis.config import JarvisConfig

log = logging.getLogger(__name__)

# Try to import speexdsp for AEC; gracefully degrade if unavailable
try:
    from speexdsp import EchoCanceller
    _HAS_AEC = True
except ImportError:
    _HAS_AEC = False
    log.warning("speexdsp not available -- AEC disabled")


class AudioEngine:
    """Audio engine supporting both push-to-talk and continuous capture."""

    def __init__(self, config: Optional[JarvisConfig] = None) -> None:
        self._config = config or JarvisConfig()
        self._frames: list[np.ndarray] = []
        self._recording = False
        self._lock = threading.Lock()

        # Continuous capture state
        self._frame_queue: queue.Queue[np.ndarray] = queue.Queue(maxsize=200)
        self._stream: Optional[sd.InputStream] = None
        self._continuous = False

        # Playback state
        self._playback_lock = threading.Lock()
        self._playing = False
        self._playback_stop = threading.Event()

        # AEC state
        self._aec_enabled = self._config.enable_aec and _HAS_AEC
        self._aec: Optional[object] = None
        self._ref_buffer: collections.deque[np.int16] = collections.deque(
            maxlen=self._config.aec_filter_length
        )
        if self._aec_enabled:
            try:
                self._aec = EchoCanceller.new(
                    self._config.aec_frame_size,
                    self._config.aec_filter_length,
                )
                log.info(
                    "AEC initialized (frame_size=%d, filter_length=%d)",
                    self._config.aec_frame_size,
                    self._config.aec_filter_length,
                )
            except Exception as exc:
                log.warning("Failed to initialize AEC: %s", exc)
                self._aec_enabled = False
                self._aec = None

    # -- Push-to-talk (Phase 1) --

    def _audio_callback(
        self,
        indata: np.ndarray,
        frame_count: int,
        time_info: object,
        status: sd.CallbackFlags,
    ) -> None:
        """Sounddevice callback -- stores incoming audio frames."""
        if status:
            log.warning("Audio callback status: %s", status)
        with self._lock:
            if self._recording:
                self._frames.append(indata.copy())

    def record_until_key(self) -> np.ndarray:
        """Record audio until the user presses Enter. Returns float32 numpy array."""
        self._frames = []
        self._recording = True

        stream = sd.InputStream(
            samplerate=self._config.sample_rate,
            channels=self._config.channels,
            dtype="float32",
            blocksize=self._config.frame_size,
            callback=self._audio_callback,
        )

        try:
            stream.start()
            input()  # Block until Enter
        except EOFError:
            pass
        finally:
            self._recording = False
            stream.stop()
            stream.close()

        with self._lock:
            if not self._frames:
                log.warning("No audio frames captured")
                return np.array([], dtype=np.float32)
            audio = np.concatenate(self._frames, axis=0)

        # Flatten to 1D (mono)
        if audio.ndim > 1:
            audio = audio[:, 0]

        duration = len(audio) / self._config.sample_rate
        log.info("Captured %.2f seconds of audio", duration)
        return audio

    # -- Continuous capture (Phase 2) --

    def _continuous_callback(
        self,
        indata: np.ndarray,
        frame_count: int,
        time_info: object,
        status: sd.CallbackFlags,
    ) -> None:
        """Sounddevice callback for continuous capture -- enqueues frames."""
        if status:
            log.warning("Audio callback status: %s", status)
        try:
            # Flatten to 1D mono float32
            frame = indata[:, 0].copy() if indata.ndim > 1 else indata.copy().flatten()
            self._frame_queue.put_nowait(frame)
        except queue.Full:
            # Drop oldest frame to make room
            try:
                self._frame_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._frame_queue.put_nowait(frame)
            except queue.Full:
                pass

    def start(self) -> None:
        """Start continuous audio capture."""
        if self._continuous:
            return

        log.info("Starting continuous audio capture")
        # Clear the queue
        while not self._frame_queue.empty():
            try:
                self._frame_queue.get_nowait()
            except queue.Empty:
                break

        self._stream = sd.InputStream(
            samplerate=self._config.sample_rate,
            channels=self._config.channels,
            dtype="float32",
            blocksize=1280,  # 80ms frames for wake word compatibility
            callback=self._continuous_callback,
        )
        self._stream.start()
        self._continuous = True
        log.info("Continuous capture started")

    def stop(self) -> None:
        """Stop continuous audio capture."""
        if not self._continuous:
            return

        log.info("Stopping continuous audio capture")
        self._continuous = False
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        log.info("Continuous capture stopped")

    def get_frame(self, frame_size: int = 1280) -> Optional[np.ndarray]:
        """Get the next audio frame from the queue.

        Returns float32 numpy array of the requested size, or None if no
        data is available. Blocks for up to 100ms waiting for data.
        """
        try:
            frame = self._frame_queue.get(timeout=0.1)
            return frame
        except queue.Empty:
            return None

    # -- AEC processing --

    def _get_reference_chunk(self, size: int) -> np.ndarray:
        """Pull `size` samples from the reference buffer as int16.

        If not enough samples are available (no playback happening),
        returns zeros -- meaning no echo to cancel.
        """
        chunk = np.zeros(size, dtype=np.int16)
        available = min(size, len(self._ref_buffer))
        for i in range(available):
            chunk[i] = self._ref_buffer.popleft()
        return chunk

    def get_frame_aec(self, frame_size: int = 1280) -> Optional[np.ndarray]:
        """Get an AEC-cleaned audio frame.

        Reads a raw mic frame, processes it through the echo canceller
        in aec_frame_size chunks, and returns the cleaned float32 frame.

        Falls back to get_frame() if AEC is not available.
        """
        frame = self.get_frame(frame_size)
        if frame is None:
            return None

        if not self._aec_enabled or self._aec is None:
            return frame

        t_start = time.monotonic()

        # Convert mic frame from float32 to int16 for AEC
        mic_int16 = np.clip(frame * 32767, -32768, 32767).astype(np.int16)

        aec_chunk = self._config.aec_frame_size  # 256 samples
        cleaned_chunks: list[np.ndarray] = []

        for i in range(0, len(mic_int16), aec_chunk):
            mic_chunk = mic_int16[i:i + aec_chunk]
            if len(mic_chunk) < aec_chunk:
                # Pad the last chunk if needed
                padded = np.zeros(aec_chunk, dtype=np.int16)
                padded[:len(mic_chunk)] = mic_chunk
                mic_chunk = padded

            ref_chunk = self._get_reference_chunk(aec_chunk)

            try:
                cleaned = self._aec.cancel(
                    mic_chunk.tobytes(), ref_chunk.tobytes()
                )
                cleaned_arr = np.frombuffer(cleaned, dtype=np.int16)
                cleaned_chunks.append(cleaned_arr)
            except Exception as exc:
                log.debug("AEC cancel error: %s", exc)
                cleaned_chunks.append(mic_chunk)

        # Reassemble and convert back to float32
        result_int16 = np.concatenate(cleaned_chunks)[:len(frame)]
        result = result_int16.astype(np.float32) / 32767.0

        elapsed_ms = (time.monotonic() - t_start) * 1000
        if elapsed_ms > 10:
            log.debug("AEC processing took %.1f ms for %d samples", elapsed_ms, len(frame))

        return result

    # -- Playback --

    def _feed_reference(self, pcm: np.ndarray, sample_rate: int) -> None:
        """Feed playback PCM into the AEC reference buffer.

        Resamples to 16kHz int16 if needed, then pushes samples into the
        ring buffer so get_frame_aec() can use them as the reference signal.
        """
        if not self._aec_enabled:
            return

        # Convert to float32 first if not already
        if pcm.dtype != np.float32:
            ref = pcm.astype(np.float32)
        else:
            ref = pcm

        # Resample to 16kHz if playback sample rate differs
        if sample_rate != self._config.sample_rate and sample_rate > 0:
            from scipy.signal import resample as scipy_resample
            new_len = int(len(ref) * self._config.sample_rate / sample_rate)
            if new_len > 0:
                ref = scipy_resample(ref, new_len).astype(np.float32)

        # Convert float32 [-1, 1] to int16
        ref_int16 = np.clip(ref * 32767, -32768, 32767).astype(np.int16)

        # Push into ring buffer (extend is much faster than per-sample append)
        self._ref_buffer.extend(ref_int16.tolist())

    def play_audio_async(self, pcm: np.ndarray, sample_rate: int) -> None:
        """Play audio without blocking the caller.

        Starts playback in a background thread. Use is_playing to check
        status, and stop_playback() to interrupt. Also feeds the PCM
        into the AEC reference buffer.
        """
        if pcm.size == 0:
            return

        # Feed reference audio for AEC before playback starts
        self._feed_reference(pcm, sample_rate)

        self._playback_stop.clear()

        def _play() -> None:
            with self._playback_lock:
                self._playing = True
            try:
                sd.play(pcm, samplerate=sample_rate)
                # Poll for completion or stop signal
                while sd.get_stream().active:
                    if self._playback_stop.is_set():
                        sd.stop()
                        break
                    sd.sleep(50)
            except Exception as exc:
                log.warning("Playback error: %s", exc)
            finally:
                with self._playback_lock:
                    self._playing = False

        thread = threading.Thread(target=_play, daemon=True)
        thread.start()

    def stop_playback(self) -> None:
        """Interrupt any ongoing playback."""
        self._playback_stop.set()
        try:
            sd.stop()
        except Exception:
            pass
        with self._playback_lock:
            self._playing = False

    @property
    def is_playing(self) -> bool:
        """Whether audio is currently being played."""
        with self._playback_lock:
            return self._playing
