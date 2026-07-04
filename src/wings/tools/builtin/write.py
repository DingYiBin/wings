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
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(input.content)
    return f"Wrote {len(input.content)} bytes to {path}"
