#!/usr/bin/env node
/**
 * Wings CLI entry point.
 *
 * Usage:
 *   node --import tsx src/index.ts chat          # interactive REPL
 *   node --import tsx src/index.ts run "prompt"  # single turn
 *   node --import tsx src/index.ts chat --log    # with logging to .wings/logs/
 */

import { runChat, runSingle } from "./cli/main.ts";
import { TurnLogger } from "./cli/logging.ts";
import { initSessionHash } from "./services/session-paths.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Version from package.json (kept in sync with pyproject.toml's 0.1.0).
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Initialize session hash before anything else.
initSessionHash();

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

// --version / -v (global, mirrors Python main.py:36-49): print version and exit.
if (args.includes("--version") || args.includes("-v")) {
  console.log(`wings ${VERSION}`);
  process.exit(0);
}

const hasLog = rest.includes("--log");

/** Read the value following any of the given option flags in `rest`. */
function optionValue(flags: string[]): string | null {
  for (const f of flags) {
    const idx = rest.indexOf(f);
    if (idx !== -1 && idx + 1 < rest.length) return rest[idx + 1]!;
  }
  return null;
}

const model = optionValue(["-m", "--model"]);
const workingDir = optionValue(["-d", "--dir"]);

if (!command || command === "chat") {
  const logger = hasLog ? new TurnLogger() : null;
  if (logger) console.log(`Logging to ${logger.path}`);
  await runChat({ model, workingDir: workingDir ?? undefined, logger });
} else if (command === "run") {
  // Prompt = all positional args (everything that isn't a flag or a flag value).
  const valueTaking = new Set(["-m", "--model", "-d", "--dir"]);
  const prompt = rest
    .filter((a, i) => {
      if (a === "--log" || valueTaking.has(a)) return false;
      if (i > 0 && valueTaking.has(rest[i - 1]!)) return false;
      return true;
    })
    .join(" ");
  if (!prompt.trim()) {
    console.error("Usage: node --import tsx src/index.ts run [-m model] [-d dir] \"prompt\"");
    process.exit(1);
  }
  const logger = hasLog ? new TurnLogger() : null;
  if (logger) console.log(`Logging to ${logger.path}`);
  await runSingle(prompt.trim(), { model, workingDir: workingDir ?? undefined, logger });
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: node --import tsx src/index.ts chat | run \"prompt\"");
  process.exit(1);
}
