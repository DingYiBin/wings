/**
 * REPL — main screen. Ink v7.
 */

import React, { useCallback, useState } from "react";
import { Box, Text, useWindowSize } from "ink";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useStore, useAgent } from "./hooks.ts";
import { getSessionHash } from "../services/session-paths.ts";
import { setInput, setPermission, appendOutput, lastTruncatedResult } from "./app-state.ts";
import { Messages } from "./components/Messages.tsx";
import { PromptInput } from "./components/PromptInput.tsx";
import { PermissionDialog } from "./components/PermissionDialog.tsx";
import { WorkingIndicator } from "./components/WorkingIndicator.tsx";
import { StatusBar } from "./components/StatusBar.tsx";

export function REPL() {
  const output = useStore((s) => s.output);
  const input = useStore((s) => s.input);
  const mode = useStore((s) => s.mode);
  const totalInput = useStore((s) => s.totalInputChars);
  const outputChars = useStore((s) => s.outputChars);
  const totalOutput = useStore((s) => s.totalOutputChars);
  const totalWaitMs = useStore((s) => s.totalWaitMs);
  const runStartMs = useStore((s) => s.runStartMs);
  const permission = useStore((s) => s.permission);
  const { initialized, runTurn } = useAgent();
  const [exitHint, setExitHint] = useState(false);
  const { columns } = useWindowSize();
  const divWidth = Math.max(1, (columns || 80) - 2);

  const handleExit = useCallback(() => {
    process.stderr.write(`\nSession: ${getSessionHash()}\n  node --import tsx src/index.ts chat --resume ${getSessionHash()}\n\n`);
    process.exit(0);
  }, []);
  const handleInterrupt = useCallback(() => {
    const loop = (globalThis as any).__loop;
    if (loop) loop._aborted = true;
  }, []);

  /** Ctrl+O: open the most recent truncated tool result in $PAGER (default less).
   *  Mirrors Python's _expand_last_result — write a temp file, run the pager
   *  synchronously, then clean up. Ink's raw mode is paused so the pager owns
   *  the terminal while it runs. */
  const handleCtrlO = useCallback(() => {
    const entry = lastTruncatedResult();
    if (!entry) return;
    const pager = process.env["PAGER"] || "less -R";
    const path = join(tmpdir(), `wings-tool-${process.pid}-${Date.now()}.txt`);
    try {
      writeFileSync(path, `# ${entry.label}\n\n${entry.content}`);
      // Relinquish raw mode so the pager can read keys directly.
      const stdin = process.stdin as any;
      const wasRaw = typeof stdin.isRaw === "boolean" ? stdin.isRaw : false;
      try { stdin.setRawMode?.(false); } catch {}
      spawnSync(pager, [path], { stdio: "inherit" });
      try { stdin.setRawMode?.(wasRaw); } catch {}
    } catch {
      // best-effort; never crash the REPL over a pager failure
    } finally {
      try { unlinkSync(path); } catch {}
    }
  }, []);

  const handleSubmit = useCallback((text: string) => {
    if (text.startsWith("/")) {
      handleSlashCommand(text, { runTurn, onExit: handleExit });
      return;
    }
    runTurn(text);
  }, [runTurn, handleExit]);

  if (!initialized) return <Text dimColor>Initializing…</Text>;

  return (
    <Box flexDirection="column" paddingBottom={1}>
      <Box flexDirection="column" marginBottom={1} flexGrow={1}>
        <Messages lines={output} />
      </Box>
      <Box flexDirection="column" paddingX={1}>
        <WorkingIndicator totalInput={totalInput} outputChars={outputChars} totalOutput={totalOutput} totalWaitMs={totalWaitMs} runStartMs={runStartMs} mode={mode} />
        <Text> </Text>
        <Text dimColor>{"─".repeat(divWidth)}</Text>
        {mode === "permission" && permission ? (
          <PermissionDialog
            permission={permission}
            onUpdate={(p) => setPermission(p)}
            onResolve={(response) => permission._resolve?.(response)}
          />
        ) : (
          <PromptInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            onExit={handleExit}
            onInterrupt={handleInterrupt}
            onCtrlO={handleCtrlO}
            onExitHint={setExitHint}
            isLoading={mode === "running"}
          />
        )}
        <Text dimColor>{"─".repeat(divWidth)}</Text>
        <StatusBar mode={mode} showExitHint={exitHint} showAbortHint={true} />
      </Box>
    </Box>
  );
}

/** Slash-command dispatch. Lives inside the REPL closure so it can invoke
 *  runTurn (for skill turns) and onExit. Mirrors Python's command handling
 *  in main.py (exit/help/pool first, then skill fallback). */
function handleSlashCommand(
  cmd: string,
  ctx: {
    runTurn: (input: string, opts?: { taskType?: string }) => void;
    onExit: () => void;
  },
) {
  // cmd includes the leading "/". Split into name + remainder (maxsplit=1),
  // matching Python's user_input[1:].split(maxsplit=1).
  const parts = cmd.slice(1).split(/\s+/);
  const name = parts[0]!;
  const args = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";

  const poolMgr = (globalThis as any).__poolMgr;
  const loop = (globalThis as any).__loop;

  if (name === "exit") {
    ctx.onExit();
    return;
  }
  if (name === "help" || name === "h") {
    showHelp(loop);
    return;
  }
  if (name === "pool" && poolMgr) {
    handlePoolCommand(["/pool", ...parts.slice(1)], poolMgr);
    return;
  }

  // Fallback: skill lookup.
  const loader = loop?.skillLoader;
  const skill = loader?.getByName?.(name);
  if (skill) {
    const skillPrompt =
      `[Skill: ${skill.name}]\n\n${skill.content}\n\n` +
      `---\n\nUser request: ${args || "Run this skill"}`;
    ctx.runTurn(skillPrompt, { taskType: `skill/${skill.name}` });
    return;
  }

  appendOutput({ type: "text", text: `Unknown command or skill: /${name}` });
}

/** /help — list commands and dynamically discovered user-invocable skills. */
function showHelp(loop: any) {
  const lines: string[] = [``, `Commands:`, `  /exit          Quit the chat session`, `  /help          Show this help`, `  /pool          View/adjust API candidate pool`, `  ctrl+o         Expand last truncated tool result`];
  const loader = loop?.skillLoader;
  if (loader) {
    const skills = loader.listUserInvocable?.() ?? [];
    if (skills.length > 0) {
      lines.push(``, `Skills:`);
      for (const s of skills) lines.push(`  /${s.name.padEnd(15)} ${s.description}`);
    }
  }
  lines.push(``);
  appendOutput({ type: "text", text: lines.join("\n") });
}

/** Format a signed fixed-point number, leading + for non-negatives (Python `:+.1f`). */
function fmtSigned(n: number): string {
  return (n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1));
}

/** Handle /pool — view and adjust API candidate pools. Mirrors Python _handle_pool. */
function handlePoolCommand(parts: string[], poolMgr: any) {
  const SUBS = new Set(["up", "down", "disable", "enable"]);
  let taskType = "main";

  if (parts.length > 1 && SUBS.has(parts[1]!)) {
    if (parts.length < 3) {
      appendOutput({ type: "text", text: "  Usage: /pool up|down|disable|enable <api_id> [--task=<type>]" });
      return;
    }
    // --task=<type> may appear anywhere after the subcommand; remaining
    // tokens join (with spaces) into the api_id.
    const apiParts: string[] = [];
    for (const tok of parts.slice(2)) {
      if (tok.startsWith("--task=")) taskType = tok.slice("--task=".length);
      else apiParts.push(tok);
    }
    const apiId = apiParts.join(" ");
    const sub = parts[1]!;
    if (sub === "up") { poolMgr.upvote(taskType, apiId); appendOutput({ type: "text", text: `  +0.5 for ${apiId} in ${taskType}` }); }
    else if (sub === "down") { poolMgr.downvote(taskType, apiId); appendOutput({ type: "text", text: `  -0.5 for ${apiId} in ${taskType}` }); }
    else if (sub === "disable") { poolMgr.disable(taskType, apiId); appendOutput({ type: "text", text: `  Disabled ${apiId} for ${taskType}` }); }
    else if (sub === "enable") { poolMgr.enable(taskType, apiId); appendOutput({ type: "text", text: `  Enabled ${apiId} for ${taskType}` }); }
    return;
  } else if (parts.length > 1) {
    // /pool <task_type> — view another task type's pool.
    taskType = parts[1]!;
  }

  const info = poolMgr.getPoolInfo(taskType) as Record<string, { base: number; delta: number; effective: number }> | null;
  const lines: string[] = [``, `  Pool: ${taskType}`];
  if (!info || Object.keys(info).length === 0) {
    lines.push("    (no APIs registered)");
  } else {
    for (const [apiId, s] of Object.entries(info)) {
      const eff = s.effective;
      if (eff <= -1e9) {
        lines.push(`    ${apiId.padEnd(45)} [DISABLED]`);
      } else if (s.delta !== 0) {
        const dStr = s.delta > 0 ? `+${s.delta}` : `${s.delta}`;
        lines.push(`    ${apiId.padEnd(45)} eff=${fmtSigned(eff)}  (base=${s.base.toFixed(1)} ${dStr})`);
      } else {
        lines.push(`    ${apiId.padEnd(45)} eff=${fmtSigned(eff)}`);
      }
    }
    const customTypes: string[] = (poolMgr.listTaskTypes() as string[]).filter((t) => t !== "main" && t !== taskType);
    if (customTypes.length > 0) {
      const sorted = customTypes.sort();
      const shown = sorted.slice(0, 8).join(", ");
      const more = sorted.length > 8 ? `, +${sorted.length - 8} more` : "";
      lines.push(``, `  Types with custom masks: ${shown}${more}`);
    }
  }
  lines.push(``, `  /pool up|down|disable|enable <api_id> [--task=<type>]`, `  /pool <task_type>  — view another task type's pool`);
  appendOutput({ type: "text", text: lines.join("\n") });
}
