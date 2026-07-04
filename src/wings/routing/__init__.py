"""API candidate pool — global pool + per-task-type score masks.

Each model call computes effective scores (base + mask) and picks
via softmax. Users adjust masks per task type (upvote/downvote/disable).
"""

from wings.routing.types import PoolConfig, PoolEntry, ScoreMask
from wings.routing.selector import NEG_INF, NoAPIAvailable, softmax_select
from wings.routing.tasks import TASK_HIERARCHY, resolve_parent
from wings.routing.protocol import ModelSelector
from wings.routing.manager import APIPoolManager

__all__ = [
    "PoolEntry",
    "ScoreMask",
    "PoolConfig",
    "NEG_INF",
    "NoAPIAvailable",
    "softmax_select",
    "TASK_HIERARCHY",
    "resolve_parent",
    "ModelSelector",
    "APIPoolManager",
]
