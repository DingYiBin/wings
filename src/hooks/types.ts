/** Pre-tool-use hook: can block or allow a tool call. */
export interface PreToolUseResult {
  decision: "allow" | "deny" | null;
  /** Optional modified tool input (for transform hooks). */
  modified_input?: Record<string, unknown> | null;
}
