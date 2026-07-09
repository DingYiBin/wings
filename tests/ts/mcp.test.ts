/**
 * Tests for MCP integration — config, tool adapter, loader.
 * Ported from tests/test_mcp.py.
 */

import { describe, test, expect } from "bun:test";

import { parseMCPToolName, type MCPServerConfig } from "../../src/mcp/client.ts";
import { loadMCPServers, _buildMCPToolForTest } from "../../src/mcp/loader.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

// -- MCPServerConfig ----------------------------------------------------------

describe("MCPServerConfig", () => {
  test("defaults — only name + command required", () => {
    const cfg: MCPServerConfig = { name: "test", command: "node" };
    expect(cfg.name).toBe("test");
    expect(cfg.command).toBe("node");
    expect(cfg.args).toBeUndefined();
    expect(cfg.env).toBeUndefined();
  });

  test("full — args + env", () => {
    const cfg: MCPServerConfig = {
      name: "test",
      command: "node",
      args: ["server.js"],
      env: { API_KEY: "sk-xxx" },
    };
    expect(cfg.args).toEqual(["server.js"]);
    expect(cfg.env).toEqual({ API_KEY: "sk-xxx" });
  });
});

// -- parseMCPToolName (name format) ------------------------------------------

describe("parseMCPToolName", () => {
  test("parses mcp__<server>__<tool>", () => {
    const parsed = parseMCPToolName("mcp__myserver__search");
    expect(parsed).toEqual({ serverName: "myserver", toolName: "search" });
  });

  test("parses tool name containing underscores", () => {
    const parsed = parseMCPToolName("mcp__srv__do_thing_now");
    expect(parsed).toEqual({ serverName: "srv", toolName: "do_thing_now" });
  });

  test("returns null for non-mcp names", () => {
    expect(parseMCPToolName("read")).toBeNull();
    expect(parseMCPToolName("mcp__onlyone")).toBeNull();
    expect(parseMCPToolName("other__server__tool")).toBeNull();
  });
});

// -- buildMCPTool (the _make_mcp_tool equivalent) ----------------------------

describe("buildMCPTool", () => {
  const config: MCPServerConfig = { name: "srv", command: "node" };

  test("name format is mcp__<server>__<tool>", () => {
    const tool = _buildMCPToolForTest(config, {
      name: "mcp__srv__search",
      description: "does X",
      input_schema: { type: "object" },
    });
    expect(tool.name).toBe("mcp__srv__search");
  });

  test("description is prefixed with [MCP:server]", () => {
    const tool = _buildMCPToolForTest(config, {
      name: "mcp__srv__t",
      description: "does X",
      input_schema: { type: "object" },
    });
    expect(tool.description).toBe("[MCP:srv] does X");
  });

  test("search_hint uses mcp_<server>_<tool>", () => {
    const tool = _buildMCPToolForTest(config, {
      name: "mcp__srv__t",
      description: "d",
      input_schema: { type: "object" },
    });
    expect(tool.search_hint).toBe("mcp_srv_t");
  });

  test("input schema passes through", () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const tool = _buildMCPToolForTest(config, {
      name: "mcp__srv__t",
      description: "d",
      input_schema: schema,
    });
    expect(tool.inputSchema()).toEqual(schema);
  });

  test("defaults to not read-only / not destructive", () => {
    const tool = _buildMCPToolForTest(config, {
      name: "mcp__srv__t",
      description: "d",
      input_schema: { type: "object" },
    });
    expect(tool.isReadOnly({})).toBe(false);
    expect(tool.isDestructive({})).toBe(false);
  });

  test("call() returns an error result when the server is unavailable", async () => {
    const tool = _buildMCPToolForTest(
      { name: "s", command: "nonexistent-command-xyz" },
      { name: "mcp__s__t", description: "d", input_schema: { type: "object" } },
    );
    const result: any = await tool.call({}, { working_dir: "/tmp", read_cache: new Map() } as any);
    // callMCPTool catches the connection failure and returns an
    // "MCP tool error: ..." string, which buildTool wraps into a ToolResult.
    const output: string = typeof result === "string" ? result : result.output;
    expect(output).toMatch(/MCP tool error/);
  });
});

// -- loadMCPServers (empty / invalid / unavailable) --------------------------

describe("loadMCPServers", () => {
  test("empty servers → 0 tools, no errors", async () => {
    const registry = new ToolRegistry();
    const res = await loadMCPServers(registry, {});
    expect(res.toolCount).toBe(0);
    expect(res.errors).toEqual([]);
  });

  test("skips servers missing 'command'", async () => {
    const registry = new ToolRegistry();
    const res = await loadMCPServers(registry, { bad: { args: ["x"] } });
    expect(res.toolCount).toBe(0);
    expect(res.errors.some((e) => e.includes("missing command"))).toBe(true);
  });

  test("skips unavailable servers gracefully", async () => {
    const registry = new ToolRegistry();
    const res = await loadMCPServers(registry, { dead: { command: "nonexistent-binary-xyz" } });
    // listMCPTools catches the connection failure and returns [], so no tools,
    // no crash. (Errors may or may not be populated depending on where it fails.)
    expect(res.toolCount).toBe(0);
  });
});
