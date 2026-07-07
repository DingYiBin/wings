/** Protocol that consumers depend on — not the concrete pool manager. */

export interface ModelSelector {
  /** Return the selected api_id.
   *
   * Args:
   *   taskType: Task type ("main", "subagent/explore", "skill/commit", ...).
   *   override: Session-level model lock (set by /model command),
   *             bypasses pool selection entirely.
   *
   * Returns:
   *   api_id string, e.g. "anthropic/claude-opus-4-6".
   *
   * Throws:
   *   NoAPIAvailable: No API is available in the resolved pool.
   */
  select(taskType: string, override?: string | null): string;
}
