"""API pool manager — stateful, thread-safe, implements ModelSelector Protocol."""

import threading
from copy import deepcopy

from wings.routing.types import PoolConfig, PoolEntry, TaskPool
from wings.routing.selector import weighted_select
from wings.routing.tasks import TASK_HIERARCHY, resolve_parent, resolve_pool


class APIPoolManager:
    """Manages API candidate pools for all task types.

    Implements ModelSelector Protocol.
    Thread-safe: all writes hold a lock, select() holds a lock.
    Singleton — held by ModelRegistry.
    """

    def __init__(
        self,
        config: PoolConfig | None = None,
        *,
        default_pool: TaskPool | None = None,
    ):
        self._lock = threading.RLock()
        self._pools: dict[str, TaskPool] = {}
        self._default_weight: float = 1.0
        self._default_pool = default_pool
        if config is not None:
            self.replace_config(config)
        else:
            self._init_defaults()

    # --- Selection (public API, implements ModelSelector) ---

    def select(self, task_type: str, override: str | None = None) -> str:
        """Select an API from the task's pool via weighted random choice.

        override (session-level /model lock) bypasses the pool entirely.
        """
        if override:
            return override
        with self._lock:
            pool = resolve_pool(
                task_type, self._pools, default_pool=self._default_pool
            )
            return weighted_select(pool.entries)

    # --- Registration ---

    def register_api(
        self,
        api_id: str,
        *,
        add_to: list[str] | None = None,
        exclude_from: list[str] | None = None,
    ) -> None:
        """Register a new API. By default, adds to all known task type pools.

        Args:
            api_id: The API identifier.
            add_to: If set, ONLY add to these task type pools.
            exclude_from: If set, add to all pools EXCEPT these.
                Mutually exclusive with add_to.
        """
        if add_to is not None and exclude_from is not None:
            raise ValueError("add_to and exclude_from are mutually exclusive")

        entry = PoolEntry(api_id=api_id, weight=self._default_weight)

        with self._lock:
            if add_to is not None:
                targets = set(add_to)
            else:
                targets = set(self._list_all_task_types())
                if exclude_from is not None:
                    targets -= set(exclude_from)

            for task_type in targets:
                self._ensure_pool(task_type).entries.append(deepcopy(entry))

    def unregister_api(self, api_id: str) -> None:
        """Remove an API from all pools."""
        with self._lock:
            for pool in self._pools.values():
                pool.entries = [
                    e for e in pool.entries if e.api_id != api_id
                ]

    # --- User adjustments ---

    def _get_entry(self, task_type: str, api_id: str) -> PoolEntry:
        """Find an entry in a pool. Raises KeyError if not found."""
        pool = self._pools.get(task_type)
        if pool is None:
            raise KeyError(f"no pool for task_type '{task_type}'")
        for entry in pool.entries:
            if entry.api_id == api_id:
                return entry
        raise KeyError(f"api_id '{api_id}' not found in pool '{task_type}'")

    def adjust_weight(self, task_type: str, api_id: str, weight: float) -> None:
        """Set an API's weight in a task pool. weight must be >= 0."""
        if weight < 0:
            raise ValueError("weight must be >= 0")
        with self._lock:
            entry = self._get_entry(task_type, api_id)
            entry.weight = weight

    def upvote(self, task_type: str, api_id: str, delta: float = 0.5) -> None:
        """Increase an API's weight in a task pool."""
        if delta <= 0:
            raise ValueError("delta must be positive")
        with self._lock:
            entry = self._get_entry(task_type, api_id)
            entry.weight += delta

    def downvote(self, task_type: str, api_id: str, delta: float = 0.5) -> None:
        """Decrease an API's weight. Floor is 0 (still in pool, can upvote to restore)."""
        if delta <= 0:
            raise ValueError("delta must be positive")
        with self._lock:
            entry = self._get_entry(task_type, api_id)
            entry.weight = max(0.0, entry.weight - delta)

    def disable(self, task_type: str, api_id: str) -> None:
        """Disable an API in a task pool (enabled=False, preserved for re-enable)."""
        with self._lock:
            entry = self._get_entry(task_type, api_id)
            entry.enabled = False

    def enable(self, task_type: str, api_id: str) -> None:
        """Re-enable a previously disabled API in a task pool."""
        with self._lock:
            entry = self._get_entry(task_type, api_id)
            entry.enabled = True

    def remove(self, task_type: str, api_id: str) -> None:
        """Permanently delete an entry from a task pool (not recoverable)."""
        with self._lock:
            pool = self._pools.get(task_type)
            if pool is None:
                raise KeyError(f"no pool for task_type '{task_type}'")
            pool.entries = [e for e in pool.entries if e.api_id != api_id]

    # --- Pool fork ---

    def fork_pool(self, task_type: str) -> TaskPool:
        """Create an independent pool for a subtype (deep copy from parent).

        E.g. /pool fork skill/commit → copies subagent/skill pool to skill/commit.
        Subsequent adjustments to skill/commit do not affect subagent/skill.
        """
        with self._lock:
            parent = resolve_pool(
                task_type, self._pools, default_pool=self._default_pool
            )
            new_pool = TaskPool(
                task_type=task_type,
                entries=deepcopy(parent.entries),
            )
            self._pools[task_type] = new_pool
            return new_pool

    # --- Query ---

    def get_pool(self, task_type: str) -> TaskPool:
        """Return the effective pool for a task type (resolved, read-only view).

        Unlike select(), this returns the pool even if it has no entries —
        it is a query, not a selection.
        """
        with self._lock:
            return self._resolve_pool_lenient(task_type)

    def _resolve_pool_lenient(self, task_type: str) -> TaskPool:
        """Resolve the pool chain for query purposes. Accepts empty pools."""
        current = task_type
        while current is not None:
            pool = self._pools.get(current)
            if pool is not None:
                return pool
            current = resolve_parent(current)
        if self._default_pool is not None:
            return self._default_pool
        return self._ensure_pool(task_type)

    def list_task_types(self) -> list[str]:
        """List all task types that have independent pool configuration."""
        with self._lock:
            return sorted(self._pools.keys())

    def list_apis(self, task_type: str) -> list[PoolEntry]:
        """List all API entries in the resolved pool for a task type."""
        pool = self.get_pool(task_type)
        return list(pool.entries)

    # --- Persistence ---

    def to_config(self) -> PoolConfig:
        """Export current pool state as a serializable PoolConfig.

        Only exports task types with non-empty independent pools.
        Called by: /pool save, config module on session end.
        """
        with self._lock:
            pools: dict[str, list[PoolEntry]] = {}
            for task_type, pool in self._pools.items():
                if pool.entries:
                    pools[task_type] = [deepcopy(e) for e in pool.entries]
            return PoolConfig(
                version=1,
                default_weight=self._default_weight,
                pools=pools,
            )

    def replace_config(self, config: PoolConfig) -> None:
        """Replace current pool state with loaded config (called on startup)."""
        with self._lock:
            self._pools.clear()
            self._default_weight = config.default_weight
            for task_type, entries in config.pools.items():
                self._pools[task_type] = TaskPool(
                    task_type=task_type,
                    entries=[deepcopy(e) for e in entries],
                )
            # Ensure root task types always exist (even with empty routing config)
            self._init_defaults()

    # --- Internal ---

    def _list_all_task_types(self) -> list[str]:
        """All known task types: static hierarchy + dynamic + already configured."""
        types: set[str] = set(TASK_HIERARCHY.keys())
        types.update(self._pools.keys())
        return sorted(types)

    def _ensure_pool(self, task_type: str) -> TaskPool:
        """Get or create a pool for a task type."""
        if task_type not in self._pools:
            self._pools[task_type] = TaskPool(task_type=task_type)
        return self._pools[task_type]

    def _init_defaults(self) -> None:
        """Initialize root task type pools as empty."""
        for root in ("main", "subagent", "continuous", "background"):
            if root not in self._pools:
                self._pools[root] = TaskPool(task_type=root)
