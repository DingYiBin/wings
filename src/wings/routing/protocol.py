"""Protocol that consumers depend on — not the concrete pool manager."""

from typing import Protocol


class ModelSelector(Protocol):
    """Interface for selecting a model API.

    AgentLoop, QueryEngine, and other consumers depend ONLY on this protocol,
    not on APIPoolManager. This makes the routing implementation replaceable
    without touching any callers.
    """

    def select(self, task_type: str, override: str | None = None) -> str:
        """Return the selected api_id.

        Args:
            task_type: Task type ("main", "subagent/explore", "skill/commit", ...)
            override: Session-level model lock (set by /model command),
                      bypasses pool selection entirely.

        Returns:
            api_id string, e.g. "anthropic/claude-opus-4-6"

        Raises:
            NoAPIAvailable: No API is available in the resolved pool.
        """
        ...
