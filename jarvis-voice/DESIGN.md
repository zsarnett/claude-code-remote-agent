# Jarvis Voice Interface -- Design Document

**Version:** 1.0
**Date:** 2026-03-21
**Status:** Draft
**Author:** Zack Barrett + Claude
**Research basis:** `jarvis-voice-interface/` and `claude-oauth-token-tos/`

---

## 1. Overview

### 1.1 What We're Building

A local-first, always-on voice assistant ("Jarvis") that runs on Zack's Mac, uses Claude as its brain via the Max subscription, and integrates with the existing Claude Code workstation setup (Discord, SecondBrain, Home Assistant, etc.).

### 1.2 Design Decision: Option A (Claude Code CLI Subprocess)

Per the TOS compliance research, the LLM backend uses `claude -p` (headless mode) with Max subscription billing. This is the only approach that:
- Is explicitly documented and encouraged by Anthropic
- Never touches the OAuth token directly
- Bills to the existing $200/month Max subscription
- Matches Anthropic's documented scripting patterns
- Has zero TOS risk

The architecture:
```
[Mic] -> [Whisper STT] -> [claude -p ...] -> [Sentence Buffer] -> [TTS] -> [Speaker]
```

### 1.3 Upgrade Path

If Anthropic officially supports subscription billing in the Agent SDK, the system can migrate from `claude -p` subprocess to the Python Agent SDK. The design isolates the LLM interface behind an abstraction layer to make this swap straightforward.

### 1.4 Target Metrics

| Metric | Target | Stretch |
|--------|--------|---------|
| Wake word to first audio | < 3.0s | < 2.0s |
| Simple query (Haiku) | < 2.5s | < 1.5s |
| Complex query (Opus) | < 5.0s | < 3.5s |
| Barge-in response | < 300ms | < 200ms |
| False wake rate | < 1/hour | < 1/day |
| CPU idle (listening) | < 5% | < 3% |

---

## 2. Architecture

### 2.1 System Diagram

```
+====================================================================+
|                     macOS (Apple Silicon M4)                        |
|                                                                     |
|  +-----------------------+                                          |
|  |   ALWAYS-ON LAYER     |                                          |
|  |                       |                                          |
|  |  [Mic 16kHz mono]     |                                          |
|  |        |               |                                          |
|  |  [sounddevice.Stream] |  (full-duplex callback)                  |
|  |        |               |                                          |
|  |  [SpeexDSP AEC] <---- | ---- [Speaker Reference Buffer]         |
|  |        |               |                                          |
|  |  [openWakeWord]        |  ("Hey Jarvis", ~0.4MB, negligible CPU) |
|  |        |               |                                          |
|  |  [Silero VAD]          |  (barge-in detection, <1ms/chunk)       |
|  +---------+--------------+                                          |
|            |                                                         |
|            | wake word detected                                      |
|            v                                                         |
|  +-----------------------+                                           |
|  |   ACTIVE PIPELINE     |                                           |
|  |                       |                                           |
|  |  [MLX Whisper STT]    |  (base.en, ~200-500ms)                   |
|  |        |               |                                           |
|  |  [Intent Classifier]  |  (local heuristic + optional Haiku)      |
|  |        |               |                                           |
|  |  [Claude CLI Bridge]  |  (claude -p --output-format stream-json) |
|  |        |               |                    |                      |
|  |  [Sentence Buffer]    |               Anthropic API               |
|  |        |               |                                           |
|  |  [Kokoro TTS]         |  (mlx-audio, 400-600ms/sentence)        |
|  |        |               |                                           |
|  |  [Speaker Output]     |                                           |
|  +-----------------------+                                           |
|                                                                      |
|  +-----------------------+    +----------------------------------+   |
|  | STATE MACHINE         |    | INTEGRATIONS                     |   |
|  |                       |    |                                  |   |
|  | IDLE --> LISTENING --> |    | Discord (notifications, text)    |   |
|  | PROCESSING --> SPEAKING|    | Home Assistant (MCP)             |   |
|  | --> (barge-in) -->     |    | SecondBrain (notes, queries)     |   |
|  | LISTENING              |    | Outlook (calendar, email)        |   |
|  +-----------------------+    +----------------------------------+   |
+======================================================================+
```

### 2.2 Data Flow (Happy Path)

```
1. User says "Hey Jarvis, what's on my calendar today?"

2. [openWakeWord] detects "Hey Jarvis"
   -> Play acknowledgment tone
   -> State: IDLE -> LISTENING
   -> Start feeding audio to MLX Whisper

3. [Silero VAD] detects end of speech (300ms silence)
   -> Stop recording
   -> State: LISTENING -> PROCESSING

4. [MLX Whisper] transcribes: "what's on my calendar today"
   -> ~200-500ms

5. [Intent Classifier] routes:
   -> "calendar" -> tool-enabled query
   -> Model: haiku (simple query)

6. [Claude CLI Bridge] spawns:
   claude -p --bare --model haiku --effort low \
     --output-format stream-json \
     --include-partial-messages \
     --verbose \
     --allowedTools Read,Bash,Glob,Grep \
     --permission-mode acceptEdits \
     --append-system-prompt "You are Jarvis..." \
     "what's on my calendar today"

7. [NDJSON Parser] reads stdout line by line:
   -> Filters for content_block_delta / text_delta events
   -> Feeds text chunks to Sentence Buffer

8. [Sentence Buffer] accumulates tokens:
   -> First chunk: 24-token threshold (aggressive, get audio out fast)
   -> Subsequent: 96-token soft limit, wait for sentence boundary (.!?)
   -> Each complete sentence -> Kokoro TTS

9. [Kokoro TTS] generates audio:
   -> State: PROCESSING -> SPEAKING
   -> Streams PCM to speaker output
   -> Copies PCM to reference buffer (for AEC)

10. User hears response. State: SPEAKING -> IDLE after last audio plays.
```

### 2.3 Data Flow (Barge-In)

```
1. Jarvis is speaking (State: SPEAKING)

2. [SpeexDSP AEC] removes Jarvis's voice from mic signal

3. [Silero VAD] detects user speech on cleaned signal (>200ms sustained)

4. Barge-in triggered:
   -> Stop TTS playback immediately
   -> Stop claude -p process (SIGTERM or close stdin)
   -> Flush speaker reference buffer
   -> Play brief acknowledgment tone
   -> State: SPEAKING -> LISTENING
   -> Begin STT on new user speech

5. Normal flow resumes from step 3 of happy path.
```

### 2.4 Data Flow (Tool Execution)

```
1. Claude decides to call a tool (e.g., Read a file, run a Bash command)

2. [NDJSON Parser] detects content_block_start with type: "tool_use"
   -> No text to speak -- tool is executing silently

3. [Filler Engine] speaks: "Let me check that..." or "One moment..."
   -> Short, pre-rendered audio clips (no TTS latency)
   -> State stays in SPEAKING

4. Tool completes, Claude generates response text
   -> Resume normal streaming to Sentence Buffer -> TTS
```

---

## 3. Component Design

### 3.1 Audio Engine (`audio_engine.py`)

Manages all audio I/O through a single full-duplex `sounddevice.Stream`.

**Responsibilities:**
- Mic capture at 16kHz/16-bit/mono
- Speaker output (TTS playback)
- AEC reference signal management
- Thread-safe audio queues

**Key interfaces:**
```python
class AudioEngine:
    def __init__(self, sample_rate=16000, channels=1, frame_size=256):
        ...

    def start(self):
        """Start the full-duplex audio stream."""

    def stop(self):
        """Stop the audio stream."""

    def get_mic_audio(self) -> bytes:
        """Get next frame of AEC-cleaned mic audio from queue."""

    def play_audio(self, pcm_data: bytes):
        """Queue PCM audio for speaker output. Auto-feeds AEC reference."""

    def stop_playback(self):
        """Immediately stop all queued audio (for barge-in)."""

    def is_playing(self) -> bool:
        """Whether audio is currently being played."""
```

**Internal architecture:**
- `sounddevice.Stream` callback runs on a dedicated audio thread
- Mic frames go into a `queue.Queue` after AEC processing
- Speaker output reads from a `queue.Queue` of PCM chunks
- AEC reference buffer is a ring buffer synchronized with the callback

**Dependencies:** `sounddevice`, `numpy`, `speexdsp`

### 3.2 Wake Word Detector (`wake_word.py`)

Always-on detector using openWakeWord with the pre-trained "hey_jarvis" model.

**Responsibilities:**
- Continuously consume AEC-cleaned mic audio
- Detect "Hey Jarvis" wake phrase
- Minimal CPU usage when idle

**Key interfaces:**
```python
class WakeWordDetector:
    def __init__(self, model="hey_jarvis", threshold=0.5):
        ...

    async def listen(self, audio_source: AudioEngine) -> AsyncIterator[WakeEvent]:
        """Yield WakeEvent each time the wake word is detected."""

    def set_active(self, active: bool):
        """Enable/disable detection (disable during LISTENING/PROCESSING)."""
```

**Configuration:**
- Model: `hey_jarvis` (pre-trained, ships with openWakeWord)
- Threshold: 0.5 (tune based on environment -- higher = fewer false wakes)
- Frame size: 1280 samples (80ms at 16kHz, openWakeWord requirement)

**Dependencies:** `openwakeword`

### 3.3 Voice Activity Detector (`vad.py`)

Dual-purpose: end-of-speech detection during LISTENING, barge-in detection during SPEAKING.

**Responsibilities:**
- Detect when user starts/stops speaking
- Configurable silence thresholds per state

**Key interfaces:**
```python
class VoiceActivityDetector:
    def __init__(self, model="silero_vad"):
        ...

    def process_frame(self, audio_frame: bytes) -> VADResult:
        """Returns speech probability for the frame."""

    def detect_speech_end(self, min_silence_ms=300) -> bool:
        """True if silence has exceeded threshold (for STT cutoff)."""

    def detect_speech_start(self, min_speech_ms=200) -> bool:
        """True if speech has been sustained (for barge-in trigger)."""
```

**Configuration:**
- End-of-speech silence: 300ms (configurable, 200-500ms range)
- Barge-in speech threshold: 200ms (avoid triggering on noise)
- Frame size: 512 samples (32ms at 16kHz, Silero minimum is 30ms)

**Dependencies:** `silero-vad` (uses ONNX Runtime internally)

### 3.4 Speech-to-Text Engine (`stt.py`)

Local transcription using MLX Whisper, optimized for Apple Silicon.

**Responsibilities:**
- Transcribe recorded speech to text
- Fast turnaround for short utterances
- Language detection (English primary)

**Key interfaces:**
```python
class SpeechToText:
    def __init__(self, model="base.en"):
        ...

    async def transcribe(self, audio: np.ndarray) -> TranscriptionResult:
        """Transcribe audio buffer to text. Returns text + confidence."""

    def preload(self):
        """Pre-load model into memory for fast first transcription."""
```

**Model choice:** `base.en` (142MB disk, ~388MB RAM)
- English-only for faster inference
- 18x realtime on M4 with MLX acceleration
- Upgrade to `small.en` if accuracy is insufficient

**Dependencies:** `mlx-whisper`

### 3.5 Claude CLI Bridge (`claude_bridge.py`)

The LLM interface. Wraps `claude -p` as a subprocess with NDJSON streaming.

**This is the core Option A component.** It spawns Claude Code as a subprocess, never touches OAuth tokens, and uses the Max subscription through Claude Code's own auth.

**Responsibilities:**
- Spawn and manage `claude -p` processes
- Parse NDJSON streaming output
- Extract text tokens for TTS
- Detect tool execution events
- Session management (multi-turn context)
- Model routing (Haiku for fast, Opus for deep)

**Key interfaces:**
```python
class ClaudeBridge:
    def __init__(self, system_prompt: str, default_model: str = "haiku"):
        self._session_id: str | None = None
        ...

    async def query(
        self,
        text: str,
        model: str | None = None,
        effort: str = "low",
        tools: list[str] | None = None,
    ) -> AsyncIterator[BridgeEvent]:
        """
        Send a query to Claude and stream back events.

        Yields:
            TextChunk(text="...")       -- partial text for TTS
            ToolStart(name="Read")      -- tool execution began
            ToolEnd(name="Read")        -- tool execution finished
            TurnComplete(session_id=..) -- response finished
            Error(message="...")        -- something went wrong
        """

    async def interrupt(self):
        """Kill the current claude process (barge-in)."""

    def reset_session(self):
        """Start a fresh conversation context."""
```

**Implementation detail -- subprocess spawning:**
```python
async def _spawn_claude(self, text: str, model: str, effort: str, tools: list[str]) -> asyncio.subprocess.Process:
    cmd = [
        "claude", "-p",
        "--bare",
        "--model", model,
        "--effort", effort,
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--append-system-prompt", self._system_prompt,
    ]

    if tools:
        cmd.extend(["--allowedTools", ",".join(tools)])

    if self._session_id:
        cmd.extend(["--resume", self._session_id])

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # Send the prompt via stdin and close it
    proc.stdin.write(text.encode())
    proc.stdin.write_eof()

    return proc
```

**NDJSON parsing:**
```python
async def _parse_stream(self, proc) -> AsyncIterator[BridgeEvent]:
    async for line in proc.stdout:
        event = json.loads(line)

        if event.get("type") == "stream_event":
            inner = event.get("event", {})

            # Text token
            if (inner.get("type") == "content_block_delta"
                and inner.get("delta", {}).get("type") == "text_delta"):
                yield TextChunk(text=inner["delta"]["text"])

            # Tool start
            elif (inner.get("type") == "content_block_start"
                  and inner.get("content_block", {}).get("type") == "tool_use"):
                yield ToolStart(name=inner["content_block"]["name"])

            # Tool end
            elif inner.get("type") == "content_block_stop":
                yield ToolEnd()

        elif event.get("type") == "result":
            self._session_id = event.get("session_id")
            yield TurnComplete(session_id=self._session_id)
```

**Session management:**
- First query: no `--resume`, captures `session_id` from the `result` event
- Subsequent queries: `--resume <session_id>` for multi-turn context
- Session auto-compacts at ~80% context usage (handled by Claude Code internally)
- `reset_session()` clears the session ID for a fresh start

**Model routing:**
- Default: Haiku with `--effort low` (fastest possible, ~500-700ms TTFT)
- Complex queries: Opus (routed by Intent Classifier, ~2500-3500ms TTFT)
- The `--bare` flag is critical for voice latency -- skips hooks, LSP, CLAUDE.md discovery

**Dependencies:** None beyond Python stdlib (spawns `claude` binary)

### 3.6 Sentence Buffer (`sentence_buffer.py`)

Accumulates streaming text tokens and emits complete sentences for TTS.

**Responsibilities:**
- Buffer incoming text chunks
- Detect sentence boundaries
- Emit sentences with latency-optimized thresholds

**Key interfaces:**
```python
class SentenceBuffer:
    def __init__(self, first_chunk_tokens=24, max_chunk_tokens=96):
        ...

    def feed(self, text: str):
        """Feed a text chunk from the LLM stream."""

    async def sentences(self) -> AsyncIterator[str]:
        """Yield complete sentences as they become available."""

    def flush(self) -> str | None:
        """Flush any remaining buffered text (end of response)."""

    def reset(self):
        """Clear the buffer (barge-in or new turn)."""
```

**Chunking strategy (from Pipecat/Nemotron research):**
- **First sentence**: 24-token soft limit. Emit at the first sentence boundary (`.!?`) after 24 tokens. If no boundary by 48 tokens, emit anyway. Goal: get audio out fast.
- **Subsequent sentences**: 96-token soft limit. Wait for natural sentence boundaries. If no boundary by 128 tokens, force-emit at the nearest word boundary.
- **Token counting**: Approximate as `len(text.split())` -- exact token count doesn't matter, word count is close enough for buffering.

### 3.7 Text-to-Speech Engine (`tts.py`)

Local TTS using Kokoro via mlx-audio.

**Responsibilities:**
- Convert text sentences to PCM audio
- Stream audio chunks to AudioEngine
- Pre-render filler phrases at startup

**Key interfaces:**
```python
class TextToSpeech:
    def __init__(self, voice="af_heart", sample_rate=16000):
        ...

    async def speak(self, text: str) -> AsyncIterator[bytes]:
        """Generate PCM audio for the given text, yielded in chunks."""

    async def speak_filler(self, filler_type: str):
        """Play a pre-rendered filler phrase (instant, no generation delay)."""

    def preload(self):
        """Pre-load model and cache filler phrases."""
```

**Filler phrases (pre-rendered at startup):**
- `"thinking"`: "Let me think about that..."
- `"checking"`: "One moment while I check..."
- `"working"`: "Working on it..."
- `"hmm"`: "Hmm..."
- `"ack"`: A short chime/tone (non-verbal acknowledgment after wake word)

**Configuration:**
- Model: Kokoro 82M via `kokoro-onnx`
- Voice: `af_heart` (or another natural-sounding voice -- test a few)
- Output: 16kHz 16-bit PCM mono (matches AudioEngine)
- Auto-downloads model (~24MB) and voice (~12MB) to `~/.cache/kokoro-onnx/`

**Dependencies:** `kokoro-onnx` (or `pipecat-ai[kokoro]`)

### 3.8 Intent Classifier (`intent.py`)

Routes voice commands to the appropriate model and tool set.

**Responsibilities:**
- Classify transcribed text by complexity and domain
- Select model (Haiku vs Opus) and tool set
- Fast -- must not add meaningful latency

**Key interfaces:**
```python
class IntentClassifier:
    def classify(self, text: str) -> Intent:
        """Classify the transcribed text and return routing info."""

@dataclass
class Intent:
    model: str          # "haiku" or "opus"
    effort: str         # "low", "medium", "high"
    tools: list[str]    # ["Read", "Bash", "Glob", "Grep", ...]
    domain: str         # "general", "code", "home", "calendar", "notes"
    play_filler: bool   # Whether to play a filler phrase before response
```

**Classification approach -- two tiers:**

**Tier 1: Local heuristic (0ms, always runs first)**
```python
# Keyword-based fast routing
SIMPLE_PATTERNS = [
    r"^(what|who|when|where|how) (is|are|was|were|do|does)",  # factual Q
    r"^(tell me|explain|describe)",  # conversational
    r"^(hi|hello|hey|good morning)",  # greeting
]

COMPLEX_PATTERNS = [
    r"(build|create|implement|refactor|debug|fix)",  # coding tasks
    r"(analyze|compare|review|design)",  # deep reasoning
    r"(read|edit|change|update) .+ (file|code|project)",  # file ops
]

HOME_PATTERNS = [
    r"(light|lamp|switch|thermostat|temperature|lock|door|garage)",
    r"(turn on|turn off|set|dim|brighten)",
]

CALENDAR_PATTERNS = [
    r"(calendar|schedule|meeting|event|appointment)",
    r"(what.+today|what.+tomorrow|what.+this week)",
]

NOTES_PATTERNS = [
    r"(note|remember|add to brain|what.+active|what.+going on)",
]
```

**Tier 2: Haiku classifier (optional, ~500ms, for ambiguous cases)**
Only invoked if Tier 1 is uncertain. Uses `claude -p --model haiku --effort low --json-schema` for structured classification. Adds latency but improves accuracy for edge cases. Disabled by default -- enable after the system is stable.

### 3.9 State Machine (`state_machine.py`)

Central coordinator for the voice pipeline.

**States:**
```
IDLE        -- Wake word engine active, minimal CPU
LISTENING   -- Recording user speech, VAD monitoring for end-of-speech
PROCESSING  -- STT running, then Claude query, then streaming response
SPEAKING    -- TTS audio playing, AEC active, VAD monitoring for barge-in
COOLDOWN    -- Brief pause after response, before returning to IDLE
```

**Transitions:**
```
IDLE       -> LISTENING    : Wake word detected
LISTENING  -> PROCESSING   : VAD detects end of speech
PROCESSING -> SPEAKING     : First TTS audio chunk ready
SPEAKING   -> LISTENING    : Barge-in detected (VAD during TTS)
SPEAKING   -> COOLDOWN     : All TTS audio played
COOLDOWN   -> IDLE         : 500ms elapsed (prevents immediate re-trigger)
LISTENING  -> IDLE         : 10s timeout with no speech (user walked away)
PROCESSING -> IDLE         : Error or empty transcription
```

**Key interfaces:**
```python
class StateMachine:
    def __init__(self, audio: AudioEngine, wake: WakeWordDetector,
                 vad: VoiceActivityDetector, stt: SpeechToText,
                 bridge: ClaudeBridge, buffer: SentenceBuffer,
                 tts: TextToSpeech, intent: IntentClassifier):
        ...

    async def run(self):
        """Main event loop. Runs until stopped."""

    async def stop(self):
        """Graceful shutdown."""
```

### 3.10 System Prompt

The voice-optimized system prompt appended to every Claude query:

```
You are Jarvis, a voice assistant running on Zack's Mac workstation.

Rules for voice responses:
- Keep responses to 1-3 sentences unless asked for detail.
- Never output markdown formatting, code blocks, or bullet lists.
- Describe code verbally instead of writing it out.
- Use natural, conversational language.
- When you take an action (read a file, run a command), state what you did briefly.
- For yes/no questions, lead with the answer.
- If you need to list items, speak them naturally ("You have three meetings today: the standup at 9, the design review at 11, and the sprint retro at 3.").

You have access to:
- The filesystem (Zack's projects, SecondBrain notes)
- Shell commands (git, system info, etc.)
- Zack's tools and integrations

When Zack asks about his schedule, notes, or projects, check the relevant files rather than guessing.
```

---

## 4. Tech Stack

### 4.1 Core Dependencies

| Component | Package | Version | Purpose |
|-----------|---------|---------|---------|
| Audio I/O | `sounddevice` | latest | Full-duplex mic/speaker |
| AEC | `speexdsp` | latest | Echo cancellation |
| Wake Word | `openwakeword` | latest | "Hey Jarvis" detection |
| VAD | `silero-vad` | latest | Speech activity detection |
| STT | `mlx-whisper` | latest | Local transcription |
| LLM | `claude` (CLI) | latest | Claude Code binary |
| TTS | `kokoro-onnx` | latest | Local speech synthesis |
| Arrays | `numpy` | latest | Audio buffer manipulation |

### 4.2 System Dependencies

```bash
# macOS system packages
brew install portaudio    # Required by sounddevice
brew install speexdsp     # Required by speexdsp Python bindings

# Claude Code CLI (already installed on workstation)
# Authenticated with Max subscription (no API key)
```

### 4.3 Python Environment

```bash
# Python 3.11+ (for Apple Silicon MLX support)
python -m venv .venv
source .venv/bin/activate

pip install sounddevice numpy
pip install speexdsp
pip install openwakeword
pip install silero-vad
pip install mlx-whisper
pip install kokoro-onnx
```

### 4.4 Project Structure

```
jarvis/
  __init__.py
  main.py                  # Entry point, argument parsing
  state_machine.py         # Central coordinator
  audio_engine.py          # sounddevice + AEC
  wake_word.py             # openWakeWord wrapper
  vad.py                   # Silero VAD wrapper
  stt.py                   # MLX Whisper wrapper
  claude_bridge.py         # claude -p subprocess + NDJSON parsing
  sentence_buffer.py       # Token accumulation + sentence splitting
  tts.py                   # Kokoro TTS wrapper
  intent.py                # Intent classification + routing
  config.py                # Configuration dataclass
  events.py                # Event types (TextChunk, ToolStart, etc.)
  fillers/                 # Pre-rendered filler audio files
    ack.wav
    thinking.wav
    checking.wav
    working.wav
  tests/
    test_sentence_buffer.py
    test_intent.py
    test_claude_bridge.py
    test_state_machine.py
```

---

## 5. Integration Points

### 5.1 Discord

Jarvis does NOT replace Discord. Discord remains the text/mobile/notification channel. Jarvis integrates with Discord for:

- **Notifications**: Jarvis can post to Discord when asked ("Hey Jarvis, tell Discord I'm stepping out")
- **Status**: Discord `#hub` gets notified when Jarvis starts/stops
- **Fallback**: If voice fails, Zack can always text via Discord

Implementation: Shell out to `~/.claude/bin/discord-notify.sh` via Claude's `Bash` tool.

### 5.2 Home Assistant

Via Claude's MCP server support. The `claude -p` command inherits MCP configuration from `~/.claude/settings.json`, so Home Assistant tools are available to voice queries:

- "Hey Jarvis, turn off the living room lights"
- "Hey Jarvis, what's the temperature downstairs?"
- "Hey Jarvis, lock the front door"

No additional integration needed -- Claude Code's MCP setup handles this.

### 5.3 SecondBrain

Via Claude's file tools (Read, Glob, Grep). The system prompt directs Claude to check SecondBrain files when asked about notes, projects, or active items:

- "Hey Jarvis, what's active in my projects?"
- "Hey Jarvis, add a note: call the dentist tomorrow"
- "Hey Jarvis, what's the status of the NYMBL project?"

### 5.4 Outlook (Calendar/Email)

Via Outlook MCP tools (already configured on the workstation):

- "Hey Jarvis, what's on my calendar today?"
- "Hey Jarvis, do I have any unread emails?"

### 5.5 Existing Workstation

Jarvis runs alongside the existing Claude Code hub agent. They don't conflict because:
- Hub agent: tmux session `claude-agent`, listens on Discord
- Jarvis: separate process, listens on microphone
- Both use the same Max subscription (shared rate limits)
- Both can read/write the same filesystem

---

## 6. Implementation Phases

### Phase 1: Push-to-Talk Voice Loop

**Goal:** Prove the core pipeline works end-to-end.
**Scope:** No wake word, no barge-in, no AEC. Manual push-to-talk via keyboard.

**Components to build:**
1. `audio_engine.py` -- mic capture only (no speaker output yet)
2. `stt.py` -- MLX Whisper transcription
3. `claude_bridge.py` -- `claude -p` subprocess with NDJSON streaming
4. `sentence_buffer.py` -- token accumulation
5. `tts.py` -- Kokoro TTS generation + playback
6. `main.py` -- simple loop: press key -> record -> transcribe -> Claude -> speak

**What we validate:**
- End-to-end latency (target: < 3s from speech end to first audio)
- Streaming NDJSON parsing works correctly
- Sentence buffering produces natural speech breaks
- TTS quality and voice selection
- Session continuity across turns

**What we skip:**
- Wake word, VAD, AEC, barge-in, state machine
- Intent classification (all queries go to Haiku)
- Filler phrases

### Phase 2: Wake Word + Always-On

**Goal:** Hands-free activation with "Hey Jarvis".

**Components to build:**
1. `wake_word.py` -- openWakeWord with "hey_jarvis" model
2. `vad.py` -- Silero VAD for end-of-speech detection
3. `state_machine.py` -- IDLE/LISTENING/PROCESSING/SPEAKING states
4. Update `audio_engine.py` -- continuous mic capture
5. Add acknowledgment tone after wake word

**What we validate:**
- Wake word detection reliability in Zack's environment
- VAD silence threshold tuning (300ms default)
- State transitions are clean
- CPU usage in IDLE state (target: < 5%)

### Phase 3: Echo Cancellation + Barge-In

**Goal:** Full-duplex conversation. User can interrupt Jarvis mid-sentence.

**Components to build:**
1. Update `audio_engine.py` -- add SpeexDSP AEC, speaker reference buffer, full-duplex stream
2. Barge-in logic in `state_machine.py` -- VAD-during-SPEAKING triggers interrupt
3. `claude_bridge.interrupt()` -- kill the subprocess
4. `sentence_buffer.reset()` -- clear buffered text
5. `tts.stop_playback()` -- immediate audio cutoff

**What we validate:**
- AEC quality (does Jarvis hear itself?)
- Barge-in reliability (false triggers vs missed triggers)
- Barge-in latency (target: < 300ms from speech to TTS stop)
- SpeexDSP filter convergence time

### Phase 4: Intent Classification + Dual Model

**Goal:** Smart routing -- fast responses for simple queries, deep reasoning for complex ones.

**Components to build:**
1. `intent.py` -- keyword-based classifier
2. Update `claude_bridge.py` -- support model/effort selection per query
3. Filler phrase system -- pre-rendered audio for tool execution delays
4. Pre-rendered fillers in `fillers/`

**What we validate:**
- Classification accuracy (are simple queries actually fast?)
- Haiku vs Opus latency difference in practice
- Filler phrases feel natural (not robotic or annoying)
- Tool execution flow (Claude reads files, runs commands, reports back)

### Phase 5: Integration + Polish

**Goal:** Connect to all workstation systems. Make it feel like Jarvis.

**Components to build:**
1. System prompt refinement based on real usage
2. Discord notifications from voice commands
3. SecondBrain queries and note creation
4. Calendar/email queries via Outlook MCP
5. Home Assistant commands
6. Startup/shutdown integration (LaunchAgent for auto-start)
7. Configuration file for tuning thresholds

**What we validate:**
- Integration reliability
- System prompt produces natural spoken responses
- Long-session stability (runs for hours without degradation)
- Memory/CPU usage over time

### Phase 6 (Future): Upgrades

**Potential improvements, not part of initial build:**
- Agent SDK migration (when Anthropic supports subscription billing)
- VoiceProcessingIO Swift bridge (better AEC quality)
- Web interface for visual companion
- Custom wake word trained on Zack's voice
- Conversation history viewer
- Voice-activated coding (dictate code changes)

---

## 7. Configuration

```python
@dataclass
class JarvisConfig:
    # Audio
    sample_rate: int = 16000
    channels: int = 1
    frame_size: int = 256           # samples per AEC frame

    # Wake word
    wake_model: str = "hey_jarvis"
    wake_threshold: float = 0.5

    # VAD
    silence_threshold_ms: int = 300  # end-of-speech
    barge_in_threshold_ms: int = 200 # speech during TTS
    listen_timeout_s: int = 10       # max wait for speech after wake

    # STT
    whisper_model: str = "base.en"

    # LLM
    default_model: str = "haiku"
    default_effort: str = "low"
    complex_model: str = "opus"
    complex_effort: str = "medium"
    default_tools: list = field(default_factory=lambda: [
        "Read", "Bash", "Glob", "Grep"
    ])
    max_budget_usd: float = 1.0      # per-query safety cap

    # TTS
    tts_voice: str = "af_heart"

    # Sentence buffer
    first_chunk_tokens: int = 24
    max_chunk_tokens: int = 96

    # State machine
    cooldown_ms: int = 500

    # AEC
    aec_filter_length: int = 2048    # samples (128ms echo tail)
```

Loaded from `~/.jarvis/config.yaml` with defaults.

---

## 8. Error Handling

| Scenario | Behavior |
|----------|----------|
| Claude CLI not found | Fatal error on startup, log instructions |
| Claude not authenticated | Fatal error on startup, prompt to run `claude /login` |
| API rate limit hit | Speak "I'm being rate limited. Try again in a moment." Retry after backoff. |
| Claude process crashes | Log error, speak "Something went wrong. Let me try again." Auto-retry once. |
| Whisper transcription empty | Return to IDLE silently (user said nothing meaningful) |
| Wake word false trigger | Whisper returns empty -> return to IDLE. Transparent. |
| TTS generation fails | Log error, skip that sentence, continue with next |
| Audio device disconnected | Attempt reconnection every 5s, notify Discord if prolonged |
| Out of memory | Unlikely on M4, but: restart Jarvis process, notify Discord |

---

## 9. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `claude -p` adds too much latency (>1s overhead) | Medium | High | Benchmark in Phase 1. If unacceptable, evaluate `--input-format stream-json` for persistent process. |
| `--bare` flag breaks tool access | Low | Medium | Test tool execution with `--bare`. If tools fail, remove `--bare` and accept the startup overhead. |
| openWakeWord "hey_jarvis" model has poor accuracy | Medium | Medium | Tune threshold. Fallback: train custom model or switch to sherpa-onnx. |
| SpeexDSP AEC quality insufficient | Medium | Medium | Phase 3 validates this. Upgrade path: Swift VoiceProcessingIO bridge. |
| Max subscription rate limits hit from voice usage | Low | High | Monitor usage. Set `--max-budget-usd` per query. Reduce model tier if hitting limits. |
| Anthropic changes `claude -p` behavior | Low | High | Pin Claude Code version. Monitor changelogs. Agent SDK migration is the backup. |
| "Ordinary individual usage" enforcement | Low | Medium | Personal use on own machine is clearly within bounds. Don't run 24/7 high-throughput. |
| Context compaction disrupts multi-turn voice | Medium | Low | Test long conversations. If problematic, reset session every N turns. |

---

## 10. Open Questions

1. **Does `--bare` still allow `--allowedTools`?** Need to verify that `--bare` only skips startup overhead and doesn't disable tool execution.

2. **What is the actual process startup overhead for `claude -p`?** Need to benchmark: bare vs non-bare, first invocation vs subsequent, with and without `--resume`.

3. **Can `--input-format stream-json` keep a single claude process alive for the whole session?** This would eliminate per-query process startup latency. Needs prototyping.

4. **How does `--resume` interact with `--bare`?** If `--bare` skips session persistence, `--resume` might not work.

5. **What is Kokoro's voice quality at 16kHz?** Models may be trained at 24kHz. Need to test resampling quality or adjust the pipeline sample rate.

6. **Does openWakeWord work reliably on macOS arm64?** The README doesn't list macOS as a tested platform. ONNX Runtime supports it, but the models are untested.

7. **What is the right `aec_filter_length` for Zack's setup?** Depends on speaker-to-mic distance and room acoustics. Start at 2048 (128ms), may need 4096 (256ms).

---

## 11. Success Criteria

The system is considered "working" when:

- [ ] Zack can say "Hey Jarvis" and get a spoken response within 3 seconds
- [ ] Multi-turn conversation works (context is maintained across turns)
- [ ] Barge-in stops Jarvis mid-sentence and listens to new input
- [ ] Simple queries (weather, time, greetings) respond in under 2 seconds
- [ ] Tool-using queries (file reads, calendar) work with appropriate filler
- [ ] The system runs for 8+ hours without crashing or degrading
- [ ] CPU usage stays under 5% when idle (just listening for wake word)
- [ ] False wake triggers are rare (< 1/hour)
- [ ] Zack can control Home Assistant via voice
- [ ] Zack can query SecondBrain via voice

---

## Appendix A: Latency Budget Breakdown

```
Component              Best    Typical   Worst
-------------------------------------------------
Wake word detection     10ms     30ms      50ms
VAD end-of-speech       --      300ms     500ms  (configurable silence wait)
Whisper STT            200ms    350ms     600ms
Intent classification    0ms      0ms     500ms  (Tier 2 Haiku, if used)
Claude CLI startup      50ms    150ms     300ms  (with --bare)
Claude API TTFT        360ms    600ms    1500ms  (Haiku)
Sentence buffering      --      200ms     400ms  (accumulating first chunk)
Kokoro TTS first chunk 200ms    400ms     600ms
-------------------------------------------------
TOTAL (no Tier 2)      820ms   2030ms    3950ms
TOTAL (with Tier 2)    820ms   2030ms    4450ms
```

Notes:
- VAD silence wait (300ms) is the biggest "waste" but necessary to avoid cutting off speech
- Claude API TTFT dominates the uncontrollable portion
- The `--bare` flag saves ~100-200ms vs standard startup
- Sentence buffering and TTS overlap with Claude streaming (pipelined, not sequential)

## Appendix B: NDJSON Stream Event Reference

Events emitted by `claude -p --output-format stream-json --verbose --include-partial-messages`:

```jsonc
// Text token (feed to TTS)
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}

// Tool call start
{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read","id":"toolu_xxx"}}}

// Tool input (ignore for voice)
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"..."}}}

// Block complete
{"type":"stream_event","event":{"type":"content_block_stop"}}

// Message complete
{"type":"stream_event","event":{"type":"message_stop"}}

// Final result (contains session_id)
{"type":"result","session_id":"abc-123","cost_usd":0.002}

// API retry (for voice feedback)
{"type":"system","subtype":"api_retry","attempt":1,"retry_delay_ms":1000}
```

## Appendix C: Future Agent SDK Migration

When Anthropic officially supports Max subscription in the Agent SDK, the migration path is:

1. Replace `claude_bridge.py` internals (subprocess -> SDK calls)
2. Keep the same `BridgeEvent` interface (`TextChunk`, `ToolStart`, etc.)
3. Replace NDJSON parsing with typed `StreamEvent` iteration
4. Replace `proc.terminate()` with `client.interrupt()`
5. Replace `--resume session_id` with `ClaudeSDKClient` stateful sessions

The rest of the pipeline (audio, wake word, VAD, STT, TTS, state machine) remains unchanged. This is why the `ClaudeBridge` abstraction exists -- it isolates the LLM integration from the voice pipeline.
