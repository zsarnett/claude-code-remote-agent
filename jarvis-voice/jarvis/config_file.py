"""Default config file creation and management."""

import logging
from pathlib import Path

log = logging.getLogger(__name__)

DEFAULT_CONFIG = """\
# Jarvis Voice Assistant Configuration

# Audio settings
sample_rate: 16000
channels: 1

# Wake word
wake_model: "hey_jarvis_v0.1"
wake_threshold: 0.5

# Voice Activity Detection
silence_threshold_ms: 300
barge_in_threshold_ms: 200
listen_timeout_s: 10

# Speech-to-Text
whisper_model: "base.en"

# LLM
default_model: "haiku"
default_effort: "low"
complex_model: "opus"
complex_effort: "medium"

# Text-to-Speech
tts_voice: "am_michael"

# Sentence buffer
first_chunk_tokens: 6
max_chunk_tokens: 48

# Echo Cancellation
enable_aec: true
aec_filter_length: 2048
"""


def ensure_config() -> Path:
    """Create default config file if it doesn't exist.

    Returns the path to the config file.
    """
    config_dir = Path.home() / ".jarvis"
    config_file = config_dir / "config.yaml"
    if not config_file.exists():
        config_dir.mkdir(parents=True, exist_ok=True)
        config_file.write_text(DEFAULT_CONFIG)
        log.info("Created default config at %s", config_file)
        print(f"Created default config at {config_file}")
    return config_file
