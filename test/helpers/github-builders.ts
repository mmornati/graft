/** Builders in the fictional world: repo graft-sandbox/sample-ts (2000001), PR 2. */

export const OWNER = "graft-sandbox";
export const REPO = "sample-ts";
export const REPO_ID = 2000001;
export const INSTALLATION_ID = 1000001;
export const PR_NUMBER = 2;
export const HEAD_SHA = "ec26c3e57ca3a959ca5aad62de7213c562f8c821";

/** A deterministic 40-hex SHA: fakeSha(1) = "000…001". */
export function fakeSha(n: number): string {
  return n.toString(16).padStart(40, "0");
}

export interface FakePull {
  number: number;
  node_id: string;
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  body: string | null;
  title: string;
  changed_files: number;
  additions: number;
  deletions: number;
  draft: boolean;
  commits: number;
  user: { id?: number; login: string; type: string } | null;
  /** Phase 1 step 5: who merged it (the revert PR mentions them for a bot author). */
  merged_by?: { id?: number; login: string; type: string } | null;
  labels: { name: string }[];
  /** `ref`: the head branch (Phase 1 step 5: `GET /pulls?head=` and revert PRs). */
  head: { sha: string; ref?: string };
  base: {
    ref: string;
    sha?: string;
    repo: { id: number; full_name: string; private: boolean; default_branch: string };
  };
}

/** User id of the default pull request author. */
export const PR_AUTHOR_ID = 4_242_001;

export function makePull(overrides: Partial<FakePull> = {}): FakePull {
  return {
    number: PR_NUMBER,
    node_id: "PR_fake2",
    state: "open",
    merged: false,
    merge_commit_sha: null,
    created_at: "2026-10-14T10:00:00Z",
    updated_at: "2026-10-14T11:00:00Z",
    closed_at: null,
    merged_at: null,
    body: null,
    title: "Fix the retry loop",
    changed_files: 1,
    additions: 10,
    deletions: 2,
    draft: false,
    commits: 1,
    user: { id: PR_AUTHOR_ID, login: "graft-dev", type: "User" },
    labels: [],
    head: { sha: HEAD_SHA },
    base: {
      ref: "main",
      sha: fakeSha(0xba5e),
      repo: {
        id: REPO_ID,
        full_name: `${OWNER}/${REPO}`,
        private: true,
        default_branch: "main",
      },
    },
    ...overrides,
  };
}

export interface FakeCommit {
  sha: string;
  /** Phase 1 step 7 (D8): `verification` defaults to verified on `pulls.listCommits`. */
  commit: { message: string; verification?: { verified: boolean; reason?: string } | undefined };
}

export function makeCommit(sha: string, message: string): FakeCommit {
  return { sha, commit: { message } };
}

/** `subject`, a blank line, optional body, a blank line, then `Key: value` trailers. */
export function commitMessage(
  subject: string,
  body?: string,
  trailers?: readonly [string, string][],
): string {
  const parts = [subject];
  if (body) parts.push(body);
  if (trailers && trailers.length > 0)
    parts.push(trailers.map(([k, v]) => `${k}: ${v}`).join("\n"));
  return parts.join("\n\n");
}

export interface FakeFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  sha: string;
}

/** A file of `pulls.listFiles`. The patch is a small hunk unless one is given (null = no patch). */
export function makeFile(o: {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string | null;
  previousPath?: string;
}): FakeFile {
  const additions = o.additions ?? 3;
  const deletions = o.deletions ?? 1;
  const patch =
    o.patch === undefined
      ? `@@ -1,${deletions} +1,${additions} @@\n${"-old line\n".repeat(deletions)}${"+new line\n".repeat(additions)}`.trimEnd()
      : o.patch;
  return {
    filename: o.path,
    ...(o.previousPath ? { previous_filename: o.previousPath } : {}),
    status: o.status ?? "modified",
    additions,
    deletions,
    changes: additions + deletions,
    ...(patch === null ? {} : { patch }),
    sha: fakeSha(0x777),
  };
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  pull_request?: { url: string };
}

export function makeIssue(
  n: number,
  o: { title?: string; body?: string | null; isPull?: boolean } = {},
): FakeIssue {
  return {
    number: n,
    title: o.title ?? `Issue ${n}`,
    body: o.body === undefined ? `Body of issue ${n}` : o.body,
    state: "open",
    ...(o.isPull ? { pull_request: { url: `https://api.github.com/pulls/${n}` } } : {}),
  };
}

export interface FakeReaction {
  id: number;
  content: string;
  created_at: string;
  user: { id: number; login: string; type: string } | null;
}

export function makeReaction(
  id: number,
  login: string,
  content: string,
  createdAt: string,
  type = "User",
): FakeReaction {
  return {
    id,
    content,
    created_at: createdAt,
    user: { id: 5_000_000 + id, login, type },
  };
}

export interface FakeReview {
  id: number;
  user: { id: number; login: string; type: string } | null;
  state: string;
  commit_id: string | null;
  submitted_at: string | null;
  author_association: string;
}

/**
 * A review of `pulls.listReviews`. Defaults: approved on the PR head, by a human reviewer who is a
 * COLLABORATOR (pass `association: "NONE"` for an outsider on a public repository).
 */
export function makeReview(o: {
  id: number;
  login?: string;
  userId?: number;
  type?: string;
  state?: string;
  commitId?: string | null;
  submittedAt?: string;
  association?: string;
}): FakeReview {
  const login = o.login ?? "reviewer-1";
  return {
    id: o.id,
    user: { id: o.userId ?? 5_000_000 + o.id, login, type: o.type ?? "User" },
    state: o.state ?? "APPROVED",
    commit_id: o.commitId === undefined ? HEAD_SHA : o.commitId,
    submitted_at: o.submittedAt ?? `2026-10-14T11:${String(o.id % 60).padStart(2, "0")}:00Z`,
    author_association: o.association ?? "COLLABORATOR",
  };
}

/** What the fake `repos.getContent` serves for one path at one ref. */
export type FakeContent =
  | { kind: "file"; text: string | Uint8Array; path?: string; omitSha?: boolean }
  | { kind: "dir" }
  | { kind: "symlink"; target: string }
  | { kind: "submodule" }
  /** A file above the 1 MB limit: the API answers with `encoding: "none"` and no content. */
  | { kind: "large"; size: number }
  /** A file whose reported size is `size` while its content is `text` (for the size guard). */
  | { kind: "sized"; text: string; size: number };

export function makeContent(kind: FakeContent): FakeContent {
  return kind;
}
