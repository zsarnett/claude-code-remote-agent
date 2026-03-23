import re
import logging
from dataclasses import dataclass

log = logging.getLogger(__name__)


@dataclass
class Intent:
    domain: str         # "general", "code", "home", "calendar", "notes"
    needs_opus: bool    # whether Opus should also run for deeper work
    play_filler: bool   # whether to play filler before response (voice mode)


# Queries where Opus adds value (tools, analysis, reasoning)
OPUS_PATTERNS = [
    re.compile(r"(build|create|implement|refactor|debug|fix|write)", re.I),
    re.compile(r"(analyze|compare|review|design|architect|plan)", re.I),
    re.compile(r"(read|edit|change|update|modify) .+ (file|code|project)", re.I),
    re.compile(r"(summarize|outline|draft|compose|write) .{20,}", re.I),
    re.compile(r"(calendar|schedule|meeting|event|appointment)", re.I),
    re.compile(r"(what.+today|what.+tomorrow|what.+this week)", re.I),
    re.compile(r"(note|remember|add to brain|what.+active|what.+going on)", re.I),
    re.compile(r"(second ?brain|vault|projects?|status)", re.I),
    re.compile(r"(check|look up|find|search|get)", re.I),
    re.compile(r"(email|inbox|unread|outlook)", re.I),
    re.compile(r"(dispatch|session|project)", re.I),
]

# Queries where Haiku alone is sufficient (no Opus needed)
HAIKU_ONLY_PATTERNS = [
    re.compile(r"^(hi|hello|hey|good morning|good evening|good night)\b", re.I),
    re.compile(r"^(thanks|thank you|ok|okay|got it|cool|nice|bye|goodbye)\b", re.I),
    re.compile(r"^(what time|what day|what date)\b", re.I),
    re.compile(r"^(yes|no|sure|nope)\b", re.I),
]

HOME_PATTERNS = [
    re.compile(r"(light|lamp|switch|thermostat|temperature|lock|door|garage)", re.I),
    re.compile(r"(turn on|turn off|set|dim|brighten)", re.I),
]

CALENDAR_PATTERNS = [
    re.compile(r"(calendar|schedule|meeting|event|appointment)", re.I),
    re.compile(r"(what.+today|what.+tomorrow|what.+this week)", re.I),
]

NOTES_PATTERNS = [
    re.compile(r"(note|remember|add to brain|what.+active|what.+going on)", re.I),
    re.compile(r"(second ?brain|vault|projects?|status)", re.I),
]

CODE_PATTERNS = [
    re.compile(r"(build|create|implement|refactor|debug|fix|write)", re.I),
    re.compile(r"(analyze|compare|review|design|architect|plan)", re.I),
    re.compile(r"(read|edit|change|update|modify) .+ (file|code|project)", re.I),
]


class IntentClassifier:
    def __init__(self, config=None):
        from jarvis.config import JarvisConfig
        self._config = config or JarvisConfig()

    def _detect_domain(self, text: str) -> str:
        """Detect the domain from the query text."""
        if any(p.search(text) for p in HOME_PATTERNS):
            return "home"
        if any(p.search(text) for p in CALENDAR_PATTERNS):
            return "calendar"
        if any(p.search(text) for p in NOTES_PATTERNS):
            return "notes"
        if any(p.search(text) for p in CODE_PATTERNS):
            return "code"
        return "general"

    def classify(self, text: str) -> Intent:
        """Classify transcribed text and return routing info.

        Haiku ALWAYS fires first as the instant feedback layer.
        This classifier determines whether Opus should ALSO run in
        parallel for deeper work (tool use, analysis, etc.).

        The only queries that skip Opus are simple greetings, yes/no,
        and trivial factual questions where Haiku is sufficient alone.
        """
        text_clean = text.strip()
        domain = self._detect_domain(text_clean)

        # Simple greetings and acknowledgments -- Haiku only
        if any(p.search(text_clean) for p in HAIKU_ONLY_PATTERNS):
            return Intent(domain=domain, needs_opus=False, play_filler=False)

        # Home commands -- Haiku handles these fine via MCP
        if domain == "home":
            return Intent(domain=domain, needs_opus=False, play_filler=False)

        # Anything that matches Opus patterns -- fire both
        if any(p.search(text_clean) for p in OPUS_PATTERNS):
            return Intent(domain=domain, needs_opus=True, play_filler=True)

        # Default: for queries longer than a few words, fire Opus too.
        # Short queries (< 5 words) are likely simple enough for Haiku alone.
        needs_opus = len(text_clean.split()) >= 5
        return Intent(
            domain=domain,
            needs_opus=needs_opus,
            play_filler=needs_opus,
        )
