/**
 * Unified message types used across all model providers.
 *
 * All model adapters convert their native format to these types so the agent
 * layer only deals with one message representation.
 */

// -- Roles -------------------------------------------------------------------

export type Role = "user" | "assistant" | "system";

export const USER: Role = "user";
export const ASSISTANT: Role = "assistant";
export const SYSTEM: Role = "system";

// -- Content blocks ---------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type MessageContent = TextBlock | ToolUseBlock | ToolResultBlock;

// -- Message ----------------------------------------------------------------

export interface Message {
  role: Role;
  content: MessageContent[];
}

// -- Streaming events -------------------------------------------------------

export interface TextDelta {
  type: "text_delta";
  text: string;
}

export interface ToolUseDelta {
  type: "tool_use_delta";
  id: string;
  /** Only present in the first delta for a given id. */
  name?: string;
  input_delta: Record<string, unknown>;
}

export interface ThinkingDelta {
  type: "thinking_delta";
  text: string;
}

export interface SubAgentStart {
  type: "subagent_start";
  agent_type: string;
  description: string;
}

export interface SubAgentDelta {
  type: "subagent_delta";
  text: string;
}

export interface SubAgentEnd {
  type: "subagent_end";
  agent_type: string;
}

export interface PermissionRequest {
  type: "permission_request";
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** Suggested scope pattern for "don't ask again". */
  scope?: string;
}

export type StreamEvent =
  | TextDelta
  | ToolUseDelta
  | ThinkingDelta
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | SubAgentStart
  | SubAgentDelta
  | SubAgentEnd
  | PermissionRequest;

// -- Stop reason ------------------------------------------------------------

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence";

// -- Wire types -------------------------------------------------------------
// Loose provider-native dict types used by providers and normalizers.

export type WireMessage = Record<string, any>;
export type WireBlock = Record<string, any>;

// -- Type guards ------------------------------------------------------------

export const isTextBlock = (b: MessageContent): b is TextBlock =>
  b.type === "text";

export const isToolUseBlock = (b: MessageContent): b is ToolUseBlock =>
  b.type === "tool_use";

export const isToolResultBlock = (
  b: MessageContent,
): b is ToolResultBlock => b.type === "tool_result";
