/**
 * The API-backed `TreeReader` of the revert plan (Phase 1 step 5, T5, D6, D8). Git Data API only:
 * `git.getTree` (non-recursive) and `git.getCommit`, which hold names, modes and SHAs. No blob,
 * file content, patch or diff is ever requested. A commit's message comes back with it and is
 * dropped here. Each object is read once per job (the cache), and the reader counts its tree
 * requests: past `maxTreeReads` it throws `TreeReadBudgetExceeded` (the D8 budget, per request).
 */
import type { GitHubClient } from "../../github/client-factory.js";
import { toJobError } from "../../github/errors.js";
import { type Entry, TreeReadBudgetExceeded, type TreeReader } from "../../guard/revert-plan.js";
import { PermanentJobError } from "../../queue/errors.js";

const SHA = /^[0-9a-f]{40}$/;
const TYPES = new Set(["blob", "tree", "commit"]);

export interface ApiTreeReader extends TreeReader {
  /** Tree requests made so far. */
  treeRequests(): number;
}

export function apiTreeReader(
  octokit: GitHubClient,
  o: { owner: string; repo: string; maxTreeReads: number },
): ApiTreeReader {
  const trees = new Map<string, ReturnType<TreeReader["tree"]>>();
  const commits = new Map<string, ReturnType<TreeReader["commit"]>>();
  let requests = 0;
  const malformed = () =>
    new PermanentJobError("GitHub returned a malformed git object", "github_malformed");
  return {
    treeRequests: () => requests,
    commit(sha) {
      let hit = commits.get(sha);
      if (!hit) {
        hit = (async () => {
          let data: Awaited<ReturnType<GitHubClient["rest"]["git"]["getCommit"]>>["data"];
          try {
            data = (
              await octokit.rest.git.getCommit({ owner: o.owner, repo: o.repo, commit_sha: sha })
            ).data;
          } catch (err) {
            throw toJobError(err, "git.getCommit");
          }
          const tree = data.tree?.sha;
          const parents = (data.parents ?? []).map((p) => p.sha);
          if (typeof tree !== "string" || !SHA.test(tree) || !parents.every((p) => SHA.test(p))) {
            throw malformed();
          }
          return { tree, parents };
        })();
        commits.set(sha, hit);
        // A failed read is not cached: a retry reads again.
        hit.catch(() => commits.delete(sha));
      }
      return hit;
    },
    tree(sha) {
      let hit = trees.get(sha);
      if (!hit) {
        if (requests >= o.maxTreeReads) return Promise.reject(new TreeReadBudgetExceeded());
        requests++;
        hit = (async () => {
          let data: Awaited<ReturnType<GitHubClient["rest"]["git"]["getTree"]>>["data"];
          try {
            data = (await octokit.rest.git.getTree({ owner: o.owner, repo: o.repo, tree_sha: sha }))
              .data;
          } catch (err) {
            throw toJobError(err, "git.getTree");
          }
          const entries: { name: string; entry: Entry }[] = [];
          for (const e of data.tree) {
            if (
              typeof e.path !== "string" ||
              typeof e.mode !== "string" ||
              typeof e.type !== "string" ||
              !TYPES.has(e.type) ||
              typeof e.sha !== "string" ||
              !SHA.test(e.sha)
            ) {
              throw malformed();
            }
            entries.push({
              name: e.path,
              entry: { mode: e.mode, type: e.type as Entry["type"], sha: e.sha },
            });
          }
          return { entries, truncated: data.truncated === true };
        })();
        trees.set(sha, hit);
        hit.catch(() => trees.delete(sha));
      }
      return hit;
    },
  };
}
