/**
 * Pure data structures for the API candidate pool (v2).
 *
 * Global pool: every known API has a base score (default 0).
 * Score masks: each task type adjusts scores over the global pool.
 * Selection: softmax(effective_scores) → weighted random pick.
 */

export interface PoolEntry {
  /** e.g. "anthropic/claude-opus-4-6" */
  api_id: string;
  /** Base score (default 0, -Infinity = globally disabled). */
  score: number;
}

export interface ScoreMask {
  /** api_id → score delta. -Infinity = disabled for this task type. Absent = 0. */
  adjustments: Record<string, number>;
}

export interface PoolConfig {
  version: 2;
  /** Global pool. */
  apis: PoolEntry[];
  /** task_type → {api_id → delta}. */
  masks: Record<string, Record<string, number>>;
}

export function makePoolConfig(
  init: Partial<PoolConfig> = {},
): PoolConfig {
  return {
    version: 2,
    apis: init.apis ?? [],
    masks: init.masks ?? {},
  };
}
