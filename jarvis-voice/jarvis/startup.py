"""Startup validation and info display."""

import logging
import shutil
import subprocess
from typing import Optional

from jarvis.config import JarvisConfig

log = logging.getLogger(__name__)


def check_prerequisites() -> list[str]:
    """Check that all prerequisites are met. Returns list of errors."""
    errors = []

    # Check claude CLI
    if not shutil.which("claude"):
        errors.append("claude CLI not found on PATH. Install it first.")

    # Check claude CLI authentication
    if shutil.which("claude"):
        try:
            result = subprocess.run(
                ["claude", "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode != 0:
                errors.append("claude CLI found but not working properly.")
        except subprocess.TimeoutExpired:
            errors.append("claude CLI timed out during version check.")
        except Exception as exc:
            errors.append(f"claude CLI check failed: {exc}")

    # Check audio devices
    try:
        import sounddevice as sd
        devices = sd.query_devices()
        has_input = any(
            d.get("max_input_channels", 0) > 0
            for d in devices
            if isinstance(d, dict)
        )
        if not has_input:
            errors.append("No input audio device found.")
    except ImportError:
        errors.append("sounddevice not installed.")
    except Exception as exc:
        errors.append(f"Audio device check failed: {exc}")

    return errors


def print_startup_info(config: JarvisConfig, mode: str) -> None:
    """Print startup configuration info."""
    print("=" * 50)
    print("  JARVIS VOICE ASSISTANT")
    print("=" * 50)
    print(f"  Mode: {mode}")
    print(f"  Model: {config.default_model} (complex: {config.complex_model})")
    print(f"  STT: Whisper {config.whisper_model}")
    print(f"  TTS: Kokoro ({config.tts_voice})")
    if mode == "voice":
        print(f"  Wake word: {config.wake_model} (threshold: {config.wake_threshold})")
        print(f"  Silence threshold: {config.silence_threshold_ms}ms")
    print("=" * 50)
    print()


def print_help_tips(mode: str) -> None:
    """Print available commands as help tips."""
    if mode == "push":
        print("  Tips:")
        print("    Press Enter to start/stop recording")
        print("    Ctrl+C to quit")
        print()
    else:
        print("  Tips:")
        print("    Say the wake word to activate")
        print("    Interrupt Jarvis by speaking (barge-in)")
        print("    Ctrl+C to quit")
        print()
