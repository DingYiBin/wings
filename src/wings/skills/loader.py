"""Skill loader — discovers and parses SKILL.md files from disk."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

from wings.skills.types import SkillSpec

_MAX_FILE_SIZE = 256 * 1024  # 256 KB


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Extract YAML frontmatter and body from SKILL.md content.

    Returns (frontmatter_dict, body_text).
    """
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not m:
        return {}, text
    raw = m.group(1)
    body = text[m.end():]
    try:
        fm = yaml.safe_load(raw) or {}
    except yaml.YAMLError:
        return {}, text
    return fm if isinstance(fm, dict) else {}, body


def _parse_skill_file(path: Path) -> SkillSpec | None:
    """Parse a single SKILL.md file into a SkillSpec.

    Returns None if the file is too large, unreadable, or missing
    a 'name' field in the frontmatter.
    """
    try:
        stat = path.stat()
        if stat.st_size > _MAX_FILE_SIZE:
            return None
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    fm, body = _parse_frontmatter(text)
    name = fm.get("name", "").strip()
    if not name:
        return None

    return SkillSpec(
        name=name,
        description=fm.get("description", "").strip(),
        content=body.strip(),
        path=path.parent,
        user_invocable=fm.get("user-invocable", True),
        disable_model_invocation=fm.get("disable-model-invocation", False),
        source=fm.get("source", "user"),
    )


def _discover_skills(root: Path, source: str) -> dict[str, SkillSpec]:
    """Discover skills in a directory.

    Each skill is a subdirectory containing a SKILL.md file.
    Dot-prefixed directories are skipped.
    """
    if not root.is_dir():
        return {}

    result: dict[str, SkillSpec] = {}
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        skill_md = entry / "SKILL.md"
        if skill_md.is_file():
            spec = _parse_skill_file(skill_md)
            if spec is not None:
                spec.source = source
                result[spec.name] = spec
    return result


class SkillLoader:
    """Discovers and loads skills from three layers.

    Layer precedence (low to high): builtin < user < project.
    A skill with the same name in a higher layer overrides the lower.
    """

    def __init__(
        self,
        user_dir: Path | None = None,
        project_dir: Path | None = None,
        builtin_dir: Path | None = None,
    ):
        self._user_dir = user_dir
        self._project_dir = project_dir
        self._builtin_dir = builtin_dir
        self._skills: dict[str, SkillSpec] = {}
        self._loaded = False

    def load_all(self) -> list[SkillSpec]:
        """Load skills from all layers. Cached after first call."""
        if self._loaded:
            return list(self._skills.values())

        merged: dict[str, SkillSpec] = {}

        # Builtin layer (lowest precedence) — SKILL.md files in package
        if self._builtin_dir is not None:
            for name, spec in _discover_skills(self._builtin_dir, "builtin").items():
                merged[name] = spec

        # User layer (~/.wings/skills/)
        if self._user_dir is not None:
            for name, spec in _discover_skills(self._user_dir, "user").items():
                merged[name] = spec

        # Project layer (.wings/skills/) — highest precedence
        if self._project_dir is not None:
            for name, spec in _discover_skills(self._project_dir, "project").items():
                merged[name] = spec

        self._skills = merged
        self._loaded = True
        return list(self._skills.values())

    def get_by_name(self, name: str) -> SkillSpec | None:
        """Look up a skill by name."""
        self.load_all()
        return self._skills.get(name)

    def list_model_visible(self) -> list[SkillSpec]:
        """Skills the model can see (excludes disable_model_invocation)."""
        self.load_all()
        return [s for s in self._skills.values() if not s.disable_model_invocation]

    def list_user_invocable(self) -> list[SkillSpec]:
        """Skills the user can invoke with /<name>."""
        self.load_all()
        return [s for s in self._skills.values() if s.user_invocable]
