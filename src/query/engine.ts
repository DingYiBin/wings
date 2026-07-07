/**
 * Query engine — unified LLM API entry point.
 *
 * Looks up the provider via ModelRegistry and calls it. Handles retry
 * for transient errors. Does NOT own message format conversion (that's
 * the provider's job) or model selection (that's ModelSelector).
 */

import type { Message, MessageContent, StreamEvent } from "../messages/types.ts";
import type { ModelConfig, ModelProvider, ModelResponse } from "../models/protocol.ts";
import type { ModelRegistry } from "../models/registry.ts";

// Transient errors worth retrying
const RETRIABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class QueryError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "QueryError";
  }
}

export class QueryEngine {
  constructor(
    private _registry: ModelRegistry,
    private _maxRetries: number = 3,
    private _retryBaseDelay: number = 1.0,
  ) {}

  async chat(
    messages: Message[],
    model: string,
    tools: Record<string, unknown>[] | null,
    config: ModelConfig,
  ): Promise<ModelResponse> {
    const provider = this._registry.get(model);

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      try {
        return await provider.chat(messages, tools, config);
      } catch (e) {
        lastError = e;
        if (!this._isRetriable(e) || attempt === this._maxRetries) break;
        const delay = this._retryBaseDelay * Math.pow(2, attempt);
        console.warn(`retry ${attempt + 1}/${this._maxRetries} for ${model} after ${delay.toFixed(1)}s: ${(e as Error).message}`);
        await sleep(delay * 1000);
      }
    }
    throw new QueryError(`chat failed for ${model}: ${(lastError as Error)?.message ?? lastError}`, lastError);
  }

  async *stream(
    messages: Message[],
    model: string,
    tools: Record<string, unknown>[] | null,
    config: ModelConfig,
  ): AsyncGenerator<StreamEvent | MessageContent> {
    const provider = this._registry.get(model);

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      try {
        for await (const event of provider.stream(messages, tools, config)) {
          yield event;
        }
        return; // successful completion
      } catch (e) {
        lastError = e;
        if (!this._isRetriable(e) || attempt === this._maxRetries) break;
        const delay = this._retryBaseDelay * Math.pow(2, attempt);
        console.warn(`stream retry ${attempt + 1}/${this._maxRetries} for ${model} after ${delay.toFixed(1)}s: ${(e as Error).message}`);
        await sleep(delay * 1000);
      }
    }
    throw new QueryError(`stream failed for ${model}: ${(lastError as Error)?.message ?? lastError}`, lastError);
  }

  private _isRetriable(exc: unknown): boolean {
    const e = exc as any;
    // Anthropic/OpenAI SDK errors use `status`.
    const status = e?.status_code ?? e?.status;
    if (typeof status === "number" && RETRIABLE_STATUSES.has(status)) return true;
    const response = e?.response;
    const httpStatus = response?.status_code ?? response?.status;
    if (typeof httpStatus === "number" && RETRIABLE_STATUSES.has(httpStatus)) return true;
    // fetch() throws TypeError on network/connection failures.
    if (e instanceof TypeError) return true;
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
