/**
 * Auto-memory extraction — runs a lightweight subagent after each turn to
 * save durable memories from the conversation.
 *
 * Mirrors src/wings/memory/extractor.py: a forked subagent scans the
 * conversation and writes topic files + updates MEMORY.md.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AgentTypeSpec } from "../agent/subagent.ts";
import { runSubagent } from "../agent/subagent.ts";
import type { QueryEngine } from "../query/engine.ts";
import type { ModelRegistry } from "../models/registry.ts";
import type { ModelSelector } from "../routing/protocol.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export const MEMORY_AGENT_SPEC: AgentTypeSpec = {
  name: "memory-extractor",
  description:
    "Extracts durable memories from conversations and saves them to .wings/memory/.",
  tools: ["write", "edit", "read", "glob", "grep"],
  disallowed_tools: ["bash", "agent"],
  read_only: false,
  task_type: "subagent/memory",
};

const EXTRACT_PROMPT = `\
Review the conversation above and extract any durable information worth saving
to the memory system at \`.wings/memory/\`.

Follow the memory system rules you already know:
- 4 types: user, feedback, project, reference
- Write topic files with YAML frontmatter (name, description, type)
- Add pointers to MEMORY.md index
- Do NOT save: code patterns, git history, debug solutions, ephemeral details
- Only save if something NEW and DURABLE was learned

If nothing new was learned that should be saved, respond with "Nothing to save."
and do not write any files.`;

export interface ExtractOpts {
  workingDir: string;
  queryEngine: QueryEngine;
  modelRegistry: ModelRegistry;
  toolRegistry: ToolRegistry;
  modelSelector: ModelSelector;
}

/**
 * Run a memory-extraction subagent if there is conversation text to scan.
 * Returns the subagent's output text, or empty string if skipped.
 */
export async function maybeExtractMemories(
  messagesText: string,
  opts: ExtractOpts,
): Promise<string> {
  if (!messagesText.trim()) return "";

  const prompt = `${EXTRACT_PROMPT}\n\n## Conversation\n\n${messagesText}`;
  const memoryDir = join(opts.workingDir, ".wings", "memory");
  mkdirSync(memoryDir, { recursive: true });

  return runSubagent(prompt, "memory-extractor", {
    queryEngine: opts.queryEngine,
    modelRegistry: opts.modelRegistry,
    toolRegistry: opts.toolRegistry,
    modelSelector: opts.modelSelector,
    workingDir: opts.workingDir,
    customAgents: { "memory-extractor": MEMORY_AGENT_SPEC },
  });
}
