/**
 * React hooks matching claude-code's useAppState pattern.
 *
 * useStore(selector) — subscribe to a slice of state (like useSelector).
 * useAgent() — wraps the agent loop, pushing events into the store.
 */

import { useSyncExternalStore, useCallback, useEffect, useRef } from "react";
import { appStore, type AppState, type OutputLine } from "./app-state.ts";
import {
  appendOutput,
  updateStreamLine,
  finalizeStreamLine,
  setMode,
  setPermission,
  setPoolInfo,
  setInitialized,
} from "./app-state.ts";
import { createSession, makeAgentContext } from "./bootstrap.ts";

/** Subscribe to a slice of app state. Matches claude-code's useAppState(selector). */
export function useStore<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(
    appStore.subscribe,
    () => selector(appStore.getState()),
  );
}

/** Hook: initializes the agent session and manages the run loop. */
export function useAgent() {
  const loopRef = useRef<any>(null);
  const configRef = useRef<any>(null);
  const initialized = useSyncExternalStore(
    appStore.subscribe,
    () => appStore.getState().initialized,
  );

  // Initialize session once.
  useEffect(() => {
    createSession(process.cwd()).then(({ loop, config, poolMgr }) => {
      loopRef.current = loop;
      configRef.current = config;
      (globalThis as any).__poolMgr = poolMgr;
      setInitialized();
    });
  }, []);

  const runTurn = useCallback(async (userInput: string) => {
    const loop = loopRef.current;
    const config = configRef.current;
    if (!loop) return;

    const ctx = makeAgentContext(config, { modelOverride: config.model, customAgents: (loop as any).customAgents ?? null });
    setMode("running");
    appendOutput({ type: "text", text: `▸ ${userInput}` });
    appendOutput({ type: "separator" });

    try {
      for await (const event of loop.run(userInput, ctx)) {
        switch (event.type) {
          case "text_delta": {
            const deltaText = (event as any).text as string;
            // Find the last streaming text line and append, or start a new one.
            const lastStream = appStore.getState().output.findLast(
              (l: OutputLine): l is OutputLine & { type: "text"; streaming: true } =>
                l.type === "text" && l.streaming === true,
            );
            updateStreamLine(lastStream ? lastStream.text + deltaText : deltaText);
            break;
          }
          case "tool_use": {
            finalizeStreamLine();
            const short = JSON.stringify(event.input).slice(0, 100);
            appendOutput({ type: "tool_use", name: event.name, input: short });
            break;
          }
          case "tool_result": {
            const tr = event as any;
            appendOutput({ type: "tool_result", content: tr.content.slice(0, 200), isError: tr.is_error });
            break;
          }
          case "permission_request": {
            finalizeStreamLine();
            const pr = event;
            const response = await new Promise<string>((resolve) => {
              setPermission({
                toolName: pr.tool_name,
                toolInput: JSON.stringify(pr.tool_input),
                scope: pr.scope,
                selected: 0,
                _resolve: resolve,
              } as any);
            });
            loop.setPermissionResponse(response);
            setPermission(null);
            break;
          }
          case "subagent_start":
            appendOutput({ type: "subagent_start", agentType: (event as any).agent_type, description: (event as any).description });
            break;
          case "subagent_end":
            appendOutput({ type: "subagent_end" });
            break;
        }
      }
      finalizeStreamLine();
    } catch (e) {
      appendOutput({ type: "text", text: `Error: ${(e as Error).message}` });
    }
    setMode("ready");
  }, []);

  return { initialized, runTurn };
}
