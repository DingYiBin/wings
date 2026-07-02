"""Tests for the messages module."""

from wings.messages import (
    Message,
    Role,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
)


class TestMessageRoundtrip:
    def test_user_text_message(self) -> None:
        msg = Message(
            role=Role.USER,
            content=[TextBlock(text="hello")],
        )
        assert msg.role == Role.USER
        assert len(msg.content) == 1
        assert msg.content[0].text == "hello"

    def test_tool_use_and_result(self) -> None:
        msg = Message(
            role=Role.USER,
            content=[
                ToolUseBlock(id="1", name="read", input={"path": "/tmp/x"}),
                ToolResultBlock(tool_use_id="1", content="file contents"),
            ],
        )
        assert len(msg.content) == 2
        tool_use = msg.content[0]
        assert isinstance(tool_use, ToolUseBlock)
        assert tool_use.name == "read"
        assert tool_use.input == {"path": "/tmp/x"}

        tool_result = msg.content[1]
        assert isinstance(tool_result, ToolResultBlock)
        assert tool_result.tool_use_id == "1"

    def test_tool_result_error_flag(self) -> None:
        result = ToolResultBlock(
            tool_use_id="2",
            content="Permission denied",
            is_error=True,
        )
        assert result.is_error

    def test_message_serialization(self) -> None:
        msg = Message(
            role=Role.SYSTEM,
            content=[TextBlock(text="system prompt")],
        )
        data = msg.model_dump()
        assert data["role"] == "system"
        assert data["content"][0]["type"] == "text"

    def test_tool_use_in_serialized_form(self) -> None:
        """Verify tool_use blocks round-trip through JSON."""
        msg = Message(
            role=Role.ASSISTANT,
            content=[ToolUseBlock(id="call_1", name="grep", input={"pattern": "foo"})],
        )
        json_str = msg.model_dump_json()
        parsed = Message.model_validate_json(json_str)
        assert parsed.content[0].name == "grep"  # type: ignore[union-attr]
