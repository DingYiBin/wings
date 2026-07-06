"""Anthropic API adapter using the official ``anthropic`` SDK."""

from __future__ import annotations

from typing import Any, AsyncIterator

import anthropic

from wings.messages.normalize import to_anthropic
from wings.messages.types import (
    Message,
    Role,
    StopReason,
    TextBlock,
    TextDelta,
    ThinkingDelta,
    ToolResultBlock,
    ToolUseBlock,
    ToolUseDelta,
)
from wings.models.protocol import (
    ModelConfig,
    ModelProvider,
    ModelResponse,
    TokenUsage,
)


class AnthropicProvider:
    """Model provider for Anthropic's API (Claude models)."""

    provider_name = "anthropic"

    def _client(self, config: ModelConfig) -> anthropic.Anthropic:
        kwargs: dict[str, Any] = {"api_key": config.api_key}
        if config.base_url:
            kwargs["base_url"] = config.base_url
        return anthropic.Anthropic(**kwargs)

    async def chat(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None,
        config: ModelConfig,
    ) -> ModelResponse:
        """Non-streaming chat call."""
        client = self._client(config)
        system, api_messages = self._split_system(messages)

        kwargs = self._build_request(config, api_messages, tools, system=system, stream=False)
        response = client.messages.create(**kwargs)

        content = self._parse_content(response.content)
        return ModelResponse(
            content=content,
            stop_reason=self._map_stop_reason(response.stop_reason),
            usage=TokenUsage(
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                cache_read_tokens=getattr(response.usage, "cache_read_input_tokens", None),
                cache_write_tokens=getattr(response.usage, "cache_creation_input_tokens", None),
            ),
        )

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None,
        config: ModelConfig,
    ) -> AsyncIterator[Any]:  # StreamEvent | ToolUseBlock | TextBlock
        """Streaming chat call with max_tokens escalation.

        If the model hits max_tokens, retries once with escalated_max_tokens
        (claude-code's CAPPED_DEFAULT → ESCALATED_MAX_TOKENS pattern).
        """
        client = self._client(config)
        system, api_messages = self._split_system(messages)

        kwargs = self._build_request(config, api_messages, tools, system=system, stream=False)
        kwargs.pop("stream", None)

        # First attempt — buffer all events so we can decide whether to escalate
        with client.messages.stream(**kwargs) as stream:
            events: list[Any] = []
            for event in stream:
                events.append(event)

            final = stream.get_final_message()
            stop_reason = self._map_stop_reason(final.stop_reason)

        # Escalate if we hit max_tokens and haven't already
        if (
            stop_reason == StopReason.MAX_TOKENS
            and kwargs["max_tokens"] < config.escalated_max_tokens
        ):
            kwargs["max_tokens"] = config.escalated_max_tokens
            # Recalculate thinking budget for escalated max_tokens
            if "thinking" in kwargs and "budget_tokens" in kwargs["thinking"]:
                escalated_budget = config.thinking_budget or (config.escalated_max_tokens - 1)
                kwargs["thinking"]["budget_tokens"] = min(
                    escalated_budget, config.escalated_max_tokens - 1,
                )
            with client.messages.stream(**kwargs) as stream2:
                for event in stream2:
                    if event.type == "content_block_delta":
                        dt = event.delta.type
                        if dt == "text_delta":
                            yield TextDelta(text=event.delta.text)
                        elif dt == "thinking_delta":
                            yield ThinkingDelta(text=event.delta.thinking)

                final2 = stream2.get_final_message()
                for block in final2.content:
                    bt = getattr(block, "type", None)
                    if bt == "text":
                        yield TextBlock(text=block.text)
                    elif bt == "tool_use":
                        yield ToolUseBlock(
                            id=block.id,
                            name=block.name,
                            input=block.input if isinstance(block.input, dict) else {},
                        )
            return

        # No escalation needed — replay buffered events
        for event in events:
            if event.type == "content_block_delta":
                dt = event.delta.type
                if dt == "text_delta":
                    yield TextDelta(text=event.delta.text)
                elif dt == "thinking_delta":
                    yield ThinkingDelta(text=event.delta.thinking)

        for block in final.content:
            bt = getattr(block, "type", None)
            if bt == "text":
                yield TextBlock(text=block.text)
            elif bt == "tool_use":
                yield ToolUseBlock(
                    id=block.id,
                    name=block.name,
                    input=block.input if isinstance(block.input, dict) else {},
                )

    # -- helpers --

    def _build_request(
        self,
        config: ModelConfig,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        *,
        system: list[dict[str, Any]] | None = None,
        stream: bool = False,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": config.model,
            "max_tokens": config.max_tokens or 4096,
            "messages": messages,
            "stream": stream,
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = tools
        if config.temperature is not None:
            kwargs["temperature"] = config.temperature
        if config.top_p is not None:
            kwargs["top_p"] = config.top_p
        if config.thinking:
            # Always set budget_tokens. claude-code formula:
            # budget = min(max_tokens - 1, user_budget)
            # API requires max_tokens > budget_tokens.
            max_tk = kwargs["max_tokens"]
            default_budget = max_tk - 1 if max_tk and max_tk > 1 else 7999
            if config.thinking_budget is not None:
                budget = min(config.thinking_budget, default_budget)
            else:
                budget = default_budget
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
        return kwargs

    def _split_system(
        self, messages: list[Message]
    ) -> tuple[list[dict[str, Any]] | None, list[dict[str, Any]]]:
        """Extract system messages for Anthropic's top-level system param."""
        system_blocks: list[dict[str, Any]] = []
        api_messages: list[dict[str, Any]] = []
        for msg in messages:
            if msg.role == Role.SYSTEM:
                for block in msg.content:
                    if isinstance(block, TextBlock):
                        system_blocks.append({"type": "text", "text": block.text})
            else:
                api_messages.append(to_anthropic(msg))
        return system_blocks if system_blocks else None, api_messages

    def _parse_content(self, raw_content: list[Any]) -> list[Any]:  # MessageContent
        """Parse Anthropic response content blocks into internal types."""
        result: list[Any] = []
        for block in raw_content:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                result.append(TextBlock(text=block.text))
            elif block_type == "tool_use":
                result.append(ToolUseBlock(
                    id=block.id,
                    name=block.name,
                    input=block.input if isinstance(block.input, dict) else {},
                ))
        return result

    def _map_stop_reason(self, raw: str | None) -> StopReason:
        if raw == "end_turn":
            return StopReason.END_TURN
        if raw == "max_tokens":
            return StopReason.MAX_TOKENS
        if raw == "tool_use":
            return StopReason.TOOL_USE
        if raw == "stop_sequence":
            return StopReason.STOP_SEQUENCE
        return StopReason.END_TURN
