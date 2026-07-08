/**
 * Application state — single source of truth matching claude-code's AppState pattern.
 *
 * All UI state lives here. The agent loop updates it via setState, and React
 * components subscribe via useStore.
 */

import { createStore, type Store } from "./store.ts";

// -- Message types for display --

export type OutputLine =
  | { type: "text"; text: string; streaming?: boolean }
  | { type: "tool_use"; name: string; input: string }
  | { type: "tool_result"; content: string; isError?: boolean }
  | { type: "subagent_start"; agentType: string; description: string }
  | { type: "subagent_end" }
  | { type: "separator" };

// -- Permission prompt state --

export interface PermissionPrompt {
  toolName: string;
  toolInput: string;
  scope?: string;
  selected: number;
}

// -- Main app state --

export interface AppState {
  /** Rendered output lines (message history for this session). */
  output: OutputLine[];
  /** Current input buffer text. */
  input: string;
  /** REPL mode. */
  mode: "ready" | "running" | "permission";
  /** Active permission request (shown as overlay when mode=permission). */
  permission: PermissionPrompt | null;
  /** Whether session has been initialized. */
  initialized: boolean;
  /** Pool info for /pool command. */
  poolInfo: Record<string, { base: number; delta: number; effective: number }> | null;
}

export const INITIAL_STATE: AppState = {
  output: [],
  input: "",
  mode: "ready",
  permission: null,
  initialized: false,
  poolInfo: null,
};

// -- Store singleton --

export const appStore: Store<AppState> = createStore(INITIAL_STATE);

// -- Convenience mutations (called from agent loop or commands) --

export function appendOutput(line: OutputLine) {
  appStore.setState((s) => ({ ...s, output: [...s.output, line] }));
}

export function updateStreamLine(text: string) {
  appStore.setState((s) => {
    const out = [...s.output];
    for (let i = out.length - 1; i >= 0; i--) {
      const line = out[i]!;
      if (line.type === "text" && line.streaming) {
        out[i] = { type: "text", text, streaming: true };
        return { ...s, output: out };
      }
    }
    out.push({ type: "text", text, streaming: true });
    return { ...s, output: out };
  });
}

export function finalizeStreamLine() {
  appStore.setState((s) => {
    const out = [...s.output];
    for (let i = out.length - 1; i >= 0; i--) {
      const line = out[i]!;
      if (line.type === "text" && line.streaming) {
        out[i] = { type: "text", text: line.text };
        return { ...s, output: out };
      }
    }
    return s;
  });
}

export function setMode(mode: AppState["mode"]) {
  appStore.setState((s) => ({ ...s, mode }));
}

export function setInput(input: string) {
  appStore.setState((s) => ({ ...s, input }));
}

export function setPermission(permission: PermissionPrompt | null) {
  appStore.setState((s) => ({ ...s, permission, mode: permission ? "permission" : "running" }));
}

export function setPoolInfo(info: AppState["poolInfo"]) {
  appStore.setState((s) => ({ ...s, poolInfo: info }));
}

export function setInitialized() {
  appStore.setState((s) => ({ ...s, initialized: true }));
}
