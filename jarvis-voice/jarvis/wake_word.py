import logging

import numpy as np

log = logging.getLogger(__name__)


class WakeWordDetector:
    """Wake word detector using openwakeword with the hey_jarvis model."""

    def __init__(
        self, model_name: str = "hey_jarvis_v0.1", threshold: float = 0.5
    ) -> None:
        self._model_name = model_name
        self._threshold = threshold
        self._model = None

    def preload(self) -> None:
        """Load the wake word model."""
        from openwakeword import Model as OWWModel

        log.info("Loading wake word model: %s", self._model_name)
        self._model = OWWModel(
            wakeword_models=[self._model_name],
            inference_framework="onnx",
        )
        log.info("Wake word model loaded")

    def _ensure_loaded(self) -> None:
        if self._model is None:
            self.preload()

    def process_frame(self, audio_frame: np.ndarray) -> float:
        """Process a single frame and return the wake word score (0-1).

        audio_frame should be int16 numpy array, 1280 samples (80ms at 16kHz).
        """
        self._ensure_loaded()

        # openwakeword expects int16 audio, 1280 samples at a time
        if audio_frame.dtype != np.int16:
            # Convert float32 [-1, 1] to int16
            audio_frame = (audio_frame * 32767).astype(np.int16)

        prediction = self._model.predict(audio_frame)

        # prediction is a dict of model_name -> score
        # Find the score for our model (key may vary slightly)
        for key, score in prediction.items():
            if self._model_name in key or key in self._model_name:
                return float(score)

        # Fallback: return max score across all models
        if prediction:
            return float(max(prediction.values()))
        return 0.0

    def detected(self, score: float) -> bool:
        """Check if score exceeds threshold."""
        return score >= self._threshold

    def reset(self) -> None:
        """Reset the model's internal buffer state."""
        if self._model is not None:
            self._model.reset()
