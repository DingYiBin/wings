/**
 * MCP stdio transport — thin wrapper around @modelcontextprotocol/sdk.
 *
 * Each call spawns a fresh connection to the MCP server (stateless).
 * For production use, pooled connections would be more efficient.
 */

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import type { MCPServerConfig, MCPToolSchema } from "./client.ts";

/** List tools from an MCP server via stdio. */
export async function listTools(config: MCPServerConfig): Promise<MCPToolSchema[]> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env,
  } as any);

  const client = new Client(
    { name: "wings", version: "0.1" },
    {} as any,
  );

  await client.connect(transport);

  const result = await client.listTools();
  const tools: MCPToolSchema[] = [];
  for (const tool of (result as any).tools ?? []) {
    tools.push({
      name: `mcp__${config.name}__${tool.name}`,
      description: (tool as any).description ?? "",
      input_schema: (tool as any).inputSchema ?? { type: "object" },
    });
  }

  await client.close();
  return tools;
}

/** Call an MCP tool via stdio and return the result text. */
export async function callTool(
  config: MCPServerConfig,
  toolName: string,
  arguments_: Record<string, unknown>,
): Promise<string> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env,
  } as any);

  const client = new Client(
    { name: "wings", version: "0.1" },
    {} as any,
  );

  await client.connect(transport);

  const result = await client.callTool({
    name: toolName,
    arguments: arguments_,
  } as any);

  await client.close();

  const texts: string[] = [];
  for (const content of (result as any).content ?? []) {
    if (typeof content.text === "string") {
      texts.push(content.text);
    }
  }
  return texts.join("\n");
}
