/** Softmax-based API selection from global pool + score masks. */

import type { PoolEntry } from "./types.ts";

export const NEG_INF = -Infinity;

export class NoAPIAvailable extends Error {
  constructor(message: string = "no API available") {
    super(message);
    this.name = "NoAPIAvailable";
  }
}

/** Select an API via softmax over effective scores.
 *
 * effective_score[api] = base_score + mask_delta
 * mask_delta of -Infinity = disabled for this task type.
 *
 * Returns the selected api_id. Throws NoAPIAvailable if all APIs are disabled.
 */
export function softmaxSelect(
  entries: PoolEntry[],
  mask: Record<string, number> | null = null,
): string {
  const adjustments = mask ?? {};

  // Compute effective scores.
  const effective: Record<string, number> = {};
  for (const e of entries) {
    const delta = adjustments[e.api_id] ?? 0;
    effective[e.api_id] = e.score + delta;
  }

  // Filter out -Infinity (disabled).
  const activeEntries = (Object.entries(effective) as Array<[string, number]>)
    .filter(([, v]) => v !== NEG_INF);

  if (activeEntries.length === 0) {
    throw new NoAPIAvailable("all APIs disabled for this task type");
  }

  // Softmax with numerical stability (subtract max).
  const maxScore = Math.max(...activeEntries.map(([, v]) => v));
  const exps: Array<[string, number]> = activeEntries.map(([k, v]) => [
    k,
    Math.exp(v - maxScore),
  ]);
  const total = exps.reduce((sum, [, e]) => sum + e, 0);

  // Weighted random selection.
  const r = Math.random() * total;
  let cumulative = 0;
  for (const [apiId, expVal] of exps) {
    cumulative += expVal;
    if (r <= cumulative) return apiId;
  }
  // Float rounding fallback.
  return activeEntries[activeEntries.length - 1]![0];
}
