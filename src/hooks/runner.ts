/**
 * Hook runner — executes shell-command lifecycle hooks.
 *
 * PreToolUse hooks run before every tool call and can block or allow.
 * PostToolUse hooks run after tool execution (advisory, fire-and-forget).
 *
 * Hook contract mirrors src/wings/hooks/runner.py:
 *   - The hook receives a JSON object on **stdin**:
 *       {"tool_name": "...", "tool_input": {...}, "tool_result": "..."}
 *   - Exit code 2 => deny (stderr || stdout used as the reason).
 *   - Otherwise, if stdout starts with `{`, it is parsed as JSON:
 *       {"decision": "allow"|"deny", "reason": "..."}
 *   - Anything else (incl. exit 0 with non-JSON output) => allow.
 *   - Matching PreToolUse hooks run **in parallel**; any deny wins.
 *
 * Configured via config.json `hooks` field:
 *   "hooks": {
 *     "PreToolUse": [{"command": "my-hook.sh", "matcher": "^bash$", "timeout": 30000}],
 *     "PostToolUse": [{"command": "my-hook.sh"}]
 *   }
 * `matcher` is a regex matched against the tool name (omitted = match all).
 */

import { spawn } from "node:child_process";
import type { PermissionResult } from "../permissions/rules.ts";
import type { HookRunner as HookRunnerProtocol } from "../permissions/pipeline.ts";

interface HookConfig {
  command: string;
  /** Regex matched against the tool name; undefined = match all tools. */
  matcher?: string;
  /** Per-hook timeout in ms (default 30000). */
  timeout?: number;
}

interface HookExecResult {
  decision: "allow" | "deny";
  reason: string;
}

function serialiseInput(input: unknown): unknown {
  // Tool inputs arrive as plain objects (zod-coerced in the tool layer),
  // so no model-dump step is needed — unlike Python's pydantic path.
  if (input && typeof input === "object") return input;
  return String(input);
}

function runCommand(
  command: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<HookExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [], { shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ decision: "allow", reason: `hook timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ decision: "allow", reason: `hook error: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      const err = stderr.trim();

      // Exit code 2 = block.
      if (code === 2) {
        resolve({ decision: "deny", reason: err || out });
        return;
      }

      // JSON response for decision.
      if (out.startsWith("{")) {
        try {
          const data = JSON.parse(out) as Record<string, unknown>;
          const decision = (data["decision"] as string) ?? "allow";
          if (decision === "allow" || decision === "deny") {
            resolve({
              decision,
              reason: (data["reason"] as string) ?? "",
            });
            return;
          }
        } catch {
          // Malformed JSON falls through to allow.
        }
      }

      resolve({ decision: "allow", reason: "" });
    });

    // Feed the JSON payload to the hook's stdin. Hooks that don't read stdin
    // (e.g. `true`, `exit 2`) will close it; ignore the resulting EPIPE.
    child.stdin?.on("error", () => {});
    const inputJson = JSON.stringify(payload);
    try {
      child.stdin?.end(inputJson);
    } catch {
      // best-effort
    }
  });
}

export class HookRunner implements HookRunnerProtocol {
  private _preHooks: HookConfig[] = [];
  private _postHooks: HookConfig[] = [];

  constructor(hooks: Record<string, Array<Record<string, unknown>>> = {}) {
    this._preHooks = (hooks["PreToolUse"] ?? []).map(parseHookConfig);
    this._postHooks = (hooks["PostToolUse"] ?? []).map(parseHookConfig);
  }

  /** Whether any hooks are configured. */
  hasHooks(): boolean {
    return this._preHooks.length > 0 || this._postHooks.length > 0;
  }

  async runPreToolUse(
    toolName: string,
    toolInput: unknown,
  ): Promise<PermissionResult | null> {
    const matching = this._matching(this._preHooks, toolName);
    if (matching.length === 0) return null;

    const payload = { tool_name: toolName, tool_input: serialiseInput(toolInput) };
    // Run all matching hooks in parallel; any deny wins (mirrors Python's
    // asyncio.gather + first-deny aggregation).
    const results = await Promise.all(
      matching.map((h) =>
        runCommand(h.command, payload, h.timeout ?? 30_000)
      ),
    );
    for (const r of results) {
      if (r.decision === "deny") return "deny";
    }
    return "allow";
  }

  async runPostToolUse(
    toolName: string,
    toolInput: unknown,
    toolResult: string,
  ): Promise<void> {
    const matching = this._matching(this._postHooks, toolName);
    if (matching.length === 0) return;

    const payload = {
      tool_name: toolName,
      tool_input: serialiseInput(toolInput),
      tool_result: toolResult,
    };
    // Fire-and-forget, but still run in parallel and swallow errors.
    await Promise.all(
      matching.map((h) =>
        runCommand(h.command, payload, h.timeout ?? 30_000).catch(() => undefined),
      ),
    );
  }

  private _matching(hooks: HookConfig[], toolName: string): HookConfig[] {
    return hooks.filter((h) => h.matcher === undefined || new RegExp(h.matcher).test(toolName));
  }
}

function parseHookConfig(raw: Record<string, unknown>): HookConfig {
  const cfg: HookConfig = {
    command: (raw["command"] as string) ?? "",
  };
  if (typeof raw["matcher"] === "string") cfg.matcher = raw["matcher"];
  if (typeof raw["timeout"] === "number") cfg.timeout = raw["timeout"];
  return cfg;
}
