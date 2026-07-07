/**
 * OpenAI API adapter using the official `openai` SDK.
 *
 * Streaming yields TextDelta in real-time, then complete TextBlock /
 * ToolUseBlock from accumulated state at the end — same shape as the
 * Anthropic provider so the agent loop can consume both uniformly.
 */

import OpenAI from "openai";

import { toOpenAIMessages } from "../messages/normalize.ts";
import type {
  Message,
  MessageContent,
  StreamEvent,
  StopReason,
  TextBlock,
  ToolUseBlock,
} from "../messages/types.ts";
import { TextDelta } from "../messages/types.ts";
import type { ModelConfig, ModelProvider, ModelResponse } from "./protocol.ts";

// -- Loose wire types --------------------------------------------------------

type Wire = Record<string, any>;
type WireMessage = Wire;

export class OpenAIProvider implements ModelProvider {
  readonly provider_name = "openai";

  private _client(config: ModelConfig): OpenAI {
    const kwargs: ConstructorParameters<typeof OpenAI>[0] = { apiKey: config.api_key };
    if (config.base_url) (kwargs as Wire).baseURL = config.base_url;
    return new OpenAI(kwargs);
  }

  async chat(
    messages: Message[],
    tools: Wire[] | null,
    config: ModelConfig,
  ): Promise<ModelResponse> {
    const client = this._client(config);
    const apiMessages = toOpenAIMessages(messages);
    const body = this._buildRequest(config, apiMessages, tools, false);

    const response: OpenAI.Chat.Completions.ChatCompletion =
      await client.chat.completions.create(body as any);

    const choice = response.choices[0];
    const content = this._parseChoice(choice);
    return {
      content,
      stop_reason: this._mapFinishReason(choice?.finish_reason),
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async *stream(
    messages: Message[],
    tools: Wire[] | null,
    config: ModelConfig,
  ): AsyncIterable<StreamEvent | MessageContent> {
    const client = this._client(config);
    const apiMessages = toOpenAIMessages(messages);
    const body = this._buildRequest(config, apiMessages, tools, true);

    const stream = await client.chat.completions.create(body as any);

    // current_tool: index → { id, name, args }
    const currentTool: Map<number, { id: string; name: string; args: string }> = new Map();
    const textBuffer: string[] = [];

    for await (const chunk of stream as any) {
      if (!chunk.choices?.length) continue;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        textBuffer.push(delta.content);
        yield { type: "text_delta", text: delta.content } satisfies TextDelta;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index;
          if (!currentTool.has(idx)) {
            currentTool.set(idx, { id: "", name: "", args: "" });
          }
          const info = currentTool.get(idx)!;
          if (tc.id) info.id = tc.id;
          if (tc.function?.name) info.name = tc.function.name;
          if (tc.function?.arguments) info.args += tc.function.arguments;
        }
      }
    }

    // Yield complete blocks from accumulated state.
    if (textBuffer.length > 0) {
      yield { type: "text", text: textBuffer.join("") } satisfies TextBlock;
    }
    const indices = [...currentTool.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const info = currentTool.get(idx)!;
      let args: Record<string, unknown>;
      try {
        args = info.args.trim() ? JSON.parse(info.args) : {};
        if (args === null || typeof args !== "object" || Array.isArray(args)) args = {};
      } catch {
        args = {};
      }
      yield {
        type: "tool_use",
        id: info.id,
        name: info.name,
        input: args,
      } satisfies ToolUseBlock;
    }
  }

  // -- helpers --

  private _buildRequest(
    config: ModelConfig,
    messages: WireMessage[],
    tools: Wire[] | null,
    stream: boolean,
  ): Wire {
    const body: Wire = {
      model: config.model,
      messages,
      stream,
    };
    if (!config.thinking) {
      // Non-reasoning models: temperature + top_p + max_tokens.
      if (config.temperature != null) body.temperature = config.temperature;
      if (config.top_p != null) body.top_p = config.top_p;
      body.max_tokens = config.max_tokens;
    } else {
      // o-series reasoning models use max_completion_tokens.
      body.max_completion_tokens = config.max_tokens;
    }
    if (tools) body.tools = tools;
    return body;
  }

  /** Parse an OpenAI completion choice into internal content blocks. */
  private _parseChoice(choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined): MessageContent[] {
    const result: MessageContent[] = [];
    if (!choice) return result;

    const content: string | null = (choice.message as any)?.content ?? null;
    if (content) {
      result.push({ type: "text", text: content } satisfies TextBlock);
    }

    const toolCalls: any[] | undefined = (choice.message as any)?.tool_calls;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const argsStr: string = tc.function?.arguments ?? "{}";
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(argsStr);
          if (args === null || typeof args !== "object" || Array.isArray(args)) args = {};
        } catch {
          args = {};
        }
        result.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name ?? "",
          input: args,
        } satisfies ToolUseBlock);
      }
    }
    return result;
  }

  /** Map OpenAI finish_reason to internal StopReason. Exposed for tests. */
  _mapFinishReason(raw: string | null | undefined): StopReason {
    if (raw === "stop") return "end_turn";
    if (raw === "length" || raw === "max_tokens") return "max_tokens";
    if (raw === "tool_calls") return "tool_use";
    return "end_turn";
  }
}
