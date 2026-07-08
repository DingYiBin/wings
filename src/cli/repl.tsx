/**
 * REPL — main screen component. Matches claude-code's REPL.tsx structure.
 *
 * Component tree:
 *   REPL
 *   ├── Messages (scrollable output history)
 *   ├── PermissionDialog (overlay, shown when mode=permission)
 *   ├── PromptInput (input bar at bottom)
 *   └── handleCommand (slash commands)
 */

import React, { useCallback } from "react";
import { Box, Text } from "ink";
import { useStore, useAgent } from "./hooks.ts";
import { setInput, setPermission, setPoolInfo, appendOutput, setMode } from "./app-state.ts";
import type { AppState } from "./app-state.ts";
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

  const handleSubmit = useCallback((text: string) => {
    if (text.startsWith("/")) {
      handleCommand(text);
      return;
    }
    runTurn(text);
  }, [runTurn]);

  if (!initialized) {
    return <Text dimColor>Initializing…</Text>;
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Text dimColor>wings — each model is a wing</Text>

      {/* Messages */}
      <Box flexDirection="column" marginY={1}>
        <Messages lines={output} />
      </Box>

      {/* Pool info (from /pool command) */}
      {poolInfo && (
        <Box flexDirection="column" marginY={1}>
          <Text dimColor>API pool (main task type):</Text>
          {Object.entries(poolInfo).map(([id, s]) => (
            <Text key={id} dimColor>
              {"  "}{id}: base={s.base.toFixed(1)} delta={s.delta.toFixed(1)} score={s.effective.toFixed(1)}
            </Text>
          ))}
        </Box>
      )}

      {/* Permission overlay */}
      {mode === "permission" && permission && (
        <PermissionDialog
          permission={permission}
          onUpdate={(p) => setPermission(p)}
          onResolve={(response) => {
            (permission as any)._resolve(response);
          }}
        />
      )}

      {/* Input bar */}
      <PromptInput
        value={input}
        mode={mode}
        onChange={setInput}
        onSubmit={handleSubmit}
      />
    </Box>
  );
}

// -- Slash command handler --

function handleCommand(cmd: string) {
  const parts = cmd.split(/\s+/);
  const name = parts[0]!;
  const poolMgr = (globalThis as any).__poolMgr;

  if (name === "/help" || name === "/h") {
    appendOutput({ type: "text", text: "Commands: /help, /pool, /pool up|down <api>, Ctrl+C to exit" });
    return;
  }

  if (name === "/pool" && poolMgr) {
    if (parts.length === 1) {
      const info = poolMgr.getPoolInfo("main");
      setPoolInfo(info);
    } else if (parts.length === 3 && parts[1] === "up") {
      poolMgr.upvote("main", parts[2]!);
      appendOutput({ type: "text", text: `  ↑ ${parts[2]}` });
    } else if (parts.length === 3 && parts[1] === "down") {
      poolMgr.downvote("main", parts[2]!);
      appendOutput({ type: "text", text: `  ↓ ${parts[2]}` });
    }
    return;
  }

  appendOutput({ type: "text", text: `Unknown command: ${name}. Type /help.` });
}
