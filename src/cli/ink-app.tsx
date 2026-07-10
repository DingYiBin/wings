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

export function runInkApp(opts: { resumeMessages?: Array<{ role: string; content: unknown[] }> | null } = {}) {
  if (opts.resumeMessages) {
    (globalThis as any).__resumeMessages = opts.resumeMessages;
  }
  // Enter alternate screen buffer so Ink frames don't pollute scrollback.
  process.stdout.write("\x1b[?1049h");
  const cleanup = () => {
    process.stdout.write("\x1b[?1049l"); // restore main screen
    process.stdout.write("\x1b[?25h");   // show cursor
    try { (process.stdin as any).setRawMode?.(false); } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  const { waitUntilExit } = render(React.createElement(App), {
    stdin: ensureStdin(),
    stdout: process.stdout,
    exitOnCtrlC: false,
  });
  return waitUntilExit().then(cleanup).catch(cleanup);
}
