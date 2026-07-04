"""Execute shell commands."""

import subprocess

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool


class BashInput(BaseModel):
    command: str = Field(description="The shell command to execute")
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
    timeout_ms = min(input.timeout or 120000, 600000)
    try:
        result = subprocess.run(
            input.command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout_ms / 1000,
            cwd=context.working_dir,
            env={**context.env} if context.env else None,
        )
    except subprocess.TimeoutExpired:
        return f"Error: command timed out after {timeout_ms}ms"

    output = result.stdout
    if result.stderr:
        output += f"\n[stderr]\n{result.stderr}"
    if result.returncode != 0:
        output += f"\n[exit code: {result.returncode}]"
    return output.strip() or "(no output)"
