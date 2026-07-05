"""Hook type definitions."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class HookConfig:
    """Configuration for a single hook."""

    command: str
    matcher: str | None = None  # regex to match tool name (None = match all)


@dataclass
class HookResult:
    """Result of running a hook."""

    decision: str = "allow"  # "allow" | "deny"
    reason: str = ""
    stdout: str = ""
    stderr: str = ""
