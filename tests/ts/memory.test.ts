import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadMemory } from "../../src/memory/loader.ts";

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
