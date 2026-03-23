import logging
from dataclasses import dataclass, fields
from pathlib import Path

import yaml

log = logging.getLogger(__name__)

CONFIG_PATH = Path.home() / ".jarvis" / "config.yaml"


@dataclass
class JarvisConfig:
    sample_rate: int = 16000
    channels: int = 1
    frame_size: int = 256
    whisper_model: str = "base.en"
    default_model: str = "haiku"
    default_effort: str = "low"
    complex_model: str = "opus"
    complex_effort: str = "medium"
    workspace_dir: str = str(Path.home() / "Documents" / "ZacksWorkspace")
    wake_model: str = "hey_jarvis_v0.1"
    wake_threshold: float = 0.5
    silence_threshold_ms: int = 300
    barge_in_threshold_ms: int = 200
    listen_timeout_s: int = 10
    tts_voice: str = "am_michael"
    first_chunk_tokens: int = 6
    max_chunk_tokens: int = 48
    cooldown_ms: int = 500
    max_budget_usd: float = 1.0
    aec_filter_length: int = 2048  # samples (128ms echo tail)
    aec_frame_size: int = 256  # AEC processing chunk size
    enable_aec: bool = True  # Can disable AEC if it causes issues

    @classmethod
    def load(cls, path: "Path | None" = None) -> "JarvisConfig":
        """Load config from a YAML file if it exists, otherwise use defaults.

        Args:
            path: Config file path. Defaults to ~/.jarvis/config.yaml.
        """
        config_path = path or CONFIG_PATH
        if not config_path.exists():
            log.info("No config file at %s, using defaults", config_path)
            return cls()

        try:
            raw = yaml.safe_load(config_path.read_text())
            if not isinstance(raw, dict):
                log.warning("Config file is not a mapping, using defaults")
                return cls()

            valid_fields = {f.name for f in fields(cls)}
            filtered = {k: v for k, v in raw.items() if k in valid_fields}
            ignored = set(raw.keys()) - valid_fields
            if ignored:
                log.warning("Ignoring unknown config keys: %s", ignored)

            log.info("Loaded config from %s", config_path)
            return cls(**filtered)
        except Exception as exc:
            log.warning("Failed to load config from %s: %s", config_path, exc)
            return cls()
