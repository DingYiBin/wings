/** Perform exact string replacements in a file. */

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { buildTool } from "../types.ts";

const CONTEXT_LINES = 3;

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function diffHunk(
  lines: string[],
  startIdx: number,
  oldLines: string[],
  newLines: string[],
): string {
  const oldLen = oldLines.length;
  const newLen = newLines.length;

  const ctxStart = Math.max(0, startIdx - CONTEXT_LINES);
  const ctxEnd = Math.min(lines.length, startIdx + oldLen + CONTEXT_LINES);

  const result: string[] = [`    @@ -${startIdx + 1},${oldLen} +${startIdx + 1},${newLen} @@`];

  // Context before
  for (let i = ctxStart; i < startIdx; i++) {
    result.push(`    ${String(i + 1).padStart(6)}  ${lines[i]!.trimEnd()}`);
  }

  // Removed lines (keep original file line numbers)
  for (let offset = 0; offset < oldLines.length; offset++) {
    result.push(`    ${String(startIdx + 1 + offset).padStart(6)} -${oldLines[offset]!.trimEnd()}`);
  }

  // Added lines
  for (const line of newLines) {
    result.push(`         +${line.trimEnd()}`);
  }

  // Context after
  const afterStart = startIdx + oldLen;
  for (let i = afterStart; i < ctxEnd; i++) {
    result.push(`    ${String(i + 1).padStart(6)}  ${lines[i]!.trimEnd()}`);
  }

  return result.join("\n");
}

function summary(added: number, removed: number, replaced: number = 1): string {
  const parts: string[] = [];
  if (added) parts.push(`Added ${added} line${added !== 1 ? "s" : ""}`);
  if (removed) {
    const caps = !added ? "Removed" : "removed";
    parts.push(`${caps} ${removed} line${removed !== 1 ? "s" : ""}`);
  }
  if (parts.length === 0) parts.push("No changes");
  let s = parts.join(", ");
  if (replaced > 1) s += ` (${replaced} occurrences)`;
  return s;
}

export const editTool = buildTool({
  name: "edit",
  description: "Perform exact string replacements in an existing file",
  search_hint: "edit /path/to/file",
  is_destructive: true,
  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the file to edit"),
    old_string: z.string().describe("The text to replace"),
    new_string: z.string().describe("The text to replace it with (must differ from old_string)"),
    replace_all: z.boolean().optional().describe("Replace all occurrences of old_string"),
  }),
  async call(input: EditInput, context) {
    if (input.old_string === input.new_string) {
      return "Error: old_string and new_string must be different";
    }

    let pathStr = input.file_path;
    if (!isAbsolute(pathStr)) pathStr = join(context.working_dir, pathStr);

    if (!existsSync(pathStr)) {
      return `Error: file not found: ${pathStr}`;
    }
    const stat = statSync(pathStr);
    if (stat.isDirectory()) {
      return `Error: path is a directory: ${pathStr}`;
    }

    // Stale detection
    const cachedMtime = context.read_cache[pathStr];
    if (cachedMtime === undefined) {
      return `Error: must read ${pathStr} before editing it. Use the read tool first.`;
    }
    const currentMtime = stat.mtimeMs / 1000;
    if (currentMtime > cachedMtime) {
      return `Error: ${pathStr} was modified since last read (cached: ${cachedMtime}, current: ${currentMtime}). Re-read the file and try again.`;
    }

    const text = readFileSync(pathStr, "utf-8");
    const replaceAll = input.replace_all ?? false;

    // Count occurrences
    let count = 0;
    let idx = 0;
    while ((idx = text.indexOf(input.old_string, idx)) !== -1) {
      count++;
      idx += input.old_string.length;
    }

    if (count === 0) {
      return `Error: old_string not found in ${pathStr}`;
    }
    if (!replaceAll && count > 1) {
      return `Error: old_string appears ${count} times in ${pathStr}. Use replace_all=true to replace all occurrences, or provide more context to make the match unique.`;
    }

    // Build the diff display
    const fileLines = text.split("\n");
    const firstIdx = text.indexOf(input.old_string);
    const prefix = text.slice(0, firstIdx);
    const lineStart = prefix.split("\n").length - 1;
    const oldLines = input.old_string.split("\n");
    const newLines = input.new_string.split("\n");

    const hunk = diffHunk(fileLines, lineStart, oldLines, newLines);

    let added: number, removed: number;
    if (input.old_string === "") {
      added = newLines.length;
      removed = 0;
    } else if (input.new_string === "") {
      added = 0;
      removed = oldLines.length;
    } else {
      added = newLines.length;
      removed = oldLines.length;
    }
    const smry = summary(added, removed, replaceAll ? count : 1);

    const newText = replaceAll
      ? text.split(input.old_string).join(input.new_string)
      : text.replace(input.old_string, input.new_string);
    writeFileSync(pathStr, newText);

    // Update read cache
    context.read_cache[pathStr] = statSync(pathStr).mtimeMs / 1000;

    return [smry, `(in ${pathStr})`, hunk].join("\n");
  },
});
