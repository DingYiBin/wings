"""Tests for the permission system — rules and pipeline."""

import pytest

from wings.permissions.rules import PermissionRules
from wings.permissions.pipeline import PermissionPipeline
from wings.tools.base import ToolContext, ToolResult


# -- PermissionRules -----------------------------------------------------------

def test_rules_allowlist_match():
    rules = PermissionRules(allowlist={"read"})
    assert rules.match("read") == "allow"


def test_rules_denylist_priority():
    """Denylist takes priority over allowlist."""
    rules = PermissionRules(allowlist={"bash"}, denylist={"bash"})
    assert rules.match("bash") == "deny"


def test_rules_asklist():
    rules = PermissionRules(asklist={"write"})
    assert rules.match("write") == "ask"


def test_rules_default_ask():
    rules = PermissionRules()
    assert rules.match("unknown_tool") == "ask"


def test_rules_add_allow():
    rules = PermissionRules()
    rules.add_allow("read")
    assert rules.match("read") == "allow"


def test_rules_add_deny():
    rules = PermissionRules()
    rules.add_deny("rm")
    assert rules.match("rm") == "deny"


def test_rules_from_config():
    config = {
        "allowlist": ["read", "glob"],
        "denylist": ["rm"],
        "asklist": ["write"],
    }
    rules = PermissionRules.from_config(config)
    assert rules.match("read") == "allow"
    assert rules.match("rm") == "deny"
    assert rules.match("write") == "ask"


# -- PermissionPipeline --------------------------------------------------------


class _Tool:
    """Minimal tool for testing the pipeline."""

    def __init__(self, name, read_only=False, destructive=False):
        self.name = name
        self.description = ""
        self.search_hint = ""
        self._read_only = read_only
        self._destructive = destructive

    def input_schema(self):
        return {}

    async def call(self, input, context):
        return ToolResult(output="ok")

    def is_enabled(self):
        return True

    def is_read_only(self, input=None):
        return self._read_only

    def is_destructive(self, input=None):
        return self._destructive

    def render_result(self, result):
        return result.output

    def activity_description(self, input=None):
        return self.name


@pytest.fixture
def ctx():
    return ToolContext(working_dir="/tmp")


@pytest.mark.asyncio
async def test_pipeline_stage1_deny(ctx):
    rules = PermissionRules(denylist={"rm"})
    pipeline = PermissionPipeline(rules)
    result = await pipeline.check(_Tool("rm"), None, ctx)
    assert result == "deny"


@pytest.mark.asyncio
async def test_pipeline_stage1_allow(ctx):
    rules = PermissionRules(allowlist={"read"})
    pipeline = PermissionPipeline(rules)
    result = await pipeline.check(_Tool("read"), None, ctx)
    assert result == "allow"


@pytest.mark.asyncio
async def test_pipeline_stage2_read_only_auto_allow(ctx):
    """Read-only tools are automatically allowed."""
    rules = PermissionRules()  # no explicit rules
    pipeline = PermissionPipeline(rules)
    result = await pipeline.check(_Tool("glob", read_only=True), None, ctx)
    assert result == "allow"


@pytest.mark.asyncio
async def test_pipeline_stage2_destructive_not_auto_allow(ctx):
    """Destructive tools without allowlist entry fall through to ask."""
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules)
    result = await pipeline.check(_Tool("rm", destructive=True), None, ctx)
    assert result == "ask"


@pytest.mark.asyncio
async def test_pipeline_stage3_hook_allows(ctx):
    """Hook returns a decision — pipeline uses it."""
    rules = PermissionRules()

    class Hook:
        async def run_pre_tool_use(self, tool_name, tool_input):
            return "allow"

    pipeline = PermissionPipeline(rules, hook_runner=Hook())
    result = await pipeline.check(_Tool("bash", destructive=True), None, ctx)
    assert result == "allow"


@pytest.mark.asyncio
async def test_pipeline_stage3_hook_denies(ctx):
    rules = PermissionRules()

    class Hook:
        async def run_pre_tool_use(self, tool_name, tool_input):
            return "deny"

    pipeline = PermissionPipeline(rules, hook_runner=Hook())
    result = await pipeline.check(_Tool("bash", destructive=True), None, ctx)
    assert result == "deny"


@pytest.mark.asyncio
async def test_pipeline_stage3_hook_passes(ctx):
    """Hook returns None — pipeline continues to stage 4."""
    rules = PermissionRules()

    class Hook:
        async def run_pre_tool_use(self, tool_name, tool_input):
            return None

    pipeline = PermissionPipeline(rules, hook_runner=Hook())
    result = await pipeline.check(_Tool("bash", destructive=True), None, ctx)
    assert result == "ask"


@pytest.mark.asyncio
async def test_pipeline_stage4_ask_is_default(ctx):
    """Without any rules, hooks, or read_only flag, result is 'ask'."""
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules)
    result = await pipeline.check(_Tool("bash", destructive=True), None, ctx)
    assert result == "ask"


@pytest.mark.asyncio
async def test_pipeline_no_hook_runner(ctx):
    """Pipeline works without a hook runner."""
    rules = PermissionRules()
    pipeline = PermissionPipeline(rules, hook_runner=None)
    result = await pipeline.check(_Tool("bash", destructive=True), None, ctx)
    assert result == "ask"


@pytest.mark.asyncio
async def test_pipeline_denylist_bypasses_everything(ctx):
    """Denylist in stage 1 prevents all later stages."""
    rules = PermissionRules(denylist={"read"})

    class Hook:
        async def run_pre_tool_use(self, tool_name, tool_input):
            return "allow"  # this should never be reached

    pipeline = PermissionPipeline(rules, hook_runner=Hook())
    result = await pipeline.check(_Tool("read", read_only=True), None, ctx)
    assert result == "deny"
