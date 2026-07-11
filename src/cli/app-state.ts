/**
 * Application state — single source of truth matching claude-code's AppState pattern.
 *
 * All UI state lives here. The agent loop updates it via setState, and React
 * components subscribe via useStore.
 */

import { createStore, type Store } from "./store.ts";

// -- Message types for display --

export type OutputLine =
  | { type: "text"; text: string; streaming?: boolean; _stream?: boolean }
  | { type: "tool_use"; name: string; input: string }
  | { type: "tool_result"; content: string; isError?: boolean }
  | { type: "subagent_start"; agentType: string; description: string }
  | { type: "subagent_end" }
  | { type: "banner" }
  | { type: "separator" };

// -- Permission prompt state --

export interface PermissionPrompt {
  toolName: string;
  toolInput: Record<string, unknown>;
  scope?: string;
  selected: number;
  /** Internal: Promise resolver set by useAgent, called by PermissionDialog. */
  _resolve?: (response: string) => void;
}

// -- Main app state --

export interface AppState {
  /** User input chars (current turn). */
  inputChars: number;
  /** Cumulative input chars across the whole session (persisted for resume). */
  totalInputChars: number;
  /** Output chars received so far (current turn, from model). */
  outputChars: number;
  /** Total output characters across all turns. */
  totalOutputChars: number;
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
  inputChars: 0,
  totalInputChars: 0,
  outputChars: 0,
  totalOutputChars: 0,
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

/**
 * Rebuild visible transcript lines from restored message history, so resuming a
 * session (--continue/--resume) shows the prior conversation instead of a blank
 * screen. Mirrors the formatting the live loop produces (❯ for user input,
 * ● for assistant text, tool_use/tool_result lines).
 */
export function messagesToOutputLines(
  messages: Array<{ role: string; content: unknown[] }>,
): OutputLine[] {
  const out: OutputLine[] = [];
  for (const msg of messages) {
    const blocks = Array.isArray(msg.content) ? (msg.content as any[]) : [];
    if (msg.role === "system") continue;
    if (msg.role === "assistant") {
      for (const b of blocks) {
        if (b?.type === "text" && b.text) {
          out.push({ type: "text", text: `● ${b.text}` });
        } else if (b?.type === "tool_use") {
          out.push({
            type: "tool_use",
            name: String(b.name ?? ""),
            input: JSON.stringify(b.input ?? {}).slice(0, 100),
          });
        }
        // thinking blocks are not displayed
      }
      continue;
    }
    // user role — either tool results, or a typed-input turn.
    const toolResults = blocks.filter((b) => b?.type === "tool_result");
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        const content = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? "");
        out.push({ type: "tool_result", content, isError: !!tr.is_error });
      }
      continue;
    }
    for (const b of blocks) {
      if (b?.type === "text" && b.text) {
        out.push({ type: "text", text: "" });
        out.push({ type: "text", text: `❯ ${b.text}` });
        out.push({ type: "separator" });
      }
    }
  }
  return out;
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

export function setInputChars(n: number) { appStore.setState((s) => ({ ...s, inputChars: n })); }
export function addInputChars(n: number) { appStore.setState((s) => ({ ...s, inputChars: s.inputChars + n, totalInputChars: s.totalInputChars + n })); }
export function addTotalInputChars(n: number) { appStore.setState((s) => ({ ...s, totalInputChars: s.totalInputChars + n })); }
export function setOutputChars(n: number) { appStore.setState((s) => ({ ...s, outputChars: n })); }
export function addTotalOutputChars(n: number) { appStore.setState((s) => ({ ...s, totalOutputChars: s.totalOutputChars + n })); }
/** Restore cumulative stats when resuming a session (0 if not recorded). */
export function setSessionTotals(totalInputChars: number, totalOutputChars: number) {
  appStore.setState((s) => ({ ...s, totalInputChars, totalOutputChars }));
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
