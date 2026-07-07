/**
 * Wings CLI — chat + run commands.
 *
 * Permission prompts use raw stdin keypress detection (single key y/n/a,
 * no Enter needed), matching claude-code's permission dialog behavior.
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

/**
 * Show a permission prompt and wait for user response.
 *
 * Uses a temporary readline interface so it doesn't conflict with the
 * main REPL loop.  Requires Enter (unlike claude-code's single-key raw
 * mode, which isn't available in Bun).
 */
async function promptPermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  scope?: string,
): Promise<string> {
  const desc = JSON.stringify(toolInput).slice(0, 120);
  process.stdout.write(`\n${YELLOW}  🔒 ${BOLD}${toolName}${RESET}${YELLOW}?${RESET} ${dim(desc)}`);
  if (scope) process.stdout.write(`\n${dim("     scope: " + scope)}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(` ${GREEN}[y=allow / n=deny / a=allow always]${RESET} `, (a) => {
      resolve(a.trim().toLowerCase());
    });
  });
  rl.close();

  if (answer === "y" || answer === "yes") return "allow";
  if (answer === "a" || answer === "always") return "allow_always";
  return "deny";
}

/** Truncate a string for display. */
function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + dim("…");
}

/** Run a single-turn request. */
export async function runSingle(
  prompt: string,
  opts: { workingDir?: string; model?: string | null; logger?: { recordCycle(opts: Record<string, unknown>): void } | null } = {},
): Promise<void> {
  const { loop, config } = await createSession(opts.workingDir, opts.logger);
  const ctx = makeAgentContext(config, {
    workingDir: opts.workingDir,
    modelOverride: opts.model ?? null,
  });

  for await (const event of loop.run(prompt, ctx)) {
    switch (event.type) {
      case "text_delta":
        process.stdout.write((event as any).text);
        break;
      case "tool_use":
        console.log(`${dim("\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 100))}`);
        break;
      case "tool_result":
        if ((event as any).is_error) {
          console.log(`${dim("  ↳")}  ${RED}error${RESET} ${dim(trunc((event as any).content, 120))}`);
        }
        break;
      case "permission_request":
        const resp = await promptPermission(event.tool_name, event.tool_input, event.scope);
        loop.setPermissionResponse(resp);
        break;
    }
  }
  console.log("");
}

/** Start an interactive chat session. */
export async function runChat(
  opts: { workingDir?: string; model?: string | null; logger?: { recordCycle(opts: Record<string, unknown>): void } | null } = {},
): Promise<void> {
  const { loop, config, poolMgr } = await createSession(opts.workingDir, opts.logger);
  const ctx = makeAgentContext(config, {
    workingDir: opts.workingDir,
    modelOverride: opts.model ?? null,
  });

  console.log(`\n${BOLD}wings${RESET} ${dim("— each model is a wing")}`);
  console.log(dim("Type /help for commands, Ctrl+C to exit\n"));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${GREEN}▸${RESET} `,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // Slash commands.
    if (input.startsWith("/")) {
      await handleCommand(input, loop, poolMgr, config);
      rl.prompt();
      return;
    }

    // Normal turn — pause readline so we own stdin for permissions.
    rl.pause();

    try {
      for await (const event of loop.run(input, ctx)) {
        switch (event.type) {
          case "text_delta":
            process.stdout.write((event as any).text);
            break;
          case "tool_use":
            console.log(`${dim("\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(trunc(JSON.stringify(event.input), 100))}`);
            break;
          case "tool_result":
            if ((event as any).is_error) {
              console.log(`${dim("  ↳")}  ${RED}error${RESET} ${dim(trunc((event as any).content, 120))}`);
            } else {
              console.log(`${dim("  ↳")}  ${dim(trunc((event as any).content, 120))}`);
            }
            break;
          case "permission_request": {
            const pr = event;
            const resp = await promptPermission(pr.tool_name, pr.tool_input, pr.scope);
            loop.setPermissionResponse(resp);
            break;
          }
          case "subagent_start":
            console.log(`\n${dim("  ┌ subagent")} ${CYAN}${(event as any).agent_type}${RESET} ${dim((event as any).description)}`);
            break;
          case "subagent_delta":
            process.stdout.write(`${dim("  │ ")}${(event as any).text}`);
            break;
          case "subagent_end":
            console.log(`\n${dim("  └ done")}`);
            break;
        }
      }
      console.log("");
    } catch (e) {
      console.error(`${RED}Error:${RESET} ${(e as Error).message}`);
    }

    // Resume readline for next input.
    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(dim("\nGoodbye."));
    process.exit(0);
  });
}

async function handleCommand(
  cmd: string,
  loop: any,
  poolMgr: any,
  config: any,
): Promise<void> {
  const parts = cmd.split(/\s+/);
  const name = parts[0]!;
  if (name === "/help" || name === "/h") {
    console.log(dim("Commands: /help, /pool, /pool up|down <api>, Ctrl+C to exit"));
  } else if (name === "/pool") {
    if (parts.length === 1) {
      const info = poolMgr.getPoolInfo("main");
      console.log(dim("\nAPI pool (main task type):"));
      for (const [apiId, s] of Object.entries(info as Record<string, any>)) {
        const eff = s.effective;
        const label = eff === -Infinity ? `${RED}disabled${RESET}` :
          eff > 50 ? `${GREEN}+${eff.toFixed(1)}${RESET}` :
          eff < -50 ? `${YELLOW}${eff.toFixed(1)}${RESET}` :
          dim(eff.toFixed(1));
        console.log(`  ${apiId}: base=${s.base.toFixed(1)} delta=${s.delta.toFixed(1)} score=${label}`);
      }
    } else if (parts.length === 3 && parts[1] === "up") {
      poolMgr.upvote("main", parts[2]!);
      console.log(dim(`  ↑ ${parts[2]}`));
    } else if (parts.length === 3 && parts[1] === "down") {
      poolMgr.downvote("main", parts[2]!);
      console.log(dim(`  ↓ ${parts[2]}`));
    }
  } else {
    console.log(dim(`Unknown command: ${name}. Type /help for commands.`));
  }
}
