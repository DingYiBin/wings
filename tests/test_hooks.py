"""Tests for the hooks system — HookRunner, HookConfig, HookResult."""

from __future__ import annotations

import asyncio

import pytest

from wings.hooks.runner import HookRunner, serialise_input
from wings.hooks.types import HookConfig, HookResult


# -- HookConfig / HookResult ---------------------------------------------------


def test_hook_config_defaults():
    cfg = HookConfig(command="echo hi")
    assert cfg.command == "echo hi"
    assert cfg.matcher is None


def test_hook_config_with_matcher():
    cfg = HookConfig(command="echo hi", matcher=r"^bash$")
    assert cfg.matcher == r"^bash$"


def test_hook_result_defaults():
    r = HookResult()
    assert r.decision == "allow"
    assert r.reason == ""
    assert r.stdout == ""


# -- HookRunner: no hooks ------------------------------------------------------


def test_has_hooks_false_when_empty():
    runner = HookRunner()
    assert not runner.has_hooks()


def test_has_hooks_true_with_pre():
    runner = HookRunner(pre_tool_use=[HookConfig(command="true")])
    assert runner.has_hooks()


@pytest.mark.asyncio
async def test_pre_tool_use_returns_none_when_no_hooks():
    runner = HookRunner()
    result = await runner.run_pre_tool_use("bash", {"command": "ls"})
    assert result is None


# -- HookRunner: allow / deny --------------------------------------------------


@pytest.mark.asyncio
async def test_pre_tool_use_allow_on_exit_0():
    """A hook that exits 0 should return 'allow'."""
    runner = HookRunner(pre_tool_use=[HookConfig(command="true")])
    result = await runner.run_pre_tool_use("bash", {"command": "ls"})
    assert result == "allow"


@pytest.mark.asyncio
async def test_pre_tool_use_deny_on_exit_2():
    """A hook that exits 2 should return 'deny'."""
    runner = HookRunner(pre_tool_use=[HookConfig(command="exit 2")])
    result = await runner.run_pre_tool_use("bash", {"command": "rm -rf /"})
    assert result == "deny"


@pytest.mark.asyncio
async def test_pre_tool_use_json_override_allow():
    """A hook can output JSON to set decision=allow."""
    runner = HookRunner(
        pre_tool_use=[HookConfig(command='echo \'{"decision":"allow","reason":"ok"}\'')]
    )
    result = await runner.run_pre_tool_use("read", {"path": "/tmp"})
    assert result == "allow"


@pytest.mark.asyncio
async def test_pre_tool_use_json_override_deny():
    """A hook can output JSON to set decision=deny."""
    runner = HookRunner(
        pre_tool_use=[HookConfig(command='echo \'{"decision":"deny","reason":"blocked"}\'')]
    )
    result = await runner.run_pre_tool_use("write", {"path": "/etc/passwd"})
    assert result == "deny"


# -- HookRunner: matcher -------------------------------------------------------


@pytest.mark.asyncio
async def test_matcher_skips_non_matching_tool():
    """A hook with matcher='^bash$' should not fire for 'read'."""
    runner = HookRunner(
        pre_tool_use=[HookConfig(command="exit 2", matcher=r"^bash$")]
    )
    # read doesn't match ^bash$ — hook doesn't fire, returns None
    result = await runner.run_pre_tool_use("read", {"path": "/tmp"})
    assert result is None


@pytest.mark.asyncio
async def test_matcher_fires_for_matching_tool():
    """A hook with matcher='^bash$' should fire for 'bash'."""
    runner = HookRunner(
        pre_tool_use=[HookConfig(command="exit 2", matcher=r"^bash$")]
    )
    result = await runner.run_pre_tool_use("bash", {"command": "ls"})
    assert result == "deny"


# -- HookRunner: post-tool-use -------------------------------------------------


@pytest.mark.asyncio
async def test_post_tool_use_runs_without_error():
    """PostToolUse hooks are fire-and-forget — should not raise."""
    runner = HookRunner(post_tool_use=[HookConfig(command="true")])
    await runner.run_post_tool_use("bash", {"command": "ls"}, "output here")


# -- serialise_input -----------------------------------------------------------


def test_serialise_input_dict():
    assert serialise_input({"a": 1}) == {"a": 1}


def test_serialise_input_string():
    assert serialise_input("hello") == "hello"


def test_serialise_input_pydantic_model():
    """Pydantic models should be dumped to dict."""
    from pydantic import BaseModel

    class MyInput(BaseModel):
        x: int = 5

    result = serialise_input(MyInput())
    assert result == {"x": 5}
