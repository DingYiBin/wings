"""Skills module — reusable prompt templates with per-skill API pools."""

from wings.skills.types import SkillSpec
from wings.skills.loader import SkillLoader
from wings.skills.injector import SkillInjector

__all__ = ["SkillSpec", "SkillLoader", "SkillInjector"]
