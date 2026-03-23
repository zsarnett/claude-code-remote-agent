import logging
import os
import random
import urllib.request
from typing import Optional

import numpy as np
import sounddevice as sd

from jarvis.config import JarvisConfig

log = logging.getLogger(__name__)

CACHE_DIR = os.path.expanduser("~/.cache/kokoro-onnx")
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
MODEL_FILE = "kokoro-v1.0.onnx"
VOICES_FILE = "voices-v1.0.bin"

FILLER_PHRASES: dict[str, list[str]] = {
    "thinking": ["Let me think.", "One moment.", "Hmm, let me see."],
    "checking": ["Let me check on that.", "Checking now."],
    "working": ["Working on it.", "Give me a moment."],
    "hmm": ["Hmm.", "Alright."],
}


class TTS:
    """Kokoro ONNX text-to-speech wrapper."""

    def __init__(self, config: Optional[JarvisConfig] = None) -> None:
        self._config = config or JarvisConfig()
        self._voice = self._config.tts_voice
        self._kokoro = None
        self._sample_rate: int = 24000
        self._filler_cache: dict[str, list[np.ndarray]] = {}

    def _download_if_needed(self, url: str, filename: str) -> str:
        """Download a file to cache if it doesn't exist."""
        os.makedirs(CACHE_DIR, exist_ok=True)
        path = os.path.join(CACHE_DIR, filename)
        if not os.path.exists(path):
            log.info("Downloading %s...", filename)
            urllib.request.urlretrieve(url, path)
            log.info("Downloaded %s (%d bytes)", filename, os.path.getsize(path))
        return path

    def preload(self) -> None:
        """Download and load the Kokoro model."""
        from kokoro_onnx import Kokoro

        model_path = self._download_if_needed(MODEL_URL, MODEL_FILE)
        voices_path = self._download_if_needed(VOICES_URL, VOICES_FILE)

        log.info("Loading Kokoro TTS model...")
        self._kokoro = Kokoro(model_path, voices_path)
        log.info("Kokoro TTS model loaded")

        # Pre-render filler phrases so playback is instant
        self._prerender_fillers()

    def _prerender_fillers(self) -> None:
        """Pre-render all filler phrases to cache for instant playback."""
        log.info("Pre-rendering filler phrases...")
        for filler_type, phrases in FILLER_PHRASES.items():
            self._filler_cache[filler_type] = []
            for phrase in phrases:
                try:
                    samples, sr = self._kokoro.create(
                        phrase, voice=self._voice, speed=1.0
                    )
                    if samples.dtype != np.float32:
                        samples = samples.astype(np.float32)
                    self._filler_cache[filler_type].append(samples)
                    log.debug(
                        "Cached filler '%s' (%.2fs)",
                        phrase, len(samples) / sr,
                    )
                except Exception as exc:
                    log.warning("Failed to pre-render filler '%s': %s", phrase, exc)
        total = sum(len(v) for v in self._filler_cache.values())
        log.info("Pre-rendered %d filler phrases", total)

    def get_filler(self, filler_type: str) -> Optional[np.ndarray]:
        """Return a random cached filler audio clip, or None if unavailable."""
        clips = self._filler_cache.get(filler_type)
        if not clips:
            return None
        return random.choice(clips)

    def _ensure_loaded(self) -> None:
        """Ensure the model is loaded, loading if necessary."""
        if self._kokoro is None:
            self.preload()

    def speak(self, text: str) -> np.ndarray:
        """Generate audio from text. Returns float32 numpy array."""
        self._ensure_loaded()

        if not text.strip():
            return np.array([], dtype=np.float32)

        log.info("Generating TTS for: %s", text[:80])

        samples, sample_rate = self._kokoro.create(
            text, voice=self._voice, speed=1.0
        )
        self._sample_rate = sample_rate

        # Ensure float32
        if samples.dtype != np.float32:
            samples = samples.astype(np.float32)

        log.info(
            "Generated %.2f seconds of audio at %d Hz",
            len(samples) / sample_rate,
            sample_rate,
        )
        return samples

    def play_audio(self, audio: np.ndarray) -> None:
        """Play audio via sounddevice."""
        if audio.size == 0:
            return

        sd.play(audio, samplerate=self._sample_rate)
        sd.wait()
