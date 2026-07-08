/**
 * Wings CLI — chat REPL (raw stdin) + single-turn (run).
 *
 * Uses raw stdin like claude-code's earlyInput.ts: reads bytes directly
 * from fd 0, terminal emulator handles IME composition and Unicode.
 */

import { createInterface } from "node:readline";
import { createSession, makeAgentContext } from "./bootstrap.ts";

const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function trunc(s: string, n: number): string { return s.length <= n ? s : s.slice(0, n); }

// -- Permission prompt (uses temp readline) --

async function promptPermission(
  toolName: string, toolInput: Record<string, unknown>, scope?: string,
): Promise<string> {
  const desc = JSON.stringify(toolInput).slice(0, 120);
  process.stdout.write(`\n${YELLOW}  🔒 ${BOLD}${toolName}${RESET} — ${dim(desc)}\n`);
  if (scope) process.stdout.write(`  ${dim("scope: " + scope)}\n`);
  process.stdout.write(`  ${dim("1.")} Yes\n`);
  process.stdout.write(`  ${dim("2.")} Yes, and don't ask again\n`);
  process.stdout.write(`  ${dim("3.")} No\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question(`  ${GREEN}>${RESET} `, (a) => r(a.trim().toLowerCase())));
  rl.close();
  if (answer === "1" || answer === "y" || answer === "yes") return "allow";
  if (answer === "2" || answer === "a" || answer === "always") return "allow_always";
  return "deny";
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
      case "text_delta": process.stdout.write((event as any).text); break;
      case "tool_use": process.stdout.write(`${dim("\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 100))}\n`); break;
      case "tool_result": if ((event as any).is_error) process.stdout.write(`${dim("  ↳")}  ${RED}error${RESET} ${dim(trunc((event as any).content, 120))}\n`); break;
      case "permission_request": loop.setPermissionResponse(await promptPermission(event.tool_name, event.tool_input, event.scope)); break;
    }
  }
  process.stdout.write("\n");
}

// -- Interactive chat (raw stdin) --

const encoder = new TextEncoder();
const writeOut = (s: string) => { process.stdout.write(encoder.encode(s)); };
const PROMPT = `${GREEN}▸${RESET} `;

/** Grapheme-aware backspace. Like claude-code's lastGrapheme(). */
function deleteLastGrapheme(s: string): string {
  if (s.length === 0) return s;
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  const all = [...seg.segment(s)].map((x) => x.segment);
  all.pop();
  return all.join("");
}

export async function runChat(
  opts: { workingDir?: string; model?: string | null; logger?: { recordCycle(opts: Record<string, unknown>): void } | null } = {},
): Promise<void> {
  const { loop, config, poolMgr } = await createSession(opts.workingDir, opts.logger);
  const ctx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model ?? null });

  writeOut(`\n${BOLD}wings${RESET} ${dim("— each model is a wing")}\n`);
  writeOut(dim("Type /help, Ctrl+C to exit\n\n"));
  writeOut(PROMPT);

  let buffer = "";
  let running = false;

  const runInput = async (line: string) => {
    const text = line.trim();
    if (!text) { writeOut(PROMPT); return; }
    running = true;

    if (text.startsWith("/")) {
      handleCommand(text, loop, poolMgr, config);
      writeOut(PROMPT);
      running = false;
      setTimeout(poll, 10);
      return;
    }

    try {
      for await (const event of loop.run(text, ctx)) {
        switch (event.type) {
          case "text_delta": writeOut((event as any).text); break;
          case "tool_use": writeOut(`${dim("\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 100))}\n`); break;
          case "tool_result": {
            const tr = event as any;
            if (tr.is_error) writeOut(`${dim("  ↳")}  ${RED}error${RESET} ${dim(trunc(tr.content, 120))}\n`);
            break;
          }
          case "permission_request": {
            const resp = await promptPermission(event.tool_name, event.tool_input, event.scope);
            loop.setPermissionResponse(resp);
            break;
          }
          case "subagent_start": writeOut(`\n${dim("  ┌ subagent")} ${CYAN}${(event as any).agent_type}${RESET} ${dim((event as any).description)}\n`); break;
          case "subagent_end": writeOut(`${dim("  └ done")}\n`); break;
        }
      }
      writeOut("\n");
    } catch (e) {
      writeOut(`${RED}Error:${RESET} ${(e as Error).message}\n`);
    }
    writeOut(PROMPT);
    running = false;
    setTimeout(poll, 10);
  };

  // Raw stdin read loop — terminal handles IME composition.
  const poll = () => {
    if (running) { setTimeout(poll, 50); return; }
    let data: Buffer | null;
    try { data = (process.stdin as any).read(1024) as Buffer | null; } catch { data = null; }
    if (!data || data.length === 0) { setTimeout(poll, 10); return; }
    const str = data.toString("utf-8");

    for (let i = 0; i < str.length; i++) {
      const ch = str[i]!;
      const code = ch.charCodeAt(0);

      if (code === 0x0d) { // Enter
        const line = buffer; buffer = "";
        writeOut("\r\n");
        runInput(line);
        return; // runInput restarts poll when done
      }
      if (code === 0x7f || code === 0x08) { // Backspace/DEL
        buffer = deleteLastGrapheme(buffer);
        writeOut(`\r\x1b[K${PROMPT}${buffer}`);
        continue;
      }
      if (code === 0x03) { writeOut("\r\n"); process.exit(0); } // Ctrl+C
      if (code === 0x04 && buffer.length === 0) { writeOut("\r\n"); process.exit(0); } // Ctrl+D
      if (code === 0x1b) { // Skip escape sequences
        let j = i + 1;
        while (j < str.length && str.charCodeAt(j) < 0x40) j++;
        if (j < str.length) j++;
        i = j - 1;
        continue;
      }
      if (code >= 0x20) { // Printable (incl. multi-byte UTF-8)
        buffer += ch;
        writeOut(`\r\x1b[K${PROMPT}${buffer}`);
      }
    }
    setTimeout(poll, 10);
  };
  setTimeout(poll, 100);
}

// -- Slash commands --

function handleCommand(cmd: string, loop: any, poolMgr: any, config: any) {
  const parts = cmd.split(/\s+/);
  const name = parts[0]!;
  if (name === "/help" || name === "/h") {
    writeOut(dim("Commands: /help, /pool, /pool up|down <api>, Ctrl+C to exit\n"));
  } else if (name === "/pool" && poolMgr) {
    if (parts.length === 1) {
      const info = poolMgr.getPoolInfo("main");
      writeOut(dim("API pool (main task type):\n"));
      for (const [apiId, s] of Object.entries(info as Record<string, any>)) {
        writeOut(dim(`  ${apiId}: base=${s.base.toFixed(1)} delta=${s.delta.toFixed(1)} score=${s.effective === -Infinity ? "disabled" : s.effective.toFixed(1)}\n`));
      }
    } else if (parts.length === 3 && (parts[1] === "up" || parts[1] === "down")) {
      parts[1] === "up" ? poolMgr.upvote("main", parts[2]!) : poolMgr.downvote("main", parts[2]!);
      writeOut(dim(`  ${parts[1] === "up" ? "↑" : "↓"} ${parts[2]}\n`));
    }
  } else {
    writeOut(dim(`Unknown command: ${name}. Type /help.\n`));
  }
}
