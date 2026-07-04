"""Tests for provider message format conversion."""

import pytest

from wings.messages.normalize import (
    MessageNormalizer,
    from_anthropic,
    from_openai,
    normalizer,
    to_anthropic,
    to_openai,
    to_openai_messages,
)
from wings.messages.types import (
    Message,
    Role,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
)


# -- MessageNormalizer ---------------------------------------------------------

class TestMessageNormalizer:
    def test_to_internal_anthropic(self) -> None:
        raw = [{"role": "user", "content": [{"type": "text", "text": "hello"}]}]
        msgs = normalizer.to_internal("anthropic", raw)
        assert len(msgs) == 1
        assert msgs[0].role == Role.USER

    def test_to_internal_openai(self) -> None:
        raw = [{"role": "user", "content": "hello"}]
        msgs = normalizer.to_internal("openai", raw)
        assert len(msgs) == 1
        assert msgs[0].role == Role.USER

    def test_to_provider_anthropic(self) -> None:
        msg = Message(role=Role.USER, content=[TextBlock(text="hello")])
        raw = normalizer.to_provider("anthropic", [msg])
        assert raw[0]["role"] == "user"

    def test_to_provider_openai(self) -> None:
        msg = Message(role=Role.USER, content=[TextBlock(text="hello")])
        raw = normalizer.to_provider("openai", [msg])
        assert raw[0]["role"] == "user"

    def test_unsupported_provider_raises(self) -> None:
        with pytest.raises(ValueError, match="unsupported provider"):
            normalizer.to_internal("unsupported", [])

    def test_normalizer_is_singleton(self) -> None:
        """Default normalizer instance is available at module level."""
        assert isinstance(normalizer, MessageNormalizer)


# -- Anthropic ----------------------------------------------------------------

class TestAnthropicRoundtrip:
    def test_user_text(self) -> None:
        raw = {"role": "user", "content": [{"type": "text", "text": "hello"}]}
        msg = from_anthropic(raw)
        assert msg.role == Role.USER
        assert len(msg.content) == 1
        assert isinstance(msg.content[0], TextBlock)
        assert msg.content[0].text == "hello"

    def test_assistant_tool_use(self) -> None:
        raw = {
            "role": "assistant",
            "content": [
                {"type": "tool_use", "id": "call_1", "name": "read", "input": {"path": "/tmp/x"}},
            ],
        }
        msg = from_anthropic(raw)
        assert msg.role == Role.ASSISTANT
        block = msg.content[0]
        assert isinstance(block, ToolUseBlock)
        assert block.name == "read"
        assert block.input == {"path": "/tmp/x"}

    def test_user_tool_result(self) -> None:
        raw = {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "call_1", "content": "some output"},
            ],
        }
        msg = from_anthropic(raw)
        block = msg.content[0]
        assert isinstance(block, ToolResultBlock)
        assert block.tool_use_id == "call_1"
        assert block.content == "some output"

    def test_text_content_as_string(self) -> None:
        """Anthropic sometimes sends content as a plain string."""
        raw = {"role": "assistant", "content": "just a string"}
        msg = from_anthropic(raw)
        assert isinstance(msg.content[0], TextBlock)
        assert msg.content[0].text == "just a string"

    def test_to_anthropic_text(self) -> None:
        msg = Message(role=Role.USER, content=[TextBlock(text="hello")])
        raw = to_anthropic(msg)
        assert raw["role"] == "user"
        assert raw["content"] == [{"type": "text", "text": "hello"}]

    def test_to_anthropic_tool_use(self) -> None:
        msg = Message(
            role=Role.ASSISTANT,
            content=[ToolUseBlock(id="1", name="read", input={"path": "/x"})],
        )
        raw = to_anthropic(msg)
        block = raw["content"][0]
        assert block["type"] == "tool_use"
        assert block["name"] == "read"

    def test_to_anthropic_tool_result(self) -> None:
        msg = Message(
            role=Role.USER,
            content=[ToolResultBlock(tool_use_id="1", content="done", is_error=True)],
        )
        raw = to_anthropic(msg)
        block = raw["content"][0]
        assert block["type"] == "tool_result"
        assert block["is_error"] is True

    def test_from_anthropic_flattens_list_result(self) -> None:
        """Tool results with content as a list of text blocks are flattened."""
        raw = {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "2",
                    "content": [
                        {"type": "text", "text": "line one "},
                        {"type": "text", "text": "line two"},
                    ],
                },
            ],
        }
        msg = from_anthropic(raw)
        block = msg.content[0]
        assert isinstance(block, ToolResultBlock)
        assert block.content == "line one line two"


# -- OpenAI -------------------------------------------------------------------

class TestOpenAIRoundtrip:
    def test_user_text_string(self) -> None:
        raw = {"role": "user", "content": "hello"}
        msg = from_openai(raw)
        assert msg.role == Role.USER
        assert msg.content[0].text == "hello"

    def test_assistant_with_tool_calls(self) -> None:
        raw = {
            "role": "assistant",
            "content": "let me check",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read", "arguments": '{"path": "/x"}'},
                },
            ],
        }
        msg = from_openai(raw)
        assert msg.role == Role.ASSISTANT
        texts = [b for b in msg.content if isinstance(b, TextBlock)]
        tools = [b for b in msg.content if isinstance(b, ToolUseBlock)]
        assert texts[0].text == "let me check"
        assert tools[0].name == "read"
        assert tools[0].input == {"path": "/x"}

    def test_tool_result(self) -> None:
        raw = {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": "file content",
        }
        msg = from_openai(raw)
        block = msg.content[0]
        assert isinstance(block, ToolResultBlock)
        assert block.tool_use_id == "call_1"
        assert block.content == "file content"

    def test_tool_calls_with_invalid_json(self) -> None:
        raw = {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "f", "arguments": "not json"},
                },
            ],
        }
        msg = from_openai(raw)
        tool = [b for b in msg.content if isinstance(b, ToolUseBlock)][0]
        assert tool.input == {}

    def test_to_openai_text(self) -> None:
        msg = Message(role=Role.USER, content=[TextBlock(text="hi")])
        raw = to_openai(msg)
        assert raw == {"role": "user", "content": "hi"}

    def test_to_openai_tool_result(self) -> None:
        msg = Message(
            role=Role.USER,
            content=[ToolResultBlock(tool_use_id="c1", content="out")],
        )
        raw = to_openai(msg)
        assert raw["role"] == "tool"
        assert raw["tool_call_id"] == "c1"

    def test_to_openai_messages_flat(self) -> None:
        """Verify that tool_results produce separate role=tool dicts."""
        msgs = [
            Message(role=Role.USER, content=[TextBlock(text="read /tmp/x")]),
            Message(
                role=Role.ASSISTANT,
                content=[ToolUseBlock(id="1", name="read", input={"path": "/tmp/x"})],
            ),
            Message(
                role=Role.USER,
                content=[ToolResultBlock(tool_use_id="1", content="hello world")],
            ),
        ]
        openai_msgs = to_openai_messages(msgs)
        assert openai_msgs[0] == {"role": "user", "content": "read /tmp/x"}
        assert openai_msgs[1]["role"] == "assistant"
        assert openai_msgs[1]["tool_calls"][0]["function"]["name"] == "read"
        assert openai_msgs[2] == {
            "role": "tool",
            "tool_call_id": "1",
            "content": "hello world",
        }
