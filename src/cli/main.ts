/**
 * Wings CLI — chat REPL + single-turn (run).
 *
 * Raw mode stdin for line editing (like claude-code).
 * Permission prompts read directly from /dev/tty for reliability.
 */

import { openSync, readSync, closeSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { createSession, makeAgentContext } from "./bootstrap.ts";
import { shouldExtractMemory, recordExtraction, extractSessionMemory } from "../services/session-memory.ts";
import { activeChild } from "../tools/builtin/bash.ts";

// -- Debug log to file (survives terminal corruption) --
const DLOG = process.env["WINGS_DEBUG"]
  ? (tag: string, ...args: unknown[]) => {
      const ts = new Date().toISOString().slice(11, 23);
      const msg = `[${ts}] ${tag} ${args.map(String).join(" ")}\n`;
      try { appendFileSync("/tmp/wings-debug.log", msg); } catch {}
    }
  : (..._: unknown[]) => {};

const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function trunc(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n); }

const encoder = new TextEncoder();
const write = (s: string) => { process.stdout.write(encoder.encode(s)); };

// Auto-extract memories after a turn (runs every 5 turns, best-effort).
// Mirrors Python main.py: the loop holds the extractMemories callback set in
// createSession; we pass it the user input plus a pointer to the assistant's
// answer (already streamed above).
async function maybeExtract(loop: any, userInput: string): Promise<void> {
  const extractor = loop?.extractMemories;
  if (typeof extractor !== "function") return;
  try {
    const context = `User: ${userInput}\n\nAssistant answered with the content above.`;
    await extractor.call(loop, context);
  } catch {
    // best-effort — never fail the turn
  }
}

let sessionToolCallCount = 0;

/** Fire-and-forget session memory extraction (claude-code post-sampling hook pattern). */
function tryExtractSessionMemory(
  workingDir: string,
  loop: any,
  engine: any,
  modelRegistry: any,
  toolRegistry: any,
  poolMgr: any,
) {
  const messages = loop.messages as any[] | undefined;
  if (!messages || messages.length === 0) return;
  sessionToolCallCount++;
  if (!shouldExtractMemory(messages, sessionToolCallCount)) return;

  // Fire and forget — don't block the REPL.
  extractSessionMemory({
    workingDir,
    messages,
    queryEngine: engine,
    modelRegistry,
    toolRegistry,
    modelSelector: poolMgr,
  }).then((updated) => {
    if (updated) recordExtraction(messages, sessionToolCallCount);
  }).catch(() => {});
}

// -- Raw stdin helpers --

function enterRawMode(): boolean {
  const stdin = process.stdin as any;
  if (typeof stdin.setRawMode !== "function") return false;
  try { stdin.setRawMode(true); return true; } catch { return false; }
}

function exitRawMode() {
  try { (process.stdin as any).setRawMode(false); } catch {}
}

function graphemeBackspace(s: string): string {
  if (!s) return s;
  try {
    const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
    return [...seg.segment(s)].map((x) => x.segment).slice(0, -1).join("");
  } catch { return s.slice(0, -1); }
}

// -- Permission dialog: reads directly from /dev/tty --

function buildPermOptions(toolName: string, scope?: string) {
  return [
    { value: "allow", label: "Yes" },
    { value: "allow_always", label: scope
      ? `Yes, and don't ask again for ${toolName}(${scope})`
      : `Yes, and don't ask again for ${toolName}` },
    { value: "deny", label: "No, tell Wings what to do differently" },
  ];
}

function renderPermDialog(
  input: Record<string, unknown>,
  options: ReturnType<typeof buildPermOptions>,
  sel: number,
): number {
  const desc = JSON.stringify(input).slice(0, 76);
  const lines: string[] = [];
  lines.push(`\r\n  ${YELLOW}┌${RESET} Permission ${dim("─".repeat(60))}`);
  lines.push(`\r\n  │ ${dim(desc)}`);
  lines.push(`\r\n  │`);
  for (let i = 0; i < options.length; i++) {
    const isSel = i === sel;
    lines.push(`\r\n  │ ${isSel ? `${BOLD}❯ ` : "  "}${isSel ? options[i]!.label : dim(options[i]!.label)}`);
  }
  lines.push(`\r\n  │`);
  lines.push(`\r\n  │ ${dim("↑↓ navigate  ·  Enter select  ·  y=allow  n=deny  esc=deny")}`);
  lines.push(`\r\n  ${dim("└" + "─".repeat(66))}`);
  write(lines.join(""));
  return lines.length;
}

/** Read a single key from /dev/tty in raw mode. Returns null if unavailable. */
function readTtyKey(ttyFd: number): string | null {
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(ttyFd, buf, 0, buf.length, null);
    if (n <= 0) return null;
    return buf.toString("utf-8", 0, n);
  } catch {
    return null;
  }
}

/**
 * Show an arrow-key-navigable permission prompt by reading directly from
 * /dev/tty. Completely independent from process.stdin — works even when
 * the stdin data handler isn't firing.
 */
async function promptPermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  scope?: string,
): Promise<string> {
  DLOG("PERM-START", toolName);
  const options = buildPermOptions(toolName, scope);
  let selected = 0;

  let ttyFd = -1;
  try { ttyFd = openSync("/dev/tty", "r"); DLOG("PERM-TTY", "opened fd=" + ttyFd); } catch { ttyFd = -1; }

  if (ttyFd < 0) {
    DLOG("PERM-FALLBACK", "no /dev/tty");
    // Fallback: use readline.
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const desc = JSON.stringify(toolInput).slice(0, 80);
    write(`\r\n${YELLOW}  🔒 ${BOLD}${toolName}${RESET}: ${dim(desc)}\r\n`);
    write(`  ${dim("[y=allow / n=deny / a=allow always]")}\r\n`);
    const a = await new Promise<string>((r) => rl.question(`  ${GREEN}>${RESET} `, (x) => r(x.trim().toLowerCase())));
    rl.close();
    if (a === "y" || a === "yes") return "allow";
    if (a === "a" || a === "always") return "allow_always";
    return "deny";
  }

  // Save and restore terminal settings.
  let oldTermios: Buffer | null = null;
  try {
    // Read raw keystrokes from /dev/tty.
    write(HIDE_CURSOR);
    let rendered = renderPermDialog(toolInput, options, selected);

    while (true) {
      const raw = readTtyKey(ttyFd);
      if (!raw) { await new Promise((r) => setTimeout(r, 10)); continue; }

      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i]!;
        const code = ch.charCodeAt(0);

        // Arrow up: ESC [ A
        if (raw.slice(i).startsWith("\x1b[A")) {
          selected = (selected - 1 + options.length) % options.length;
          write(`\x1b[${rendered}A`);
          rendered = renderPermDialog(toolInput, options, selected);
          i += 2; continue;
        }
        // Arrow down: ESC [ B
        if (raw.slice(i).startsWith("\x1b[B")) {
          selected = (selected + 1) % options.length;
          write(`\x1b[${rendered}A`);
          rendered = renderPermDialog(toolInput, options, selected);
          i += 2; continue;
        }
        // Enter
        if (code === 0x0d) { const val = options[selected]!.value; DLOG("PERM-CHOICE", "enter ->", val); closeSync(ttyFd); write(SHOW_CURSOR); write(`\x1b[${rendered}A\x1b[J`); return val; }
        if (ch === "y" || ch === "Y") { DLOG("PERM-CHOICE", "y -> allow"); closeSync(ttyFd); write(SHOW_CURSOR); write(`\x1b[${rendered}A\x1b[J`); return "allow"; }
        if (ch === "n" || ch === "N" || code === 0x1b || code === 0x03) { DLOG("PERM-CHOICE", "n/esc -> deny"); closeSync(ttyFd); write(SHOW_CURSOR); write(`\x1b[${rendered}A\x1b[J`); return "deny"; }
        if (code >= 0x31 && code <= 0x33) { const val = options[code - 0x31]!.value; DLOG("PERM-CHOICE", "num ->", val); closeSync(ttyFd); write(SHOW_CURSOR); write(`\x1b[${rendered}A\x1b[J`); return val; }
        // j / k
        if (ch === "j") { selected = (selected + 1) % options.length; write(`\x1b[${rendered}A`); rendered = renderPermDialog(toolInput, options, selected); }
        if (ch === "k") { selected = (selected - 1 + options.length) % options.length; write(`\x1b[${rendered}A`); rendered = renderPermDialog(toolInput, options, selected); }
      }
    }
  } finally {
    if (ttyFd >= 0) try { closeSync(ttyFd); } catch {}
    write(SHOW_CURSOR);
  }
}

// -- Single-turn --

export async function runSingle(
  prompt: string,
  opts: { workingDir?: string; model?: string | null; logger?: { recordCycle(opts: Record<string, unknown>): void } | null } = {},
): Promise<void> {
  const { loop, config } = await createSession(opts.workingDir, opts.logger);
  // runSingle doesn't use engine/modelRegistry/toolRegistry
  const ctx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model ?? null, customAgents: (loop as any).customAgents ?? null, skills: (loop as any).skillsList ?? [] });

  for await (const event of loop.run(prompt, ctx)) {
    switch (event.type) {
      case "text_delta": write((event as any).text); break;
      case "tool_use": write(`\r\n${dim("  ⚙")} ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 80))}`); break;
      case "tool_result": { const content = (event as any).content ?? ""; const preview = trunc(content, 80).replace(/\n/g, " "); if ((event as any).is_error) write(`\r\n${dim("  ↳")} ${RED}${preview}${RESET}`); else if (preview) write(`\r\n${dim("  ↳")} ${dim(preview)}`); break; }
      case "permission_request":
        loop.setPermissionResponse(await promptPermission(event.tool_name, event.tool_input, event.scope));
        break;
    }
  }
  write("\r\n");

  await maybeExtract(loop, prompt);
}

// -- Interactive chat (raw mode) --

export async function runChat(
  opts: { workingDir?: string; model?: string | null; logger?: { recordCycle(opts: Record<string, unknown>): void } | null } = {},
): Promise<void> {
  const { loop, config, poolMgr, engine, modelRegistry, toolRegistry } = await createSession(opts.workingDir, opts.logger);
  const ctx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model ?? null, customAgents: (loop as any).customAgents ?? null, skills: (loop as any).skillsList ?? [] });

  write(`\r\n${BOLD}wings${RESET} ${dim("— each model is a wing")}\r\n`);
  write(dim("Type /help, Ctrl+C to exit\r\n\r\n"));

  const raw = enterRawMode();
  if (!raw) {
    write(dim("(raw mode unavailable, using basic input)\r\n"));
    await runChatFallback(loop, ctx, poolMgr, config);
    return;
  }
  let buffer = "";
  let running = false;
  const PROMPT = `${GREEN}▸${RESET} `;
  write(`\r\x1b[K${PROMPT}`);

  // -- History (cross-session, stored in ~/.wings/sessions/history.jsonl) --
  const historyFile = pathJoin(homedir(), ".wings", "sessions", "history.jsonl");
  let history: string[] = [];
  let historyIdx = 0;
  try {
    if (existsSync(historyFile)) {
      history = readFileSync(historyFile, "utf-8").trim().split("\n")
        .map(l => { try { return (JSON.parse(l) as any).text as string; } catch { return ""; } })
        .filter(Boolean);
    }
    historyIdx = history.length; // start at "new entry" position
  } catch {}
  function saveHistoryEntry(line: string) {
    try {
      const { mkdirSync } = require("node:fs") as typeof import("node:fs");
      mkdirSync(pathJoin(homedir(), ".wings", "sessions"), { recursive: true });
      appendFileSync(historyFile, JSON.stringify({ text: line }) + "\n");
    } catch {}
  }

  const doTurn = async (line: string) => {
    const text = line.trim();
    if (!text) { write(`\r\x1b[K${PROMPT}`); return; }
    // Add to history, remove duplicates.
    history = history.filter(h => h !== text);
    history.push(text);
    if (history.length > 1000) history.shift();
    historyIdx = history.length;
    saveHistoryEntry(text);
    running = true;

    if (text.startsWith("/")) { handleCommand(text, poolMgr); write(`\r\x1b[K${PROMPT}`); running = false; return; }

    let prevEvent = "";
    try {
      for await (const event of loop.run(text, ctx)) {
        switch (event.type) {
          case "text_delta":
            if (prevEvent === "tool_result") write(`\r\n${dim("  ──────")}\r\n`);
            write((event as any).text);
            break;
          case "tool_use": write(`\r\n${dim("  ⚙")} ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 80))}`); break;
          case "tool_result": { const tr = event as any; const content = tr.content ?? ""; const preview = trunc(content, 80).replace(/\n/g, " "); if (tr.is_error) write(`\r\n${dim("  ↳")} ${RED}${preview}${RESET}`); else if (preview) write(`\r\n${dim("  ↳")} ${dim(preview)}`); break; }
          case "permission_request":
            DLOG("DO-PERM", "calling promptPermission...");
            const permResp = await promptPermission(event.tool_name, event.tool_input, event.scope);
            DLOG("DO-PERM", "got", permResp, "calling setPermissionResponse...");
            loop.setPermissionResponse(permResp);
            DLOG("DO-PERM", "setPermissionResponse returned, continuing loop...");
            break;
          case "subagent_start": write(`\r\n${dim("  ┌ subagent")} ${CYAN}${(event as any).agent_type}${RESET} ${dim((event as any).description)}\r\n`); break;
          case "subagent_end": write(`${dim("  └ done")}\r\n`); break;
        }
        prevEvent = event.type;
      }
      write("\r\n");
    } catch (e) { write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`); }
    await maybeExtract(loop, text);
    tryExtractSessionMemory(opts.workingDir ?? process.cwd(), loop, engine, modelRegistry, toolRegistry, poolMgr);
    write(`\r\x1b[K${PROMPT}`);
    running = false;
  };

  // Cursor position within buffer (0 = start, buffer.length = end).
  let cursor = 0;
  // Double-tap Ctrl+C tracking.
  let lastCtrlC = 0;

  // -- Word boundary helper --
  const wordLeft = (s: string, pos: number): number => {
    // Skip whitespace, then skip non-whitespace.
    let p = pos;
    while (p > 0 && s[p - 1] === " ") p--;
    while (p > 0 && s[p - 1] !== " ") p--;
    return p;
  };
  const wordRight = (s: string, pos: number): number => {
    let p = pos;
    while (p < s.length && s[p] !== " ") p++;
    while (p < s.length && s[p] === " ") p++;
    return p;
  };

  // -- Render line with inverted cursor (matches claude-code Layer 1) --
  const REV = "\x1b[7m";  // reverse video
  const REV_OFF = "\x1b[27m";
  const renderLine = () => {
    const before = buffer.slice(0, cursor);
    const atCursor = buffer[cursor] ?? " ";
    const after = buffer.slice(cursor + 1);
    // Prompt + before-cursor text + inverted cursor char + after-cursor text.
    write(`\r\x1b[K${PROMPT}${before}${REV}${atCursor}${REV_OFF}${after}`);
    // Move terminal cursor back to just after the prompt + before-cursor text,
    // so the native cursor sits on the inverted character.
    if (after.length > 0) write(`\x1b[${after.length}D`);
    // The cursor is now visually on the inverted character and physically
    // positioned for IME input at that spot.
  };

  // -- Data handler --
  process.stdin.on("data", (data: Buffer) => {
    if (running) {
      const raw = data.toString("utf-8");
      if (raw === "\x1b" || raw === "\x03" ||
          (raw.includes("\x1b") && !raw.includes("\x1b[") && !raw.includes("\x1bO"))) {
        (loop as any)._aborted = true;
        if (activeChild) { activeChild.kill("SIGKILL"); }
      }
      return;
    }
    const rawStr = data.toString("utf-8");
    for (let i = 0; i < rawStr.length; i++) {
      const ch = rawStr[i]!;
      const code = ch.charCodeAt(0);
      const rest = rawStr.slice(i);

      // ── History (up/down arrows) ──
      // ESC [ A = up, ESC [ B = down, Ctrl+P = up, Ctrl+N = down
      if (rest.startsWith("\x1b[A") || code === 0x10 /* Ctrl+P */) {
        if (history.length > 0 && historyIdx >= 0) {
          if (historyIdx === history.length) historyIdx = history.length - 1;
          else if (historyIdx > 0) historyIdx--;
          buffer = history[historyIdx] ?? "";
          cursor = buffer.length;
          renderLine();
        }
        i += code === 0x10 ? 0 : 2; continue;
      }
      if (rest.startsWith("\x1b[B") || code === 0x0e /* Ctrl+N */) {
        if (historyIdx < history.length - 1) {
          historyIdx++;
          buffer = history[historyIdx] ?? "";
        } else {
          historyIdx = history.length;
          buffer = "";
        }
        cursor = buffer.length;
        renderLine();
        i += code === 0x0e ? 0 : 2; continue;
      }
      // ── Arrow / navigation ──
      if (rest.startsWith("\x1b[D") || code === 0x02 /* Ctrl+B */) {
        cursor = Math.max(0, cursor - 1); renderLine(); i += code === 0x02 ? 0 : 2; continue;
      }
      if (rest.startsWith("\x1b[C") || code === 0x06 /* Ctrl+F */) {
        cursor = Math.min(buffer.length, cursor + 1); renderLine(); i += code === 0x06 ? 0 : 2; continue;
      }
      // Ctrl+Left / ESC [ 1 ; 5 D: word left
      if (rest.startsWith("\x1b[1;5D") || rest.startsWith("\x1b[1;2D")) {
        cursor = wordLeft(buffer, cursor); renderLine(); i += 5; continue;
      }
      // Ctrl+Right / ESC [ 1 ; 5 C: word right
      if (rest.startsWith("\x1b[1;5C") || rest.startsWith("\x1b[1;2C")) {
        cursor = wordRight(buffer, cursor); renderLine(); i += 5; continue;
      }
      // Home / Ctrl+A
      if (rest.startsWith("\x1b[H") || rest.startsWith("\x1b[1~") || code === 0x01) {
        cursor = 0; renderLine();
        if (code !== 0x01) { i += rest.startsWith("\x1b[1~") ? 3 : 2; } continue;
      }
      // End / Ctrl+E
      if (rest.startsWith("\x1b[F") || rest.startsWith("\x1b[4~") || code === 0x05) {
        cursor = buffer.length; renderLine();
        if (code !== 0x05) { i += rest.startsWith("\x1b[4~") ? 3 : 2; } continue;
      }

      // ── Editing ──
      if (code === 0x0d) { // Enter
        const line = buffer; buffer = ""; cursor = 0;
        write("\r\n"); doTurn(line); return;
      }
      // Delete: ESC [ 3 ~
      if (rest.startsWith("\x1b[3~")) {
        if (cursor < buffer.length) {
          const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
          const graphemes = [...seg.segment(buffer.slice(cursor))];
          buffer = buffer.slice(0, cursor) + graphemes.slice(1).map(x => x.segment).join("");
          renderLine();
        }
        i += 3; continue;
      }
      // Backspace / Ctrl+H
      if (code === 0x7f || code === 0x08) {
        if (cursor > 0) {
          const before = buffer.slice(0, cursor);
          const newBefore = graphemeBackspace(before);
          const removed = before.length - newBefore.length;
          buffer = newBefore + buffer.slice(cursor);
          cursor -= removed;
          renderLine();
        }
        continue;
      }
      // Ctrl+W: delete word before.
      if (code === 0x17) {
        const cutPos = wordLeft(buffer, cursor);
        buffer = buffer.slice(0, cutPos) + buffer.slice(cursor);
        cursor = cutPos;
        renderLine(); continue;
      }

      // ── Exit ──
      if (code === 0x03) { // Ctrl+C — double-tap to exit
        const now = Date.now();
        if (lastCtrlC > 0 && now - lastCtrlC < 2000) {
          exitRawMode(); write(SHOW_CURSOR + "\r\n"); process.exit(0);
        }
        lastCtrlC = now;
        write(`\r\n${dim("  Press Ctrl+C again to exit")}\r\n`);
        buffer = ""; cursor = 0; renderLine();
        continue;
      }
      if (code === 0x04 && !buffer) { exitRawMode(); write(SHOW_CURSOR + "\r\n"); process.exit(0); }

      // ── Printable ──
      if (code >= 0x20) {
        buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
        cursor += 1;
        renderLine();
        continue;
      }
      // Skip other escape sequences.
      if (code === 0x1b) { let j = i + 1; while (j < rawStr.length && rawStr.charCodeAt(j) < 0x40) j++; if (j < rawStr.length) j++; i = j - 1; }
    }
  });
}

// -- Readline fallback --

async function runChatFallback(loop: any, ctx: any, poolMgr: any, config: any) {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const safePrompt = () => { try { rl.prompt(); } catch {} };
  rl.setPrompt(`${GREEN}▸${RESET} `);
  safePrompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) { safePrompt(); return; }
    if (text.startsWith("/")) { handleCommand(text, poolMgr); safePrompt(); return; }
    try {
      for await (const event of loop.run(text, ctx)) {
        if (event.type === "text_delta") write((event as any).text);
        else if (event.type === "tool_use") write(`\r\n${dim("  ⚙")} ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 80))}`);
        else if (event.type === "permission_request")
          loop.setPermissionResponse(await promptPermission(event.tool_name, event.tool_input, event.scope));
      }
      write("\r\n");
    } catch (e) { write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`); }
    await maybeExtract(loop, text);
    safePrompt();
  });
}

function handleCommand(cmd: string, poolMgr: any) {
  const parts = cmd.split(/\s+/);
  const name = parts[0]!;
  if (name === "/help" || name === "/h") write(dim("Commands: /help, /pool, /pool up|down <api>, Ctrl+C to exit\r\n"));
  else if (name === "/pool" && poolMgr) {
    if (parts.length === 1) {
      const info = poolMgr.getPoolInfo("main");
      write(dim("API pool (main task type):\r\n"));
      for (const [id, s] of Object.entries(info as Record<string, any>))
        write(dim(`  ${id}: base=${s.base.toFixed(1)} delta=${s.delta.toFixed(1)} score=${s.effective === -Infinity ? "disabled" : s.effective.toFixed(1)}\r\n`));
    } else if (parts.length === 3 && (parts[1] === "up" || parts[1] === "down")) {
      parts[1] === "up" ? poolMgr.upvote("main", parts[2]!) : poolMgr.downvote("main", parts[2]!);
      write(dim(`  ${parts[1] === "up" ? "↑" : "↓"} ${parts[2]}\r\n`));
    }
  } else write(dim(`Unknown command: ${name}. Type /help.\r\n`));
}
