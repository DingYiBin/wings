"""Read a file from the local filesystem."""

from pathlib import Path

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool


class ReadInput(BaseModel):
    file_path: str = Field(description="Absolute path to the file to read")
    offset: int | None = Field(default=None, description="Line number to start reading from (1-based)")
    limit: int | None = Field(default=None, description="Maximum number of lines to read")


@tool(
    name="read",
    description="Read a file from the local filesystem",
    search_hint="read /path/to/file",
    read_only=True,
)
async def read_file(input: ReadInput, context: ToolContext) -> str:
    path = Path(input.file_path)
    if not path.is_absolute():
        path = Path(context.working_dir) / path
    if not path.exists():
        return f"Error: file not found: {path}"
    if path.is_dir():
        return f"Error: path is a directory: {path}"
    try:
        text = path.read_text()
    except UnicodeDecodeError:
        return f"Error: cannot read binary file: {path}"
    lines = text.split("\n")
    start = (input.offset or 1) - 1
    end = start + input.limit if input.limit else len(lines)
    selected = lines[start:end]
    result = [f"{i}\t{line}" for i, line in enumerate(selected, start=start + 1)]
    return "\n".join(result)
