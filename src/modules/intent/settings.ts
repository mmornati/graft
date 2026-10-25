import type { JobContext } from "../../core/context.js";
import type { GitHubClient } from "../../github/client-factory.js";
import { loadBasePolicy } from "../../policy/load.js";
import type { ReportLanguage } from "../../policy/schema.js";
import type { FloorConfig } from "./risk-floor.js";

/**
 * What the hook needs to read `graft.yaml`: an installation client and the BASE commit. The base
 * SHA, never the head, so a pull request cannot edit the policy that judges it (D3).
 */
export interface IntentSettingsTarget {
  repositoryId: number;
  installationId: number;
  owner: string;
  repo: string;
  /** 40-hex SHA of a base-branch commit. */
  baseSha: string;
}

/**
 * Per-repository settings for the intent service. Merges the `sensitive_paths` of the base
 * branch's `graft.yaml` with `GRAFT_INTENT_SENSITIVE_PATHS` (T9) and reads `report.language`. A
 * missing or invalid file falls back to the configured globs only, in English. Transient GitHub
 * errors propagate (the caller maps them).
 */
export async function intentRepoSettings(
  ctx: Pick<JobContext, "config" | "log">,
  target: IntentSettingsTarget,
  octokit: GitHubClient,
): Promise<{ floor: FloorConfig; dailyTokenBudget: number; language: ReportLanguage }> {
  if (!/^[0-9a-f]{40}$/.test(target.baseSha)) {
    throw new Error("intentRepoSettings needs a 40-hex base SHA");
  }
  const loaded = await loadBasePolicy(octokit, {
    repositoryId: target.repositoryId,
    owner: target.owner,
    repo: target.repo,
    commitSha: target.baseSha,
    log: ctx.log,
  });
  const configured = ctx.config.intentSensitivePaths;
  let globs = configured;
  let language: ReportLanguage = "en";
  if (loaded.status === "ok") {
    globs = [...new Set([...configured, ...loaded.policy.sensitivePaths])];
    language = loaded.policy.report?.language ?? "en";
  } else {
    ctx.log.info({ policy_status: loaded.status }, "graft.yaml not used for sensitive paths");
  }
  return {
    floor: { extraSensitiveGlobs: globs },
    dailyTokenBudget: ctx.config.llmDailyTokenBudget,
    language,
  };
}
