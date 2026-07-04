"""Tests for routing — global pool + score masks + softmax selection."""

import math
import random

import pytest

from wings.routing.types import PoolConfig, PoolEntry
from wings.routing.selector import NEG_INF, NoAPIAvailable, softmax_select
from wings.routing.tasks import TASK_HIERARCHY, resolve_parent
from wings.routing.manager import APIPoolManager


# -- softmax_select ------------------------------------------------------------

def test_softmax_select_single():
    entries = [PoolEntry(api_id="a", score=0.0)]
    assert softmax_select(entries) == "a"


def test_softmax_select_disabled():
    """-inf mask delta excludes the API."""
    entries = [PoolEntry(api_id="a", score=0.0), PoolEntry(api_id="b", score=0.0)]
    random.seed(0)
    result = softmax_select(entries, mask={"a": NEG_INF})
    assert result == "b"


def test_softmax_select_higher_score_more_likely():
    """Higher score adjustment → exponentially higher probability."""
    entries = [PoolEntry(api_id="a", score=0.0), PoolEntry(api_id="b", score=0.0)]
    counts = {"a": 0, "b": 0}
    random.seed(0)
    for _ in range(10000):
        api = softmax_select(entries, mask={"a": 2.0})
        counts[api] += 1
    # a has exp(2) ≈ 7.4x more weight
    assert counts["a"] > counts["b"] * 2


def test_softmax_select_all_disabled():
    entries = [PoolEntry(api_id="a", score=0.0)]
    with pytest.raises(NoAPIAvailable):
        softmax_select(entries, mask={"a": NEG_INF})


def test_softmax_select_empty_entries():
    with pytest.raises(NoAPIAvailable):
        softmax_select([], None)


def test_softmax_select_no_mask():
    """No mask → all at base score → uniform probabilities."""
    entries = [PoolEntry(api_id="a"), PoolEntry(api_id="b")]
    random.seed(0)
    result = softmax_select(entries)
    assert result in ("a", "b")


def test_softmax_negative_adjustment():
    """Negative delta reduces probability but doesn't disable."""
    entries = [PoolEntry(api_id="a"), PoolEntry(api_id="b")]
    random.seed(0)
    # a at -5 should almost never be selected vs b at 0
    # exp(-5) / (exp(0) + exp(-5)) ≈ 0.007
    counts = {"a": 0, "b": 0}
    for _ in range(10000):
        api = softmax_select(entries, mask={"a": -5.0})
        counts[api] += 1
    assert counts["b"] > counts["a"] * 10


# -- resolve_parent ------------------------------------------------------------

def test_resolve_parent_static():
    assert resolve_parent("subagent/explore") == "subagent"
    assert resolve_parent("main") is None


def test_resolve_parent_skill_dynamic():
    assert resolve_parent("skill/commit") == "subagent/skill"


def test_resolve_parent_unknown():
    assert resolve_parent("custom/type") is None


def test_root_types_have_no_parent():
    for root in ("main", "subagent", "continuous", "background"):
        assert TASK_HIERARCHY[root] is None


def test_all_hierarchy_values_are_valid_keys():
    for child, parent in TASK_HIERARCHY.items():
        if parent is not None:
            assert parent in TASK_HIERARCHY


# -- APIPoolManager: selection ------------------------------------------------


def test_manager_select_with_override():
    mgr = APIPoolManager()
    mgr.register_api("api-a")
    assert mgr.select("main", override="forced") == "forced"


def test_manager_select_from_global_pool():
    mgr = APIPoolManager()
    mgr.register_api("api-a")
    mgr.register_api("api-b")
    random.seed(0)
    result = mgr.select("main")
    assert result in ("api-a", "api-b")


def test_manager_select_empty_pool_raises():
    mgr = APIPoolManager()
    with pytest.raises(NoAPIAvailable):
        mgr.select("main")


def test_manager_select_all_disabled_raises():
    mgr = APIPoolManager()
    mgr.register_api("api-a")
    mgr.disable("main", "api-a")
    with pytest.raises(NoAPIAvailable):
        mgr.select("main")


# -- APIPoolManager: registration ----------------------------------------------


def test_register_api_adds_to_global_pool():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    assert "api-x" in mgr.list_apis()


def test_unregister_api_removes_from_global_and_masks():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.disable("main", "api-x")
    mgr.unregister_api("api-x")
    assert "api-x" not in mgr.list_apis()
    assert "api-x" not in mgr.get_mask("main")


# -- APIPoolManager: score adjustments -----------------------------------------


def test_upvote_increases_mask_delta():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.upvote("main", "api-x", delta=0.5)
    assert mgr.get_mask("main")["api-x"] == 0.5


def test_downvote_decreases_mask_delta():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.downvote("main", "api-x", delta=0.5)
    assert mgr.get_mask("main")["api-x"] == -0.5


def test_adjust_score_exact():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.adjust_score("main", "api-x", 3.0)
    assert mgr.get_mask("main")["api-x"] == 3.0


def test_adjust_base_score():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.adjust_base_score("api-x", 2.0)
    random.seed(0)
    mgr.register_api("api-y")
    # api-x at score 2.0 should dominate api-y at 0.0
    counts = {"api-x": 0, "api-y": 0}
    for _ in range(1000):
        api = mgr.select("main")
        counts[api] += 1
    assert counts["api-x"] > counts["api-y"] * 2


def test_disable_excludes():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.register_api("api-y")
    mgr.disable("main", "api-x")
    random.seed(0)
    for _ in range(50):
        assert mgr.select("main") == "api-y"


def test_enable_reincludes():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.register_api("api-y")
    mgr.disable("main", "api-x")
    mgr.enable("main", "api-x")
    random.seed(0)
    found = set()
    for _ in range(50):
        found.add(mgr.select("main"))
    assert "api-x" in found


# -- APIPoolManager: masks + inheritance ---------------------------------------


def test_mask_inheritance():
    """subagent/explore inherits subagent mask."""
    mgr = APIPoolManager()
    mgr.register_api("api-a")
    mgr.register_api("api-b")
    mgr.disable("subagent", "api-b")
    # subagent/explore has no mask → inherits subagent mask
    random.seed(0)
    for _ in range(50):
        assert mgr.select("subagent/explore") == "api-a"


def test_mask_child_overrides_parent():
    """Child mask takes priority over parent."""
    mgr = APIPoolManager()
    mgr.register_api("api-a")
    mgr.register_api("api-b")
    mgr.disable("subagent", "api-a")
    # Child explicitly enables api-a (overrides parent disable)
    mgr.adjust_score("subagent/explore", "api-a", 0.0)
    mgr.disable("subagent/explore", "api-b")
    random.seed(0)
    for _ in range(50):
        assert mgr.select("subagent/explore") == "api-a"


def test_fork_mask():
    mgr = APIPoolManager()
    mgr.register_api("api-a")
    mgr.register_api("api-b")
    mgr.disable("subagent", "api-b")
    mgr.fork_mask("skill/commit", "subagent")
    random.seed(0)
    for _ in range(50):
        assert mgr.select("skill/commit") == "api-a"


# -- APIPoolManager: persistence -----------------------------------------------


def test_to_config_roundtrip():
    mgr = APIPoolManager()
    mgr.register_api("api-a")
    mgr.register_api("api-b", score=1.0)
    mgr.upvote("main", "api-a", 2.0)
    mgr.disable("subagent", "api-b")

    config = mgr.to_config()
    assert config.version == 2
    assert len(config.apis) == 2

    restored = APIPoolManager(config=config)
    assert set(restored.list_apis()) == {"api-a", "api-b"}
    assert restored.get_mask("main")["api-a"] == 2.0
    assert restored.get_mask("subagent")["api-b"] == NEG_INF


def test_replace_config():
    config = PoolConfig(
        version=2,
        apis=[PoolEntry(api_id="x", score=5.0)],
        masks={"main": {"x": 1.0}},
    )
    mgr = APIPoolManager(config=config)
    assert mgr.list_apis() == ["x"]
    assert mgr.get_mask("main")["x"] == 1.0


def test_list_task_types():
    mgr = APIPoolManager()
    mgr.register_api("api-x")
    mgr.upvote("main", "api-x", 1.0)
    assert "main" in mgr.list_task_types()
