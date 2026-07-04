"""Softmax-based API selection from global pool + score masks."""

import math
import random
from collections.abc import Sequence

from wings.routing.types import PoolEntry

NEG_INF = float("-inf")


class NoAPIAvailable(Exception):
    """No API is available for selection."""


def softmax_select(
    entries: Sequence[PoolEntry],
    mask: dict[str, float] | None = None,
) -> str:
    """Select an API via softmax over effective scores.

    effective_score[api] = base_score + mask_delta
    mask_delta of -inf = disabled for this task type.

    Returns the selected api_id.
    Raises NoAPIAvailable if all APIs are disabled.
    """
    adjustments = mask or {}

    # Compute effective scores
    effective: dict[str, float] = {}
    for e in entries:
        delta = adjustments.get(e.api_id, 0.0)
        effective[e.api_id] = e.score + delta

    # Filter out -inf (disabled)
    active = {k: v for k, v in effective.items() if not math.isinf(v) or v > NEG_INF}
    if not active:
        raise NoAPIAvailable("all APIs disabled for this task type")

    # Softmax with numerical stability (subtract max)
    max_score = max(active.values())
    exps = {k: math.exp(v - max_score) for k, v in active.items()}
    total = sum(exps.values())

    # Weighted random selection
    r = random.uniform(0, total)
    cumulative = 0.0
    for api_id, exp_val in exps.items():
        cumulative += exp_val
        if r <= cumulative:
            return api_id
    # Float rounding fallback
    return list(active.keys())[-1]
