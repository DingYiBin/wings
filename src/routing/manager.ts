/** API pool manager — global pool + per-task-type score masks.
 *
 * Each agent, skill, etc. manages a score mask over the global pool.
 * An API can be disabled (-Infinity), promoted (+delta), or demoted (-delta).
 * Selection uses softmax(effective_scores).
 *
 * No locks needed: JS is single-threaded.
 */

import type { ModelSelector } from "./protocol.ts";
import type { PoolConfig, PoolEntry } from "./types.ts";
import { NEG_INF, NoAPIAvailable, softmaxSelect } from "./selector.ts";
import { resolveParent } from "./tasks.ts";

export class APIPoolManager implements ModelSelector {
  /** api_id → PoolEntry (global). */
  private _entries: Map<string, PoolEntry> = new Map();
  /** task_type → {api_id → delta}. */
  private _masks: Map<string, Map<string, number>> = new Map();

  constructor(config?: PoolConfig) {
    if (config) this.replaceConfig(config);
  }

  // -- Selection (implements ModelSelector) --

  select(taskType: string, override?: string | null): string {
    if (override) return override;
    const mask = this._resolveMask(taskType);
    const entries = [...this._entries.values()];
    if (entries.length === 0) {
      throw new NoAPIAvailable("no APIs in global pool");
    }
    return softmaxSelect(entries, mask);
  }

  // -- Registration --

  /** Add an API to the global pool. Does NOT touch masks (effectively
   * available to all task types at base score). */
  registerApi(apiId: string, opts: { score?: number } = {}): void {
    this._entries.set(apiId, { api_id: apiId, score: opts.score ?? 0 });
  }

  /** Remove an API from the global pool and all masks. */
  unregisterApi(apiId: string): void {
    this._entries.delete(apiId);
    for (const mask of this._masks.values()) mask.delete(apiId);
  }

  // -- Score adjustments (per task type) --

  private _ensureMask(taskType: string): Map<string, number> {
    let m = this._masks.get(taskType);
    if (!m) {
      m = new Map();
      this._masks.set(taskType, m);
    }
    return m;
  }

  /** Set the score adjustment for an API in a task type's mask. */
  adjustScore(taskType: string, apiId: string, score: number): void {
    this._ensureMask(taskType).set(apiId, score);
  }

  /** Set the base score of an API (affects all task types). */
  adjustBaseScore(apiId: string, score: number): void {
    const entry = this._entries.get(apiId);
    if (!entry) throw new Error(`Unknown api_id: ${apiId}`);
    entry.score = score;
  }

  /** Increase an API's score adjustment for a task type. */
  upvote(taskType: string, apiId: string, delta: number = 0.5): void {
    const mask = this._ensureMask(taskType);
    mask.set(apiId, (mask.get(apiId) ?? 0) + delta);
  }

  /** Decrease an API's score adjustment for a task type. */
  downvote(taskType: string, apiId: string, delta: number = 0.5): void {
    const mask = this._ensureMask(taskType);
    mask.set(apiId, (mask.get(apiId) ?? 0) - delta);
  }

  /** Disable an API for a task type (mask delta = -Infinity). */
  disable(taskType: string, apiId: string): void {
    this._ensureMask(taskType).set(apiId, NEG_INF);
  }

  /** Re-enable a previously disabled API (remove mask entry). */
  enable(taskType: string, apiId: string): void {
    const mask = this._masks.get(taskType);
    if (mask) mask.delete(apiId);
  }

  // -- Pool fork --

  /** Copy another task type's mask as a starting point. */
  forkMask(taskType: string, fromTask: string): void {
    const source = this._masks.get(fromTask) ?? new Map();
    this._masks.set(
      taskType,
      new Map(source.entries()),
    );
  }

  // -- Query --

  /** Return effective scores for a task type: api_id → {base, delta, effective}. */
  getPoolInfo(taskType: string): Record<
    string,
    { base: number; delta: number; effective: number }
  > {
    const mask = this._resolveMask(taskType);
    const result: Record<string, { base: number; delta: number; effective: number }> = {};
    for (const [apiId, entry] of this._entries) {
      const delta = mask[apiId] ?? 0;
      result[apiId] = {
        base: entry.score,
        delta,
        effective: entry.score + delta,
      };
    }
    return result;
  }

  /** List all APIs in the global pool. */
  listApis(): string[] {
    return [...this._entries.keys()].sort();
  }

  /** Get the effective mask for a task type (resolved via inheritance). */
  getMask(taskType: string): Record<string, number> {
    return this._resolveMask(taskType);
  }

  /** List task types that have explicit masks. */
  listTaskTypes(): string[] {
    return [...this._masks.keys()].sort();
  }

  // -- Persistence --

  /** Export global pool + masks to PoolConfig. */
  toConfig(): PoolConfig {
    return {
      version: 2,
      apis: [...this._entries.values()].map((e) => ({ ...e })),
      masks: Object.fromEntries(
        [...this._masks.entries()]
          .filter(([, m]) => m.size > 0)
          .map(([tt, m]) => [tt, Object.fromEntries(m)] as const),
      ),
    };
  }

  /** Replace state from a loaded PoolConfig. */
  replaceConfig(config: PoolConfig): void {
    this._entries.clear();
    this._masks.clear();
    for (const entry of config.apis) {
      this._entries.set(entry.api_id, { ...entry });
    }
    for (const [taskType, adjustments] of Object.entries(config.masks)) {
      this._masks.set(taskType, new Map(Object.entries(adjustments)));
    }
  }

  // -- Internal --

  /** Resolve mask via inheritance chain. Falls back to parent masks. */
  private _resolveMask(taskType: string): Record<string, number> {
    let current: string | null = taskType;
    const resolved: Record<string, number> = {};
    while (current !== null) {
      const mask = this._masks.get(current);
      if (mask) {
        for (const [apiId, delta] of mask) {
          if (!(apiId in resolved)) resolved[apiId] = delta;
        }
      }
      current = resolveParent(current);
    }
    return resolved;
  }
}
