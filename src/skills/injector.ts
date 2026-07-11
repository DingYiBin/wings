/**
 * Skill injector — adds available skills to the system prompt.
 *
 * Handles both bundled skills (TypeScript) and file-based skills (SKILL.md).
 */

import type { SkillSpec } from "./types.ts";
import { getBundledSkills, type BundledSkillDefinition } from "./bundledSkills.ts";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class SkillInjector {
  /** Append an <available_skills> block to the system prompt.
   *  Includes both bundled skills and file-based skills. */
  injectSkills(systemPrompt: string, fileSkills: SkillSpec[]): string {
    const bundled = getBundledSkills().filter((s) => !s.disableModelInvocation);
    const fileVisible = fileSkills.filter((s) => !s.disable_model_invocation);
    if (bundled.length === 0 && fileVisible.length === 0) return systemPrompt;
    return `${systemPrompt}\n\n${this._buildBlock(bundled, fileVisible)}`;
  }

  private _buildBlock(
    bundled: BundledSkillDefinition[],
    fileSkills: SkillSpec[],
  ): string {
    const lines: string[] = [
      "## Skills",
      "Skills are optional task playbooks. Use them only when a listed entry",
      "clearly matches the user's current request.",
      'Call skill_view(name="<skill_name>") to load a skill\'s full instructions,',
      "then use only the tools available in this session.",
      "When no entry is relevant, answer without loading a skill.",
      "",
      "<available_skills>",
    ];
    for (const s of bundled) {
      lines.push("  <skill>");
      lines.push(`    <name>${xmlEscape(s.name)}</name>`);
      lines.push(`    <description>${xmlEscape(s.description)}</description>`);
      lines.push("  </skill>");
    }
    for (const s of fileSkills) {
      lines.push("  <skill>");
      lines.push(`    <name>${xmlEscape(s.name)}</name>`);
      lines.push(`    <description>${xmlEscape(s.description)}</description>`);
      lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    return lines.join("\n");
  }
}

