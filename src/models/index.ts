/**
 * Model adapters — each provider is a wing.
 */

export type {
  ModelConfig,
  ModelProvider,
  ModelResponse,
  TokenUsage,
} from "./protocol.ts";
export { makeModelConfig } from "./protocol.ts";

export type { ModelCapabilities, SpeedTier } from "./capabilities.ts";
export {
  CAPABILITY_CATALOG,
  getCapabilities,
} from "./capabilities.ts";

export { ModelRegistry } from "./registry.ts";
export { AnthropicProvider } from "./anthropic.ts";
export { OpenAIProvider } from "./openai.ts";
