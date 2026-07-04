"""Query engine — unified LLM API entry point.

Looks up the provider via ModelRegistry and calls it. Handles retry
for transient errors. Does NOT own message format conversion (that's
the provider's job) or model selection (that's ModelSelector).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator

from wings.messages.types import Message, StreamEvent
from wings.models.protocol import ModelConfig, ModelResponse
from wings.models.registry import ModelRegistry

logger = logging.getLogger(__name__)

# Transient errors worth retrying
_RETRIABLE_STATUSES: tuple[int, ...] = (429, 500, 502, 503, 504)


class QueryError(Exception):
    """A non-retriable error from a model provider."""


class QueryEngine:
    """Unified entry point for LLM API calls.

    Messages are passed through to the provider as-is — each provider
    converts to its native format internally.  The engine is only
    responsible for error handling and retry logic.
    """

    def __init__(
        self,
        registry: ModelRegistry,
        *,
        max_retries: int = 3,
        retry_base_delay: float = 1.0,
    ):
        self._registry = registry
        self._max_retries = max_retries
        self._retry_base_delay = retry_base_delay

    async def chat(
        self,
        messages: list[Message],
        model: str,
        tools: list[dict[str, Any]] | None,
        config: ModelConfig,
    ) -> ModelResponse:
        """Non-streaming query. Returns a complete ModelResponse."""
        provider = self._registry.get(model)

        last_error: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                return await provider.chat(messages, tools, config)
            except Exception as e:
                last_error = e
                if not self._is_retriable(e) or attempt == self._max_retries:
                    break
                delay = self._retry_base_delay * (2 ** attempt)
                logger.warning(
                    "retry %d/%d for %s after %.1fs: %s",
                    attempt + 1, self._max_retries, model, delay, e,
                )
                await asyncio.sleep(delay)

        raise QueryError(f"chat failed for {model}: {last_error}") from last_error

    async def stream(
        self,
        messages: list[Message],
        model: str,
        tools: list[dict[str, Any]] | None,
        config: ModelConfig,
    ) -> AsyncIterator[StreamEvent]:
        """Streaming query. Yields StreamEvent items."""
        provider = self._registry.get(model)

        last_error: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                async for event in provider.stream(messages, tools, config):
                    yield event
                return  # successful completion
            except Exception as e:
                last_error = e
                if not self._is_retriable(e) or attempt == self._max_retries:
                    break
                delay = self._retry_base_delay * (2 ** attempt)
                logger.warning(
                    "stream retry %d/%d for %s after %.1fs: %s",
                    attempt + 1, self._max_retries, model, delay, e,
                )
                await asyncio.sleep(delay)

        raise QueryError(f"stream failed for {model}: {last_error}") from last_error

    def _is_retriable(self, exc: Exception) -> bool:
        """Check whether an exception suggests a transient error."""
        status = getattr(exc, "status_code", None)
        if status is not None and status in _RETRIABLE_STATUSES:
            return True
        response = getattr(exc, "response", None)
        if response is not None:
            http_status = getattr(response, "status_code", None)
            if http_status is not None and http_status in _RETRIABLE_STATUSES:
                return True
        import httpx
        if isinstance(exc, httpx.HTTPStatusError):
            return exc.response.status_code in _RETRIABLE_STATUSES
        if isinstance(exc, (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError)):
            return True
        return False
