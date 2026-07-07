/** Create or overwrite a file. */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";

import { z } from "zod";

import { buildTool } from "../types.ts";

interface WriteInput {
  file_path: string;
  content: string;
}

function linesChanged(old: string, new_: string): string {
  const oldLines = old.split("\n");
  const newLines = new_.split("\n");
  const added = Math.max(0, newLines.length - oldLines.length);
  const removed = Math.max(0, oldLines.length - newLines.length);

  const parts: string[] = [];
  if (added) parts.push(`Added ${added} line${added !== 1 ? "s" : ""}`);
  if (removed) {
    const caps = !added ? "Removed" : "removed";
    parts.push(`${caps} ${removed} line${removed !== 1 ? "s" : ""}`);
  }
  if (parts.length === 0) parts.push("Content replaced");
  return parts.join(", ");
}

export const writeTool = buildTool({
  name: "write",
  description: "Create or overwrite a file with the given content",
  search_hint: "write /path/to/file",
  is_destructive: true,
  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the file to write"),
    content: z.string().describe("Content to write to the file"),
  }),
  async call(input: WriteInput, context) {
    let pathStr = input.file_path;
    if (!isAbsolute(pathStr)) pathStr = join(context.working_dir, pathStr);

    const existed = existsSync(pathStr);

    // Stale detection for existing files
    if (existed) {
      const cachedMtime = context.read_cache[pathStr];
      if (cachedMtime === undefined) {
        return `Error: must read ${pathStr} before writing to it. Use the read tool first.`;
      }
      const currentMtime = statSync(pathStr).mtimeMs / 1000;
      if (currentMtime > cachedMtime) {
        return `Error: ${pathStr} was modified since last read (cached: ${cachedMtime}, current: ${currentMtime}). Re-read the file and try again.`;
      }
    }

    const oldText = existed ? readFileSync(pathStr, "utf-8") : "";
    mkdirSync(dirname(pathStr), { recursive: true });
    writeFileSync(pathStr, input.content);

    // Update read cache so the file is "fresh" after write
    context.read_cache[pathStr] = statSync(pathStr).mtimeMs / 1000;

    const newLines = input.content.split("\n");
    const lineCount = newLines.length;

    if (!existed) {
      // New file — show first lines as preview with + prefix
      const result = [`Wrote ${lineCount} line${lineCount !== 1 ? "s" : ""} to ${pathStr}`];
      const preview = Math.min(lineCount, 10);
      for (let i = 0; i < preview; i++) {
        result.push(`         +${newLines[i]!.trimEnd()}`);
      }
      if (lineCount > preview) {
        result.push(`    \u2026 +${lineCount - preview} lines`);
      }
      return result.join("\n");
    }

    // Update — show summary + diff-like preview
    const summary = linesChanged(oldText, input.content);
    const result = [summary, `(in ${pathStr})`];

    // Show a diff-like view: new lines with + where different
    const oldLines = oldText.split("\n");
    const maxShow = Math.min(Math.max(oldLines.length, lineCount), 30);
    let changed = 0;
    for (let i = 0; i < maxShow; i++) {
      const old = i < oldLines.length ? oldLines[i]!.trimEnd() : "";
      const newL = i < lineCount ? newLines[i]!.trimEnd() : "";
      if (old !== newL) {
        if (old) result.push(`    ${String(i + 1).padStart(6)} -${old}`);
        if (newL) result.push(`    ${String(i + 1).padStart(6)} +${newL}`);
        changed++;
      } else if (changed > 0) {
        result.push(`    ${String(i + 1).padStart(6)}  ${old}`);
      }
    }
    if (Math.max(lineCount, oldLines.length) > maxShow) {
      result.push(`    \u2026 (${Math.max(lineCount, oldLines.length) - maxShow} more lines)`);
    }

    return result.join("\n");
  },
});
