import argparse
import asyncio
import logging
import time
import sys

from jarvis.audio_engine import AudioEngine
from jarvis.claude_bridge import ClaudeBridge
from jarvis.config import JarvisConfig
from jarvis.config_file import ensure_config
from jarvis.events import Error, TextChunk, ToolEnd, ToolStart, TurnComplete
from jarvis.sentence_buffer import SentenceBuffer
from jarvis.startup import check_prerequisites, print_help_tips, print_startup_info
from jarvis.stt import STT
from jarvis.tts import TTS

log = logging.getLogger(__name__)


async def run_push_loop(config: JarvisConfig, reset_session: bool = False) -> None:
    """Main push-to-talk loop (Phase 1)."""
    print("Loading models (this may take a moment on first run)...")

    engine = AudioEngine(config)
    stt = STT(config)
    tts = TTS(config)
    bridge = ClaudeBridge(config)
    sentence_buf = SentenceBuffer(
        first_chunk_tokens=config.first_chunk_tokens,
        max_chunk_tokens=config.max_chunk_tokens,
    )

    if reset_session:
        bridge.reset_session()
        print("  Session reset -- starting with fresh context.")

    # Preload models
    print("  Loading Whisper STT...")
    stt.preload()
    print("  Loading Kokoro TTS...")
    tts.preload()
    print("Ready.\n")

    while True:
        try:
            print("Press Enter to speak (Ctrl+C to quit)...")
            await asyncio.get_event_loop().run_in_executor(None, input)

            print("Listening... (press Enter to stop)")
            audio = await asyncio.get_event_loop().run_in_executor(
                None, engine.record_until_key
            )

            if audio.size == 0:
                print("No audio captured, try again.\n")
                continue

            # STT
            print("Transcribing...")
            t_stt_start = time.monotonic()
            result = await asyncio.get_event_loop().run_in_executor(
                None, stt.transcribe, audio
            )
            t_stt = time.monotonic() - t_stt_start

            # Filter Whisper hallucinations on silence/noise
            HALLUCINATION_PHRASES = {
                "you", "thanks for watching", "thank you", "bye",
                "the end", "thanks", "thank you for watching",
            }
            if not result.text or result.text.strip().lower() in HALLUCINATION_PHRASES:
                print("No speech detected, try again.\n")
                continue

            print(f"You: {result.text}")
            print(f"  [STT: {t_stt:.2f}s]")

            # Claude bridge
            print("Thinking...")
            t_turn_start = time.monotonic()
            t_first_text = None
            t_first_audio = None
            sentence_buf.reset()
            full_response = ""

            async for event in bridge.query(result.text):
                match event:
                    case TextChunk(text=text):
                        if t_first_text is None:
                            t_first_text = time.monotonic() - t_turn_start
                        full_response += text
                        sentence_buf.feed(text)

                        # Check for complete sentences to speak
                        while True:
                            sentence = sentence_buf.get_sentence()
                            if sentence is None:
                                break
                            if t_first_audio is None:
                                t_first_audio = time.monotonic() - t_turn_start
                            audio_out = await asyncio.get_event_loop().run_in_executor(
                                None, tts.speak, sentence
                            )
                            await asyncio.get_event_loop().run_in_executor(
                                None, tts.play_audio, audio_out
                            )

                    case ToolStart(name=name):
                        print(f"  [Using tool: {name}]")

                    case ToolEnd():
                        pass

                    case TurnComplete(session_id=sid):
                        log.debug("Turn complete, session: %s", sid)

                    case Error(message=msg):
                        print(f"  [Error: {msg}]")

            # Flush remaining text
            remainder = sentence_buf.flush()
            if remainder:
                if t_first_audio is None:
                    t_first_audio = time.monotonic() - t_turn_start
                audio_out = await asyncio.get_event_loop().run_in_executor(
                    None, tts.speak, remainder
                )
                await asyncio.get_event_loop().run_in_executor(
                    None, tts.play_audio, audio_out
                )

            t_total = time.monotonic() - t_turn_start

            # Print response and timing
            if full_response:
                print(f"Jarvis: {full_response.strip()}")
            print(
                f"  [First text: {t_first_text:.2f}s | "
                f"First audio: {t_first_audio:.2f}s | "
                f"Total: {t_total:.2f}s]"
                if t_first_text is not None and t_first_audio is not None
                else f"  [Total: {t_total:.2f}s]"
            )
            print()

        except KeyboardInterrupt:
            print("\nGoodbye.")
            await bridge.interrupt()
            break
        except Exception as exc:
            log.error("Error in main loop: %s", exc, exc_info=True)
            print(f"Error: {exc}\n")


async def run_voice_mode(config: JarvisConfig, reset_session: bool = False) -> None:
    """Always-on voice mode with wake word detection (Phase 2)."""
    from jarvis.intent import IntentClassifier
    from jarvis.state_machine import StateMachine
    from jarvis.vad import VoiceActivityDetector
    from jarvis.wake_word import WakeWordDetector

    print("Loading models (this may take a moment on first run)...")

    engine = AudioEngine(config)
    wake = WakeWordDetector(
        model_name=config.wake_model,
        threshold=config.wake_threshold,
    )
    vad = VoiceActivityDetector(sample_rate=config.sample_rate)
    stt = STT(config)
    bridge = ClaudeBridge(config)
    sentence_buf = SentenceBuffer(
        first_chunk_tokens=config.first_chunk_tokens,
        max_chunk_tokens=config.max_chunk_tokens,
    )
    tts = TTS(config)
    intent_classifier = IntentClassifier(config)

    if reset_session:
        bridge.reset_session()
        print("  Session reset -- starting with fresh context.")

    # Preload all models
    print("  Loading wake word model...")
    wake.preload()
    print("  Loading VAD model...")
    vad.preload()
    print("  Loading Whisper STT...")
    stt.preload()
    print("  Loading Kokoro TTS (and filler phrases)...")
    tts.preload()
    print("Ready.\n")

    sm = StateMachine(
        config, engine, wake, vad, stt, bridge, sentence_buf, tts,
        intent_classifier=intent_classifier,
    )

    try:
        await sm.run()
    except KeyboardInterrupt:
        print("\nShutting down...")
        await sm.stop()


def main() -> None:
    """Entry point."""
    parser = argparse.ArgumentParser(description="Jarvis voice assistant")
    parser.add_argument(
        "--mode",
        choices=["push", "voice"],
        default="push",
        help="Operation mode: push (push-to-talk) or voice (always-on with wake word)",
    )
    parser.add_argument(
        "--config",
        type=str,
        default=None,
        help="Path to config file (default: ~/.jarvis/config.yaml)",
    )
    parser.add_argument(
        "--reset-session",
        action="store_true",
        help="Start with a fresh Claude session (clear multi-turn context)",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )

    # Ensure default config exists
    ensure_config()

    # Load config (from custom path or default)
    config_path = None
    if args.config:
        from pathlib import Path
        config_path = Path(args.config)
        if not config_path.exists():
            print(f"Config file not found: {config_path}", file=sys.stderr)
            sys.exit(1)
    config = JarvisConfig.load(path=config_path)

    # Run prerequisite checks
    errors = check_prerequisites()
    if errors:
        print("Startup checks failed:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

    # Print startup info
    print_startup_info(config, args.mode)
    print_help_tips(args.mode)

    try:
        if args.mode == "voice":
            asyncio.run(run_voice_mode(config, reset_session=args.reset_session))
        else:
            asyncio.run(run_push_loop(config, reset_session=args.reset_session))
    except KeyboardInterrupt:
        pass
