"""Agent core loop — the main conversation cycle.

Ties together model selection, permission checks, tool execution,
handoff detection, and query calls into a single async generator.

Uses non-streaming chat() for now — tool_use blocks are complete
and executable immediately. Streaming can be layered on later.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from wings.agent.handoff import HandoffDetector, TurnRecord
from wings.messages.types import (
    Message,
    Role,
    StopReason,
    StreamEvent,
    TextBlock,
    TextDelta,
    ToolResultBlock,
    ToolUseBlock,
)
from wings.models.protocol import ModelConfig
from wings.models.registry import ModelRegistry
from wings.permissions.pipeline import PermissionPipeline
from wings.query.engine import QueryEngine
from wings.routing.protocol import ModelSelector
from wings.tools.base import ToolContext
from wings.tools.registry import ToolRegistry


@dataclass
class AgentContext:
    """Per-turn context for an agent run."""

    task_type: str = "main"
    model_override: str | None = None  # /model session lock
    tool_context: ToolContext = field(
        default_factory=lambda: ToolContext(working_dir=".")
    )
    system_prompt: str = ""


class AgentLoop:
    """Main conversation loop for a single agent session.

    One AgentLoop per session. Owns turn history and handoff detection.
    """

    def __init__(
        self,
        query_engine: QueryEngine,
        tool_registry: ToolRegistry,
        permission_pipeline: PermissionPipeline,
        model_selector: ModelSelector,
        model_registry: ModelRegistry,
    ):
        self._query_engine = query_engine
        self._tool_registry = tool_registry
        self._permission_pipeline = permission_pipeline
        self._selector = model_selector
        self._model_registry = model_registry
        self._handoff_detector = HandoffDetector()
        self._turn_history: list[TurnRecord] = []
        self._messages: list[Message] = []
        self._logger: Any = None  # set by set_logger()

    # -- Public API ------------------------------------------------------------

    def set_logger(self, logger: Any) -> None:
        """Attach a TurnLogger for request/response recording."""
        self._logger = logger

    async def run(
        self,
        user_input: str,
        context: AgentContext,
        config: ModelConfig | None = None,
    ) -> AsyncIterator[StreamEvent]:
        """Run one turn of the agent loop.

        Yields TextDelta events for assistant output. Tool execution
        is transparent — results are injected into the message list
        and the loop continues until end_turn.
        """
        model = self._select_model(context)
        self._assemble_messages(user_input, context)

        # Handoff detection (main conversation only)
        if context.task_type == "main":
            handoff = self._handoff_detector.detect(model, self._turn_history)
            if handoff:
                self._messages.append(
                    Message(role=Role.USER, content=[TextBlock(text=handoff)])
                )

        # Record turn
        provider_name, _, service_model = model.partition("/")
        turn = TurnRecord(
            turn_id=len(self._turn_history),
            model_id=model,
            provider_name=provider_name,
            service_model=service_model,
            user_input_summary=user_input[:200],
        )
        self._turn_history.append(turn)

        cfg = config or self._model_registry.build_config(model)

        while True:
            response = await self._query_engine.chat(
                self._messages,
                model,
                tools=self._tool_registry.get_schemas(),
                config=cfg,
            )

            had_tool_use = False
            cycle_tool_calls: list[str] = []
            assistant_content: list[Any] = []

            for block in response.content:
                if isinstance(block, TextBlock):
                    assistant_content.append(block)
                    yield TextDelta(text=block.text)
                elif isinstance(block, ToolUseBlock):
                    assistant_content.append(block)
                    had_tool_use = True

                    tool = self._tool_registry.get(block.name)
                    if tool is None:
                        self._inject_error(block.id, f"unknown tool: {block.name}")
                        break

                    result = await self._permission_pipeline.check(
                        tool, block.input, context.tool_context,
                    )
                    if result == "deny":
                        self._inject_error(block.id, "permission denied")
                        break

                    cycle_tool_calls.append(block.name)
                    turn.tool_calls.append(block.name)
                    tool_result = await tool.call(block.input, context.tool_context)
                    self._messages.append(
                        Message(
                            role=Role.USER,
                            content=[
                                ToolResultBlock(
                                    tool_use_id=block.id,
                                    content=tool_result.output,
                                    is_error=tool_result.error is not None,
                                )
                            ],
                        )
                    )

            # Log this request/response cycle
            if self._logger is not None:
                self._logger.record_turn(
                    model=model,
                    messages_sent=[m.model_dump() for m in self._messages],
                    response=response.model_dump(),
                    tool_calls=cycle_tool_calls,
                )

            # Record assistant message
            if assistant_content:
                self._messages.append(
                    Message(role=Role.ASSISTANT, content=assistant_content)
                )

            if not had_tool_use:
                turn.summary = self._last_assistant_text()[:200]
                return  # end_turn

    # -- Internal helpers ------------------------------------------------------

    @property
    def last_model(self) -> str:
        """Return the api_id used in the most recent turn, or ''."""
        if self._turn_history:
            return self._turn_history[-1].model_id
        return ""

    def _select_model(self, context: AgentContext) -> str:
        return self._selector.select(context.task_type, context.model_override)

    def _assemble_messages(self, user_input: str, context: AgentContext) -> None:
        if context.system_prompt and not self._messages:
            self._messages.append(
                Message(role=Role.SYSTEM, content=[TextBlock(text=context.system_prompt)])
            )
        self._messages.append(
            Message(role=Role.USER, content=[TextBlock(text=user_input)])
        )

    def _inject_error(self, tool_use_id: str, error: str) -> None:
        self._messages.append(
            Message(
                role=Role.USER,
                content=[
                    ToolResultBlock(
                        tool_use_id=tool_use_id, content=error, is_error=True
                    )
                ],
            )
        )

    def _last_assistant_text(self) -> str:
        for msg in reversed(self._messages):
            if msg.role == Role.ASSISTANT:
                texts = [
                    b.text for b in msg.content if isinstance(b, TextBlock)
                ]
                return " ".join(texts)
        return ""
