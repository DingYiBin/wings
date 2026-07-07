/**
 * Anthropic API adapter using the official `@anthropic-ai/sdk`.
 *
 * Streaming buffers all events first so we can check stop_reason before
 * yielding anything — matches the Python implementation's max_tokens
 * escalation (8K → 64K on stop_reason=max_tokens).
 */

import Anthropic from "@anthropic-ai/sdk";

import { toAnthropic } from "../messages/normalize.ts";
import type { WireBlock, WireMessage } from "../messages/types.ts";
import type {
  Message,
  MessageContent,
  Role,
  StreamEvent,
  StopReason,
  TextBlock,
  TextDelta,
  ThinkingBlock,
  ThinkingDelta,
  ToolUseBlock,
} from "../messages/types.ts";
import type { ModelConfig, ModelProvider, ModelResponse } from "./protocol.ts";

type Wire = Record<string, any>;

class StopReasonMap {
  static map(raw: string | null | undefined): StopReason {
    if (raw === "end_turn") return "end_turn";
    if (raw === "max_tokens") return "max_tokens";
    if (raw === "tool_use") return "tool_use";
    if (raw === "stop_sequence") return "stop_sequence";
    return "end_turn";
  }
}

export class AnthropicProvider implements ModelProvider {
  readonly provider_name = "anthropic";

  private _client(config: ModelConfig): Anthropic {
    const kwargs: ConstructorParameters<typeof Anthropic>[0] = { apiKey: config.api_key };
    if (config.base_url) (kwargs as Wire).baseURL = config.base_url;
    return new Anthropic(kwargs);
  }

  async chat(
    messages: Message[],
    tools: Wire[] | null,
    config: ModelConfig,
  ): Promise<ModelResponse> {
    const client = this._client(config);
    const [system, apiMessages] = this._splitSystem(messages);
    const body = this._buildRequest(config, apiMessages, tools, system);

    const response: Anthropic.Messages.Message = await client.messages.create(body as any);

    const content = this._parseContent(response.content as any[]);
    return {
      content,
      stop_reason: StopReasonMap.map(response.stop_reason),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_tokens: (response.usage as any).cache_read_input_tokens ?? null,
        cache_write_tokens: (response.usage as any).cache_creation_input_tokens ?? null,
      },
    };
  }

  async *stream(
    messages: Message[],
    tools: Wire[] | null,
    config: ModelConfig,
  ): AsyncIterable<StreamEvent | MessageContent> {
    const client = this._client(config);
    const [system, apiMessages] = this._splitSystem(messages);
    let body = this._buildRequest(config, apiMessages, tools, system);

    // First attempt — buffer all events so we can decide whether to escalate.
    const msgStream = client.messages.stream(body as any);
    const events: any[] = [];
    for await (const event of msgStream) {
      events.push(event);
    }
    const final: Anthropic.Messages.Message = await msgStream.finalMessage();
    let stopReason = StopReasonMap.map(final.stop_reason);

    // Escalate if we hit max_tokens and haven't already.
    if (
      stopReason === "max_tokens" &&
      (body as any).max_tokens < config.escalated_max_tokens
    ) {
      (body as any).max_tokens = config.escalated_max_tokens;
      // Recalculate thinking budget for escalated max_tokens.
      if (
        (body as any).thinking &&
        typeof (body as any).thinking === "object" &&
        "budget_tokens" in (body as any).thinking
      ) {
        const escalatedBudget = config.thinking_budget ?? (config.escalated_max_tokens - 1);
        (body as any).thinking.budget_tokens = Math.min(
          escalatedBudget,
          config.escalated_max_tokens - 1,
        );
      }

      const stream2 = client.messages.stream(body as any);
      for await (const event of stream2) {
        if (event.type === "content_block_delta") {
          const dt = event.delta?.type;
          if (dt === "text_delta") {
            yield { type: "text_delta", text: event.delta.text } satisfies TextDelta;
          } else if (dt === "thinking_delta") {
            yield { type: "thinking_delta", text: event.delta.thinking } satisfies ThinkingDelta;
          }
        }
      }
      const final2: Anthropic.Messages.Message = await stream2.finalMessage();
      for (const block of final2.content as any[]) {
        const bt = block?.type;
        if (bt === "text") {
          yield { type: "text", text: block.text } satisfies TextBlock;
        } else if (bt === "thinking") {
          yield {
            type: "thinking",
            thinking: block.thinking ?? "",
            signature: block.signature ?? "",
          } satisfies ThinkingBlock;
        } else if (bt === "tool_use") {
          yield {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: typeof block.input === "object" && block.input !== null ? block.input : {},
          } satisfies ToolUseBlock;
        }
      }
      return;
    }

    // No escalation needed — replay buffered events.
    for (const event of events) {
      if (event.type === "content_block_delta") {
        const dt = event.delta?.type;
        if (dt === "text_delta") {
          yield { type: "text_delta", text: event.delta.text } satisfies TextDelta;
        } else if (dt === "thinking_delta") {
          yield { type: "thinking_delta", text: event.delta.thinking } satisfies ThinkingDelta;
        }
      }
    }

    for (const block of final.content as any[]) {
      const bt = block?.type;
      if (bt === "text") {
        yield { type: "text", text: block.text } satisfies TextBlock;
      } else if (bt === "thinking") {
        yield {
          type: "thinking",
          thinking: block.thinking ?? "",
          signature: block.signature ?? "",
        } satisfies ThinkingBlock;
      } else if (bt === "tool_use") {
        yield {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: typeof block.input === "object" && block.input !== null ? block.input : {},
        } satisfies ToolUseBlock;
      }
    }
  }

  // -- helpers --

  private _buildRequest(
    config: ModelConfig,
    messages: WireMessage[],
    tools: Wire[] | null,
    system: WireBlock[] | null,
  ): Wire {
    const body: Wire = {
      model: config.model,
      max_tokens: config.max_tokens || 4096,
      messages,
    };
    if (system) body.system = system;
    if (tools) body.tools = tools;
    if (config.temperature != null) body.temperature = config.temperature;
    if (config.top_p != null) body.top_p = config.top_p;

    if (config.thinking) {
      // Always set budget_tokens. claude-code formula:
      //   budget = min(max_tokens - 1, user_budget)
      // API requires max_tokens > budget_tokens.
      const maxTk: number = body.max_tokens;
      const defaultBudget = maxTk && maxTk > 1 ? maxTk - 1 : 7999;
      const budget =
        config.thinking_budget != null
          ? Math.min(config.thinking_budget, defaultBudget)
          : defaultBudget;
      body.thinking = { type: "enabled", budget_tokens: budget };
    }
    return body;
  }

  /** Extract system messages for Anthropic's top-level system param. */
  private _splitSystem(
    messages: Message[],
  ): [WireBlock[] | null, WireMessage[]] {
    const systemBlocks: WireBlock[] = [];
    const apiMessages: WireMessage[] = [];
    for (const msg of messages) {
      if (msg.role === ("system" as Role)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            systemBlocks.push({ type: "text", text: block.text });
          }
        }
      } else {
        apiMessages.push(toAnthropic(msg));
      }
    }
    return [systemBlocks.length > 0 ? systemBlocks : null, apiMessages];
  }

  /** Parse Anthropic response content blocks into internal types. */
  private _parseContent(rawContent: any[]): MessageContent[] {
    const result: MessageContent[] = [];
    for (const block of rawContent) {
      const blockType: string = block?.type ?? "";
      if (blockType === "text") {
        result.push({ type: "text", text: block.text } satisfies TextBlock);
      } else if (blockType === "thinking") {
        result.push({
          type: "thinking",
          thinking: block.thinking ?? "",
          signature: block.signature ?? "",
        } satisfies ThinkingBlock);
      } else if (blockType === "tool_use") {
        result.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: typeof block.input === "object" && block.input !== null ? block.input : {},
        } satisfies ToolUseBlock);
      }
    }
    return result;
  }

  /** Map Anthropic stop_reason to internal StopReason. Exposed for tests. */
  _mapStopReason(raw: string | null | undefined): StopReason {
    return StopReasonMap.map(raw);
  }
}
