import asyncio
import io
import json
import logging
import os
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

# Jarvis modules
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from jarvis.claude_bridge import ClaudeBridge
from jarvis.config import JarvisConfig
from jarvis.events import TextChunk, ToolStart, ToolEnd, TurnComplete, Error
from jarvis.intent import IntentClassifier
from jarvis.sentence_buffer import SentenceBuffer
from jarvis.stt import STT
from jarvis.tts import TTS

log = logging.getLogger(__name__)

app = FastAPI(title="Jarvis", docs_url=None, redoc_url=None)

# Serve static files
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Global state
config = JarvisConfig.load()
stt_engine: Optional[STT] = None
tts_engine: Optional[TTS] = None
intent_classifier = IntentClassifier(config)

# Paths
HOME = Path.home()
CLAUDE_DIR = HOME / ".claude"
CHANNEL_MAP = CLAUDE_DIR / "channels" / "discord" / "channel-map.json"
SECOND_BRAIN = HOME / "Documents" / "ZacksWorkspace" / "SecondBrain"
WORKSPACE = HOME / "Documents" / "ZacksWorkspace"


def _run(cmd: str, timeout: int = 5) -> str:
    """Run a shell command and return output. Only for trusted internal commands."""
    try:
        return subprocess.check_output(
            cmd, shell=True, text=True, timeout=timeout, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:
        return ""


def _run_safe(args: list[str], timeout: int = 5, cwd: str | None = None) -> str:
    """Run a command with an argument list (no shell injection). Use for user input."""
    try:
        return subprocess.check_output(
            args, text=True, timeout=timeout, stderr=subprocess.DEVNULL, cwd=cwd
        ).strip()
    except Exception:
        return ""


from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(application: FastAPI):
    global stt_engine, tts_engine
    # Strip Discord env vars so child processes (claude -p) never post
    # web interface responses to Discord channels.
    for key in list(os.environ):
        if "DISCORD" in key:
            del os.environ[key]
    log.info("Loading STT model...")
    stt_engine = STT(config)
    stt_engine.preload()
    log.info("Loading TTS model...")
    tts_engine = TTS(config)
    tts_engine.preload()
    log.info("Jarvis web server ready")
    yield


app.router.lifespan_context = lifespan


# ---- Pages ----

@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


# ---- API: System Status ----

@app.get("/api/status")
async def get_status():
    """System overview: sessions, CPU, memory, disk."""
    import os as _os
    load_avg = _os.getloadavg()
    cpu_count = _os.cpu_count() or 1

    # Memory via vm_stat
    mem_info = _run("vm_stat")
    total_mem_gb = 0
    used_pct = 0
    try:
        import re
        page_size = 16384  # Apple Silicon default
        pages = {}
        for line in mem_info.split("\n"):
            m = re.match(r'(.+):\s+(\d+)', line)
            if m:
                pages[m.group(1).strip()] = int(m.group(2))
        active = pages.get("Pages active", 0)
        wired = pages.get("Pages wired down", 0)
        free_pages = pages.get("Pages free", 0)
        inactive = pages.get("Pages inactive", 0)
        total = active + wired + free_pages + inactive
        if total > 0:
            used_pct = round((active + wired) / total * 100, 1)
            total_mem_gb = round(total * page_size / 1073741824, 1)
    except Exception:
        pass

    # Disk
    disk_total = disk_used = disk_pct = 0
    try:
        st = _os.statvfs("/")
        disk_total = st.f_blocks * st.f_frsize
        disk_used = (st.f_blocks - st.f_bfree) * st.f_frsize
        disk_pct = round(disk_used / disk_total * 100, 1) if disk_total else 0
    except Exception:
        pass

    return {
        "cpu_pct": round(load_avg[0] / cpu_count * 100, 1),
        "cpu_count": cpu_count,
        "load_avg": [round(x, 2) for x in load_avg],
        "mem_used_pct": used_pct,
        "mem_total_gb": total_mem_gb,
        "disk_used_pct": disk_pct,
        "disk_total_gb": round(disk_total / 1073741824, 1),
        "disk_used_gb": round(disk_used / 1073741824, 1),
        "uptime": _run("uptime -p 2>/dev/null || uptime | sed 's/.*up /up /' | sed 's/,.*//'"),
        "timestamp": datetime.now().isoformat(),
    }


# ---- API: Sessions ----

@app.get("/api/sessions")
async def get_sessions():
    """List all Claude tmux sessions."""
    raw = _run('tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}|#{session_windows}" 2>/dev/null')
    if not raw:
        return []

    # Load channel map
    channel_map = {}
    try:
        cm = json.loads(CHANNEL_MAP.read_text())
        for ch_id, info in cm.get("channels", {}).items():
            channel_map[info["name"]] = {"channelId": ch_id, "dir": info.get("dir", "")}
    except Exception:
        pass

    sessions = []
    for line in raw.split("\n"):
        if "claude" not in line:
            continue
        parts = line.split("|")
        if len(parts) < 4:
            continue
        name, created_ts, attached, windows = parts[0], parts[1], parts[2], parts[3]
        project = name.replace("claude-", "")
        is_hub = project == "agent"
        ch_info = channel_map.get(project)

        created = datetime.fromtimestamp(int(created_ts))
        uptime = datetime.now() - created
        hours = int(uptime.total_seconds() // 3600)
        minutes = int((uptime.total_seconds() % 3600) // 60)

        # Get last output
        last_output = _run(f'tmux capture-pane -t "{name}" -p -S -10 2>/dev/null')

        sessions.append({
            "name": name,
            "role": "hub" if is_hub else "project",
            "project": None if is_hub else project,
            "dir": ch_info["dir"] if ch_info else None,
            "uptime": f"{hours}h {minutes}m" if hours else f"{minutes}m",
            "attached": attached == "1",
            "lastOutput": last_output or "(empty)",
        })

    return sessions


# ---- API: Projects ----

@app.get("/api/projects")
async def get_projects():
    """List projects from channel map."""
    try:
        cm = json.loads(CHANNEL_MAP.read_text())
        projects = []
        for ch_id, info in cm.get("channels", {}).items():
            name = info["name"]
            dir_path = info.get("dir", "")
            # Check git status
            git_branch = _run(f'cd "{dir_path}" && git branch --show-current 2>/dev/null') if dir_path else ""
            has_changes = bool(_run(f'cd "{dir_path}" && git status --porcelain 2>/dev/null')) if dir_path else False

            projects.append({
                "name": name,
                "dir": dir_path,
                "channelId": ch_id,
                "gitBranch": git_branch,
                "hasChanges": has_changes,
                "isHub": name == "hub",
            })
        return projects
    except Exception as e:
        return []


# ---- API: SecondBrain ----

@app.get("/api/brain/active")
async def get_active_items():
    """Get all active SecondBrain items."""
    items = []
    if not SECOND_BRAIN.exists():
        return items

    for folder in ["Projects", "People", "Ideas", "Admin"]:
        folder_path = SECOND_BRAIN / folder
        if not folder_path.exists():
            continue
        for f in folder_path.glob("*.md"):
            try:
                content = f.read_text()
                if "status: active" in content:
                    # Extract frontmatter
                    name = ""
                    next_action = ""
                    for line in content.split("\n"):
                        if line.startswith("name:"):
                            name = line.split(":", 1)[1].strip().strip('"')
                        elif line.startswith("next_action:"):
                            next_action = line.split(":", 1)[1].strip().strip('"')
                    items.append({
                        "name": name or f.stem,
                        "folder": folder,
                        "next_action": next_action,
                        "file": str(f.relative_to(SECOND_BRAIN)),
                    })
            except Exception:
                continue
    return items


@app.get("/api/brain/search")
async def search_brain(q: str = ""):
    """Search SecondBrain files by content."""
    if not q or not SECOND_BRAIN.exists():
        return []

    results = []
    for f in SECOND_BRAIN.rglob("*.md"):
        try:
            content = f.read_text()
            if q.lower() in content.lower():
                # Get first non-frontmatter line as preview
                lines = content.split("\n")
                preview = ""
                in_frontmatter = False
                for line in lines:
                    if line.strip() == "---":
                        in_frontmatter = not in_frontmatter
                        continue
                    if not in_frontmatter and line.strip():
                        preview = line.strip()[:100]
                        break
                results.append({
                    "file": str(f.relative_to(SECOND_BRAIN)),
                    "name": f.stem.replace("_", " ").title(),
                    "preview": preview,
                })
        except Exception:
            continue
    return results[:20]


@app.get("/api/brain/file/{filepath:path}")
async def read_brain_file(filepath: str):
    """Read a SecondBrain file."""
    full_path = (SECOND_BRAIN / filepath).resolve()
    if not full_path.exists() or not full_path.is_relative_to(SECOND_BRAIN.resolve()):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"content": full_path.read_text(), "path": filepath}


# ---- API: Home Assistant ----

@app.get("/api/home/areas")
async def get_home_areas():
    """Get Home Assistant areas (via Claude's MCP)."""
    # We'll query HA through the claude bridge for now
    # In the future, could call HA API directly
    return {"message": "Use the chat to control Home Assistant"}


# ---- API: Hub Operations ----

@app.post("/api/sessions/{name}/dispatch")
async def dispatch_to_session(name: str, message: str = ""):
    """Dispatch a message to a project session."""
    try:
        cm = json.loads(CHANNEL_MAP.read_text())
        channel_id = None
        project_dir = None
        for ch_id, info in cm.get("channels", {}).items():
            if info["name"] == name:
                channel_id = ch_id
                project_dir = info.get("dir", "")
                break
        if not project_dir:
            return JSONResponse({"error": f"Project '{name}' not found"}, status_code=404)

        result = _run_safe(
            ["bash", str(HOME / ".claude/bin/dispatch-to-session.sh"),
             name, project_dir, channel_id, message],
            timeout=10,
        )
        return {"status": "dispatched", "project": name, "result": result}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/sessions/{name}/kill")
async def kill_session(name: str):
    """Kill a project session to clear its context."""
    channel_id = ""
    try:
        cm = json.loads(CHANNEL_MAP.read_text())
        for ch_id, info in cm.get("channels", {}).items():
            if info["name"] == name:
                channel_id = ch_id
                break
    except Exception:
        pass

    result = _run_safe(
        ["bash", str(HOME / ".claude/bin/kill-project-session.sh"), name, channel_id],
        timeout=10,
    )
    return {"status": "killed", "project": name, "result": result}


@app.post("/api/projects/create")
async def create_project(name: str, agent: str = ""):
    """Create a new project with optional agent (architect, researcher)."""
    project_dir = str(WORKSPACE / name)

    os.makedirs(project_dir, exist_ok=True)
    _run_safe(["git", "init"], timeout=5, cwd=project_dir)

    result = _run_safe(
        ["bash", str(HOME / ".claude/bin/discord-create-channel.sh"), name, project_dir],
        timeout=15,
    )

    channel_id = ""
    try:
        for line in result.split("\n"):
            if line.strip().isdigit():
                channel_id = line.strip()
                break
    except Exception:
        pass

    if agent and channel_id:
        _run_safe(
            ["bash", str(HOME / ".claude/bin/dispatch-to-session.sh"),
             name, project_dir, channel_id, "New project created", agent],
            timeout=10,
        )

    return {
        "status": "created",
        "name": name,
        "dir": project_dir,
        "channelId": channel_id,
        "agent": agent or "none",
    }


@app.get("/api/sessions/list")
async def list_sessions_script():
    """List sessions using the management script."""
    result = _run("bash ~/.claude/bin/list-project-sessions.sh", timeout=10)
    return {"output": result}


@app.post("/api/schedule")
async def create_schedule(schedule_type: str, value: str, channel_id: str = "", message: str = ""):
    """Create a timer or cron schedule."""
    script = str(HOME / ".claude/bin/schedule.sh")
    if schedule_type == "timer":
        result = _run_safe(
            ["bash", script, "timer", value, channel_id, message], timeout=10,
        )
    elif schedule_type == "cron":
        result = _run_safe(
            ["bash", script, "cron", value, channel_id, message], timeout=10,
        )
    else:
        return JSONResponse({"error": "Invalid type"}, status_code=400)
    return {"status": "scheduled", "result": result}


@app.get("/api/schedules")
async def list_schedules():
    """List active schedules."""
    result = _run("bash ~/.claude/bin/schedule.sh list", timeout=10)
    return {"output": result}


@app.delete("/api/schedule/{pid}")
async def cancel_schedule(pid: str):
    """Cancel a scheduled timer/cron."""
    result = _run_safe(
        ["bash", str(HOME / ".claude/bin/schedule.sh"), "cancel", pid], timeout=10,
    )
    return {"status": "cancelled", "result": result}


# ---- WebSocket: Chat ----

def _audio_to_base64_wav(audio_out: np.ndarray) -> str:
    """Convert float32 audio array to base64-encoded WAV string."""
    import base64
    import wave as wave_mod
    wav_buffer = io.BytesIO()
    with wave_mod.open(wav_buffer, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(24000)
        wf.writeframes((audio_out * 32767).astype(np.int16).tobytes())
    return base64.b64encode(wav_buffer.getvalue()).decode("ascii")


async def _tts_worker(
    ws: WebSocket, tts_queue: asyncio.Queue, loop: asyncio.AbstractEventLoop,
) -> None:
    """Background task that generates TTS audio from sentences and sends to client.

    Runs concurrently with text streaming so TTS generation never blocks
    the Claude output stream. Sentences are processed in order.
    """
    while True:
        sentence = await tts_queue.get()
        if sentence is None:  # Poison pill -- done
            break
        try:
            audio_out = await loop.run_in_executor(None, tts_engine.speak, sentence)
            audio_b64 = _audio_to_base64_wav(audio_out)
            await ws.send_json({"type": "audio_response", "audio": audio_b64})
        except Exception as e:
            log.warning("TTS worker error: %s", e)


async def _stream_bridge_to_ws(
    ws: WebSocket,
    bridge: ClaudeBridge,
    text: str,
    *,
    model: str = "haiku",
    effort: str = "low",
    tts_queue: asyncio.Queue | None = None,
    sentence_buf: SentenceBuffer | None = None,
    label: str = "",
) -> str:
    """Stream a single bridge query to the WebSocket, feeding TTS queue.

    Returns the full response text.
    """
    full_response = ""

    async for event in bridge.query(text, model=model, effort=effort):
        if isinstance(event, TextChunk):
            full_response += event.text
            await ws.send_json({"type": "text_chunk", "text": event.text, "label": label})

            # Feed sentence buffer -- TTS worker picks up sentences from the queue
            if sentence_buf and tts_queue and tts_engine:
                sentence_buf.feed(event.text)
                while True:
                    sentence = sentence_buf.get_sentence()
                    if sentence is None:
                        break
                    await tts_queue.put(sentence)

        elif isinstance(event, ToolStart):
            await ws.send_json({"type": "tool_start", "name": event.name})
        elif isinstance(event, ToolEnd):
            await ws.send_json({"type": "tool_end"})
        elif isinstance(event, TurnComplete):
            await ws.send_json({"type": "turn_complete", "session_id": event.session_id})
        elif isinstance(event, Error):
            await ws.send_json({"type": "error", "message": event.message})

    # Flush remaining text in the sentence buffer
    if sentence_buf and tts_queue and tts_engine:
        remainder = sentence_buf.flush()
        if remainder:
            await tts_queue.put(remainder)

    return full_response


async def _stream_hub_query(
    ws: WebSocket, bridge: ClaudeBridge, text: str, *, stream_tts: bool = False,
):
    """Stream a hub-routed query to the WebSocket client.

    Architecture: Haiku ALWAYS fires first as the instant feedback layer.
    If the query needs deeper work, Opus fires in parallel and its response
    streams after Haiku finishes.

    Flow:
    1. Haiku fires immediately -> streams text + TTS to client
    2. If needs_opus: Opus fires in parallel, collects its response
    3. When Haiku finishes streaming, Opus result streams as follow-up
    4. Total latency = max(Haiku, Opus), not Haiku + Opus

    For simple queries (greetings, yes/no), only Haiku runs.
    """
    intent = intent_classifier.classify(text)
    await ws.send_json({
        "type": "intent",
        "model": config.default_model,
        "domain": intent.domain,
        "needs_opus": intent.needs_opus,
    })

    loop = asyncio.get_event_loop()
    tts_queue: asyncio.Queue | None = None
    tts_task: asyncio.Task | None = None

    if stream_tts and tts_engine:
        tts_queue = asyncio.Queue()
        tts_task = asyncio.create_task(_tts_worker(ws, tts_queue, loop))

    full_response = ""

    # Step 1: If Opus is needed, start it in the background immediately
    opus_task: asyncio.Task | None = None
    if intent.needs_opus:
        async def _run_opus() -> str:
            opus_chunks: list[str] = []
            async for event in bridge.query(
                text,
                model=config.complex_model,
                effort=config.complex_effort,
            ):
                if isinstance(event, TextChunk):
                    opus_chunks.append(event.text)
            return "".join(opus_chunks)

        opus_task = asyncio.create_task(_run_opus())

    # Step 2: Stream Haiku immediately with TTS (always runs)
    haiku_label = "fast" if intent.needs_opus else ""
    if intent.needs_opus:
        await ws.send_json({"type": "dual_model", "phase": "fast", "model": config.default_model})

    haiku_buf = SentenceBuffer(
        first_chunk_tokens=config.first_chunk_tokens,
        max_chunk_tokens=config.max_chunk_tokens,
    ) if stream_tts else None

    # Use a separate bridge for Haiku so it doesn't share session with Opus
    haiku_bridge = ClaudeBridge(config, cwd=config.workspace_dir) if intent.needs_opus else bridge
    haiku_response = await _stream_bridge_to_ws(
        ws, haiku_bridge, text,
        model=config.default_model,
        effort=config.default_effort,
        tts_queue=tts_queue, sentence_buf=haiku_buf, label=haiku_label,
    )
    full_response = haiku_response

    # Step 3: If Opus was running, wait for it and stream the follow-up
    if opus_task is not None:
        opus_response = await opus_task

        await ws.send_json({"type": "dual_model", "phase": "deep", "model": config.complex_model})
        if opus_response.strip():
            await ws.send_json({"type": "text_chunk", "text": opus_response, "label": "deep"})
            if tts_queue and tts_engine:
                opus_buf = SentenceBuffer(
                    first_chunk_tokens=config.first_chunk_tokens,
                    max_chunk_tokens=config.max_chunk_tokens,
                )
                opus_buf.feed(opus_response)
                while True:
                    sentence = opus_buf.get_sentence()
                    if sentence is None:
                        break
                    await tts_queue.put(sentence)
                remainder = opus_buf.flush()
                if remainder:
                    await tts_queue.put(remainder)
            full_response = haiku_response + "\n\n" + opus_response

    # Signal TTS worker to finish and wait for it
    if tts_queue is not None:
        await tts_queue.put(None)  # Poison pill
    if tts_task is not None:
        await tts_task

    await ws.send_json({"type": "response_complete", "text": full_response})
    return full_response


async def _generate_tts_response(ws: WebSocket, text: str):
    """Generate TTS audio from text and send as base64 WAV."""
    if not text.strip() or not tts_engine:
        return
    try:
        audio_out = tts_engine.speak(text.strip())
        audio_b64 = _audio_to_base64_wav(audio_out)
        await ws.send_json({"type": "audio_response", "audio": audio_b64})
    except Exception as e:
        log.warning("TTS error: %s", e)


@app.websocket("/ws/chat")
async def websocket_chat(ws: WebSocket):
    """WebSocket endpoint for real-time text + voice chat.

    All queries route through the hub-equivalent ClaudeBridge that runs
    from the workspace root. This gives Jarvis the same capabilities as
    the hub agent (dispatch, SecondBrain, HA, Outlook, etc.).
    """
    await ws.accept()
    log.info("WebSocket chat connection opened")

    # Each WebSocket gets its own hub-routed bridge for session isolation.
    # cwd = workspace root so it picks up the hub's CLAUDE.md and context.
    chat_bridge = ClaudeBridge(config, cwd=config.workspace_dir)

    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type", "")

            if msg_type == "text":
                text = data.get("text", "").strip()
                if not text:
                    continue
                # Stream TTS for text input too so users can hear responses
                speak = data.get("speak", False)
                await _stream_hub_query(ws, chat_bridge, text, stream_tts=speak)

            elif msg_type == "audio":
                import base64
                audio_b64 = data.get("audio", "")
                if not audio_b64:
                    continue

                audio_bytes = base64.b64decode(audio_b64)

                try:
                    import wave
                    wav_io = io.BytesIO(audio_bytes)
                    with wave.open(wav_io, "rb") as wf:
                        n_channels = wf.getnchannels()
                        sample_width = wf.getsampwidth()
                        frame_rate = wf.getframerate()
                        n_frames = wf.getnframes()
                        raw = wf.readframes(n_frames)

                    if sample_width == 2:
                        audio_np = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                    elif sample_width == 4:
                        audio_np = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
                    else:
                        audio_np = np.frombuffer(raw, dtype=np.float32)

                    if n_channels > 1:
                        audio_np = audio_np.reshape(-1, n_channels).mean(axis=1)

                    if frame_rate != 16000:
                        from scipy.signal import resample
                        n_samples = int(len(audio_np) * 16000 / frame_rate)
                        audio_np = resample(audio_np, n_samples).astype(np.float32)

                    await ws.send_json({"type": "status", "message": "Transcribing..."})
                    result = stt_engine.transcribe(audio_np)

                    if not result.text or result.text.strip().lower() in {
                        "you", "thanks for watching", "thank you", "bye", "the end"
                    }:
                        await ws.send_json({"type": "status", "message": "No speech detected"})
                        continue

                    await ws.send_json({"type": "transcription", "text": result.text})

                    # Route transcribed speech through the hub with streaming TTS.
                    # Audio flows back sentence-by-sentence as Claude generates text.
                    await _stream_hub_query(ws, chat_bridge, result.text, stream_tts=True)

                except Exception as e:
                    log.error("Audio processing error: %s", e)
                    await ws.send_json({"type": "error", "message": f"Audio error: {str(e)}"})

            elif msg_type == "reset_session":
                chat_bridge.reset_session()
                await ws.send_json({"type": "status", "message": "Session reset"})

            elif msg_type == "tts":
                text = data.get("text", "").strip()
                await _generate_tts_response(ws, text)

    except WebSocketDisconnect:
        log.info("WebSocket chat connection closed")
    except Exception as e:
        log.error("WebSocket error: %s", e, exc_info=True)


# ---- Run ----

if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    # HTTPS is required for microphone access from non-localhost origins.
    # Use self-signed certs in certs/ for local network access.
    cert_dir = Path(__file__).parent.parent / "certs"
    ssl_keyfile = cert_dir / "key.pem"
    ssl_certfile = cert_dir / "cert.pem"

    if ssl_certfile.exists() and ssl_keyfile.exists():
        log.info("Starting with HTTPS (self-signed cert)")
        uvicorn.run(
            app, host="0.0.0.0", port=3000,
            ssl_keyfile=str(ssl_keyfile),
            ssl_certfile=str(ssl_certfile),
        )
    else:
        log.warning("No SSL certs found at %s -- mic will not work from remote devices", cert_dir)
        uvicorn.run(app, host="0.0.0.0", port=3000)
