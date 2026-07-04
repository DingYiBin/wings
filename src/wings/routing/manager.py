"""API pool manager — global pool + per-task-type score masks.

Each agent, skill, etc. manages a score mask over the global pool.
An API can be disabled (-inf), promoted (+delta), or demoted (-delta).
Selection uses softmax(effective_scores).
"""

import threading
from copy import deepcopy

from wings.routing.types import PoolConfig, PoolEntry, ScoreMask
from wings.routing.selector import NEG_INF, NoAPIAvailable, softmax_select


class APIPoolManager:
    """Manages a global pool of APIs with per-task-type score masks.

    Implements ModelSelector Protocol.
    Thread-safe: all writes hold an RLock.
    """

    def __init__(self, config: PoolConfig | None = None):
        self._lock = threading.RLock()
        self._entries: dict[str, PoolEntry] = {}  # api_id → PoolEntry (global)
        self._masks: dict[str, dict[str, float]] = {}  # task_type → {api_id → delta}
        if config is not None:
            self.replace_config(config)

    # -- Selection (implements ModelSelector) --

    def select(self, task_type: str, override: str | None = None) -> str:
        """Select an API via softmax over effective scores. override bypasses."""
        if override:
            return override
        with self._lock:
            mask = self._resolve_mask(task_type)
            entries = list(self._entries.values())
            if not entries:
                raise NoAPIAvailable("no APIs in global pool")
            return softmax_select(entries, mask)

    # -- Registration --

    def register_api(
        self,
        api_id: str,
        *,
        score: float = 0.0,
    ) -> None:
        """Add an API to the global pool. Does NOT touch masks (effectively
        available to all task types at base score)."""
        with self._lock:
            self._entries[api_id] = PoolEntry(api_id=api_id, score=score)

    def unregister_api(self, api_id: str) -> None:
        """Remove an API from the global pool and all masks."""
        with self._lock:
            self._entries.pop(api_id, None)
            for mask in self._masks.values():
                mask.pop(api_id, None)

    # -- Score adjustments (per task type) --

    def _ensure_mask(self, task_type: str) -> dict[str, float]:
        if task_type not in self._masks:
            self._masks[task_type] = {}
        return self._masks[task_type]

    def adjust_score(self, task_type: str, api_id: str, score: float) -> None:
        """Set the score adjustment for an API in a task type's mask."""
        with self._lock:
            self._ensure_mask(task_type)[api_id] = score

    def adjust_base_score(self, api_id: str, score: float) -> None:
        """Set the base score of an API (affects all task types)."""
        with self._lock:
            if api_id not in self._entries:
                raise KeyError(api_id)
            self._entries[api_id].score = score

    def upvote(self, task_type: str, api_id: str, delta: float = 0.5) -> None:
        """Increase an API's score adjustment for a task type."""
        with self._lock:
            mask = self._ensure_mask(task_type)
            current = mask.get(api_id, 0.0)
            mask[api_id] = current + delta

    def downvote(self, task_type: str, api_id: str, delta: float = 0.5) -> None:
        """Decrease an API's score adjustment for a task type."""
        with self._lock:
            mask = self._ensure_mask(task_type)
            current = mask.get(api_id, 0.0)
            mask[api_id] = current - delta

    def disable(self, task_type: str, api_id: str) -> None:
        """Disable an API for a task type (mask delta = -inf)."""
        with self._lock:
            self._ensure_mask(task_type)[api_id] = NEG_INF

    def enable(self, task_type: str, api_id: str) -> None:
        """Re-enable a previously disabled API (remove mask entry)."""
        with self._lock:
            if task_type in self._masks:
                self._masks[task_type].pop(api_id, None)

    # -- Pool fork --

    def fork_mask(self, task_type: str, from_task: str) -> None:
        """Copy another task type's mask as a starting point."""
        with self._lock:
            source = self._masks.get(from_task, {})
            self._masks[task_type] = deepcopy(source)

    # -- Query --

    def list_apis(self) -> list[str]:
        """List all APIs in the global pool."""
        with self._lock:
            return sorted(self._entries.keys())

    def get_mask(self, task_type: str) -> dict[str, float]:
        """Get the effective mask for a task type (resolved via inheritance)."""
        with self._lock:
            return dict(self._resolve_mask(task_type))

    def list_task_types(self) -> list[str]:
        """List task types that have explicit masks."""
        with self._lock:
            return sorted(self._masks.keys())

    # -- Persistence --

    def to_config(self) -> PoolConfig:
        """Export global pool + masks to PoolConfig."""
        with self._lock:
            return PoolConfig(
                version=2,
                apis=[deepcopy(e) for e in self._entries.values()],
                masks={
                    tt: dict(m)
                    for tt, m in self._masks.items()
                    if m  # only non-empty masks
                },
            )

    def replace_config(self, config: PoolConfig) -> None:
        """Replace state from a loaded PoolConfig."""
        with self._lock:
            self._entries.clear()
            self._masks.clear()
            for entry in config.apis:
                self._entries[entry.api_id] = deepcopy(entry)
            for task_type, adjustments in config.masks.items():
                self._masks[task_type] = dict(adjustments)

    # -- Internal --

    def _resolve_mask(self, task_type: str) -> dict[str, float]:
        """Resolve mask via inheritance chain. Falls back to parent masks."""
        from wings.routing.tasks import resolve_parent

        # Walk up the chain collecting non-empty masks
        current = task_type
        resolved: dict[str, float] = {}
        while current is not None:
            mask = self._masks.get(current, {})
            for api_id, delta in mask.items():
                if api_id not in resolved:
                    resolved[api_id] = delta
            current = resolve_parent(current)
        return resolved
