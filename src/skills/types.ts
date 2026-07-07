export interface SkillSpec {
  name: string;
  description: string;
  /** The complete markdown body (instructions after the YAML frontmatter). */
  content: string;
  /** Parent directory of the SKILL.md file. */
  path: string;
  /** Whether the skill can be invoked by the user via /<name>. */
  user_invocable: boolean;
  /** When true, the skill is hidden from the model's context. */
  disable_model_invocation: boolean;
  /** Source layer: "builtin", "user", or "project". */
  source: string;
}
