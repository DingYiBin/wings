/**
 * Model adapter protocol — the interface every API provider implements.
 *
 * Each adapter speaks its provider's native protocol and converts to/from
 * the internal Message format, so the agent layer only deals with one
 * message representation.
 */

import type { Message, MessageContent, StopReason, StreamEvent } from "../messages/types.ts";

// -- Config -------------------------------------------------------------------

export interface ModelConfig {
  model: string;
  temperature?: number | null;
  /** claude-code's CAPPED_DEFAULT. */
  max_tokens: number;
  /** Retry cap on max_tokens hit. */
  escalated_max_tokens: number;
  top_p?: number | null;
  thinking: boolean;
  /** null = auto: max_tokens - 1. */
  thinking_budget?: number | null;
  api_key: string;
  base_url?: string | null;
  /** Input context window (tokens). */
  context_window: number;
}

export function makeModelConfig(init: Partial<ModelConfig> & { model: string }): ModelConfig {
  return {
    temperature: null,
    max_tokens: 8_000,
    escalated_max_tokens: 64_000,
    top_p: null,
    thinking: true,
    thinking_budget: null,
    api_key: "",
    base_url: null,
    context_window: 200_000,
    ...init,
  };
}

// -- Response -----------------------------------------------------------------

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
}

export interface ModelResponse {
  content: MessageContent[];
  stop_reason: StopReason;
  usage: TokenUsage;
}

// -- Provider Protocol --------------------------------------------------------

/**
 * Protocol that every API adapter must implement.
 *
 * Each adapter speaks its provider's native protocol and converts to/from
 * the internal Message format.
 */
export interface ModelProvider {
  readonly provider_name: string;

  /** Send messages and receive a complete response. */
  chat(
    messages: Message[],
    tools: Record<string, unknown>[] | null,
    config: ModelConfig,
  ): Promise<ModelResponse>;

  /** Send messages and receive streaming events. */
  stream(
    messages: Message[],
    tools: Record<string, unknown>[] | null,
    config: ModelConfig,
  ): AsyncIterable<StreamEvent | MessageContent>;
}
