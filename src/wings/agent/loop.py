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
    ThinkingDelta,
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
            # Stream phase — collect deltas (real-time) and final blocks
            tool_use_blocks: list[ToolUseBlock] = []
            text_blocks: list[TextBlock] = []
            cycle_tool_calls: list[str] = []

            streamed_text = False  # track if any real-time text was sent

            async for event in self._query_engine.stream(
                self._messages,
                model,
                tools=self._tool_registry.get_schemas(),
                config=cfg,
            ):
                if isinstance(event, (TextDelta, ThinkingDelta)):
                    streamed_text = True
                    yield event
                elif isinstance(event, TextBlock):
                    text_blocks.append(event)
                    if not streamed_text:
                        # API didn't stream deltas — send text from final block
                        yield TextDelta(text=event.text)
                elif isinstance(event, ToolUseBlock):
                    tool_use_blocks.append(event)

            # Log this request/response cycle
            if self._logger is not None:
                self._logger.record_turn(
                    model=model,
                    messages_sent=[m.model_dump() for m in self._messages],
                    response={
                        "content": [
                            b.model_dump() for b in text_blocks + tool_use_blocks  # type: ignore[union-attr]
                        ]
                    },
                    tool_calls=cycle_tool_calls,
                )

            # Execute tools
            if tool_use_blocks:
                assistant_content: list[Any] = list(text_blocks) + list(tool_use_blocks)
                self._messages.append(
                    Message(role=Role.ASSISTANT, content=assistant_content)
                )

                # Collect all tool results into a single user message.
                # Anthropic requires all tool_result blocks for one assistant
                # response to be grouped in the next user message.
                tool_results: list[ToolResultBlock] = []
                for block in tool_use_blocks:
                    tool = self._tool_registry.get(block.name)
                    if tool is None:
                        tool_results.append(ToolResultBlock(
                            tool_use_id=block.id,
                            content=f"unknown tool: {block.name}",
                            is_error=True,
                        ))
                        continue

                    result = await self._permission_pipeline.check(
                        tool, block.input, context.tool_context,
                    )
                    if result == "deny":
                        tool_results.append(ToolResultBlock(
                            tool_use_id=block.id,
                            content="permission denied",
                            is_error=True,
                        ))
                        continue

                    cycle_tool_calls.append(block.name)
                    turn.tool_calls.append(block.name)
                    try:
                        tool_result = await tool.call(block.input, context.tool_context)
                    except Exception as exc:
                        tool_results.append(ToolResultBlock(
                            tool_use_id=block.id,
                            content=f"tool error: {exc}",
                            is_error=True,
                        ))
                        continue
                    tool_results.append(ToolResultBlock(
                        tool_use_id=block.id,
                        content=tool_result.output,
                        is_error=tool_result.error is not None,
                    ))

                self._messages.append(
                    Message(role=Role.USER, content=list(tool_results))
                )

                # Update the log entry with actual tool calls
                if self._logger is not None and cycle_tool_calls:
                    self._logger.record_turn(
                        model=model,
                        messages_sent=[m.model_dump() for m in self._messages],
                        response={"content": [b.model_dump() for b in tool_use_blocks]},
                        tool_calls=cycle_tool_calls,
                    )
                continue  # loop back for next chat call

            # No tools — end turn
            if text_blocks:
                self._messages.append(
                    Message(role=Role.ASSISTANT, content=list(text_blocks))
                )
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

    def _last_assistant_text(self) -> str:
        for msg in reversed(self._messages):
            if msg.role == Role.ASSISTANT:
                texts = [
                    b.text for b in msg.content if isinstance(b, TextBlock)
                ]
                return " ".join(texts)
        return ""
