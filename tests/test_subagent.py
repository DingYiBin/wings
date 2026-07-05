"""Tests for the subagent module."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from wings.agent.loop import AgentContext, AgentLoop
from wings.agent.subagent import (
    BUILTIN_AGENT_TYPES,
    AgentTypeSpec,
    _filter_tools_for_agent,
    run_subagent,
)
from wings.messages.types import (
    Message,
    Role,
    TextBlock,
    TextDelta,
    ToolResultBlock,
    ToolUseBlock,
)
from wings.permissions.pipeline import PermissionPipeline
from wings.permissions.rules import PermissionRules
from wings.routing.tasks import TASK_HIERARCHY
from wings.tools.base import ToolContext, ToolResult
from wings.tools.registry import ToolRegistry


# -- Agent type definitions ----------------------------------------------------

def test_builtin_types_exist():
    """All expected agent types are defined."""
    assert "general" in BUILTIN_AGENT_TYPES
    assert "explore" in BUILTIN_AGENT_TYPES
    assert "plan" in BUILTIN_AGENT_TYPES


def test_agent_types_have_valid_task_types():
    """Each agent type maps to a valid task_type in TASK_HIERARCHY."""
    for name, spec in BUILTIN_AGENT_TYPES.items():
        assert spec.task_type in TASK_HIERARCHY, (
            f"{name} has task_type '{spec.task_type}' not in TASK_HIERARCHY"
        )


def test_no_type_allows_agent_tool():
    """Agent tool is disallowed for all agent types (recursion prevention)."""
    for name, spec in BUILTIN_AGENT_TYPES.items():
        assert "agent" in spec.disallowed_tools, (
            f"{name} must disallow 'agent' to prevent recursive spawning"
        )


def test_explore_is_read_only():
    assert BUILTIN_AGENT_TYPES["explore"].read_only is True


def test_plan_is_read_only():
    assert BUILTIN_AGENT_TYPES["plan"].read_only is True


def test_general_is_not_read_only():
    assert BUILTIN_AGENT_TYPES["general"].read_only is False


def test_explore_has_explicit_tool_list():
    """Explore has a limited tool allowlist."""
    assert BUILTIN_AGENT_TYPES["explore"].tools is not None


def test_general_wildcard_tools():
    """General agent has None tools (wildcard = all)."""
    assert BUILTIN_AGENT_TYPES["general"].tools is None


# -- Tool filtering ------------------------------------------------------------


class _FakeTool:
    """Minimal tool for testing filtering."""
    def __init__(self, name, read_only=True, destructive=False):
        self.name = name
        self.description = f"desc:{name}"
        self.search_hint = f"hint:{name}"
        self._read_only = read_only
        self._destructive = destructive

    def input_schema(self):
        return {"type": "object"}

    async def call(self, input, context):
        return ToolResult(output=f"result:{self.name}")

    def is_enabled(self):
        return True

    def is_read_only(self, input=None):
        return self._read_only

    def is_destructive(self, input=None):
        return self._destructive

    def render_result(self, result):
        return result.output

    def activity_description(self, input=None):
        return f"doing:{self.name}"


def _make_registry(tool_names, **kwargs):
    """Create a ToolRegistry with named fake tools."""
    reg = ToolRegistry()
    for name in tool_names:
        reg.register(_FakeTool(name, **kwargs))
    return reg


def test_filter_explore_only_read_tools():
    reg = _make_registry(["read", "write", "bash", "glob", "grep", "skill_view", "agent"])
    spec = BUILTIN_AGENT_TYPES["explore"]
    filtered = _filter_tools_for_agent(reg, spec)
    names = {t.name for t in filtered.list_all()}
    assert names == {"read", "glob", "grep", "skill_view"}


def test_filter_general_has_all_except_agent():
    reg = _make_registry(["read", "write", "edit", "bash", "glob", "grep", "skill_view", "agent"])
    spec = BUILTIN_AGENT_TYPES["general"]
    filtered = _filter_tools_for_agent(reg, spec)
    names = {t.name for t in filtered.list_all()}
    assert "agent" not in names
    assert "bash" in names
    assert "write" in names


def test_filter_plan_no_write_edit():
    reg = _make_registry(["read", "write", "edit", "bash", "glob", "grep", "skill_view", "agent"])
    spec = BUILTIN_AGENT_TYPES["plan"]
    filtered = _filter_tools_for_agent(reg, spec)
    names = {t.name for t in filtered.list_all()}
    assert "write" not in names
    assert "edit" not in names
    assert "agent" not in names
    assert "read" in names
    assert "bash" in names


def test_filter_read_only_removes_destructive():
    reg = _make_registry(["read", "bash", "write"])
    # Make bash and write destructive
    # Override with specific instances
    reg2 = ToolRegistry()
    reg2.register(_FakeTool("read", read_only=True, destructive=False))
    reg2.register(_FakeTool("bash", read_only=False, destructive=True))
    reg2.register(_FakeTool("write", read_only=False, destructive=True))
    spec = AgentTypeSpec(
        name="test", description="test",
        tools=None, disallowed_tools=["agent"], read_only=True,
    )
    filtered = _filter_tools_for_agent(reg2, spec)
    names = {t.name for t in filtered.list_all()}
    assert names == {"read"}


def test_filter_agent_always_denied():
    """Agent tool is removed even if not explicitly listed in disallowed_tools."""
    reg = _make_registry(["read", "agent"])
    spec = AgentTypeSpec(
        name="test", description="test",
        tools=None, disallowed_tools=[], read_only=False,
    )
    filtered = _filter_tools_for_agent(reg, spec)
    names = {t.name for t in filtered.list_all()}
    assert "agent" not in names


def test_filter_does_not_mutate_parent():
    reg = _make_registry(["read", "write", "bash", "glob", "grep", "skill_view", "agent"])
    original = {t.name for t in reg.list_all()}
    spec = BUILTIN_AGENT_TYPES["explore"]
    _filter_tools_for_agent(reg, spec)
    assert {t.name for t in reg.list_all()} == original


def test_filter_nonexistent_tools_skipped():
    """Tools in allowlist that don't exist in parent are skipped."""
    reg = _make_registry(["read", "glob"])
    spec = AgentTypeSpec(
        name="test", description="test",
        tools=["read", "nonexistent", "glob"],
        disallowed_tools=["agent"],
    )
    filtered = _filter_tools_for_agent(reg, spec)
    names = {t.name for t in filtered.list_all()}
    assert names == {"read", "glob"}


# -- run_subagent --------------------------------------------------------------


def _make_mock_engine():
    """Create a QueryEngine whose stream() returns events from a preset list."""
    engine = MagicMock()
    return engine


def _make_mock_registry(model_id="test/model"):
    """Create a ModelRegistry that returns a mock provider."""
    reg = MagicMock()
    reg.build_config.return_value = MagicMock()
    return reg


def _make_mock_selector(model_id="test/model"):
    """Create a mock ModelSelector."""
    selector = MagicMock()
    selector.select.return_value = model_id
    return selector


@pytest.mark.asyncio
async def test_run_subagent_returns_text():
    """Simple text-only subagent response."""
    engine = _make_mock_engine()

    async def _stream(messages, model, tools, config):
        yield TextDelta(text="Done.")
        yield TextBlock(text="Done.")

    engine.stream = _stream

    result = await run_subagent(
        prompt="do something",
        agent_type="general",
        query_engine=engine,
        model_registry=_make_mock_registry(),
        tool_registry=_make_registry(["read", "glob", "grep", "skill_view"]),
        model_selector=_make_mock_selector(),
        working_dir="/tmp",
    )
    assert result == "Done."


@pytest.mark.asyncio
async def test_run_subagent_uses_correct_task_type():
    """Subagent queries use the agent type's task_type for routing."""
    engine = _make_mock_engine()

    async def _stream(messages, model, tools, config):
        yield TextDelta(text="ok")
        yield TextBlock(text="ok")

    engine.stream = _stream
    selector = _make_mock_selector()

    await run_subagent(
        prompt="explore this",
        agent_type="explore",
        query_engine=engine,
        model_registry=_make_mock_registry(),
        tool_registry=_make_registry(["read", "glob", "grep", "skill_view"]),
        model_selector=selector,
        working_dir="/tmp",
    )
    # Model selector should have been called with subagent/explore
    select_calls = selector.select.call_args_list
    assert any("subagent/explore" in str(c) for c in select_calls)


@pytest.mark.asyncio
async def test_run_subagent_tool_cycle():
    """Subagent uses a tool, gets result, and continues."""
    engine = _make_mock_engine()

    call_count = [0]

    async def _stream(messages, model, tools, config):
        call_count[0] += 1
        if call_count[0] == 1:
            yield ToolUseBlock(id="tu1", name="read", input={"file_path": "/tmp/x"})
        else:
            yield TextDelta(text="result text")
            yield TextBlock(text="result text")

    engine.stream = _stream

    # Register a real-ish read tool that subagent can use
    tools = ToolRegistry()
    read_tool = _FakeTool("read", read_only=True)
    tools.register(read_tool)

    result = await run_subagent(
        prompt="read something",
        agent_type="explore",
        query_engine=engine,
        model_registry=_make_mock_registry(),
        tool_registry=tools,
        model_selector=_make_mock_selector(),
        working_dir="/tmp",
    )
    assert result == "result text"
    assert call_count[0] == 2  # two API calls: tool call + final text


@pytest.mark.asyncio
async def test_run_subagent_unknown_type():
    """Unknown agent type returns error message."""
    result = await run_subagent(
        prompt="test",
        agent_type="nonexistent",
        query_engine=_make_mock_engine(),
        model_registry=_make_mock_registry(),
        tool_registry=_make_registry(["read"]),
        model_selector=_make_mock_selector(),
        working_dir="/tmp",
    )
    assert "Error" in result
    assert "nonexistent" in result


@pytest.mark.asyncio
async def test_run_subagent_event_callback():
    """Events are pushed to the callback."""
    engine = _make_mock_engine()

    async def _stream(messages, model, tools, config):
        yield TextDelta(text="hello")
        yield TextBlock(text="hello")

    engine.stream = _stream

    events = []

    async def _cb(event):
        events.append(event)

    await run_subagent(
        prompt="test",
        agent_type="general",
        query_engine=engine,
        model_registry=_make_mock_registry(),
        tool_registry=_make_registry(["read"]),
        model_selector=_make_mock_selector(),
        working_dir="/tmp",
        event_callback=_cb,
    )
    assert len(events) > 0
    assert any(isinstance(e, TextDelta) for e in events)


@pytest.mark.asyncio
async def test_run_subagent_fresh_messages():
    """Each run_subagent call creates a new AgentLoop (isolated messages)."""
    engine = _make_mock_engine()
    messages_sent = []

    async def _stream(messages, model, tools, config):
        messages_sent.append(messages)
        yield TextDelta(text="ok")
        yield TextBlock(text="ok")

    engine.stream = _stream

    await run_subagent(
        prompt="first",
        agent_type="general",
        query_engine=engine,
        model_registry=_make_mock_registry(),
        tool_registry=_make_registry(["read"]),
        model_selector=_make_mock_selector(),
        working_dir="/tmp",
    )
    # First message should be system + user, not a continuation
    assert len(messages_sent) == 1
    msgs = messages_sent[0]
    roles = [m.role for m in msgs]
    assert Role.SYSTEM in roles
    assert Role.USER in roles


@pytest.mark.asyncio
async def test_run_subagent_permission_auto_allows():
    """Subagent tools are auto-allowed — no permission requests."""
    engine = _make_mock_engine()

    call_count = [0]

    async def _stream(messages, model, tools, config):
        call_count[0] += 1
        if call_count[0] == 1:
            yield ToolUseBlock(id="tu1", name="read", input={"file_path": "/tmp/x"})
        else:
            yield TextDelta(text="final output")
            yield TextBlock(text="final output")

    engine.stream = _stream

    tools = ToolRegistry()
    tools.register(_FakeTool("read", read_only=True))

    # Should not raise or block — tools are pre-allowed
    result = await run_subagent(
        prompt="read",
        agent_type="explore",
        query_engine=engine,
        model_registry=_make_mock_registry(),
        tool_registry=tools,
        model_selector=_make_mock_selector(),
        working_dir="/tmp",
    )
    # The subagent executed the tool (auto-allowed) and completed the turn
    assert "final output" in result


# -- Agent tool schema ---------------------------------------------------------


def test_agent_input_schema():
    """Verify the agent tool input schema has expected fields."""
    from wings.tools.builtin.agent import AgentInput
    schema = AgentInput.model_json_schema()
    props = schema["properties"]
    assert "description" in props
    assert "prompt" in props
    assert "subagent_type" in props
    assert props["subagent_type"].get("default") == "general"


# -- Agent type spec construction ----------------------------------------------


def test_agent_spec_defaults():
    """AgentTypeSpec default values."""
    spec = AgentTypeSpec(name="test", description="A test agent")
    assert spec.tools is None
    assert spec.disallowed_tools == []
    assert spec.read_only is False
    assert spec.task_type == ""
