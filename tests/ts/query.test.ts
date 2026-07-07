/**
 * Tests for the query engine and token budget.
 * Ported from tests/test_query.py.
 */

import { describe, test, expect } from "bun:test";

import { ASSISTANT, Message, USER, TextBlock, TextDelta, ToolResultBlock, ToolUseBlock } from "../../src/messages/types.ts";
import { makeModelConfig, type ModelProvider, type ModelResponse } from "../../src/models/protocol.ts";
import { ModelRegistry } from "../../src/models/registry.ts";
import { QueryEngine, QueryError } from "../../src/query/engine.ts";
import { TokenBudget } from "../../src/query/token_budget.ts";
import type { ModelSelector } from "../../src/routing/protocol.ts";

// -- TokenBudget --

describe("TokenBudget", () => {
  test("remaining", () => {
    const budget = new TokenBudget(100_000, { reservedForOutput: 4_000 });
    const messages: Message[] = [
      { role: USER, content: [{ type: "text", text: "hello" }] },
    ];
    expect(budget.remaining(messages)).toBeGreaterThan(90_000);
  });

  test("needsCompact false", () => {
    const budget = new TokenBudget(100_000);
    const messages: Message[] = [{ role: USER, content: [{ type: "text", text: "short" }] }];
    expect(budget.needsCompact(messages)).toBe(false);
  });

  test("needsCompact true", () => {
    const budget = new TokenBudget(100);
    const bigText = "x".repeat(10_000);
    const messages: Message[] = [{ role: USER, content: [{ type: "text", text: bigText }] }];
    expect(budget.needsCompact(messages)).toBe(true);
  });

  test("estimateTokens", () => {
    const budget = new TokenBudget(100_000);
    expect(budget.estimateTokens("x".repeat(400))).toBe(100);
  });

  test("estimateTokens short text", () => {
    const budget = new TokenBudget(100_000);
    expect(budget.estimateTokens("hi")).toBe(1);
  });

  test("system prompt", () => {
    const budget = new TokenBudget(100_000, { systemPromptTokens: 5_000 });
    const messages: Message[] = [{ role: USER, content: [{ type: "text", text: "hello" }] }];
    expect(budget.remaining(messages)).toBeLessThan(100_000 - 4_096 - 5_000);
  });

  test("tool messages", () => {
    const budget = new TokenBudget(100_000);
    const messages: Message[] = [
      { role: ASSISTANT, content: [{ type: "tool_use", id: "1", name: "read", input: {} }] },
      { role: USER, content: [{ type: "tool_result", tool_use_id: "1", content: "output" }] },
    ];
    expect(budget.remaining(messages)).toBeGreaterThan(0);
  });

  test("no messages", () => {
    const budget = new TokenBudget(100_000);
    expect(budget.remaining([])).toBe(100_000 - 4_096);
  });
});

// -- QueryEngine --

class MockSelector implements ModelSelector {
  select(_task_type: string, _override?: string | null): string {
    return "test/model";
  }
}

function makeMockProvider(opts: {
  responses?: any[];
  streamEvents?: any[];
} = {}): ModelProvider & { chatCalls: number } {
  let chatCallIndex = 0;
  const responses = opts.responses;
  const streamEvents = opts.streamEvents;
  let chatCalls = 0;
  return {
    provider_name: "mock",
    async chat() {
      chatCalls++;
      if (responses) {
        const r = responses[chatCallIndex++];
        if (r instanceof Error) throw r;
        return r as ModelResponse;
      }
      return {
        content: [{ type: "text", text: "hello from test" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
    async *stream() {
      if (streamEvents) {
        for (const e of streamEvents) yield e;
      } else {
        yield { type: "text_delta", text: "hello" } as any;
        yield { type: "text_delta", text: " world" } as any;
      }
    },
    get chatCalls() {
      return chatCalls;
    },
  } as any;
}

function makeEngine(): QueryEngine {
  const selector = new MockSelector();
  const registry = new ModelRegistry(selector);
  return new QueryEngine(registry);
}

describe("QueryEngine", () => {
  test("chat returns response", async () => {
    const engine = makeEngine();
    const provider = makeMockProvider();
    (engine as any)._registry.register("test/model", provider);

    const config = makeModelConfig({ model: "test/model", api_key: "sk-test" });
    const messages: Message[] = [{ role: USER, content: [{ type: "text", text: "hi" }] }];

    const result = await engine.chat(messages, "test/model", null, config);
    expect(result.stop_reason).toBe("end_turn");
    expect((result.content[0] as TextBlock).text).toBe("hello from test");
  });

  test("chat unknown model throws", async () => {
    const engine = makeEngine();
    const config = makeModelConfig({ model: "nonexistent", api_key: "sk-test" });
    const messages: Message[] = [{ role: USER, content: [{ type: "text", text: "hi" }] }];
    expect(engine.chat(messages, "nonexistent", null, config)).rejects.toThrow(/unknown model/);
  });

  test("stream yields events", async () => {
    const engine = makeEngine();
    const provider = makeMockProvider();
    (engine as any)._registry.register("test/model", provider);

    const config = makeModelConfig({ model: "test/model", api_key: "sk-test" });
    const messages: Message[] = [{ role: USER, content: [{ type: "text", text: "hi" }] }];

    const events: any[] = [];
    for await (const event of engine.stream(messages, "test/model", null, config)) {
      events.push(event);
    }
    expect(events.length).toBe(2);
    expect((events[0] as TextDelta).text).toBe("hello");
    expect((events[1] as TextDelta).text).toBe(" world");
  });

  test("stream unknown model throws", async () => {
    const engine = makeEngine();
    const config = makeModelConfig({ model: "nonexistent", api_key: "sk-test" });
    const messages: Message[] = [{ role: USER, content: [{ type: "text", text: "hi" }] }];
    let threw = false;
    try {
      for await (const _ of engine.stream(messages, "nonexistent", null, config)) {
        // drain
      }
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/unknown model/);
    }
    expect(threw).toBe(true);
  });

  test("retry on transient error", async () => {
    class TransientError extends Error {
      status_code = 503;
    }
    const provider = makeMockProvider({
      responses: [
        new TransientError(),
        new TransientError(),
        {
          content: [{ type: "text", text: "finally" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      ],
    });
    const engine = makeEngine();
    (engine as any)._maxRetries = 3;
    (engine as any)._retryBaseDelay = 0.001;
    (engine as any)._registry.register("test/model", provider);

    const config = makeModelConfig({ model: "test/model", api_key: "sk-test" });
    const messages: Message[] = [{ role: USER, content: [{ type: "text", text: "hi" }] }];

    const result = await engine.chat(messages, "test/model", null, config);
    expect((result.content[0] as TextBlock).text).toBe("finally");
    expect((provider as any).chatCalls).toBe(3);
  });

  test("retry exhausted raises QueryError", async () => {
    class ServerError extends Error {
      status_code = 500;
    }
    const provider = makeMockProvider({
      responses: [new ServerError(), new ServerError(), new ServerError(), new ServerError()],
    });
    const engine = makeEngine();
    (engine as any)._maxRetries = 3;
    (engine as any)._retryBaseDelay = 0.001;
    (engine as any)._registry.register("test/model", provider);

    const config = makeModelConfig({ model: "test/model", api_key: "sk-test" });
    const messages: Message[] = [{ role: USER, content: [{ type: "text", text: "hi" }] }];

    await expect(engine.chat(messages, "test/model", null, config)).rejects.toThrow(/chat failed/);
    expect((provider as any).chatCalls).toBe(4);
  });

  test("non-retriable error raises immediately", async () => {
    class AuthError extends Error {
      status_code = 401;
    }
    const provider = makeMockProvider({ responses: [new AuthError()] });
    const engine = makeEngine();
    (engine as any)._registry.register("test/model", provider);

    const config = makeModelConfig({ model: "test/model", api_key: "sk-test" });
    const messages: Message[] = [{ role: USER, content: [{ type: "text", text: "hi" }] }];

    await expect(engine.chat(messages, "test/model", null, config)).rejects.toThrow();
    expect((provider as any).chatCalls).toBe(1);
  });
});
