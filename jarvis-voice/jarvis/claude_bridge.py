import asyncio
import json
import logging
import os
import shutil
from typing import AsyncIterator, Optional

from jarvis.config import JarvisConfig
from jarvis.events import BridgeEvent, Error, TextChunk, ToolEnd, ToolStart, TurnComplete

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are Jarvis, Zack's voice assistant. You are a VOICE FRONTEND to the hub agent system running on Zack's Mac workstation.

You have the SAME capabilities as the hub agent -- you can dispatch to project sessions, manage SecondBrain, control Home Assistant, read Outlook, manage Slack, run shell commands, and everything else the hub does. The only difference is that your responses will be spoken aloud via TTS, so format them accordingly.

Rules for voice responses:
- Keep responses to 1-3 sentences unless asked for detail.
- Never output markdown formatting, code blocks, or bullet lists.
- Describe code verbally instead of writing it out.
- Use natural, conversational language.
- When you take an action (read a file, run a command), state what you did briefly.
- For yes/no questions, lead with the answer.
- If you need to list items, speak them naturally (for example, "You have three meetings today: the standup at 9, the design review at 11, and the sprint retro at 3.").

Hub operations you can perform:
- Dispatch work to project sessions: use dispatch-to-session.sh
- Manage SecondBrain notes: read/write files in ~/Documents/ZacksWorkspace/SecondBrain/
- Control Home Assistant: via MCP tools
- Check email/calendar: via Outlook MCP tools
- Manage sessions: list, kill, restart project sessions
- Schedule tasks: use schedule.sh for timers and crons
- Run any shell command on the workstation

When Zack asks about his schedule, notes, or projects, check the relevant files rather than guessing.
When Zack asks to dispatch work or manage projects, use the same scripts the hub uses."""


class ClaudeBridge:
    """Streams responses from Claude CLI as BridgeEvents.

    When cwd is set to the workspace root, this bridge acts as a hub-equivalent
    session with access to all tools and project CLAUDE.md context -- making
    Jarvis a voice frontend to the hub rather than a standalone assistant.
    """

    def __init__(
        self,
        config: Optional[JarvisConfig] = None,
        cwd: Optional[str] = None,
    ) -> None:
        self._config = config or JarvisConfig()
        self._cwd = cwd or self._config.workspace_dir
        self._process: Optional[asyncio.subprocess.Process] = None
        self._session_id: Optional[str] = None
        self._claude_path: Optional[str] = None

    def _find_claude(self) -> str:
        """Locate the claude CLI binary."""
        if self._claude_path:
            return self._claude_path
        path = shutil.which("claude")
        if not path:
            raise FileNotFoundError(
                "claude CLI not found on PATH. Install it first."
            )
        self._claude_path = path
        return path

    def _build_command(
        self,
        text: str,
        model: Optional[str] = None,
        effort: Optional[str] = None,
    ) -> list[str]:
        """Build the claude CLI command."""
        claude = self._find_claude()
        model = model or self._config.default_model
        effort = effort or self._config.default_effort

        # Note: --bare would save ~100-200ms startup but skips CLAUDE.md and
        # MCP auto-discovery. Since Jarvis needs MCP (HA, Outlook) and the
        # hub's CLAUDE.md context, we keep --setting-sources instead.
        cmd = [
            claude,
            "-p",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--setting-sources", "user,project",
            "--dangerously-skip-permissions",
            "--model", model,
            "--effort", effort,
            "--max-budget-usd", str(self._config.max_budget_usd),
            "--append-system-prompt", SYSTEM_PROMPT,
        ]

        if self._session_id:
            cmd.extend(["--resume", self._session_id])

        cmd.append(text)
        return cmd

    async def query(
        self,
        text: str,
        model: Optional[str] = None,
        effort: Optional[str] = None,
    ) -> AsyncIterator[BridgeEvent]:
        """Send a query to Claude and yield BridgeEvents from the stream."""
        cmd = self._build_command(text, model, effort)
        log.info("Running: %s", " ".join(cmd[:6]) + " ...")

        try:
            # Strip DISCORD_CHANNEL_ID so the Stop hook doesn't post web
            # interface responses to Discord. The web pipeline is independent.
            env = {k: v for k, v in os.environ.items() if k != "DISCORD_CHANNEL_ID"}

            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self._cwd,
                env=env,
            )

            if self._process.stdout is None:
                yield Error(message="Failed to capture stdout from claude process")
                return

            async for line in self._process.stdout:
                decoded = line.decode("utf-8", errors="replace").strip()
                if not decoded:
                    continue

                event = self._parse_line(decoded)
                if event is not None:
                    yield event

            await self._process.wait()

            if self._process.returncode and self._process.returncode != 0:
                stderr_bytes = b""
                if self._process.stderr:
                    stderr_bytes = await self._process.stderr.read()
                stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
                if stderr_text:
                    log.warning("Claude stderr: %s", stderr_text)

        except Exception as exc:
            log.error("Claude bridge error: %s", exc)
            yield Error(message=str(exc))
        finally:
            self._process = None

    def _parse_line(self, line: str) -> Optional[BridgeEvent]:
        """Parse a single NDJSON line into a BridgeEvent.

        Claude CLI stream-json wraps API events in an envelope:
        {"type":"stream_event","event":{"type":"content_block_delta",...}}

        Top-level types like "result" are not wrapped.
        """
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            log.debug("Non-JSON line: %s", line[:100])
            return None

        top_type = data.get("type", "")

        # Unwrap the stream_event envelope
        if top_type == "stream_event":
            inner = data.get("event", {})
            return self._parse_inner_event(inner)

        # Top-level result event (not wrapped)
        if top_type == "result":
            session_id = data.get("session_id")
            if session_id:
                self._session_id = session_id
                log.info("Session ID: %s", session_id)
            return TurnComplete(session_id=session_id)

        # Fallback: try parsing as a bare inner event (in case format varies)
        return self._parse_inner_event(data)

    def _parse_inner_event(self, event: dict) -> Optional[BridgeEvent]:
        """Parse an inner API event (content_block_delta, etc.)."""
        event_type = event.get("type", "")

        # Text content streaming
        if event_type == "content_block_delta":
            delta = event.get("delta", {})
            if delta.get("type") == "text_delta":
                text = delta.get("text", "")
                if text:
                    return TextChunk(text=text)

        # Tool use start
        elif event_type == "content_block_start":
            content_block = event.get("content_block", {})
            if content_block.get("type") == "tool_use":
                name = content_block.get("name", "unknown")
                log.info("Tool started: %s", name)
                return ToolStart(name=name)

        # Tool use end
        elif event_type == "content_block_stop":
            return ToolEnd()

        return None

    async def interrupt(self) -> None:
        """Kill the running subprocess if any."""
        if self._process and self._process.returncode is None:
            log.info("Interrupting Claude process")
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                self._process.kill()
            self._process = None

    def reset_session(self) -> None:
        """Clear the session ID to start fresh context."""
        log.info("Resetting session (was: %s)", self._session_id)
        self._session_id = None
