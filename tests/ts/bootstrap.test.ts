/** Tests for bootstrap wiring — system prompt composition. */

import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { makeAgentContext } from "../../src/cli/bootstrap.ts";
import { makeGlobalSettings } from "../../src/config/settings.ts";
import type { AgentTypeSpec } from "../../src/agent/subagent.ts";

function minimalConfig() {
  return makeGlobalSettings({ personality: "You are wings." });
}

const CUSTOM_AGENT: AgentTypeSpec = {
  name: "code-reviewer",
  description: "Reviews code for bugs and style.",
  tools: ["read", "glob", "grep"],
  disallowed_tools: ["bash", "write", "edit", "agent"],
  read_only: true,
  task_type: "subagent/code-reviewer",
};

describe("makeAgentContext: agent listing", () => {
  test("lists builtin agents by default", () => {
    const wd = mkdtempSync(join(tmpdir(), "wings-bootstrap-"));
    const ctx = makeAgentContext(minimalConfig(), { workingDir: wd });
    expect(ctx.system_prompt).toContain("## Available Agents");
    expect(ctx.system_prompt).toContain("**general**");
    expect(ctx.system_prompt).toContain("**explore**");
    expect(ctx.system_prompt).toContain("**plan**");
  });

  test("injects custom agents alongside builtins", () => {
    const wd = mkdtempSync(join(tmpdir(), "wings-bootstrap-"));
    const ctx = makeAgentContext(minimalConfig(), {
      workingDir: wd,
      customAgents: { "code-reviewer": CUSTOM_AGENT },
    });
    // Custom agent appears in the listing...
    expect(ctx.system_prompt).toContain("**code-reviewer**");
    expect(ctx.system_prompt).toContain("Reviews code for bugs and style.");
    expect(ctx.system_prompt).toContain("[read-only]");
    // ...and builtins are still present.
    expect(ctx.system_prompt).toContain("**general**");
  });

  test("includes memory prompt section", () => {
    const wd = mkdtempSync(join(tmpdir(), "wings-bootstrap-"));
    const ctx = makeAgentContext(minimalConfig(), { workingDir: wd });
    expect(ctx.system_prompt).toContain("<system-reminder>");
    expect(ctx.system_prompt).toContain(".wings/memory");
  });
});
