/**
 * Static model capability metadata.
 *
 * Each model entry describes what the model can and cannot do, enabling
 * capability-aware selection and validation. Values are sourced from
 * official provider documentation.
 */

export type SpeedTier = "fast" | "normal" | "slow";

export interface ModelCapabilities {
  /** Maximum context size in tokens. */
  context_window: number;
  /** Maximum output tokens per call. */
  max_output_tokens: number;
  /** Image understanding. */
  supports_vision: boolean;
  /** Extended thinking / reasoning. */
  supports_thinking: boolean;
  /** Function calling / tool use. */
  supports_tools: boolean;
  /** Streaming output. */
  supports_streaming: boolean;
  /** Multiple tool calls in one turn. */
  supports_parallel_tools: boolean;
  speed_tier: SpeedTier;
  /** $ per million input tokens. */
  cost_per_m_input: number;
  /** $ per million output tokens. */
  cost_per_m_output: number;
}

function makeCap(init: ModelCapabilities): ModelCapabilities {
  return { ...init };
}

// -- Built-in capability catalog ---------------------------------------------
// Pricing as of 2026-07.

// Anthropic models
export const CLAUDE_OPUS_4_6: ModelCapabilities = makeCap({
  context_window: 200_000,
  max_output_tokens: 32_768,
  supports_vision: true,
  supports_thinking: true,
  supports_tools: true,
  supports_streaming: true,
  supports_parallel_tools: true,
  speed_tier: "slow",
  cost_per_m_input: 15.0,
  cost_per_m_output: 75.0,
});

export const CLAUDE_SONNET_4_6: ModelCapabilities = makeCap({
  context_window: 200_000,
  max_output_tokens: 16_384,
  supports_vision: true,
  supports_thinking: true,
  supports_tools: true,
  supports_streaming: true,
  supports_parallel_tools: true,
  speed_tier: "normal",
  cost_per_m_input: 3.0,
  cost_per_m_output: 15.0,
});

export const CLAUDE_HAIKU_4_5: ModelCapabilities = makeCap({
  context_window: 200_000,
  max_output_tokens: 8_192,
  supports_vision: true,
  supports_thinking: false,
  supports_tools: true,
  supports_streaming: true,
  supports_parallel_tools: true,
  speed_tier: "fast",
  cost_per_m_input: 0.8,
  cost_per_m_output: 4.0,
});

// OpenAI models
export const GPT_4O: ModelCapabilities = makeCap({
  context_window: 128_000,
  max_output_tokens: 16_384,
  supports_vision: true,
  supports_thinking: false,
  supports_tools: true,
  supports_streaming: true,
  supports_parallel_tools: true,
  speed_tier: "normal",
  cost_per_m_input: 2.5,
  cost_per_m_output: 10.0,
});

export const GPT_O4_MINI: ModelCapabilities = makeCap({
  context_window: 200_000,
  max_output_tokens: 100_000,
  supports_vision: true,
  supports_thinking: true,
  supports_tools: true,
  supports_streaming: true,
  supports_parallel_tools: false,
  speed_tier: "normal",
  cost_per_m_input: 1.1,
  cost_per_m_output: 4.4,
});

// Google Gemini models
export const GEMINI_2_5_PRO: ModelCapabilities = makeCap({
  context_window: 1_048_576,
  max_output_tokens: 65_536,
  supports_vision: true,
  supports_thinking: true,
  supports_tools: true,
  supports_streaming: true,
  supports_parallel_tools: true,
  speed_tier: "normal",
  cost_per_m_input: 1.25,
  cost_per_m_output: 10.0,
});

export const GEMINI_2_5_FLASH: ModelCapabilities = makeCap({
  context_window: 1_048_576,
  max_output_tokens: 65_536,
  supports_vision: true,
  supports_thinking: true,
  supports_tools: true,
  supports_streaming: true,
  supports_parallel_tools: true,
  speed_tier: "fast",
  cost_per_m_input: 0.15,
  cost_per_m_output: 0.6,
});

/** Lookup table keyed by the canonical api_id used in the pool system. */
export const CAPABILITY_CATALOG: Record<string, ModelCapabilities> = {
  "anthropic/claude-opus-4-6": CLAUDE_OPUS_4_6,
  "anthropic/claude-sonnet-4-6": CLAUDE_SONNET_4_6,
  "anthropic/claude-haiku-4-5": CLAUDE_HAIKU_4_5,
  "openai/gpt-4o": GPT_4O,
  "openai/o4-mini": GPT_O4_MINI,
  "google/gemini-2.5-pro": GEMINI_2_5_PRO,
  "google/gemini-2.5-flash": GEMINI_2_5_FLASH,
};

/** Look up capabilities for an api_id. Returns undefined if unknown. */
export function getCapabilities(api_id: string): ModelCapabilities | undefined {
  return CAPABILITY_CATALOG[api_id];
}
