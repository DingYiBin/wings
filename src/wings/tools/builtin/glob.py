"""Fast file pattern matching."""

from pathlib import Path

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool


class GlobInput(BaseModel):
    pattern: str = Field(description="Glob pattern to match, e.g. '**/*.py'")
    path: str | None = Field(
        default=None,
        description="Directory to search in. Defaults to working directory.",
    )


@tool(
    name="glob",
    description="Find files matching a glob pattern",
    search_hint="glob '**/*.py'",
    read_only=True,
)
async def glob_files(input: GlobInput, context: ToolContext) -> str:
    base = Path(input.path) if input.path else Path(context.working_dir)
    if not base.is_absolute():
        base = Path(context.working_dir) / base
    if not base.exists():
        return f"Error: directory not found: {base}"

    matches = sorted(base.glob(input.pattern))
    if not matches:
        return f"No files matched '{input.pattern}' in {base}"

    label = "file" if len(matches) == 1 else "files"
    lines = [f"Found {len(matches)} {label}"]
    lines.extend(str(m) for m in matches)
    return "\n".join(lines)
