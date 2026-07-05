"""Agent core loop — ties together all modules into a working agent."""

from wings.agent.handoff import HandoffDetector, TurnRecord
from wings.agent.loop import AgentContext, AgentLoop
from wings.agent.subagent import (
    BUILTIN_AGENT_TYPES,
    AgentTypeSpec,
    run_subagent,
)

__all__ = [
    "AgentContext",
    "AgentLoop",
    "AgentTypeSpec",
    "BUILTIN_AGENT_TYPES",
    "HandoffDetector",
    "TurnRecord",
    "run_subagent",
]
