/**
 * Convert between internal Message types and provider-specific formats.
 *
 * Each provider speaks a different wire format for tool calls, tool results,
 * and content blocks. The normalizer maps all of them to the single internal
 * Message representation so the agent loop never deals with provider quirks.
 */

import type { Message, MessageContent, Role, WireBlock, WireMessage } from "./types.ts";
import { TextBlock, ToolResultBlock, ToolUseBlock } from "./types.ts";

// -- Anthropic ---------------------------------------------------------------

/** Convert a single Anthropic API message dict to internal format. */
export function fromAnthropic(raw: WireMessage): Message {
  const role = raw["role"] as Role;
  let rawContent: WireBlock[] | string = raw["content"] ?? [];
  if (typeof rawContent === "string") {
    rawContent = [{ type: "text", text: rawContent }];
  }

  const content: MessageContent[] = [];
  for (const block of rawContent as WireBlock[]) {
    const blockType: string = block["type"] ?? "text";
    if (blockType === "text") {
      content.push({ type: "text", text: block["text"] } satisfies TextBlock);
    } else if (blockType === "tool_use") {
      content.push({
        type: "tool_use",
        id: block["id"],
        name: block["name"],
        input: block["input"] ?? {},
      } satisfies ToolUseBlock);
    } else if (blockType === "tool_result") {
      const rc = block["content"] ?? "";
      let text: string;
      if (Array.isArray(rc)) {
        // Flatten: concatenate text from text blocks.
        text = "";
        for (const b of rc) {
          if (typeof b === "object" && b !== null && b["type"] === "text") {
            text += b["text"];
          }
        }
      } else {
        text = String(rc);
      }
      content.push({
        type: "tool_result",
        tool_use_id: block["tool_use_id"],
        content: text,
        is_error: block["is_error"] ?? false,
      } satisfies ToolResultBlock);
    }
  }

  return { role, content };
}

/** Convert an internal Message to Anthropic API format. */
export function toAnthropic(message: Message): WireMessage {
  const blocks: WireBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
    } else if (block.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error ?? false,
      });
    }
  }
  return { role: message.role, content: blocks };
}

// -- OpenAI ------------------------------------------------------------------

/** Convert a single OpenAI API message dict to internal format. */
export function fromOpenAI(raw: WireMessage): Message {
  const rawRole: string = raw["role"];
  const role: Role = rawRole === "tool" ? "user" : (rawRole as Role);

  const content: MessageContent[] = [];
  const rawContent = raw["content"];

  // Tool results — role="tool" messages carry tool output only.
  if (rawRole === "tool") {
    content.push({
      type: "tool_result",
      tool_use_id: raw["tool_call_id"],
      content: String(rawContent ?? ""),
    } satisfies ToolResultBlock);
    return { role, content };
  }

  // OpenAI text content: string, or list of content parts.
  if (rawContent !== undefined && rawContent !== null) {
    if (typeof rawContent === "string") {
      if (rawContent.trim()) {
        content.push({ type: "text", text: rawContent } satisfies TextBlock);
      }
    } else if (Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (
          typeof part === "object" &&
          part !== null &&
          part["type"] === "text"
        ) {
          content.push({ type: "text", text: part["text"] } satisfies TextBlock);
        }
      }
    }
  }

  // Tool calls.
  const toolCalls: WireBlock[] = raw["tool_calls"] ?? [];
  for (const tc of toolCalls) {
    const fn = tc["function"] ?? {};
    const argsStr = fn["arguments"] ?? "{}";
    let args: Record<string, unknown>;
    try {
      args =
        typeof argsStr === "string" ? JSON.parse(argsStr) : argsStr;
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        args = {};
      }
    } catch {
      args = {};
    }
    content.push({
      type: "tool_use",
      id: tc["id"],
      name: fn["name"] ?? "",
      input: args,
    } satisfies ToolUseBlock);
  }

  return { role, content };
}

/** Convert an internal Message to a single OpenAI API message dict.
 *
 * For tool-result-only user messages, returns a `role="tool"` dict.
 * For assistant messages with tool calls, includes `tool_calls`.
 */
export function toOpenAI(message: Message): WireMessage {
  const toolCalls: WireBlock[] = [];
  const toolResults: WireBlock[] = [];
  const textParts: string[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    } else if (block.type === "tool_result") {
      toolResults.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: block.content,
      });
    }
  }

  if (message.role === "user" && toolResults.length > 0) {
    return toolResults[0]!;
  }

  if (toolCalls.length > 0) {
    const result: WireMessage = {
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("\n") : null,
      tool_calls: toolCalls,
    };
    if (result["content"] === null) delete result["content"];
    return result;
  }

  return {
    role: message.role,
    content: textParts.length > 0 ? textParts.join("\n") : "",
  };
}

/** Convert a sequence of internal Messages to a flat list of OpenAI API
 * message dicts.
 *
 * Handles the case where a single internal message with multiple tool_use
 * blocks needs to produce one assistant message with multiple tool_calls
 * entries, and each tool_result produces its own role="tool" message.
 */
export function toOpenAIMessages(messages: Message[]): WireMessage[] {
  const result: WireMessage[] = [];
  for (const msg of messages) {
    const toolResults: WireBlock[] = [];
    const textParts: string[] = [];
    const toolCalls: WireBlock[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      } else if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.content,
        });
      }
    }

    if (toolResults.length > 0) result.push(...toolResults);
    if (textParts.length > 0 || toolCalls.length > 0) {
      const r: WireMessage = { role: msg.role };
      if (toolCalls.length > 0) {
        r["tool_calls"] = toolCalls;
        if (textParts.length > 0) r["content"] = textParts.join("\n");
      } else {
        r["content"] = textParts.length > 0 ? textParts.join("\n") : "";
      }
      result.push(r);
    }
  }
  return result;
}

// -- MessageNormalizer (dispatcher) -----------------------------------------

type FromFn = (raw: WireMessage) => Message;
type ToFn = (msg: Message) => WireMessage;
type ToMessagesFn = (msgs: Message[]) => WireMessage[];

export class MessageNormalizer {
  private _from: Record<string, FromFn> = {};
  private _to: Record<string, ToFn> = {};
  private _toMessages: Record<string, ToMessagesFn> = {};

  register(
    provider: string,
    fromFn: FromFn,
    toFn: ToFn,
    toMessagesFn?: ToMessagesFn,
  ): void {
    this._from[provider] = fromFn;
    this._to[provider] = toFn;
    if (toMessagesFn) this._toMessages[provider] = toMessagesFn;
  }

  toInternal(provider: string, rawMessages: WireMessage[]): Message[] {
    const converter = this._from[provider];
    if (!converter) throw new Error(`unsupported provider: ${JSON.stringify(provider)}`);
    return rawMessages.map((r) => converter(r));
  }

  toProvider(provider: string, messages: Message[]): WireMessage[] {
    const multi = this._toMessages[provider];
    if (multi) return multi(messages);
    const converter = this._to[provider];
    if (!converter) throw new Error(`unsupported provider: ${JSON.stringify(provider)}`);
    return messages.map((m) => converter(m));
  }
}

/** Default singleton — all callers get the same instance. */
export const normalizer = new MessageNormalizer();

normalizer.register("anthropic", fromAnthropic, toAnthropic);
normalizer.register("openai", fromOpenAI, toOpenAI, toOpenAIMessages);
