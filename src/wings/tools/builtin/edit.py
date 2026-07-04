"""Perform exact string replacements in a file."""

import os
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
    """Build a unified-diff-style hunk matching claude-code format.

    Shows the hunk header (@@ -start,len +start,len @@), context lines
    with line numbers, removed lines (-) and added lines (+).
    """
    old_len = len(old_lines)
    new_len = len(new_lines)

    ctx_start = max(0, start_idx - _CONTEXT_LINES)
    ctx_end = min(len(lines), start_idx + old_len + _CONTEXT_LINES)

    # Hunk header
    result = [f"    @@ -{start_idx + 1},{old_len} +{start_idx + 1},{new_len} @@"]

    # Context before
    for i in range(ctx_start, start_idx):
        result.append(f"    {i + 1:>6}  {lines[i].rstrip()}")

    # Removed lines (keep original file line numbers)
    for offset, line in enumerate(old_lines):
        result.append(f"    {start_idx + 1 + offset:>6} -{line.rstrip()}")

    # Added lines
    for line in new_lines:
        result.append(f"         +{line.rstrip()}")

    # Context after
    after_start = start_idx + old_len
    for i in range(after_start, ctx_end):
        result.append(f"    {i + 1:>6}  {lines[i].rstrip()}")

    return "\n".join(result)


def _summary(added: int, removed: int, replaced: int = 1) -> str:
    """Build a summary line like claude-code: 'Added 5 lines, Removed 3 lines'."""
    parts = []
    if added:
        parts.append(f"Added {added} line{'s' if added != 1 else ''}")
    if removed:
        caps = "Removed" if not added else "removed"
        parts.append(f"{caps} {removed} line{'s' if removed != 1 else ''}")
    if not parts:
        parts.append("No changes")
    summary = ", ".join(parts)
    if replaced > 1:
        summary += f" ({replaced} occurrences)"
    return summary


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

    path_str = str(path)

    if not path.exists():
        return f"Error: file not found: {path}"
    if path.is_dir():
        return f"Error: path is a directory: {path}"

    # Stale detection
    cached_mtime = context.read_cache.get(path_str)
    if cached_mtime is None:
        return (
            f"Error: must read {path} before editing it. "
            f"Use the read tool first."
        )
    current_mtime = os.path.getmtime(path_str)
    if current_mtime > cached_mtime:
        return (
            f"Error: {path} was modified since last read "
            f"(cached: {cached_mtime}, current: {current_mtime}). "
            f"Re-read the file and try again."
        )

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
    added = len(new_lines) - len(old_lines)
    removed = len(old_lines) - len(new_lines) if len(old_lines) > len(new_lines) else len(old_lines)
    if input.old_string == "":
        added = len(new_lines)
        removed = 0
    elif input.new_string == "":
        added = 0
        removed = len(old_lines)
    else:
        added = len(new_lines)
        removed = len(old_lines)
    summary = _summary(added=added, removed=removed, replaced=count if input.replace_all else 1)

    new_text = text.replace(input.old_string, input.new_string)
    path.write_text(new_text)

    # Update read cache
    context.read_cache[path_str] = os.path.getmtime(path_str)

    out = [f"{summary}", f"(in {path})", hunk]
    return "\n".join(out)
