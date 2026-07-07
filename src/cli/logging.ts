/**
 * Request/response logger — writes session transcripts to .wings/logs/.
 *
 * Ported from src/wings/cli/logging.py.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class TurnLogger {
  private _dir: string;
  private _path: string;
  private _buffer: Array<Record<string, unknown>> = [];
  private _cycleCount = 0;
  private _sessionStart: number;

  constructor(workingDir: string) {
    this._dir = join(workingDir, ".wings", "logs");
    mkdirSync(this._dir, { recursive: true });
    this._path = this._makePath();
    this._sessionStart = Date.now();
  }

  private _makePath(): string {
    const now = new Date();
    const ts = now.toISOString().replace(/[T:]/g, "-").replace(/\..+/, "");
    const raw = `${ts}-${Date.now()}`;
    const h = createHash("sha256").update(raw).digest("hex").slice(0, 8);
    return join(this._dir, `${ts}_${h}.log`);
  }

  get path(): string {
    return this._path;
  }

  recordCycle(opts: {
    model: string;
    context?: string;
    message_count?: number;
    input_summary?: string;
    response: Record<string, unknown>;
    system_prompt?: string;
    tool_calls?: string[];
    tool_results?: string[];
    thinking?: string | null;
  }): void {
    this._cycleCount++;
    const [providerName, , serviceModel] = opts.model.split("/");
    const elapsed = ((Date.now() - this._sessionStart) / 1000).toFixed(3);

    const entry: Record<string, unknown> = {
      cycle: this._cycleCount,
      context: opts.context ?? "main",
      timestamp: new Date().toISOString(),
      elapsed_s: elapsed,
      provider: providerName ?? "",
      service_model: serviceModel ?? opts.model,
      api_id: opts.model,
      message_count: opts.message_count ?? 0,
      input: opts.input_summary ?? "",
      response: opts.response,
      tool_calls: opts.tool_calls ?? [],
    };
    if (opts.system_prompt) entry["system_prompt"] = opts.system_prompt;
    if (opts.tool_results) entry["tool_results"] = opts.tool_results;
    if (opts.thinking) entry["thinking"] = opts.thinking;

    this._buffer.push(entry);
    this._flush();
  }

  private _flush(): void {
    const lines = this._buffer.map((e) => JSON.stringify(e));
    writeFileSync(this._path, lines.join("\n") + "\n");
  }
}
