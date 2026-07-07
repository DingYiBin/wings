/**
 * Tests for the compaction service.
 * Ported from tests/test_compact.py.
 */

import { describe, test, expect } from "bun:test";

import type { Message } from "../../src/messages/types.ts";
import { makeModelConfig } from "../../src/models/protocol.ts";
import { compactMessages } from "../../src/services/compact.ts";
import type { QueryEngine } from "../../src/query/engine.ts";

function makeMessages(n: number, opts: { withSystem?: boolean } = {}): Message[] {
  const withSystem = opts.withSystem ?? true;
  const msgs: Message[] = [];
  if (withSystem) {
    msgs.push({ role: "system", content: [{ type: "text", text: "system prompt" }] });
  }
  for (let i = 0; i < n; i++) {
    const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
    msgs.push({ role, content: [{ type: "text", text: `message ${i}` }] });
  }
  return msgs;
}

function makeEngineWithSummary(summaryText: string): QueryEngine {
  async function* stream() {
    yield { type: "text_delta", text: summaryText };
  }
  const engine: any = {
    stream,
    chat: async () => ({ content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }),
  };
  return engine;
}

// -- messagesToText (indirectly tested via compactMessages) --

describe("compactMessages", () => {
  test("preserves system prompt", async () => {
    const engine = makeEngineWithSummary("summary text");
    const msgs = makeMessages(20);
    const config = makeModelConfig({ model: "test/model", api_key: "sk-test" });

    const result = await compactMessages(msgs, {
      queryEngine: engine,
      model: "test/model",
      config,
    });
    expect(result[0]!.role).toBe("system");
    expect((result[0]!.content[0] as any).text).toBe("system prompt");
  });

  test("preserves recent messages", async () => {
    const engine = makeEngineWithSummary("summary text");
    const msgs = makeMessages(20);
    const config = makeModelConfig({ model: "test/model", api_key: "sk-test" });

    const result = await compactMessages(msgs, {
      queryEngine: engine,
      model: "test/model",
      config,
      keepRecent: 4,
    });

    // Last 4 messages of the original (excluding system) should be at the end.
    const recentOriginal = msgs.slice(-4);
    const recentResult = result.slice(-4);
    for (let i = 0; i < 4; i++) {
      expect(recentResult[i]!.role).toBe(recentOriginal[i]!.role);
      expect((recentResult[i]!.content[0] as any).text).toBe((recentOriginal[i]!.content[0] as any).text);
    }
  });

  test("inserts summary message", async () => {
    const engine = makeEngineWithSummary("This is the summary.");
    const msgs = makeMessages(20);
    const config = makeModelConfig({ model: "test/model", api_key: "sk-test" });

    const result = await compactMessages(msgs, {
      queryEngine: engine,
      model: "test/model",
      config,
      keepRecent: 4,
    });

    // Structure: [system, summary, *4 recent]
    expect(result.length).toBe(6);
    expect(result[0]!.role).toBe("system");
    expect(result[1]!.role).toBe("user");
    expect((result[1]!.content[0] as any).text).toContain("This is the summary.");
  });

  test("skips when too few messages", async () => {
    const engine = makeEngineWithSummary("summary");
    const msgs = makeMessages(4);
    const config = makeModelConfig({ model: "test/model", api_key: "sk-test" });

    const result = await compactMessages(msgs, {
      queryEngine: engine,
      model: "test/model",
      config,
    });
    expect(result).toBe(msgs); // same reference
  });
});
