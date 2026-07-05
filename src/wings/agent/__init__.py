"""Agent core loop — ties together all modules into a working agent."""

from wings.agent.agent_loader import load_custom_agents
from wings.agent.handoff import HandoffDetector, TurnRecord
from wings.agent.loop import AgentContext, AgentLoop
from wings.agent.subagent import (
    BUILTIN_AGENT_TYPES,
    AgentTypeSpec,
    get_agent_types,
    run_subagent,
)

__all__ = [
    "AgentContext",
    "AgentLoop",
    "AgentTypeSpec",
    "BUILTIN_AGENT_TYPES",
    "HandoffDetector",
    "TurnRecord",
    "get_agent_types",
    "load_custom_agents",
    "run_subagent",
]
