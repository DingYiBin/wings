/** Fast file pattern matching. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { z } from "zod";

import { buildTool } from "../types.ts";

// VCS directories skipped during traversal (performance, mirrors grep).
// Hidden files and other dot-directories (e.g. .wings/) are NOT skipped —
// pathlib.glob traverses them, and so do we.
const VCS_DIRS = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]);

/** Convert a glob pattern to a regex. Supports *, **, ?, {a,b}, [abc].
 *  Matched against forward-slash-relative paths (e.g. "foo/bar.py"). */
export function globToRegex(pattern: string): RegExp {
  // Normalize separators.
  pattern = pattern.replace(/\\/g, "/");
  let rx = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any path
        if (pattern[i + 2] === "/" || i + 2 >= pattern.length) {
          rx += ".*";
          i += pattern[i + 2] === "/" ? 3 : 2;
          continue;
        }
      }
      rx += "[^/]*";
    } else if (c === "?") {
      rx += "[^/]";
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) { rx += "\\{"; }
      else {
        const opts = pattern.slice(i + 1, end).split(",").map((s) => s.trim());
        rx += `(?:${opts.join("|")})`;
        i = end;
      }
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) { rx += "\\["; }
      else { rx += pattern.slice(i, end + 1); i = end; }
    } else if (".^$\\+()|".includes(c)) {
      rx += "\\" + c;
    } else {
      rx += c;
    }
    i++;
  }
  rx += "$";
  return new RegExp(rx);
}

/** Walk directory tree recursively and return files matching the glob pattern. */
function walkAndMatch(base: string, pattern: string): string[] {
  const regex = globToRegex(pattern);
  const results: string[] = [];

  function walk(dir: string) {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as any; }
    catch { return; }
    for (const e of entries) {
      const name: string = e.name as any;
      const full = join(dir, name);
      if (e.isDirectory()) {
        if (!VCS_DIRS.has(name)) walk(full);
      } else if (e.isFile()) {
        const rel = relative(base, full).replace(/\\/g, "/");
        if (regex.test(rel)) {
          results.push(full);
        }
      }
    }
  }
  walk(base);
  return results.sort();
}

export const globTool = buildTool({
  name: "glob",
  description: "Find files matching a glob pattern",
  search_hint: "glob '**/*.py'",
  is_read_only: true,
  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern to match, e.g. '**/*.py'"),
    path: z.string().optional().describe("Directory to search in. Defaults to working directory."),
  }),
  async call(input, context) {
    let base = input.path ?? context.working_dir;
    if (!isAbsolute(base)) base = join(context.working_dir, base);
    if (!existsSync(base)) {
      return `Error: directory not found: ${base}`;
    }

    // Walk directory tree and match against glob pattern.
    const matches = walkAndMatch(base, input.pattern);

    if (matches.length === 0) {
      return `No files matched '${input.pattern}' in ${base}`;
    }

    const label = matches.length === 1 ? "file" : "files";
    const lines = [`Found ${matches.length} ${label}`];
    for (const m of matches) lines.push(m);
    return lines.join("\n");
  },
});
