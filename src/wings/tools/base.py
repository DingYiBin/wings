"""Tool protocol — every capability implements this interface."""

from __future__ import annotations

from typing import Any, Protocol

from pydantic import BaseModel, Field


class ToolResult(BaseModel):
    """Result of a tool execution."""

    output: str
    error: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    max_result_size_chars: int | None = None  # Write to file if exceeded


class ToolContext(BaseModel):
    """Execution context passed to every tool call."""

    working_dir: str
    env: dict[str, str] = Field(default_factory=dict)
    session_id: str = ""
    available_skills: dict[str, str] = Field(default_factory=dict)


class Tool(Protocol):
    """Protocol every tool must implement.

    All capabilities — file I/O, shell, search, sub-agents —
    use the same interface so permissions and execution are unified.
    """

    name: str
    description: str
    search_hint: str

    def input_schema(self) -> dict[str, Any]:
        """Return the JSON Schema for this tool's input parameters."""
        ...

    async def call(self, input: Any, context: ToolContext) -> ToolResult:
        """Execute the tool with the given input and context."""
        ...

    def is_enabled(self) -> bool:
        """Whether this tool is currently available."""
        ...

    def is_read_only(self, input: Any) -> bool:
        """Whether this specific invocation is read-only."""
        ...

    def is_destructive(self, input: Any) -> bool:
        """Whether this specific invocation is destructive."""
        ...

    def render_result(self, result: ToolResult) -> str:
        """Format the tool result for display."""
        ...

    def activity_description(self, input: Any) -> str:
        """Short description shown in the spinner."""
        ...
