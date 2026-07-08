/**
 * Wings CLI — chat REPL + single-turn (run).
 *
 * Uses raw mode stdin for everything (like claude-code). No readline.
 * Terminal stays in raw mode throughout the session — no mode switching.
 */

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

// -- Grapheme-aware text editing (matches claude-code's MeasuredText) --

function graphemeBackspace(s: string): string {
  if (!s) return s;
  try {
    const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
    const all = [...seg.segment(s)].map((x) => x.segment);
    all.pop();
    return all.join("");
  } catch { return s.slice(0, -1); }
}

// -- Permission dialog (raw mode, arrow-key navigation) --

function buildPermOptions(toolName: string, scope?: string) {
  return [
    { value: "allow", label: "Yes" },
    { value: "allow_always", label: scope
      ? `Yes, and don't ask again for ${toolName}(${scope})`
      : `Yes, and don't ask again for ${toolName}` },
    { value: "deny", label: "No, tell Wings what to do differently" },
  ];
}

let permResolve: ((v: string) => void) | null = null;
let permSelected = 0;
let permOptions: ReturnType<typeof buildPermOptions> = [];
let permInput = "";
let permRendered = 0;

function renderPerm(input: Record<string, unknown>, options: typeof permOptions, sel: number) {
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

function handlePermInput(key: string) {
  const code = key.charCodeAt(0);
  if (key === "\x1b[A" || key === "k") {
    permSelected = (permSelected - 1 + permOptions.length) % permOptions.length;
    write(`\x1b[${permRendered}A`);
    permRendered = renderPerm(JSON.parse(permInput), permOptions, permSelected);
  } else if (key === "\x1b[B" || key === "j") {
    permSelected = (permSelected + 1) % permOptions.length;
    write(`\x1b[${permRendered}A`);
    permRendered = renderPerm(JSON.parse(permInput), permOptions, permSelected);
  } else if (code === 0x0d) {
    const r = permResolve; permResolve = null;
    r!(permOptions[permSelected]!.value);
  } else if (key === "y" || key === "Y") {
    const r = permResolve; permResolve = null;
    r!("allow");
  } else if (key === "n" || key === "N" || code === 0x1b || code === 0x03) {
    const r = permResolve; permResolve = null;
    r!("deny");
  } else if (code >= 0x31 && code <= 0x33) {
    const r = permResolve; permResolve = null;
    r!(permOptions[code - 0x31]!.value);
  }
}

// -- Single-turn (non-interactive, keeps using pipe-compatible mode) --

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
        // For runSingle, use a simple inline readline question since we're
        // not in a raw terminal context.
        {
          const { createInterface } = await import("node:readline");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const desc = JSON.stringify(event.tool_input).slice(0, 80);
          write(`\r\n${YELLOW}  🔒 ${BOLD}${event.tool_name}${RESET}: ${dim(desc)}\r\n`);
          write(`  ${dim("[y=allow / n=deny / a=allow always]")}\r\n`);
          const a = await new Promise<string>((r) => rl.question(`  ${GREEN}>${RESET} `, (x) => r(x.trim().toLowerCase())));
          rl.close();
          if (a === "y" || a === "yes") loop.setPermissionResponse("allow");
          else if (a === "a" || a === "always") loop.setPermissionResponse("allow_always");
          else loop.setPermissionResponse("deny");
        }
        break;
    }
  }
  write("\r\n");
}

// -- Interactive chat (raw mode, like claude-code) --

export async function runChat(
  opts: { workingDir?: string; model?: string | null; logger?: { recordCycle(opts: Record<string, unknown>): void } | null } = {},
): Promise<void> {
  const { loop, config, poolMgr } = await createSession(opts.workingDir, opts.logger);
  const ctx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model ?? null });

  write(`\r\n${BOLD}wings${RESET} ${dim("— each model is a wing")}\r\n`);
  write(dim("Type /help, Ctrl+C to exit\r\n\r\n"));

  // Try raw mode. If unavailable, use readline fallback.
  const raw = enterRawMode();
  if (!raw) {
    write(dim("(raw mode unavailable, using basic input)\r\n"));
    await runChatFallback(loop, ctx, poolMgr, config);
    return;
  }
  write(HIDE_CURSOR);

  let buffer = "";
  let running = false;
  let leftover = ""; // accumulate partial bytes across data events

  const PROMPT = `${GREEN}▸${RESET} `;
  write(PROMPT);

  const doTurn = async (line: string) => {
    const text = line.trim();
    if (!text) { write(PROMPT); return; }
    running = true;

    if (text.startsWith("/")) {
      handleCommand(text, poolMgr);
      write(PROMPT);
      running = false;
      return;
    }

    try {
      for await (const event of loop.run(text, ctx)) {
        if (permResolve) {
          // We're inside a permission prompt — handle it in the data handler.
          // The loop.waitPermission() should be handled by the agent loop.
          // Events during permission are ignored (we only show the dialog).
          continue;
        }
        switch (event.type) {
          case "text_delta": write((event as any).text); break;
          case "tool_use": write(`${dim("\r\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 100))}\r\n`); break;
          case "tool_result": {
            const tr = event as any;
            if (tr.is_error) write(`${dim("  ↳")}  ${RED}error${RESET} ${dim(trunc(tr.content, 120))}\r\n`);
            break;
          }
          case "permission_request": {
            // Clear current line and show permission dialog.
            write(`\x1b[2K\r`);
            const inputJson = JSON.stringify(event.tool_input);
            permInput = inputJson;
            permOptions = buildPermOptions(event.tool_name, event.scope);
            permSelected = 0;
            permRendered = renderPerm(event.tool_input, permOptions, 0);
            // Wait for user choice.
            const response = await new Promise<string>((r) => { permResolve = r; });
            loop.setPermissionResponse(response);
            // Clear dialog and restore prompt.
            write(`\x1b[${permRendered}A\x1b[J\r\n${PROMPT}`);
            break;
          }
          case "subagent_start": write(`\r\n${dim("  ┌ subagent")} ${CYAN}${(event as any).agent_type}${RESET} ${dim((event as any).description)}\r\n`); break;
          case "subagent_end": write(`${dim("  └ done")}\r\n`); break;
        }
      }
      write("\r\n");
    } catch (e) {
      write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`);
    }
    write(PROMPT);
    running = false;
  };

  // Single data handler: routes to permission or line editing.
  process.stdin.on("data", (data: Buffer) => {
    const rawStr = leftover + data.toString("utf-8");
    leftover = "";

    if (permResolve) {
      // Permission mode: check for arrow-key sequences.
      // Try to match complete sequences first.
      let i = 0;
      while (i < rawStr.length) {
        const rest = rawStr.slice(i);
        // Arrow up: ESC [ A
        if (rest.startsWith("\x1b[A")) { handlePermInput("\x1b[A"); i += 3; continue; }
        // Arrow down: ESC [ B
        if (rest.startsWith("\x1b[B")) { handlePermInput("\x1b[B"); i += 3; continue; }
        // Single char.
        handlePermInput(rest[0]!);
        i++;
      }
      return;
    }

    if (running) return; // ignore input while agent is running

    // Line editing mode.
    for (let i = 0; i < rawStr.length; i++) {
      const ch = rawStr[i]!;
      const code = ch.charCodeAt(0);

      if (code === 0x0d) { // Enter
        const line = buffer;
        buffer = "";
        write("\r\n");
        doTurn(line);
        return;
      }
      if (code === 0x7f || code === 0x08) { // Backspace
        buffer = graphemeBackspace(buffer);
        write(`\r\x1b[K${PROMPT}${buffer}`);
        continue;
      }
      if (code === 0x03) { exitRawMode(); write(SHOW_CURSOR + "\r\n"); process.exit(0); }
      if (code === 0x04 && !buffer) { exitRawMode(); write(SHOW_CURSOR + "\r\n"); process.exit(0); }
      // Skip control chars and escape sequences.
      if (code < 0x20 && code !== 0x0d) {
        if (code === 0x1b) {
          // Try to identify and skip the escape sequence.
          let j = i + 1;
          while (j < rawStr.length && rawStr.charCodeAt(j) < 0x40) j++;
          if (j < rawStr.length) j++;
          i = j - 1;
        }
        continue;
      }
      // Printable (incl. multi-byte UTF-8 from IME).
      buffer += ch;
      write(`\r\x1b[K${PROMPT}${buffer}`);
    }
  });

  // Cleanup on exit.
  process.on("SIGINT", () => { exitRawMode(); write(SHOW_CURSOR + "\r\n"); process.exit(0); });
  process.on("SIGTERM", () => { exitRawMode(); write(SHOW_CURSOR + "\r\n"); process.exit(0); });
}

// -- Readline fallback (when raw mode is unavailable) --

async function runChatFallback(loop: any, ctx: any, poolMgr: any, config: any) {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
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
        else if (event.type === "permission_request") {
          write(`\r\n${YELLOW}  🔒 ${BOLD}${event.tool_name}${RESET}: ${dim(JSON.stringify(event.tool_input).slice(0, 80))}\r\n`);
          write(`  ${dim("[y=allow / n=deny / a=allow always]")}\r\n`);
          const a = await ask(`  ${GREEN}>${RESET} `);
          const ans = a.trim().toLowerCase();
          if (ans === "y" || ans === "yes") loop.setPermissionResponse("allow");
          else if (ans === "a" || ans === "always") loop.setPermissionResponse("allow_always");
          else loop.setPermissionResponse("deny");
        }
      }
      write("\r\n");
    } catch (e) { write(`${RED}Error:${RESET} ${(e as Error).message}\r\n`); }
    safePrompt();
  });
}

// -- Slash commands --

function handleCommand(cmd: string, poolMgr: any) {
  const parts = cmd.split(/\s+/);
  const name = parts[0]!;
  if (name === "/help" || name === "/h") {
    write(dim("Commands: /help, /pool, /pool up|down <api>, Ctrl+C to exit\r\n"));
  } else if (name === "/pool" && poolMgr) {
    if (parts.length === 1) {
      const info = poolMgr.getPoolInfo("main");
      write(dim("API pool (main task type):\r\n"));
      for (const [id, s] of Object.entries(info as Record<string, any>)) {
        write(dim(`  ${id}: base=${s.base.toFixed(1)} delta=${s.delta.toFixed(1)} score=${s.effective === -Infinity ? "disabled" : s.effective.toFixed(1)}\r\n`));
      }
    } else if (parts.length === 3 && (parts[1] === "up" || parts[1] === "down")) {
      parts[1] === "up" ? poolMgr.upvote("main", parts[2]!) : poolMgr.downvote("main", parts[2]!);
      write(dim(`  ${parts[1] === "up" ? "↑" : "↓"} ${parts[2]}\r\n`));
    }
  } else {
    write(dim(`Unknown command: ${name}. Type /help.\r\n`));
  }
}
