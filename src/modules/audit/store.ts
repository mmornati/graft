/**
 * The audit log (Phase 1 step 3, spec §5, D6 to D8). Append-only: this file inserts and reads,
 * never updates or deletes (only `pilot purge` deletes, through the cascade from `repositories`).
 *
 * "Later" between two rows of the same (change, head) compares `created_at`; on a tie a `removed`
 * row counts as later than an `applied` one, so an ambiguous order never keeps a bypass alive.
 */
import { type Selectable, sql, type Transaction } from "kysely";
import type { Db } from "../../db/client.js";
import type { AuditLogTable, Database } from "../../db/schema.js";

type Executor = Db | Transaction<Database>;
export type AuditRow = Selectable<AuditLogTable>;
export type AuditKind = AuditLogTable["kind"];
export type AuditReason = NonNullable<AuditLogTable["reason"]>;
export type AuditRole = NonNullable<AuditLogTable["actor_role"]>;
export const AUDIT_KINDS: readonly AuditKind[] = ["applied", "ignored", "stale", "removed"];

export interface NewAuditRow {
  repositoryId: number;
  changeId: string;
  prNumber: number;
  /** The live head from `pulls.get` (API data), never the payload's. */
  headSha: string;
  kind: AuditKind;
  reason: AuditReason | null;
  actor: { id: number; login: string } | null;
  role: AuditRole | null;
  self: boolean;
  policyMode: "report" | "enforce";
  labelEventAt: Date | null;
  createdAt: Date;
}

/**
 * The `applied` row that makes a break-glass active for (change, head) (D6, D8): the latest
 * `applied` row with no `removed` row at or after it. Undefined when there is none.
 */
export async function activeBreakGlass(
  ex: Executor,
  changeId: string,
  headSha: string,
): Promise<AuditRow | undefined> {
  return ex
    .selectFrom("audit_log as a")
    .selectAll("a")
    .where("a.change_id", "=", changeId)
    .where("a.head_sha", "=", headSha)
    .where("a.kind", "=", "applied")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("audit_log as r")
            .select(sql<number>`1`.as("one"))
            .whereRef("r.change_id", "=", "a.change_id")
            .whereRef("r.head_sha", "=", "a.head_sha")
            .where("r.kind", "=", "removed")
            .whereRef("r.created_at", ">=", "a.created_at"),
        ),
      ),
    )
    .orderBy("a.created_at", "desc")
    .limit(1)
    .executeTakeFirst();
}

/**
 * D8, for the post-merge guard (step 5): was this change merged under break-glass? True when an
 * `applied` row exists for its final head with no later `removed` row.
 */
export async function mergedUnderBreakGlass(
  ex: Executor,
  changeId: string,
  headSha: string,
): Promise<boolean> {
  return (await activeBreakGlass(ex, changeId, headSha)) !== undefined;
}

/** The newest row of (change, head), or undefined. What the comment shows between label events. */
export async function latestAuditForHead(
  ex: Executor,
  changeId: string,
  headSha: string,
): Promise<AuditRow | undefined> {
  return ex
    .selectFrom("audit_log")
    .selectAll()
    .where("change_id", "=", changeId)
    .where("head_sha", "=", headSha)
    .orderBy("created_at", "desc")
    .orderBy(sql`case kind when 'removed' then 0 else 1 end`)
    .limit(1)
    .executeTakeFirst();
}

/**
 * Insert one row, with the D7 rules; returns whether a row was written. Call it inside the change
 * lock (every writer of a change's rows holds it), so the checks below cannot race:
 * - `applied`: never a second one while one is active for (change, head);
 * - `removed`: only while one is active (the label taken off while applied);
 * - `ignored`: at most one per (change, head, actor), the unknown actor included;
 * - `stale`: at most one per (change, head).
 * The partial unique indexes back the last two (`ON CONFLICT DO NOTHING`).
 */
export async function insertAuditRow(
  tx: Transaction<Database>,
  row: NewAuditRow,
): Promise<boolean> {
  const active = await activeBreakGlass(tx, row.changeId, row.headSha);
  if (row.kind === "applied" && active) return false;
  if (row.kind === "removed" && !active) return false;
  if (row.kind === "ignored" || row.kind === "stale") {
    let q = tx
      .selectFrom("audit_log")
      .select("id")
      .where("change_id", "=", row.changeId)
      .where("head_sha", "=", row.headSha)
      .where("kind", "=", row.kind);
    if (row.kind === "ignored") {
      q =
        row.actor === null
          ? q.where("actor_id", "is", null)
          : q.where("actor_id", "=", row.actor.id);
    }
    if (await q.executeTakeFirst()) return false;
  }
  const res = await tx
    .insertInto("audit_log")
    .values({
      repository_id: row.repositoryId,
      change_id: row.changeId,
      pr_number: row.prNumber,
      head_sha: row.headSha,
      kind: row.kind,
      reason: row.reason,
      actor_id: row.actor?.id ?? null,
      actor_login: row.actor?.login ?? null,
      actor_role: row.role,
      self: row.self,
      policy_mode: row.policyMode,
      label_event_at: row.labelEventAt,
      created_at: row.createdAt,
    })
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  return Number(res.numInsertedOrUpdatedRows ?? 0n) > 0;
}

export interface AuditQuery {
  repositoryId: number;
  since?: Date | undefined;
  kind?: AuditKind | undefined;
  /** 1 to 500. */
  limit: number;
}

/** Newest first (§8). */
export async function listAudit(ex: Executor, q: AuditQuery): Promise<AuditRow[]> {
  let query = ex.selectFrom("audit_log").selectAll().where("repository_id", "=", q.repositoryId);
  if (q.since !== undefined) query = query.where("created_at", ">=", q.since);
  if (q.kind !== undefined) query = query.where("kind", "=", q.kind);
  return query.orderBy("created_at", "desc").orderBy("id", "desc").limit(q.limit).execute();
}

/** `applied` rows since `since`, per active repository of an installation (the doctor, T7). */
export async function countAppliedSince(
  ex: Executor,
  installationId: number,
  since: Date,
): Promise<{ fullName: string; n: number }[]> {
  const rows = await ex
    .selectFrom("audit_log as a")
    .innerJoin("repositories as r", "r.id", "a.repository_id")
    .select(["r.full_name as fullName", (eb) => eb.fn.countAll<string>().as("n")])
    .where("r.installation_id", "=", installationId)
    .where("r.removed_at", "is", null)
    .where("a.kind", "=", "applied")
    .where("a.created_at", ">=", since)
    .groupBy("r.full_name")
    .orderBy("r.full_name")
    .execute();
  return rows.map((r) => ({ fullName: r.fullName, n: Number(r.n) }));
}
