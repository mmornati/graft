/**
 * `get_policy` (§7): the parsed policy of a branch (the default branch unless `base` is given) and
 * the repository's modes. It reads `graft.yaml` through the policy job's own loader and cache and
 * returns the parsed object in canonical key order: never the YAML text or its comments.
 */
import type { GitHubClient } from "../../../github/client-factory.js";
import {
  type GetPolicyInput,
  type GetPolicyOutput,
  validBranchName,
} from "../../../mcp/schemas.js";
import { type LoadedPolicy, loadBasePolicy, resolveBaseCommit } from "../../../policy/load.js";
import { canonicalJson } from "../../../policy/parse.js";
import { PermanentJobError } from "../../../queue/errors.js";
import { getEffectiveModes } from "../../modes/index.js";
import {
  checkRepository,
  githubError,
  splitFullName,
  type ToolContext,
  ToolError,
} from "./common.js";
import { modeView } from "./get-status.js";

/** D17: the default branch, from the API (never from an argument). */
export async function defaultBranch(
  octokit: GitHubClient,
  owner: string,
  repo: string,
): Promise<string> {
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    if (typeof data.default_branch !== "string" || data.default_branch === "") {
      throw new ToolError("internal");
    }
    return data.default_branch;
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw githubError(err);
  }
}

export async function getPolicy(ctx: ToolContext, input: GetPolicyInput): Promise<GetPolicyOutput> {
  checkRepository(ctx, input.repository);
  const { principal } = ctx;
  const { owner, repo } = splitFullName(principal.fullName);
  if (input.base !== undefined && !validBranchName(input.base)) {
    throw new ToolError("base_not_found");
  }
  let octokit: GitHubClient;
  try {
    octokit = await ctx.github.forInstallation(principal.installationId);
  } catch (err) {
    throw githubError(err);
  }
  const base = input.base ?? (await defaultBranch(octokit, owner, repo));

  let loaded: LoadedPolicy;
  try {
    const commitSha = await resolveBaseCommit(octokit, { owner, repo, baseRef: base });
    loaded = await loadBasePolicy(octokit, {
      repositoryId: principal.repositoryId,
      owner,
      repo,
      commitSha,
    });
  } catch (err) {
    if (err instanceof PermanentJobError && err.reason === "base_missing") {
      throw new ToolError("base_not_found");
    }
    // `toJobError` keeps the status of a GitHub error on the cause it wraps.
    throw githubError((err as { cause?: unknown }).cause ?? err);
  }
  const modes = await getEffectiveModes(ctx.db, principal.repositoryId, ctx.config);
  return {
    base,
    commitSha: loaded.commitSha,
    status: loaded.status,
    hash: loaded.status === "ok" ? loaded.hash : null,
    policy:
      loaded.status === "ok"
        ? (JSON.parse(canonicalJson(loaded.policy)) as Record<string, unknown>)
        : null,
    errors:
      loaded.status === "invalid"
        ? loaded.errors.map((e) => ({
            code: e.code,
            ...(e.line === null ? {} : { line: e.line }),
            ...(e.location === null ? {} : { path: e.location }),
          }))
        : [],
    warnings:
      loaded.status === "ok"
        ? loaded.warnings.map((w) => JSON.parse(canonicalJson(w)) as Record<string, unknown>)
        : [],
    modes: {
      ceiling: modes.ceiling,
      policy: modeView(modes.policy),
      guard: modeView(modes.guard),
      mcpWrite: modeView(modes.mcpWrite),
    },
  };
}
