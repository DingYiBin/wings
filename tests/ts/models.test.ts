/**
 * Tests for the models module — adapter protocol, registry, capabilities.
 *
 * Ported from tests/test_models.py.
 */

import { describe, test, expect } from "bun:test";

import {
  ASSISTANT,
  Message,
  type MessageContent,
  Role,
  SYSTEM,
  TextBlock,
  ToolUseBlock,
  USER,
} from "../../src/messages/types.ts";
import { AnthropicProvider } from "../../src/models/anthropic.ts";
import {
  CAPABILITY_CATALOG,
  getCapabilities,
} from "../../src/models/capabilities.ts";
import { OpenAIProvider } from "../../src/models/openai.ts";
import { makeModelConfig, type ModelProvider, type ModelResponse } from "../../src/models/protocol.ts";
import { ModelRegistry } from "../../src/models/registry.ts";
import type { ModelSelector } from "../../src/routing/protocol.ts";

// -- ModelConfig / TokenUsage / ModelResponse --------------------------------

describe("ModelConfig / TokenUsage / ModelResponse", () => {
  test("model config defaults", () => {
    const config = makeModelConfig({ model: "test" });
    expect(config.temperature).toBeNull();
    expect(config.max_tokens).toBe(8_000);
    expect(config.thinking).toBe(true);
  });

  test("model response is serializable", () => {
    const resp: ModelResponse = {
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const data = JSON.parse(JSON.stringify(resp));
    expect(data.stop_reason).toBe("end_turn");
    expect(data.usage.input_tokens).toBe(10);
  });
});

// -- ModelCapabilities -------------------------------------------------------

describe("ModelCapabilities", () => {
  test("capability catalog has entries", () => {
    expect(Object.keys(CAPABILITY_CATALOG).length).toBeGreaterThanOrEqual(6);
    expect("anthropic/claude-opus-4-6" in CAPABILITY_CATALOG).toBe(true);
    expect("openai/gpt-4o" in CAPABILITY_CATALOG).toBe(true);
  });

  test("getCapabilities found", () => {
    const cap = getCapabilities("anthropic/claude-sonnet-4-6");
    expect(cap).toBeDefined();
    expect(cap!.supports_tools).toBe(true);
    expect(cap!.supports_streaming).toBe(true);
  });

  test("getCapabilities unknown", () => {
    expect(getCapabilities("unknown/model")).toBeUndefined();
  });

  test("capability fields", () => {
    const cap = CAPABILITY_CATALOG["anthropic/claude-haiku-4-5"]!;
    expect(cap.speed_tier).toBe("fast");
    expect(cap.supports_thinking).toBe(false);
    expect(cap.context_window).toBe(200_000);
  });
});

// -- ModelRegistry -----------------------------------------------------------

class MockSelector implements ModelSelector {
  select(task_type: string, override?: string | null): string {
    if (override) return override;
    return "anthropic/claude-haiku-4-5";
  }
}

function makeRegistry(): ModelRegistry {
  const selector = new MockSelector();
  const reg = new ModelRegistry(selector);
  // Register mock providers.
  const mockProvider: ModelProvider = {
    provider_name: "mock",
    async chat() {
      return { content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
    },
    async *stream() {},
  };
  reg.register("anthropic/claude-haiku-4-5", mockProvider);
  reg.register("openai/gpt-4o", mockProvider);
  return reg;
}

describe("ModelRegistry", () => {
  test("list", () => {
    const reg = makeRegistry();
    const names = reg.list();
    expect(names).toContain("anthropic/claude-haiku-4-5");
    expect(names).toContain("openai/gpt-4o");
  });

  test("get", () => {
    const reg = makeRegistry();
    const provider = reg.get("anthropic/claude-haiku-4-5");
    expect(provider).toBeDefined();
  });

  test("get unknown throws", () => {
    const reg = makeRegistry();
    expect(() => reg.get("nonexistent")).toThrow(/unknown model/);
  });

  test("alias", () => {
    const reg = makeRegistry();
    reg.alias("haiku", "anthropic/claude-haiku-4-5");
    expect(reg.get("haiku")).toBe(reg.get("anthropic/claude-haiku-4-5"));
  });

  test("alias unknown target throws", () => {
    const reg = makeRegistry();
    expect(() => reg.alias("bad", "nonexistent")).toThrow();
  });

  test("select no override", () => {
    const reg = makeRegistry();
    expect(reg.select("main")).toBe("anthropic/claude-haiku-4-5");
  });

  test("select with override", () => {
    const reg = makeRegistry();
    expect(reg.select("main", "openai/gpt-4o")).toBe("openai/gpt-4o");
  });

  test("buildConfig", () => {
    const reg = makeRegistry();
    const config = reg.buildConfig("openai/gpt-4o", { temperature: 0.0 });
    expect(config.model).toBe("openai/gpt-4o");
    expect(config.temperature).toBe(0.0);
    expect(config.max_tokens).toBe(8_000);
  });
});

// -- AnthropicProvider: response parsing -------------------------------------

describe("AnthropicProvider", () => {
  test("parse text content", () => {
    const provider = new AnthropicProvider();
    const raw = [{ type: "text", text: "hello world" }];
    const result = (provider as any)._parseContent(raw);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("text");
    expect(result[0].text).toBe("hello world");
  });

  test("parse tool use", () => {
    const provider = new AnthropicProvider();
    const raw = [
      { type: "tool_use", id: "call_1", name: "read", input: { path: "/x" } },
    ];
    const result = (provider as any)._parseContent(raw);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("tool_use");
    expect(result[0].name).toBe("read");
  });

  test("map stop reason", () => {
    const provider = new AnthropicProvider();
    expect(provider._mapStopReason("end_turn")).toBe("end_turn");
    expect(provider._mapStopReason("max_tokens")).toBe("max_tokens");
    expect(provider._mapStopReason("tool_use")).toBe("tool_use");
    expect(provider._mapStopReason("stop_sequence")).toBe("stop_sequence");
    expect(provider._mapStopReason(null)).toBe("end_turn");
  });

  test("split system", () => {
    const provider = new AnthropicProvider();
    const messages: Message[] = [
      { role: SYSTEM, content: [{ type: "text", text: "you are helpful" }] },
      { role: USER, content: [{ type: "text", text: "hello" }] },
    ];
    const [system, apiMsgs] = (provider as any)._splitSystem(messages);
    expect(system).not.toBeNull();
    expect(system.length).toBe(1);
    expect(system[0].text).toBe("you are helpful");
    expect(apiMsgs.length).toBe(1);
    expect(apiMsgs[0].role).toBe("user");
  });

  test("split system no system", () => {
    const provider = new AnthropicProvider();
    const messages: Message[] = [
      { role: USER, content: [{ type: "text", text: "hello" }] },
    ];
    const [system, apiMsgs] = (provider as any)._splitSystem(messages);
    expect(system).toBeNull();
    expect(apiMsgs.length).toBe(1);
  });
});

// -- OpenAIProvider: response parsing ----------------------------------------

describe("OpenAIProvider", () => {
  test("map finish reason", () => {
    const provider = new OpenAIProvider();
    expect(provider._mapFinishReason("stop")).toBe("end_turn");
    expect(provider._mapFinishReason("length")).toBe("max_tokens");
    expect(provider._mapFinishReason("tool_calls")).toBe("tool_use");
    expect(provider._mapFinishReason(null)).toBe("end_turn");
  });
});
