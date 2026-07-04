"""Create or overwrite a file."""

import os
from pathlib import Path

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool


class WriteInput(BaseModel):
    file_path: str = Field(description="Absolute path to the file to write")
    content: str = Field(description="Content to write to the file")


def _lines_changed(old: str, new: str) -> str:
    """Build a diff summary for an update."""
    old_lines = old.split("\n")
    new_lines = new.split("\n")

    added = max(0, len(new_lines) - len(old_lines))
    removed = max(0, len(old_lines) - len(new_lines))

    parts = []
    if added:
        parts.append(f"Added {added} line{'s' if added != 1 else ''}")
    if removed:
        caps = "Removed" if not added else "removed"
        parts.append(f"{caps} {removed} line{'s' if removed != 1 else ''}")
    if not parts:
        parts.append("Content replaced")

    return ", ".join(parts)


@tool(
    name="write",
    description="Create or overwrite a file with the given content",
    search_hint="write /path/to/file",
    destructive=True,
)
async def write_file(input: WriteInput, context: ToolContext) -> str:
    path = Path(input.file_path)
    if not path.is_absolute():
        path = Path(context.working_dir) / path

    path_str = str(path)
    existed = path.exists()

    # Stale detection for existing files
    if existed:
        cached_mtime = context.read_cache.get(path_str)
        if cached_mtime is None:
            return (
                f"Error: must read {path} before writing to it. "
                f"Use the read tool first."
            )
        current_mtime = os.path.getmtime(path_str)
        if current_mtime > cached_mtime:
            return (
                f"Error: {path} was modified since last read "
                f"(cached: {cached_mtime}, current: {current_mtime}). "
                f"Re-read the file and try again."
            )

    old_text = path.read_text() if existed else ""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(input.content)

    # Update read cache so the file is "fresh" after write
    context.read_cache[path_str] = os.path.getmtime(path_str)

    new_lines = input.content.split("\n")
    line_count = len(new_lines)

    if not existed:
        # New file — show first lines as preview with + prefix
        result = [f"Wrote {line_count} line{'s' if line_count != 1 else ''} to {path}"]
        preview = min(line_count, 10)
        for line in new_lines[:preview]:
            result.append(f"         +{line.rstrip()}")
        if line_count > preview:
            result.append(f"    \u2026 +{line_count - preview} lines")
        return "\n".join(result)

    # Update — show summary + diff-like preview
    summary = _lines_changed(old_text, input.content)
    result = [f"{summary}", f"(in {path})"]

    # Show a diff-like view: new lines with + where different
    old_lines = old_text.split("\n")
    max_show = min(max(len(old_lines), line_count), 30)
    changed = 0
    for i in range(max_show):
        old = old_lines[i].rstrip() if i < len(old_lines) else ""
        new = new_lines[i].rstrip() if i < line_count else ""
        if old != new:
            if old:
                result.append(f"    {i + 1:>6} -{old}")
            if new:
                result.append(f"    {i + 1:>6} +{new}")
            changed += 1
        else:
            if changed > 0:
                result.append(f"    {i + 1:>6}  {old}")
    if max(line_count, len(old_lines)) > max_show:
        result.append(f"    \u2026 ({max(line_count, len(old_lines)) - max_show} more lines)")

    return "\n".join(result)
