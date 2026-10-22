/**
 * The guard's tables (Phase 1 step 4): `main_commits`, `ci_results` and the step 4 columns of
 * `guard_events`. SHAs, keys, check names, classes, numbers and times only: never output, logs,
 * commit messages or PR text.
 */
import { type Selectable, sql, type Transaction } from "kysely";
import type { Db } from "../../db/client.js";
import type {
  CiResultsTable,
  Database,
  GuardCandidate,
  GuardEventStatus,
  GuardEventsTable,
  GuardFailingCheck,
  MainCommitsTable,
} from "../../db/schema.js";
import type { ChainCommit, CommitPr } from "../../guard/detect.js";

type Executor = Db | Transaction<Database>;
export type MainCommitRow = Selectable<MainCommitsTable>;
export type CiResultRow = Selectable<CiResultsTable>;
export type GuardEventRow = Selectable<GuardEventsTable>;

/** How far back the chain is read for one detection (D5 caps one walk at 300 commits). */
export const MAX_LINE = 400;
export const MAX_FAILING_CHECKS = 20;
export const MAX_CANDIDATES = 50;

/**
 * D11: a transaction holding the per-repository advisory lock. Detection reads results and writes
 * events inside it; no GitHub call is ever made inside it.
 */
export async function withRepositoryGuardLock<T>(
  db: Db,
  repositoryId: number,
  fn: (tx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('guard:' || ${String(repositoryId)}))`.execute(
      tx,
    );
    return fn(tx);
  });
}

// ---------------------------------------------------------------------------------------------
// main_commits
// ---------------------------------------------------------------------------------------------

export async function getMainCommit(
  ex: Executor,
  repositoryId: number,
  sha: string,
): Promise<MainCommitRow | undefined> {
  return ex
    .selectFrom("main_commits")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("sha", "=", sha)
    .executeTakeFirst();
}

/** The subset of `shas` already stored for the repository. */
export async function storedShas(
  ex: Executor,
  repositoryId: number,
  shas: readonly string[],
): Promise<Set<string>> {
  if (shas.length === 0) return new Set();
  const rows = await ex
    .selectFrom("main_commits")
    .select("sha")
    .where("repository_id", "=", repositoryId)
    .where("sha", "in", [...shas])
    .execute();
  return new Set(rows.map((r) => r.sha));
}

export async function maxSeq(ex: Executor, repositoryId: number): Promise<number> {
  const row = await ex
    .selectFrom("main_commits")
    .select((eb) => eb.fn.max("seq").as("seq"))
    .where("repository_id", "=", repositoryId)
    .executeTakeFirst();
  return row?.seq === null || row?.seq === undefined ? 0 : Number(row.seq);
}

export interface NewMainCommit {
  sha: string;
  parentSha: string | null;
  chainBreak: boolean;
  prSource: MainCommitsTable["pr_source"];
  changeId: string | null;
  prNumber: number | null;
  committedAt: Date | null;
}

/** Oldest first; each gets the next `seq`. A commit already stored is never rewritten. */
export async function insertMainCommits(
  tx: Transaction<Database>,
  repositoryId: number,
  commits: readonly NewMainCommit[],
  now: Date,
): Promise<number> {
  let seq = await maxSeq(tx, repositoryId);
  let inserted = 0;
  for (const c of commits) {
    const res = await tx
      .insertInto("main_commits")
      .values({
        repository_id: repositoryId,
        sha: c.sha,
        parent_sha: c.parentSha,
        seq: seq + 1,
        chain_break: c.chainBreak,
        pr_source: c.prSource,
        change_id: c.changeId,
        pr_number: c.prNumber,
        committed_at: c.committedAt,
        tracked_at: now,
      })
      .onConflict((oc) => oc.columns(["repository_id", "sha"]).doNothing())
      .executeTakeFirst();
    if (Number(res.numInsertedOrUpdatedRows ?? 0) > 0) {
      seq++;
      inserted++;
    }
  }
  return inserted;
}

export function commitPr(row: Pick<MainCommitRow, "pr_source" | "pr_number">): CommitPr {
  if ((row.pr_source === "change" || row.pr_source === "api") && row.pr_number !== null) {
    return { kind: "pr", number: row.pr_number };
  }
  if (row.pr_source === "multiple") return { kind: "multiple" };
  if (row.pr_source === "direct") return { kind: "direct" };
  return { kind: "unresolved" };
}

export const toChainCommit = (row: MainCommitRow): ChainCommit => ({
  sha: row.sha,
  seq: Number(row.seq),
  chainBreak: row.chain_break,
  pr: commitPr(row),
});

/**
 * The first-parent line that ends at `sha`, oldest first: it follows `parent_sha` back to the
 * nearest chain break (included) or to a parent that is not stored. Following the parents (rather
 * than `seq` alone) keeps a rewound branch's abandoned commits out of the line.
 */
export async function lineTo(
  ex: Executor,
  repositoryId: number,
  sha: string,
): Promise<MainCommitRow[]> {
  const res = await sql<MainCommitRow & { depth: number }>`
    with recursive line as (
      select m.*, 0 as depth from main_commits m
      where m.repository_id = ${repositoryId} and m.sha = ${sha}
      union all
      select p.*, l.depth + 1 from main_commits p
      join line l on p.repository_id = l.repository_id and p.sha = l.parent_sha
      where not l.chain_break and l.depth < ${MAX_LINE}
    )
    select * from line order by depth desc`.execute(ex);
  return res.rows.map(({ depth: _depth, ...row }) => ({
    ...row,
    seq: Number(row.seq),
    pr_number: row.pr_number === null ? null : Number(row.pr_number),
  }));
}

/** The next commit on the chain: the newest stored child of `sha` that is not a chain break. */
export async function childOf(
  ex: Executor,
  repositoryId: number,
  sha: string,
): Promise<MainCommitRow | undefined> {
  return ex
    .selectFrom("main_commits")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("parent_sha", "=", sha)
    .where("chain_break", "=", false)
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
}

// ---------------------------------------------------------------------------------------------
// ci_results
// ---------------------------------------------------------------------------------------------

export interface ObservedResult {
  key: string;
  name: string;
  source: "check_run" | "status";
  class: "green" | "red" | "ignored";
  filtered: boolean;
  htmlUrl: string | null;
  completedAt: Date | null;
}

export async function resultsAt(
  ex: Executor,
  repositoryId: number,
  shas: readonly string[],
  keys?: readonly string[],
): Promise<CiResultRow[]> {
  if (shas.length === 0 || keys?.length === 0) return [];
  let q = ex
    .selectFrom("ci_results")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("sha", "in", [...shas]);
  if (keys !== undefined) q = q.where("key", "in", [...keys]);
  return q.execute();
}

/**
 * §6.3: one row per (repository, sha, key). A newer `completed_at` replaces an older one, an older
 * one never overwrites, and a result that has not completed never replaces one that has. Returns
 * the keys whose class changed (a new row counts as a change).
 */
export async function upsertResults(
  tx: Transaction<Database>,
  repositoryId: number,
  sha: string,
  observed: readonly ObservedResult[],
  now: Date,
): Promise<string[]> {
  const current = new Map(
    (await resultsAt(tx, repositoryId, [sha])).map((r) => [r.key, r] as const),
  );
  const changed: string[] = [];
  for (const o of observed) {
    const old = current.get(o.key);
    if (old) {
      const oldAt = old.completed_at?.getTime() ?? null;
      const newAt = o.completedAt?.getTime() ?? null;
      const newer =
        newAt === null
          ? oldAt === null && (old.class !== o.class || old.filtered !== o.filtered)
          : oldAt === null || newAt > oldAt;
      if (!newer) continue;
    }
    await tx
      .insertInto("ci_results")
      .values({
        repository_id: repositoryId,
        sha,
        key: o.key,
        name: o.name,
        source: o.source,
        class: o.class,
        filtered: o.filtered,
        html_url: o.htmlUrl,
        completed_at: o.completedAt,
        observed_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["repository_id", "sha", "key"]).doUpdateSet({
          name: o.name,
          source: o.source,
          class: o.class,
          filtered: o.filtered,
          html_url: o.htmlUrl,
          completed_at: o.completedAt,
          observed_at: now,
        }),
      )
      .execute();
    if (!old || old.class !== o.class) changed.push(o.key);
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// guard_events
// ---------------------------------------------------------------------------------------------

export async function getEvent(ex: Executor, id: string): Promise<GuardEventRow | undefined> {
  return ex.selectFrom("guard_events").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function getEventForUpdate(
  tx: Transaction<Database>,
  id: string,
): Promise<GuardEventRow | undefined> {
  return tx
    .selectFrom("guard_events")
    .selectAll()
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
}

export async function eventAt(
  ex: Executor,
  repositoryId: number,
  failingSha: string,
): Promise<GuardEventRow | undefined> {
  return ex
    .selectFrom("guard_events")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("failing_sha", "=", failingSha)
    .executeTakeFirst();
}

export async function openEvents(ex: Executor, repositoryId: number): Promise<GuardEventRow[]> {
  return ex
    .selectFrom("guard_events")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("status", "=", "confirming")
    .orderBy("detected_at")
    .orderBy("id")
    .execute();
}

/** `culprit_found` events whose comment is not written yet (a crashed or retried publish). */
export async function eventsAwaitingComment(
  ex: Executor,
  repositoryId: number,
): Promise<GuardEventRow[]> {
  return ex
    .selectFrom("guard_events")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("status", "=", "culprit_found")
    .where("comment_id", "is", null)
    .where("culprit_change_id", "is not", null)
    .orderBy("detected_at")
    .limit(20)
    .execute();
}

export interface NewEvent {
  repositoryId: number;
  branch: string;
  failingSha: string;
  lastGreenSha: string;
  failingChecks: GuardFailingCheck[];
  candidates: GuardCandidate[];
  ciRunUrl: string | null;
  culpritChangeId: string | null;
  status: GuardEventStatus;
  detectedAt: Date;
  confirmedAt: Date | null;
  confirmReason: GuardEventsTable["confirm_reason"];
}

export async function insertEvent(tx: Transaction<Database>, e: NewEvent): Promise<GuardEventRow> {
  return tx
    .insertInto("guard_events")
    .values({
      repository_id: e.repositoryId,
      branch: e.branch,
      failing_sha: e.failingSha,
      last_green_sha: e.lastGreenSha,
      failing_checks: JSON.stringify(e.failingChecks.slice(0, MAX_FAILING_CHECKS)),
      candidates: JSON.stringify(e.candidates),
      ci_run_url: e.ciRunUrl,
      culprit_change_id: e.culpritChangeId,
      status: e.status,
      detected_at: e.detectedAt,
      confirmed_at: e.confirmedAt,
      confirm_reason: e.confirmReason,
      created_at: e.detectedAt,
      updated_at: e.detectedAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateEvent(
  tx: Transaction<Database>,
  id: string,
  set: Partial<{
    failingSha: string;
    lastGreenSha: string;
    failingChecks: GuardFailingCheck[];
    candidates: GuardCandidate[];
    ciRunUrl: string | null;
    culpritChangeId: string | null;
    status: GuardEventStatus;
    confirmedAt: Date | null;
    confirmReason: GuardEventsTable["confirm_reason"];
    commentId: number;
    guardMode: "report" | "enforce";
  }>,
  now: Date,
): Promise<void> {
  await tx
    .updateTable("guard_events")
    .set({
      updated_at: now,
      ...(set.failingSha !== undefined ? { failing_sha: set.failingSha } : {}),
      ...(set.lastGreenSha !== undefined ? { last_green_sha: set.lastGreenSha } : {}),
      ...(set.failingChecks !== undefined
        ? { failing_checks: JSON.stringify(set.failingChecks.slice(0, MAX_FAILING_CHECKS)) }
        : {}),
      ...(set.candidates !== undefined ? { candidates: JSON.stringify(set.candidates) } : {}),
      ...(set.ciRunUrl !== undefined ? { ci_run_url: set.ciRunUrl } : {}),
      ...(set.culpritChangeId !== undefined ? { culprit_change_id: set.culpritChangeId } : {}),
      ...(set.status !== undefined ? { status: set.status } : {}),
      ...(set.confirmedAt !== undefined ? { confirmed_at: set.confirmedAt } : {}),
      ...(set.confirmReason !== undefined ? { confirm_reason: set.confirmReason } : {}),
      ...(set.commentId !== undefined ? { comment_id: set.commentId } : {}),
      ...(set.guardMode !== undefined ? { guard_mode: set.guardMode } : {}),
    })
    .where("id", "=", id)
    .execute();
}

/** `graft guard list`: newest first. */
export async function listEvents(
  ex: Executor,
  repositoryId: number,
  o: { status?: GuardEventStatus; limit: number },
): Promise<(GuardEventRow & { culprit_pr_number: number | null })[]> {
  let q = ex
    .selectFrom("guard_events as e")
    .leftJoin("changes as c", "c.id", "e.culprit_change_id")
    .selectAll("e")
    .select("c.pr_number as culprit_pr_number")
    .where("e.repository_id", "=", repositoryId);
  if (o.status !== undefined) q = q.where("e.status", "=", o.status);
  return q
    .orderBy(sql`coalesce(e.detected_at, e.created_at)`, "desc")
    .orderBy("e.id", "desc")
    .limit(o.limit)
    .execute();
}

// ---------------------------------------------------------------------------------------------
// retention (D15)
// ---------------------------------------------------------------------------------------------

/**
 * Deletes commits and results older than `cutoff`, except the commits an open (`confirming`)
 * event refers to (its failing commit, last green commit and candidates) and their results.
 */
export async function pruneOlderThan(
  db: Db,
  cutoff: Date,
): Promise<{ commits: number; results: number }> {
  return db.transaction().execute(async (tx) => {
    const kept = sql`(
      select e.repository_id, e.failing_sha as sha from guard_events e where e.status = 'confirming'
      union
      select e.repository_id, e.last_green_sha from guard_events e
        where e.status = 'confirming' and e.last_green_sha is not null
      union
      select e.repository_id, c->>'sha' from guard_events e, jsonb_array_elements(e.candidates) c
        where e.status = 'confirming'
    )`;
    const results = await sql`
      delete from ci_results r where r.observed_at < ${cutoff}
        and not exists (select 1 from ${kept} k where k.repository_id = r.repository_id and k.sha = r.sha)`.execute(
      tx,
    );
    const commits = await sql`
      delete from main_commits m where m.tracked_at < ${cutoff}
        and not exists (select 1 from ${kept} k where k.repository_id = m.repository_id and k.sha = m.sha)`.execute(
      tx,
    );
    return {
      commits: Number(commits.numAffectedRows ?? 0),
      results: Number(results.numAffectedRows ?? 0),
    };
  });
}
