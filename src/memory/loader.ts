/**
 * Memory loader — reads .wings/memory/ directory structure.
 *
 * MEMORY.md is an index file listing per-topic markdown files.
 * Each per-topic file has YAML frontmatter (name, description, type)
 * followed by markdown body content.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { MemoryEntry, MemoryType } from "./types.ts";

const VALID_TYPES = new Set<string>(["user", "feedback", "project", "reference"]);
const MEMORY_DIR_NAME = ".wings/memory";
const MEMORY_FILE = "MEMORY.md";

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

/**
 * Load MEMORY.md and build the full system prompt injection.
 *
 * Creates .wings/memory/ if it doesn't exist. Returns the memory guidance
 * (teaching the model how to use memory) plus the MEMORY.md index content,
 * wrapped in <system-reminder> tags so the model treats it as system-level
 * context. Mirrors Python's load_memory_prompt().
 */
export function loadMemoryPrompt(workingDir: string): string {
  const memoryDir = join(workingDir, ...MEMORY_DIR_NAME.split("/"));
  mkdirSync(memoryDir, { recursive: true });

  // Guidance text lives next to this source file as a plain markdown asset
  // (avoids template-literal escaping for its 28 backticks).
  const guidancePath = join(import.meta.dirname!, "guidance.md");
  let guidance = readFileSync(guidancePath, "utf-8");
  guidance = guidance.replaceAll("{memory_dir}", memoryDir);

  const memoryMdPath = join(memoryDir, MEMORY_FILE);
  if (existsSync(memoryMdPath)) {
    const content = readFileSync(memoryMdPath, "utf-8").trim();
    if (content) {
      return `<system-reminder>\n${guidance}\n\n${content}\n</system-reminder>`;
    }
  }
  return `<system-reminder>\n${guidance}\n</system-reminder>`;
}
