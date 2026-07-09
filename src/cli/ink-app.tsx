import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";
import { TurnLogger } from "./logging.ts";
import { setGlobalLogger } from "./hooks.ts";

function ensureStdin(): NodeJS.ReadStream {
  const stdin = process.stdin as any;
  if (stdin.isTTY && typeof stdin.setRawMode === "function") return stdin;
  return new Proxy(stdin, {
    get(target, prop) {
      if (prop === "isTTY") return true;
      if (prop === "setRawMode") {
        return (flag: boolean) => { try { target.setRawMode?.(flag); } catch {} };
      }
      const val = target[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
  }) as unknown as NodeJS.ReadStream;
}

export function runInkApp(opts: { logger?: TurnLogger | null } = {}) {
  if (opts.logger) setGlobalLogger(opts.logger);
  const { waitUntilExit } = render(React.createElement(App), {
    stdin: ensureStdin(),
    stdout: process.stdout,
    exitOnCtrlC: false,
  });
  return waitUntilExit();
}
