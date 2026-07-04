"""Tool system — unified interface for all agent capabilities."""

from wings.tools.base import Tool, ToolContext, ToolResult
from wings.tools.registry import ToolRegistry
from wings.tools.decorator import tool

__all__ = [
    "Tool",
    "ToolContext",
    "ToolResult",
    "ToolRegistry",
    "tool",
]
