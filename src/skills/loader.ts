/**
 * Skill loader — discovers and parses SKILL.md files from disk.
 *
 * Three layers (low to high): builtin < user < project.
 * A skill with the same name in a higher layer overrides the lower.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { SkillSpec } from "./types.ts";

const MAX_FILE_SIZE = 256 * 1024; // 256 KB

export function parseFrontmatter(text: string): [Record<string, unknown>, string] {
  const m = /^---\s*\n(.*?)\n---\s*\n/s.exec(text);
  if (!m) return [{}, text];
  const raw = m[1]!;
  const body = text.slice(m[0].length);
  try {
    const fm = parseYaml(raw);
    return [fm && typeof fm === "object" ? fm as Record<string, unknown> : {}, body];
  } catch {
    return [{}, text];
  }
}

export function parseSkillFile(path: string): SkillSpec | null {
  try {
    const stat = readFileSync(path);
    if (stat.length > MAX_FILE_SIZE) return null;
    const text = stat.toString("utf-8");
    const [fm, body] = parseFrontmatter(text);
    const name = String(fm["name"] ?? "").trim();
    if (!name) return null;
    return {
      name,
      description: String(fm["description"] ?? "").trim(),
      content: body.trim(),
      path: join(path, ".."),
      user_invocable: fm["user-invocable"] !== false,
      disable_model_invocation: fm["disable-model-invocation"] === true,
      source: String(fm["source"] ?? "user"),
    };
  } catch {
    return null;
  }
}

function discoverSkills(root: string, source: string): Record<string, SkillSpec> {
  if (!existsSync(root)) return {};

  const result: Record<string, SkillSpec> = {};
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return {};
  }

  for (const entryName of entries) {
    const skillMd = join(root, entryName, "SKILL.md");
    if (existsSync(skillMd)) {
      const spec = parseSkillFile(skillMd);
      if (spec) {
        spec.source = source;
        result[spec.name] = spec;
      }
    }
  }
  return result;
}

export class SkillLoader {
  private _userDir: string | null;
  private _projectDir: string | null;
  private _builtinDir: string | null;
  private _skills: Record<string, SkillSpec> = {};
  private _loaded = false;

  constructor(opts: {
    userDir?: string | null;
    projectDir?: string | null;
    builtinDir?: string | null;
  } = {}) {
    this._userDir = opts.userDir ?? null;
    this._projectDir = opts.projectDir ?? null;
    this._builtinDir = opts.builtinDir ?? null;
  }

  loadAll(): SkillSpec[] {
    if (this._loaded) return Object.values(this._skills);

    const merged: Record<string, SkillSpec> = {};

    // Builtin layer (lowest precedence).
    if (this._builtinDir) {
      Object.assign(merged, discoverSkills(this._builtinDir, "builtin"));
    }

    // User layer (~/.wings/skills/).
    if (this._userDir) {
      Object.assign(merged, discoverSkills(this._userDir, "user"));
    }

    // Project layer (.wings/skills/) — highest precedence.
    if (this._projectDir) {
      Object.assign(merged, discoverSkills(this._projectDir, "project"));
    }

    this._skills = merged;
    this._loaded = true;
    return Object.values(this._skills);
  }

  getByName(name: string): SkillSpec | undefined {
    this.loadAll();
    return this._skills[name];
  }

  listModelVisible(): SkillSpec[] {
    return this.loadAll().filter((s) => !s.disable_model_invocation);
  }

  listUserInvocable(): SkillSpec[] {
    return this.loadAll().filter((s) => s.user_invocable);
  }
}
