/**
 * Memory loader — reads ~/.wings/projects/<dashed-path>/memory/ directory.
 *
 * MEMORY.md is an index file listing per-topic markdown files.
 * Each per-topic file has YAML frontmatter (name, description, type)
 * followed by markdown body content.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { MemoryEntry, MemoryType } from "./types.ts";

const VALID_TYPES = new Set<string>(["user", "feedback", "project", "reference"]);

/** Test hook: override home directory for test isolation. */
let _homeOverride: string | null = null;
export function setMemoryHomeDir(dir: string | null) { _homeOverride = dir; }

export function getProjectMemoryDir(workingDir: string): string {
  const base = _homeOverride ?? homedir();
  const slug = workingDir.replace(/^\//, "").replace(/\//g, "-");
  return join(base, ".wings", "projects", slug, "memory");
}

function parseMemoryFile(path: string): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf-8");
    const m = /^---\s*\n(.*?)\n---\s*\n?(.*)/s.exec(text);
    if (!m) return { frontmatter: {}, body: text };
    const fm = parseYaml(m[1]!) ?? {};
    return {
      frontmatter: (fm && typeof fm === "object" ? fm : {}) as Record<string, unknown>,
      body: (m[2] ?? text).trim(),
    };
  } catch {
    return null;
  }
}

export interface MemoryStore {
  entries: MemoryEntry[];
  content: Record<string, { frontmatter: Record<string, unknown>; body: string }>;
}

export function loadMemory(workingDir: string): MemoryStore {
  const memDir = getProjectMemoryDir(workingDir);
  if (!existsSync(memDir)) return { entries: [], content: {} };

  const indexPath = join(memDir, "MEMORY.md");
  if (!existsSync(indexPath)) return { entries: [], content: {} };

  const indexFile = parseMemoryFile(indexPath);
  const entries: MemoryEntry[] = [];
  const content: Record<string, { frontmatter: Record<string, unknown>; body: string }> = {};

  if (indexFile) {
    const lines = indexFile.body.split("\n");
    for (const line of lines) {
      const m = /^-\s+\[([^\]]+)\]\(([^)]+)\)/.exec(line.trim());
      if (m) {
        const name = m[1]!;
        const fileName = m[2]!;
        const filePath = join(memDir, fileName);
        const file = parseMemoryFile(filePath);
        if (file) {
          const type = file.frontmatter["type"] as MemoryType | undefined;
          if (type && VALID_TYPES.has(type)) {
            entries.push({
              name: file.frontmatter["name"] as string ?? name,
              description: file.frontmatter["description"] as string ?? "",
              type,
            });
            content[name] = file;
          }
        }
      }
    }
  }

  return { entries, content };
}

/** Load MEMORY.md and build system prompt injection. Only creates the dir
 *  if memory was explicitly initiated (i.e. MEMORY.md exists). Otherwise
 *  returns empty guidance without creating anything. */
export function loadMemoryPrompt(workingDir: string): string {
  const memDir = getProjectMemoryDir(workingDir);
  const indexPath = join(memDir, "MEMORY.md");
  if (!existsSync(indexPath)) return ""; // no memory → skip

  const guidancePath = join(import.meta.dirname!, "guidance.md");
  let guidance: string;
  try { guidance = readFileSync(guidancePath, "utf-8"); } catch { return ""; }
  guidance = guidance.replaceAll("{memory_dir}", memDir);

  const content = readFileSync(indexPath, "utf-8").trim();
  if (content) {
    return `<system-reminder>\n${guidance}\n\n${content}\n</system-reminder>`;
  }
  return `<system-reminder>\n${guidance}\n</system-reminder>`;
}
