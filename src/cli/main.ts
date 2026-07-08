/**
 * Wings CLI — chat REPL + single-turn (run).
 *
 * Uses node:readline for input. Permission prompts use raw mode
 * for arrow-key navigation (matching claude-code's permission dialog).
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

// -- Arrow-key permission prompt (raw mode) --

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function buildPermOptions(toolName: string, scope?: string) {
  return [
    { value: "allow", label: "Yes" },
    {
      value: "allow_always",
      label: scope
        ? `Yes, and don't ask again for ${toolName}(${scope})`
        : `Yes, and don't ask again for ${toolName}`,
    },
    { value: "deny", label: "No, tell Wings what to do differently" },
  ];
}

/** Render the permission dialog at the current cursor position. Returns lines rendered. */
function renderPermDialog(
  toolInput: Record<string, unknown>,
  options: ReturnType<typeof buildPermOptions>,
  selected: number,
): number {
  const desc = JSON.stringify(toolInput).slice(0, 76);
  const lines: string[] = [];
  lines.push(`\n  ${YELLOW}┌${RESET} Permission ${dim("─".repeat(62))}`);
  lines.push(`  │ ${dim(desc)}`);
  lines.push(`  │`);
  for (let i = 0; i < options.length; i++) {
    const isSel = i === selected;
    lines.push(`  │ ${isSel ? `${BOLD}❯ ` : "  "}${isSel ? options[i]!.label : dim(options[i]!.label)}`);
  }
  lines.push(`  │`);
  lines.push(`  │ ${dim("↑↓ navigate  ·  Enter select  ·  y=allow  n=deny  esc=deny")}`);
  lines.push(`  ${dim("└" + "─".repeat(68))}`);
  process.stdout.write(lines.join("\n"));
  return lines.length;
}

/**
 * Show an arrow-key-navigable permission prompt using raw stdin mode.
 * Pauses readline, enables raw mode, renders the dialog, and returns
 * the user's choice. Restores readline state on exit.
 */
async function promptPermissionRaw(
  rl: { pause: () => void; resume: () => void; prompt: () => void },
  toolName: string,
  toolInput: Record<string, unknown>,
  scope?: string,
): Promise<string> {
  const options = buildPermOptions(toolName, scope);
  let selected = 0;

  // Pause readline and take over stdin.
  rl.pause();
  process.stdin.setRawMode(true);
  process.stdout.write(HIDE_CURSOR);

  // Render initial dialog.
  let renderedLines = renderPermDialog(toolInput, options, selected);

  const result = await new Promise<string>((resolve) => {
    const onData = (buf: Buffer) => {
      const str = buf.toString("utf-8");

      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);

        // Arrow up / k
        if (str.slice(i).startsWith("\x1b[A") || str[i] === "k") {
          if (str.slice(i).startsWith("\x1b[A")) i += 2;
          selected = (selected - 1 + options.length) % options.length;
          process.stdout.write(`\x1b[${renderedLines}A`);
          renderedLines = renderPermDialog(toolInput, options, selected);
          continue;
        }
        // Arrow down / j
        if (str.slice(i).startsWith("\x1b[B") || str[i] === "j") {
          if (str.slice(i).startsWith("\x1b[B")) i += 2;
          selected = (selected + 1) % options.length;
          process.stdout.write(`\x1b[${renderedLines}A`);
          renderedLines = renderPermDialog(toolInput, options, selected);
          continue;
        }
        // Enter
        if (code === 0x0d) {
          cleanup();
          resolve(options[selected]!.value);
          return;
        }
        // y = allow
        if (str[i] === "y" || str[i] === "Y") {
          cleanup();
          resolve("allow");
          return;
        }
        // n = deny
        if (str[i] === "n" || str[i] === "N") {
          cleanup();
          resolve("deny");
          return;
        }
        // Esc / Ctrl+C = deny
        if (code === 0x1b || code === 0x03) {
          cleanup();
          resolve("deny");
          return;
        }
        // 1/2/3 number keys
        if (code >= 0x31 && code <= 0x33) {
          const idx = code - 0x31;
          cleanup();
          resolve(options[idx]!.value);
          return;
        }
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdout.write(SHOW_CURSOR);
      // Clear the dialog.
      process.stdout.write(`\x1b[${renderedLines}A\x1b[J`);
      rl.resume();
      rl.prompt();
    };

    process.stdin.on("data", onData);
  });

  return result;
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
      case "permission_request": {
        // runSingle has no rl — create a temporary one.
        const tmpRl = createInterface({ input: process.stdin, output: process.stdout });
        loop.setPermissionResponse(await promptPermissionRaw(tmpRl, event.tool_name, event.tool_input, event.scope));
        tmpRl.close();
        break;
      }
    }
  }
  process.stdout.write("\n");
}

// -- Interactive chat (readline) --

export async function runChat(
  opts: { workingDir?: string; model?: string | null; logger?: { recordCycle(opts: Record<string, unknown>): void } | null } = {},
): Promise<void> {
  const { loop, config, poolMgr } = await createSession(opts.workingDir, opts.logger);
  const ctx = makeAgentContext(config, { workingDir: opts.workingDir, modelOverride: opts.model ?? null });

  process.stdout.write(`\n${BOLD}wings${RESET} ${dim("— each model is a wing")}\n`);
  process.stdout.write(dim("Type /help, Ctrl+C to exit\n\n"));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  const promptUser = () => { rl.setPrompt(`${GREEN}▸${RESET} `); rl.prompt(); };
  promptUser();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) { promptUser(); return; }

    if (text.startsWith("/")) {
      handleCommand(text, loop, poolMgr, config);
      promptUser();
      return;
    }

    try {
      for await (const event of loop.run(text, ctx)) {
        switch (event.type) {
          case "text_delta": process.stdout.write((event as any).text); break;
          case "tool_use": console.log(`${dim("\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 100))}`); break;
          case "tool_result": {
            const tr = event as any;
            if (tr.is_error) console.log(`${dim("  ↳")}  ${RED}error${RESET} ${dim(trunc(tr.content, 120))}`);
            break;
          }
          case "permission_request":
            loop.setPermissionResponse(await promptPermissionRaw(rl, event.tool_name, event.tool_input, event.scope));
            break;
          case "subagent_start": console.log(`\n${dim("  ┌ subagent")} ${CYAN}${(event as any).agent_type}${RESET} ${dim((event as any).description)}`); break;
          case "subagent_end": console.log(`${dim("  └ done")}`); break;
        }
      }
      process.stdout.write("\n");
    } catch (e) {
      console.error(`${RED}Error:${RESET} ${(e as Error).message}`);
    }
    promptUser();
  });

  rl.on("close", () => {
    process.stdout.write(dim("\nGoodbye.\n"));
    process.exit(0);
  });
}

// -- Slash commands --

function handleCommand(cmd: string, loop: any, poolMgr: any, config: any) {
  const parts = cmd.split(/\s+/);
  const name = parts[0]!;
  if (name === "/help" || name === "/h") {
    console.log(dim("Commands: /help, /pool, /pool up|down <api>, Ctrl+C to exit"));
  } else if (name === "/pool" && poolMgr) {
    if (parts.length === 1) {
      const info = poolMgr.getPoolInfo("main");
      console.log(dim("API pool (main task type):"));
      for (const [apiId, s] of Object.entries(info as Record<string, any>)) {
        console.log(dim(`  ${apiId}: base=${s.base.toFixed(1)} delta=${s.delta.toFixed(1)} score=${s.effective === -Infinity ? "disabled" : s.effective.toFixed(1)}`));
      }
    } else if (parts.length === 3 && (parts[1] === "up" || parts[1] === "down")) {
      parts[1] === "up" ? poolMgr.upvote("main", parts[2]!) : poolMgr.downvote("main", parts[2]!);
      console.log(dim(`  ${parts[1] === "up" ? "↑" : "↓"} ${parts[2]}`));
    }
  } else {
    console.log(dim(`Unknown command: ${name}. Type /help.`));
  }
}
