"""Locate the built-in skills directory packaged with wings."""

from __future__ import annotations

from importlib import resources
from pathlib import Path


def builtin_skills_dir() -> Path:
    """Return the path to the built-in skills directory.

    Uses importlib.resources so it works both in development
    (editable install) and after packaging as a wheel.
    """
    # The builtin/ directory is a package subdirectory with SKILL.md files.
    # In a wheel it's regular package data; during dev it's on the filesystem.
    pkg_path = resources.files("wings.skills")
    return Path(pkg_path) / "builtin"
