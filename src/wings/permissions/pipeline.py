"""Multi-stage permission pipeline for tool execution.

Request → static rules → auto-classify → hooks → interactive approval
"""

from __future__ import annotations

from typing import Any, Protocol

from wings.tools.base import Tool, ToolContext
from wings.permissions.rules import PermissionResult, PermissionRules


class HookRunner(Protocol):
    """Protocol for running pre-tool-use hooks.

    Implementations may be a no-op (hooks disabled) or run shell
    commands / scripts to decide or transform tool calls.
    """

    async def run_pre_tool_use(
        self, tool_name: str, tool_input: Any
    ) -> PermissionResult | None:
        """Run the hook. Return a decision or None to pass."""
        ...


class PermissionPipeline:
    """Four-stage permission check for tool execution.

    Stage 1: static rules (allowlist/denylist)
    Stage 2: auto-classify (read-only → allow, destructive → passthrough)
    Stage 3: hooks (user-configured shell scripts)
    Stage 4: interactive approval (return "ask" for the UI to handle)
    """

    def __init__(
        self,
        rules: PermissionRules,
        hook_runner: HookRunner | None = None,
    ):
        self._rules = rules
        self._hook_runner = hook_runner

    async def check(
        self,
        tool: Tool,
        tool_input: Any,
        context: ToolContext,
    ) -> PermissionResult:
        """Run the full permission pipeline.

        Returns "allow", "deny", or "ask" (for interactive approval).
        """

        # Stage 1: static rules (tool-level)
        result = self._rules.match(tool.name)
        if result != "ask":
            return result

        # Stage 1b: scoped rules (input-level)
        scoped = self._rules.check_scoped(tool.name, tool_input)
        if scoped is not None:
            return scoped

        # Stage 2: auto-classify (read-only operations are safe)
        if tool.is_read_only(tool_input):
            return "allow"

        # Stage 3: hooks
        if self._hook_runner is not None:
            hook_result = await self._hook_runner.run_pre_tool_use(
                tool.name, tool_input,
            )
            if hook_result is not None:
                return hook_result

        # Stage 4: interactive approval
        return "ask"
