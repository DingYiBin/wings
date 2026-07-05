"""HookRunner — executes shell-command hooks for tool lifecycle events.

Implements the HookRunner Protocol from permissions.pipeline.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from wings.hooks.types import HookConfig, HookResult


class HookRunner:
    """Runs configured shell-command hooks for PreToolUse and PostToolUse events.

    Implements the HookRunner protocol so it plugs into PermissionPipeline.
    """

    def __init__(
        self,
        pre_tool_use: list[HookConfig] | None = None,
        post_tool_use: list[HookConfig] | None = None,
        timeout: float = 30.0,
    ):
        self._pre = pre_tool_use or []
        self._post = post_tool_use or []
        self._timeout = timeout

    # -- PermissionPipeline integration (HookRunner protocol) --

    async def run_pre_tool_use(
        self, tool_name: str, tool_input: Any
    ) -> str | None:
        """Run pre-tool-use hooks. Returns 'allow', 'deny', or None (passthrough)."""
        result = await self._run_matching(self._pre, tool_name, tool_input)
        if result is None:
            return None
        return result.decision

    # -- Public API --

    async def run_post_tool_use(
        self, tool_name: str, tool_input: Any, tool_result: str
    ) -> None:
        """Run post-tool-use hooks (fire-and-forget, results are advisory)."""
        await self._run_matching(
            self._post, tool_name, tool_input, tool_result
        )

    def has_hooks(self) -> bool:
        """Whether any hooks are configured."""
        return bool(self._pre or self._post)

    # -- Internal --

    async def _run_matching(
        self,
        hooks: list[HookConfig],
        tool_name: str,
        tool_input: Any,
        tool_result: str = "",
    ) -> HookResult | None:
        """Run all matching hooks in parallel, aggregate results.

        Returns the first "deny" result, or the first non-None result,
        or None if no hooks match.
        """
        matching = [
            h for h in hooks
            if h.matcher is None or re.search(h.matcher, tool_name)
        ]
        if not matching:
            return None

        tasks = [self._exec(h, tool_name, tool_input, tool_result) for h in matching]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for r in results:
            if isinstance(r, HookResult) and r.decision == "deny":
                return r
        for r in results:
            if isinstance(r, HookResult):
                return r
        return None

    async def _exec(
        self,
        hook: HookConfig,
        tool_name: str,
        tool_input: Any,
        tool_result: str = "",
    ) -> HookResult:
        """Execute a single shell-command hook."""
        input_json = json.dumps({
            "tool_name": tool_name,
            "tool_input": serialise_input(tool_input),
            "tool_result": tool_result,
        }, ensure_ascii=False)

        try:
            proc = await asyncio.create_subprocess_shell(
                hook.command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(input_json.encode()),
                timeout=self._timeout,
            )
            stdout = stdout_bytes.decode("utf-8", errors="replace").strip()
            stderr = stderr_bytes.decode("utf-8", errors="replace").strip()

            # Exit code 2 = block
            if proc.returncode == 2:
                return HookResult(decision="deny", reason=stderr or stdout)

            # Try JSON response for decision
            if stdout and stdout.startswith("{"):
                try:
                    data = json.loads(stdout)
                    decision = data.get("decision", "allow")
                    if decision in ("allow", "deny"):
                        return HookResult(
                            decision=decision,
                            reason=data.get("reason", ""),
                            stdout=stdout,
                            stderr=stderr,
                        )
                except json.JSONDecodeError:
                    pass

            return HookResult(decision="allow", stdout=stdout, stderr=stderr)

        except asyncio.TimeoutError:
            return HookResult(decision="allow", reason=f"hook timed out after {self._timeout}s")
        except Exception as e:
            return HookResult(decision="allow", reason=f"hook error: {e}")


def serialise_input(input: Any) -> dict | str:
    """Convert tool input to a JSON-serialisable dict."""
    if hasattr(input, "model_dump"):
        return input.model_dump()
    if isinstance(input, dict):
        return input
    return str(input)
