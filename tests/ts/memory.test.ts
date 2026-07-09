import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadMemory, loadMemoryPrompt, setMemoryHomeDir, getProjectMemoryDir } from "../../src/memory/loader.ts";
import { maybeExtractMemories } from "../../src/memory/extractor.ts";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "wings-mem-home-"));
  setMemoryHomeDir(tmpHome);
});

function makeMemoryDir(wd: string, memoryName: string, type: string, body: string) {
  const memDir = getProjectMemoryDir(wd);
  mkdirSync(memDir, { recursive: true });
  const fileName = `${memoryName}.md`;
  const content = [
    "---", `name: ${memoryName}`, `description: test entry`, `type: ${type}`, "---", body,
  ].join("\n");
  writeFileSync(join(memDir, fileName), content);
  return fileName;
}

function writeMemoryIndex(wd: string, entries: Array<{ title: string; file: string }>) {
  const memDir = getProjectMemoryDir(wd);
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
    writeMemoryIndex(tmp, [{ title: "user_role", file: f1 }, { title: "feedback_testing", file: f2 }]);
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
  test("returns empty string when no MEMORY.md exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-mem-"));
    const prompt = loadMemoryPrompt(tmp);
    expect(prompt).toBe("");
  });

  test("returns guidance when MEMORY.md exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-mem-"));
    writeMemoryIndex(tmp, [{ title: "user_role", file: "user_role.md" }]);
    const prompt = loadMemoryPrompt(tmp);
    expect(prompt.startsWith("<system-reminder>")).toBe(true);
    expect(prompt.endsWith("</system-reminder>")).toBe(true);
    expect(prompt).toContain("user_role");
    expect(prompt).not.toContain("{memory_dir}");
  });
});

describe("maybeExtractMemories", () => {
  test("skips extraction and returns empty when there is no conversation text", async () => {
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
