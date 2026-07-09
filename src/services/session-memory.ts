/**
 * Session Memory — per-conversation structured notes that persist across
 * compaction boundaries.
 *
 * Mirrors claude-code's SessionMemory system:
 * - A single `summary.md` file in .wings/session-memory/
 * - Markdown template with preserved section headers
 * - Forked subagent updates it after reaching token/tool-call thresholds
 * - Used by compaction as the conversation summary (primary use case)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runSubagent } from "../agent/subagent.ts";
import type { AgentTypeSpec } from "../agent/subagent.ts";
import type { QueryEngine } from "../query/engine.ts";
import type { ModelRegistry } from "../models/registry.ts";
import type { ModelSelector } from "../routing/protocol.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Message } from "../messages/types.ts";

// -- Paths (delegated to session-paths.ts) --

import { getSessionMemoryDir, getSessionMemoryPath } from "./session-paths.ts";
export { getSessionMemoryDir, getSessionMemoryPath };

// -- Default template (matches claude-code) --

const DEFAULT_TEMPLATE = [
  "# Session Title",
  "_A short 5-10 word descriptive title for the session._",
  "",
  "# Current State",
  "_What is actively being worked on right now? Pending tasks not yet completed._",
  "",
  "# Task specification",
  "_What did the user ask to build? Design decisions and context._",
  "",
  "# Files and Functions",
  "_Important files — what they contain and why they're relevant._",
  "",
  "# Workflow",
  "_What bash commands are usually run? How to interpret their output?_",
  "",
  "# Errors & Corrections",
  "_Errors encountered and how they were fixed. Approaches that failed._",
  "",
  "# Codebase and System Documentation",
  "_Important system components and how they fit together._",
  "",
  "# Learnings",
  "_What has worked well? What to avoid? Don't duplicate other sections._",
  "",
  "# Key results",
  "_Exact answers to user questions, tables, or other output._",
  "",
  "# Worklog",
  "_Step by step, what was attempted and done. Terse summary per step._",
  "",
].join("\n");

// -- Thresholds (matches claude-code defaults) --

export interface SessionMemoryConfig {
  /** Minimum token estimate before first extraction. */
  minTokensToInit: number;
  /** Context growth needed between updates. */
  minTokensBetweenUpdate: number;
  /** Tool calls needed between updates. */
  toolCallsBetweenUpdates: number;
  /** Max tokens per section before warning. */
  maxSectionTokens: number;
  /** Max total session memory tokens. */
  maxTotalTokens: number;
}

export const DEFAULT_CONFIG: SessionMemoryConfig = {
  minTokensToInit: 10_000,
  minTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
  maxSectionTokens: 2_000,
  maxTotalTokens: 12_000,
};

// -- State --

let lastExtractedTokenCount = 0;
let lastExtractedMessageIndex = 0;
let extractionInProgress = false;
let config: SessionMemoryConfig = { ...DEFAULT_CONFIG };

export function getSessionMemoryConfig(): SessionMemoryConfig {
  return config;
}

export function setSessionMemoryConfig(c: Partial<SessionMemoryConfig>) {
  config = { ...config, ...c };
}

/** Rough token estimate: chars / 4. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") total += estimateTokens(b.text);
      else if (b.type === "tool_result") total += estimateTokens(b.content);
      else if (b.type === "tool_use") total += estimateTokens(JSON.stringify(b.input)) + 4;
      else if (b.type === "thinking") total += estimateTokens(b.thinking);
    }
  }
  return total;
}

// -- File I/O --

export function setupSessionMemoryFile(): string {
  const dir = getSessionMemoryDir();
  mkdirSync(dir, { recursive: true });
  const path = getSessionMemoryPath();
  if (!existsSync(path)) {
    writeFileSync(path, DEFAULT_TEMPLATE);
  }
  return path;
}

export function readSessionMemory(): string | null {
  const path = getSessionMemoryPath();
  if (!existsSync(path)) return null;
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

export function isSessionMemoryEmpty(content: string): boolean {
  // If it only differs from the template by whitespace, it's empty.
  const stripped = content.replace(/\s+/g, " ");
  const templateStripped = DEFAULT_TEMPLATE.replace(/\s+/g, " ");
  return stripped === templateStripped || !content.trim();
}

// -- Extraction logic --

/** Check whether extraction should run based on thresholds. */
export function shouldExtractMemory(
  messages: Message[],
  toolCallCount: number,
): boolean {
  const tokenCount = estimateMessagesTokens(messages);

  // First extraction: need enough context.
  if (lastExtractedTokenCount === 0) {
    return tokenCount >= config.minTokensToInit;
  }

  // Subsequent extractions: need enough growth + tool activity.
  const tokenGrowth = tokenCount - lastExtractedTokenCount;
  return tokenGrowth >= config.minTokensBetweenUpdate &&
    toolCallCount >= config.toolCallsBetweenUpdates;
}

/** Record that extraction completed successfully. */
export function recordExtraction(messages: Message[], toolCallCount: number) {
  lastExtractedTokenCount = estimateMessagesTokens(messages);
  lastExtractedMessageIndex = messages.length;
}

// -- Extraction agent spec --

const SESSION_MEMORY_AGENT: AgentTypeSpec = {
  name: "session-memory",
  description: "Updates session memory summary with conversation progress.",
  tools: ["write", "edit", "read", "glob", "grep"],
  disallowed_tools: ["bash", "agent"],
  read_only: false,
  task_type: "subagent/memory",
};

function buildUpdatePrompt(currentNotes: string, notesPath: string): string {
  return [
    "Update the session memory file to reflect the latest conversation progress.",
    "",
    "The file is at: " + notesPath,
    "",
    "## Current notes",
    "```",
    currentNotes,
    "```",
    "",
    "## Instructions",
    "- Each `# Section Name` header and its `_italic description_` must be preserved exactly as-is",
    "- Only update content BELOW the italic description lines",
    "- Add new information; don't remove existing useful information",
    "- Keep each section under 2000 tokens",
    "- Keep the total file under 12000 tokens",
    "- Write terse, information-dense summaries — no filler",
    "- Mark the session title if not yet set (use the first user request as source)",
    "- Fill in the Worklog with recent steps",
    "",
    "If nothing new was learned since the last update, respond with 'Nothing to save.'",
  ].join("\n");
}

// -- Main extraction function --

export interface ExtractOpts {
  workingDir: string;
  messages: Message[];
  queryEngine: QueryEngine;
  modelRegistry: ModelRegistry;
  toolRegistry: ToolRegistry;
  modelSelector: ModelSelector;
}

/** Run a session-memory extraction subagent. Returns true if memory was updated. */
export async function extractSessionMemory(opts: ExtractOpts): Promise<boolean> {
  if (extractionInProgress) return false;

  const memPath = setupSessionMemoryFile();
  const currentNotes = readFileSync(memPath, "utf-8");
  const prompt = buildUpdatePrompt(currentNotes, memPath);

  extractionInProgress = true;
  try {
    const result = await runSubagent(prompt, "session-memory", {
      queryEngine: opts.queryEngine,
      modelRegistry: opts.modelRegistry,
      toolRegistry: opts.toolRegistry,
      modelSelector: opts.modelSelector,
      workingDir: opts.workingDir,
      customAgents: { "session-memory": SESSION_MEMORY_AGENT },
    });

    if (result.includes("Nothing to save")) return false;

    // Re-read to check if file was actually changed.
    const updated = readFileSync(memPath, "utf-8");
    if (updated !== currentNotes) return true;
    return false;
  } catch {
    return false;
  } finally {
    extractionInProgress = false;
  }
}

// -- Compaction integration --

/**
 * Build a compact summary message from session memory.
 * Mirrors claude-code's getCompactUserSummaryMessage.
 */
export function buildSessionMemoryCompactMessage(): string | null {
  const content = readSessionMemory();
  if (!content || isSessionMemoryEmpty(content)) return null;

  return [
    "This session is being continued from a previous conversation that ran out of context.",
    "The summary below covers the earlier portion of the conversation.",
    "",
    content,
    "",
    "Recent messages are preserved verbatim.",
  ].join("\n");
}
