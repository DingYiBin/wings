/**
 * Wings CLI — chat REPL + single-turn (run).
 *
 * Raw mode stdin for line editing (like claude-code).
 * Permission prompts read directly from /dev/tty for reliability.
 */

import { openSync, readSync, closeSync } from "node:fs";
import { createSession, makeAgentContext } from "./bootstrap.ts";

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
  const options = buildPermOptions(toolName, scope);
  let selected = 0;

  // Try to open /dev/tty for raw keyboard reading.
  let ttyFd = -1;
  try { ttyFd = openSync("/dev/tty", "r"); } catch { ttyFd = -1; }

  if (ttyFd < 0) {
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
        if (code === 0x0d) { closeSync(ttyFd); write(SHOW_CURSOR); write(`\x1b[${rendered}A\x1b[J`); return options[selected]!.value; }
        // y
        if (ch === "y" || ch === "Y") { closeSync(ttyFd); write(SHOW_CURSOR); write(`\x1b[${rendered}A\x1b[J`); return "allow"; }
        // n / Esc / Ctrl+C
        if (ch === "n" || ch === "N" || code === 0x1b || code === 0x03) {
          closeSync(ttyFd); write(SHOW_CURSOR); write(`\x1b[${rendered}A\x1b[J`); return "deny";
        }
        // 1/2/3
        if (code >= 0x31 && code <= 0x33) { closeSync(ttyFd); write(SHOW_CURSOR); write(`\x1b[${rendered}A\x1b[J`); return options[code - 0x31]!.value; }
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
  const ctx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model ?? null });

  for await (const event of loop.run(prompt, ctx)) {
    switch (event.type) {
      case "text_delta": write((event as any).text); break;
      case "tool_use": write(`${dim("\r\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 100))}\r\n`); break;
      case "tool_result": if ((event as any).is_error) write(`${dim("  ↳")}  ${RED}error${RESET} ${dim(trunc((event as any).content, 120))}\r\n`); break;
      case "permission_request":
        loop.setPermissionResponse(await promptPermission(event.tool_name, event.tool_input, event.scope));
        break;
    }
  }
  write("\r\n");
}

// -- Interactive chat (raw mode) --

export async function runChat(
  opts: { workingDir?: string; model?: string | null; logger?: { recordCycle(opts: Record<string, unknown>): void } | null } = {},
): Promise<void> {
  const { loop, config, poolMgr } = await createSession(opts.workingDir, opts.logger);
  const ctx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model ?? null });

  write(`\r\n${BOLD}wings${RESET} ${dim("— each model is a wing")}\r\n`);
  write(dim("Type /help, Ctrl+C to exit\r\n\r\n"));

  const raw = enterRawMode();
  if (!raw) {
    write(dim("(raw mode unavailable, using basic input)\r\n"));
    await runChatFallback(loop, ctx, poolMgr, config);
    return;
  }
  write(HIDE_CURSOR);

  let buffer = "";
  let running = false;
  const PROMPT = `${GREEN}▸${RESET} `;
  write(PROMPT);

  const doTurn = async (line: string) => {
    const text = line.trim();
    if (!text) { write(PROMPT); return; }
    running = true;

    if (text.startsWith("/")) { handleCommand(text, poolMgr); write(PROMPT); running = false; return; }

    try {
      for await (const event of loop.run(text, ctx)) {
        switch (event.type) {
          case "text_delta": write((event as any).text); break;
          case "tool_use": write(`${dim("\r\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 100))}\r\n`); break;
          case "tool_result": { const tr = event as any; const len = (tr.content ?? "").length; if (tr.is_error) write(`${dim("  ↳")}  ${RED}error${RESET} ${dim(trunc(tr.content, 120))}\r\n`); else write(`${dim("  ↳")}  ${dim(len + " chars")}\r\n`); break; }
          case "permission_request":
            loop.setPermissionResponse(await promptPermission(event.tool_name, event.tool_input, event.scope));
            break;
          case "subagent_start": write(`\r\n${dim("  ┌ subagent")} ${CYAN}${(event as any).agent_type}${RESET} ${dim((event as any).description)}\r\n`); break;
          case "subagent_end": write(`${dim("  └ done")}\r\n`); break;
        }
      }
      write("\r\n");
    } catch (e) { write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`); }
    write(PROMPT);
    running = false;
  };

  process.stdin.on("data", (data: Buffer) => {
    if (running) return;
    const rawStr = data.toString("utf-8");
    for (let i = 0; i < rawStr.length; i++) {
      const ch = rawStr[i]!;
      const code = ch.charCodeAt(0);
      if (code === 0x0d) { const line = buffer; buffer = ""; write("\r\n"); doTurn(line); return; }
      if (code === 0x7f || code === 0x08) { buffer = graphemeBackspace(buffer); write(`\r\x1b[K${PROMPT}${buffer}`); continue; }
      if (code === 0x03) { exitRawMode(); write(SHOW_CURSOR + "\r\n"); process.exit(0); }
      if (code === 0x04 && !buffer) { exitRawMode(); write(SHOW_CURSOR + "\r\n"); process.exit(0); }
      if (code < 0x20) {
        if (code === 0x1b) { let j = i + 1; while (j < rawStr.length && rawStr.charCodeAt(j) < 0x40) j++; if (j < rawStr.length) j++; i = j - 1; }
        continue;
      }
      buffer += ch;
      write(`\r\x1b[K${PROMPT}${buffer}`);
    }
  });

  process.on("SIGINT", () => { exitRawMode(); write(SHOW_CURSOR + "\r\n"); process.exit(0); });
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
        else if (event.type === "tool_use") write(`${dim("\r\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 100))}\r\n`);
        else if (event.type === "permission_request")
          loop.setPermissionResponse(await promptPermission(event.tool_name, event.tool_input, event.scope));
      }
      write("\r\n");
    } catch (e) { write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`); }
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
