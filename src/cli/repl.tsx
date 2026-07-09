/**
 * REPL — main screen matching claude-code structure.
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { useStore, useAgent } from "./hooks.ts";
import { setInput, setPermission, setPoolInfo, appendOutput, setMode } from "./app-state.ts";
import { Messages } from "./components/Messages.tsx";
import { PromptInput } from "./components/PromptInput.tsx";
import { PermissionDialog } from "./components/PermissionDialog.tsx";

export function REPL() {
  const output = useStore((s) => s.output);
  const input = useStore((s) => s.input);
  const mode = useStore((s) => s.mode);
  const permission = useStore((s) => s.permission);
  const poolInfo = useStore((s) => s.poolInfo);
  const { initialized, runTurn } = useAgent();

  const [exitMsg, setExitMsg] = useState(false);
  const exitCount = React.useRef(0);

  const handleSubmit = useCallback((text: string) => {
    if (text.startsWith("/")) {
      handleSlashCommand(text);
      return;
    }
    runTurn(text);
  }, [runTurn]);

  const handleExit = useCallback(() => {
    exitCount.current++;
    if (exitCount.current >= 2) {
      process.exit(0);
    }
    setExitMsg(true);
    setTimeout(() => { setExitMsg(false); exitCount.current = 0; }, 2000);
  }, []);

  if (!initialized) {
    return <Text dimColor>Initializing…</Text>;
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} height="100%">
      <Text dimColor>wings — each model is a wing</Text>
      <Box flexDirection="column" marginY={1} flexGrow={1}>
        <Messages lines={output} />
      </Box>
      {poolInfo && (
        <Box flexDirection="column" marginY={1}>
          <Text dimColor>API pool (main task type):</Text>
          {Object.entries(poolInfo).map(([id, s]) => (
            <Text key={id} dimColor>  {id}: base={s.base.toFixed(1)} delta={s.delta.toFixed(1)} score={s.effective.toFixed(1)}</Text>
          ))}
        </Box>
      )}
      {mode === "permission" && permission && (
        <PermissionDialog
          permission={permission}
          onUpdate={(p) => setPermission(p)}
          onResolve={(response) => permission._resolve?.(response)}
        />
      )}
      <PromptInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        onExit={handleExit}
        isLoading={mode === "running"}
      />
      {exitMsg && <Text dimColor>  Press Ctrl+C again to exit</Text>}
    </Box>
  );
}

function handleSlashCommand(cmd: string) {
  const parts = cmd.split(/\s+/);
  const name = parts[0]!;
  const poolMgr = (globalThis as any).__poolMgr;
  if (name === "/help" || name === "/h") {
    appendOutput({ type: "text", text: "Commands: /help, /pool, /pool up|down <api>, Ctrl+C to exit" });
  } else if (name === "/pool" && poolMgr) {
    if (parts.length === 1) {
      setPoolInfo(poolMgr.getPoolInfo("main"));
    } else if (parts.length === 3 && parts[1] === "up") {
      poolMgr.upvote("main", parts[2]!);
      appendOutput({ type: "text", text: `  ↑ ${parts[2]}` });
    } else if (parts.length === 3 && parts[1] === "down") {
      poolMgr.downvote("main", parts[2]!);
      appendOutput({ type: "text", text: `  ↓ ${parts[2]}` });
    }
  } else {
    appendOutput({ type: "text", text: `Unknown command: ${name}. Type /help.` });
  }
}
