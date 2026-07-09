/** Tests for the hooks system — HookRunner parity with Python test_hooks.py. */

import { describe, test, expect } from "bun:test";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { HookRunner } from "../../src/hooks/runner.ts";

// Hooks use `spawn(shell: true)` → /bin/sh on Linux. Commands below are
// POSIX-sh compatible.

describe("HookRunner: no hooks", () => {
  test("hasHooks() is false when empty", () => {
    expect(new HookRunner({}).hasHooks()).toBe(false);
  });

  test("hasHooks() is true with PreToolUse", () => {
    expect(new HookRunner({ PreToolUse: [{ command: "true" }] }).hasHooks()).toBe(true);
  });

  test("runPreToolUse returns null when no hooks configured", async () => {
    const runner = new HookRunner({});
    expect(await runner.runPreToolUse("bash", { command: "ls" })).toBeNull();
  });
});

describe("HookRunner: allow / deny decisions", () => {
  test("exit 0 -> allow", async () => {
    const runner = new HookRunner({ PreToolUse: [{ command: "true" }] });
    expect(await runner.runPreToolUse("bash", { command: "ls" })).toBe("allow");
  });

  test("exit 2 -> deny", async () => {
    const runner = new HookRunner({ PreToolUse: [{ command: "exit 2" }] });
    expect(await runner.runPreToolUse("bash", { command: "rm -rf /" })).toBe("deny");
  });

  test("JSON stdout decision=allow", async () => {
    const runner = new HookRunner({
      PreToolUse: [{ command: "echo '{\"decision\":\"allow\",\"reason\":\"ok\"}'" }],
    });
    expect(await runner.runPreToolUse("read", { path: "/tmp" })).toBe("allow");
  });

  test("JSON stdout decision=deny", async () => {
    const runner = new HookRunner({
      PreToolUse: [{ command: "echo '{\"decision\":\"deny\",\"reason\":\"blocked\"}'" }],
    });
    expect(await runner.runPreToolUse("write", { path: "/etc/passwd" })).toBe("deny");
  });

  test("non-JSON exit-0 output -> allow", async () => {
    const runner = new HookRunner({ PreToolUse: [{ command: "echo hello" }] });
    expect(await runner.runPreToolUse("bash", {})).toBe("allow");
  });
});

describe("HookRunner: matcher", () => {
  test("skips non-matching tool (returns null)", async () => {
    const runner = new HookRunner({
      PreToolUse: [{ command: "exit 2", matcher: "^bash$" }],
    });
    // 'read' does not match ^bash$ — hook does not fire.
    expect(await runner.runPreToolUse("read", { path: "/tmp" })).toBeNull();
  });

  test("fires for matching tool", async () => {
    const runner = new HookRunner({
      PreToolUse: [{ command: "exit 2", matcher: "^bash$" }],
    });
    expect(await runner.runPreToolUse("bash", { command: "ls" })).toBe("deny");
  });
});

describe("HookRunner: parallel aggregation", () => {
  test("any deny wins over an allow hook", async () => {
    // Two hooks: one allows (exit 0), one denies (exit 2). Order is fixed
    // here but Promise.all runs them concurrently; deny must win regardless.
    const runner = new HookRunner({
      PreToolUse: [
        { command: "true" },
        { command: "exit 2" },
      ],
    });
    expect(await runner.runPreToolUse("bash", {})).toBe("deny");
  });

  test("all-allow hooks -> allow", async () => {
    const runner = new HookRunner({
      PreToolUse: [{ command: "true" }, { command: "true" }],
    });
    expect(await runner.runPreToolUse("bash", {})).toBe("allow");
  });
});

describe("HookRunner: stdin payload", () => {
  test("receives JSON {tool_name, tool_input} on stdin", async () => {
    const tmpFile = join(tmpdir(), `wings-hook-stdin-${randomUUID()}.txt`);
    // `cat` copies stdin (the JSON payload) into the temp file, then exits 0.
    const runner = new HookRunner({
      PreToolUse: [{ command: `cat > ${tmpFile}` }],
    });
    await runner.runPreToolUse("bash", { command: "ls -la" });

    expect(existsSync(tmpFile)).toBe(true);
    const captured = readFileSync(tmpFile, "utf-8");
    const parsed = JSON.parse(captured);
    expect(parsed["tool_name"]).toBe("bash");
    expect(parsed["tool_input"]).toEqual({ command: "ls -la" });
    unlinkSync(tmpFile);
  });

  test("PostToolUse payload includes tool_result", async () => {
    const tmpFile = join(tmpdir(), `wings-hook-post-${randomUUID()}.txt`);
    const runner = new HookRunner({
      PostToolUse: [{ command: `cat > ${tmpFile}` }],
    });
    await runner.runPostToolUse("bash", { command: "ls" }, "file1\nfile2");

    expect(existsSync(tmpFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(tmpFile, "utf-8"));
    expect(parsed["tool_result"]).toBe("file1\nfile2");
    expect(parsed["tool_name"]).toBe("bash");
    unlinkSync(tmpFile);
  });
});

describe("HookRunner: post-tool-use", () => {
  test("runs without error (fire-and-forget)", async () => {
    const runner = new HookRunner({ PostToolUse: [{ command: "true" }] });
    await expect(runner.runPostToolUse("bash", { command: "ls" }, "output")).resolves.toBeUndefined();
  });
});
