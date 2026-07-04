"""Skill injector — adds available skills to the system prompt."""

from __future__ import annotations

from xml.sax.saxutils import escape as xml_escape

from wings.skills.types import SkillSpec


class SkillInjector:
    """Injects available skill names and descriptions into the system prompt.

    The model sees an <available_skills> XML block it can use to
    decide whether to call skill_view() for a particular skill.
    """

    def inject_skills(
        self,
        system_prompt: str,
        skills: list[SkillSpec],
    ) -> str:
        """Append an <available_skills> block to the system prompt."""
        visible = [s for s in skills if not s.disable_model_invocation]
        if not visible:
            return system_prompt

        block = self._build_skills_block(visible)
        return f"{system_prompt}\n\n{block}"

    def _build_skills_block(self, skills: list[SkillSpec]) -> str:
        lines = [
            "## Skills",
            "Skills are optional task playbooks. Use them only when a listed entry",
            "clearly matches the user's current request.",
            "Call skill_view(name=\"<skill_name>\") to load a skill's full instructions,",
            "then use only the tools available in this session.",
            "When no entry is relevant, answer without loading a skill.",
            "",
            "<available_skills>",
        ]
        for s in skills:
            lines.append("  <skill>")
            lines.append(f"    <name>{xml_escape(s.name)}</name>")
            lines.append(f"    <description>{xml_escape(s.description)}</description>")
            lines.append("  </skill>")
        lines.append("</available_skills>")
        return "\n".join(lines)
