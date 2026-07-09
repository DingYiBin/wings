import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SkillLoader, parseFrontmatter, parseSkillFile } from "../../src/skills/loader.ts";
import { SkillInjector } from "../../src/skills/injector.ts";
import type { SkillSpec } from "../../src/skills/types.ts";

function makeSkillDir(base: string, name: string, body: string, extraFm: Record<string, unknown> = {}) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const fm = [`name: ${name}`, `description: ${name} skill`, ...Object.entries(extraFm).map(([k, v]) => `${k}: ${v}`)];
  const content = `---\n${fm.join("\n")}\n---\n${body}`;
  writeFileSync(join(dir, "SKILL.md"), content);
}

describe("SkillLoader", () => {
  test("discovers skills from builtin dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-skills-"));
    makeSkillDir(tmp, "test-skill", "do things");
    makeSkillDir(tmp, "another", "more things", { "disable-model-invocation": true });

    const loader = new SkillLoader({ builtinDir: tmp });
    const skills = loader.loadAll();
    expect(skills.length).toBe(2);
    expect(loader.getByName("test-skill")?.content).toBe("do things");
  });

  test("listModelVisible excludes hidden", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-skills-"));
    makeSkillDir(tmp, "visible", "body");
    makeSkillDir(tmp, "hidden", "body", { "disable-model-invocation": true });

    const loader = new SkillLoader({ builtinDir: tmp });
    const visible = loader.listModelVisible();
    expect(visible.length).toBe(1);
    expect(visible[0]!.name).toBe("visible");
  });

  test("listUserInvocable excludes non-invocable", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-skills-"));
    makeSkillDir(tmp, "invocable", "body", { "user-invocable": true });
    makeSkillDir(tmp, "not-invocable", "body", { "user-invocable": false });

    const loader = new SkillLoader({ builtinDir: tmp });
    const invocable = loader.listUserInvocable();
    expect(invocable.length).toBe(1);
    expect(invocable[0]!.name).toBe("invocable");
  });

  test("project layer overrides builtin", () => {
    const builtinTmp = mkdtempSync(join(tmpdir(), "wings-skills-builtin-"));
    const projectTmp = mkdtempSync(join(tmpdir(), "wings-skills-project-"));
    makeSkillDir(builtinTmp, "same-name", "builtin body");
    makeSkillDir(projectTmp, "same-name", "project body");

    const loader = new SkillLoader({ builtinDir: builtinTmp, projectDir: projectTmp });
    const skill = loader.getByName("same-name");
    expect(skill?.content).toBe("project body");
    expect(skill?.source).toBe("project");
  });

  test("loadAll is cached", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wings-skills-"));
    makeSkillDir(tmp, "cached", "body");

    const loader = new SkillLoader({ builtinDir: tmp });
    const first = loader.loadAll();
    const second = loader.loadAll();
    expect(first.length).toBe(second.length);
    expect(first[0]!.name).toBe(second[0]!.name);
  });

  test("getByName returns undefined for missing", () => {
    const loader = new SkillLoader();
    expect(loader.getByName("nonexistent")).toBeUndefined();
  });

  test("user layer overrides builtin", () => {
    const base = mkdtempSync(join(tmpdir(), "wings-skills-ub-"));
    const builtinDir = join(base, "builtin");
    const userDir = join(base, "user");
    makeSkillDir(builtinDir, "test", "Builtin body.");
    makeSkillDir(userDir, "test", "User body.");
    const loader = new SkillLoader({ builtinDir, userDir });
    const spec = loader.getByName("test");
    expect(spec).toBeDefined();
    expect(spec!.source).toBe("user");
    expect(spec!.content).toBe("User body.");
  });

  test("missing dirs are graceful → empty", () => {
    const loader = new SkillLoader({
      userDir: "/nonexistent/path",
      projectDir: "/another/nonexistent",
    });
    expect(loader.loadAll()).toEqual([]);
  });

  test("skips dot-directories", () => {
    const base = mkdtempSync(join(tmpdir(), "wings-skills-dot-"));
    makeSkillDir(base, "valid", "Body.");
    const hidden = join(base, ".hidden");
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, "SKILL.md"), "---\nname: hidden\ndescription: nope\n---\n\nBody.");
    const loader = new SkillLoader({ projectDir: base });
    const skills = loader.loadAll();
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("valid");
  });

  test("skips dirs without SKILL.md", () => {
    const base = mkdtempSync(join(tmpdir(), "wings-skills-noskill-"));
    makeSkillDir(base, "s1", "Body.");
    mkdirSync(join(base, "empty"), { recursive: true }); // no SKILL.md
    const loader = new SkillLoader({ projectDir: base });
    const skills = loader.loadAll();
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("s1");
  });
  // NOTE: a "loads real builtin skills" test (asserting skills/builtin holds
  // commit/review-pr/simplify) lives with the skill-migration PR that creates
  // skills/builtin; it's omitted here to keep this test-coverage PR
  // independent of that change.
});

// -- parseFrontmatter / parseSkillFile edge cases ---------------------------

describe("parseFrontmatter", () => {
  test("no delimiter → empty fm, body unchanged", () => {
    const text = "Just plain markdown\n\nNo frontmatter.";
    const [fm, body] = parseFrontmatter(text);
    expect(fm).toEqual({});
    expect(body).toBe(text);
  });

  test("empty input", () => {
    const [fm, body] = parseFrontmatter("");
    expect(fm).toEqual({});
    expect(body).toBe("");
  });

  test("invalid yaml → empty fm, body unchanged", () => {
    const text = "---\n\tinvalid: yaml: indent\n---\n\nBody.";
    const [fm, body] = parseFrontmatter(text);
    expect(fm).toEqual({});
    expect(body).toBe(text);
  });
});

describe("parseSkillFile", () => {
  test("valid skill", () => {
    const base = mkdtempSync(join(tmpdir(), "wings-parse-valid-"));
    const skillDir = join(base, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: my-skill\ndescription: Does things\n---\n\n## Instructions\n\nDo the thing.");
    const spec = parseSkillFile(join(skillDir, "SKILL.md"));
    expect(spec).not.toBeNull();
    expect(spec!.name).toBe("my-skill");
    expect(spec!.description).toBe("Does things");
    expect(spec!.content).toBe("## Instructions\n\nDo the thing.");
  });

  test("missing name → null", () => {
    const base = mkdtempSync(join(tmpdir(), "wings-parse-noname-"));
    const skillDir = join(base, "bad");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: No name here\n---\n\nBody.");
    expect(parseSkillFile(join(skillDir, "SKILL.md"))).toBeNull();
  });

  test("no frontmatter → null", () => {
    const base = mkdtempSync(join(tmpdir(), "wings-parse-nofm-"));
    const skillDir = join(base, "no-fm");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "Just markdown, no YAML frontmatter.");
    expect(parseSkillFile(join(skillDir, "SKILL.md"))).toBeNull();
  });

  test("empty file → null", () => {
    const base = mkdtempSync(join(tmpdir(), "wings-parse-empty-"));
    const skillDir = join(base, "empty");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "");
    expect(parseSkillFile(join(skillDir, "SKILL.md"))).toBeNull();
  });

  test("user-invocable: false", () => {
    const base = mkdtempSync(join(tmpdir(), "wings-parse-uif-"));
    const skillDir = join(base, "hidden");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: hidden\ndescription: d\nuser-invocable: false\n---\n\nBody.");
    const spec = parseSkillFile(join(skillDir, "SKILL.md"));
    expect(spec).not.toBeNull();
    expect(spec!.user_invocable).toBe(false);
  });
});

function makeSpec(name: string, description: string, opts: Partial<SkillSpec> = {}): SkillSpec {
  return {
    name,
    description,
    content: "",
    path: "",
    user_invocable: true,
    disable_model_invocation: false,
    source: "builtin",
    ...opts,
  };
}

describe("SkillInjector", () => {
  test("returns prompt unchanged when no visible skills", () => {
    const injector = new SkillInjector();
    const hidden = [makeSpec("h", "d", { disable_model_invocation: true })];
    expect(injector.injectSkills("BASE", hidden)).toBe("BASE");
    expect(injector.injectSkills("BASE", [])).toBe("BASE");
  });

  test("builds <available_skills> XML block with intro text", () => {
    const injector = new SkillInjector();
    const out = injector.injectSkills("BASE", [
      makeSpec("git-commit", "Commits changes following conventions"),
    ]);
    expect(out).toContain("## Skills");
    expect(out).toContain("<available_skills>");
    expect(out).toContain("</available_skills>");
    expect(out).toContain("<name>git-commit</name>");
    expect(out).toContain("<description>Commits changes following conventions</description>");
    expect(out.startsWith("BASE\n\n")).toBe(true);
  });

  test("hides skills with disable_model_invocation", () => {
    const injector = new SkillInjector();
    const out = injector.injectSkills("BASE", [
      makeSpec("visible", "v"),
      makeSpec("hidden", "h", { disable_model_invocation: true }),
    ]);
    expect(out).toContain("<name>visible</name>");
    expect(out).not.toContain("<name>hidden</name>");
  });

  test("XML-escapes special characters in name and description", () => {
    const injector = new SkillInjector();
    const out = injector.injectSkills("BASE", [
      makeSpec("a<b>&c", "desc <tag> & stuff"),
    ]);
    expect(out).toContain("<name>a&lt;b&gt;&amp;c</name>");
    expect(out).toContain("<description>desc &lt;tag&gt; &amp; stuff</description>");
    // No raw unescaped angle brackets inside the skill element name/description.
    expect(out).not.toContain("<name>a<b>");
  });
});
