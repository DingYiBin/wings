#!/usr/bin/env bun
/**
 * Wings CLI entry point.
 *
 * Usage:
 *   wings chat              # interactive REPL
 *   wings run "prompt"      # single turn
 */

import { runChat, runSingle } from "./cli/main.ts";

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "chat") {
  const modelIdx = args.indexOf("-m") !== -1 ? args.indexOf("-m") : args.indexOf("--model");
  const model = modelIdx !== -1 ? args[modelIdx + 1] : null;
  await runChat({ model });
} else if (command === "run") {
  const promptIdx = args.indexOf("run") + 1;
  const modelIdx = args.indexOf("-m") !== -1 ? args.indexOf("-m") : args.indexOf("--model");
  const model = modelIdx !== -1 ? args[modelIdx + 1] : null;
  let prompt = args.slice(promptIdx).join(" ");
  // Remove --model/-m and its value from the prompt.
  for (const flag of ["-m", "--model"]) {
    const fi = args.indexOf(flag);
    if (fi !== -1) {
      const before = args.slice(promptIdx, fi);
      const after = args.slice(fi + 2);
      prompt = [...before, ...after].join(" ");
    }
  }
  if (!prompt || prompt.trim() === "") {
    console.error("Usage: wings run [-m model] \"prompt\"");
    process.exit(1);
  }
  await runSingle(prompt.trim(), { model });
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Usage: wings chat | wings run \"prompt\"");
  process.exit(1);
}
