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

  test("handoff injects System notice when model switches mid-session", async () => {
    // Mirrors test_agent.py:296-339. Selector alternates model-a → model-b →
    // model-a; on the third turn the loop should inject a [System notice] user
    // message because model-a was used, then model-b intervened, then model-a
    // returned.
    async function* stream() {
      yield { type: "text_delta", text: "ok" };
      yield { type: "text", text: "ok" };
    }
    class SwitchingSelector implements ModelSelector {
      calls = 0;
      select(_taskType: string, _override?: string | null): string {
        this.calls += 1;
        return this.calls % 2 === 1 ? "model-a" : "model-b";
      }
    }
    const selector = new SwitchingSelector();
    const registry = new ModelRegistry(selector);
    const provider = makeStream(stream);
    // Register both model ids so buildConfig can resolve either.
    const cfg = makeModelConfig({ model: "test", api_key: "sk-test" });
    registry.register("model-a", provider, { config: cfg });
    registry.register("model-b", provider, { config: cfg });
    const engine = new QueryEngine(registry);

    const loop = new AgentLoop(
      engine,
      new ToolRegistry(),
      new PermissionPipeline(new PermissionRules()),
      selector,
      registry,
    );
    const ctx = new AgentContext({ task_type: "main" });

    for await (const _ of loop.run("first", ctx, cfg)) {}
    for await (const _ of loop.run("second", ctx, cfg)) {}
    for await (const _ of loop.run("third", ctx, cfg)) {}

    // A handoff [System notice] user message must have been injected.
    const handoffFound = loop.messages.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some(
          (b) => (b as TextBlock).type === "text" && (b as TextBlock).text.includes("System notice"),
        ),
    );
    expect(handoffFound).toBe(true);
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

  test("persistToolResult under limit", async () => {
    const result = await (AgentLoop as any)._persistToolResult("short", "id1", 1000);
    expect(result).toBe("short");
  });

  test("persistToolResult over limit writes to file", async () => {
    const output = "line1\nline2\n" + "x".repeat(50000);
    const result = await (AgentLoop as any)._persistToolResult(output, "id2", 10);
    expect(result.length).toBeLessThan(output.length);
    expect(result).toContain("<persisted-output>");
    expect(result).toContain("tool-results/id2.txt");
    expect(result).toContain("Preview");
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
