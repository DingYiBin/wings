"""MCP integration — Model Context Protocol tool bridging."""

from wings.mcp.client import MCPServerConfig, call_mcp_tool, list_mcp_tools
from wings.mcp.loader import load_mcp_tools

__all__ = ["MCPServerConfig", "call_mcp_tool", "list_mcp_tools", "load_mcp_tools"]
