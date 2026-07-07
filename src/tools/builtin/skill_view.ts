/** skill_view tool — lets the model load a skill's full instructions by name. */

import { z } from "zod";

import { buildTool } from "../types.ts";

export const skillViewTool = buildTool({
  name: "skill_view",
  description:
    "Load a skill's full instructions by name. " +
    "Call this when a listed skill matches the user's request, " +
    "then follow its instructions.",
  search_hint: "skill_view name=commit",
  is_read_only: true,
  inputSchema: z.object({
    name: z.string().describe("Name of the skill to view, e.g. 'commit'"),
  }),
  async call(input, context) {
    const skills = context.available_skills ?? {};
    const content = skills[input.name];
    if (content === undefined) {
      const available = Object.keys(skills).length > 0
        ? Object.keys(skills).sort().join(", ")
        : "(none)";
      return `Error: skill '${input.name}' not found. Available skills: ${available}`;
    }
    return content;
  },
});
