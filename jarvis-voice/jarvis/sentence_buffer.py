import logging
import re
from typing import Optional

log = logging.getLogger(__name__)

SENTENCE_END = re.compile(r"[.!?][\s]")
SENTENCE_END_FINAL = re.compile(r"[.!?]$")


class SentenceBuffer:
    """Accumulates streaming text and emits complete sentences."""

    def __init__(
        self, first_chunk_tokens: int = 24, max_chunk_tokens: int = 96
    ) -> None:
        self._buffer = ""
        self._first_emitted = False
        self._first_chunk_tokens = first_chunk_tokens
        self._max_chunk_tokens = max_chunk_tokens

    def _word_count(self, text: str) -> int:
        """Approximate token count as word count."""
        return len(text.split())

    def _current_threshold(self) -> int:
        if not self._first_emitted:
            return self._first_chunk_tokens
        return self._max_chunk_tokens

    def feed(self, text: str) -> None:
        """Feed a text chunk into the buffer."""
        self._buffer += text

    def get_sentence(self) -> Optional[str]:
        """Get the next complete sentence if one is ready, otherwise None."""
        threshold = self._current_threshold()
        force_limit = threshold * 2
        # For the first chunk, emit at any sentence boundary with 2+ words
        # to get audio out as fast as possible.
        min_words = 2 if not self._first_emitted else 3

        # Look for sentence boundary (.!? followed by space)
        match = SENTENCE_END.search(self._buffer)
        if match:
            candidate = self._buffer[: match.end()].strip()
            wc = self._word_count(candidate)
            # Emit at sentence boundary once we have enough words
            if wc >= min_words:
                self._buffer = self._buffer[match.end():]
                self._first_emitted = True
                return candidate

        # Check for sentence ending at buffer end
        stripped = self._buffer.rstrip()
        if SENTENCE_END_FINAL.search(stripped):
            wc = self._word_count(stripped)
            if wc >= min_words:
                self._buffer = ""
                self._first_emitted = True
                return stripped

        # Force emit at word boundary if buffer is too long
        if self._word_count(self._buffer) >= force_limit:
            words = self._buffer.split()
            emit_words = words[:threshold]
            remaining_words = words[threshold:]
            self._buffer = " ".join(remaining_words)
            if self._buffer:
                self._buffer += " "
            self._first_emitted = True
            return " ".join(emit_words)

        return None

    def flush(self) -> Optional[str]:
        """Flush any remaining text in the buffer."""
        text = self._buffer.strip()
        self._buffer = ""
        if text:
            self._first_emitted = True
            return text
        return None

    def reset(self) -> None:
        """Clear the buffer and reset state."""
        self._buffer = ""
        self._first_emitted = False
