"""Skill data types."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class SkillSpec:
    """Parsed skill definition from a SKILL.md file.

    The content is the markdown body after the YAML frontmatter.
    It gets injected into the conversation when the skill is invoked.
    """

    name: str
    description: str
    content: str
    path: Path | None = None
    user_invocable: bool = True
    disable_model_invocation: bool = False
    source: str = "user"  # "builtin" | "project" | "user"
