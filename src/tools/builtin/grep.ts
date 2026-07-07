/** Regular expression content search. */

import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { buildTool } from "../types.ts";

// Directories to exclude from search
const VCS_DIRS = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]);

interface GrepInput {
  pattern: string;
  path?: string | null;
  glob?: string | null;
  output_mode?: string | null;
  head_limit?: number | null;
}


/** Recursively collect files under base, optionally filtered by glob pattern. */
function collectFiles(base: string, globPattern: string | null): string[] {
  const result: string[] = [];
  function walk(dir: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as import("node:fs").Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const name: string = entry.name as unknown as string;
      const full = join(dir, name);
      if (entry.isDirectory()) {
        if (!VCS_DIRS.has(name)) walk(full);
      } else if (entry.isFile()) {
        if (globPattern && globPattern !== "**/*") {
          if (!matchSimpleGlob(name, globPattern)) continue;
        }
        result.push(full);
      }
    }
  }
  walk(base);
  return result.sort();
}

function matchSimpleGlob(name: string, pattern: string): boolean {
  // Convert simple glob to regex: *, ?, {a,b}
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      regex += ".*";
    } else if (c === "?") {
      regex += ".";
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        regex += "\\{";
      } else {
        const options = pattern.slice(i + 1, end).split(",").map((s) => s.trim());
        regex += `(?:${options.join("|")})`;
        i = end;
      }
    } else if (c === "[") {
      regex += "[";
    } else if (c === "]") {
      regex += "]";
    } else if ("\\^$.|+()".includes(c)) {
      regex += "\\" + c;
    } else {
      regex += c;
    }
    i++;
  }
  regex += "$";
  return new RegExp(regex).test(name);
}

export const grepTool = buildTool({
  name: "grep",
  description: "Search file contents using regular expressions",
  search_hint: "grep 'pattern'",
  is_read_only: true,
  inputSchema: z.object({
    pattern: z.string().describe("The regular expression pattern to search for"),
    path: z.string().optional().describe("File or directory to search in. Defaults to working directory."),
    glob: z.string().optional().describe("Glob pattern to filter files, e.g. '*.py'"),
    output_mode: z.string().optional().describe("Output mode: 'content', 'files_with_matches', or 'count'"),
    head_limit: z.number().optional().describe("Limit output to first N lines/entries"),
  }),
  async call(input: GrepInput, context) {
    let base = input.path ?? context.working_dir;
    if (!isAbsolute(base)) base = join(context.working_dir, base);
    if (!existsSync(base)) {
      return `Error: path not found: ${base}`;
    }

    // Collect files to search
    let files: string[];
    const stat = statSync(base);
    if (stat.isFile()) {
      files = [base];
    } else {
      files = collectFiles(base, input.glob ?? null);
    }

    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (e) {
      return `Error: invalid regex: ${(e as Error).message}`;
    }

    const outputLines: string[] = [];
    let fileCount = 0;
    let matchCount = 0;
    const outputMode = input.output_mode ?? "content";

    for (const filepath of files) {
      let text: string;
      try {
        text = readFileSync(filepath, "utf-8");
      } catch {
        continue;
      }

      // Find all matches. Strip sticky flag (y) and ensure global (g) for exec loop.
      let baseFlags = regex.flags.replace("y", "");
      if (!baseFlags.includes("g")) baseFlags += "g";
      const globalRegex = new RegExp(regex.source, baseFlags);
      const matches: Array<{ index: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = globalRegex.exec(text)) !== null) {
        matches.push({ index: m.index });
        if (m.index === globalRegex.lastIndex) globalRegex.lastIndex++;
      }

      if (matches.length === 0) continue;

      fileCount++;
      matchCount += matches.length;

      if (outputMode === "files_with_matches") {
        outputLines.push(filepath);
      } else if (outputMode === "count") {
        outputLines.push(`${filepath}:${matches.length}`);
      } else {
        const lines = text.split("\n");
        for (const match of matches) {
          const lineNo = text.slice(0, match.index).split("\n").length;
          const lineText = lineNo <= lines.length ? lines[lineNo - 1] : "";
          outputLines.push(`${filepath}:${lineNo}: ${lineText.trim()}`);
        }
      }

      if (input.head_limit && outputLines.length >= input.head_limit) {
        outputLines.length = input.head_limit;
        break;
      }
    }

    if (outputLines.length === 0) {
      return "(no matches)";
    }

    // Summary line matching claude-code: "Found N matches across M files"
    let summary: string;
    if (outputMode === "files_with_matches") {
      const label = fileCount === 1 ? "file" : "files";
      summary = `Found ${fileCount} ${label}`;
    } else if (outputMode === "count") {
      const label = matchCount === 1 ? "match" : "matches";
      const fileLabel = fileCount === 1 ? "file" : "files";
      summary = `Found ${matchCount} ${label} across ${fileCount} ${fileLabel}`;
    } else {
      const label = matchCount === 1 ? "match" : "matches";
      const fileLabel = fileCount === 1 ? "file" : "files";
      summary = `Found ${matchCount} ${label} across ${fileCount} ${fileLabel}`;
    }

    return summary + "\n" + outputLines.join("\n");
  },
});
