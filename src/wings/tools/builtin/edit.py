"""Perform exact string replacements in a file."""

from pathlib import Path

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool

_CONTEXT_LINES = 3  # lines of context to show around the change


class EditInput(BaseModel):
    file_path: str = Field(description="Absolute path to the file to edit")
    old_string: str = Field(description="The text to replace")
    new_string: str = Field(description="The text to replace it with (must differ from old_string)")
    replace_all: bool = Field(default=False, description="Replace all occurrences of old_string")


def _diff_hunk(
    lines: list[str],
    start_idx: int,
    old_lines: list[str],
    new_lines: list[str],
) -> str:
    """Build a unified-diff-style hunk showing the old→new change with context."""
    # Context before
    ctx_start = max(0, start_idx - _CONTEXT_LINES)
    ctx_end = min(len(lines), start_idx + len(old_lines) + _CONTEXT_LINES)

    result: list[str] = []
    for i in range(ctx_start, start_idx):
        result.append(f"    {i + 1:>6}  {lines[i].rstrip()}")

    # Removed lines
    for line in old_lines:
        result.append(f"    {start_idx + 1:>6} -{line.rstrip()}")
        start_idx += 1

    # Added lines
    for line in new_lines:
        result.append(f"         +{line.rstrip()}")

    # Context after
    for i in range(start_idx, ctx_end):
        result.append(f"    {i + 1:>6}  {lines[i].rstrip()}")

    return "\n".join(result)


def _describe_change(old: str, new: str) -> str:
    """Short summary of what changed."""
    if not old:
        return f"Added {len(new.splitlines())} line(s)"
    if not new:
        return f"Removed {len(old.splitlines())} line(s)"
    return f"Replaced {len(old.splitlines())} line(s) with {len(new.splitlines())} line(s)"


@tool(
    name="edit",
    description="Perform exact string replacements in an existing file",
    search_hint="edit /path/to/file",
    destructive=True,
)
async def edit_file(input: EditInput, context: ToolContext) -> str:
    if input.old_string == input.new_string:
        return "Error: old_string and new_string must be different"

    path = Path(input.file_path)
    if not path.is_absolute():
        path = Path(context.working_dir) / path
    if not path.exists():
        return f"Error: file not found: {path}"
    if path.is_dir():
        return f"Error: path is a directory: {path}"

    text = path.read_text()
    count = text.count(input.old_string)

    if count == 0:
        return f"Error: old_string not found in {path}"
    if not input.replace_all and count > 1:
        return (
            f"Error: old_string appears {count} times in {path}. "
            f"Use replace_all=True to replace all occurrences, "
            f"or provide more context to make the match unique."
        )

    # Build the diff display
    file_lines = text.split("\n")
    idx = text.index(input.old_string)
    prefix = text[:idx]
    line_start = prefix.count("\n")
    old_lines = input.old_string.split("\n")
    new_lines = input.new_string.split("\n")

    hunk = _diff_hunk(file_lines, line_start, old_lines, new_lines)
    summary = _describe_change(input.old_string, input.new_string)

    new_text = text.replace(input.old_string, input.new_string)
    path.write_text(new_text)
    replaced = count if input.replace_all else 1

    out = [f"{summary} in {path}"]
    if replaced > 1:
        out[0] += f" ({replaced} occurrences)"
    out.append(hunk)
    return "\n".join(out)
