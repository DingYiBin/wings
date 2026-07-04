"""Unified message types used across all model providers.

All model adapters convert their native format to these types so the agent
layer only deals with one message representation.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field


# -- Roles -------------------------------------------------------------------

class Role(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"


# -- Content blocks ----------------------------------------------------------

class TextBlock(BaseModel):
    """Plain text content in a message."""
    type: Literal["text"] = "text"
    text: str


class ToolUseBlock(BaseModel):
    """A tool call requested by the model."""
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: dict[str, Any] = Field(default_factory=dict)


class ToolResultBlock(BaseModel):
    """The result of a tool execution, returned to the model."""
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str
    is_error: bool = False


MessageContent = TextBlock | ToolUseBlock | ToolResultBlock


# -- Message -----------------------------------------------------------------

class Message(BaseModel):
    """A single message in a conversation."""
    role: Role
    content: list[MessageContent]


# -- Streaming events --------------------------------------------------------

class TextDelta(BaseModel):
    """A chunk of streaming text from the model."""
    type: Literal["text_delta"] = "text_delta"
    text: str


class ToolUseDelta(BaseModel):
    """Incremental tool call data from a streaming response."""
    type: Literal["tool_use_delta"] = "tool_use_delta"
    id: str
    name: str | None = None          # only present in the first delta
    input_delta: dict[str, Any] = Field(default_factory=dict)


class ThinkingDelta(BaseModel):
    """A chunk of thinking/reasoning text."""
    type: Literal["thinking_delta"] = "thinking_delta"
    text: str


StreamEvent = TextDelta | ToolUseDelta | ThinkingDelta | TextBlock | ToolUseBlock | ToolResultBlock


# -- Permission ----------------------------------------------------------------

class PermissionRequest(BaseModel):
    """An interactive permission prompt yielded by the agent loop.

    The CLI displays this to the user and responds via
    AgentLoop.set_permission_response().
    """

    type: Literal["permission_request"] = "permission_request"
    tool_name: str
    tool_input: dict[str, Any] = Field(default_factory=dict)
    scope: str | None = None  # suggested scope pattern for "don't ask again"


# -- Stop reason -------------------------------------------------------------

class StopReason(StrEnum):
    END_TURN = "end_turn"
    MAX_TOKENS = "max_tokens"
    TOOL_USE = "tool_use"
    STOP_SEQUENCE = "stop_sequence"
