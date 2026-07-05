"""MCP tool loader — discovers MCP tools and wraps them as wings Tools."""

from __future__ import annotations

import asyncio
from typing import Any

from wings.mcp.client import MCPServerConfig, call_mcp_tool, list_mcp_tools
from wings.tools.base import Tool, ToolContext, ToolResult


def _make_mcp_tool(
    server_name: str,
    tool_name: str,
    description: str,
    input_schema: dict[str, Any],
    server_command: str,
    server_args: list[str] | None,
    server_env: dict[str, str] | None,
) -> Tool:
    """Create a wings Tool that proxies to an MCP server tool."""

    class _McpToolAdapter:
        name = f"mcp__{server_name}__{tool_name}"
        description = f"[MCP:{server_name}] {description}"
        search_hint = f"mcp_{server_name}_{tool_name}"

        def input_schema(self) -> dict[str, Any]:
            return input_schema

        async def call(self, input: Any, context: ToolContext) -> ToolResult:
            args = input if isinstance(input, dict) else (
                input.model_dump() if hasattr(input, "model_dump") else {}
            )
            try:
                output = await call_mcp_tool(
                    server_name=server_name,
                    tool_name=tool_name,
                    arguments=args,
                    command=server_command,
                    args=server_args,
                    env=server_env,
                )
                return ToolResult(output=output)
            except Exception as e:
                return ToolResult(output=f"MCP error: {e}", error=str(e))

        def is_enabled(self) -> bool:
            return True

        def is_read_only(self, input: Any) -> bool:
            return False

        def is_destructive(self, input: Any) -> bool:
            return False

        def render_result(self, result: ToolResult) -> str:
            return result.output

        def activity_description(self, input: Any) -> str:
            return f"MCP {self.name}..."

    return _McpToolAdapter()


async def load_mcp_tools(
    servers: dict[str, dict],
) -> list[Tool]:
    """Connect to all configured MCP servers and load their tools.

    Args:
        servers: dict of server_name -> {command, args?, env?}

    Returns:
        List of wings Tool objects ready for registration.
    """
    tools: list[Tool] = []

    for server_name, cfg in servers.items():
        if not isinstance(cfg, dict) or "command" not in cfg:
            continue

        config = MCPServerConfig(
            name=server_name,
            command=cfg["command"],
            args=cfg.get("args"),
            env=cfg.get("env"),
        )

        try:
            mcp_tools = await list_mcp_tools(config)
        except Exception:
            continue  # server unavailable, skip

        for t in mcp_tools:
            tool = _make_mcp_tool(
                server_name=server_name,
                tool_name=t["name"].split("__", 2)[-1],  # strip mcp__server__ prefix
                description=t["description"],
                input_schema=t["input_schema"],
                server_command=config.command,
                server_args=config.args,
                server_env=config.env,
            )
            tools.append(tool)

    return tools
