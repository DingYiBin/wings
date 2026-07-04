"""Perform exact string replacements in a file."""

from pathlib import Path

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool


class EditInput(BaseModel):
    file_path: str = Field(description="Absolute path to the file to edit")
    old_string: str = Field(description="The text to replace")
    new_string: str = Field(description="The text to replace it with (must differ from old_string)")
    replace_all: bool = Field(default=False, description="Replace all occurrences of old_string")


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

    new_text = text.replace(input.old_string, input.new_string)
    path.write_text(new_text)
    replaced = count if input.replace_all else 1
    return f"Edit applied to {path}: {replaced} occurrence(s) replaced"
