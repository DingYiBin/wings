"""Pure data structures for the API candidate pool."""

from pydantic import BaseModel, Field


class PoolEntry(BaseModel):
    """A single API entry in a candidate pool.

    Weight is a float. Comparisons use epsilon tolerance 1e-9.
    """

    api_id: str  # Unique identifier, e.g. "anthropic/claude-opus-4-6"
    weight: float = 1.0  # Relative probability weight, >= 0
    enabled: bool = True  # False = excluded from selection


class TaskPool(BaseModel):
    """API candidate pool for a specific task type (runtime structure).

    Inheritance is defined ONLY in TASK_HIERARCHY (tasks.py).
    TaskPool does not carry inherit_from — single source of truth.
    """

    task_type: str
    entries: list[PoolEntry] = Field(default_factory=list)


class PoolConfig(BaseModel):
    """Serializable pool configuration for persistence.

    Only stores task types that have independent pool configuration
    (non-empty entries). Task types not present here resolve via
    the inheritance chain.
    """

    version: int = 1  # Config format version, for future migrations
    default_weight: float = 1.0  # Default weight for newly registered APIs
    pools: dict[str, list[PoolEntry]] = Field(default_factory=dict)
