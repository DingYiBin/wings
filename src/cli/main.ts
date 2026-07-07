/**
 * Wings CLI — chat + run commands.
 *
 * Minimal version: uses readline for REPL. Full Ink/React TUI planned for
 * Phase 7 polish pass.
 */

import { createInterface } from "node:readline";
import { createSession, makeAgentContext } from "./bootstrap.ts";

const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }

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
        console.log(`${dim("\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(JSON.stringify(event.input).slice(0, 100))}`);
        break;
      case "tool_result":
        if ((event as any).is_error) {
          console.log(`${dim("  ↳")}  ${RED}error${RESET} ${dim((event as any).content.slice(0, 100))}`);
        }
        break;
      case "permission_request":
        const pr = event;
        console.log(`\n${YELLOW}  🔒 permission${RESET} ${pr.tool_name} ${dim(JSON.stringify(pr.tool_input).slice(0, 80))}`);
        break;
    }
  }
  console.log(""); // trailing newline
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

  const ask = (): Promise<string> => new Promise((resolve) => {
    rl.question("", (answer) => resolve(answer));
  });

  rl.prompt();
  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Slash commands.
    if (input.startsWith("/")) {
      await handleCommand(input, loop, poolMgr, config, ctx);
      rl.prompt();
      return;
    }

    // Normal turn.
    try {
      for await (const event of loop.run(input, ctx)) {
        switch (event.type) {
          case "text_delta":
            process.stdout.write((event as any).text);
            break;
          case "tool_use":
            console.log(`${dim("\n  ⚙")}  ${CYAN}${event.name}${RESET} ${dim(JSON.stringify(event.input).slice(0, 100))}`);
            break;
          case "tool_result":
            if ((event as any).is_error) {
              console.log(`${dim("  ↳")}  ${RED}error${RESET} ${dim((event as any).content.slice(0, 120))}`);
            } else {
              console.log(`${dim("  ↳")}  ${dim((event as any).content.slice(0, 120))}`);
            }
            break;
          case "permission_request":
            const pr = event;
            console.log(`\n${YELLOW}  🔒 Allow${RESET} ${BOLD}${pr.tool_name}${RESET}? ${dim(JSON.stringify(pr.tool_input).slice(0, 80))}`);
            if (pr.scope) console.log(dim(`     scope: ${pr.scope}`));
            const answer = await ask();
            const resp = answer.trim().toLowerCase();
            if (resp === "y" || resp === "yes") {
              loop.setPermissionResponse("allow");
            } else if (resp === "a" || resp === "always") {
              loop.setPermissionResponse("allow_always");
            } else {
              loop.setPermissionResponse("deny");
            }
            break;
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
      console.log(""); // trailing newline
    } catch (e) {
      console.error(`${RED}Error:${RESET} ${(e as Error).message}`);
    }
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
  _ctx: any,
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
