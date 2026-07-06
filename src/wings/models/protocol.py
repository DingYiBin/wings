"""Model adapter protocol — the interface every API provider implements."""

from __future__ import annotations

from typing import Any, AsyncIterator, Protocol

from pydantic import BaseModel, Field

from wings.messages.types import Message, MessageContent, StopReason, StreamEvent


# -- Config -------------------------------------------------------------------

class ModelConfig(BaseModel):
    """Configuration for a single model API call."""

    model: str
    temperature: float | None = None
    max_tokens: int = 8_000  # claude-code's CAPPED_DEFAULT
    escalated_max_tokens: int = 64_000  # retry cap on max_tokens hit
    top_p: float | None = None
    thinking: bool = True
    thinking_budget: int | None = None  # None = auto: max_tokens - 1
    api_key: str = ""
    base_url: str | None = None


# -- Response -----------------------------------------------------------------

class TokenUsage(BaseModel):
    """Token usage for a single API call."""

    input_tokens: int
    output_tokens: int
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None


class ModelResponse(BaseModel):
    """The result of a non-streaming chat call."""

    content: list[MessageContent] = Field(default_factory=list)
    stop_reason: StopReason
    usage: TokenUsage


# -- Provider Protocol --------------------------------------------------------


class ModelProvider(Protocol):
    """Protocol that every API adapter must implement.

    Each adapter speaks its provider's native protocol and converts to/from
    the internal :class:`Message` format.
    """

    provider_name: str

    async def chat(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None,
        config: ModelConfig,
    ) -> ModelResponse:
        """Send messages and receive a complete response."""
        ...

    async def stream(
        self,
        messages: list[Message],
        tools: list[dict[str, Any]] | None,
        config: ModelConfig,
    ) -> AsyncIterator[StreamEvent]:
        """Send messages and receive streaming events."""
        ...
