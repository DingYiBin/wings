"""Pure data structures for the API candidate pool (v2).

Global pool: every known API has a base score (default 0).
Score masks: each task type adjusts scores over the global pool.
Selection: softmax(effective_scores) → weighted random pick.
"""

from pydantic import BaseModel, Field


class PoolEntry(BaseModel):
    """A known API in the global pool."""

    api_id: str  # e.g. "anthropic/claude-opus-4-6"
    score: float = 0.0  # base score (default 0, -inf = globally disabled)


class ScoreMask(BaseModel):
    """Per-task-type score adjustments over the global pool.

    Keys are api_id, values are score deltas.
    -inf = disabled for this task type.
    Absent keys = no adjustment (delta 0).
    """

    adjustments: dict[str, float] = Field(default_factory=dict)


class PoolConfig(BaseModel):
    """Serializable pool configuration (v2)."""

    version: int = 2
    apis: list[PoolEntry] = Field(default_factory=list)  # global pool
    masks: dict[str, dict[str, float]] = Field(default_factory=dict)  # task_type → {api_id → delta}
