"""Tests for the models module — adapter protocol, registry, capabilities."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from wings.messages.types import (
    Message,
    Role,
    StopReason,
    TextBlock,
    TextDelta,
    ToolUseBlock,
    ToolUseDelta,
)
from wings.models.anthropic import AnthropicProvider
from wings.models.capabilities import (
    CAPABILITY_CATALOG,
    ModelCapabilities,
    get_capabilities,
)
from wings.models.openai import OpenAIProvider
from wings.models.protocol import (
    ModelConfig,
    ModelResponse,
    TokenUsage,
)
from wings.models.registry import ModelRegistry
from wings.routing.protocol import ModelSelector


# -- ModelConfig / TokenUsage / ModelResponse ----------------------------------

def test_model_config_defaults():
    config = ModelConfig(model="test")
    assert config.temperature == 0.7
    assert config.max_tokens == 4096
    assert config.thinking is False


def test_token_usage_model():
    usage = TokenUsage(input_tokens=100, output_tokens=50)
    assert usage.input_tokens == 100
    assert usage.output_tokens == 50
    assert usage.cache_read_tokens is None


def test_model_response_serializable():
    resp = ModelResponse(
        content=[TextBlock(text="hello")],
        stop_reason=StopReason.END_TURN,
        usage=TokenUsage(input_tokens=10, output_tokens=5),
    )
    data = resp.model_dump()
    assert data["stop_reason"] == "end_turn"
    assert data["usage"]["input_tokens"] == 10


# -- ModelCapabilities ---------------------------------------------------------

def test_capability_catalog_has_entries():
    assert len(CAPABILITY_CATALOG) >= 6
    assert "anthropic/claude-opus-4-6" in CAPABILITY_CATALOG
    assert "openai/gpt-4o" in CAPABILITY_CATALOG


def test_get_capabilities_found():
    cap = get_capabilities("anthropic/claude-sonnet-4-6")
    assert cap is not None
    assert cap.supports_tools is True
    assert cap.supports_streaming is True


def test_get_capabilities_unknown():
    assert get_capabilities("unknown/model") is None


def test_capability_fields():
    cap = CAPABILITY_CATALOG["anthropic/claude-haiku-4-5"]
    assert cap.speed_tier == "fast"
    assert cap.supports_thinking is False
    assert cap.context_window == 200_000


# -- ModelRegistry -------------------------------------------------------------


class _MockSelector:
    """Ad-hoc ModelSelector for testing."""

    def select(self, task_type: str, override: str | None = None) -> str:
        if override:
            return override
        return "anthropic/claude-haiku-4-5"


@pytest.fixture
def registry():
    selector = _MockSelector()
    reg = ModelRegistry(selector)
    reg.register("anthropic/claude-haiku-4-5", MagicMock())
    reg.register("openai/gpt-4o", MagicMock())
    return reg


def test_registry_list(registry):
    names = registry.list()
    assert "anthropic/claude-haiku-4-5" in names
    assert "openai/gpt-4o" in names


def test_registry_get(registry):
    provider = registry.get("anthropic/claude-haiku-4-5")
    assert provider is not None


def test_registry_get_unknown_raises(registry):
    with pytest.raises(KeyError, match="unknown model"):
        registry.get("nonexistent")


def test_registry_alias(registry):
    registry.alias("haiku", "anthropic/claude-haiku-4-5")
    provider = registry.get("haiku")
    assert provider is registry.get("anthropic/claude-haiku-4-5")


def test_registry_alias_unknown_target_raises(registry):
    with pytest.raises(KeyError):
        registry.alias("bad", "nonexistent")


def test_registry_select_no_override(registry):
    result = registry.select("main")
    assert result == "anthropic/claude-haiku-4-5"


def test_registry_select_with_override(registry):
    result = registry.select("main", override="openai/gpt-4o")
    assert result == "openai/gpt-4o"


def test_registry_build_config(registry):
    config = registry.build_config("openai/gpt-4o", temperature=0.0)
    assert config.model == "openai/gpt-4o"
    assert config.temperature == 0.0
    assert config.max_tokens == 4096


# -- AnthropicProvider: response parsing ---------------------------------------


def test_anthropic_parse_text_content():
    provider = AnthropicProvider()
    raw = [type("Block", (), {"type": "text", "text": "hello world"})()]
    result = provider._parse_content(raw)
    assert len(result) == 1
    assert isinstance(result[0], TextBlock)
    assert result[0].text == "hello world"


def test_anthropic_parse_tool_use():
    provider = AnthropicProvider()
    # Use a simple object so attributes retain their string values.
    raw = [type("Block", (), {"type": "tool_use", "id": "call_1", "name": "read", "input": {"path": "/x"}})()]
    result = provider._parse_content(raw)
    assert len(result) == 1
    assert isinstance(result[0], ToolUseBlock)
    assert result[0].name == "read"


def test_anthropic_map_stop_reason():
    provider = AnthropicProvider()
    assert provider._map_stop_reason("end_turn") == StopReason.END_TURN
    assert provider._map_stop_reason("max_tokens") == StopReason.MAX_TOKENS
    assert provider._map_stop_reason("tool_use") == StopReason.TOOL_USE
    assert provider._map_stop_reason("stop_sequence") == StopReason.STOP_SEQUENCE
    assert provider._map_stop_reason(None) == StopReason.END_TURN


def test_anthropic_split_system():
    provider = AnthropicProvider()
    messages = [
        Message(role=Role.SYSTEM, content=[TextBlock(text="you are helpful")]),
        Message(role=Role.USER, content=[TextBlock(text="hello")]),
    ]
    system, api_msgs = provider._split_system(messages)
    assert system is not None
    assert len(system) == 1
    assert system[0]["text"] == "you are helpful"
    assert len(api_msgs) == 1
    assert api_msgs[0]["role"] == "user"


def test_anthropic_split_system_no_system():
    provider = AnthropicProvider()
    messages = [
        Message(role=Role.USER, content=[TextBlock(text="hello")]),
    ]
    system, api_msgs = provider._split_system(messages)
    assert system is None
    assert len(api_msgs) == 1


# -- OpenAIProvider: response parsing ------------------------------------------


def test_openai_map_finish_reason():
    provider = OpenAIProvider()
    assert provider._map_finish_reason("stop") == StopReason.END_TURN
    assert provider._map_finish_reason("length") == StopReason.MAX_TOKENS
    assert provider._map_finish_reason("tool_calls") == StopReason.TOOL_USE
    assert provider._map_finish_reason(None) == StopReason.END_TURN
