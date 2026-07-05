"""Subagent system — agent type definitions, tool filtering, and execution.

Each agent type maps to a routing pool (subagent/<type>) so users can
independently score models per agent type via the API pool manager.
"""

from __future__ import annotations

import platform
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable

from wings.agent.loop import AgentContext, AgentLoop
from wings.permissions.pipeline import PermissionPipeline
from wings.permissions.rules import PermissionRules
from wings.query.engine import QueryEngine
from wings.routing.protocol import ModelSelector
from wings.models.registry import ModelRegistry
from wings.tools.base import ToolContext
from wings.tools.registry import ToolRegistry


# -- Agent type definitions ---------------------------------------------------

@dataclass
class AgentTypeSpec:
    """Definition of a subagent type."""

    name: str
    description: str
    tools: list[str] | None = None          # None = all available tools
    disallowed_tools: list[str] = field(default_factory=list)
    read_only: bool = False
    task_type: str = ""                      # routing pool key, e.g. "subagent/explore"


BUILTIN_AGENT_TYPES: dict[str, AgentTypeSpec] = {
    "general": AgentTypeSpec(
        name="general",
        description="General-purpose agent for complex multi-step tasks. Full tool access.",
        tools=None,
        disallowed_tools=["agent"],
        task_type="subagent/general",
    ),
    "explore": AgentTypeSpec(
        name="explore",
        description="Read-only filesearch agent. Fast model, no file edits.",
        tools=["read", "glob", "grep", "skill_view"],
        disallowed_tools=["bash", "write", "edit", "agent"],
        read_only=True,
        task_type="subagent/explore",
    ),
    "plan": AgentTypeSpec(
        name="plan",
        description="Software architect agent. Plans implementations, no file edits.",
        tools=None,
        disallowed_tools=["write", "edit", "agent"],
        read_only=True,
        task_type="subagent/plan",
    ),
}


# -- Tool filtering -----------------------------------------------------------

def _filter_tools_for_agent(
    parent_registry: ToolRegistry,
    spec: AgentTypeSpec,
) -> ToolRegistry:
    """Build a filtered ToolRegistry for a subagent type.

    Never mutates the parent registry — returns a new one so the main
    agent's tool set is unaffected.
    """
    filtered = ToolRegistry()

    if spec.tools is not None:
        # Explicit allowlist — only register those by name
        for name in spec.tools:
            tool = parent_registry.get(name)
            if tool is not None:
                filtered.register(tool)
    else:
        # None = all tools
        for tool in parent_registry.list_all():
            filtered.register(tool)

    # Apply disallowed tools
    if spec.disallowed_tools:
        filtered.filter_denied(spec.disallowed_tools)

    # read_only safety belt — remove any destructive tool
    if spec.read_only:
        for tool in filtered.list_all():
            if not tool.is_read_only(None):
                filtered.filter_denied([tool.name])

    # Always prevent recursion
    filtered.filter_denied(["agent"])

    return filtered


# -- Subagent execution -------------------------------------------------------

def _build_subagent_system_prompt(spec: AgentTypeSpec, working_dir: str) -> str:
    """Build the system prompt for a subagent."""
    env_info = (
        f"Working directory: {working_dir}\n"
        f"Operating system: {platform.system()}\n"
        f"Current date: {datetime.now().strftime('%Y-%m-%d')}"
    )
    return (
        f"{env_info}\n\n"
        f"You are a {spec.name} subagent. {spec.description}\n"
        f"Execute the delegated task faithfully and return a complete result. "
        f"Work autonomously — do not ask the user questions."
    )


def _build_subagent_permission_pipeline(
    filtered_tools: ToolRegistry,
) -> PermissionPipeline:
    """Build a permission pipeline that auto-allows all filtered tools.

    Subagents should not trigger interactive permission prompts — the user
    already approved the agent tool itself. All tools in the filtered
    registry are pre-allowed; anything else is denied.
    """
    rules = PermissionRules()
    for tool in filtered_tools.list_all():
        rules.add_allow(tool.name)
    return PermissionPipeline(rules)


async def run_subagent(
    prompt: str,
    agent_type: str,
    *,
    query_engine: QueryEngine,
    model_registry: ModelRegistry,
    tool_registry: ToolRegistry,
    model_selector: ModelSelector,
    working_dir: str,
    event_callback: Callable[[Any], Awaitable[None]] | None = None,
) -> str:
    """Run a subagent to completion and return the final text output.

    Creates a fresh AgentLoop with filtered tools and an isolated message
    list. Model selection uses the subagent/<type> routing pool.
    """
    # Case-insensitive lookup (model may pass "Explore" instead of "explore")
    agent_type_lower = agent_type.lower().strip()
    spec = BUILTIN_AGENT_TYPES.get(agent_type_lower)
    if spec is None:
        available = ", ".join(sorted(BUILTIN_AGENT_TYPES))
        return f"Error: unknown agent type '{agent_type}'. Available: {available}"

    # Build filtered tool set
    filtered_tools = _filter_tools_for_agent(tool_registry, spec)

    # Build permission pipeline (auto-allow all filtered tools)
    subagent_pipeline = _build_subagent_permission_pipeline(filtered_tools)

    # Build system prompt
    system_prompt = _build_subagent_system_prompt(spec, working_dir)

    # Build context — task_type drives routing via the pool hierarchy
    ctx = AgentContext(
        task_type=spec.task_type,
        model_override=None,  # use pool-based selection
        tool_context=ToolContext(working_dir=working_dir),
        system_prompt=system_prompt,
    )

    # Create fresh AgentLoop (isolated messages, handoff auto-skipped for non-main)
    subagent_loop = AgentLoop(
        query_engine=query_engine,
        tool_registry=filtered_tools,
        permission_pipeline=subagent_pipeline,
        model_selector=model_selector,
        model_registry=model_registry,
    )

    # Run to completion
    final_text = ""
    async for event in subagent_loop.run(prompt, ctx):
        if event_callback:
            await event_callback(event)
        # Collect text deltas into the final result
        if hasattr(event, "text") and event.type == "text_delta":
            final_text += event.text  # type: ignore[attr-defined]

    return final_text.strip()
