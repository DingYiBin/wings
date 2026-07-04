"""API candidate pool — wings' core differentiator.

Each model call randomly selects an API from the current task type's pool
using weighted random selection. Users adjust pools through scoring and settings.
"""

from wings.routing.types import PoolConfig, PoolEntry, TaskPool
from wings.routing.selector import NoAPIAvailable, weighted_select
from wings.routing.tasks import TASK_HIERARCHY, resolve_parent, resolve_pool
from wings.routing.protocol import ModelSelector
from wings.routing.manager import APIPoolManager

__all__ = [
    "PoolEntry",
    "TaskPool",
    "PoolConfig",
    "NoAPIAvailable",
    "weighted_select",
    "TASK_HIERARCHY",
    "resolve_parent",
    "resolve_pool",
    "ModelSelector",
    "APIPoolManager",
]
