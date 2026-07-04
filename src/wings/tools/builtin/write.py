"""Create or overwrite a file."""

from pathlib import Path

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool


class WriteInput(BaseModel):
    file_path: str = Field(description="Absolute path to the file to write")
    content: str = Field(description="Content to write to the file")


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

    existed = path.exists()
    old_text = path.read_text() if existed else ""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(input.content)

    action = "Updated" if existed else "Created"
    lines = input.content.split("\n")
    line_count = len(lines)

    if not existed:
        # Show all lines as added
        result = [f"{action} {path} ({line_count} line(s))"]
        for line in lines[:30]:
            result.append(f"         +{line.rstrip()}")
        if len(lines) > 30:
            result.append(f"         ... ({len(lines) - 30} more lines)")
        return "\n".join(result)

    # For updates, show summary + changed line count
    old_lines = old_text.split("\n")
    added = max(0, line_count - len(old_lines))
    removed = max(0, len(old_lines) - line_count)
    parts = []
    if added:
        parts.append(f"+{added} line(s)")
    if removed:
        parts.append(f"-{removed} line(s)")
    change_desc = ", ".join(parts) if parts else "content replaced"

    return f"{action} {path}: {change_desc} ({line_count} lines)"
