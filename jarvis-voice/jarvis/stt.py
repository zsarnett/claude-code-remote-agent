import logging
from typing import Optional

import numpy as np

from jarvis.config import JarvisConfig
from jarvis.events import TranscriptionResult

log = logging.getLogger(__name__)

# Map short model names to HuggingFace repo paths for mlx-whisper
_MLX_MODEL_MAP = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "tiny.en": "mlx-community/whisper-tiny.en-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "base.en": "mlx-community/whisper-base.en-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "small.en": "mlx-community/whisper-small.en-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "medium.en": "mlx-community/whisper-medium.en-mlx",
    "large": "mlx-community/whisper-large-v3-mlx",
}


class STT:
    """Whisper speech-to-text wrapper using mlx-whisper for Apple Silicon."""

    def __init__(self, config: Optional[JarvisConfig] = None) -> None:
        self._config = config or JarvisConfig()
        self._model_name = self._config.whisper_model
        self._hf_repo = _MLX_MODEL_MAP.get(
            self._model_name, f"mlx-community/whisper-{self._model_name}"
        )
        self._loaded = False

    def preload(self) -> None:
        """Pre-download the model so first transcription is fast."""
        import mlx_whisper

        log.info("Preloading mlx-whisper model: %s (%s)", self._model_name, self._hf_repo)
        # Run a tiny silent transcription to trigger download and warmup
        silence = np.zeros(16000, dtype=np.float32)
        mlx_whisper.transcribe(
            silence, path_or_hf_repo=self._hf_repo, language="en",
        )
        self._loaded = True
        log.info("mlx-whisper model loaded")

    def transcribe(self, audio: np.ndarray) -> TranscriptionResult:
        """Transcribe audio to text. Audio should be float32 at 16kHz."""
        import mlx_whisper

        if audio.size == 0:
            return TranscriptionResult(text="", confidence=0.0)

        if not self._loaded:
            self.preload()

        log.info(
            "Transcribing %.2f seconds of audio",
            len(audio) / 16000,
        )

        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self._hf_repo,
            language="en",
        )
        text = result.get("text", "").strip()

        segments = result.get("segments", [])
        if segments:
            avg_confidence = sum(
                s.get("avg_logprob", 0.0) for s in segments
            ) / len(segments)
        else:
            avg_confidence = 0.0

        log.info("Transcription: %s", text)
        return TranscriptionResult(text=text, confidence=avg_confidence)
