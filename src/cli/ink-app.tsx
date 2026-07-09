/**
 * Ink entry point — renders the App component tree.
 *
 * Wraps process.stdin to ensure Ink's TTY check passes, even on terminals
 * (e.g. WSL) where `isTTY` is undefined despite raw mode being available.
 */

import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";

function ensureStdin(): NodeJS.ReadStream {
  const stdin = process.stdin as any;
  // If stdin already looks like a TTY to Ink, use it directly.
  if (stdin.isTTY && typeof stdin.setRawMode === "function") return stdin;

  // Wrap it to fake isTTY. Raw mode is already set by our enterRawMode().
  return new Proxy(stdin, {
    get(target, prop) {
      if (prop === "isTTY") return true;
      if (prop === "setRawMode") {
        return (flag: boolean) => {
          try { target.setRawMode?.(flag); } catch {}
        };
      }
      const val = target[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
  }) as unknown as NodeJS.ReadStream;
}

export function runInkApp() {
  const { waitUntilExit } = render(React.createElement(App), {
    stdin: ensureStdin(),
    stdout: process.stdout,
    exitOnCtrlC: false,
  });
  return waitUntilExit();
}
