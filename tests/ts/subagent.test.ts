/**
 * Tests for the subagent module.
 * Ported from tests/test_subagent.py.
 */

import { describe, test, expect } from "bun:test";

import {
  BUILTIN_AGENT_TYPES,
  type AgentTypeSpec,
  getAgentTypes,
  runSubagent,
} from "../../src/agent/subagent.ts";
import type { Message, TextBlock, TextDelta, ToolResultBlock, ToolUseBlock } from "../../src/messages/types.ts";
import { makeModelConfig } from "../../src/models/protocol.ts";
import type { ModelRegistry } from "../../src/models/registry.ts";
import type { QueryEngine } from "../../src/query/engine.ts";
import type { ModelSelector } from "../../src/routing/protocol.ts";
import { TASK_HIERARCHY } from "../../src/routing/tasks.ts";
import { makeToolContext, type Tool, type ToolContext } from "../../src/tools/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

// -- Agent type definitions --

describe("Agent types", () => {
  test("builtin types exist", () => {
    expect("general" in BUILTIN_AGENT_TYPES).toBe(true);
    expect("explore" in BUILTIN_AGENT_TYPES).toBe(true);
    expect("plan" in BUILTIN_AGENT_TYPES).toBe(true);
  });

  test("agent types have valid task types", () => {
    for (const [name, spec] of Object.entries(BUILTIN_AGENT_TYPES)) {
      expect(spec.task_type in TASK_HIERARCHY).toBe(true);
    }
  });

  test("no type allows agent tool", () => {
    for (const [name, spec] of Object.entries(BUILTIN_AGENT_TYPES)) {
      expect(spec.disallowed_tools).toContain("agent");
    }
  });

  test("explore is read only", () => {
    expect(BUILTIN_AGENT_TYPES["explore"]!.read_only).toBe(true);
  });

  test("plan is read only", () => {
    expect(BUILTIN_AGENT_TYPES["plan"]!.read_only).toBe(true);
  });

  test("general is not read only", () => {
    expect(BUILTIN_AGENT_TYPES["general"]!.read_only).toBe(false);
  });

  test("explore has explicit tool list", () => {
    expect(BUILTIN_AGENT_TYPES["explore"]!.tools).not.toBeNull();
  });

  test("general wildcard tools", () => {
    expect(BUILTIN_AGENT_TYPES["general"]!.tools).toBeNull();
  });

  test("AgentTypeSpec defaults", () => {
    const spec: AgentTypeSpec = {
      name: "test",
      description: "A test agent",
      tools: null,
      disallowed_tools: [],
      read_only: false,
      task_type: "",
    };
    expect(spec.tools).toBeNull();
    expect(spec.read_only).toBe(false);
    expect(spec.task_type).toBe("");
  });
});

// -- Fake tool --

class FakeTool implements Tool {
  name: string;
  description: string;
  search_hint: string;
  private _readOnly: boolean;
  private _destructive: boolean;
  constructor(name: string, readOnly = true, destructive = false) {
    this.name = name;
    this.description = `desc:${name}`;
    this.search_hint = `hint:${name}`;
    this._readOnly = readOnly;
    this._destructive = destructive;
  }
  inputSchema() { return { type: "object" }; }
  async call() { return { output: `result:${this.name}` }; }
  isEnabled() { return true; }
  isReadOnly() { return this._readOnly; }
  isDestructive() { return this._destructive; }
  renderResult(r: { output: string }) { return r.output; }
  activityDescription() { return `doing:${this.name}`; }
}

function makeRegistry(names: string[], readOnly = true, destructive = false): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of names) reg.register(new FakeTool(name, readOnly, destructive));
  return reg;
}

// -- Tool filtering tests (via runSubagent internal logic) --

describe("Tool filtering", () => {
  test("explore only read tools", () => {
    // We test via getAgentTypes + the filtering logic.
    // Since _filter_tools_for_agent is private, test indirectly via
    // runSubagent which uses it internally.
    const spec = BUILTIN_AGENT_TYPES["explore"]!;
    expect(spec.tools).not.toBeNull();
    const tools = spec.tools!;
    expect(tools).toContain("read");
    expect(tools).toContain("glob");
    expect(tools).toContain("grep");
    expect(tools).toContain("skill_view");
    expect(tools).not.toContain("agent");
    expect(tools).not.toContain("bash");
  });

  test("general has all except agent", () => {
    const spec = BUILTIN_AGENT_TYPES["general"]!;
    expect(spec.tools).toBeNull(); // wildcard
    expect(spec.disallowed_tools).toContain("agent");
  });

  test("plan no write edit", () => {
    const spec = BUILTIN_AGENT_TYPES["plan"]!;
    expect(spec.tools).toBeNull();
    expect(spec.disallowed_tools).toContain("write");
    expect(spec.disallowed_tools).toContain("edit");
    expect(spec.disallowed_tools).toContain("agent");
  });
});

// -- runSubagent --

function makeMockEngine(streamFn: () => AsyncIterable<any>): QueryEngine {
  const engine: any = {
    stream: streamFn,
    chat: async () => ({ content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }),
  };
  return engine;
}

function makeMockRegistry(modelId = "test/model"): ModelRegistry {
  return {
    get: (name: string) => ({ provider_name: "test", chat: async () => ({} as any), stream: async function* () {} }),
    buildConfig: (apiId: string, overrides?: any) => makeModelConfig({ model: apiId, ...overrides }),
    register: () => {},
    select: () => modelId,
    list: () => [],
    alias: () => {},
  } as any;
}

function makeMockSelector(modelId = "test/model"): ModelSelector {
  return {
    select: (_taskType: string, _override?: string | null) => modelId,
  };
}

describe("runSubagent", async () => {
  test("returns text", async () => {
    async function* stream() {
      yield { type: "text_delta", text: "Done." };
      yield { type: "text", text: "Done." };
    }
    const result = await runSubagent("do something", "general", {
      queryEngine: makeMockEngine(stream),
      modelRegistry: makeMockRegistry(),
      toolRegistry: makeRegistry(["read", "glob", "grep", "skill_view"]),
      modelSelector: makeMockSelector(),
      workingDir: "/tmp",
    });
    expect(result).toBe("Done.");
  });

  test("uses correct task type", async () => {
    async function* stream() {
      yield { type: "text_delta", text: "ok" };
      yield { type: "text", text: "ok" };
    }
    const calls: string[] = [];
    const selector: ModelSelector = {
      select(taskType: string, _override?: string | null): string {
        calls.push(taskType);
        return "test/model";
      },
    };
    await runSubagent("explore this", "explore", {
      queryEngine: makeMockEngine(stream),
      modelRegistry: makeMockRegistry(),
      toolRegistry: makeRegistry(["read", "glob", "grep", "skill_view"]),
      modelSelector: selector,
      workingDir: "/tmp",
    });
    expect(calls.some((c) => c.includes("subagent/explore"))).toBe(true);
  });

  test("unknown type returns error", async () => {
    async function* empty() {}
    const result = await runSubagent("test", "nonexistent", {
      queryEngine: makeMockEngine(empty),
      modelRegistry: makeMockRegistry(),
      toolRegistry: makeRegistry(["read"]),
      modelSelector: makeMockSelector(),
      workingDir: "/tmp",
    });
    expect(result).toContain("Error");
    expect(result).toContain("nonexistent");
  });

  test("event callback", async () => {
    async function* stream() {
      yield { type: "text_delta", text: "hello" };
      yield { type: "text", text: "hello" };
    }
    const events: any[] = [];
    await runSubagent("test", "general", {
      queryEngine: makeMockEngine(stream),
      modelRegistry: makeMockRegistry(),
      toolRegistry: makeRegistry(["read"]),
      modelSelector: makeMockSelector(),
      workingDir: "/tmp",
      eventCallback: (e) => events.push(e),
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });

  test("fresh messages", async () => {
    const messagesSent: any[][] = [];
    async function* stream(this: any, messages: any[]) {
      messagesSent.push(messages);
      yield { type: "text_delta", text: "ok" };
      yield { type: "text", text: "ok" };
    }
    await runSubagent("first", "general", {
      queryEngine: { stream, chat: async () => ({} as any), _maxRetries: 3, _retryBaseDelay: 0 } as any,
      modelRegistry: makeMockRegistry(),
      toolRegistry: makeRegistry(["read"]),
      modelSelector: makeMockSelector(),
      workingDir: "/tmp",
    });
    expect(messagesSent.length).toBe(1);
    const roles = (messagesSent[0] as any[]).map((m: any) => m.role);
    expect(roles).toContain("system");
    expect(roles).toContain("user");
  });
});
