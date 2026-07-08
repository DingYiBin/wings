/**
 * Wings CLI — chat REPL + single-turn (run).
 *
 * Uses node:readline. Permission prompts use the same readline instance
 * via question(), which pauses the emitter and waits for the next line
 * event without conflict.
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

// -- Permission prompt (uses the main readline instance) --

function showPermPrompt(
  toolName: string, toolInput: Record<string, unknown>, scope?: string,
): void {
  const desc = JSON.stringify(toolInput).slice(0, 120);
  process.stdout.write(`\n${YELLOW}  🔒 ${BOLD}${toolName}${RESET} — ${dim(desc)}\n`);
  if (scope) process.stdout.write(`  ${dim("scope: " + scope)}\n`);
  process.stdout.write(`  ${dim("1.")} Yes\n`);
  process.stdout.write(`  ${dim("2.")} Yes, and don't ask again\n`);
  process.stdout.write(`  ${dim("3.")} No\n`);
}

function parsePermAnswer(answer: string): string {
  const a = answer.trim().toLowerCase();
  if (a === "1" || a === "y" || a === "yes") return "allow";
  if (a === "2" || a === "a" || a === "always") return "allow_always";
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
      case "permission_request": {
        showPermPrompt(event.tool_name, event.tool_input, event.scope);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((r) => rl.question(`  ${GREEN}>${RESET} `, (a) => r(a)));
        rl.close();
        loop.setPermissionResponse(parsePermAnswer(answer));
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
          case "permission_request": {
            showPermPrompt(event.tool_name, event.tool_input, event.scope);
            const answer = await ask(`  ${GREEN}>${RESET} `);
            loop.setPermissionResponse(parsePermAnswer(answer));
            break;
          }
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
