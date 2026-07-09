/**
 * Skill injector — adds available skills to the system prompt.
 *
 * The model sees an <available_skills> XML block it can use to decide
 * whether to call skill_view() for a particular skill.
 *
 * Mirrors src/wings/skills/injector.py.
 */

import type { SkillSpec } from "./types.ts";

/** Escape a string for safe inclusion in XML element text. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export class SkillInjector {
  /** Append an <available_skills> block to the system prompt. */
  injectSkills(systemPrompt: string, skills: SkillSpec[]): string {
    const visible = skills.filter((s) => !s.disable_model_invocation);
    if (visible.length === 0) return systemPrompt;
    return `${systemPrompt}\n\n${this._buildSkillsBlock(visible)}`;
  }

  private _buildSkillsBlock(skills: SkillSpec[]): string {
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
    for (const s of skills) {
      lines.push("  <skill>");
      lines.push(`    <name>${xmlEscape(s.name)}</name>`);
      lines.push(`    <description>${xmlEscape(s.description)}</description>`);
      lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    return lines.join("\n");
  }
}
