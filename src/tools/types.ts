/**
 * Tool protocol — every capability implements this interface.
 *
 * Uses a `buildTool()` factory (plain object + Zod) instead of classes or
 * decorators, matching the claude-code pattern. Zod schemas give both
 * runtime validation and JSON Schema generation for the LLM.
 */

import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// -- ToolResult --------------------------------------------------------------

export interface ToolResult {
  output: string;
  error?: string | null;
  metadata?: Record<string, unknown>;
  /** Write to file if exceeded. */
  max_result_size_chars?: number | null;
}

export function makeToolResult(init: Partial<ToolResult> & { output: string }): ToolResult {
  return {
    error: null,
    metadata: {},
    max_result_size_chars: null,
    ...init,
  };
}

// -- ToolContext -------------------------------------------------------------

export interface ToolContext {
  working_dir: string;
  env?: Record<string, string>;
  session_id?: string;
  available_skills?: Record<string, string>;
  /** File path → mtime for recently read files. Used for stale-write detection. */
  read_cache: Record<string, number>;
  /** Optional callback for subagent events. Set by AgentLoop before calling the agent tool. */
  event_callback?: ((event: unknown) => void) | null;
  /** Pending background-agent results (populated by the agent tool). */
  _pending_background?: Array<{ description: string; result: string }>;
}

export function makeToolContext(init: Partial<ToolContext> & { working_dir: string }): ToolContext {
  return {
    env: {},
    session_id: "",
    available_skills: {},
    read_cache: {},
    event_callback: null,
    ...init,
  };
}

// -- Tool interface ----------------------------------------------------------

export interface Tool {
  name: string;
  description: string;
  search_hint: string;
  /** Return the JSON Schema for this tool's input parameters. */
  inputSchema(): Record<string, unknown>;
  /** Execute the tool with the given input and context. */
  call(input: unknown, context: ToolContext): Promise<ToolResult>;
  /** Whether this tool is currently available. */
  isEnabled(): boolean;
  /** Whether this specific invocation is read-only. */
  isReadOnly(input?: unknown): boolean;
  /** Whether this specific invocation is destructive. */
  isDestructive(input?: unknown): boolean;
  /** Format the tool result for display. */
  renderResult(result: ToolResult): string;
  /** Short description shown in the spinner. */
  activityDescription(input?: unknown): string;
}

// -- ToolDef (input to buildTool) -------------------------------------------

export interface ToolDef<I> {
  name: string;
  description: string;
  search_hint: string;
  inputSchema: z.ZodType<I>;
  call(input: I, context: ToolContext): Promise<string | ToolResult>;
  is_read_only?: boolean;
  is_destructive?: boolean;
  /** Dynamic read-only check based on input. */
  is_read_only_fn?: (input: I) => boolean;
  /** Dynamic destructive check based on input. */
  is_destructive_fn?: (input: I) => boolean;
  /** Whether this tool is enabled (default true). */
  is_enabled?: boolean;
}

// -- buildTool ---------------------------------------------------------------

/** Build a Tool from a ToolDef, filling in defaults. */
export function buildTool<I>(def: ToolDef<I>): Tool {
  const readOnly = def.is_read_only ?? false;
  const destructive = def.is_destructive ?? false;
  const enabled = def.is_enabled ?? true;

  return {
    name: def.name,
    description: def.description,
    search_hint: def.search_hint,

    inputSchema(): Record<string, unknown> {
      const schema = zodToJsonSchema(def.inputSchema, { target: "openApi3" });
      return schema as Record<string, unknown>;
    },

    async call(input: unknown, context: ToolContext): Promise<ToolResult> {
      // Validate + coerce input through Zod schema.
      const parsed = def.inputSchema.parse(input);
      const result = await def.call(parsed as I, context);
      if (typeof result === "string") {
        return makeToolResult({ output: result });
      }
      return result;
    },

    isEnabled(): boolean {
      return enabled;
    },

    isReadOnly(input?: unknown): boolean {
      if (def.is_read_only_fn && input != null) {
        try {
          return def.is_read_only_fn(def.inputSchema.parse(input) as I);
        } catch {
          return readOnly;
        }
      }
      return readOnly;
    },

    isDestructive(input?: unknown): boolean {
      if (def.is_destructive_fn && input != null) {
        try {
          return def.is_destructive_fn(def.inputSchema.parse(input) as I);
        } catch {
          return destructive;
        }
      }
      return destructive;
    },

    renderResult(result: ToolResult): string {
      return result.output;
    },

    activityDescription(_input?: unknown): string {
      return `${def.name}...`;
    },
  };
}
