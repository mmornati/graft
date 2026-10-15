/**
 * Reading `graft.yaml` from the BASE branch (spec T6, D3, D7, D17).
 *
 * The policy commit is the commit `heads/<base ref>` points to; the file is read at that SHA and
 * never from the PR head or a pull ref. Commits are immutable, so the result is cached per
 * `repositoryId:commitSha` (LRU of 256). Failures from GitHub are never cached.
 *
 * This is the one file of `src/policy` that touches `src/github` and `src/queue/errors.ts` (the
 * error classes only); the pure parts (schema, parse, evaluate) do not.
 */
import type { Logger } from "../core/logger.js";
import type { GitHubClient } from "../github/client-factory.js";
import { classifyGitHubError, toJobError } from "../github/errors.js";
import { PermanentJobError } from "../queue/errors.js";
import { LIMITS, POLICY_PATH } from "./constants.js";
import type { PolicyError, PolicyWarning } from "./errors.js";
import { parsePolicyText } from "./parse.js";
import type { Policy } from "./schema.js";

export type LoadedPolicy =
  | {
      status: "ok";
      commitSha: string;
      fileSha: string;
      policy: Policy;
      hash: string;
      warnings: PolicyWarning[];
    }
  | { status: "missing"; commitSha: string; fileSha: null }
  | { status: "invalid"; commitSha: string; fileSha: string | null; errors: PolicyError[] };

const SHA40 = /^[0-9a-f]{40}$/;
const CACHE_SIZE = 256;

const cache = new Map<string, LoadedPolicy>();
const inflight = new Map<string, Promise<LoadedPolicy>>();

export function clearPolicyCache(): void {
  cache.clear();
  inflight.clear();
}

export async function resolveBaseCommit(
  octokit: GitHubClient,
  o: { owner: string; repo: string; baseRef: string },
): Promise<string> {
  try {
    const { data } = await octokit.rest.git.getRef({
      owner: o.owner,
      repo: o.repo,
      ref: `heads/${o.baseRef}`,
    });
    const sha = data.object.sha;
    if (!SHA40.test(sha)) throw new Error("git.getRef returned a malformed SHA");
    return sha;
  } catch (err) {
    if (classifyGitHubError(err) === "not_found") {
      throw new PermanentJobError("base branch not found", "base_missing");
    }
    if (err instanceof Error && err.message === "git.getRef returned a malformed SHA") throw err;
    throw toJobError(err, "git.getRef");
  }
}

const invalid = (
  commitSha: string,
  fileSha: string | null,
  code: PolicyError["code"],
  detail?: number,
): LoadedPolicy => ({
  status: "invalid",
  commitSha,
  fileSha,
  errors: [
    {
      code,
      location: null,
      line: null,
      column: null,
      ...(detail !== undefined ? { detail } : {}),
    },
  ],
});

async function fetchPolicy(
  octokit: GitHubClient,
  o: { owner: string; repo: string; commitSha: string },
): Promise<LoadedPolicy> {
  const { commitSha } = o;
  let data: unknown;
  try {
    const res = await octokit.rest.repos.getContent({
      owner: o.owner,
      repo: o.repo,
      path: POLICY_PATH,
      ref: commitSha,
    });
    data = res.data;
  } catch (err) {
    if (classifyGitHubError(err) === "not_found")
      return { status: "missing", commitSha, fileSha: null };
    throw toJobError(err, "repos.getContent");
  }
  if (Array.isArray(data)) return invalid(commitSha, null, "file_not_regular");
  const f = (data ?? {}) as Record<string, unknown>;
  const fileSha = typeof f.sha === "string" && SHA40.test(f.sha) ? f.sha : null;
  // GitHub follows a symlink to an in-repo file and returns the target's path (D7).
  if (f.type !== "file" || f.path !== POLICY_PATH) {
    return invalid(commitSha, fileSha, "file_not_regular");
  }
  const size = typeof f.size === "number" ? f.size : 0;
  if (size > LIMITS.fileBytes || f.encoding !== "base64" || typeof f.content !== "string") {
    return invalid(commitSha, fileSha, "file_too_large", size);
  }
  const bytes = Buffer.from(f.content, "base64");
  const parsed = parsePolicyText(bytes);
  if (!parsed.ok) return { status: "invalid", commitSha, fileSha, errors: parsed.errors };
  if (fileSha === null)
    throw new PermanentJobError("graft.yaml has no blob SHA", "policy_no_blob_sha");
  return {
    status: "ok",
    commitSha,
    fileSha,
    policy: parsed.policy,
    hash: parsed.hash,
    warnings: parsed.warnings,
  };
}

export async function loadBasePolicy(
  octokit: GitHubClient,
  o: {
    repositoryId: number;
    owner: string;
    repo: string;
    commitSha: string;
    log?: Pick<Logger, "info">;
  },
): Promise<LoadedPolicy> {
  const key = `${o.repositoryId}:${o.commitSha}`;
  const hit = cache.get(key);
  if (hit) {
    // LRU: most recent last.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchPolicy(octokit, o).then((loaded) => {
      cache.set(key, loaded);
      while (cache.size > CACHE_SIZE) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      o.log?.info(
        {
          repositoryId: o.repositoryId,
          commitSha7: o.commitSha.slice(0, 7),
          status: loaded.status,
          errors: loaded.status === "invalid" ? loaded.errors.length : 0,
        },
        "policy loaded",
      );
      return loaded;
    });
    inflight.set(key, pending);
    pending.then(
      () => inflight.delete(key),
      () => inflight.delete(key),
    );
  }
  return pending;
}
