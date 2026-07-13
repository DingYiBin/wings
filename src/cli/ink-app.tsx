import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";

function ensureStdin(): NodeJS.ReadStream {
  const stdin = process.stdin as any;
  // If setRawMode exists, stdin IS a TTY (even if isTTY is undefined on WSL).
  if (typeof stdin.setRawMode === "function") {
    // Patch isTTY if missing so Ink's check passes.
    if (stdin.isTTY === undefined) {
      Object.defineProperty(stdin, "isTTY", { get: () => true, configurable: true });
    }
    return stdin;
  }
  // Fallback: fake TTY via Proxy (piped stdin, etc.).
  return new Proxy(stdin, {
    get(target, prop) {
      if (prop === "isTTY") return true;
      if (prop === "setRawMode") return (flag: boolean) => { try { target.setRawMode?.(flag); } catch {} };
      const val = target[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
  }) as unknown as NodeJS.ReadStream;
}

export function runInkApp(opts: { resumeMessages?: Array<{ role: string; content: unknown[] }> | null; resumeStats?: { input: number; output: number; wait: number } | null; workingDir?: string | null } = {}) {
  if (opts.resumeMessages) {
    (globalThis as any).__resumeMessages = opts.resumeMessages;
  }
  if (opts.resumeStats) {
    (globalThis as any).__resumeStats = opts.resumeStats;
  }
  if (opts.workingDir) {
    (globalThis as any).__workingDir = opts.workingDir;
  }
  const { waitUntilExit } = render(React.createElement(App), {
    stdin: ensureStdin(),
    stdout: process.stdout,
    exitOnCtrlC: false,
    // Enable the kitty keyboard protocol (auto-detected, safe on any terminal)
    // so modified Enter — Ctrl+Enter / Shift+Enter — is reported distinctly
    // from a plain Enter, letting PromptInput insert a newline instead of submitting.
    kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes"] },
  });
  return waitUntilExit();
}
