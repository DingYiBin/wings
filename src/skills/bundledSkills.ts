/**
 * Bundled skills — TypeScript-hardcoded skills compiled into the CLI.
 * Matches claude-code's src/skills/bundledSkills.ts pattern.
 *
 * File-based skills (SKILL.md) are still supported via loader.ts.
 */

export interface BundledSkillDefinition {
  name: string;
  description: string;
  /** Aliases — also invocable by these names. */
  aliases?: string[];
  /** When-to-use hint injected into the system prompt. */
  whenToUse?: string;
  /** Argument hint shown in help text. */
  argumentHint?: string;
  /** Restrict to these tools (empty = all). */
  allowedTools?: string[];
  /** Hide from model context (user can still invoke). */
  disableModelInvocation?: boolean;
  /** User can invoke via /name. */
  userInvocable?: boolean;
  /** Dynamic enable check. */
  isEnabled?: () => boolean;
  /** Generate the skill's prompt. args is the user input after /name. */
  getPromptForCommand: (args: string) => Promise<Array<{ type: "text"; text: string }>>;
}

// Global registry.
const _bundled: BundledSkillDefinition[] = [];

export function registerBundledSkill(def: BundledSkillDefinition): void {
  _bundled.push(def);
}

export function getBundledSkills(): BundledSkillDefinition[] {
  return _bundled;
}

export function getBundledSkillByName(name: string): BundledSkillDefinition | undefined {
  return _bundled.find((s) => s.name === name || (s.aliases ?? []).includes(name));
}
