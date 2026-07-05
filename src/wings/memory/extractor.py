"""Auto-memory extraction — runs a lightweight subagent after each turn
to save durable memories from the conversation.

Follows claude-code's extractMemories pattern: a forked subagent scans the
conversation and writes topic files + updates MEMORY.md.
"""

from __future__ import annotations

from pathlib import Path

from wings.agent.subagent import AgentTypeSpec, run_subagent
from wings.query.engine import QueryEngine
from wings.models.registry import ModelRegistry
from wings.routing.protocol import ModelSelector
from wings.tools.registry import ToolRegistry

_MEMORY_AGENT_SPEC = AgentTypeSpec(
    name="memory-extractor",
    description="Extracts durable memories from conversations and saves them to .wings/memory/.",
    tools=["write", "edit", "read", "glob", "grep"],
    disallowed_tools=["bash", "agent"],
    read_only=False,
    task_type="subagent/memory",
)

_EXTRACT_PROMPT = """\
Review the conversation above and extract any durable information worth saving
to the memory system at `.wings/memory/`.

Follow the memory system rules you already know:
- 4 types: user, feedback, project, reference
- Write topic files with YAML frontmatter (name, description, type)
- Add pointers to MEMORY.md index
- Do NOT save: code patterns, git history, debug solutions, ephemeral details
- Only save if something NEW and DURABLE was learned

If nothing new was learned that should be saved, respond with "Nothing to save."
and do not write any files."""


async def maybe_extract_memories(
    messages_text: str,
    *,
    working_dir: str,
    query_engine: QueryEngine,
    model_registry: ModelRegistry,
    tool_registry: ToolRegistry,
    model_selector: ModelSelector,
    min_turns_between: int = 5,
) -> str:
    """Run a memory-extraction subagent if enough turns have passed.

    Returns the subagent's output text, or empty string if skipped.
    """
    if not messages_text.strip():
        return ""

    prompt = f"{_EXTRACT_PROMPT}\n\n## Conversation\n\n{messages_text}"
    memory_dir = Path(working_dir) / ".wings" / "memory"
    memory_dir.mkdir(parents=True, exist_ok=True)

    result = await run_subagent(
        prompt=prompt,
        agent_type="memory-extractor",
        query_engine=query_engine,
        model_registry=model_registry,
        tool_registry=tool_registry,
        model_selector=model_selector,
        working_dir=working_dir,
        custom_agents={"memory-extractor": _MEMORY_AGENT_SPEC},
    )
    return result
