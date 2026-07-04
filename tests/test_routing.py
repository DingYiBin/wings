"""Tests for the routing module — API candidate pool system."""

import random

import pytest

from wings.routing.types import PoolConfig, PoolEntry, TaskPool
from wings.routing.selector import WEIGHT_EPSILON, NoAPIAvailable, weighted_select
from wings.routing.tasks import (
    TASK_HIERARCHY,
    resolve_parent,
    resolve_pool,
)
from wings.routing.manager import APIPoolManager


# ---- weighted_select ----

def test_weighted_select_single_entry():
    entries = [PoolEntry(api_id="a", weight=1.0)]
    assert weighted_select(entries) == "a"


def test_weighted_select_zero_weight_excluded():
    entries = [
        PoolEntry(api_id="a", weight=0.0),
        PoolEntry(api_id="b", weight=1.0),
    ]
    # With seed=42, "b" should be the only option
    random.seed(42)
    result = weighted_select(entries)
    assert result == "b"


def test_weighted_select_disabled_excluded():
    entries = [
        PoolEntry(api_id="a", weight=1.0, enabled=False),
        PoolEntry(api_id="b", weight=1.0),
    ]
    random.seed(0)
    assert weighted_select(entries) == "b"


def test_weighted_select_empty_raises():
    with pytest.raises(NoAPIAvailable, match="no active API"):
        weighted_select([])


def test_weighted_select_all_disabled_raises():
    entries = [PoolEntry(api_id="a", enabled=False)]
    with pytest.raises(NoAPIAvailable):
        weighted_select(entries)


def test_weighted_select_all_zero_weight_raises():
    entries = [PoolEntry(api_id="a", weight=0.0)]
    with pytest.raises(NoAPIAvailable):
        weighted_select(entries)


def test_weighted_select_proportional():
    """Statistical test: higher weight → more frequent selection."""
    entries = [
        PoolEntry(api_id="heavy", weight=9.0),
        PoolEntry(api_id="light", weight=1.0),
    ]
    counts: dict[str, int] = {}
    random.seed(0)
    for _ in range(10000):
        api = weighted_select(entries)
        counts[api] = counts.get(api, 0) + 1
    # heavy should be selected roughly 9x more than light
    assert counts["heavy"] > counts["light"] * 3  # generous margin


def test_weighted_select_epsilon_boundary():
    """Entries at exactly EPSILON are included, below are excluded."""
    entries = [
        PoolEntry(api_id="barely", weight=WEIGHT_EPSILON * 1.01),
        PoolEntry(api_id="excluded", weight=WEIGHT_EPSILON * 0.99),
        PoolEntry(api_id="normal", weight=1.0),
    ]
    # "excluded" should never be selected
    random.seed(0)
    for _ in range(100):
        assert weighted_select(entries) != "excluded"


# ---- resolve_parent ----

def test_resolve_parent_static():
    assert resolve_parent("subagent/explore") == "subagent"
    assert resolve_parent("subagent/plan") == "subagent"
    assert resolve_parent("subagent/skill") == "subagent"
    assert resolve_parent("main") is None
    assert resolve_parent("subagent") is None


def test_resolve_parent_skill_dynamic():
    assert resolve_parent("skill/commit") == "subagent/skill"
    assert resolve_parent("skill/review-pr") == "subagent/skill"
    assert resolve_parent("skill/pdf") == "subagent/skill"


def test_resolve_parent_unknown():
    assert resolve_parent("custom/type") is None
    assert resolve_parent("unknown") is None


# ---- resolve_pool ----

def test_resolve_pool_exact_match():
    pools = {
        "main": TaskPool(
            task_type="main",
            entries=[PoolEntry(api_id="a")],
        )
    }
    result = resolve_pool("main", pools)
    assert result.task_type == "main"
    assert result.entries[0].api_id == "a"


def test_resolve_pool_inherits_from_parent():
    pools = {
        "subagent": TaskPool(
            task_type="subagent",
            entries=[PoolEntry(api_id="parent-api")],
        )
    }
    result = resolve_pool("subagent/explore", pools)
    assert result.task_type == "subagent"


def test_resolve_pool_uses_independent_over_parent():
    pools = {
        "subagent": TaskPool(
            task_type="subagent",
            entries=[PoolEntry(api_id="parent-api")],
        ),
        "subagent/explore": TaskPool(
            task_type="subagent/explore",
            entries=[PoolEntry(api_id="explore-api")],
        ),
    }
    result = resolve_pool("subagent/explore", pools)
    assert result.task_type == "subagent/explore"


def test_resolve_pool_skill_dynamic_chain():
    """skill/commit → subagent/skill → subagent"""
    pools = {
        "subagent": TaskPool(
            task_type="subagent",
            entries=[PoolEntry(api_id="base-api")],
        )
    }
    result = resolve_pool("skill/commit", pools)
    assert result.task_type == "subagent"


def test_resolve_pool_skill_has_independent():
    pools = {
        "subagent": TaskPool(
            task_type="subagent",
            entries=[PoolEntry(api_id="base-api")],
        ),
        "skill/commit": TaskPool(
            task_type="skill/commit",
            entries=[PoolEntry(api_id="commit-api")],
        ),
    }
    result = resolve_pool("skill/commit", pools)
    assert result.task_type == "skill/commit"


def test_resolve_pool_empty_parent_skipped():
    """Pool with empty entries is skipped; fall through to parent's parent."""
    pools = {
        "subagent/skill": TaskPool(task_type="subagent/skill", entries=[]),
        "subagent": TaskPool(
            task_type="subagent",
            entries=[PoolEntry(api_id="base-api")],
        ),
    }
    result = resolve_pool("skill/commit", pools)
    assert result.task_type == "subagent"


def test_resolve_pool_falls_back_to_default():
    default = TaskPool(
        task_type="default",
        entries=[PoolEntry(api_id="fallback")],
    )
    result = resolve_pool("main", {}, default_pool=default)
    assert result.task_type == "default"


def test_resolve_pool_no_default_raises():
    with pytest.raises(NoAPIAvailable, match="no pool"):
        resolve_pool("main", {}, default_pool=None)


def test_resolve_pool_unknown_type_uses_default():
    default = TaskPool(
        task_type="default",
        entries=[PoolEntry(api_id="fallback")],
    )
    result = resolve_pool("custom/unknown", {}, default_pool=default)
    assert result.task_type == "default"


# ---- APIPoolManager: selection ----

def test_manager_select_with_override():
    mgr = APIPoolManager()
    mgr.register_api("api-a")
    assert mgr.select("main", override="forced-model") == "forced-model"


def test_manager_select_from_pool():
    mgr = APIPoolManager()
    mgr.register_api("api-a")
    mgr.register_api("api-b")
    # Both have equal weight, selection should return one of them
    random.seed(0)
    result = mgr.select("main")
    assert result in ("api-a", "api-b")


def test_manager_select_empty_pool_raises():
    mgr = APIPoolManager()
    with pytest.raises(NoAPIAvailable):
        mgr.select("main")


# ---- APIPoolManager: registration ----

def test_register_api_adds_to_all_root_pools():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    for root in ("main", "subagent", "continuous", "background"):
        apis = [e.api_id for e in mgr.list_apis(root)]
        assert "api-x" in apis, f"missing from {root}"


def test_register_api_add_to_specific():
    mgr = APIPoolManager()
    mgr.register_api("api-x", add_to=["main", "subagent"])
    assert "api-x" in [e.api_id for e in mgr.list_apis("main")]
    assert "api-x" in [e.api_id for e in mgr.list_apis("subagent")]
    # Not in continuous since we specified add_to
    apis_cont = [e.api_id for e in mgr.list_apis("continuous")]
    assert "api-x" not in apis_cont


def test_register_api_exclude_from():
    mgr = APIPoolManager()
    mgr.register_api("api-x", exclude_from=["continuous"])
    assert "api-x" in [e.api_id for e in mgr.list_apis("main")]
    assert "api-x" not in [e.api_id for e in mgr.list_apis("continuous")]


def test_register_api_add_to_exclude_from_mutually_exclusive():
    mgr = APIPoolManager()
    with pytest.raises(ValueError, match="mutually exclusive"):
        mgr.register_api("api-x", add_to=["main"], exclude_from=["subagent"])


def test_unregister_api_removes_from_all():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.unregister_api("api-x")
    for root in ("main", "subagent", "continuous", "background"):
        apis = [e.api_id for e in mgr.list_apis(root)]
        assert "api-x" not in apis


# ---- APIPoolManager: adjustments ----

def test_upvote_increases_weight():
    mgr = APIPoolManager()
    mgr.register_api("api-x", add_to=["main"])
    original = mgr.list_apis("main")[0].weight
    mgr.upvote("main", "api-x", delta=0.5)
    assert mgr.list_apis("main")[0].weight == original + 0.5


def test_downvote_decreases_weight():
    mgr = APIPoolManager()
    mgr.register_api("api-x", add_to=["main"])
    mgr.adjust_weight("main", "api-x", 2.0)
    mgr.downvote("main", "api-x", delta=0.5)
    assert mgr.list_apis("main")[0].weight == 1.5


def test_downvote_floor_zero():
    mgr = APIPoolManager()
    mgr.register_api("api-x", add_to=["main"])
    mgr.adjust_weight("main", "api-x", 0.2)
    mgr.downvote("main", "api-x", delta=1.0)
    assert mgr.list_apis("main")[0].weight == 0.0


def test_adjust_weight_exact():
    mgr = APIPoolManager()
    mgr.register_api("api-x", add_to=["main"])
    mgr.adjust_weight("main", "api-x", 3.5)
    assert mgr.list_apis("main")[0].weight == 3.5


def test_adjust_weight_negative_raises():
    mgr = APIPoolManager()
    mgr.register_api("api-x", add_to=["main"])
    with pytest.raises(ValueError, match="weight must be >= 0"):
        mgr.adjust_weight("main", "api-x", -1.0)


def test_disable_excludes_from_selection():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.disable("main", "api-x")
    entry = [e for e in mgr.list_apis("main") if e.api_id == "api-x"][0]
    assert entry.enabled is False
    # Should not be selectable
    random.seed(0)
    mgr.register_api("api-y", add_to=["main"])
    for _ in range(50):
        assert mgr.select("main", override=None) == "api-y"


def test_enable_reincludes():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.disable("main", "api-x")
    mgr.enable("main", "api-x")
    entry = [e for e in mgr.list_apis("main") if e.api_id == "api-x"][0]
    assert entry.enabled is True


def test_remove_deletes_entry():
    mgr = APIPoolManager()
    mgr.register_api("api-x", add_to=["main"])
    mgr.remove("main", "api-x")
    apis = [e.api_id for e in mgr.list_apis("main")]
    assert "api-x" not in apis


def test_upvote_nonexistent_pool_raises():
    mgr = APIPoolManager()
    with pytest.raises(KeyError):
        mgr.upvote("nonexistent", "api-x")


def test_upvote_nonexistent_api_raises():
    mgr = APIPoolManager()
    mgr.register_api("api-x", add_to=["main"])
    with pytest.raises(KeyError):
        mgr.upvote("main", "nonexistent")


# ---- APIPoolManager: fork ----

def test_fork_pool_copies_parent_entries():
    mgr = APIPoolManager()
    mgr.register_api("api-a", add_to=["subagent"])
    mgr.register_api("api-b", add_to=["subagent"])

    mgr.fork_pool("skill/commit")

    commit_apis = [e.api_id for e in mgr.list_apis("skill/commit")]
    assert set(commit_apis) == {"api-a", "api-b"}


def test_fork_pool_independent_after_fork():
    """After fork, changes to the child don't affect the parent."""
    mgr = APIPoolManager()
    mgr.register_api("api-a", add_to=["subagent"])

    mgr.fork_pool("skill/commit")
    mgr.adjust_weight("skill/commit", "api-a", 5.0)

    # Parent weight unchanged
    parent_entry = [e for e in mgr.list_apis("subagent") if e.api_id == "api-a"][0]
    assert parent_entry.weight == 1.0
    # Child has new weight
    child_entry = [e for e in mgr.list_apis("skill/commit") if e.api_id == "api-a"][0]
    assert child_entry.weight == 5.0


# ---- APIPoolManager: persistence ----

def test_to_config_roundtrip():
    mgr = APIPoolManager()
    mgr.register_api("api-a", add_to=["main"])
    mgr.adjust_weight("main", "api-a", 2.0)
    mgr.register_api("api-b", add_to=["subagent"])
    mgr.disable("subagent", "api-b")

    config = mgr.to_config()
    assert config.version == 1
    assert config.default_weight == 1.0
    assert "main" in config.pools
    assert "subagent" in config.pools


def test_replace_config_restores_state():
    original = APIPoolManager()
    original.register_api("api-a", add_to=["main"])
    original.adjust_weight("main", "api-a", 3.0)

    config = original.to_config()

    restored = APIPoolManager(config=config)
    entry = [e for e in restored.list_apis("main") if e.api_id == "api-a"][0]
    assert entry.weight == 3.0


def test_to_config_skips_empty_pools():
    mgr = APIPoolManager()
    mgr.register_api("api-x", add_to=["main"])
    config = mgr.to_config()
    # "subagent" has no entries yet (empty pool created by _init_defaults)
    assert "subagent" not in config.pools


def test_replace_config_updates_default_weight():
    config = PoolConfig(version=1, default_weight=2.0)
    mgr = APIPoolManager(config=config)
    mgr.register_api("api-x", add_to=["main"])
    assert mgr.list_apis("main")[0].weight == 2.0


# ---- APIPoolManager: list_task_types ----

def test_list_task_types():
    mgr = APIPoolManager()
    mgr.register_api("api-x", add_to=["main", "subagent/explore"])
    types = mgr.list_task_types()
    assert "main" in types
    assert "subagent/explore" in types


# ---- TASK_HIERARCHY completeness ----

def test_root_types_have_no_parent():
    for root in ("main", "subagent", "continuous", "background"):
        assert TASK_HIERARCHY[root] is None


def test_all_hierarchy_values_are_valid_keys():
    for child, parent in TASK_HIERARCHY.items():
        if parent is not None:
            assert parent in TASK_HIERARCHY, (
                f"Parent '{parent}' of '{child}' not in hierarchy"
            )
