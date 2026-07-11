import { registerBundledSkill } from "../bundledSkills.ts";

const PROMPT = `# Simplify Skill

Review recently changed code for:
1. **Dead code**: unused imports, unreachable branches, redundant variables
2. **Duplication**: repeated patterns that should be extracted
3. **Complexity**: functions > 80 lines, nesting > 4 deep, too many params
4. **Idioms**: use language-appropriate patterns, avoid antipatterns
5. **Naming**: unclear or misleading names

Fix issues inline with the edit tool. Be surgical — do not rewrite working code.`;

export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: "simplify",
    description:
      "Review code for reuse, quality, and efficiency, then fix any issues found",
    userInvocable: true,
    async getPromptForCommand(_args: string) {
      return [{ type: "text", text: PROMPT }];
    },
  });
}
