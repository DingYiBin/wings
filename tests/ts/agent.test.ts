/**
 * Tests for the agent module — handoff detection and core loop.
 * Ported from tests/test_agent.py.
 */

import { describe, test, expect } from "bun:test";

import { HandoffDetector, makeTurnRecord, AgentContext, AgentLoop } from "../../src/agent/index.ts";
import type { TurnRecord } from "../../src/agent/index.ts";
import { Message, type TextBlock } from "../../src/messages/types.ts";
import { makeModelConfig, type ModelProvider, type ModelResponse } from "../../src/models/protocol.ts";
import { ModelRegistry } from "../../src/models/registry.ts";
import { PermissionPipeline } from "../../src/permissions/pipeline.ts";
import { PermissionRules } from "../../src/permissions/rules.ts";
import { QueryEngine } from "../../src/query/engine.ts";
import type { ModelSelector } from "../../src/routing/protocol.ts";
import { makeToolContext, makeToolResult, type Tool, type ToolContext } from "../../src/tools/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

// -- HandoffDetector --

function makeTurn(turn_id: number, model_id: string, summary = ""): TurnRecord {
  return makeTurnRecord(turn_id, model_id, {
    user_input_summary: summary,
    summary,
  });
}

describe("HandoffDetector", () => {
  test("no history", () => {
    expect(new HandoffDetector().detect("model-a", [])).toBeNull();
  });

  test("first appearance", () => {
    const detector = new HandoffDetector();
    const history = [makeTurn(0, "model-b", "did something")];
    expect(detector.detect("model-a", history)).toBeNull();
  });

  test("same model consecutive", () => {
    const detector = new HandoffDetector();
    const history = [makeTurn(0, "model-a", "first"), makeTurn(1, "model-a", "second")];
    expect(detector.detect("model-a", history)).toBeNull();
  });

  test("handoff detected", () => {
    const detector = new HandoffDetector();
    const history = [
      makeTurn(0, "model-a", "first task"),
      makeTurn(1, "model-b", "handled something in between"),
    ];
    const prompt = detector.detect("model-a", history)!;
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("model-b");
    expect(prompt).toContain("handled something in between");
  });

  test("multiple intervening", () => {
    const detector = new HandoffDetector();
    const history = [
      makeTurn(0, "model-a", "task A"),
      makeTurn(1, "model-b", "task B"),
      makeTurn(2, "model-c", "task C"),
    ];
    const prompt = detector.detect("model-a", history)!;
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("model-b");
    expect(prompt).toContain("model-c");
  });

  test("only intervening models listed", () => {
    const detector = new HandoffDetector();
    const history = [
      makeTurn(0, "model-a", "A1"),
      makeTurn(1, "model-b", "B"),
      makeTurn(2, "model-a", "A2"),
      makeTurn(3, "model-c", "C"),
    ];
    const prompt = detector.detect("model-a", history)!;
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("model-c");
    expect(prompt).not.toContain("model-b");
  });
});

// -- AgentLoop helpers --

class FakeTool implements Tool {
  name = "echo";
  description = "echoes input";
  search_hint = "echo";
  inputSchema() {
    return { type: "object", properties: { msg: { type: "string" } } };
  }
  async call(input: any, _context: ToolContext) {
    return makeToolResult({ output: `echo: ${input.msg}` });
  }
  isEnabled() { return true; }
  isReadOnly() { return true; }
  isDestructive() { return false; }
  renderResult(result: { output: string }) { return result.output; }
  activityDescription() { return "echoing..."; }
}

class MockSelector implements ModelSelector {
  select(_taskType: string, override?: string | null): string {
    return override ?? "test/model";
  }
}

function makeStream(streamFn: () => AsyncIterable<any>): ModelProvider {
  return {
    provider_name: "anthropic",
    async chat(): Promise<ModelResponse> {
      return { content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    },
    async *stream() {
      for await (const e of streamFn()) yield e;
    },
  } as any;
}

function makeEngine(streamFn: () => AsyncIterable<any>): { engine: QueryEngine; registry: ModelRegistry } {
  const selector = new MockSelector();
  const registry = new ModelRegistry(selector);
  const provider = makeStream(streamFn);
  registry.register("test/model", provider, {
    config: makeModelConfig({ model: "test/model", api_key: "sk-test" }),
  });
  return { engine: new QueryEngine(registry), registry };
}

// -- AgentLoop tests --

describe("AgentLoop", () => {
  test("simple text response", async () => {
    async function* stream() {
      yield { type: "text_delta", text: "hello world" };
      yield { type: "text", text: "hello world" };
    }
    const { engine, registry } = makeEngine(stream);
    const tools = new ToolRegistry();
    const pipeline = new PermissionPipeline(new PermissionRules());
    const selector = new MockSelector();

    const loop = new AgentLoop(engine, tools, pipeline, selector, registry);
    const ctx = new AgentContext({ task_type: "main" });
    const events: any[] = [];
    for await (const evt of loop.run("hello", ctx, makeModelConfig({ model: "test", api_key: "sk-test" }))) {
      events.push(evt);
    }
    expect(events.length).toBe(1);
    expect(events[0].text).toBe("hello world");
  });

  test("tool use cycle", async () => {
    let callCount = 0;
    async function* stream() {
      callCount++;
      if (callCount === 1) {
        yield { type: "tool_use", id: "1", name: "echo", input: { msg: "ping" } };
      } else {
        yield { type: "text_delta", text: "done after tool" };
        yield { type: "text", text: "done after tool" };
      }
    }
    const { engine, registry } = makeEngine(stream);
    const tools = new ToolRegistry();
    tools.register(new FakeTool());
    const rules = new PermissionRules({ allowlist: ["echo"] });
    const pipeline = new PermissionPipeline(rules);
    const selector = new MockSelector();

    const loop = new AgentLoop(engine, tools, pipeline, selector, registry);
    const ctx = new AgentContext({ task_type: "main" });
    const events: any[] = [];
    for await (const evt of loop.run("echo ping", ctx, makeModelConfig({ model: "test", api_key: "sk-test" }))) {
      events.push(evt);
    }
    expect(callCount).toBe(2);
    expect(events[events.length - 1].text).toBe("done after tool");
  });

  test("permission denied", async () => {
    let callCount = 0;
    async function* stream() {
      callCount++;
      if (callCount === 1) {
        yield { type: "tool_use", id: "1", name: "echo", input: { msg: "x" } };
      } else {
        yield { type: "text_delta", text: "got error, stopping" };
        yield { type: "text", text: "got error, stopping" };
      }
    }
    const { engine, registry } = makeEngine(stream);
    const tools = new ToolRegistry();
    tools.register(new FakeTool());
    const rules = new PermissionRules({ denylist: ["echo"] });
    const pipeline = new PermissionPipeline(rules);
    const selector = new MockSelector();

    const loop = new AgentLoop(engine, tools, pipeline, selector, registry);
    const ctx = new AgentContext({ task_type: "main" });
    for await (const _ of loop.run("echo x", ctx, makeModelConfig({ model: "test", api_key: "sk-test" }))) {}
    expect(callCount).toBe(2);
  });

  test("unknown tool", async () => {
    let callCount = 0;
    async function* stream() {
      callCount++;
      if (callCount === 1) {
        yield { type: "tool_use", id: "1", name: "nonexistent", input: {} };
      } else {
        yield { type: "text_delta", text: "ok" };
        yield { type: "text", text: "ok" };
      }
    }
    const { engine, registry } = makeEngine(stream);
    const tools = new ToolRegistry();
    const pipeline = new PermissionPipeline(new PermissionRules());
    const selector = new MockSelector();

    const loop = new AgentLoop(engine, tools, pipeline, selector, registry);
    const ctx = new AgentContext({ task_type: "main" });
    for await (const _ of loop.run("hi", ctx, makeModelConfig({ model: "test", api_key: "sk-test" }))) {}
    expect(callCount).toBe(2);
  });

  test("system prompt injected once", async () => {
    async function* stream() {
      yield { type: "text_delta", text: "ok" };
      yield { type: "text", text: "ok" };
    }
    const { engine, registry } = makeEngine(stream);
    const loop = new AgentLoop(engine, new ToolRegistry(), new PermissionPipeline(new PermissionRules()), new MockSelector(), registry);
    const ctx = new AgentContext({ system_prompt: "you are helpful" });
    const cfg = makeModelConfig({ model: "test", api_key: "sk-test" });
    for await (const _ of loop.run("turn1", ctx, cfg)) {}
    for await (const _ of loop.run("turn2", ctx, cfg)) {}
    const systemCount = loop.messages.filter((m) => m.role === "system").length;
    expect(systemCount).toBe(1);
  });
});

// -- Token budget & truncation --

describe("Compaction triggers", () => {
  test("needsCompact false for short history", () => {
    const selector = new MockSelector();
    const registry = new ModelRegistry(selector);
    const loop = new AgentLoop(
      new QueryEngine(registry),
      new ToolRegistry(),
      new PermissionPipeline(new PermissionRules()),
      selector,
      registry,
    );
    // Set private field directly for testing.
    (loop as any)._messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const cfg = makeModelConfig({ model: "test", api_key: "sk-test", context_window: 200_000 });
    expect((loop as any)._needsCompact(new AgentContext(), cfg)).toBe(false);
  });

  test("needsCompact true when over threshold", () => {
    async function* empty() {}
    const { registry } = makeEngine(empty);
    const selector = new MockSelector();
    const loop = new AgentLoop(
      new QueryEngine(registry),
      new ToolRegistry(),
      new PermissionPipeline(new PermissionRules()),
      selector,
      registry,
    );
    (loop as any)._messages = Array.from({ length: 8 }, () => ({
      role: "user",
      content: [{ type: "text", text: "x".repeat(5000) }],
    }));
    const cfg = makeModelConfig({ model: "test", api_key: "sk-test", context_window: 10_000 });
    expect((loop as any)._needsCompact(new AgentContext(), cfg)).toBe(true);
  });

  test("truncate under limit", () => {
    expect((AgentLoop as any)._truncateToolResult("short")).toBe("short");
  });

  test("truncate over limit", () => {
    const limit = (AgentLoop as any).MAX_TOOL_RESULT_CHARS;
    const longOutput = "x".repeat(limit + 100);
    const result = (AgentLoop as any)._truncateToolResult(longOutput);
    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain("truncated");
  });

  test("compaction logs a [compaction performed] cycle", async () => {
    // The summarization call yields a short summary text.
    async function* summaryStream() {
      yield { type: "text_delta", text: "summary of prior turns" };
      yield { type: "text", text: "summary of prior turns" };
    }
    const { engine, registry } = makeEngine(summaryStream);
    const selector = new MockSelector();
    const loop = new AgentLoop(
      engine,
      new ToolRegistry(),
      new PermissionPipeline(new PermissionRules()),
      selector,
      registry,
    );

    // Long history: 1 system + 9 user/assistant turns (> keepRecent+1).
    const messages: any[] = [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      ...Array.from({ length: 9 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `msg ${i}` }],
      })),
    ];
    (loop as any)._messages = messages;

    const recorded: any[] = [];
    loop.setLogger({ recordCycle(opts: Record<string, unknown>) { recorded.push(opts); } });

    const cfg = makeModelConfig({ model: "test/model", api_key: "sk-test", context_window: 10_000 });
    await (loop as any)._compactMessages(new AgentContext({ task_type: "main" }), cfg);

    expect(recorded.length).toBe(1);
    expect(recorded[0]!.input_summary).toBe("[compaction performed]");
    expect(recorded[0]!.tool_calls).toEqual([]);
    // Messages were compacted (fewer than the original 10).
    expect((loop as any)._messages.length).toBeLessThan(messages.length);
  });
});
