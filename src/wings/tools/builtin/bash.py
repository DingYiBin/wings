"""Execute shell commands."""

import re
import subprocess
import time

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool

# Commands/patterns that are always denied
_DENY_PATTERNS: list[re.Pattern] = [
    # Fork bomb
    re.compile(r":\s*\(\s*\)\s*\{"),
    # Format/wipe disk
    re.compile(r"\bmkfs\."),
    # Direct disk write
    re.compile(r"\bdd\s+if="),
    # Recursive chmod 777 on root
    re.compile(r"\bchmod\s+.*-R\s+777\s+/"),
    # Overwrite disk
    re.compile(r">\s*/dev/sd[a-z]"),
    # Fork bomb variants
    re.compile(r"\(\)\s*\{.*:.*\|.*:.*&.*\}"),
]


def _is_sleep_command(cmd: str) -> bool | None:
    """Return True if the command is a sleep >= 2 seconds."""
    m = re.match(r"^sleep\s+(\d+)", cmd.strip())
    if m:
        return int(m.group(1)) >= 2
    # Also catch decimal sleeps
    m = re.match(r"^sleep\s+(\d+\.?\d*)", cmd.strip())
    if m:
        return float(m.group(1)) >= 2.0
    return None


def _check_denylist(cmd: str) -> str | None:
    """Return an error message if the command matches a deny pattern."""
    for pattern in _DENY_PATTERNS:
        if pattern.search(cmd):
            return f"Error: command denied by security policy (matched: {pattern.pattern})"
    return None


class BashInput(BaseModel):
    command: str = Field(description="The shell command to execute")
    description: str = Field(
        default="",
        description="Short description of what this command does (shown to the user)",
    )
    timeout: int | None = Field(
        default=120000, description="Timeout in milliseconds (max 600000)"
    )


@tool(
    name="bash",
    description="Execute a shell command in the current working directory",
    search_hint="bash 'command'",
    destructive=True,
)
async def bash(input: BashInput, context: ToolContext) -> str:
    cmd = input.command

    # Security checks
    error = _check_denylist(cmd)
    if error:
        return error

    # Block sleep
    if _is_sleep_command(cmd):
        return "Error: sleep is not allowed. Use a non-blocking approach instead."

    timeout_ms = min(input.timeout or 120000, 600000)
    started = time.monotonic()
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout_ms / 1000,
            cwd=context.working_dir,
            env={**context.env} if context.env else None,
        )
    except subprocess.TimeoutExpired:
        elapsed = time.monotonic() - started
        return f"(timeout {timeout_ms / 1000:.0f}s)  ({elapsed:.1f}s)"

    elapsed = time.monotonic() - started
    elapsed_str = f"({elapsed:.1f}s)" if elapsed >= 0.5 else ""

    parts: list[str] = []
    if result.stdout.strip():
        parts.append(result.stdout.rstrip())
    if result.stderr.strip():
        parts.append(result.stderr.rstrip())

    output = "\n".join(parts).strip()
    if not output and result.returncode == 0:
        return "(No output)" if elapsed < 0.5 else f"(No output)  {elapsed_str}"
    if not output:
        output = "(No output)"

    if result.returncode != 0:
        output += f"\n[exit code: {result.returncode}]"
    if elapsed_str:
        output += f"\n{elapsed_str}"
    return output
