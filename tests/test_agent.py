"""Tests for the agent module — handoff detection and core loop."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from wings.agent.handoff import HandoffDetector, TurnRecord
from wings.agent.loop import AgentContext, AgentLoop
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
from wings.permissions.pipeline import PermissionPipeline
from wings.permissions.rules import PermissionRules
from wings.query.engine import QueryEngine
from wings.tools.base import ToolContext, ToolResult
from wings.tools.registry import ToolRegistry


# -- HandoffDetector -----------------------------------------------------------

def make_turn(turn_id: int, model_id: str, summary: str = "") -> TurnRecord:
    return TurnRecord(
        turn_id=turn_id,
        model_id=model_id,
        timestamp=datetime.now(timezone.utc),
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


def _make_engine(responses=None):
    """Create a QueryEngine with a mock provider that returns canned responses."""
    selector = _MockSelector()
    registry = ModelRegistry(selector)

    provider = AsyncMock()
    if responses:
        provider.chat.side_effect = responses
    else:
        provider.chat.return_value = ModelResponse(
            content=[TextBlock(text="hello world")],
            stop_reason=StopReason.END_TURN,
            usage=TokenUsage(input_tokens=5, output_tokens=5),
        )
    registry.register("test/model", provider)
    return QueryEngine(registry), provider


@pytest.fixture
def engine_and_provider():
    return _make_engine()


@pytest.mark.asyncio
async def test_loop_simple_text_response(engine_and_provider):
    engine, provider = engine_and_provider
    registry = ToolRegistry()
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules)
    selector = _MockSelector()

    loop = AgentLoop(engine, registry, pipeline, selector)
    ctx = AgentContext(task_type="main")

    events = []
    async for event in loop.run("hello", ctx):
        events.append(event)

    assert len(events) == 1
    assert events[0].text == "hello world"
    provider.chat.assert_called_once()


@pytest.mark.asyncio
async def test_loop_tool_use_cycle(engine_and_provider):
    """Agent handles a tool_use response, executes it, and continues."""
    engine, provider = engine_and_provider
    registry = ToolRegistry()
    registry.register(_FakeTool())
    rules = PermissionRules(allowlist={"echo"})
    pipeline = PermissionPipeline(rules)
    selector = _MockSelector()

    # First response: tool_use, second: final text
    class EchoCall:
        msg = "ping"

    provider.chat.side_effect = [
        ModelResponse(
            content=[ToolUseBlock(id="1", name="echo", input={"msg": "ping"})],
            stop_reason=StopReason.TOOL_USE,
            usage=TokenUsage(input_tokens=5, output_tokens=5),
        ),
        ModelResponse(
            content=[TextBlock(text="done after tool")],
            stop_reason=StopReason.END_TURN,
            usage=TokenUsage(input_tokens=10, output_tokens=5),
        ),
    ]

    loop = AgentLoop(engine, registry, pipeline, selector)
    ctx = AgentContext(task_type="main")

    events = []
    async for event in loop.run("echo ping", ctx):
        events.append(event)

    # Two chat calls: one for tool_use, one for final
    assert provider.chat.call_count == 2
    assert len(events) == 1
    assert events[0].text == "done after tool"


@pytest.mark.asyncio
async def test_loop_permission_denied(engine_and_provider):
    """Tool use is denied by the permission pipeline."""
    engine, provider = engine_and_provider
    registry = ToolRegistry()
    registry.register(_FakeTool())
    rules = PermissionRules(denylist={"echo"})
    pipeline = PermissionPipeline(rules)
    selector = _MockSelector()

    provider.chat.side_effect = [
        ModelResponse(
            content=[ToolUseBlock(id="1", name="echo", input={"msg": "x"})],
            stop_reason=StopReason.TOOL_USE,
            usage=TokenUsage(input_tokens=5, output_tokens=5),
        ),
        ModelResponse(
            content=[TextBlock(text="got error, stopping")],
            stop_reason=StopReason.END_TURN,
            usage=TokenUsage(input_tokens=5, output_tokens=5),
        ),
    ]

    loop = AgentLoop(engine, registry, pipeline, selector)
    ctx = AgentContext(task_type="main")

    async for _ in loop.run("echo x", ctx):
        pass

    assert provider.chat.call_count == 2


@pytest.mark.asyncio
async def test_loop_unknown_tool(engine_and_provider):
    """Unknown tool in response is handled as an error."""
    engine, provider = engine_and_provider
    registry = ToolRegistry()
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules)
    selector = _MockSelector()

    provider.chat.side_effect = [
        ModelResponse(
            content=[ToolUseBlock(id="1", name="nonexistent", input={})],
            stop_reason=StopReason.TOOL_USE,
            usage=TokenUsage(input_tokens=5, output_tokens=5),
        ),
        ModelResponse(
            content=[TextBlock(text="ok")],
            stop_reason=StopReason.END_TURN,
            usage=TokenUsage(input_tokens=5, output_tokens=2),
        ),
    ]

    loop = AgentLoop(engine, registry, pipeline, selector)
    ctx = AgentContext(task_type="main")

    async for _ in loop.run("hi", ctx):
        pass

    assert provider.chat.call_count == 2


@pytest.mark.asyncio
async def test_loop_handoff_injects_prompt(engine_and_provider):
    """Main conversation triggers handoff when model changes mid-session."""
    engine, provider = engine_and_provider
    # Register under both names so the selector can switch between them
    engine._registry.register("model-a", provider)
    engine._registry.register("model-b", provider)

    registry = ToolRegistry()
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules)

    class SwitchingSelector:
        def __init__(self):
            self.calls = 0

        def select(self, task_type, override=None):
            self.calls += 1
            return "model-a" if self.calls % 2 == 1 else "model-b"

    selector = SwitchingSelector()
    loop = AgentLoop(engine, registry, pipeline, selector)
    ctx = AgentContext(task_type="main")

    # Turn 1: model-a
    async for _ in loop.run("first", ctx):
        pass

    # Turn 2: model-b
    async for _ in loop.run("second", ctx):
        pass

    # Turn 3: model-a again — should trigger handoff
    # The handoff prompt should be injected into _messages
    provider.chat.return_value = ModelResponse(
        content=[TextBlock(text="back again")],
        stop_reason=StopReason.END_TURN,
        usage=TokenUsage(input_tokens=5, output_tokens=5),
    )
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
async def test_loop_system_prompt_injected_once(engine_and_provider):
    engine, provider = engine_and_provider
    registry = ToolRegistry()
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules)
    selector = _MockSelector()

    loop = AgentLoop(engine, registry, pipeline, selector)
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
