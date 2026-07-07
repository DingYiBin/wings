/**
 * Hook runner — executes shell-command lifecycle hooks.
 *
 * PreToolUse hooks run before every tool call and can block or transform.
 * PostToolUse hooks run after tool execution (advisory only).
 *
 * Configured via config.json `hooks` field:
 *   "hooks": {
 *     "PreToolUse": [{"command": "my-hook.sh", "timeout": 5000}],
 *     "PostToolUse": [{"command": "my-hook.sh"}]
 *   }
 */

import { spawn } from "node:child_process";
import type { PermissionResult } from "../permissions/rules.ts";
import type { PreToolUseResult } from "./types.ts";
import type { HookRunner as HookRunnerProtocol } from "../permissions/pipeline.ts";

interface HookConfig {
  command: string;
  timeout?: number;
}

function runCommand(
  command: string,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: true,
      env: {
        ...process.env,
        WINGS_TOOL_NAME: input["tool_name"] as string ?? "",
        WINGS_TOOL_INPUT: JSON.stringify(input),
      },
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.stdout?.on("data", (d) => { output += d; });
    child.stderr?.on("data", (d) => { output += d; });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output.trim() || null);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export class HookRunner implements HookRunnerProtocol {
  private _preHooks: HookConfig[] = [];
  private _postHooks: HookConfig[] = [];

  constructor(hooks: Record<string, Array<Record<string, unknown>>> = {}) {
    this._preHooks = (hooks["PreToolUse"] ?? []).map(parseHookConfig);
    this._postHooks = (hooks["PostToolUse"] ?? []).map(parseHookConfig);
  }

  async runPreToolUse(
    toolName: string,
    toolInput: unknown,
  ): Promise<PermissionResult | null> {
    if (this._preHooks.length === 0) return null;
    const input = { tool_name: toolName, tool_input: toolInput };
    for (const hook of this._preHooks) {
      const output = await runCommand(hook.command, input as Record<string, unknown>, hook.timeout ?? 5000);
      if (output === null) continue;
      const line = output.split("\n")[0]?.trim().toLowerCase();
      if (line === "allow") return "allow";
      if (line === "deny") return "deny";
    }
    return null;
  }

  async runPostToolUse(
    toolName: string,
    toolInput: unknown,
    toolResult: string,
  ): Promise<void> {
    if (this._postHooks.length === 0) return;
    const input = { tool_name: toolName, tool_input: toolInput, tool_result: toolResult };
    for (const hook of this._postHooks) {
      await runCommand(hook.command, input as Record<string, unknown>, hook.timeout ?? 5000);
    }
  }
}

function parseHookConfig(raw: Record<string, unknown>): HookConfig {
  return {
    command: raw["command"] as string ?? "",
    timeout: raw["timeout"] as number | undefined,
  };
}
