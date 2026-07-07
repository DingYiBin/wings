/**
 * Multi-stage permission pipeline for tool execution.
 *
 * Request → static rules → auto-classify → hooks → interactive approval
 */

import type { Tool, ToolContext } from "../tools/types.ts";
import type { PermissionResult } from "./rules.ts";
import type { PermissionRules } from "./rules.ts";

/** Protocol for running pre-tool-use hooks. */
export interface HookRunner {
  /** Run the hook. Return a decision or null to pass. */
  runPreToolUse(toolName: string, toolInput: unknown): Promise<PermissionResult | null>;
  /** Run post-tool-use hooks (fire-and-forget). Optional. */
  runPostToolUse?(toolName: string, toolInput: unknown, toolResult: string): Promise<void>;
}

/**
 * Four-stage permission check for tool execution.
 *
 * Stage 1: static rules (allowlist/denylist)
 * Stage 1b: scoped rules (input-level)
 * Stage 2: auto-classify (read-only → allow, destructive → passthrough)
 * Stage 3: hooks (user-configured shell scripts)
 * Stage 4: interactive approval (return "ask" for the UI to handle)
 */
export class PermissionPipeline {
  private _hookRunner: HookRunner | null;

  constructor(
    private _rules: PermissionRules,
    hookRunner: HookRunner | null = null,
  ) {
    this._hookRunner = hookRunner;
  }

  /** Run the full permission pipeline.
   * Returns "allow", "deny", or "ask" (for interactive approval).
   */
  async check(
    tool: Tool,
    toolInput: unknown,
    _context: ToolContext,
  ): Promise<PermissionResult> {
    // Stage 1: static rules (tool-level)
    const result = this._rules.match(tool.name);
    if (result !== "ask") return result;

    // Stage 1b: scoped rules (input-level)
    if (toolInput && typeof toolInput === "object") {
      const scoped = this._rules.checkScoped(tool.name, toolInput as Record<string, unknown>);
      if (scoped !== null) return scoped;
    }

    // Stage 2: auto-classify (read-only operations are safe)
    if (tool.isReadOnly(toolInput)) return "allow";

    // Stage 3: hooks
    if (this._hookRunner) {
      const hookResult = await this._hookRunner.runPreToolUse(tool.name, toolInput);
      if (hookResult !== null) return hookResult;
    }

    // Stage 4: interactive approval
    return "ask";
  }

  /** Run post-tool-use hooks (fire-and-forget). */
  async runPostToolUse(
    toolName: string,
    toolInput: unknown,
    toolResult: string,
  ): Promise<void> {
    if (this._hookRunner?.runPostToolUse) {
      await this._hookRunner.runPostToolUse(toolName, toolInput, toolResult);
    }
  }
}
