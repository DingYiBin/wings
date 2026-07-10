#!/usr/bin/env node
/**
 * Wings CLI entry point.
 *
 * Usage:
 *   node --import tsx src/index.ts chat          # interactive REPL
 *   node --import tsx src/index.ts run "prompt"  # single turn
 *   node --import tsx src/index.ts chat --log    # with logging to .wings/logs/
 */

import { runChatFallback, runSingle } from "./cli/main.ts";
import { TurnLogger } from "./cli/logging.ts";
import { initSessionHash, getLatestSessionHash, loadSessionMessages, loadSessionMeta, getSessionMessagesPath } from "./services/session-paths.ts";

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

const hasLog = rest.includes("--log");
const hasResume = rest.includes("--resume");
const hasContinue = rest.includes("--continue");
const resumeIdx = rest.indexOf("--resume");
const resumeHash = resumeIdx !== -1 ? rest[resumeIdx + 1] : null;
const modelIdx = rest.indexOf("-m") !== -1 ? rest.indexOf("-m") : rest.indexOf("--model");
const model = modelIdx !== -1 ? rest[modelIdx + 1] : null;

if (!command || command === "chat") {
  const logger = hasLog ? new TurnLogger() : null;
  if (logger) console.log(`Logging to ${logger.path}`);

  // Resolve session hash for --resume / --continue.
  let sessionHash: string | null = null;
  let resumeMessages: Array<{ role: string; content: unknown[] }> | null = null;

  if (hasResume && resumeHash) {
    sessionHash = resumeHash;
    resumeMessages = loadSessionMessages(sessionHash);
    if (resumeMessages.length === 0) {
      console.error(`Session ${sessionHash} not found or has no messages.`);
      process.exit(1);
    }
    console.log(`Resuming session ${sessionHash} (${resumeMessages.length} messages)`);
  } else if (hasContinue) {
    sessionHash = getLatestSessionHash(process.cwd());
    if (!sessionHash) {
      console.error("No previous session found for this directory. Use --resume <hash> to specify one.");
      process.exit(1);
    }
    resumeMessages = loadSessionMessages(sessionHash);
    if (resumeMessages.length === 0) {
      console.error(`Session ${sessionHash} has no messages.`);
      process.exit(1);
    }
    console.log(`Continuing session ${sessionHash} (${resumeMessages.length} messages)`);
  }

  // Initialize session hash (use existing for resume, or generate new).
  initSessionHash(sessionHash ?? undefined);

  // Ink v7 (3rdparty) if raw mode available, else fallback.
  if (typeof (process.stdin as any).setRawMode === "function") {
    try {
      const { runInkApp } = await import("./cli/ink-app.tsx");
      await runInkApp({ logger, resumeMessages });
    } catch {
      await runChatFallback({ model, logger });
    }
  } else {
    await runChatFallback({ model, logger });
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
