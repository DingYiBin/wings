"""Tests for the compaction service."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from wings.messages.types import Message, Role, TextBlock, TextDelta
from wings.models.protocol import ModelConfig
from wings.models.registry import ModelRegistry
from wings.query.engine import QueryEngine
from wings.services.compact import _messages_to_text, compact_messages


class _MockSelector:
    def select(self, task_type, override=None):
        return override or "test/model"


def _make_engine_with_summary(summary_text: str):
    """Create a QueryEngine whose stream yields a fixed summary."""
    selector = _MockSelector()
    registry = ModelRegistry(selector)

    async def _stream(*args, **kwargs):
        yield TextDelta(text=summary_text)

    provider = AsyncMock()
    provider.provider_name = "test"
    provider.stream = _stream
    config = ModelConfig(model="test/model", api_key="sk-test")
    registry.register("test/model", provider, config=config)
    return QueryEngine(registry)


def _make_messages(n: int, *, with_system: bool = True) -> list[Message]:
    """Build a list of n alternating user/assistant messages."""
    msgs: list[Message] = []
    if with_system:
        msgs.append(Message(role=Role.SYSTEM, content=[TextBlock(text="system prompt")]))
    for i in range(n):
        role = Role.USER if i % 2 == 0 else Role.ASSISTANT
        msgs.append(Message(role=role, content=[TextBlock(text=f"message {i}")]))
    return msgs


@pytest.mark.asyncio
async def test_compact_preserves_system_prompt():
    """System prompt must be kept verbatim in the result."""
    engine = _make_engine_with_summary("summary text")
    msgs = _make_messages(20)
    config = ModelConfig(model="test/model", api_key="sk-test")

    result = await compact_messages(msgs, query_engine=engine, model="test/model", config=config)

    assert result[0].role == Role.SYSTEM
    assert result[0].content[0].text == "system prompt"  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_compact_preserves_recent_messages():
    """The last keep_recent messages must be kept verbatim."""
    engine = _make_engine_with_summary("summary text")
    msgs = _make_messages(20)
    config = ModelConfig(model="test/model", api_key="sk-test")

    result = await compact_messages(
        msgs, query_engine=engine, model="test/model", config=config, keep_recent=4
    )

    # Last 4 messages of the original (excluding system) should be at the end
    recent_original = msgs[-4:]
    recent_result = result[-4:]
    for orig, res in zip(recent_original, recent_result):
        assert orig.role == res.role
        assert orig.content[0].text == res.content[0].text  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_compact_inserts_summary_message():
    """A summary message must appear between system prompt and recent messages."""
    engine = _make_engine_with_summary("This is the summary.")
    msgs = _make_messages(20)
    config = ModelConfig(model="test/model", api_key="sk-test")

    result = await compact_messages(
        msgs, query_engine=engine, model="test/model", config=config, keep_recent=4
    )

    # Structure: [system, summary, *4 recent]
    assert len(result) == 6
    assert result[0].role == Role.SYSTEM
    assert result[1].role == Role.USER
    assert "This is the summary." in result[1].content[0].text  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_compact_skips_when_too_few_messages():
    """If there aren't enough messages, compaction is a no-op."""
    engine = _make_engine_with_summary("summary")
    msgs = _make_messages(4)
    config = ModelConfig(model="test/model", api_key="sk-test")

    result = await compact_messages(msgs, query_engine=engine, model="test/model", config=config)
    assert result is msgs  # same list, unchanged


def test_messages_to_text_includes_roles():
    """_messages_to_text should label each message with its role."""
    msgs = [
        Message(role=Role.USER, content=[TextBlock(text="hello")]),
        Message(role=Role.ASSISTANT, content=[TextBlock(text="hi there")]),
    ]
    text = _messages_to_text(msgs)
    assert "USER" in text
    assert "ASSISTANT" in text
    assert "hello" in text
    assert "hi there" in text
