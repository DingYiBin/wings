"""Static permission rules — allowlist and denylist matching.

Supports both tool-level rules (``add_allow("bash")``) and scoped
rules (``add_allow("bash", pattern="git commit:*")``) that match
against specific tool input.
"""

from __future__ import annotations

from typing import Literal

PermissionResult = Literal["allow", "deny", "ask"]


class PermissionRules:
    """Static allowlist / denylist for tool permissions.

    Stage 1 of the permission pipeline: fast, deterministic matching.

    Scoped rules match against tool input:
    - bash: command prefix (e.g. ``git commit:*`` matches ``git commit -m ...``)
    - write/edit: directory prefix (e.g. ``/home/user/project/*``)
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

        # tool_name -> set of scope patterns (e.g. "bash" -> {"git commit:*", "npm:*"})
        self.scoped_allowlist: dict[str, set[str]] = {}

    # -- Tool-level matching --------------------------------------------------

    def match(self, tool_name: str) -> PermissionResult:
        """Match a tool name against the tool-level rules.

        Priority: denylist > allowlist > asklist > default "ask".
        """
        if tool_name in self.denylist:
            return "deny"
        if tool_name in self.allowlist:
            return "allow"
        if tool_name in self.asklist:
            return "ask"
        return "ask"

    # -- Scoped matching ------------------------------------------------------

    def check_scoped(self, tool_name: str, tool_input: dict) -> PermissionResult | None:
        """Check scoped allow rules against tool input.

        Returns "allow" if the input matches a scoped rule, None otherwise.
        """
        patterns = self.scoped_allowlist.get(tool_name)
        if not patterns:
            return None

        target = _extract_scope_target(tool_name, tool_input)
        if target is None:
            return None

        for pattern in patterns:
            if _scope_matches(target, pattern):
                return "allow"
        return None

    # -- Mutation -------------------------------------------------------------

    def add_allow(self, tool_name: str, pattern: str | None = None) -> None:
        """Add an allow rule. With pattern = scoped, without = tool-level."""
        if pattern:
            self.scoped_allowlist.setdefault(tool_name, set()).add(pattern)
        else:
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


# -- Scope helpers ------------------------------------------------------------

def _extract_scope_target(tool_name: str, tool_input: dict) -> str | None:
    """Extract the match target from tool input for scoped rule matching.

    - bash: the command string
    - write/edit/read: the file path
    """
    if tool_name == "bash":
        return tool_input.get("command", "")
    if tool_name in ("write", "edit", "read"):
        return tool_input.get("file_path", "")
    return None


def _scope_matches(target: str, pattern: str) -> bool:
    """Check if a target matches a scope pattern.

    Patterns ending with ``:*`` match by prefix (everything before ``:*``).
    Patterns ending with ``/*`` match by directory prefix.
    Otherwise exact match.
    """
    if pattern.endswith(":*"):
        prefix = pattern[:-2]
        return target == prefix or target.startswith(prefix + " ")
    if pattern.endswith("/*"):
        prefix = pattern[:-2]
        return target.startswith(prefix + "/") or target == prefix
    return target == pattern


def suggest_scope(tool_name: str, tool_input: dict) -> str | None:
    """Generate a suggested scope pattern for the "don't ask again" option.

    - bash: first 1-2 words of command → ``git commit:*`` or ``git:*``
    - write/edit: parent directory → ``/home/user/project/*``
    """
    if tool_name == "bash":
        cmd = tool_input.get("command", "").strip()
        if not cmd:
            return None
        words = cmd.split()
        if len(words) >= 2 and words[1].islower() and words[1].replace("-", "").isalpha():
            # Two-word subcommand like "git commit", "npm run"
            return f"{words[0]} {words[1]}:*"
        return f"{words[0]}:*"

    if tool_name in ("write", "edit"):
        path = tool_input.get("file_path", "")
        if path and "/" in path:
            parent = path.rsplit("/", 1)[0]
            if parent:
                return f"{parent}/*"
        return None

    return None
