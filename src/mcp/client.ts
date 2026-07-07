/**
 * MCP (Model Context Protocol) client — connects to stdio MCP servers.
 *
 * Tools from MCP servers are registered with `mcp__<server>__<tool>` naming
 * so they don't collide with built-in tools or other servers' tools.
 *
 * Uses @modelcontextprotocol/sdk for the stdio transport layer.
 */

import type { Tool } from "../tools/types.ts";

// -- Types --

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPToolSchema {
  name: string; // mcp__server__tool format
  description: string;
  input_schema: Record<string, unknown>;
}

// -- Client --

/**
 * List tools available from an MCP server via stdio.
 *
 * This uses the MCP SDK's stdio client to connect, initialize, and list
 * tools. Each tool name is prefixed with `mcp__<server>__` for namespace
 * isolation.
 */
export async function listMCPTools(
  config: MCPServerConfig,
): Promise<MCPToolSchema[]> {
  try {
    const { listTools } = await import("./transport.ts");
    return await listTools(config);
  } catch {
    return [];
  }
}

/**
 * Call an MCP tool via stdio and return the result text.
 */
export async function callMCPTool(
  config: MCPServerConfig,
  toolName: string, // the original tool name (without mcp__ prefix)
  arguments_: Record<string, unknown>,
): Promise<string> {
  try {
    const { callTool } = await import("./transport.ts");
    return await callTool(config, toolName, arguments_);
  } catch (e) {
    return `MCP tool error: ${(e as Error).message}`;
  }
}

/** Parse the server name and tool name from a prefixed name like
 * `mcp__myserver__mytool`. */
export function parseMCPToolName(
  prefixedName: string,
): { serverName: string; toolName: string } | null {
  const parts = prefixedName.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return null;
  return {
    serverName: parts[1]!,
    toolName: parts.slice(2).join("__"),
  };
}
