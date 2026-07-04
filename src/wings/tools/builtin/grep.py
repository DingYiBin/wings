"""Regular expression content search."""

import re
from pathlib import Path

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool


class GrepInput(BaseModel):
    pattern: str = Field(description="The regular expression pattern to search for")
    path: str | None = Field(
        default=None,
        description="File or directory to search in. Defaults to working directory.",
    )
    glob: str | None = Field(
        default=None,
        description="Glob pattern to filter files, e.g. '*.py'",
    )
    output_mode: str | None = Field(
        default="content",
        description="Output mode: 'content', 'files_with_matches', or 'count'",
    )
    head_limit: int | None = Field(
        default=None,
        description="Limit output to first N lines/entries",
    )


@tool(
    name="grep",
    description="Search file contents using regular expressions",
    search_hint="grep 'pattern'",
    read_only=True,
)
async def grep(input: GrepInput, context: ToolContext) -> str:
    base = Path(input.path) if input.path else Path(context.working_dir)
    if not base.is_absolute():
        base = Path(context.working_dir) / base
    if not base.exists():
        return f"Error: path not found: {base}"

    # Collect files to search
    if base.is_file():
        files = [base]
    else:
        glob_pattern = input.glob or "**/*"
        files = sorted(
            f for f in base.glob(glob_pattern) if f.is_file()
        )

    try:
        regex = re.compile(input.pattern)
    except re.error as e:
        return f"Error: invalid regex: {e}"

    output_lines: list[str] = []
    file_count = 0

    for filepath in files:
        try:
            text = filepath.read_text()
        except (UnicodeDecodeError, OSError):
            continue

        matches = list(regex.finditer(text))
        if not matches:
            continue

        file_count += 1

        if input.output_mode == "files_with_matches":
            output_lines.append(str(filepath))
        elif input.output_mode == "count":
            output_lines.append(f"{str(filepath)}:{len(matches)}")
        else:
            lines = text.split("\n")
            for m in matches:
                line_no = text[:m.start()].count("\n") + 1
                line_text = lines[line_no - 1] if line_no <= len(lines) else ""
                output_lines.append(f"{filepath}:{line_no}: {line_text.strip()}")

        if input.head_limit and len(output_lines) >= input.head_limit:
            output_lines = output_lines[:input.head_limit]
            break

    if not output_lines:
        return "(no matches)"

    if input.head_limit:
        output_lines = output_lines[:input.head_limit]

    return "\n".join(output_lines)
