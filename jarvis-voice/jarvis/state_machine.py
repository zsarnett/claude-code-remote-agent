import asyncio
import logging
import time
from enum import Enum, auto

import numpy as np

from jarvis.audio_engine import AudioEngine
from jarvis.claude_bridge import ClaudeBridge
from jarvis.config import JarvisConfig
from jarvis.intent import IntentClassifier
from jarvis.events import (
    Error,
    SpeechEnd,
    StateChange,
    TextChunk,
    ToolEnd,
    ToolStart,
    TurnComplete,
    WakeWordDetected,
)
from jarvis.sentence_buffer import SentenceBuffer
from jarvis.stt import STT
from jarvis.tts import TTS
from jarvis.vad import VoiceActivityDetector
from jarvis.wake_word import WakeWordDetector

log = logging.getLogger(__name__)

# Hallucination phrases that Whisper produces on silence/noise
HALLUCINATION_PHRASES = {
    "you", "thanks for watching", "thank you", "bye",
    "the end", "thanks", "thank you for watching",
}


class State(Enum):
    IDLE = auto()
    LISTENING = auto()
    PROCESSING = auto()
    SPEAKING = auto()
    COOLDOWN = auto()


class StateMachine:
    """Central coordinator for the always-on voice interface."""

    def __init__(
        self,
        config: JarvisConfig,
        audio_engine: AudioEngine,
        wake_word: WakeWordDetector,
        vad: VoiceActivityDetector,
        stt: STT,
        bridge: ClaudeBridge,
        sentence_buffer: SentenceBuffer,
        tts: TTS,
        intent_classifier: IntentClassifier | None = None,
    ) -> None:
        self._config = config
        self._audio = audio_engine
        self._wake = wake_word
        self._vad = vad
        self._stt = stt
        self._bridge = bridge
        self._buf = sentence_buffer
        self._tts = tts
        self._intent = intent_classifier or IntentClassifier(config)

        self._state = State.IDLE
        self._running = False
        self._speech_frames: list[np.ndarray] = []
        self._listen_start: float = 0.0

    def _set_state(self, new_state: State) -> None:
        """Transition to a new state with logging."""
        old_state = self._state
        self._state = new_state
        elapsed = time.monotonic()
        log.info(
            "State: %s -> %s (at %.3f)",
            old_state.name, new_state.name, elapsed,
        )

    def _generate_ack_tone(self) -> np.ndarray:
        """Generate a short sine wave beep (440Hz, 100ms) as acknowledgment."""
        sample_rate = self._config.sample_rate
        duration = 0.1  # 100ms
        t = np.linspace(0, duration, int(sample_rate * duration), dtype=np.float32)
        tone = 0.3 * np.sin(2 * np.pi * 440 * t).astype(np.float32)

        # Apply a short fade in/out to avoid clicks
        fade_samples = int(sample_rate * 0.005)  # 5ms fade
        if fade_samples > 0 and len(tone) > 2 * fade_samples:
            tone[:fade_samples] *= np.linspace(0, 1, fade_samples, dtype=np.float32)
            tone[-fade_samples:] *= np.linspace(1, 0, fade_samples, dtype=np.float32)

        return tone

    async def run(self) -> None:
        """Main event loop."""
        self._running = True
        loop = asyncio.get_event_loop()

        print("Jarvis voice mode active. Listening for wake word...")
        log.info("State machine starting in IDLE state")

        self._audio.start()

        try:
            while self._running:
                if self._state == State.IDLE:
                    await self._handle_idle()
                elif self._state == State.LISTENING:
                    await self._handle_listening()
                elif self._state == State.PROCESSING:
                    await self._handle_processing()
                elif self._state == State.SPEAKING:
                    await self._handle_speaking()
                elif self._state == State.COOLDOWN:
                    await self._handle_cooldown()
        except KeyboardInterrupt:
            log.info("Keyboard interrupt received")
            print("\nGoodbye.")
        except Exception as exc:
            log.error("State machine error: %s", exc, exc_info=True)
        finally:
            self._running = False
            self._audio.stop()

    async def _handle_idle(self) -> None:
        """IDLE: Feed audio to wake word detector."""
        loop = asyncio.get_event_loop()

        # Use AEC-cleaned frames when available so wake word detection
        # is not confused by Jarvis's own voice during cooldown overlap.
        frame = await loop.run_in_executor(
            None, self._audio.get_frame_aec, 1280
        )
        if frame is None:
            await asyncio.sleep(0.01)
            return

        score = self._wake.process_frame(frame)

        if self._wake.detected(score):
            log.info("Wake word detected with score %.3f", score)
            print("Wake word detected!")

            # Play acknowledgment tone
            tone = self._generate_ack_tone()
            self._audio.play_audio_async(tone, self._config.sample_rate)

            # Prepare for listening
            self._speech_frames = []
            self._vad.reset()
            self._listen_start = time.monotonic()
            self._set_state(State.LISTENING)

    async def _handle_listening(self) -> None:
        """LISTENING: Record speech, use VAD to detect end of speech."""
        loop = asyncio.get_event_loop()

        frame = await loop.run_in_executor(
            None, self._audio.get_frame_aec, 1280
        )
        if frame is None:
            await asyncio.sleep(0.01)
            return

        # Accumulate audio for STT (keep as float32)
        self._speech_frames.append(frame.copy())

        # Feed to VAD in 512-sample chunks
        # frame is 1280 samples, split into chunks for VAD
        frame_float = frame.astype(np.float32) if frame.dtype != np.float32 else frame
        chunk_size = 512
        for i in range(0, len(frame_float), chunk_size):
            chunk = frame_float[i:i + chunk_size]
            if len(chunk) == chunk_size:
                self._vad.process_frame(chunk)

        # Check for speech end
        if self._vad.detect_speech_end(self._config.silence_threshold_ms):
            duration_ms = int((time.monotonic() - self._listen_start) * 1000)
            log.info("Speech ended after %d ms", duration_ms)
            print("Speech ended, processing...")
            self._set_state(State.PROCESSING)
            return

        # Check for listen timeout
        elapsed = time.monotonic() - self._listen_start
        if elapsed >= self._config.listen_timeout_s:
            log.info("Listen timeout after %.1f seconds", elapsed)
            if self._speech_frames:
                print("Listen timeout, processing what was captured...")
                self._set_state(State.PROCESSING)
            else:
                print("Listen timeout with no speech, returning to idle.")
                self._set_state(State.IDLE)

    async def _handle_processing(self) -> None:
        """PROCESSING: Transcribe speech and query Claude."""
        loop = asyncio.get_event_loop()

        if not self._speech_frames:
            log.warning("No speech frames to process")
            self._set_state(State.IDLE)
            return

        # Concatenate all speech frames
        audio = np.concatenate(self._speech_frames, axis=0)
        if audio.ndim > 1:
            audio = audio[:, 0]

        # Ensure float32 for Whisper
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        self._speech_frames = []

        duration = len(audio) / self._config.sample_rate
        log.info("Processing %.2f seconds of audio", duration)

        # STT
        t_stt_start = time.monotonic()
        result = await loop.run_in_executor(None, self._stt.transcribe, audio)
        t_stt = time.monotonic() - t_stt_start

        # Filter hallucinations
        if not result.text or result.text.strip().lower() in HALLUCINATION_PHRASES:
            log.info("No valid speech detected (hallucination filter)")
            print("No speech detected, returning to idle.")
            self._set_state(State.IDLE)
            return

        print(f"You: {result.text}")
        print(f"  [STT: {t_stt:.2f}s]")

        # Classify intent
        intent = self._intent.classify(result.text)
        # Voice mode: Haiku always responds first. If needs_opus, Opus
        # handles the query on the persistent bridge for deeper work.
        use_model = self._config.complex_model if intent.needs_opus else self._config.default_model
        use_effort = self._config.complex_effort if intent.needs_opus else self._config.default_effort
        log.info(
            "Intent: domain=%s needs_opus=%s model=%s filler=%s",
            intent.domain, intent.needs_opus, use_model, intent.play_filler,
        )

        # Play filler if needed (while waiting for Claude)
        if intent.play_filler:
            filler = self._tts.get_filler("thinking")
            if filler is not None:
                self._audio.play_audio_async(filler, 24000)
                while self._audio.is_playing:
                    await asyncio.sleep(0.05)

        # Query Claude and stream TTS with pipelined audio generation.
        # Architecture: sentences go into a queue. A background TTS task
        # generates audio for the next sentence while the current one plays.
        self._buf.reset()
        t_turn_start = time.monotonic()
        t_first_text = None
        t_first_audio = None
        full_response = ""
        barged_in = False

        self._set_state(State.SPEAKING)

        # Pipelined TTS: queue holds pre-generated audio arrays
        audio_queue: asyncio.Queue[np.ndarray | None] = asyncio.Queue(maxsize=3)

        async def tts_producer() -> None:
            """Generate TTS audio from sentences and enqueue results."""
            nonlocal t_first_audio
            sentence_queue: asyncio.Queue[str | None] = self._tts_sentence_queue
            while True:
                sentence = await sentence_queue.get()
                if sentence is None:
                    await audio_queue.put(None)
                    break
                try:
                    audio_out = await loop.run_in_executor(
                        None, self._tts.speak, sentence
                    )
                    if t_first_audio is None:
                        t_first_audio = time.monotonic() - t_turn_start
                    await audio_queue.put(audio_out)
                except Exception as exc:
                    log.warning("TTS generation error: %s", exc)

        async def audio_consumer() -> bool:
            """Play audio from the queue, checking for barge-in. Returns True if barged in."""
            while True:
                audio_out = await audio_queue.get()
                if audio_out is None:
                    return False
                self._audio.play_audio_async(audio_out, 24000)
                if await self._wait_playback_or_barge_in(loop):
                    return True
            return False

        # Sentence queue feeds the TTS producer
        self._tts_sentence_queue = asyncio.Queue()
        producer_task = asyncio.create_task(tts_producer())

        async for event in self._bridge.query(
            result.text,
            model=use_model,
            effort=use_effort,
        ):
            if barged_in:
                break

            match event:
                case TextChunk(text=text):
                    if t_first_text is None:
                        t_first_text = time.monotonic() - t_turn_start
                    full_response += text
                    self._buf.feed(text)

                    while True:
                        sentence = self._buf.get_sentence()
                        if sentence is None:
                            break
                        await self._tts_sentence_queue.put(sentence)

                case ToolStart(name=name):
                    print(f"  [Using tool: {name}]")
                    filler = self._tts.get_filler("checking")
                    if filler is not None and not self._audio.is_playing:
                        self._audio.play_audio_async(filler, 24000)

                case ToolEnd():
                    pass

                case TurnComplete(session_id=sid):
                    log.debug("Turn complete, session: %s", sid)

                case Error(message=msg):
                    print(f"  [Error: {msg}]")

        # Flush remaining text
        remainder = self._buf.flush()
        if remainder:
            await self._tts_sentence_queue.put(remainder)

        # Signal producer to stop
        await self._tts_sentence_queue.put(None)

        # Wait for all audio to play (consumer runs inline here)
        barged_in = await audio_consumer()
        await producer_task

        if barged_in:
            return

        t_total = time.monotonic() - t_turn_start

        if full_response:
            print(f"Jarvis: {full_response.strip()}")
        if t_first_text is not None and t_first_audio is not None:
            print(
                f"  [First text: {t_first_text:.2f}s | "
                f"First audio: {t_first_audio:.2f}s | "
                f"Total: {t_total:.2f}s]"
            )
        else:
            print(f"  [Total: {t_total:.2f}s]")

        self._set_state(State.COOLDOWN)

    async def _wait_playback_or_barge_in(
        self, loop: asyncio.AbstractEventLoop
    ) -> bool:
        """Wait for playback to finish while checking for barge-in.

        Returns True if barge-in was triggered, False if playback completed
        normally.
        """
        # Reset VAD so we get a clean speech-start measurement
        self._vad.reset()

        while self._audio.is_playing:
            # Get AEC-cleaned frame for barge-in detection
            frame = await loop.run_in_executor(
                None, self._audio.get_frame_aec, 512
            )
            if frame is not None:
                # Feed to VAD in 512-sample chunks
                chunk = frame[:512] if len(frame) >= 512 else frame
                self._vad.process_frame(chunk)

                if self._vad.detect_speech_start(
                    self._config.barge_in_threshold_ms
                ):
                    await self._handle_barge_in()
                    return True

            await asyncio.sleep(0.01)

        return False

    async def _handle_barge_in(self) -> None:
        """Handle barge-in: stop everything and transition to LISTENING."""
        log.info("Barge-in detected!")
        print("Barge-in! Listening...")

        self._audio.stop_playback()
        await self._bridge.interrupt()
        self._buf.reset()
        self._speech_frames = []
        self._vad.reset()
        self._listen_start = time.monotonic()

        # Play brief ack tone so user knows Jarvis heard them
        tone = self._generate_ack_tone()
        self._audio.play_audio_async(tone, self._config.sample_rate)

        self._set_state(State.LISTENING)

    async def _handle_speaking(self) -> None:
        """SPEAKING: Wait for TTS playback to finish.

        In practice, speaking is handled inline during PROCESSING.
        This state handles any remaining playback.
        """
        if self._audio.is_playing:
            await asyncio.sleep(0.05)
        else:
            self._set_state(State.COOLDOWN)

    async def _handle_cooldown(self) -> None:
        """COOLDOWN: Brief pause before returning to IDLE."""
        cooldown_s = self._config.cooldown_ms / 1000.0
        log.info("Cooldown for %.1f ms", self._config.cooldown_ms)
        await asyncio.sleep(cooldown_s)
        self._wake.reset()
        self._vad.reset()
        print("Listening for wake word...")
        self._set_state(State.IDLE)

    async def stop(self) -> None:
        """Graceful shutdown."""
        log.info("Stopping state machine")
        self._running = False
        self._audio.stop_playback()
        await self._bridge.interrupt()
        self._audio.stop()
