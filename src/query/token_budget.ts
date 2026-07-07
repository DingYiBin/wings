/** Token budget — track context window usage and signal compaction. */

import type { Message } from "../messages/types.ts";

/**
 * Track remaining context window budget.
 *
 * Doesn't do actual tokenization (that requires model-specific tokenizers).
 * Instead uses a conservative character-based heuristic (~4 chars per token)
 * to estimate. Sufficient for deciding when to compact — the compactor itself
 * will use a real token count from the API response.
 */
export class TokenBudget {
  /** Conservative estimate: 4 characters ≈ 1 token for English text. */
  static readonly CHARS_PER_TOKEN = 4;

  contextWindow: number;
  reservedForOutput: number;
  systemPromptTokens: number;

  constructor(
    contextWindow: number,
    opts: { reservedForOutput?: number; systemPromptTokens?: number } = {},
  ) {
    this.contextWindow = contextWindow;
    this.reservedForOutput = opts.reservedForOutput ?? 4096;
    this.systemPromptTokens = opts.systemPromptTokens ?? 0;
  }

  /** Return estimated remaining tokens after accounting for messages. */
  remaining(messages: Message[]): number {
    let used = this.systemPromptTokens;
    for (const msg of messages) {
      used += this._estimateMessageTokens(msg);
    }
    return Math.max(0, this.contextWindow - this.reservedForOutput - used);
  }

  /** Return true if messages consume > 80% of the available budget. */
  needsCompact(messages: Message[]): boolean {
    const available = this.contextWindow - this.reservedForOutput - this.systemPromptTokens;
    if (available <= 0) return true;
    let used = 0;
    for (const m of messages) used += this._estimateMessageTokens(m);
    return used > available * 0.8;
  }

  /** Estimate token count for a plain text string. */
  estimateTokens(text: string): number {
    return Math.max(1, Math.floor(text.length / TokenBudget.CHARS_PER_TOKEN));
  }

  private _estimateMessageTokens(msg: Message): number {
    let total = 0;
    for (const block of msg.content) {
      // Each content block has a small type overhead.
      total += 2;
      if (block.type === "text") {
        total += Math.floor(block.text.length / TokenBudget.CHARS_PER_TOKEN);
      } else if (block.type === "tool_use") {
        total += Math.floor(block.name.length / TokenBudget.CHARS_PER_TOKEN) + 4;
      } else if (block.type === "tool_result") {
        total += Math.floor(block.content.length / TokenBudget.CHARS_PER_TOKEN);
      }
    }
    return Math.max(1, total);
  }
}
