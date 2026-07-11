/**
 * Tests for restoring the visible transcript when resuming a session.
 */

import { describe, test, expect } from "bun:test";
import { messagesToOutputLines } from "../../src/cli/app-state.ts";

describe("messagesToOutputLines", () => {
  test("restores user input, assistant text, tool use and result", () => {
    const msgs = [
      { role: "system", content: [{ type: "text", text: "system prompt" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi there" },
          { type: "tool_use", id: "1", name: "read", input: { file_path: "/a" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "file body", is_error: false }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const out = messagesToOutputLines(msgs as any);

    // System prompt is never shown.
    expect(out.some((l) => l.type === "text" && l.text.includes("system prompt"))).toBe(false);
    // User input echoed with the prompt marker.
    expect(out.some((l) => l.type === "text" && l.text === "❯ hello")).toBe(true);
    // Assistant text keeps the ● marker.
    expect(out.some((l) => l.type === "text" && l.text === "● hi there")).toBe(true);
    // Tool use restored with its name.
    const tu = out.find((l) => l.type === "tool_use") as any;
    expect(tu?.name).toBe("read");
    expect(tu?.input).toContain("/a");
    // Tool result restored with its content.
    const tr = out.find((l) => l.type === "tool_result") as any;
    expect(tr?.content).toBe("file body");
    expect(tr?.isError).toBe(false);
  });

  test("skips thinking blocks and empty text", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "answer" }] },
    ];
    const out = messagesToOutputLines(msgs as any);
    expect(out.length).toBe(1);
    expect((out[0] as any).text).toBe("● answer");
  });

  test("marks a tool_result error and stringifies non-string content", () => {
    const msgs = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: { a: 1 }, is_error: true }] },
    ];
    const out = messagesToOutputLines(msgs as any);
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe("tool_result");
    expect((out[0] as any).isError).toBe(true);
    expect((out[0] as any).content).toBe('{"a":1}');
  });

  test("empty history yields no lines", () => {
    expect(messagesToOutputLines([]).length).toBe(0);
  });
});
