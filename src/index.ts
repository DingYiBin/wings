#!/usr/bin/env bun
/**
 * Wings CLI entry point.
 *
 * Usage:
 *   wings chat              # interactive REPL
 *   wings chat --log        # with logging to .wings/logs/
 *   wings run "prompt"      # single turn
 *   wings run "prompt" --log
 */

import { runChat, runSingle } from "./cli/main.ts";
import { TurnLogger } from "./cli/logging.ts";

const args = process.argv.slice(2);
const command = args[0];

// Parse flags from remaining args (after command).
const rest = args.slice(1);
const hasLog = rest.includes("--log");
const modelIdx = rest.indexOf("-m") !== -1 ? rest.indexOf("-m") : rest.indexOf("--model");
const model = modelIdx !== -1 ? rest[modelIdx + 1] : null;

function makeLogger(workingDir?: string): TurnLogger | null {
  return hasLog ? new TurnLogger(workingDir ?? process.cwd()) : null;
}

if (!command || command === "chat") {
  const logger = makeLogger();
  if (logger) console.log(`Logging to ${logger.path}`);
  await runChat({ model, logger });
} else if (command === "run") {
  // Extract prompt: args after "run", minus flags.
  const prompt = rest
    .filter((a, i) => {
      if (a === "--log") return false;
      if (a === "-m" || a === "--model") return false;
      if (i > 0 && (rest[i - 1] === "-m" || rest[i - 1] === "--model")) return false;
      return true;
    })
    .join(" ");
  if (!prompt.trim()) {
    console.error("Usage: wings run [-m model] [--log] \"prompt\"");
    process.exit(1);
  }
  const logger = makeLogger();
  if (logger) console.log(`Logging to ${logger.path}`);
  await runSingle(prompt.trim(), { model, logger });
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: wings chat | wings run \"prompt\"");
  process.exit(1);
}
