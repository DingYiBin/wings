/**
 * Memory types — file-based persistent memory in .wings/memory/.
 *
 * MEMORY.md index + per-topic markdown files with YAML frontmatter.
 * 4 types: user / feedback / project / reference.
 */

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  /** File name (without .md), e.g. "user_role", "feedback_testing". */
  name: string;
  description: string;
  type: MemoryType;
}

export interface MemoryIndex {
  entries: MemoryEntry[];
}
