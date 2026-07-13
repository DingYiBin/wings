/**
 * REPL — main screen. Ink v7.
 */

import React, { useCallback, useState } from "react";
import { Box, Text, useWindowSize } from "ink";
import { useStore, useAgent } from "./hooks.ts";
import { getSessionHash } from "../services/session-paths.ts";
import { setInput, setPermission, appendOutput } from "./app-state.ts";
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

  const handleSubmit = useCallback((text: string) => {
    if (text.startsWith("/")) { handleSlashCommand(text); return; }
    runTurn(text);
  }, [runTurn]);

  const handleExit = useCallback(() => {
    process.stderr.write(`\nSession: ${getSessionHash()}\n  node --import tsx src/index.ts chat --resume ${getSessionHash()}\n\n`);
    process.exit(0);
  }, []);
  const handleInterrupt = useCallback(() => {
    const loop = (globalThis as any).__loop;
    if (loop) loop._aborted = true;
  }, []);

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

function handleSlashCommand(cmd: string) {
  const p = cmd.split(/\s+/); const n = p[0]!;
  const poolMgr = (globalThis as any).__poolMgr;
  if (n === "/help" || n === "/h") appendOutput({ type: "text", text: "Commands: /help, /pool, /pool up|down <api>, Ctrl+C twice to exit" });
  else if (n === "/pool" && poolMgr) {
    handlePoolCommand(p, poolMgr);
  } else appendOutput({ type: "text", text: `Unknown command: ${n}. Type /help.` });
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
