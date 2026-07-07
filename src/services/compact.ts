/**
 * Compaction service — summarize old messages to free context window.
 *
 * When the token budget exceeds 80% of the context window, the agent loop
 * calls compactMessages() to replace the oldest messages with a single
 * summary. The system prompt and most recent messages are preserved verbatim.
 */

import type { Message, TextBlock, ToolResultBlock, ToolUseBlock } from "../messages/types.ts";
import type { ModelConfig } from "../models/protocol.ts";
import { QueryEngine } from "../query/engine.ts";

const COMPACT_PROMPT = [
  "Review the conversation history below and produce a concise summary",
  "that preserves all information needed to continue the task:",
  "",
  "- User's original request and goals",
  "- Key decisions made and why",
  "- Files read or modified (with full paths)",
  "- Tool results that informed decisions (brief, not full output)",
  "- Current progress and pending next steps",
  "- Any errors or blockers encountered",
  "",
  "Be specific about file paths, function names, and technical details.",
  "Do NOT include full file contents — reference them by path.",
  "Write the summary as a continuous narrative, not a bullet list of",
  "every message.",
].join("\n");

const KEEP_RECENT = 6; // Must be even to preserve user/assistant pairing.

/** Flatten messages into a readable transcript for summarization. */
function messagesToText(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = (msg.role as string).toUpperCase();
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push(block.text);
      } else if (block.type === "tool_use") {
        parts.push(
          `[tool call: ${block.name}(${JSON.stringify(block.input)})]`,
        );
      } else if (block.type === "tool_result") {
        parts.push(`[tool result: ${block.content.slice(0, 500)}]`);
      }
    }
    const text = parts.join("\n");
    lines.push(`### ${role}\n${text}`);
  }
  return lines.join("\n\n");
}

async function generateSummary(
  queryEngine: QueryEngine,
  model: string,
  config: ModelConfig,
  prompt: string,
): Promise<string> {
  const summaryMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  ];
  let resultText = "";
  for await (const event of queryEngine.stream(
    summaryMessages,
    model,
    null, // no tools — pure text summarization
    config,
  )) {
    if (event.type === "text_delta") {
      resultText += (event as any).text ?? "";
    } else if (event.type === "text") {
      resultText += (event as any).text ?? "";
    }
  }
  return resultText.trim() || "(summary unavailable)";
}

/**
 * Compact message history by summarizing older messages.
 *
 * Returns a new message list:
 * `[system_prompt?, summary_message, *recent_messages]`
 *
 * The system prompt (first message if role=SYSTEM) is always preserved.
 * The most recent `keepRecent` messages are preserved verbatim.
 * Everything in between is sent to the model for summarization.
 */
export async function compactMessages(
  messages: Message[],
  opts: {
    queryEngine: QueryEngine;
    model: string;
    config: ModelConfig;
    keepRecent?: number;
  },
): Promise<Message[]> {
  const keepRecent = opts.keepRecent ?? KEEP_RECENT;
  if (messages.length <= keepRecent + 1) return messages;

  // 1. Separate system prompt (if present).
  let systemMsg: Message | null = null;
  let rest = messages;
  if (messages.length > 0 && messages[0]!.role === "system") {
    systemMsg = messages[0]!;
    rest = messages.slice(1);
  }

  // 2. Split.
  if (rest.length <= keepRecent) return messages;
  const toSummarize = rest.slice(0, -keepRecent);
  const recent = rest.slice(-keepRecent);

  // 3. Build the summarization input.
  const conversationText = messagesToText(toSummarize);
  const prompt = `${COMPACT_PROMPT}\n\n## Conversation to summarize\n\n${conversationText}`;

  const summary = await generateSummary(
    opts.queryEngine,
    opts.model,
    opts.config,
    prompt,
  );

  // 4. Reassemble: [system?, summary, *recent].
  const result: Message[] = [];
  if (systemMsg) result.push(systemMsg);
  result.push({
    role: "user",
    content: [
      { type: "text", text: `## Conversation summary\n\n${summary}` },
    ],
  });
  result.push(...recent);
  return result;
}
