import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";
import { TurnLogger } from "./logging.ts";
import { setGlobalLogger } from "./hooks.ts";

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

export function runInkApp(opts: { logger?: TurnLogger | null; resumeMessages?: Array<{ role: string; content: unknown[] }> | null } = {}) {
  if (opts.logger) setGlobalLogger(opts.logger);
  if (opts.resumeMessages) {
    // Pass resume messages to the global store for hooks.ts to pick up.
    (globalThis as any).__resumeMessages = opts.resumeMessages;
  }
  const { waitUntilExit } = render(React.createElement(App), {
    stdin: ensureStdin(),
    stdout: process.stdout,
    exitOnCtrlC: false,
  });
  return waitUntilExit();
}
