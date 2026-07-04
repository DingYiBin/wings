"""Agent core loop — the main conversation cycle.

Ties together model selection, permission checks, tool execution,
handoff detection, and query calls into a single async generator.

Every API call (including tool-use cycles) independently selects a model
from the task-type candidate pool.  This is the core wings differentiator:
users configure pools, and each model invocation is a fresh weighted-random
draw.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from wings.agent.handoff import HandoffDetector, TurnRecord
from wings.messages.types import (
    Message,
    PermissionRequest,
    Role,
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

        # Permission sync — used when the pipeline returns "ask"
        self._perm_event = asyncio.Event()
        self._perm_response: str = "deny"  # default: deny until answered

    # -- Public API ------------------------------------------------------------

    def set_logger(self, logger: Any) -> None:
        """Attach a TurnLogger for request/response recording."""
        self._logger = logger

    def set_permission_response(self, response: str) -> None:
        """Set the user's response to a pending permission request.

        Called by the CLI after the user answers y/n/a.
        Must be one of: "allow", "deny", "allow_always".
        """
        self._perm_response = response
        self._perm_event.set()

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

        Every API call (including after tool execution) performs
        a fresh model selection from the task-type candidate pool.
        """
        self._assemble_messages(user_input, context)

        turn: TurnRecord | None = None

        while True:
            # -- Select model for *this* API call --
            model = self._select_model(context)
            cfg = config or self._model_registry.build_config(model)

            # Record turn from the first cycle's model selection
            if turn is None:
                provider_name, _, service_model = model.partition("/")
                turn = TurnRecord(
                    turn_id=len(self._turn_history),
                    model_id=model,
                    provider_name=provider_name,
                    service_model=service_model,
                    user_input_summary=user_input[:200],
                )

                # Handoff detection (main conversation only).
                # Do this BEFORE adding the turn to history so the
                # detector looks at past turns, not the current one.
                if context.task_type == "main":
                    handoff = self._handoff_detector.detect(model, self._turn_history)
                    if handoff:
                        self._messages.append(
                            Message(role=Role.USER, content=[TextBlock(text=handoff)])
                        )

                self._turn_history.append(turn)

            # Stream phase — collect deltas (real-time) and final blocks
            tool_use_blocks: list[ToolUseBlock] = []
            text_blocks: list[TextBlock] = []
            cycle_tool_calls: list[str] = []
            streamed_text = False

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
                        yield TextDelta(text=event.text)
                elif isinstance(event, ToolUseBlock):
                    tool_use_blocks.append(event)

            # Log this request/response cycle
            if self._logger is not None:
                self._logger.record_cycle(
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
                # Yield tool_use blocks for CLI display
                for block in tool_use_blocks:
                    yield block

                assistant_content: list[Any] = list(text_blocks) + list(tool_use_blocks)
                self._messages.append(
                    Message(role=Role.ASSISTANT, content=assistant_content)
                )

                # Collect all tool results into a single user message.
                # Anthropic requires all tool_result blocks for one assistant
                # response to be grouped in the next user message.
                tool_results: list[ToolResultBlock] = []
                permission_denied = False
                for block in tool_use_blocks:
                    tool = self._tool_registry.get(block.name)
                    if tool is None:
                        tr = ToolResultBlock(
                            tool_use_id=block.id,
                            content=f"unknown tool: {block.name}",
                            is_error=True,
                        )
                        tool_results.append(tr)
                        yield tr
                        continue

                    perm_result = await self._permission_pipeline.check(
                        tool, block.input, context.tool_context,
                    )
                    if perm_result == "deny":
                        tr = ToolResultBlock(
                            tool_use_id=block.id,
                            content="permission denied",
                            is_error=True,
                        )
                        tool_results.append(tr)
                        yield tr
                        continue

                    if perm_result == "ask":
                        # Interactive approval
                        self._perm_event.clear()
                        yield PermissionRequest(
                            tool_name=block.name,
                            tool_input=block.input,
                        )
                        await self._perm_event.wait()
                        response = self._perm_response

                        if response == "allow_always":
                            self._permission_pipeline._rules.add_allow(block.name)
                        elif response == "deny":
                            tr = ToolResultBlock(
                                tool_use_id=block.id,
                                content="permission denied by user",
                                is_error=True,
                            )
                            tool_results.append(tr)
                            yield tr
                            permission_denied = True
                            continue

                    cycle_tool_calls.append(block.name)
                    turn.tool_calls.append(block.name)
                    try:
                        tool_result = await tool.call(block.input, context.tool_context)
                    except Exception as exc:
                        tr = ToolResultBlock(
                            tool_use_id=block.id,
                            content=f"tool error: {exc}",
                            is_error=True,
                        )
                        tool_results.append(tr)
                        yield tr
                        continue
                    tr = ToolResultBlock(
                        tool_use_id=block.id,
                        content=tool_result.output,
                        is_error=tool_result.error is not None,
                    )
                    tool_results.append(tr)
                    yield tr

                self._messages.append(
                    Message(role=Role.USER, content=list(tool_results))
                )

                # Log after tool execution
                if self._logger is not None and cycle_tool_calls:
                    self._logger.record_cycle(
                        model=model,
                        messages_sent=[m.model_dump() for m in self._messages],
                        response={"content": [b.model_dump() for b in tool_use_blocks]},
                        tool_calls=cycle_tool_calls,
                    )

                # If user denied a permission request, stop the turn so the
                # user can decide what to do next instead of letting the
                # model continue with alternatives.
                if permission_denied:
                    turn.summary = "permission denied by user"
                    return

                continue  # loop back for next chat call with fresh model selection

            # No tools — end turn
            if text_blocks:
                self._messages.append(
                    Message(role=Role.ASSISTANT, content=list(text_blocks))
                )
            turn.summary = self._last_assistant_text()[:200]
            # Record the model that actually produced the final answer
            turn.model_id = model
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
