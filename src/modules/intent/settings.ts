import type { JobContext } from "../../core/context.js";
import type { FloorConfig } from "./risk-floor.js";

/**
 * What step 5 needs to read `graft.yaml`: an installation client and a ref. The base SHA, not the
 * head, so a pull request cannot edit its own policy.
 */
export interface IntentSettingsTarget {
  repositoryId: number;
  installationId: number;
  owner: string;
  repo: string;
  baseSha: string;
}

/**
 * Per-repository settings for the intent service.
 *
 * Step 5 merges `graft.yaml` sensitive paths and budgets here; callers must not read config
 * directly.
 */
export async function intentRepoSettings(
  ctx: Pick<JobContext, "config">,
  _repo: IntentSettingsTarget,
): Promise<{ floor: FloorConfig; dailyTokenBudget: number }> {
  return {
    floor: { extraSensitiveGlobs: ctx.config.intentSensitivePaths },
    dailyTokenBudget: ctx.config.llmDailyTokenBudget,
  };
}
