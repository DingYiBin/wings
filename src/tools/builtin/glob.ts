/** Fast file pattern matching. */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { buildTool } from "../types.ts";

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

    // Use Bun's Glob for matching.
    const Glob = (await import("bun")).Glob;
    const g = new Glob(input.pattern);
    const matches: string[] = [];
    for await (const match of g.scan({ cwd: base, onlyFiles: true })) {
      matches.push(match);
    }
    matches.sort();

    if (matches.length === 0) {
      return `No files matched '${input.pattern}' in ${base}`;
    }

    const label = matches.length === 1 ? "file" : "files";
    const lines = [`Found ${matches.length} ${label}`];
    for (const m of matches) lines.push(m);
    return lines.join("\n");
  },
});
