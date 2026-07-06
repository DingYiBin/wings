"""Tests for the MCP integration — config, tool adapter, loader."""

from __future__ import annotations

import pytest

from wings.mcp.client import MCPServerConfig
from wings.mcp.loader import _make_mcp_tool
from wings.tools.base import ToolResult


# -- MCPServerConfig -----------------------------------------------------------


def test_mcp_server_config_defaults():
    cfg = MCPServerConfig(name="test", command="node")
    assert cfg.name == "test"
    assert cfg.command == "node"
    assert cfg.args is None
    assert cfg.env is None


def test_mcp_server_config_full():
    cfg = MCPServerConfig(
        name="test",
        command="node",
        args=["server.js"],
        env={"API_KEY": "sk-xxx"},
    )
    assert cfg.args == ["server.js"]
    assert cfg.env == {"API_KEY": "sk-xxx"}


# -- _make_mcp_tool ------------------------------------------------------------


def test_mcp_tool_name_format():
    """Tool name should be mcp__<server>__<tool>."""
    tool = _make_mcp_tool(
        server_name="myserver",
        tool_name="search",
        description="Search things",
        input_schema={"type": "object"},
        server_command="node",
        server_args=None,
        server_env=None,
    )
    assert tool.name == "mcp__myserver__search"


def test_mcp_tool_description_prefixed():
    """Description should include [MCP:server] prefix."""
    tool = _make_mcp_tool(
        server_name="srv",
        tool_name="t",
        description="does X",
        input_schema={"type": "object"},
        server_command="node",
        server_args=None,
        server_env=None,
    )
    assert tool.description == "[MCP:srv] does X"


def test_mcp_tool_input_schema_passthrough():
    """Input schema should be returned verbatim."""
    schema = {"type": "object", "properties": {"q": {"type": "string"}}}
    tool = _make_mcp_tool(
        server_name="s",
        tool_name="t",
        description="d",
        input_schema=schema,
        server_command="c",
        server_args=None,
        server_env=None,
    )
    assert tool.input_schema() == schema


def test_mcp_tool_is_not_read_only():
    """MCP tools default to not read-only (conservative)."""
    tool = _make_mcp_tool(
        server_name="s",
        tool_name="t",
        description="d",
        input_schema={"type": "object"},
        server_command="c",
        server_args=None,
        server_env=None,
    )
    assert not tool.is_read_only({})
    assert not tool.is_destructive({})


@pytest.mark.asyncio
async def test_mcp_tool_call_handles_error():
    """When the MCP server is unavailable, call() returns an error result."""
    tool = _make_mcp_tool(
        server_name="s",
        tool_name="t",
        description="d",
        input_schema={"type": "object"},
        server_command="nonexistent-command-xyz",
        server_args=None,
        server_env=None,
    )
    result = await tool.call({}, None)  # type: ignore[arg-type]
    assert isinstance(result, ToolResult)
    assert result.error is not None
    assert "MCP error" in result.output


# -- load_mcp_tools (with empty/invalid configs) -------------------------------


@pytest.mark.asyncio
async def test_load_mcp_tools_empty_servers():
    """No servers configured → no tools."""
    from wings.mcp.loader import load_mcp_tools

    tools = await load_mcp_tools({})
    assert tools == []


@pytest.mark.asyncio
async def test_load_mcp_tools_skips_invalid_config():
    """Servers without 'command' key should be skipped."""
    from wings.mcp.loader import load_mcp_tools

    tools = await load_mcp_tools({"bad": {"args": ["x"]}})
    assert tools == []


@pytest.mark.asyncio
async def test_load_mcp_tools_skips_unavailable_server():
    """If a server can't connect, it should be skipped gracefully."""
    from wings.mcp.loader import load_mcp_tools

    tools = await load_mcp_tools(
        {"dead": {"command": "nonexistent-binary-xyz"}}
    )
    assert tools == []
