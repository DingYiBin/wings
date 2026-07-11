/**
 * Wings CLI — single-turn (run) + readline fallback for non-TTY.
 *
 * The main interactive REPL is ink-app.tsx (Ink v7).
 * This file provides runSingle and a minimal readline chat for piped stdin.
 */

import { openSync, readSync, closeSync } from "node:fs";
import { createSession, makeAgentContext } from "./bootstrap.ts";

const GREEN = "\x1b[32m"; const CYAN = "\x1b[36m"; const YELLOW = "\x1b[33m";
const RED = "\x1b[31m"; const RESET = "\x1b[0m"; const BOLD = "\x1b[1m"; const DIM = "\x1b[2m";
const SHOW_CURSOR = "\x1b[?25h"; const HIDE_CURSOR = "\x1b[?25l";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function trunc(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n); }

const encoder = new TextEncoder();
const write = (s: string) => { process.stdout.write(encoder.encode(s)); };

// -- Permission dialog (reads /dev/tty for arrow keys) --

async function promptPermission(
  toolName: string, toolInput: Record<string, unknown>, scope?: string,
): Promise<string> {
  const opts = [
    { v: "allow", l: "Yes" },
    { v: "allow_always", l: scope ? `Yes, and don't ask again for ${toolName}(${scope})` : `Yes, and don't ask again for ${toolName}` },
    { v: "deny", l: "No, tell Wings what to do differently" },
  ];
  let sel = 0;
  let fd = -1; try { fd = openSync("/dev/tty", "r"); } catch { fd = -1; }

  if (fd < 0) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    write(`\r\n${YELLOW}  🔒 ${BOLD}${toolName}${RESET}: ${dim(JSON.stringify(toolInput).slice(0, 80))}\r\n  ${dim("[y=allow / n=deny / a=allow always]")}\r\n`);
    const a = await new Promise<string>(r => rl.question(`  ${GREEN}>${RESET} `, x => r(x.trim().toLowerCase())));
    rl.close(); if (a === "y" || a === "yes") return "allow"; if (a === "a" || a === "always") return "allow_always"; return "deny";
  }

  write(HIDE_CURSOR);
  const d = JSON.stringify(toolInput).slice(0, 76);
  let lines = [`\r\n  ${YELLOW}┌${RESET} Permission ${dim("─".repeat(60))}`, `\r\n  │ ${dim(d)}`, `\r\n  │`];
  for (let i = 0; i < opts.length; i++) lines.push(`\r\n  │ ${i === sel ? `${BOLD}❯ ` : "  "}${i === sel ? opts[i]!.l : dim(opts[i]!.l)}`);
  lines.push(`\r\n  │`, `\r\n  │ ${dim("↑↓ navigate  ·  Enter select  ·  y=allow  n=deny  esc=deny")}`, `\r\n  ${dim("└" + "─".repeat(66))}`);
  write(lines.join("")); let r = lines.length;

  while (true) {
    const buf = Buffer.alloc(16); const n = readSync(fd, buf, 0, 16, null);
    if (n <= 0) { await new Promise(r => setTimeout(r, 10)); continue; }
    const raw = buf.toString("utf-8", 0, n);
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!, c = ch.charCodeAt(0);
      if (raw.slice(i).startsWith("\x1b[A")) { sel = (sel - 1 + opts.length) % opts.length; write(`\x1b[${r}A`); lines = [`\r\n  ${YELLOW}┌${RESET} Permission ${dim("─".repeat(60))}`, `\r\n  │ ${dim(d)}`, `\r\n  │`]; for (let j = 0; j < opts.length; j++) lines.push(`\r\n  │ ${j === sel ? `${BOLD}❯ ` : "  "}${j === sel ? opts[j]!.l : dim(opts[j]!.l)}`); lines.push(`\r\n  │`, `\r\n  │ ${dim("↑↓ navigate  ·  Enter select  ·  y=allow  n=deny  esc=deny")}`, `\r\n  ${dim("└" + "─".repeat(66))}`); write(lines.join("")); r = lines.length; i += 2; continue; }
      if (raw.slice(i).startsWith("\x1b[B")) { sel = (sel + 1) % opts.length; write(`\x1b[${r}A`); lines = [`\r\n  ${YELLOW}┌${RESET} Permission ${dim("─".repeat(60))}`, `\r\n  │ ${dim(d)}`, `\r\n  │`]; for (let j = 0; j < opts.length; j++) lines.push(`\r\n  │ ${j === sel ? `${BOLD}❯ ` : "  "}${j === sel ? opts[j]!.l : dim(opts[j]!.l)}`); lines.push(`\r\n  │`, `\r\n  │ ${dim("↑↓ navigate  ·  Enter select  ·  y=allow  n=deny  esc=deny")}`, `\r\n  ${dim("└" + "─".repeat(66))}`); write(lines.join("")); r = lines.length; i += 2; continue; }
      if (c === 0x0d) { try { closeSync(fd); } catch {} write(SHOW_CURSOR); write(`\x1b[${r}A\x1b[J`); return opts[sel]!.v; }
      if (ch === "y" || ch === "Y") { try { closeSync(fd); } catch {} write(SHOW_CURSOR); write(`\x1b[${r}A\x1b[J`); return "allow"; }
      if (ch === "n" || ch === "N" || c === 0x1b || c === 0x03) { try { closeSync(fd); } catch {} write(SHOW_CURSOR); write(`\x1b[${r}A\x1b[J`); return "deny"; }
      if (c >= 0x31 && c <= 0x33) { try { closeSync(fd); } catch {} write(SHOW_CURSOR); write(`\x1b[${r}A\x1b[J`); return opts[c - 0x31]!.v; }
    }
  }
}

// -- Single-turn --

export async function runSingle(
  prompt: string,
  opts: { workingDir?: string; model?: string | null } = {},
): Promise<void> {
  const { loop, config } = await createSession(opts.workingDir);
  const ctx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model ?? null, customAgents: (loop as any).customAgents ?? null, skills: (loop as any).skillsList ?? [] });
  for await (const event of loop.run(prompt, ctx)) {
    if (event.type === "text_delta") write((event as any).text);
    else if (event.type === "tool_use") write(`\r\n${dim("  ⚙")} ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 80))}`);
    else if (event.type === "tool_result") { const c = (event as any).content ?? ""; const p = trunc(c, 80).replace(/\n/g, " "); if ((event as any).is_error) write(`\r\n${dim("  ↳")} ${RED}${p}${RESET}`); else if (p) write(`\r\n${dim("  ↳")} ${dim(p)}`); }
    else if (event.type === "permission_request") loop.setPermissionResponse(await promptPermission(event.tool_name, event.tool_input, event.scope));
  }
  write("\r\n");
}

// -- Readline fallback for non-TTY environments --

export async function runChatFallback(opts: { model?: string | null } = {}): Promise<void> {
  const { loop, config, poolMgr } = await createSession(undefined);
  const ctx = makeAgentContext(config, { modelOverride: opts.model ?? null, customAgents: (loop as any).customAgents ?? null, skills: (loop as any).skillsList ?? [] });

  write(`\r\n${BOLD}wings${RESET} ${dim("— each model is a wing")}\r\n\r\n`);
  write(dim("Type /help, Ctrl+C to exit\r\n\r\n"));

  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.setPrompt(`${GREEN}❯${RESET} `); rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim(); if (!text) { rl.prompt(); return; }
    if (text.startsWith("/")) { handleCommand(text, poolMgr); rl.prompt(); return; }
    try {
      for await (const e of loop.run(text, ctx)) {
        if (e.type === "text_delta") write((e as any).text);
        else if (e.type === "tool_use") write(`\r\n${dim("  ⚙")} ${CYAN}${e.name}${RESET} ${dim(trunc(JSON.stringify(e.input), 80))}`);
        else if (e.type === "permission_request") loop.setPermissionResponse(await promptPermission(e.tool_name, e.tool_input, e.scope));
      }
      write("\r\n");
    } catch (e) { write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`); }
    rl.prompt();
  });
}

function handleCommand(cmd: string, poolMgr: any) {
  const p = cmd.split(/\s+/); const n = p[0]!;
  if (n === "/help" || n === "/h") write(dim("Commands: /help, /pool, Ctrl+C twice to exit\r\n"));
  else if (n === "/pool" && poolMgr) {
    if (p.length === 1) { const i = poolMgr.getPoolInfo("main"); write(dim("API pool:\r\n")); for (const [id, s] of Object.entries(i as Record<string, any>)) write(dim(`  ${id}: ${s.effective === -Infinity ? "disabled" : s.effective.toFixed(1)}\r\n`)); }
    else if (p.length === 3 && (p[1] === "up" || p[1] === "down")) { p[1] === "up" ? poolMgr.upvote("main", p[2]!) : poolMgr.downvote("main", p[2]!); write(dim(`  ${p[1] === "up" ? "↑" : "↓"} ${p[2]}\r\n`)); }
  } else write(dim(`Unknown: ${n}. /help\r\n`));
}
