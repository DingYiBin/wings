"""Agent tool — launch a subagent to handle complex multi-step tasks.

Usage:
    from wings.tools.builtin.agent import make_agent_tool

    agent_tool = make_agent_tool(engine, registry, tools, pool_mgr, rules)
    tools.register(agent_tool)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from wings.agent.subagent import BUILTIN_AGENT_TYPES, run_subagent
from wings.tools.base import Tool, ToolContext, ToolResult
from wings.tools.decorator import tool

if TYPE_CHECKING:
    from wings.query.engine import QueryEngine
    from wings.models.registry import ModelRegistry
    from wings.routing.protocol import ModelSelector
    from wings.tools.registry import ToolRegistry
    from wings.permissions.rules import PermissionRules


class AgentInput(BaseModel):
    """Input schema for the agent tool."""

    description: str = Field(
        description="Short (3-5 word) description of the task",
    )
    prompt: str = Field(
        description="The task for the agent to perform",
    )
    subagent_type: str = Field(
        default="general",
        description="Type of agent to use: general, explore, or plan",
    )


def make_agent_tool(
    query_engine: QueryEngine,
    model_registry: ModelRegistry,
    tool_registry: ToolRegistry,
    model_selector: ModelSelector,
    permission_rules: PermissionRules,
) -> Tool:
    """Create the agent tool with captured dependencies.

    Uses a factory function (closure) for dependency injection — the tool
    needs references to query_engine, registry, etc. but the @tool decorator
    only receives ToolContext at call time.
    """

    @tool(
        name="agent",
        description=(
            "Launch a new agent to handle complex, multi-step tasks autonomously.\n"
            "\n"
            "The Agent tool launches specialized agents (subprocesses) that "
            "autonomously handle complex tasks. Each agent type has specific "
            "capabilities and tools available to it.\n"
            "\n"
            "Available agent types and the tools they have access to:\n"
            "- general: General-purpose agent for researching complex "
            "questions, searching for code, and executing multi-step tasks. "
            "When you are searching for a keyword or file and are not confident "
            "that you will find the right match in the first few tries use this "
            "agent to perform the search for you. (Tools: *)\n"
            "- explore: Fast agent specialized for exploring codebases. Use this "
            "when you need to quickly find files by patterns (eg. "
            "\"src/components/**/*.tsx\"), search code for keywords (eg. \"API "
            "endpoints\"), or answer questions about the codebase (eg. \"how do "
            "API endpoints work?\"). (Tools: Read, Glob, Grep, SkillView)\n"
            "- plan: Software architect agent for designing implementation plans. "
            "Use this when you need to plan the implementation strategy for a "
            "task. Returns step-by-step plans, identifies critical files, and "
            "considers architectural trade-offs. (Tools: all except Write, Edit, "
            "Agent)\n"
            "\n"
            "When using the Agent tool, specify a subagent_type parameter to "
            "select which agent type to use. If omitted, the general "
            "agent is used.\n"
            "\n"
            "When NOT to use the Agent tool:\n"
            "- If you want to read a specific file path, use the Read tool or "
            "the Glob tool instead of the Agent tool, to find the match more "
            "quickly\n"
            "- If you are searching for a specific class definition like "
            "\"class Foo\", use the Glob tool instead, to find the match more "
            "quickly\n"
            "- If you are searching for code within a specific file or set of "
            "2-3 files, use the Read tool instead of the Agent tool, to find "
            "the match more quickly\n"
            "- Other tasks that are not related to the agent descriptions above\n"
            "\n"
            "Usage notes:\n"
            "- Launch multiple agents concurrently whenever possible, to "
            "maximize performance; to do that, use a single message with "
            "multiple tool uses\n"
            "- When the agent is done, it will return a single message back to "
            "you. The result returned by the agent is not visible to the user. "
            "To show the user the result, you should send a text message back "
            "to the user with a concise summary of the result.\n"
            "- Each Agent invocation starts fresh — provide a complete task "
            "description. The agent has no knowledge of the current "
            "conversation.\n"
            "- Clearly tell the agent whether you expect it to write code or "
            "just to do research (search, file reads, etc.), since it is not "
            "aware of the user's intent\n"
            "- The agent's outputs should generally be trusted\n"
            "- If the agent description mentions that it should be used "
            "proactively, then you should try your best to use it without the "
            "user having to ask for it first. Use your judgement."
        ),
        read_only=False,
        search_hint="agent description='search auth patterns' subagent_type=explore",
    )
    async def agent(input: AgentInput, context: ToolContext) -> str:
        agent_type = input.subagent_type.lower().strip()
        spec = BUILTIN_AGENT_TYPES.get(agent_type)
        if spec is None:
            available = ", ".join(sorted(BUILTIN_AGENT_TYPES))
            return f"Error: unknown agent type '{input.subagent_type}'. Available: {available}"

        return await run_subagent(
            prompt=input.prompt,
            agent_type=agent_type,
            query_engine=query_engine,
            model_registry=model_registry,
            tool_registry=tool_registry,
            model_selector=model_selector,
            working_dir=context.working_dir,
            event_callback=context.event_callback,
        )

    return agent
