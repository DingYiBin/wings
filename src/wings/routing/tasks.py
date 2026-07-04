"""Task type hierarchy and pool resolution — pure functions.

This is the SINGLE source of truth for inheritance relationships.
TaskPool does NOT carry its own inherit_from field.
"""

from wings.routing.selector import NoAPIAvailable
from wings.routing.types import TaskPool

# Static inheritance hierarchy.
# Task types not listed here:
#   - "skill/<name>" → resolve_parent returns "subagent/skill"
#   - other unknown → resolve_parent returns None (treated as root type)
TASK_HIERARCHY: dict[str, str | None] = {
    # Root task types (parent = None)
    "main": None,
    "subagent": None,
    "continuous": None,
    "background": None,
    # Sub-agent subtypes
    "subagent/explore": "subagent",
    "subagent/plan": "subagent",
    "subagent/general": "subagent",
    "subagent/compact": "subagent",
    "subagent/memory": "subagent",
    "subagent/skill": "subagent",
    "subagent/meta": "subagent",
    "subagent/classify": "subagent",
    "subagent/code": "subagent",
    # Continuous subtypes
    "continuous/cron": "continuous",
    "continuous/monitor": "continuous",
    "continuous/heartbeat": "continuous",
    # Background subtypes (fall back to continuous)
    "background/dream": "continuous",
    "background/title": "continuous",
    "background/compact": "continuous",
    "background/flush": "continuous",
}


def resolve_parent(task_type: str) -> str | None:
    """Resolve the parent task type (pure function).

    Lookup order: static TASK_HIERARCHY → skill/* prefix → unknown returns None
    """
    if task_type in TASK_HIERARCHY:
        return TASK_HIERARCHY[task_type]
    if task_type.startswith("skill/"):
        return "subagent/skill"
    return None


def resolve_pool(
    task_type: str,
    pools: dict[str, TaskPool],
    *,
    default_pool: TaskPool | None = None,
) -> TaskPool:
    """Resolve the effective pool for a task type (pure function).

    Walks up the inheritance chain, returning the first pool with
    independent configuration (non-empty entries).

    If the entire chain has no configured pool, falls back to default_pool.
    If default_pool is also None, raises NoAPIAvailable.

    Args:
        task_type: The task type to resolve.
        pools: All configured pools, keyed by task_type.
        default_pool: Global fallback pool.

    Returns:
        The resolved TaskPool.

    Raises:
        NoAPIAvailable: No pool found and no default configured.
    """
    current = task_type
    while current is not None:
        pool = pools.get(current)
        if pool is not None and pool.entries:
            return pool
        current = resolve_parent(current)
    if default_pool is not None:
        return default_pool
    raise NoAPIAvailable(
        f"no pool for task_type '{task_type}' and no default pool configured"
    )
