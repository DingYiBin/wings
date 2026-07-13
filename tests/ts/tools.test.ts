/**
 * Tests for the tools module — protocol, registry, builtins.
 *
 * Ported from tests/test_tools.py.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTool,
  makeToolContext,
  makeToolResult,
  type Tool,
  type ToolContext,
} from "../../src/tools/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { readTool } from "../../src/tools/builtin/read.ts";
import { writeTool } from "../../src/tools/builtin/write.ts";
import { editTool } from "../../src/tools/builtin/edit.ts";
import { bashTool } from "../../src/tools/builtin/bash.ts";
import { globTool } from "../../src/tools/builtin/glob.ts";
import { grepTool } from "../../src/tools/builtin/grep.ts";
import { z } from "zod";

// -- helpers --

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wings-tools-"));
});

function ctx(): ToolContext {
  return makeToolContext({ working_dir: tmpDir });
}

async function call(tool: Tool, input: unknown, context: ToolContext) {
  return tool.call(input, context);
}

// -- ToolResult / ToolContext --

describe("ToolResult / ToolContext", () => {
  test("tool result defaults", () => {
    const r = makeToolResult({ output: "done" });
    expect(r.output).toBe("done");
    expect(r.error).toBeNull();
  });

  test("tool result with error", () => {
    const r = makeToolResult({ output: "", error: "permission denied" });
    expect(r.error).toBe("permission denied");
  });

  test("tool context", () => {
    const c = makeToolContext({ working_dir: "/tmp", session_id: "s1" });
    expect(c.working_dir).toBe("/tmp");
  });
});

// -- ToolRegistry --

class FakeTool implements Tool {
  name = "fake";
  description = "a fake tool";
  search_hint = "fake";
  private _enabled: boolean = true;
  constructor(enabled: boolean = true) {
    this._enabled = enabled;
  }
  inputSchema() {
    return { type: "object", properties: { x: { type: "string" } } };
  }
  async call() {
    return makeToolResult({ output: "ok" });
  }
  isEnabled() {
    return this._enabled;
  }
  isReadOnly() {
    return true;
  }
  isDestructive() {
    return false;
  }
  renderResult(result: { output: string }) {
    return result.output;
  }
  activityDescription() {
    return "faking...";
  }
}

describe("ToolRegistry", () => {
  test("register and get", () => {
    const reg = new ToolRegistry();
    const t = new FakeTool();
    reg.register(t);
    expect(reg.get("fake")).toBe(t);
  });

  test("get missing", () => {
    expect(new ToolRegistry().get("nope")).toBeUndefined();
  });

  test("listAll", () => {
    const reg = new ToolRegistry();
    reg.register(new FakeTool());
    expect(reg.listAll().length).toBe(1);
  });

  test("listEnabled", () => {
    const reg = new ToolRegistry();
    const t1 = new FakeTool(true);
    const t2 = new FakeTool(false);
    t2.name = "fake2";
    reg.register(t1);
    reg.register(t2);
    expect(reg.listEnabled().length).toBe(1);
  });

  test("getSchemas", () => {
    const reg = new ToolRegistry();
    reg.register(new FakeTool());
    const schemas = reg.getSchemas();
    expect(schemas.length).toBe(1);
    expect(schemas[0]!["name"]).toBe("fake");
    expect("input_schema" in schemas[0]!).toBe(true);
  });

  test("filterDenied", () => {
    const reg = new ToolRegistry();
    reg.register(new FakeTool());
    reg.filterDenied(["fake"]);
    expect(reg.get("fake")).toBeUndefined();
  });
});

// -- buildTool --

describe("buildTool", () => {
  test("basic", () => {
    const t = buildTool({
      name: "my_tool",
      description: "desc",
      search_hint: "hint",
      is_read_only: true,
      inputSchema: z.object({ text: z.string() }),
      async call(input) {
        return `got: ${input.text}`;
      },
    });
    expect(t.name).toBe("my_tool");
    expect(t.isReadOnly()).toBe(true);
    expect(t.isEnabled()).toBe(true);
    expect(JSON.stringify(t.inputSchema())).toContain("text");
  });

  test("call returns string → ToolResult", async () => {
    const t = buildTool({
      name: "doubler",
      description: "",
      search_hint: "",
      inputSchema: z.object({ value: z.number() }),
      async call(input) {
        return String(input.value * 2);
      },
    });
    const result = await t.call({ value: 5 }, ctx());
    expect(result.output).toBe("10");
  });
});

// -- read --

describe("read tool", () => {
  test("file content", async () => {
    const f = join(tmpDir, "test.txt");
    writeFileSync(f, "line one\nline two\nline three\n");
    const result = await call(readTool, { file_path: f }, ctx());
    expect(result.output).toContain("line one");
    expect(result.output).toContain("line two");
  });

  test("with offset", async () => {
    const f = join(tmpDir, "test.txt");
    writeFileSync(f, "line one\nline two\nline three\n");
    const result = await call(readTool, { file_path: f, offset: 2 }, ctx());
    expect(result.output).not.toContain("line one");
    expect(result.output).toContain("line two");
  });

  test("not found", async () => {
    const result = await call(readTool, { file_path: join(tmpDir, "nope.txt") }, ctx());
    expect(result.output).toContain("Error: file not found");
  });

  test("is directory", async () => {
    const result = await call(readTool, { file_path: tmpDir }, ctx());
    expect(result.output).toContain("Error: path is a directory");
  });

  test("attrs", () => {
    expect(readTool.name).toBe("read");
    expect(readTool.isReadOnly()).toBe(true);
    expect(readTool.isEnabled()).toBe(true);
  });
});

// -- write --

describe("write tool", () => {
  test("write file", async () => {
    const f = join(tmpDir, "out.txt");
    const result = await call(writeTool, { file_path: f, content: "hello world" }, ctx());
    expect(result.output).toContain("Wrote");
    expect(result.output).toContain("hello world");
    expect(await Bun.file(f).text()).toBe("hello world");
  });

  test("creates parent dirs", async () => {
    const f = join(tmpDir, "deep", "nested", "file.txt");
    await call(writeTool, { file_path: f, content: "deep" }, ctx());
    expect(await Bun.file(f).text()).toBe("deep");
  });

  test("attrs", () => {
    expect(writeTool.name).toBe("write");
    expect(writeTool.isDestructive()).toBe(true);
  });
});

// -- edit --

describe("edit tool", () => {
  test("edit file", async () => {
    const f = join(tmpDir, "edit.txt");
    writeFileSync(f, "hello world\n");
    const c = ctx();
    c.read_cache[f] = statSync(f).mtimeMs / 1000;
    const result = await call(editTool, { file_path: f, old_string: "hello", new_string: "goodbye" }, c);
    expect(result.output).toContain("Added");
    expect(result.output).toContain("removed");
    expect(await Bun.file(f).text()).toBe("goodbye world\n");
  });

  test("same string error", async () => {
    const f = join(tmpDir, "edit.txt");
    writeFileSync(f, "hello\n");
    const result = await call(editTool, { file_path: f, old_string: "hello", new_string: "hello" }, ctx());
    expect(result.output).toContain("Error");
  });

  test("duplicate no replace_all", async () => {
    const f = join(tmpDir, "edit.txt");
    writeFileSync(f, "hello world hello\n");
    const c = ctx();
    c.read_cache[f] = statSync(f).mtimeMs / 1000;
    const result = await call(editTool, { file_path: f, old_string: "hello", new_string: "bye" }, c);
    expect(result.output).toContain("appears 2 times");
  });

  test("replace_all", async () => {
    const f = join(tmpDir, "edit.txt");
    writeFileSync(f, "hello world hello\n");
    const c = ctx();
    c.read_cache[f] = statSync(f).mtimeMs / 1000;
    const result = await call(editTool, { file_path: f, old_string: "hello", new_string: "bye", replace_all: true }, c);
    expect(result.output).toContain("2 occurrence");
    expect(await Bun.file(f).text()).toBe("bye world bye\n");
  });

  test("attrs", () => {
    expect(editTool.name).toBe("edit");
    expect(editTool.isReadOnly()).toBe(false);
    expect(editTool.isDestructive()).toBe(true);
  });
});

// -- bash --

describe("bash tool", () => {
  test("echo", async () => {
    const result = await call(bashTool, { command: "echo hello" }, ctx());
    expect(result.output).toContain("hello");
  });

  test("nonzero exit", async () => {
    const result = await call(bashTool, { command: "exit 1" }, ctx());
    expect(result.output).toContain("exit code: 1");
  });

  test("attrs", () => {
    expect(bashTool.name).toBe("bash");
    expect(bashTool.isDestructive()).toBe(true);
  });
});

// -- glob --

describe("glob tool", () => {
  test("finds files", async () => {
    writeFileSync(join(tmpDir, "a.py"), "");
    writeFileSync(join(tmpDir, "b.py"), "");
    writeFileSync(join(tmpDir, "c.txt"), "");
    const result = await call(globTool, { pattern: "*.py" }, ctx());
    expect(result.output).toContain("a.py");
    expect(result.output).toContain("b.py");
    expect(result.output).not.toContain("c.txt");
  });

  test("no matches", async () => {
    const result = await call(globTool, { pattern: "*.rs" }, ctx());
    expect(result.output.toLowerCase()).toMatch(/matches|no files matched/);
  });

  test("attrs", () => {
    expect(globTool.name).toBe("glob");
    expect(globTool.isReadOnly()).toBe(true);
  });
});

// -- grep --

describe("grep tool", () => {
  test("finds pattern", async () => {
    writeFileSync(join(tmpDir, "test.py"), "def foo():\n    pass\n");
    const result = await call(grepTool, { pattern: "def foo", path: tmpDir }, ctx());
    expect(result.output).toContain("def foo");
  });

  test("files_with_matches", async () => {
    writeFileSync(join(tmpDir, "a.py"), "def foo():\n    pass\n");
    writeFileSync(join(tmpDir, "b.py"), "def bar():\n    pass\n");
    const result = await call(grepTool, { pattern: "def foo", path: tmpDir, output_mode: "files_with_matches" }, ctx());
    expect(result.output).toContain("a.py");
    expect(result.output).not.toContain("b.py");
  });

  test("count", async () => {
    writeFileSync(join(tmpDir, "a.py"), "foo foo foo\n");
    const result = await call(grepTool, { pattern: "foo", path: tmpDir, output_mode: "count" }, ctx());
    expect(result.output).toContain(":3");
  });

  test("no matches", async () => {
    writeFileSync(join(tmpDir, "a.py"), "hello\n");
    const result = await call(grepTool, { pattern: "xyzzy_nonexistent", path: tmpDir }, ctx());
    expect(result.output.toLowerCase()).toMatch(/matches|no files matched/);
  });

  test("invalid regex", async () => {
    const result = await call(grepTool, { pattern: "[invalid", path: tmpDir }, ctx());
    expect(result.output).toContain("Error: invalid regex");
  });

  test("**/*.py glob matches files in subdirectories", async () => {
    mkdirSync(join(tmpDir, "sub"), { recursive: true });
    writeFileSync(join(tmpDir, "sub", "deep.py"), "target line\n");
    writeFileSync(join(tmpDir, "top.txt"), "target line\n");
    const result = await call(grepTool, { pattern: "target", path: tmpDir, glob: "**/*.py" }, ctx());
    expect(result.output).toContain("deep.py");
    expect(result.output).not.toContain("top.txt");
  });

  test("*.py glob matches only top level (not subdirectories)", async () => {
    mkdirSync(join(tmpDir, "lvl2"), { recursive: true });
    writeFileSync(join(tmpDir, "root.py"), "target line\n");
    writeFileSync(join(tmpDir, "lvl2", "nested.py"), "target line\n");
    const result = await call(grepTool, { pattern: "target", path: tmpDir, glob: "*.py" }, ctx());
    expect(result.output).toContain("root.py");
    expect(result.output).not.toContain("nested.py");
  });
});
