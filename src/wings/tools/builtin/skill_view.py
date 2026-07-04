"""skill_view tool — lets the model load a skill's full instructions by name."""

from pydantic import BaseModel, Field

from wings.tools.base import ToolContext
from wings.tools.decorator import tool


class SkillViewInput(BaseModel):
    """Input for the skill_view tool."""

    name: str = Field(description="Name of the skill to view, e.g. 'commit'")


@tool(
    name="skill_view",
    description=(
        "Load a skill's full instructions by name. "
        "Call this when a listed skill matches the user's request, "
        "then follow its instructions."
    ),
    search_hint="skill_view name=commit",
    read_only=True,
)
async def skill_view(input: SkillViewInput, context: ToolContext) -> str:
    """Return the full markdown content of the named skill."""
    skills = context.available_skills
    content = skills.get(input.name)
    if content is None:
        available = ", ".join(sorted(skills.keys())) if skills else "(none)"
        return f"Error: skill '{input.name}' not found. Available skills: {available}"
    return content
