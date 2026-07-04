"""Weighted random selection algorithm — pure function, zero dependencies."""

import random
from collections.abc import Sequence

from wings.routing.types import PoolEntry

WEIGHT_EPSILON = 1e-9


class NoAPIAvailable(Exception):
    """No API is available in the resolved pool."""


def weighted_select(entries: Sequence[PoolEntry]) -> str:
    """Select an API by weighted random choice (pure function).

    Entries with weight <= EPSILON or enabled=False are excluded.

    Args:
        entries: Pool entries to select from.

    Returns:
        The api_id of the selected entry.

    Raises:
        NoAPIAvailable: No active entries in the pool.
    """
    active = [e for e in entries if e.enabled and e.weight > WEIGHT_EPSILON]
    if not active:
        raise NoAPIAvailable("no active API in pool")

    total = sum(e.weight for e in active)
    r = random.uniform(0, total)
    cumulative = 0.0
    for e in active:
        cumulative += e.weight
        if r <= cumulative:
            return e.api_id
    # Float rounding caused a miss; return the last entry
    return active[-1].api_id
