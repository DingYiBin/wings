"""Token budget — track context window usage and signal compaction."""

from __future__ import annotations

from wings.messages.types import Message


class TokenBudget:
    """Track remaining context window budget.

    Doesn't do actual tokenization (that requires model-specific
    tokenizers). Instead uses a conservative character-based heuristic
    (~4 chars per token) to estimate. This is sufficient for deciding
    when to compact — the compactor itself will use a real token count
    from the API response.
    """

    # Conservative estimate: 4 characters ≈ 1 token for English text.
    # This slightly overestimates usage, which is safe (compact early).
    CHARS_PER_TOKEN = 4

    def __init__(
        self,
        context_window: int,
        *,
        reserved_for_output: int = 4096,
        system_prompt_tokens: int = 0,
    ):
        self.context_window = context_window
        self.reserved_for_output = reserved_for_output
        self.system_prompt_tokens = system_prompt_tokens

    def remaining(self, messages: list[Message]) -> int:
        """Return estimated remaining tokens after accounting for messages."""
        used = self.system_prompt_tokens
        for msg in messages:
            used += self._estimate_message_tokens(msg)
        return max(0, self.context_window - self.reserved_for_output - used)

    def needs_compact(self, messages: list[Message]) -> bool:
        """Return True if messages consume > 80% of the available budget."""
        available = self.context_window - self.reserved_for_output - self.system_prompt_tokens
        if available <= 0:
            return True
        used = sum(self._estimate_message_tokens(m) for m in messages)
        return used > available * 0.8

    def estimate_tokens(self, text: str) -> int:
        """Estimate token count for a plain text string."""
        return max(1, len(text) // self.CHARS_PER_TOKEN)

    def _estimate_message_tokens(self, msg: Message) -> int:
        """Estimate tokens for a single Message."""
        total = 0
        for block in msg.content:
            # Each content block has a small type overhead
            total += 2
            if hasattr(block, "text"):
                total += len(block.text) // self.CHARS_PER_TOKEN  # type: ignore[union-attr]
            elif hasattr(block, "name"):
                total += len(block.name) // self.CHARS_PER_TOKEN + 4  # type: ignore[union-attr]
            elif hasattr(block, "content"):
                total += len(block.content) // self.CHARS_PER_TOKEN  # type: ignore[union-attr]
        return max(1, total)
