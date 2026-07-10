/**
 * REPL — main screen. Ink v7.
 */

import React, { useCallback, useState } from "react";
import { Box, Text } from "ink";
import { useStore, useAgent } from "./hooks.ts";
import { setInput, setPermission, setPoolInfo, appendOutput } from "./app-state.ts";
import { Messages } from "./components/Messages.tsx";
import { PromptInput } from "./components/PromptInput.tsx";
import { PermissionDialog } from "./components/PermissionDialog.tsx";
import { WorkingIndicator } from "./components/WorkingIndicator.tsx";

export function REPL() {
  const output = useStore((s) => s.output);
  const input = useStore((s) => s.input);
  const mode = useStore((s) => s.mode);
  const charCount = useStore((s) => s.charCount);
  const permission = useStore((s) => s.permission);
  const { initialized, runTurn } = useAgent();
  const [exitCount, setExitCount] = useState(0);

  const handleSubmit = useCallback((text: string) => {
    if (text.startsWith("/")) {
      handleSlashCommand(text);
      return;
    }
    runTurn(text);
  }, [runTurn]);

  const handleExit = useCallback(() => {
    setExitCount((n) => n + 1);
    if (exitCount >= 1) process.exit(0);
    setTimeout(() => setExitCount(0), 2000);
  }, [exitCount]);

  if (!initialized) return <Text dimColor>Initializing…</Text>;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text dimColor>wings — each model is a wing</Text>
      <Box flexDirection="column" marginY={1} flexGrow={1}>
        <Messages lines={output} />
      </Box>
      {mode === "permission" && permission && (
        <PermissionDialog
          permission={permission}
          onUpdate={(p) => setPermission(p)}
          onResolve={(response) => permission._resolve?.(response)}
        />
      )}
      <Text dimColor>{"─".repeat(process.stdout.columns || 80)}</Text>
      <WorkingIndicator charCount={charCount} visible={mode === "running"} />
      <PromptInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        onExit={handleExit}
        isLoading={mode === "running"}
      />
      <Text dimColor>{"─".repeat(process.stdout.columns || 80)}</Text>
    </Box>
  );
}

function handleSlashCommand(cmd: string) {
  const p = cmd.split(/\s+/); const n = p[0]!;
  const poolMgr = (globalThis as any).__poolMgr;
  if (n === "/help" || n === "/h") appendOutput({ type: "text", text: "Commands: /help, /pool, /pool up|down <api>, Ctrl+C twice to exit" });
  else if (n === "/pool" && poolMgr) {
    if (p.length === 1) setPoolInfo(poolMgr.getPoolInfo("main"));
    else if (p.length === 3 && (p[1] === "up" || p[1] === "down")) {
      p[1] === "up" ? poolMgr.upvote("main", p[2]!) : poolMgr.downvote("main", p[2]!);
      appendOutput({ type: "text", text: `  ${p[1] === "up" ? "↑" : "↓"} ${p[2]}` });
    }
  } else appendOutput({ type: "text", text: `Unknown command: ${n}. Type /help.` });
}
