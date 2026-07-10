/**
 * React hooks for Ink REPL — useStore, useAgent.
 */

import { useSyncExternalStore, useCallback, useEffect, useRef } from "react";
import { appStore, type AppState } from "./app-state.ts";
import { appendOutput, setMode, setPermission, setInitialized } from "./app-state.ts";
import { createSession, makeAgentContext } from "./bootstrap.ts";

export function useStore<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(appStore.subscribe, () => selector(appStore.getState()));
}

let _logger: { recordCycle(o: Record<string, unknown>): void } | null = null;
export function setGlobalLogger(l: typeof _logger) { _logger = l; }

export function useAgent() {
  const loopRef = useRef<any>(null);
  const configRef = useRef<any>(null);
  const initialized = useSyncExternalStore(
    appStore.subscribe,
    () => appStore.getState().initialized,
  );

  useEffect(() => {
    createSession(process.cwd(), _logger).then(({ loop, config, poolMgr }) => {
      loopRef.current = loop;
      configRef.current = config;
      (globalThis as any).__poolMgr = poolMgr;
      (globalThis as any).__loop = loop;
      setInitialized();
    });
  }, []);

  const runTurn = useCallback(async (userInput: string) => {
    const loop = loopRef.current;
    const config = configRef.current;
    if (!loop) return;

    setMode("running");
    appendOutput({ type: "text", text: "" });  // blank line
    appendOutput({ type: "text", text: `▸ ${userInput}` });
    appendOutput({ type: "separator" });

    const ctx = makeAgentContext(config, {
      modelOverride: config.model,
      customAgents: (loop as any).customAgents ?? null,
      skills: (loop as any).skillsList ?? [],
    });

    try {
      // Track streaming text: append to last OutputLine if it's a streaming text.
      let streamBuf = "";
      for await (const event of loop.run(userInput, ctx)) {
        switch (event.type) {
          case "text_delta": {
            streamBuf += (event as any).text;
            appStore.setState((s) => {
              const out = [...s.output];
              const last = out[out.length - 1];
              if (last?.type === "text" && last.streaming) {
                out[out.length - 1] = { type: "text", text: streamBuf, streaming: true };
              } else {
                out.push({ type: "text", text: streamBuf, streaming: true });
              }
              return { ...s, output: out };
            });
            break;
          }
          case "tool_use": {
            streamBuf = "";
            appendOutput({ type: "tool_use", name: event.name, input: JSON.stringify(event.input).slice(0, 100) });
            break;
          }
          case "tool_result": {
            streamBuf = "";
            const tr = event as any;
            appendOutput({ type: "tool_result", content: tr.content.slice(0, 200), isError: tr.is_error });
            break;
          }
          case "permission_request": {
            streamBuf = "";
            const pr = event;
            const response = await new Promise<string>((resolve) => {
              setPermission({ toolName: pr.tool_name, toolInput: JSON.stringify(pr.tool_input), scope: pr.scope, selected: 0, _resolve: resolve });
            });
            loop.setPermissionResponse(response);
            setPermission(null);
            break;
          }
          case "subagent_start": {
            streamBuf = "";
            appendOutput({ type: "subagent_start", agentType: (event as any).agent_type, description: (event as any).description ?? "" });
            break;
          }
          case "subagent_end": {
            streamBuf = "";
            appendOutput({ type: "subagent_end" });
            break;
          }
        }
      }
    } catch (e) {
      appendOutput({ type: "text", text: `Error: ${(e as Error).message}` });
    }
    setMode("ready");
  }, []);

  return { initialized, runTurn };
}
