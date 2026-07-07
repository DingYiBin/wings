/**
 * Tests for the permission system — rules and pipeline.
 * Ported from tests/test_permissions.py.
 */

import { describe, test, expect } from "bun:test";

import { PermissionRules } from "../../src/permissions/rules.ts";
import { PermissionPipeline, type HookRunner } from "../../src/permissions/pipeline.ts";
import { makeToolContext, type Tool, type ToolContext, type ToolResult } from "../../src/tools/types.ts";
import { makeToolResult } from "../../src/tools/types.ts";

// -- PermissionRules --

describe("PermissionRules", () => {
  test("allowlist match", () => {
    const rules = new PermissionRules({ allowlist: ["read"] });
    expect(rules.match("read")).toBe("allow");
  });

  test("denylist priority", () => {
    const rules = new PermissionRules({ allowlist: ["bash"], denylist: ["bash"] });
    expect(rules.match("bash")).toBe("deny");
  });

  test("asklist", () => {
    const rules = new PermissionRules({ asklist: ["write"] });
    expect(rules.match("write")).toBe("ask");
  });

  test("default ask", () => {
    const rules = new PermissionRules();
    expect(rules.match("unknown_tool")).toBe("ask");
  });

  test("addAllow", () => {
    const rules = new PermissionRules();
    rules.addAllow("read");
    expect(rules.match("read")).toBe("allow");
  });

  test("addDeny", () => {
    const rules = new PermissionRules();
    rules.addDeny("rm");
    expect(rules.match("rm")).toBe("deny");
  });

  test("fromConfig", () => {
    const config = {
      allowlist: ["read", "glob"],
      denylist: ["rm"],
      asklist: ["write"],
    };
    const rules = PermissionRules.fromConfig(config);
    expect(rules.match("read")).toBe("allow");
    expect(rules.match("rm")).toBe("deny");
    expect(rules.match("write")).toBe("ask");
  });
});

// -- PermissionPipeline --

class TestTool implements Tool {
  name: string;
  description = "";
  search_hint = "";
  private _readOnly: boolean;
  private _destructive: boolean;
  constructor(name: string, readOnly = false, destructive = false) {
    this.name = name;
    this._readOnly = readOnly;
    this._destructive = destructive;
  }
  inputSchema() {
    return {};
  }
  async call(): Promise<ToolResult> {
    return makeToolResult({ output: "ok" });
  }
  isEnabled() {
    return true;
  }
  isReadOnly() {
    return this._readOnly;
  }
  isDestructive() {
    return this._destructive;
  }
  renderResult(result: ToolResult) {
    return result.output;
  }
  activityDescription() {
    return this.name;
  }
}

function ctx(): ToolContext {
  return makeToolContext({ working_dir: "/tmp" });
}

describe("PermissionPipeline", () => {
  test("stage1 deny", async () => {
    const rules = new PermissionRules({ denylist: ["rm"] });
    const pipeline = new PermissionPipeline(rules);
    expect(await pipeline.check(new TestTool("rm"), null, ctx())).toBe("deny");
  });

  test("stage1 allow", async () => {
    const rules = new PermissionRules({ allowlist: ["read"] });
    const pipeline = new PermissionPipeline(rules);
    expect(await pipeline.check(new TestTool("read"), null, ctx())).toBe("allow");
  });

  test("stage2 read-only auto allow", async () => {
    const rules = new PermissionRules();
    const pipeline = new PermissionPipeline(rules);
    expect(await pipeline.check(new TestTool("glob", true), null, ctx())).toBe("allow");
  });

  test("stage2 destructive not auto allow", async () => {
    const rules = new PermissionRules();
    const pipeline = new PermissionPipeline(rules);
    expect(await pipeline.check(new TestTool("rm", false, true), null, ctx())).toBe("ask");
  });

  test("stage3 hook allows", async () => {
    const rules = new PermissionRules();
    const hook: HookRunner = {
      async runPreToolUse() { return "allow"; },
    };
    const pipeline = new PermissionPipeline(rules, hook);
    expect(await pipeline.check(new TestTool("bash", false, true), null, ctx())).toBe("allow");
  });

  test("stage3 hook denies", async () => {
    const rules = new PermissionRules();
    const hook: HookRunner = {
      async runPreToolUse() { return "deny"; },
    };
    const pipeline = new PermissionPipeline(rules, hook);
    expect(await pipeline.check(new TestTool("bash", false, true), null, ctx())).toBe("deny");
  });

  test("stage3 hook passes", async () => {
    const rules = new PermissionRules();
    const hook: HookRunner = {
      async runPreToolUse() { return null; },
    };
    const pipeline = new PermissionPipeline(rules, hook);
    expect(await pipeline.check(new TestTool("bash", false, true), null, ctx())).toBe("ask");
  });

  test("stage4 ask is default", async () => {
    const rules = new PermissionRules();
    const pipeline = new PermissionPipeline(rules);
    expect(await pipeline.check(new TestTool("bash", false, true), null, ctx())).toBe("ask");
  });

  test("no hook runner", async () => {
    const rules = new PermissionRules();
    const pipeline = new PermissionPipeline(rules, null);
    expect(await pipeline.check(new TestTool("bash", false, true), null, ctx())).toBe("ask");
  });

  test("denylist bypasses everything", async () => {
    const rules = new PermissionRules({ denylist: ["read"] });
    const hook: HookRunner = {
      async runPreToolUse() { return "allow"; },
    };
    const pipeline = new PermissionPipeline(rules, hook);
    expect(await pipeline.check(new TestTool("read", true), null, ctx())).toBe("deny");
  });
});
