/**
 * Memory loader — reads .wings/memory/ directory structure.
 *
 * MEMORY.md is an index file listing per-topic markdown files.
 * Each per-topic file has YAML frontmatter (name, description, type)
 * followed by markdown body content.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { MemoryEntry, MemoryType } from "./types.ts";

const VALID_TYPES = new Set<string>(["user", "feedback", "project", "reference"]);

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
  /** The parsed index entries from MEMORY.md. */
  entries: MemoryEntry[];
  /** Map of entry name to full file content (frontmatter + body). */
  content: Record<string, { frontmatter: Record<string, unknown>; body: string }>;
}

export function loadMemory(baseDir: string): MemoryStore {
  const memDir = join(baseDir, ".wings", "memory");
  if (!existsSync(memDir)) return { entries: [], content: {} };

  // Parse MEMORY.md index.
  const indexPath = join(memDir, "MEMORY.md");
  const indexFile = parseMemoryFile(indexPath);
  const entries: MemoryEntry[] = [];
  const content: Record<string, { frontmatter: Record<string, unknown>; body: string }> = {};

  // Parse index entries (one per line as markdown links).
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
