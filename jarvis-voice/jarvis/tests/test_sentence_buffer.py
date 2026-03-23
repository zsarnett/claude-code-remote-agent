"""Tests for the sentence buffer."""
from jarvis.sentence_buffer import SentenceBuffer


def test_basic_sentence():
    buf = SentenceBuffer(first_chunk_tokens=3, max_chunk_tokens=5)
    buf.feed("Hello there! How are you?")
    s = buf.get_sentence()
    assert s is not None
    assert "Hello there!" in s


def test_streaming_tokens():
    buf = SentenceBuffer(first_chunk_tokens=3, max_chunk_tokens=5)
    for word in ["Hello", " there", "!", " How", " are", " you", "?"]:
        buf.feed(word)
    s = buf.get_sentence()
    assert s is not None
    assert "Hello there!" in s


def test_flush_remainder():
    buf = SentenceBuffer(first_chunk_tokens=50, max_chunk_tokens=50)
    buf.feed("Short text")
    assert buf.get_sentence() is None  # Not enough words
    s = buf.flush()
    assert s == "Short text"


def test_reset():
    buf = SentenceBuffer(first_chunk_tokens=3, max_chunk_tokens=5)
    buf.feed("Hello there! More text.")
    buf.reset()
    assert buf.get_sentence() is None
    assert buf.flush() is None


def test_multiple_sentences():
    buf = SentenceBuffer(first_chunk_tokens=3, max_chunk_tokens=5)
    buf.feed("First sentence here. Second sentence here. Third one.")

    sentences = []
    while True:
        s = buf.get_sentence()
        if s is None:
            break
        sentences.append(s.strip())

    remainder = buf.flush()
    if remainder:
        sentences.append(remainder.strip())

    # Should have extracted at least 2 chunks
    assert len(sentences) >= 2
    full = " ".join(sentences)
    assert "First" in full
    assert "Third" in full


def test_empty_feed():
    buf = SentenceBuffer()
    buf.feed("")
    assert buf.get_sentence() is None
    assert buf.flush() is None


def test_force_emit_long_text():
    buf = SentenceBuffer(first_chunk_tokens=5, max_chunk_tokens=5)
    # Feed text with no sentence boundaries
    words = " ".join(f"word{i}" for i in range(12))
    buf.feed(words)
    s = buf.get_sentence()
    assert s is not None  # Should force-emit
