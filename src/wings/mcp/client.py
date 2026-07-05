"""MCP client — connect to stdio MCP servers and bridge tools into wings."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@dataclass
class MCPServerConfig:
    """Configuration for one MCP server."""

    name: str
    command: str
    args: list[str] | None = None
    env: dict[str, str] | None = None


async def list_mcp_tools(config: MCPServerConfig) -> list[dict[str, Any]]:
    """Connect to an MCP server via stdio and list its tools.

    Returns a list of tool schemas with `mcp__server__tool` naming.
    """
    server_params = StdioServerParameters(
        command=config.command,
        args=config.args or [],
        env=config.env,
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()

            tools = []
            for tool in result.tools:
                name = f"mcp__{config.name}__{tool.name}"
                tools.append({
                    "name": name,
                    "description": tool.description or "",
                    "input_schema": tool.inputSchema or {"type": "object"},
                })
            return tools


async def call_mcp_tool(
    server_name: str,
    tool_name: str,
    arguments: dict[str, Any],
    *,
    command: str,
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
) -> str:
    """Call an MCP tool via stdio and return the result text."""
    server_params = StdioServerParameters(
        command=command,
        args=args or [],
        env=env,
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, arguments=arguments)

            texts = []
            for content in result.content:
                if hasattr(content, "text"):
                    texts.append(content.text)
            return "\n".join(texts)
