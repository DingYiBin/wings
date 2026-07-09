import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadMemory, loadMemoryPrompt } from "../../src/memory/loader.ts";
import { maybeExtractMemories } from "../../src/memory/extractor.ts";

function makeMemoryDir(base: string, memoryName: string, type: string, body: string) {
  const memDir = join(base, ".wings", "memory");
  mkdirSync(memDir, { recursive: true });
  const fileName = `${memoryName}.md`;
  const content = [
    "---",
    `name: ${memoryName}`,
    `description: test entry`,
    `type: ${type}`,
    "---",
    body,
  ].join("\n");
  writeFileSync(join(memDir, fileName), content);
  return fileName;
}

function writeMemoryIndex(base: string, entries: Array<{ title: string; file: string }>) {
  const memDir = join(base, ".wings", "memory");
  mkdirSync(memDir, { recursive: true });
  const lines = entries.map((e) => `- [${e.title}](${e.file})`).join("\n");
  writeFileSync(join(memDir, "MEMORY.md"), lines);
}

describe("loadMemory", () => {
  test("returns empty for non-existent dir", () => {
    const result = loadMemory("/nonexistent/path");
    expect(result.entries.length).toBe(0);
  });

  test("parses MEMORY.md index", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-mem-"));
    const fileName = makeMemoryDir(tmp, "user_role", "user", "I am a developer.");
    writeMemoryIndex(tmp, [{ title: "user_role", file: fileName }]);

    const result = loadMemory(tmp);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]!.name).toBe("user_role");
    expect(result.entries[0]!.type).toBe("user");
    expect(result.content["user_role"]!.body).toBe("I am a developer.");
  });

  test("parses multiple entries", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-mem-"));
    const f1 = makeMemoryDir(tmp, "user_role", "user", "dev");
    const f2 = makeMemoryDir(tmp, "feedback_testing", "feedback", "use real DB");
    writeMemoryIndex(tmp, [
      { title: "user_role", file: f1 },
      { title: "feedback_testing", file: f2 },
    ]);

    const result = loadMemory(tmp);
    expect(result.entries.length).toBe(2);
  });

  test("skips invalid type", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-mem-"));
    const fileName = makeMemoryDir(tmp, "bad_entry", "invalid_type", "body");
    writeMemoryIndex(tmp, [{ title: "bad_entry", file: fileName }]);

    const result = loadMemory(tmp);
    expect(result.entries.length).toBe(0);
  });
});

describe("loadMemoryPrompt", () => {
  test("creates memory dir and returns guidance with placeholder substituted", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-mem-"));
    const prompt = loadMemoryPrompt(tmp);
    // Guidance is wrapped in a system-reminder block.
    expect(prompt.startsWith("<system-reminder>")).toBe(true);
    expect(prompt.endsWith("</system-reminder>")).toBe(true);
    // The {memory_dir} placeholder must be fully replaced with the real path.
    expect(prompt).not.toContain("{memory_dir}");
    expect(prompt).toContain(tmp);
    // The memory directory was created.
    expect(existsSync(join(tmp, ".wings", "memory"))).toBe(true);
  });

  test("appends MEMORY.md index content when present", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-mem-"));
    writeMemoryIndex(tmp, [{ title: "user_role", file: "user_role.md" }]);
    const prompt = loadMemoryPrompt(tmp);
    expect(prompt).toContain("user_role");
    expect(prompt).toContain("- [user_role](user_role.md)");
  });
});

describe("maybeExtractMemories", () => {
  test("skips extraction and returns empty when there is no conversation text", async () => {
    // Empty/whitespace input must short-circuit before touching a subagent,
    // so no engine/registry wiring is required here.
    const opts = {
      workingDir: mkdtempSync(join(tmpdir(), "wings-mem-")),
      queryEngine: null as never,
      modelRegistry: null as never,
      toolRegistry: null as never,
      modelSelector: null as never,
    };
    await expect(maybeExtractMemories("", opts)).resolves.toBe("");
    await expect(maybeExtractMemories("   \n  ", opts)).resolves.toBe("");
  });
});
