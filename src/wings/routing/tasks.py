"""Task type hierarchy — used by the pool manager to resolve mask inheritance."""

# Static inheritance hierarchy.  Not listed here:
#   - "skill/<name>" → resolve_parent returns "subagent/skill"
#   - other unknown → resolve_parent returns None (root type)
TASK_HIERARCHY: dict[str, str | None] = {
    "main": None,
    "subagent": None,
    "continuous": None,
    "background": None,
    "subagent/explore": "subagent",
    "subagent/plan": "subagent",
    "subagent/general": "subagent",
    "subagent/compact": "subagent",
    "subagent/memory": "subagent",
    "subagent/skill": "subagent",
    "subagent/meta": "subagent",
    "subagent/classify": "subagent",
    "subagent/code": "subagent",
    "continuous/cron": "continuous",
    "continuous/monitor": "continuous",
    "continuous/heartbeat": "continuous",
    "background/dream": "continuous",
    "background/title": "continuous",
    "background/compact": "continuous",
    "background/flush": "continuous",
}


def resolve_parent(task_type: str) -> str | None:
    """Resolve the parent task type.

    Lookup order: static TASK_HIERARCHY → skill/* prefix → unknown → None.
    """
    if task_type in TASK_HIERARCHY:
        return TASK_HIERARCHY[task_type]
    if task_type.startswith("skill/"):
        return "subagent/skill"
    return None
