/**
 * React hooks for Ink REPL — useStore, useAgent.
 */

import { useSyncExternalStore, useCallback, useEffect, useRef } from "react";
import { appStore, type AppState } from "./app-state.ts";
import { appendOutput, setMode, setPermission, setInitialized, setInputChars, setOutputChars, addTotalOutputChars, addInputChars } from "./app-state.ts";
import { createSession, makeAgentContext } from "./bootstrap.ts";
import { saveNewMessages, updateSessionIndex, saveSessionMeta, updateSessionMeta, getSessionHash } from "../services/session-paths.ts";

export function useStore<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(appStore.subscribe, () => selector(appStore.getState()));
}

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
  const turnCountRef = useRef(0);
  const firstSaveRef = useRef(true);

  // Centralized output: buffers text from any source (main loop or subagent),
  // flushes only on non-text events or after turn completes. Subagent text gets
  // the same "● " marker as main-agent text for visual consistency.
  const flushText = (buf: string) => {
    if (buf) { appendOutput({ type: "text", text: `● ${buf}` }); addTotalOutputChars(buf.length); }
  };

  useEffect(() => {
    // Expose for subagent capture in loop.ts.
    (globalThis as any).__appendOutput = (line: { type: string; text?: string; name?: string; input?: string; content?: string; }) => {
      if (line.type === "text" && line.text !== undefined) {
        _subBuf += line.text;
        appStore.setState((s) => ({ ...s, outputChars: s.outputChars + line.text!.length }));
      } else if (line.type === "tool_use") {
        flushText(_subBuf); _subBuf = "";
        appendOutput({ type: "tool_use", name: line.name!, input: line.input! });
      } else if (line.type === "tool_result" && line.content !== undefined) {
        // Count but don't display — subagent tool results are internal.
        addInputChars(line.content.length);
      }
    };
    createSession(process.cwd()).then(({ loop, config, poolMgr }) => {
      loopRef.current = loop;
      configRef.current = config;
      (globalThis as any).__poolMgr = poolMgr;
      (globalThis as any).__loop = loop;
      // Inject resume messages if restoring a session.
      const resumeMsgs = (globalThis as any).__resumeMessages as Array<{ role: string; content: unknown[] }> | undefined;
      if (resumeMsgs && resumeMsgs.length > 0) {
        (loop as any)._messages = resumeMsgs as any;
        // Skip adding system prompt since messages already have it.
      }
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

    try {
      for await (const event of loop.run(userInput, ctx)) {
        switch (event.type) {
          case "text_delta": {
            // White dot marker for model response (like claude-code). The blank
            // line above a text block is handled by the renderer (gapAboveText).
            if (!streamBuf) streamBuf = "● ";
            streamBuf += (event as any).text as string;
            setOutputChars(streamBuf.length + _subBuf.length);
            break;
          }
          case "tool_use": {
            finalizeStream();
            appendOutput({ type: "tool_use", name: event.name, input: JSON.stringify(event.input).slice(0, 100) });
            break;
          }
          case "tool_result": {
            finalizeStream();
            const tr = event as any;
            appendOutput({ type: "tool_result", content: tr.content, isError: tr.is_error });
            // Tool results are sent to the API as input — count them.
            addInputChars((tr.content ?? "").length);
            break;
          }
          case "permission_request": {
            finalizeStream();
            const pr = event;
            const response = await new Promise<string>((resolve) => {
              setPermission({ toolName: pr.tool_name, toolInput: pr.tool_input as Record<string, unknown>, scope: pr.scope, selected: 0, _resolve: resolve });
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
      }
      finalizeStream();
    } catch (e) {
      clearInterval(displayTimer);
      appendOutput({ type: "text", text: `Error: ${(e as Error).message}` });
    }
    appendOutput({ type: "text", text: "" });
    appendOutput({ type: "separator" });
    // Restore DECCKM so terminal scrolling works (WSL may disable it).
    process.stdout.write("\x1b[?1l");
    // Save session state for --resume / --continue.
    const hash = getSessionHash();
    const msgs = loop.messages as Array<{ role: string; content: unknown[] }>;
    if (msgs && msgs.length > 0) {
      saveNewMessages(hash, msgs);
      if (firstSaveRef.current) {
        saveSessionMeta(hash, process.cwd(), turnCountRef.current);
        updateSessionIndex(process.cwd(), hash);
        firstSaveRef.current = false;
      } else {
        updateSessionMeta(hash, turnCountRef.current);
      }
    }
    turnCountRef.current++;
    setMode("ready");
    runningRef.current = false;
  }, []);

  return { initialized, runTurn };
}
