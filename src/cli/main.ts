/**
 * Wings CLI — chat REPL + single-turn (run).
 *
 * Raw mode stdin for line editing (like claude-code).
 * Permission prompts read directly from /dev/tty for reliability.
 */

import { openSync, readSync, closeSync, appendFileSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createSession, makeAgentContext } from "./bootstrap.ts";
import type { SkillSpec } from "../skills/types.ts";
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

// Print the per-turn model tag `[provider]` after a turn completes.
// Mirrors Python main.py:371-372,465-466 — last_model is "provider/model",
// we show the provider nickname.
function writeModelTag(loop: any): void {
  const last = loop?.lastModel;
  if (!last) return;
  const nick = last.split("/")[0];
  if (nick) write(`  [${nick}]\r\n`);
}

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
      case "subagent_start": write(`\r\n${dim("  ┌ subagent")} ${CYAN}${(event as any).agent_type}${RESET} ${dim((event as any).description)}\r\n`); break;
      case "subagent_delta": write((event as any).text); break;
      case "subagent_end": write(`${dim("  └ done")}\r\n`); break;
    }
  }
  write("\r\n");
  writeModelTag(loop);

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

  // Per-turn store of truncated tool results for ctrl+o expansion.
  // Mirrors Python _truncated_results (main.py:110,360,455): reset each turn.
  let truncatedResults: { label: string; content: string }[] = [];
  const expandLastResult = () => {
    if (truncatedResults.length === 0) return;
    const { label, content } = truncatedResults[truncatedResults.length - 1]!;
    const pager = process.env.PAGER ?? "less -R";
    const parts = pager.split(/\s+/);
    let dir: string | null = null;
    try {
      dir = mkdtempSync(pathJoin(tmpdir(), "wings-tool-"));
      const file = pathJoin(dir, "result.txt");
      writeFileSync(file, `# ${label}\n\n${content}`);
      // Exit raw mode so the pager owns the terminal, then re-enter after.
      exitRawMode();
      write(SHOW_CURSOR + "\r\n");
      spawnSync(parts[0]!, [...parts.slice(1), file], { stdio: "inherit" });
    } catch {
      // best-effort — pager unavailable or write failed
    } finally {
      if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
      enterRawMode();
      write(`\r\x1b[K${PROMPT}`);
      renderLine();
    }
  };

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
    truncatedResults = [];

    // Resolve what to run this turn. A slash command is either a built-in
    // (/help, /pool) or a skill invocation (/<skill-name> [args]) — mirrors
    // Python main.py:430-448, where a matched skill rewrites the prompt and
    // runs under task_type=skill/<name>.
    let turnText = text;
    let turnCtx = ctx;
    if (text.startsWith("/")) {
      const parts = text.slice(1).split(/\s+/);
      const cmd = parts[0] ?? "";
      if (cmd === "exit" || cmd === "quit") { // /exit — mirrors Python main.py:425-426
        exitRawMode(); write(SHOW_CURSOR + "\r\n"); process.exit(0);
      }
      if (cmd === "help" || cmd === "h" || cmd === "pool") {
        handleCommand(text, poolMgr, loop);
        write(`\r\x1b[K${PROMPT}`);
        running = false;
        return;
      }
      const loader = (loop as any).skillLoader;
      const skill = loader?.getByName(cmd) as SkillSpec | undefined;
      if (skill) {
        const args = parts.slice(1).join(" ").trim();
        turnText = `[Skill: ${skill.name}]\n\n${skill.content}\n\n---\n\nUser request: ${args || "Run this skill"}`;
        turnCtx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model ?? null, customAgents: (loop as any).customAgents ?? null, skills: (loop as any).skillsList ?? [], taskType: `skill/${skill.name}` });
      } else {
        write(dim(`Unknown command or skill: /${cmd}. Type /help.\r\n`));
        write(`\r\x1b[K${PROMPT}`);
        running = false;
        return;
      }
    }

    let prevEvent = "";
    // Spinner: show "Working... (Ns)" while waiting for the first content
    // token. Mirrors Python _spinner_task/_wrap_stream (main.py:132-171).
    const spinStart = Date.now();
    const spinTick = () => write(`\r\x1b[KWorking... (${Math.floor((Date.now() - spinStart) / 1000)}s)`);
    let spinTimer: ReturnType<typeof setInterval> | null = setInterval(spinTick, 1000);
    let spinCleared = false;
    const clearSpinner = () => {
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      if (!spinCleared) { write("\r\x1b[K"); spinCleared = true; }
    };
    spinTick(); // show immediately instead of waiting 1s
    try {
      for await (const event of loop.run(turnText, turnCtx)) {
        // First content event cancels the spinner (matches Python's cancel set).
        if (!spinCleared && ["text_delta", "tool_use", "subagent_start", "subagent_delta"].includes(event.type)) {
          clearSpinner();
        }
        switch (event.type) {
          case "text_delta":
            if (prevEvent === "tool_result") write(`\r\n${dim("  ──────")}\r\n`);
            write((event as any).text);
            break;
          case "tool_use": write(`\r\n${dim("  ⚙")} ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 80))}`); break;
          case "tool_result": {
            const tr = event as any;
            const content = tr.content ?? "";
            const preview = trunc(content, 80).replace(/\n/g, " ");
            // Track for ctrl+o expansion when the preview elides content
            // (multi-line or longer than the preview) — mirrors Python
            // main.py:306-307.
            const truncated = content.length > 80 || content.includes("\n");
            if (truncated) truncatedResults.push({ label: "Tool result", content });
            const hint = truncated ? dim("  (ctrl+o)") : "";
            if (tr.is_error) write(`\r\n${dim("  ↳")} ${RED}${preview}${RESET}${hint}`);
            else if (preview) write(`\r\n${dim("  ↳")} ${dim(preview)}${hint}`);
            break;
          }
          case "permission_request":
            DLOG("DO-PERM", "calling promptPermission...");
            const permResp = await promptPermission(event.tool_name, event.tool_input, event.scope);
            DLOG("DO-PERM", "got", permResp, "calling setPermissionResponse...");
            loop.setPermissionResponse(permResp);
            DLOG("DO-PERM", "setPermissionResponse returned, continuing loop...");
            break;
          case "subagent_start": write(`\r\n${dim("  ┌ subagent")} ${CYAN}${(event as any).agent_type}${RESET} ${dim((event as any).description)}\r\n`); break;
          case "subagent_delta": write((event as any).text); break;
          case "subagent_end": write(`${dim("  └ done")}\r\n`); break;
        }
        prevEvent = event.type;
      }
      clearSpinner();
      write("\r\n");
      writeModelTag(loop);
    } catch (e) { clearSpinner(); write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`); }
    await maybeExtract(loop, turnText);
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

  // -- Render line: prompt + full text, cursor at correct position --
  const renderLine = () => {
    write(`\r\x1b[K${PROMPT}${buffer}`);
    // Move cursor back to the right spot after the prompt text.
    if (cursor < buffer.length) {
      write(`\x1b[${buffer.length - cursor}D`);
    }
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

      // ── ctrl+o: expand last truncated tool result in $PAGER ──
      if (code === 0x0f) { expandLastResult(); continue; }

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
    if (text.startsWith("/")) { handleCommand(text, poolMgr, loop); safePrompt(); return; }
    try {
      for await (const event of loop.run(text, ctx)) {
        if (event.type === "text_delta") write((event as any).text);
        else if (event.type === "tool_use") write(`\r\n${dim("  ⚙")} ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 80))}`);
        else if (event.type === "permission_request")
          loop.setPermissionResponse(await promptPermission(event.tool_name, event.tool_input, event.scope));
        else if (event.type === "subagent_start") write(`\r\n${dim("  ┌ subagent")} ${CYAN}${(event as any).agent_type}${RESET} ${dim((event as any).description)}\r\n`);
        else if (event.type === "subagent_delta") write((event as any).text);
        else if (event.type === "subagent_end") write(`${dim("  └ done")}\r\n`);
      }
      write("\r\n");
      writeModelTag(loop);
    } catch (e) { write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`); }
    await maybeExtract(loop, text);
    safePrompt();
  });
}

// Display available slash commands and user-invocable skills.
// Mirrors Python _show_help (main.py:553-569): a Commands section followed
// by a dynamically enumerated Skills section.
function showHelp(loop?: any): void {
  const lines: string[] = ["Commands:"];
  lines.push("  /help                Show this help");
  lines.push("  /exit                Quit the chat session");
  lines.push("  /pool                View/adjust API candidate pool");
  lines.push("  /pool up|down <api>  Adjust API score by ±0.5");
  lines.push("  Ctrl+C (2x)          Exit");
  lines.push("  ESC                  Abort the running turn");
  lines.push("  ctrl+o               Expand last truncated tool result");
  const loader = (loop as any)?.skillLoader;
  if (loader) {
    const skills = loader.listUserInvocable() as SkillSpec[];
    if (skills.length > 0) {
      lines.push("", "Skills:");
      const pad = Math.max(...skills.map((s) => s.name.length));
      for (const s of skills) lines.push(`  /${s.name.padEnd(pad)}  ${s.description}`);
    }
  }
  write(dim(lines.join("\r\n") + "\r\n"));
}

// Handle /pool — view and adjust API candidate pools.
// Mirrors Python _handle_pool (main.py:478-552): up/down/disable/enable with
// an optional --task=<type>, /pool <task_type> to view another type, and a
// display that flags disabled APIs and shows task types with custom masks.
function handlePool(args: string[], poolMgr: any): void {
  let taskType = "main";
  if (args.length > 0 && ["up", "down", "disable", "enable"].includes(args[0]!)) {
    const sub = args[0]!;
    const rest = args.slice(1);
    if (rest.length === 0) {
      write(dim("  Usage: /pool up|down|disable|enable <api_id> [--task=<type>]\r\n"));
      return;
    }
    const apiParts: string[] = [];
    for (const p of rest) {
      if (p.startsWith("--task=")) taskType = p.slice("--task=".length);
      else apiParts.push(p);
    }
    const apiId = apiParts.join(" ");
    if (sub === "up") { poolMgr.upvote(taskType, apiId, 0.5); write(dim(`  +0.5 for ${apiId} in ${taskType}\r\n`)); }
    else if (sub === "down") { poolMgr.downvote(taskType, apiId, 0.5); write(dim(`  -0.5 for ${apiId} in ${taskType}\r\n`)); }
    else if (sub === "disable") { poolMgr.disable(taskType, apiId); write(dim(`  Disabled ${apiId} for ${taskType}\r\n`)); }
    else if (sub === "enable") { poolMgr.enable(taskType, apiId); write(dim(`  Enabled ${apiId} for ${taskType}\r\n`)); }
    return;
  } else if (args.length > 0) {
    // /pool <task_type> — view another task type's pool.
    taskType = args[0]!;
  }

  const info = poolMgr.getPoolInfo(taskType) as Record<string, { base: number; delta: number; effective: number }>;
  write(dim(`\r\n  Pool: ${taskType}\r\n`));
  const entries = Object.entries(info);
  if (entries.length === 0) { write(dim("    (no APIs registered)\r\n")); return; }
  const sign = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1);
  for (const [apiId, s] of entries) {
    if (s.effective <= -1e9) write(dim(`    ${apiId.padEnd(45)} [DISABLED]\r\n`));
    else if (s.delta !== 0) {
      const deltaStr = s.delta > 0 ? `+${s.delta}` : `${s.delta}`;
      write(dim(`    ${apiId.padEnd(45)} eff=${sign(s.effective)}  (base=${s.base.toFixed(1)} ${deltaStr})\r\n`));
    } else {
      write(dim(`    ${apiId.padEnd(45)} eff=${sign(s.effective)}\r\n`));
    }
  }
  const customTypes = (poolMgr.listTaskTypes() as string[]).filter((t) => t !== "main" && t !== taskType).sort();
  if (customTypes.length > 0) {
    const shown = customTypes.slice(0, 8).join(", ");
    const typesStr = customTypes.length > 8 ? `${shown}, +${customTypes.length - 8} more` : shown;
    write(dim(`\r\n  Types with custom masks: ${typesStr}\r\n`));
  }
  write(dim(`\r\n  /pool up|down|disable|enable <api_id> [--task=<type>]\r\n`));
  write(dim(`  /pool <task_type>  — view another task type's pool\r\n`));
}

function handleCommand(cmd: string, poolMgr: any, loop?: any) {
  const parts = cmd.split(/\s+/);
  const name = parts[0]!;
  if (name === "/help" || name === "/h") showHelp(loop);
  else if (name === "/pool" && poolMgr) handlePool(parts.slice(1), poolMgr);
  else write(dim(`Unknown command: ${name}. Type /help.\r\n`));
}
