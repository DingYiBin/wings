/**
 * React hooks for Ink REPL — useStore, useAgent.
 */

import { useSyncExternalStore, useCallback, useEffect, useRef } from "react";
import { appStore, type AppState } from "./app-state.ts";
import { appendOutput, setMode, setPermission, setInitialized, setInputChars, setOutputChars, addTotalOutputChars } from "./app-state.ts";
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

  // Subagent text accumulator — buffered, flushed on non-text events.
  let _subBuf = "";
  // Prevent concurrent turn execution.
  const runningRef = useRef(false);

  // Centralized output: buffers text from any source (main loop or subagent),
  // flushes only on non-text events or after turn completes.
  const flushText = (buf: string) => {
    if (buf) { appendOutput({ type: "text", text: buf }); addTotalOutputChars(buf.length); }
  };

  useEffect(() => {
    // Expose for subagent capture in loop.ts.
    (globalThis as any).__appendOutput = (line: { type: string; text?: string; name?: string; input?: string; }) => {
      if (line.type === "text" && line.text !== undefined) {
        _subBuf += line.text;
        appStore.setState((s) => ({ ...s, outputChars: s.outputChars + line.text!.length }));
      } else if (line.type === "tool_use") {
        flushText(_subBuf); _subBuf = "";
        appendOutput({ type: "tool_use", name: line.name!, input: line.input! });
      }
    };
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
    if (!loop || runningRef.current) return;
    runningRef.current = true;

    _subBuf = "";
    setMode("running");
    setInputChars(userInput.length);
    setOutputChars(0);
    appendOutput({ type: "text", text: "" });
    appendOutput({ type: "text", text: `❯ ${userInput}` });
    appendOutput({ type: "separator" });

    const ctx = makeAgentContext(config, {
      modelOverride: config.model,
      customAgents: (loop as any).customAgents ?? null,
      skills: (loop as any).skillsList ?? [],
    });

    // Throttle: flush display every 100ms while running.
    let streamBuf = "";
    let lastFlushed = "";
    const displayTimer = setInterval(() => {
      if (streamBuf !== lastFlushed) {
        // Update the last text OutputLine in-place.
        appStore.setState((s) => {
          const out = [...s.output];
          const last = out[out.length - 1];
          if (last?.type === "text" && last._stream === true) {
            out[out.length - 1] = { type: "text", text: streamBuf, _stream: true } as any;
          } else {
            out.push({ type: "text", text: streamBuf, _stream: true } as any);
          }
          return { ...s, output: out };
        });
        lastFlushed = streamBuf;
      }
    }, 100);

    const finalizeStream = () => {
      clearInterval(displayTimer);
      if (streamBuf) {
        // Replace the _stream line with a finalized non-streaming one.
        appStore.setState((s) => {
          const out = [...s.output];
          const last = out[out.length - 1];
          if (last?.type === "text" && (last as any)._stream === true) {
            out[out.length - 1] = { type: "text", text: streamBuf };
          } else if (streamBuf) {
            out.push({ type: "text", text: streamBuf });
          }
          return { ...s, output: out };
        });
        addTotalOutputChars(streamBuf.length);
        streamBuf = "";
        lastFlushed = "";
      }
    };

    let prevEv = "";
    try {
      for await (const event of loop.run(userInput, ctx)) {
        switch (event.type) {
          case "text_delta": {
            // Add blank line when transitioning from tool results to summary text.
            if (prevEv === "tool_result" && !streamBuf) {
              appendOutput({ type: "text", text: "" });
            }
            streamBuf += (event as any).text as string;
            setOutputChars(streamBuf.length + _subBuf.length);
            break;
          }
          case "tool_use": {
            finalizeStream();
            appendOutput({ type: "text", text: "" }); // blank line before tool call
            appendOutput({ type: "tool_use", name: event.name, input: JSON.stringify(event.input).slice(0, 100) });
            break;
          }
          case "tool_result": {
            finalizeStream();
            const tr = event as any;
            appendOutput({ type: "tool_result", content: tr.content.slice(0, 200), isError: tr.is_error });
            break;
          }
          case "permission_request": {
            finalizeStream();
            const pr = event;
            const response = await new Promise<string>((resolve) => {
              setPermission({ toolName: pr.tool_name, toolInput: JSON.stringify(pr.tool_input), scope: pr.scope, selected: 0, _resolve: resolve });
            });
            loop.setPermissionResponse(response);
            setPermission(null);
            break;
          }
          case "subagent_start": {
            finalizeStream();
            _subBuf = "";
            appendOutput({ type: "subagent_start", agentType: (event as any).agent_type, description: (event as any).description ?? "" });
            break;
          }
          case "subagent_end": {
            // Flush subagent buffer as a finalized line.
            flushText(_subBuf); _subBuf = "";
            finalizeStream();
            appendOutput({ type: "subagent_end" });
            break;
          }
        }
        prevEv = event.type;
      }
      finalizeStream();
    } catch (e) {
      clearInterval(displayTimer);
      appendOutput({ type: "text", text: `Error: ${(e as Error).message}` });
    }
    appendOutput({ type: "text", text: "" });
    appendOutput({ type: "separator" });
    setMode("ready");
    runningRef.current = false;
  }, []);

  return { initialized, runTurn };
}
