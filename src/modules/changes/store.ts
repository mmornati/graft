import type { Selectable, Transaction } from "kysely";
import type { Db } from "../../db/client.js";
import type { ChangesTable, Database } from "../../db/schema.js";

type Executor = Db | Transaction<Database>;

/** The subset of `pulls.get` we read. */
export interface LivePull {
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
  commits: number;
  user: { id?: number; login: string; type: string } | null;
  labels?: { name: string }[];
  head: { sha: string };
  base: {
    ref: string;
    sha?: string;
    repo: { id: number; full_name: string; private: boolean; default_branch: string };
  };
}

export type Change = Selectable<ChangesTable>;

const toDate = (v: string | null): Date | null => (v === null ? null : new Date(v));

/**
 * Insert or update the change row from a LIVE pull. The update applies only when the stored
 * `pr_updated_at` is not newer than this snapshot (`<=`, so retries are idempotent). Returns the
 * row after the statement and whether this snapshot was applied.
 */
export async function upsertChangeFromPull(
  ex: Executor,
  repositoryId: number,
  pull: LivePull,
  now: Date,
): Promise<{ change: Change; applied: boolean }> {
  const state = pull.merged ? "merged" : pull.state;
  const values = {
    pr_node_id: pull.node_id,
    head_sha: pull.head.sha,
    base_ref: pull.base.ref,
    author_login: pull.user?.login ?? "ghost",
    author_id: pull.user?.id ?? null,
    author_is_bot: pull.user?.type === "Bot",
    state,
    // GitHub fills merge_commit_sha with a test-merge SHA on open PRs: keep it only when merged.
    merge_commit_sha: pull.merged ? pull.merge_commit_sha : null,
    opened_at: new Date(pull.created_at),
    closed_at: toDate(pull.closed_at),
    merged_at: toDate(pull.merged_at),
    pr_updated_at: new Date(pull.updated_at),
  } as const;

  const row = await ex
    .insertInto("changes")
    .values({
      repository_id: repositoryId,
      pr_number: pull.number,
      task_id: null,
      graft_comment_id: null,
      created_at: now,
      updated_at: now,
      ...values,
    })
    .onConflict((oc) =>
      oc
        .columns(["repository_id", "pr_number"])
        .doUpdateSet({ ...values, updated_at: now })
        .where((eb) =>
          eb.or([
            eb("changes.pr_updated_at", "is", null),
            eb("changes.pr_updated_at", "<=", values.pr_updated_at),
          ]),
        ),
    )
    .returningAll()
    .executeTakeFirst();
  if (row) return { change: row, applied: true };

  const current = await ex
    .selectFrom("changes")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("pr_number", "=", pull.number)
    .executeTakeFirstOrThrow();
  return { change: current, applied: false };
}

export async function getChange(ex: Executor, id: string): Promise<Change | undefined> {
  return ex.selectFrom("changes").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function findChangeByHead(
  ex: Executor,
  repositoryId: number,
  headSha: string,
): Promise<Change | undefined> {
  return ex
    .selectFrom("changes")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("head_sha", "=", headSha)
    .orderBy("pr_number", "desc")
    .executeTakeFirst();
}

export async function getChangeByNumber(
  ex: Executor,
  repositoryId: number,
  prNumber: number,
): Promise<Change | undefined> {
  return ex
    .selectFrom("changes")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("pr_number", "=", prNumber)
    .executeTakeFirst();
}
