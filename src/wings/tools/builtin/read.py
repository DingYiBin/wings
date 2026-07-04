"""Read a file from the local filesystem."""

import os
from pathlib import Path

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool

_MAX_SAMPLE = 8192  # bytes to read for binary detection

# Paths that should never be read (device files, etc.)
_BLOCKED_DEVICE_PATHS = frozenset({
    "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full",
    "/dev/stdin", "/dev/stdout", "/dev/stderr",
    "/dev/tty", "/dev/console",
})

# Block /dev/fd/0, /dev/fd/1, /dev/fd/2
_BLOCKED_FD_PREFIXES = ("/dev/fd/",)

# Block /proc/.../fd/0, /proc/.../fd/1, /proc/.../fd/2
_BLOCKED_PROC_FD_SUFFIXES = ("fd/0", "fd/1", "fd/2")

# Extensions that indicate binary (non-text) files
_BINARY_EXTENSIONS = frozenset({
    ".7z", ".bin", ".bz2", ".dmg", ".exe", ".gz", ".o",
    ".rar", ".tar", ".zip", ".xz", ".lz", ".lz4", ".zst",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
    ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac",
    ".pdf", ".pyc", ".pyo", ".so", ".class", ".jar",
    ".ttf", ".otf", ".woff", ".woff2",
    ".xlsx", ".docx", ".pptx",
})


class ReadInput(BaseModel):
    file_path: str = Field(description="Absolute path to the file to read")
    offset: int | None = Field(
        default=None, description="Line number to start reading from (1-based)"
    )
    limit: int | None = Field(
        default=None, description="Maximum number of lines to read"
    )


def _is_blocked_device(path: str) -> bool:
    """Check if the path points to a blocked device or proc fd."""
    if path in _BLOCKED_DEVICE_PATHS:
        return True
    for prefix in _BLOCKED_FD_PREFIXES:
        if path.startswith(prefix) and path[len(prefix):] in ("0", "1", "2"):
            return True
    # /proc/PID/fd/0-2
    if "/proc/" in path:
        for suffix in _BLOCKED_PROC_FD_SUFFIXES:
            if path.endswith("/" + suffix):
                return True
    return False


def _is_binary_by_extension(path: str) -> bool:
    suffix = Path(path).suffix.lower()
    return suffix in _BINARY_EXTENSIONS


def _is_binary_by_content(path: str) -> bool:
    """Check if a file contains NUL bytes (strong indicator of binary)."""
    try:
        with open(path, "rb") as f:
            sample = f.read(_MAX_SAMPLE)
        return b"\x00" in sample
    except OSError:
        return False


@tool(
    name="read",
    description="Read a file from the local filesystem. Supports text files only.",
    search_hint="read /path/to/file",
    read_only=True,
)
async def read_file(input: ReadInput, context: ToolContext) -> str:
    path = Path(input.file_path)
    if not path.is_absolute():
        path = Path(context.working_dir) / path

    path_str = str(path)

    # Block device paths
    if _is_blocked_device(path_str):
        return f"Error: cannot read device path: {path}"

    # Check for directory
    if path.is_dir():
        return f"Error: path is a directory: {path}"

    if not path.exists():
        return f"Error: file not found: {path}"

    # Binary detection — extension first (fast), then content (accurate)
    if _is_binary_by_extension(path_str):
        return f"Error: cannot read binary file (by extension): {path}"
    if _is_binary_by_content(path_str):
        return f"Error: cannot read binary file: {path}"

    try:
        text = path.read_text()
    except UnicodeDecodeError:
        return f"Error: cannot read binary file: {path}"

    # Track this read in the context for stale-write detection
    mtime = os.path.getmtime(path_str)
    context.read_cache[path_str] = mtime

    lines = text.split("\n")
    start = (input.offset or 1) - 1
    end = start + input.limit if input.limit else len(lines)
    selected = lines[start:end]
    result = [f"{i}\t{line}" for i, line in enumerate(selected, start=start + 1)]
    return "\n".join(result)
