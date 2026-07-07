/** Tests for the messages module. */

import { describe, expect, test } from "bun:test";
import {
  MessageNormalizer,
  TextDelta,
  fromAnthropic,
  fromOpenAI,
  isTextBlock,
  isToolResultBlock,
  isToolUseBlock,
  normalizer,
  toAnthropic,
  toOpenAI,
  toOpenAIMessages,
} from "../../src/messages/index.ts";
import type {
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../../src/messages/types.ts";

// -- Message construction & type guards -------------------------------------

describe("message types", () => {
  test("user text message", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(1);
    expect((msg.content[0] as TextBlock).text).toBe("hello");
  });

  test("tool use and result", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "tool_use", id: "1", name: "read", input: { path: "/tmp/x" } },
        { type: "tool_result", tool_use_id: "1", content: "file contents" },
      ],
    };
    expect(msg.content).toHaveLength(2);
    const toolUse = msg.content[0] as ToolUseBlock;
    expect(isToolUseBlock(toolUse)).toBe(true);
    expect(toolUse.name).toBe("read");
    expect(toolUse.input).toEqual({ path: "/tmp/x" });

    const toolResult = msg.content[1] as ToolResultBlock;
    expect(isToolResultBlock(toolResult)).toBe(true);
    expect(toolResult.tool_use_id).toBe("1");
  });

  test("tool result error flag", () => {
    const result: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "2",
      content: "Permission denied",
      is_error: true,
    };
    expect(result.is_error).toBe(true);
  });

  test("message JSON round-trip", () => {
    const msg: Message = {
      role: "system",
      content: [{ type: "text", text: "system prompt" }],
    };
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json) as Message;
    expect(parsed.role).toBe("system");
    expect(parsed.content[0]!.type).toBe("text");
  });

  test("tool_use blocks round-trip through JSON", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "grep", input: { pattern: "foo" } },
      ],
    };
    const parsed = JSON.parse(JSON.stringify(msg)) as Message;
    expect((parsed.content[0] as ToolUseBlock).name).toBe("grep");
  });
});

// -- MessageNormalizer dispatch ---------------------------------------------

describe("MessageNormalizer", () => {
  test("to_internal anthropic", () => {
    const raw = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const msgs = normalizer.toInternal("anthropic", raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
  });

  test("to_internal openai", () => {
    const raw = [{ role: "user", content: "hello" }];
    const msgs = normalizer.toInternal("openai", raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
  });

  test("to_provider anthropic", () => {
    const msg: Message = { role: "user", content: [{ type: "text", text: "hello" }] };
    const raw = normalizer.toProvider("anthropic", [msg]);
    expect(raw[0]!["role"]).toBe("user");
  });

  test("to_provider openai", () => {
    const msg: Message = { role: "user", content: [{ type: "text", text: "hello" }] };
    const raw = normalizer.toProvider("openai", [msg]);
    expect(raw[0]!["role"]).toBe("user");
  });

  test("unsupported provider throws", () => {
    expect(() => normalizer.toInternal("unsupported", [])).toThrow(
      /unsupported provider/,
    );
  });

  test("normalizer is MessageNormalizer instance", () => {
    expect(normalizer).toBeInstanceOf(MessageNormalizer);
  });
});

// -- Anthropic round-trip ---------------------------------------------------

describe("anthropic round-trip", () => {
  test("user text", () => {
    const raw = { role: "user", content: [{ type: "text", text: "hello" }] };
    const msg = fromAnthropic(raw);
    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(1);
    expect(isTextBlock(msg.content[0]!)).toBe(true);
    expect((msg.content[0] as TextBlock).text).toBe("hello");
  });

  test("assistant tool_use", () => {
    const raw = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "read", input: { path: "/tmp/x" } },
      ],
    };
    const msg = fromAnthropic(raw);
    expect(msg.role).toBe("assistant");
    const block = msg.content[0] as ToolUseBlock;
    expect(isToolUseBlock(block)).toBe(true);
    expect(block.name).toBe("read");
    expect(block.input).toEqual({ path: "/tmp/x" });
  });

  test("user tool_result", () => {
    const raw = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "some output" },
      ],
    };
    const msg = fromAnthropic(raw);
    const block = msg.content[0] as ToolResultBlock;
    expect(isToolResultBlock(block)).toBe(true);
    expect(block.tool_use_id).toBe("call_1");
    expect(block.content).toBe("some output");
  });

  test("text content as plain string", () => {
    const raw = { role: "assistant", content: "just a string" };
    const msg = fromAnthropic(raw);
    expect(isTextBlock(msg.content[0]!)).toBe(true);
    expect((msg.content[0] as TextBlock).text).toBe("just a string");
  });

  test("to_anthropic text", () => {
    const msg: Message = { role: "user", content: [{ type: "text", text: "hello" }] };
    const raw = toAnthropic(msg);
    expect(raw["role"]).toBe("user");
    expect(raw["content"]).toEqual([{ type: "text", text: "hello" }]);
  });

  test("to_anthropic tool_use", () => {
    const msg: Message = {
      role: "assistant",
      content: [{ type: "tool_use", id: "1", name: "read", input: { path: "/x" } }],
    };
    const raw = toAnthropic(msg);
    const block = raw["content"][0];
    expect(block["type"]).toBe("tool_use");
    expect(block["name"]).toBe("read");
  });

  test("to_anthropic tool_result", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "1", content: "done", is_error: true },
      ],
    };
    const raw = toAnthropic(msg);
    const block = raw["content"][0];
    expect(block["type"]).toBe("tool_result");
    expect(block["is_error"]).toBe(true);
  });

  test("flattens list-form tool result content", () => {
    const raw = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "2",
          content: [
            { type: "text", text: "line one " },
            { type: "text", text: "line two" },
          ],
        },
      ],
    };
    const msg = fromAnthropic(raw);
    const block = msg.content[0] as ToolResultBlock;
    expect(block.content).toBe("line one line two");
  });
});

// -- OpenAI round-trip ------------------------------------------------------

describe("openai round-trip", () => {
  test("user text string", () => {
    const raw = { role: "user", content: "hello" };
    const msg = fromOpenAI(raw);
    expect(msg.role).toBe("user");
    expect((msg.content[0] as TextBlock).text).toBe("hello");
  });

  test("assistant with tool_calls", () => {
    const raw = {
      role: "assistant",
      content: "let me check",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: '{"path": "/x"}' },
        },
      ],
    };
    const msg = fromOpenAI(raw);
    expect(msg.role).toBe("assistant");
    const texts = msg.content.filter(isTextBlock);
    const tools = msg.content.filter(isToolUseBlock);
    expect(texts[0]!.text).toBe("let me check");
    expect(tools[0]!.name).toBe("read");
    expect(tools[0]!.input).toEqual({ path: "/x" });
  });

  test("tool result", () => {
    const raw = { role: "tool", tool_call_id: "call_1", content: "file content" };
    const msg = fromOpenAI(raw);
    const block = msg.content[0] as ToolResultBlock;
    expect(isToolResultBlock(block)).toBe(true);
    expect(block.tool_use_id).toBe("call_1");
    expect(block.content).toBe("file content");
  });

  test("tool_calls with invalid JSON", () => {
    const raw = {
      role: "assistant",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "f", arguments: "not json" },
        },
      ],
    };
    const msg = fromOpenAI(raw);
    const tool = msg.content.filter(isToolUseBlock)[0]!;
    expect(tool.input).toEqual({});
  });

  test("to_openai text", () => {
    const msg: Message = { role: "user", content: [{ type: "text", text: "hi" }] };
    const raw = toOpenAI(msg);
    expect(raw).toEqual({ role: "user", content: "hi" });
  });

  test("to_openai tool_result", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }],
    };
    const raw = toOpenAI(msg);
    expect(raw["role"]).toBe("tool");
    expect(raw["tool_call_id"]).toBe("c1");
  });

  test("to_openai_messages flat", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "read /tmp/x" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "1", name: "read", input: { path: "/tmp/x" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "1", content: "hello world" }],
      },
    ];
    const openaiMsgs = toOpenAIMessages(msgs);
    expect(openaiMsgs[0]).toEqual({ role: "user", content: "read /tmp/x" });
    expect(openaiMsgs[1]!["role"]).toBe("assistant");
    expect(openaiMsgs[1]!["tool_calls"][0]["function"]["name"]).toBe("read");
    expect(openaiMsgs[2]).toEqual({
      role: "tool",
      tool_call_id: "1",
      content: "hello world",
    });
  });
});

// Unused import guard (ensures TextDelta re-export is wired)
test("TextDelta type is accessible", () => {
  const d: TextDelta = { type: "text_delta", text: "x" };
  expect(d.type).toBe("text_delta");
});
