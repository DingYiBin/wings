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

// Initialize session hash before anything else.
initSessionHash();

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

const hasLog = rest.includes("--log");
const modelIdx = rest.indexOf("-m") !== -1 ? rest.indexOf("-m") : rest.indexOf("--model");
const model = modelIdx !== -1 ? rest[modelIdx + 1] : null;

if (!command || command === "chat") {
  const logger = hasLog ? new TurnLogger() : null;
  if (logger) console.log(`Logging to ${logger.path}`);
  await runChat({ model, logger });
} else if (command === "run") {
  const prompt = rest
    .filter((a, i) => {
      if (a === "--log" || a === "-m" || a === "--model") return false;
      if (i > 0 && (rest[i - 1] === "-m" || rest[i - 1] === "--model")) return false;
      return true;
    })
    .join(" ");
  if (!prompt.trim()) {
    console.error("Usage: node --import tsx src/index.ts run [-m model] \"prompt\"");
    process.exit(1);
  }
  const logger = hasLog ? new TurnLogger() : null;
  if (logger) console.log(`Logging to ${logger.path}`);
  await runSingle(prompt.trim(), { model, logger });
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: node --import tsx src/index.ts chat | run \"prompt\"");
  process.exit(1);
}
