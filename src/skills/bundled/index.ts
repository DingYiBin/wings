import { registerCommitSkill } from "./commit.ts";
import { registerSimplifySkill } from "./simplify.ts";
import { registerReviewPrSkill } from "./review-pr.ts";

export function registerAllBundledSkills(): void {
  registerCommitSkill();
  registerSimplifySkill();
  registerReviewPrSkill();
}
