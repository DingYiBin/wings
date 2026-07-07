/** Execute shell commands. */

import { spawn } from "node:child_process";

import { z } from "zod";

import { buildTool } from "../types.ts";

// Commands/patterns that are always denied
const DENY_PATTERNS: RegExp[] = [
  /:\s*\(\s*\)\s*\{/, // Fork bomb
  /\bmkfs\./, // Format/wipe disk
  /\bdd\s+if=/, // Direct disk write
  /\bchmod\s+.*-R\s+777\s+\//, // Recursive chmod 777 on root
  />\s*\/dev\/sd[a-z]/, // Overwrite disk
  /\(\)\s*\{.*:.*\|.*:.*&.*\}/, // Fork bomb variants
];

function isSleepCommand(cmd: string): boolean | null {
  const trimmed = cmd.trim();
  let m = /^sleep\s+(\d+)/.exec(trimmed);
  if (m) return parseInt(m[1]!, 10) >= 2;
  m = /^sleep\s+(\d+\.?\d*)/.exec(trimmed);
  if (m) return parseFloat(m[1]!) >= 2.0;
  return null;
}

function checkDenylist(cmd: string): string | null {
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(cmd)) {
      return `Error: command denied by security policy (matched: ${pattern.source})`;
    }
  }
  return null;
}

interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
}

function runShell(cmd: string, cwd: string, env: Record<string, string> | undefined, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut });
    });
  });
}

export const bashTool = buildTool({
  name: "bash",
  description: "Execute a shell command in the current working directory",
  search_hint: "bash 'command'",
  is_destructive: true,
  inputSchema: z.object({
    command: z.string().describe("The shell command to execute"),
    description: z.string().optional().describe("Short description of what this command does (shown to the user)"),
    timeout: z.number().optional().describe("Timeout in milliseconds (max 600000)"),
  }),
  async call(input: BashInput, context) {
    const cmd = input.command;

    // Security checks
    const denyError = checkDenylist(cmd);
    if (denyError) return denyError;

    // Block sleep
    const isSleep = isSleepCommand(cmd);
    if (isSleep) {
      return "Error: sleep is not allowed. Use a non-blocking approach instead.";
    }

    const timeoutMs = Math.min(input.timeout ?? 120000, 600000);
    const started = Date.now();
    const { stdout, stderr, code, timedOut } = await runShell(
      cmd,
      context.working_dir,
      context.env,
      timeoutMs,
    );

    if (timedOut) {
      const elapsed = (Date.now() - started) / 1000;
      return `(timeout ${timeoutMs / 1000}s)  (${elapsed.toFixed(1)}s)`;
    }

    const elapsed = (Date.now() - started) / 1000;
    const elapsedStr = elapsed >= 0.5 ? `(${elapsed.toFixed(1)}s)` : "";

    const parts: string[] = [];
    if (stdout.trim()) parts.push(stdout.trimEnd());
    if (stderr.trim()) parts.push(stderr.trimEnd());

    let output = parts.join("\n").trim();
    if (!output && code === 0) {
      return elapsed < 0.5 ? "(No output)" : `(No output)  ${elapsedStr}`;
    }
    if (!output) output = "(No output)";

    if (code !== 0) {
      output += `\n[exit code: ${code}]`;
    }
    if (elapsedStr) {
      output += `\n${elapsedStr}`;
    }
    return output;
  },
});
