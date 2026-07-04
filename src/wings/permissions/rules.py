"""Static permission rules — allowlist and denylist matching."""

from __future__ import annotations

from typing import Literal

PermissionResult = Literal["allow", "deny", "ask"]


class PermissionRules:
    """Static allowlist / denylist for tool permissions.

    Stage 1 of the permission pipeline: fast, deterministic matching
    without looking at tool input or context.
    """

    def __init__(
        self,
        allowlist: set[str] | None = None,
        denylist: set[str] | None = None,
        asklist: set[str] | None = None,
    ):
        self.allowlist: set[str] = allowlist or set()
        self.denylist: set[str] = denylist or set()
        self.asklist: set[str] = asklist or set()

    def match(self, tool_name: str) -> PermissionResult:
        """Match a tool name against the rules.

        Priority: denylist > allowlist > asklist > default "ask".
        """
        if tool_name in self.denylist:
            return "deny"
        if tool_name in self.allowlist:
            return "allow"
        if tool_name in self.asklist:
            return "ask"
        return "ask"  # default: ask user

    def add_allow(self, tool_name: str) -> None:
        self.allowlist.add(tool_name)

    def add_deny(self, tool_name: str) -> None:
        self.denylist.add(tool_name)

    def add_ask(self, tool_name: str) -> None:
        self.asklist.add(tool_name)

    @classmethod
    def from_config(cls, config: dict) -> PermissionRules:
        """Create rules from a config dict."""
        return cls(
            allowlist=set(config.get("allowlist", [])),
            denylist=set(config.get("denylist", [])),
            asklist=set(config.get("asklist", [])),
        )
