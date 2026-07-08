#!/usr/bin/env -S npx tsx
/**
 * Wings CLI entry point.
 *
 * Usage:
 *   wings chat              # interactive REPL (Ink if TTY, readline fallback)
 *   wings run "prompt"      # single turn
 *   wings chat --log        # with logging to .wings/logs/
 */

import { runChat, runSingle } from "./cli/main.ts";
import { TurnLogger } from "./cli/logging.ts";

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

const hasLog = rest.includes("--log");
const modelIdx = rest.indexOf("-m") !== -1 ? rest.indexOf("-m") : rest.indexOf("--model");
const model = modelIdx !== -1 ? rest[modelIdx + 1] : null;

function hasTty(): boolean {
  return process.stdin.isTTY === true && typeof process.stdin.setRawMode === "function";
}

if (!command || command === "chat") {
  const logger = hasLog ? new TurnLogger(process.cwd()) : null;
  if (logger) console.log(`Logging to ${logger.path}`);

  if (hasTty()) {
    // Ink REPL (Node.js with real TTY).
    try {
      const { runInkApp } = await import("./cli/ink-app.tsx");
      await runInkApp();
    } catch (e) {
      if (logger) console.log(`Logging to ${logger.path}`);
      // Fallback to raw-stdin REPL on Ink failure.
      await runChat({ model, logger });
    }
  } else {
    // No TTY: use raw-stdin REPL.
    await runChat({ model, logger });
  }
} else if (command === "run") {
  const prompt = rest
    .filter((a, i) => {
      if (a === "--log" || a === "-m" || a === "--model") return false;
      if (i > 0 && (rest[i - 1] === "-m" || rest[i - 1] === "--model")) return false;
      return true;
    })
    .join(" ");
  if (!prompt.trim()) {
    console.error("Usage: wings run [-m model] \"prompt\"");
    process.exit(1);
  }
  const logger = hasLog ? new TurnLogger(process.cwd()) : null;
  if (logger) console.log(`Logging to ${logger.path}`);
  await runSingle(prompt.trim(), { model, logger });
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: wings chat | wings run \"prompt\"");
  process.exit(1);
}
