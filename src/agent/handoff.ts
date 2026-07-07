/**
 * Model handoff detection — when a model returns after other models intervened.
 *
 * In a main conversation, the candidate pool may select different models for
 * different turns. When model A is used, then model B, then model A again,
 * the system injects a handoff prompt so model A knows what happened in
 * between and can review for needed corrections.
 */

export interface TurnRecord {
  turn_id: number;
  /** Internal pool key, e.g. "anthropic/claude-opus-4-6". */
  model_id: string;
  /** Provider name, e.g. "anthropic". */
  provider_name: string;
  /** API model name, e.g. "claude-opus-4-6". */
  service_model: string;
  timestamp: Date;
  /** One-line summary of user input. */
  user_input_summary: string;
  /** Tool names called during this turn. */
  tool_calls: string[];
  /** One-line summary of what the turn accomplished. */
  summary: string;
}

export function makeTurnRecord(
  turn_id: number,
  model_id: string,
  opts: Partial<TurnRecord> = {},
): TurnRecord {
  return {
    turn_id,
    model_id,
    provider_name: opts.provider_name ?? "",
    service_model: opts.service_model ?? "",
    timestamp: new Date(),
    user_input_summary: opts.user_input_summary ?? "",
    tool_calls: opts.tool_calls ?? [],
    summary: opts.summary ?? "",
  };
}

export class HandoffDetector {
  /**
   * Detect if a handoff prompt is needed.
   *
   * Returns a handoff prompt string, or null if not needed.
   *
   * Trigger: model A was used → other models were used in between
   * → model A is being used again.
   */
  detect(currentModel: string, turnHistory: TurnRecord[]): string | null {
    if (turnHistory.length < 2) return null;

    // Find the last turn where the current model was used.
    let previousTurn: TurnRecord | null = null;
    for (let i = turnHistory.length - 1; i >= 0; i--) {
      if (turnHistory[i]!.model_id === currentModel) {
        previousTurn = turnHistory[i]!;
        break;
      }
    }
    if (!previousTurn) return null; // first appearance

    // Find intervening turns by other models.
    const intermediate: TurnRecord[] = [];
    for (let i = turnHistory.length - 1; i >= 0; i--) {
      const t = turnHistory[i]!;
      if (t === previousTurn) break;
      if (t.model_id !== currentModel) intermediate.push(t);
    }

    if (intermediate.length === 0) return null;
    return this._buildPrompt(currentModel, previousTurn, intermediate);
  }

  private _buildPrompt(
    currentModel: string,
    previousTurn: TurnRecord,
    intermediateTurns: TurnRecord[],
  ): string {
    const otherModels = [
      ...new Set(intermediateTurns.map((t) => t.service_model || t.model_id)),
    ].sort();
    const turnsDesc = intermediateTurns
      .reverse()
      .map(
        (t) =>
          `  - [${t.service_model || t.model_id}] ${t.summary || t.user_input_summary}`,
      )
      .join("\n");

    return (
      `[System notice] Since your last turn in this conversation ` +
      `(turn #${previousTurn.turn_id}) as ${currentModel}, ` +
      `${intermediateTurns.length} turn(s) were handled by other ` +
      `models: ${otherModels.join(", ")}.\n\n` +
      `Work done in between:\n${turnsDesc}\n\n` +
      `Before addressing the current task, please:\n` +
      `1. Review these intermediate turns for issues that need ` +
      `correction but haven't been addressed (e.g. inconsistent ` +
      `code style, conflicting decisions, missed edge cases)\n` +
      `2. If issues are found, correct them before proceeding\n` +
      `3. If no corrections are needed, proceed with the current task`
    );
  }
}
