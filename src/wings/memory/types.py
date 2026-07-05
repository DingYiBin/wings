"""Memory types — the 4-type taxonomy from claude-code."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class MemoryType(str, Enum):
    """Memory content types matching claude-code's taxonomy."""

    USER = "user"
    FEEDBACK = "feedback"
    PROJECT = "project"
    REFERENCE = "reference"


@dataclass
class MemoryEntry:
    """A parsed memory file entry from MEMORY.md index."""

    title: str
    file: str
    hook: str  # one-line description
