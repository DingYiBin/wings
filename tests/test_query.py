"""Tests for the query engine and token budget."""

from unittest.mock import AsyncMock

import pytest

from wings.messages.types import (
    Message,
    Role,
    StopReason,
    TextBlock,
    TextDelta,
    ToolResultBlock,
    ToolUseBlock,
)
from wings.models.protocol import ModelConfig, ModelResponse, TokenUsage
from wings.models.registry import ModelRegistry
from wings.query.engine import QueryEngine, QueryError
from wings.query.token_budget import TokenBudget
from wings.routing.protocol import ModelSelector


# -- TokenBudget ---------------------------------------------------------------


def test_token_budget_remaining():
    budget = TokenBudget(context_window=100_000, reserved_for_output=4_000)
    messages = [
        Message(role=Role.USER, content=[TextBlock(text="hello")]),
    ]
    remaining = budget.remaining(messages)
    assert remaining > 90_000  # plenty of room


def test_token_budget_needs_compact_false():
    budget = TokenBudget(context_window=100_000)
    messages = [Message(role=Role.USER, content=[TextBlock(text="short")])]
    assert budget.needs_compact(messages) is False


def test_token_budget_needs_compact_true():
    budget = TokenBudget(context_window=100)
    big_text = "x" * 10_000
    messages = [Message(role=Role.USER, content=[TextBlock(text=big_text)])]
    assert budget.needs_compact(messages) is True


def test_token_budget_estimate_tokens():
    budget = TokenBudget(context_window=100_000)
    # 400 chars / 4 = ~100 tokens
    text = "x" * 400
    assert budget.estimate_tokens(text) == 100


def test_token_budget_estimate_short_text():
    budget = TokenBudget(context_window=100_000)
    assert budget.estimate_tokens("hi") == 1  # minimum


def test_token_budget_system_prompt():
    budget = TokenBudget(context_window=100_000, system_prompt_tokens=5_000)
    messages = [Message(role=Role.USER, content=[TextBlock(text="hello")])]
    remaining = budget.remaining(messages)
    # channel capacity minus system prompt minus output reserve minus message
    assert remaining < 100_000 - 4_096 - 5_000


def test_token_budget_tool_messages():
    budget = TokenBudget(context_window=100_000)
    messages = [
        Message(role=Role.ASSISTANT, content=[ToolUseBlock(id="1", name="read", input={})]),
        Message(role=Role.USER, content=[ToolResultBlock(tool_use_id="1", content="output")]),
    ]
    remaining = budget.remaining(messages)
    assert remaining > 0


def test_token_budget_no_messages():
    budget = TokenBudget(context_window=100_000)
    remaining = budget.remaining([])
    assert remaining == 100_000 - 4_096  # reserved_for_output


# -- QueryEngine ---------------------------------------------------------------


class _MockSelector:
    def select(self, task_type: str, override: str | None = None) -> str:
        return "test/model"


def _make_mock_provider(responses=None, stream_events=None):
    """Create a mock provider with configurable responses."""
    provider = AsyncMock()
    if responses:
        provider.chat.side_effect = responses
    else:
        provider.chat.return_value = ModelResponse(
            content=[TextBlock(text="hello from test")],
            stop_reason=StopReason.END_TURN,
            usage=TokenUsage(input_tokens=10, output_tokens=5),
        )
    if stream_events:
        provider.stream.return_value = stream_events
    else:
        async def _stream(*args, **kwargs):
            yield TextDelta(text="hello")
            yield TextDelta(text=" world")
        provider.stream = _stream
    return provider


@pytest.fixture
def engine():
    selector = _MockSelector()
    registry = ModelRegistry(selector)
    return QueryEngine(registry)


def test_chat_returns_response(engine):
    provider = _make_mock_provider()
    engine._registry.register("test/model", provider)

    config = ModelConfig(model="test/model", api_key="sk-test")
    messages = [Message(role=Role.USER, content=[TextBlock(text="hi")])]

    result = engine.chat(
        messages, model="test/model", tools=None, config=config
    )
    # chat is async, need to run it
    import asyncio
    result = asyncio.run(result)

    assert isinstance(result, ModelResponse)
    assert result.stop_reason == StopReason.END_TURN
    assert result.content[0].text == "hello from test"


def test_chat_unknown_model_raises(engine):
    config = ModelConfig(model="nonexistent", api_key="sk-test")
    messages = [Message(role=Role.USER, content=[TextBlock(text="hi")])]

    import asyncio
    with pytest.raises(KeyError, match="unknown model"):
        asyncio.run(engine.chat(messages, model="nonexistent", tools=None, config=config))


@pytest.mark.asyncio
async def test_stream_yields_events(engine):
    provider = _make_mock_provider()
    engine._registry.register("test/model", provider)

    config = ModelConfig(model="test/model", api_key="sk-test")
    messages = [Message(role=Role.USER, content=[TextBlock(text="hi")])]

    events = []
    async for event in engine.stream(messages, model="test/model", tools=None, config=config):
        events.append(event)

    assert len(events) == 2
    assert events[0].text == "hello"
    assert events[1].text == " world"


@pytest.mark.asyncio
async def test_stream_unknown_model_raises(engine):
    config = ModelConfig(model="nonexistent", api_key="sk-test")
    messages = [Message(role=Role.USER, content=[TextBlock(text="hi")])]

    with pytest.raises(KeyError, match="unknown model"):
        async for _ in engine.stream(messages, model="nonexistent", tools=None, config=config):
            pass


def test_retry_on_transient_error(engine):
    class TransientError(Exception):
        def __init__(self):
            self.status_code = 503

    provider = _make_mock_provider(responses=[
        TransientError(),
        TransientError(),
        ModelResponse(
            content=[TextBlock(text="finally")],
            stop_reason=StopReason.END_TURN,
            usage=TokenUsage(input_tokens=2, output_tokens=1),
        ),
    ])
    engine._registry.register("test/model", provider)

    config = ModelConfig(model="test/model", api_key="sk-test")
    messages = [Message(role=Role.USER, content=[TextBlock(text="hi")])]

    import asyncio
    result = asyncio.run(engine.chat(
        messages, model="test/model", tools=None, config=config
    ))
    assert result.content[0].text == "finally"
    assert provider.chat.call_count == 3


def test_retry_exhausted_raises_query_error(engine):
    class ServerError(Exception):
        def __init__(self):
            self.status_code = 500

    provider = _make_mock_provider(responses=[ServerError(), ServerError(), ServerError(), ServerError()])
    engine._registry.register("test/model", provider)

    config = ModelConfig(model="test/model", api_key="sk-test")
    messages = [Message(role=Role.USER, content=[TextBlock(text="hi")])]

    import asyncio
    with pytest.raises(QueryError, match="chat failed"):
        asyncio.run(engine.chat(
            messages, model="test/model", tools=None, config=config
        ))
    assert provider.chat.call_count == 4  # initial + 3 retries


def test_non_retriable_error_raises_immediately(engine):
    class AuthError(Exception):
        def __init__(self):
            self.status_code = 401  # not retriable

    provider = _make_mock_provider(responses=[AuthError()])
    engine._registry.register("test/model", provider)

    config = ModelConfig(model="test/model", api_key="sk-test")
    messages = [Message(role=Role.USER, content=[TextBlock(text="hi")])]

    import asyncio
    with pytest.raises(QueryError):
        asyncio.run(engine.chat(
            messages, model="test/model", tools=None, config=config
        ))
    assert provider.chat.call_count == 1  # no retries
