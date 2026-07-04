"""OpenAI API adapter using the official ``openai`` SDK."""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

import openai

from wings.messages.normalize import to_openai_messages
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


class OpenAIProvider:
    """Model provider for the OpenAI API (GPT, o-series models)."""

    provider_name = "openai"

    def _client(self, config: ModelConfig) -> openai.AsyncOpenAI:
        kwargs: dict[str, Any] = {"api_key": config.api_key}
        if config.base_url:
            kwargs["base_url"] = config.base_url
        return openai.AsyncOpenAI(**kwargs)

    async def chat(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None,
        config: ModelConfig,
    ) -> ModelResponse:
        """Non-streaming chat call."""
        client = self._client(config)
        api_messages = to_openai_messages(messages)

        kwargs = self._build_request(config, api_messages, tools, stream=False)
        response = await client.chat.completions.create(**kwargs)

        choice = response.choices[0]
        content = self._parse_choice(choice)
        return ModelResponse(
            content=content,
            stop_reason=self._map_finish_reason(choice.finish_reason),
            usage=TokenUsage(
                input_tokens=response.usage.prompt_tokens if response.usage else 0,
                output_tokens=response.usage.completion_tokens if response.usage else 0,
            ),
        )

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None,
        config: ModelConfig,
    ) -> AsyncIterator[Any]:  # StreamEvent
        """Streaming chat call. Yields TextDelta, ToolUseDelta, ThinkingDelta."""
        client = self._client(config)
        api_messages = to_openai_messages(messages)

        kwargs = self._build_request(config, api_messages, tools, stream=True)
        stream = await client.chat.completions.create(**kwargs)

        current_tool: dict[str, Any] = {}  # id -> accumulated state

        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta is None:
                continue

            # Text
            if delta.content:
                yield TextDelta(text=delta.content)

            # Tool calls
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in current_tool:
                        current_tool[idx] = {"id": "", "name": "", "args": ""}

                    if tc.id:
                        current_tool[idx]["id"] = tc.id
                        if tc.function and tc.function.name:
                            current_tool[idx]["name"] = tc.function.name
                        yield ToolUseDelta(
                            id=tc.id,
                            name=tc.function.name if tc.function else None,
                        )
                    elif tc.function and tc.function.arguments:
                        current_tool[idx]["args"] += tc.function.arguments
                        yield ToolUseDelta(
                            id=current_tool[idx]["id"],
                            input_delta={"_partial_json": tc.function.arguments},
                        )

            # Finish reason (stop)
            if chunk.choices[0].finish_reason:
                pass  # terminal chunk; loop ends naturally

    # -- helpers --

    def _build_request(
        self,
        config: ModelConfig,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        *,
        stream: bool = False,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": config.model,
            "messages": messages,
            "stream": stream,
        }
        if not config.thinking:
            # o-series models don't support temperature
            kwargs["temperature"] = config.temperature
            if config.top_p is not None:
                kwargs["top_p"] = config.top_p
            kwargs["max_tokens"] = config.max_tokens
        else:
            # o-series use max_completion_tokens
            kwargs["max_completion_tokens"] = config.max_tokens
        if tools:
            kwargs["tools"] = tools
        return kwargs

    def _parse_choice(self, choice: Any) -> list[Any]:  # MessageContent
        """Parse an OpenAI completion choice into internal content blocks."""
        result: list[Any] = []

        if choice.message.content:
            result.append(TextBlock(text=choice.message.content))

        if choice.message.tool_calls:
            for tc in choice.message.tool_calls:
                args_str = tc.function.arguments or "{}"
                try:
                    args = json.loads(args_str)
                except json.JSONDecodeError:
                    args = {}
                result.append(ToolUseBlock(
                    id=tc.id,
                    name=tc.function.name,
                    input=args,
                ))

        return result

    def _map_finish_reason(self, raw: str | None) -> StopReason:
        if raw == "stop":
            return StopReason.END_TURN
        if raw in ("length", "max_tokens"):
            return StopReason.MAX_TOKENS
        if raw == "tool_calls":
            return StopReason.TOOL_USE
        return StopReason.END_TURN
