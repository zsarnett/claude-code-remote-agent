from dataclasses import dataclass


@dataclass
class TextChunk:
    text: str


@dataclass
class ToolStart:
    name: str


@dataclass
class ToolEnd:
    name: str = ""


@dataclass
class TurnComplete:
    session_id: str | None = None


@dataclass
class Error:
    message: str


@dataclass
class TranscriptionResult:
    text: str
    confidence: float = 0.0


@dataclass
class WakeWordDetected:
    score: float


@dataclass
class SpeechEnd:
    duration_ms: int


@dataclass
class StateChange:
    from_state: str
    to_state: str


BridgeEvent = TextChunk | ToolStart | ToolEnd | TurnComplete | Error
