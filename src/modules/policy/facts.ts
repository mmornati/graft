/**
 * What the policy engine knows about a PR (spec T7). File lists and reviews come from the API and
 * are reduced to paths and numbers at once: a `patch` is dropped as soon as it is read.
 */
import type { GlobBudget } from "../../core/glob.js";
import type { GitHubClient } from "../../github/client-factory.js";
import type { PolicyFacts, ReviewLike } from "../../policy/evaluate.js";
import type { LivePull } from "../changes/index.js";
import {
  type ChangedFile,
  computeRiskFloor,
  type IntentCardRow,
  maxRisk,
} from "../intent/index.js";
import type { ChangeProvenanceRow } from "../provenance/index.js";

export const MAX_LISTED_FILES = 1_000;
const FILE_PAGE = 100;
const MAX_FILE_PAGES = 10;
const REVIEW_PAGE = 100;
const MAX_REVIEW_PAGES = 3;

export interface ListedFile {
  path: string;
  previousPath: string | null;
  status: ChangedFile["status"];
  additions: number;
  deletions: number;
}

export async function listChangedPaths(
  octokit: GitHubClient,
  o: { owner: string; repo: string; prNumber: number; changedFiles: number },
): Promise<{ files: ListedFile[]; complete: boolean }> {
  if (o.changedFiles > MAX_LISTED_FILES) return { files: [], complete: false };
  const files: ListedFile[] = [];
  let pages = 0;
  const it = octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner: o.owner,
    repo: o.repo,
    pull_number: o.prNumber,
    per_page: FILE_PAGE,
  });
  for await (const page of it) {
    for (const f of page.data) {
      // `patch` is deliberately not copied: diffs are never kept (README §5).
      files.push({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      });
    }
    if (++pages >= MAX_FILE_PAGES) break;
  }
  return { files, complete: files.length === o.changedFiles };
}

export async function listReviews(
  octokit: GitHubClient,
  o: { owner: string; repo: string; prNumber: number },
): Promise<{ reviews: ReviewLike[]; truncated: boolean }> {
  const reviews: ReviewLike[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
    const res = await octokit.rest.pulls.listReviews({
      owner: o.owner,
      repo: o.repo,
      pull_number: o.prNumber,
      per_page: REVIEW_PAGE,
      page,
    });
    for (const r of res.data) {
      reviews.push({
        user: r.user ? { id: r.user.id, login: r.user.login, type: r.user.type } : null,
        state: r.state,
        commit_id: r.commit_id ?? null,
        submitted_at: r.submitted_at ?? null,
        author_association: r.author_association,
      });
    }
    if (res.data.length < REVIEW_PAGE) break;
    if (page === MAX_REVIEW_PAGES) truncated = true;
  }
  return { reviews, truncated };
}

export function buildFacts(o: {
  /** The job's shared glob work budget (also used by `evaluatePolicy`). */
  budget?: GlobBudget;
  pull: Pick<LivePull, "additions" | "deletions" | "changed_files" | "labels" | "head">;
  files: readonly ListedFile[];
  complete: boolean;
  card: Pick<IntentCardRow, "head_sha" | "status" | "risk_class"> | undefined;
  provenance:
    | (Pick<ChangeProvenanceRow, "head_sha" | "author_kind" | "agent"> & {
        /** Phase 1 step 6 (D13); absent on rows read before 0014, which means `none`. */
        mcp_report?: ChangeProvenanceRow["mcp_report"];
      })
    | undefined;
  configSensitivePaths: readonly string[];
  policySensitivePaths: readonly string[];
}): PolicyFacts {
  const { pull } = o;
  const headSha = pull.head.sha;

  let risk: PolicyFacts["risk"];
  if (o.card && o.card.head_sha === headSha) {
    risk =
      o.card.status === "ok"
        ? { value: o.card.risk_class, final: true, source: "card" }
        : { value: o.card.risk_class, final: false, source: "card_unavailable" };
  } else {
    const files: ChangedFile[] = o.files.map((f) => ({
      path: f.path,
      previousPath: f.previousPath,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: null,
    }));
    const { floor } = computeRiskFloor(
      {
        files,
        pr: {
          additions: pull.additions,
          deletions: pull.deletions,
          changedFiles: pull.changed_files,
        },
        listingTruncated: !o.complete,
        tooLarge: pull.changed_files > MAX_LISTED_FILES,
        partialPaths: [],
        untrustedTexts: [],
      },
      { extraSensitiveGlobs: [...new Set([...o.configSensitivePaths, ...o.policySensitivePaths])] },
      o.budget,
    );
    risk = { value: maxRisk(floor, "logic"), final: false, source: "card_pending" };
  }

  // Phase 1 step 6 (D13): an MCP report that disagrees with the trailers makes the author
  // unknown, the strictest fact the engine has. A report never replaces a trailer value.
  const author: PolicyFacts["author"] =
    o.provenance && o.provenance.head_sha === headSha && o.provenance.mcp_report !== "disagrees"
      ? { kind: o.provenance.author_kind, agent: o.provenance.agent }
      : { kind: "unknown", agent: null };

  return {
    files: o.files.map((f) => ({ path: f.path, previousPath: f.previousPath })),
    listingComplete: o.complete,
    size: { lines: pull.additions + pull.deletions, files: pull.changed_files },
    risk,
    author,
    labels: (pull.labels ?? []).map((l) => l.name),
  };
}

/** D19: at most this many commits are read; more means "cannot tell who wrote it". */
export const MAX_COMMIT_LOGINS = 250;
const COMMIT_PAGE = 100;

/**
 * Phase 1 step 7 (D8): on a PR opened through MCP, only verified commits let approvals count.
 * Decided by the spec, not a pending product decision (step 7 review 1, nit 8): `false` goes back
 * to step 6's D19 alone, which reopens step 6 residual risk 2 and needs a new security review.
 */
export const REQUIRE_VERIFIED_COMMITS = true;

/** Why Graft cannot tell who wrote an MCP-opened PR (Phase 1 step 6 D19, step 7 D8). */
export type CommitLoginsUnknown = "too_many" | "no_author" | "unverified";
export type CommitLogins = { logins: string[] } | { unknown: CommitLoginsUnknown };

/**
 * Phase 1 step 6 (D19): the lowercased author and committer logins of a PR's commits, for a PR
 * opened through MCP, or why Graft cannot tell who they are: more than 250 commits (`too_many`), a
 * commit with no author login (`no_author`), or, Phase 1 step 7 (D8), a commit GitHub has not
 * verified (`unverified`: `commit.verification.verified` is not `true`, the committer has no
 * login, or the committer is GitHub's `web-flow`). Anyone who pushes chooses the author and
 * committer emails; a verified signature made with the committer's own key ties the committer to
 * its account. A `web-flow` signature only proves that GitHub created the commit, not who asked
 * it to, so such a commit is `unverified` too (step 7 review 1, finding 2; until the HUMAN-TODO
 * real-GitHub check shows GitHub never signs a `web-flow` commit with an author the caller chose).
 * Logins only: no message, no SHA, nothing stored.
 */
export async function listCommitLogins(
  octokit: GitHubClient,
  o: { owner: string; repo: string; prNumber: number; commits: number },
): Promise<CommitLogins> {
  if (o.commits > MAX_COMMIT_LOGINS) return { unknown: "too_many" };
  const logins = new Set<string>();
  let seen = 0;
  for (let page = 1; page <= Math.ceil(MAX_COMMIT_LOGINS / COMMIT_PAGE); page++) {
    const res = await octokit.rest.pulls.listCommits({
      owner: o.owner,
      repo: o.repo,
      pull_number: o.prNumber,
      per_page: COMMIT_PAGE,
      page,
    });
    for (const c of res.data) {
      seen++;
      const author = c.author?.login;
      if (typeof author !== "string" || author === "") return { unknown: "no_author" };
      const committer = c.committer?.login;
      if (REQUIRE_VERIFIED_COMMITS) {
        // D8: only `verified: true` counts; absent, false or anything else is unverified.
        if (c.commit?.verification?.verified !== true) return { unknown: "unverified" };
        if (typeof committer !== "string" || committer === "") return { unknown: "unverified" };
        // Step 7 review 1, finding 2: GitHub's `web-flow` signature proves only that GitHub made
        // the commit, not who asked it to, so the author is not tied to an account.
        if (committer === "web-flow") return { unknown: "unverified" };
      }
      logins.add(author.toLowerCase());
      if (typeof committer === "string" && committer !== "" && committer !== "web-flow") {
        logins.add(committer.toLowerCase());
      }
    }
    if (res.data.length < COMMIT_PAGE) break;
  }
  if (seen > MAX_COMMIT_LOGINS) return { unknown: "too_many" };
  return { logins: [...logins].sort() };
}
