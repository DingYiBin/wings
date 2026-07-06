"""Tests for the agent module — handoff detection and core loop."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest

from wings.agent.handoff import HandoffDetector, TurnRecord
from wings.agent.loop import AgentContext, AgentLoop
from wings.messages.types import (
    Message,
    Role,
    TextBlock,
    TextDelta,
    ToolUseBlock,
)
from wings.models.protocol import ModelConfig
from wings.models.registry import ModelRegistry
from wings.permissions.pipeline import PermissionPipeline
from wings.permissions.rules import PermissionRules
from wings.query.engine import QueryEngine
from wings.tools.base import ToolResult
from wings.tools.registry import ToolRegistry

# -- HandoffDetector -----------------------------------------------------------

def make_turn(turn_id: int, model_id: str, summary: str = "") -> TurnRecord:
    return TurnRecord(
        turn_id=turn_id,
        model_id=model_id,
        timestamp=datetime.now(UTC),
        user_input_summary=summary,
        summary=summary,
    )


def test_handoff_no_history():
    detector = HandoffDetector()
    assert detector.detect("model-a", []) is None


def test_handoff_first_appearance():
    detector = HandoffDetector()
    history = [make_turn(0, "model-b", "did something")]
    assert detector.detect("model-a", history) is None


def test_handoff_same_model_consecutive():
    """No intervention — same model used twice in a row."""
    detector = HandoffDetector()
    history = [
        make_turn(0, "model-a", "first"),
        make_turn(1, "model-a", "second"),
    ]
    assert detector.detect("model-a", history) is None


def test_handoff_detected():
    """Model A was used, then B, now A again — handoff triggered."""
    detector = HandoffDetector()
    history = [
        make_turn(0, "model-a", "first task"),
        make_turn(1, "model-b", "handled something in between"),
    ]
    prompt = detector.detect("model-a", history)
    assert prompt is not None
    assert "model-b" in prompt
    assert "handled something in between" in prompt
    assert "turn #0" in prompt


def test_handoff_multiple_intervening():
    detector = HandoffDetector()
    history = [
        make_turn(0, "model-a", "task A"),
        make_turn(1, "model-b", "task B"),
        make_turn(2, "model-c", "task C"),
    ]
    prompt = detector.detect("model-a", history)
    assert prompt is not None
    assert "model-b" in prompt
    assert "model-c" in prompt


def test_handoff_only_intervening_models_listed():
    """Only models between A's last turn and now are mentioned."""
    detector = HandoffDetector()
    history = [
        make_turn(0, "model-a", "A's first"),  # first A
        make_turn(1, "model-b", "B's turn"),
        make_turn(2, "model-a", "A's second"),  # A returns
        make_turn(3, "model-c", "C's turn"),
    ]
    prompt = detector.detect("model-a", history)
    assert prompt is not None
    # Only model C intervened between A's last turn (2) and now
    assert "model-c" in prompt
    assert "model-b" not in prompt  # B was before A's last turn


# -- AgentLoop ----------------------------------------------------------------


class _FakeTool:
    """A simple tool that returns its input as output."""
    name = "echo"
    description = "echoes input"
    search_hint = "echo"
    _enabled = True

    def input_schema(self):
        return {"type": "object", "properties": {"msg": {"type": "string"}}}

    async def call(self, input, context):
        return ToolResult(output=f"echo: {getattr(input, 'msg', input)}")

    def is_enabled(self):
        return self._enabled

    def is_read_only(self, input=None):
        return True

    def is_destructive(self, input=None):
        return False

    def render_result(self, result):
        return result.output

    def activity_description(self, input=None):
        return "echoing..."


class _EchoInput:
    def __init__(self, msg="hello"):
        self.msg = msg


class _MockSelector:
    def select(self, task_type, override=None):
        return override or "test/model"


def _make_stream(blocks=None):
    """Create an async generator that yields deltas then complete blocks."""
    async def _stream(*args, **kwargs):
        for b in (blocks or [TextBlock(text="hello world")]):
            if isinstance(b, TextBlock):
                yield TextDelta(text=b.text)
                yield b  # complete block at end
            elif isinstance(b, ToolUseBlock):
                yield b  # tool block
    return _stream


def _make_engine(stream_blocks=None):
    """Create a QueryEngine with a mock provider.

    Args:
        stream_blocks: list of TextBlock/ToolUseBlock to yield from stream().
    """
    selector = _MockSelector()
    registry = ModelRegistry(selector)

    provider = AsyncMock()
    provider.provider_name = "anthropic"
    provider.stream = _make_stream(stream_blocks)

    config = ModelConfig(model="test/model", api_key="sk-test")
    registry.register("test/model", provider, config=config)
    return QueryEngine(registry), registry, provider


@pytest.fixture
def engine_registry_provider():
    return _make_engine()


@pytest.mark.asyncio
async def test_loop_simple_text_response(engine_registry_provider):
    engine, model_registry, provider = engine_registry_provider
    tools = ToolRegistry()
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules)
    selector = _MockSelector()

    loop = AgentLoop(engine, tools, pipeline, selector, model_registry)
    ctx = AgentContext(task_type="main")

    events = []
    async for event in loop.run("hello", ctx):
        events.append(event)

    assert len(events) == 1  # TextDelta (TextBlock collected internally)
    assert events[0].text == "hello world"


@pytest.mark.asyncio
async def test_loop_tool_use_cycle(engine_registry_provider):
    """Agent handles a tool_use response, executes it, and continues."""
    engine, model_registry, provider = engine_registry_provider
    tools = ToolRegistry()
    tools.register(_FakeTool())
    rules = PermissionRules(allowlist={"echo"})
    pipeline = PermissionPipeline(rules)
    selector = _MockSelector()

    call_count = 0

    async def _stream(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield ToolUseBlock(id="1", name="echo", input={"msg": "ping"})
        else:
            yield TextDelta(text="done after tool")
            yield TextBlock(text="done after tool")

    provider.stream = _stream

    loop = AgentLoop(engine, tools, pipeline, selector, model_registry)
    ctx = AgentContext(task_type="main")

    events = []
    async for event in loop.run("echo ping", ctx):
        events.append(event)

    assert call_count == 2
    # First call: tool block (no text), second call: text
    assert events[-1].text == "done after tool"


@pytest.mark.asyncio
async def test_loop_permission_denied(engine_registry_provider):
    """Tool use is denied by the permission pipeline."""
    engine, model_registry, provider = engine_registry_provider
    tools = ToolRegistry()
    tools.register(_FakeTool())
    rules = PermissionRules(denylist={"echo"})
    pipeline = PermissionPipeline(rules)
    selector = _MockSelector()

    call_count = 0

    async def _stream(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield ToolUseBlock(id="1", name="echo", input={"msg": "x"})
        else:
            yield TextDelta(text="got error, stopping")
            yield TextBlock(text="got error, stopping")

    provider.stream = _stream

    loop = AgentLoop(engine, tools, pipeline, selector, model_registry)
    ctx = AgentContext(task_type="main")

    async for _ in loop.run("echo x", ctx):
        pass

    assert call_count == 2


@pytest.mark.asyncio
async def test_loop_unknown_tool(engine_registry_provider):
    """Unknown tool in response is handled as an error."""
    engine, model_registry, provider = engine_registry_provider
    tools = ToolRegistry()
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules)
    selector = _MockSelector()

    call_count = 0

    async def _stream(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            yield ToolUseBlock(id="1", name="nonexistent", input={})
        else:
            yield TextDelta(text="ok")
            yield TextBlock(text="ok")

    provider.stream = _stream

    loop = AgentLoop(engine, tools, pipeline, selector, model_registry)
    ctx = AgentContext(task_type="main")

    async for _ in loop.run("hi", ctx):
        pass

    assert call_count == 2


@pytest.mark.asyncio
async def test_loop_handoff_injects_prompt(engine_registry_provider):
    """Main conversation triggers handoff when model changes mid-session."""
    engine, model_registry, provider = engine_registry_provider
    # Register under both names so the selector can switch between them
    cfg = ModelConfig(model="test", api_key="sk-test")
    model_registry.register("model-a", provider, config=cfg)
    model_registry.register("model-b", provider, config=cfg)

    tools = ToolRegistry()
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules)

    class SwitchingSelector:
        def __init__(self):
            self.calls = 0

        def select(self, task_type, override=None):
            self.calls += 1
            return "model-a" if self.calls % 2 == 1 else "model-b"

    selector = SwitchingSelector()
    loop = AgentLoop(engine, tools, pipeline, selector, model_registry)
    ctx = AgentContext(task_type="main")

    # Turn 1: model-a
    async for _ in loop.run("first", ctx):
        pass

    # Turn 2: model-b
    async for _ in loop.run("second", ctx):
        pass

    # Turn 3: model-a again — should trigger handoff
    async for _ in loop.run("third", ctx):
        pass

    # Check that a handoff message was injected
    handoff_found = False
    for msg in loop._messages:
        if msg.role == Role.USER:
            for block in msg.content:
                if isinstance(block, TextBlock) and "System notice" in block.text:
                    handoff_found = True
    assert handoff_found


@pytest.mark.asyncio
async def test_loop_system_prompt_injected_once(engine_registry_provider):
    engine, model_registry, provider = engine_registry_provider
    tools = ToolRegistry()
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules)
    selector = _MockSelector()

    loop = AgentLoop(engine, tools, pipeline, selector, model_registry)
    ctx = AgentContext(task_type="main", system_prompt="you are helpful")

    # Two turns — system prompt should only appear in messages once
    async for _ in loop.run("turn 1", ctx):
        pass
    async for _ in loop.run("turn 2", ctx):
        pass

    system_count = sum(
        1 for m in loop._messages
        if m.role == Role.SYSTEM
    )
    assert system_count == 1


# -- Token budget & truncation -------------------------------------------------


def test_needs_compact_false_for_short_history(engine_registry_provider):
    """Few messages should never trigger compaction."""
    engine, model_registry, _ = engine_registry_provider
    tools = ToolRegistry()
    pipeline = PermissionPipeline(PermissionRules())
    loop = AgentLoop(engine, tools, pipeline, _MockSelector(), model_registry)
    cfg = ModelConfig(model="test/model", api_key="sk-test", context_window=200_000)
    ctx = AgentContext(task_type="main")
    loop._messages = [
        Message(role=Role.USER, content=[TextBlock(text="hi")]),
        Message(role=Role.ASSISTANT, content=[TextBlock(text="hello")]),
    ]
    assert not loop._needs_compact(ctx, cfg)


def test_needs_compact_true_when_over_threshold():
    """Large message history should trigger compaction."""
    selector = _MockSelector()
    registry = ModelRegistry(selector)
    provider = AsyncMock()
    provider.provider_name = "test"
    provider.stream = _make_stream()
    registry.register("test/model", provider, config=ModelConfig(model="test/model", api_key="sk-test"))
    engine = QueryEngine(registry)

    loop = AgentLoop(engine, ToolRegistry(), PermissionPipeline(PermissionRules()), selector, registry)
    cfg = ModelConfig(model="test/model", api_key="sk-test", context_window=10_000)
    ctx = AgentContext(task_type="main")
    # 8 messages of ~5000 chars each = ~10000 tokens, exceeds 80% of 10k
    loop._messages = [
        Message(role=Role.USER, content=[TextBlock(text="x" * 5000)])
        for _ in range(8)
    ]
    assert loop._needs_compact(ctx, cfg)


def test_truncate_tool_result_under_limit():
    """Short output passes through unchanged."""
    loop = AgentLoop.__new__(AgentLoop)  # bypass __init__
    loop.MAX_TOOL_RESULT_CHARS = 100
    assert loop._truncate_tool_result("short") == "short"


def test_truncate_tool_result_over_limit():
    """Long output gets truncated with a notice."""
    loop = AgentLoop.__new__(AgentLoop)
    loop.MAX_TOOL_RESULT_CHARS = 100
    long_output = "x" * 500
    result = loop._truncate_tool_result(long_output)
    assert len(result) < len(long_output)
    assert "truncated" in result
    assert "500 total" in result
