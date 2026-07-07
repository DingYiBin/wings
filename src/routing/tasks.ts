/**
 * Task type hierarchy — used by the pool manager to resolve mask inheritance.
 *
 * Not listed here:
 *   - "skill/<name>" → resolve_parent returns "subagent/skill"
 *   - other unknown → resolve_parent returns null (root type)
 */

export const TASK_HIERARCHY: Record<string, string | null> = {
  main: null,
  subagent: null,
  continuous: null,
  background: null,
  "subagent/explore": "subagent",
  "subagent/plan": "subagent",
  "subagent/general": "subagent",
  "subagent/compact": "subagent",
  "subagent/memory": "subagent",
  "subagent/skill": "subagent",
  "subagent/meta": "subagent",
  "subagent/classify": "subagent",
  "subagent/code": "subagent",
  "continuous/cron": "continuous",
  "continuous/monitor": "continuous",
  "continuous/heartbeat": "continuous",
  "background/dream": "continuous",
  "background/title": "continuous",
  "background/compact": "continuous",
  "background/flush": "continuous",
};

/** Resolve the parent task type.
 *
 * Lookup order: static TASK_HIERARCHY → skill/* prefix → unknown → null.
 */
export function resolveParent(taskType: string): string | null {
  if (taskType in TASK_HIERARCHY) return TASK_HIERARCHY[taskType]!;
  if (taskType.startsWith("skill/")) return "subagent/skill";
  return null;
}
