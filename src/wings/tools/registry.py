"""Tool registry — central catalogue of all available tools."""

from __future__ import annotations

from typing import Any

from wings.tools.base import Tool


class ToolRegistry:
    """Registry of all tools available to the agent.

    Tools are registered by name and can be filtered by enabled state
    and deny lists. The registry also generates the tool schemas that
    are sent to the LLM.
    """

    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        """Register a tool. Overwrites if the name already exists."""
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        """Look up a tool by name."""
        return self._tools.get(name)

    def list_all(self) -> list[Tool]:
        """Return all registered tools."""
        return list(self._tools.values())

    def list_enabled(self) -> list[Tool]:
        """Return only enabled tools."""
        return [t for t in self._tools.values() if t.is_enabled()]

    def get_schemas(self) -> list[dict[str, Any]]:
        """Generate tool schemas to send to the LLM.

        Only enabled tools are included. Each schema includes name,
        description, and JSON Schema input_schema.
        """
        schemas: list[dict[str, Any]] = []
        for tool in self.list_enabled():
            schemas.append({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema(),
            })
        return schemas

    def filter_denied(self, deny_list: list[str]) -> None:
        """Remove tools whose names are in the deny list."""
        for name in deny_list:
            self._tools.pop(name, None)
