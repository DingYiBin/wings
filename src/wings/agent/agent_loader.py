"""Custom agent loader — discovers .wings/agents/*.md files.

Format: YAML frontmatter + markdown body (same as SKILL.md).
Custom agents merge on top of built-in types — project agents override
built-in agents with the same name.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from wings.agent.subagent import AgentTypeSpec

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)", re.DOTALL)


def load_custom_agents(project_dir: Path) -> dict[str, AgentTypeSpec]:
    """Discover custom agent definitions from .wings/agents/*.md.

    Returns a dict of agent_name -> AgentTypeSpec. Project-level agents
    take precedence over built-in agents with the same name.
    """
    agents_dir = project_dir / ".wings" / "agents"
    if not agents_dir.is_dir():
        return {}

    custom: dict[str, AgentTypeSpec] = {}
    for md_file in sorted(agents_dir.glob("*.md")):
        spec = _parse_agent_file(md_file)
        if spec is not None:
            custom[spec.name] = spec

    return custom


def _parse_agent_file(path: Path) -> AgentTypeSpec | None:
    """Parse a single .wings/agents/*.md file into an AgentTypeSpec."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None

    m = _FRONTMATTER_RE.match(text)
    if not m:
        return None

    try:
        meta = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return None

    if not isinstance(meta, dict) or "name" not in meta:
        return None

    body = m.group(2).strip()
    description = str(meta.get("description", body[:200] if body else ""))

    # YAML may load tools as list or string
    tools_raw = meta.get("tools")
    if tools_raw is None:
        tools = None  # None = all
    elif isinstance(tools_raw, list):
        tools = [str(t) for t in tools_raw]
    else:
        tools = [t.strip() for t in str(tools_raw).split(",")]

    disallowed_raw = meta.get("disallowed_tools", [])
    if isinstance(disallowed_raw, list):
        disallowed = [str(t) for t in disallowed_raw]
    else:
        disallowed = [t.strip() for t in str(disallowed_raw).split(",")]

    # Always disallow agent tool for custom agents (prevent recursion)
    if "agent" not in disallowed:
        disallowed.append("agent")

    name = str(meta["name"]).lower().strip()
    task_type = f"subagent/{name}"

    return AgentTypeSpec(
        name=name,
        description=description,
        tools=tools,
        disallowed_tools=disallowed,
        read_only=bool(meta.get("read_only", False)),
        task_type=task_type,
    )
