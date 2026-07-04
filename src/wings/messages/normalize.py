"""Convert between internal Message types and provider-specific formats.

Each provider speaks a different wire format for tool calls, tool results,
and content blocks.  The normalizer maps all of them to the single internal
:class:`Message` representation so the agent loop never deals with provider
quirks.
"""

from __future__ import annotations

import json
from typing import Any

from wings.messages.types import (
    Message,
    MessageContent,
    Role,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
)


class MessageNormalizer:
    """Dispatch provider-specific conversion through a single interface.

    QueryEngine and other consumers depend on this class rather than
    on individual from_*/to_* functions, making it easy to add new
    providers without touching callers.
    """

    # Per-provider converter registries.  Keyed by provider name string
    # (e.g. "anthropic", "openai").
    _from_provider: dict[str, Any] = {}
    _to_provider: dict[str, Any] = {}
    _to_provider_messages: dict[str, Any] = {}

    def __init_subclass__(cls, **kwargs: Any) -> None:
        # No subclassing needed — registries are populated explicitly below.
        pass

    def to_internal(
        self, provider: str, raw_messages: list[dict[str, Any]]
    ) -> list[Message]:
        """Convert a list of provider-native message dicts to internal Messages."""
        converter = self._from_provider.get(provider)
        if converter is None:
            raise ValueError(f"unsupported provider: {provider!r}")
        return [converter(raw) for raw in raw_messages]

    def to_provider(
        self, provider: str, messages: list[Message]
    ) -> list[dict[str, Any]]:
        """Convert internal Messages to a flat list of provider-native dicts."""
        multi_converter = self._to_provider_messages.get(provider)
        if multi_converter is not None:
            return multi_converter(messages)
        converter = self._to_provider.get(provider)
        if converter is None:
            raise ValueError(f"unsupported provider: {provider!r}")
        return [converter(msg) for msg in messages]

    # Called at module load time to wire up converters.
    @classmethod
    def _register(
        cls,
        provider: str,
        from_fn: Any,
        to_fn: Any,
        to_messages_fn: Any | None = None,
    ) -> None:
        cls._from_provider[provider] = from_fn
        cls._to_provider[provider] = to_fn
        if to_messages_fn is not None:
            cls._to_provider_messages[provider] = to_messages_fn


# Default singleton — all callers get the same instance.
normalizer = MessageNormalizer()


# -- Anthropic ----------------------------------------------------------------

def from_anthropic(raw: dict[str, Any]) -> Message:
    """Convert a single Anthropic API message dict to internal format.

    Anthropic shape::

        {"role": "user", "content": [{"type": "text", "text": "..."}]}
        {"role": "assistant", "content": [
            {"type": "tool_use", "id": "...", "name": "...", "input": {...}}
        ]}
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "...", "content": "..."}
        ]}
    """
    role = Role(raw["role"])
    raw_content = raw.get("content", [])

    if isinstance(raw_content, str):
        raw_content = [{"type": "text", "text": raw_content}]

    content: list[MessageContent] = []
    for block in raw_content:
        block_type = block.get("type", "text")
        if block_type == "text":
            content.append(TextBlock(text=block["text"]))
        elif block_type == "tool_use":
            content.append(ToolUseBlock(
                id=block["id"],
                name=block["name"],
                input=block.get("input", {}),
            ))
        elif block_type == "tool_result":
            result_content = block.get("content", "")
            is_error = block.get("is_error", False)
            if isinstance(result_content, list):
                # Flatten: take text from the first text block
                result_text = ""
                for b in result_content:
                    if isinstance(b, dict) and b.get("type") == "text":
                        result_text += b["text"]
            else:
                result_text = str(result_content)
            content.append(ToolResultBlock(
                tool_use_id=block["tool_use_id"],
                content=result_text,
                is_error=is_error,
            ))

    return Message(role=role, content=content)


def to_anthropic(message: Message) -> dict[str, Any]:
    """Convert an internal :class:`Message` to Anthropic API format."""
    blocks: list[dict[str, Any]] = []
    for block in message.content:
        if isinstance(block, TextBlock):
            blocks.append({"type": "text", "text": block.text})
        elif isinstance(block, ToolUseBlock):
            blocks.append({
                "type": "tool_use",
                "id": block.id,
                "name": block.name,
                "input": block.input,
            })
        elif isinstance(block, ToolResultBlock):
            blocks.append({
                "type": "tool_result",
                "tool_use_id": block.tool_use_id,
                "content": block.content,
                "is_error": block.is_error,
            })

    return {"role": str(message.role.value), "content": blocks}


# -- OpenAI -------------------------------------------------------------------

def from_openai(raw: dict[str, Any]) -> Message:
    """Convert a single OpenAI API message dict to internal format.

    OpenAI shape::

        {"role": "user", "content": "hello"}
        {"role": "assistant", "content": "reply",
         "tool_calls": [{"id": "...", "function": {"name": "...", "arguments": "..."}}]}
        {"role": "tool", "tool_call_id": "...", "content": "result"}
    """
    raw_role = raw["role"]
    if raw_role == "tool":
        role = Role.USER  # tool results become user messages internally
    else:
        role = Role(raw_role)

    content: list[MessageContent] = []
    raw_content = raw.get("content")

    # Tool results — role="tool" messages carry tool output only
    if raw_role == "tool":
        content.append(ToolResultBlock(
            tool_use_id=raw["tool_call_id"],
            content=str(raw_content or ""),
        ))
        return Message(role=role, content=content)

    # OpenAI text content: string, or list of content parts
    if raw_content is not None:
        if isinstance(raw_content, str):
            if raw_content.strip():
                content.append(TextBlock(text=raw_content))
        elif isinstance(raw_content, list):
            for part in raw_content:
                if isinstance(part, dict) and part.get("type") == "text":
                    content.append(TextBlock(text=part["text"]))

    # Tool calls
    tool_calls = raw.get("tool_calls", [])
    for tc in tool_calls:
        fn = tc.get("function", {})
        args_str = fn.get("arguments", "{}")
        try:
            args = json.loads(args_str) if isinstance(args_str, str) else args_str
        except json.JSONDecodeError:
            args = {}
        content.append(ToolUseBlock(
            id=tc["id"],
            name=fn.get("name", ""),
            input=args if isinstance(args, dict) else {},
        ))

    return Message(role=role, content=content)


def to_openai(message: Message) -> dict[str, Any]:
    """Convert an internal :class:`Message` to OpenAI API format.

    Returns a tuple when the message contains both text and tool calls,
    because OpenAI represents tool calls alongside assistant content.
    For tool results, returns ``{"role": "tool", ...}`` entries.
    """
    tool_calls: list[dict[str, Any]] = []
    tool_results: list[dict[str, Any]] = []
    text_parts: list[str] = []

    for block in message.content:
        if isinstance(block, TextBlock):
            text_parts.append(block.text)
        elif isinstance(block, ToolUseBlock):
            tool_calls.append({
                "id": block.id,
                "type": "function",
                "function": {
                    "name": block.name,
                    "arguments": json.dumps(block.input, ensure_ascii=False),
                },
            })
        elif isinstance(block, ToolResultBlock):
            tool_results.append({
                "role": "tool",
                "tool_call_id": block.tool_use_id,
                "content": block.content,
            })

    # Tool results are returned as separate message dicts (list)
    if tool_results:
        # This is a multi-message situation — caller must handle
        # We return the role="tool" message here; the caller
        # is responsible for flattening when building the full list.
        # For single messages, text + tool_calls OR tool result, never both.
        pass

    # Build result
    result: dict[str, Any]

    if message.role == Role.USER and tool_results:
        # tool result message
        # If multiple results, return first; normalization layer
        # creates one Message per result
        return tool_results[0]

    if tool_calls:
        result = {
            "role": "assistant",
            "content": "\n".join(text_parts) if text_parts else None,
            "tool_calls": tool_calls,
        }
        if result["content"] is None:
            del result["content"]
    else:
        result = {
            "role": str(message.role.value),
            "content": "\n".join(text_parts) if text_parts else "",
        }

    return result


def to_openai_messages(messages: list[Message]) -> list[dict[str, Any]]:
    """Convert a sequence of internal :class:`Message` objects to a flat
    list of OpenAI API message dicts.

    Handles the case where a single internal message with multiple tool_use
    blocks needs to produce one assistant message with multiple
    ``tool_calls`` entries, and each tool_result produces its own
    ``role="tool"`` message.
    """
    result: list[dict[str, Any]] = []
    for msg in messages:
        tool_results: list[dict[str, Any]] = []
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []

        for block in msg.content:
            if isinstance(block, TextBlock):
                text_parts.append(block.text)
            elif isinstance(block, ToolUseBlock):
                tool_calls.append({
                    "id": block.id,
                    "type": "function",
                    "function": {
                        "name": block.name,
                        "arguments": json.dumps(block.input, ensure_ascii=False),
                    },
                })
            elif isinstance(block, ToolResultBlock):
                tool_results.append({
                    "role": "tool",
                    "tool_call_id": block.tool_use_id,
                    "content": block.content,
                })

        if tool_results:
            result.extend(tool_results)
        if text_parts or tool_calls:
            r: dict[str, Any] = {"role": str(msg.role.value)}
            if tool_calls:
                r["tool_calls"] = tool_calls
                if text_parts:
                    r["content"] = "\n".join(text_parts)
            else:
                r["content"] = "\n".join(text_parts) if text_parts else ""
            result.append(r)

    return result

# -- Provider registration ----------------------------------------------------

MessageNormalizer._register("anthropic", from_anthropic, to_anthropic)
MessageNormalizer._register("openai", from_openai, to_openai, to_messages_fn=to_openai_messages)

