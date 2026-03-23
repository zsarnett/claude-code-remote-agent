import logging
import time

import numpy as np
import torch

log = logging.getLogger(__name__)


class VoiceActivityDetector:
    """Voice Activity Detector using Silero VAD."""

    def __init__(self, sample_rate: int = 16000) -> None:
        self._sample_rate = sample_rate
        self._model = None
        self._last_speech_prob = 0.0
        self._silence_start: float | None = None
        self._speech_start: float | None = None
        self._is_speech = False

    def preload(self) -> None:
        """Load the Silero VAD model."""
        log.info("Loading Silero VAD model...")
        self._model, _ = torch.hub.load(
            "snakers4/silero-vad", "silero_vad", trust_repo=True
        )
        log.info("Silero VAD model loaded")

    def _ensure_loaded(self) -> None:
        if self._model is None:
            self.preload()

    def process_frame(self, audio_frame: np.ndarray) -> float:
        """Process audio frame, return speech probability (0-1).

        Frame should be 512 samples (32ms) of float32 audio at 16kHz.
        """
        self._ensure_loaded()

        # Ensure float32
        if audio_frame.dtype != np.float32:
            audio_frame = audio_frame.astype(np.float32)

        tensor = torch.from_numpy(audio_frame)
        prob = self._model(tensor, self._sample_rate).item()
        self._last_speech_prob = prob

        now = time.monotonic()

        if prob >= 0.5:
            # Speech detected
            self._silence_start = None
            if not self._is_speech:
                if self._speech_start is None:
                    self._speech_start = now
            self._is_speech = True
        else:
            # Silence detected
            if self._is_speech and self._silence_start is None:
                self._silence_start = now
            self._speech_start = None

        return prob

    def detect_speech_end(self, min_silence_ms: int = 300) -> bool:
        """Check if silence has persisted long enough to indicate speech end.

        Call after each process_frame. Returns True when speech was active
        and then silence lasted at least min_silence_ms.
        """
        if not self._is_speech or self._silence_start is None:
            return False

        elapsed_ms = (time.monotonic() - self._silence_start) * 1000
        if elapsed_ms >= min_silence_ms:
            return True
        return False

    def detect_speech_start(self, min_speech_ms: int = 200) -> bool:
        """Check if speech has been sustained long enough (for barge-in).

        Call after each process_frame. Returns True when speech has been
        active for at least min_speech_ms continuously.
        """
        if self._speech_start is None:
            return False

        elapsed_ms = (time.monotonic() - self._speech_start) * 1000
        return elapsed_ms >= min_speech_ms

    def reset(self) -> None:
        """Reset internal state counters."""
        self._last_speech_prob = 0.0
        self._silence_start = None
        self._speech_start = None
        self._is_speech = False
        if self._model is not None:
            self._model.reset_states()
