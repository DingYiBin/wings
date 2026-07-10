/**
 * Tests for the skill_view tool.
 * Ported from tests/test_skills.py:329-357.
 */

import { describe, test, expect } from "bun:test";

import { skillViewTool } from "../../src/tools/builtin/skill_view.ts";
import { makeToolContext } from "../../src/tools/types.ts";

describe("skill_view tool", () => {
  test("returns skill content", async () => {
    const ctx = makeToolContext({
      working_dir: ".",
      available_skills: { commit: "## Instructions\n\nGenerate a commit message." },
    });
    const r: any = await skillViewTool.call({ name: "commit" }, ctx);
    expect(r.output).toBe("## Instructions\n\nGenerate a commit message.");
    expect(r.error).toBeNull();
  });

  test("not found lists available skills", async () => {
    const ctx = makeToolContext({
      working_dir: ".",
      available_skills: { commit: "..." },
    });
    const r: any = await skillViewTool.call({ name: "nonexistent" }, ctx);
    expect(r.output).toContain("not found");
    expect(r.output).toContain("commit");
  });

  test("empty skills shows (none)", async () => {
    const ctx = makeToolContext({ working_dir: "." });
    const r: any = await skillViewTool.call({ name: "test" }, ctx);
    expect(r.output).toContain("not found");
    expect(r.output).toContain("(none)");
  });
});
