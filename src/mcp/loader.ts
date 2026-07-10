/**
 * MCP loader — discovers MCP servers from config and registers their tools.
 *
 * Configured via config.json `mcp_servers` field:
 *   "mcp_servers": {
 *     "myserver": { "command": "python", "args": ["-m", "my_mcp_server"] }
 *   }
 */

import type { Tool } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { buildTool } from "../tools/types.ts";
import { z } from "zod";

import {
  callMCPTool,
  listMCPTools,
  parseMCPToolName,
  type MCPServerConfig,
} from "./client.ts";

function parseServerConfig(
  name: string,
  raw: Record<string, unknown>,
): MCPServerConfig {
  return {
    name,
    command: (raw["command"] as string) ?? "",
    args: raw["args"] as string[] | undefined,
    env: raw["env"] as Record<string, string> | undefined,
  };
}

export interface MCPLoaderResult {
  toolCount: number;
  errors: string[];
}

/** Connect to all configured MCP servers and register their tools into
 * the given registry. Each tool is named `mcp__<server>__<tool>`. */
export async function loadMCPServers(
  toolRegistry: ToolRegistry,
  serverConfigs: Record<string, Record<string, unknown>>,
): Promise<MCPLoaderResult> {
  let toolCount = 0;
  const errors: string[] = [];

  for (const [serverName, rawConfig] of Object.entries(serverConfigs)) {
    const config = parseServerConfig(serverName, rawConfig);
    if (!config.command) {
      errors.push(`MCP server "${serverName}": missing command`);
      continue;
    }

    try {
      const schemas = await listMCPTools(config);
      for (const schema of schemas) {
        const tool = buildMCPTool(config, schema);
        toolRegistry.register(tool);
        toolCount++;
      }
    } catch (e) {
      errors.push(`MCP server "${serverName}": ${(e as Error).message}`);
    }
  }

  return { toolCount, errors };
}

function buildMCPTool(
  config: MCPServerConfig,
  schema: { name: string; description: string; input_schema: Record<string, unknown> },
): Tool {
  // Mirror Python _make_mcp_tool: description is prefixed with [MCP:server]
  // and search_hint uses mcp_<server>_<tool> (underscores, no namespace).
  const parsed = parseMCPToolName(schema.name);
  const toolName = parsed?.toolName ?? schema.name;
  return buildTool({
    name: schema.name,
    description: `[MCP:${config.name}] ${schema.description}`,
    search_hint: `mcp_${config.name}_${toolName}`,
    is_read_only: false,
    inputSchema: z.object({}).passthrough(),
    // Pass the server-defined schema through verbatim (mirrors Python's
    // input_schema passthrough) so the model sees the real parameters.
    raw_input_schema: schema.input_schema,
    async call(input: Record<string, unknown>) {
      const p = parseMCPToolName(schema.name);
      if (!p) return "Error: invalid MCP tool name";
      return await callMCPTool(config, p.toolName, input);
    },
  });
}

// Exported for testing — constructs an MCP tool from a server config + schema
// without connecting to a live server.
export function _buildMCPToolForTest(
  config: MCPServerConfig,
  schema: { name: string; description: string; input_schema: Record<string, unknown> },
): Tool {
  return buildMCPTool(config, schema);
}
