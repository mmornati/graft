import { type Selectable, sql, type Transaction } from "kysely";
import type { Db } from "../../db/client.js";
import type { Database, IncidentsTable } from "../../db/schema.js";

type Executor = Db | Transaction<Database>;
export type IncidentRow = Selectable<IncidentsTable>;

/** Insert reviewer ids for a change; existing (change, user, reason) rows stay as they are. */
export async function addReviewers(
  ex: Executor,
  changeId: string,
  rows: readonly { userId: number; reason: "requested" | "reviewed" }[],
  now: Date,
): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await ex
    .insertInto("pr_reviewers")
    .values(
      rows.map((r) => ({
        change_id: changeId,
        user_id: r.userId,
        reason: r.reason,
        first_seen_at: now,
      })),
    )
    .onConflict((oc) => oc.columns(["change_id", "user_id", "reason"]).doNothing())
    .returning("user_id")
    .execute();
  return res.length;
}

/**
 * Record an incident. A row with the same (repository, culprit, fix) is left alone. Returns
 * whether a row was inserted.
 */
export async function insertIncident(
  ex: Executor,
  row: {
    repositoryId: number;
    culpritPrNumber: number | null;
    fixPrNumber: number | null;
    source: "cli" | "label";
    severity: number | null;
    occurredAt: Date;
    recordedAt: Date;
  },
): Promise<boolean> {
  const res = await ex
    .insertInto("incidents")
    .values({
      repository_id: row.repositoryId,
      culprit_pr_number: row.culpritPrNumber,
      fix_pr_number: row.fixPrNumber,
      source: row.source,
      severity: row.severity,
      occurred_at: row.occurredAt,
      recorded_at: row.recordedAt,
    })
    .onConflict((oc) =>
      oc.columns(["repository_id", "culprit_pr_number", "fix_pr_number"]).doNothing(),
    )
    .returning("id")
    .execute();
  return res.length > 0;
}

/** The label row of a fix PR that has no culprit yet (a label without a link). */
export async function findUnlinkedIncident(
  ex: Executor,
  repositoryId: number,
  fixPrNumber: number,
): Promise<IncidentRow | undefined> {
  return ex
    .selectFrom("incidents")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("fix_pr_number", "=", fixPrNumber)
    .where("culprit_pr_number", "is", null)
    .executeTakeFirst();
}

export async function listIncidents(
  ex: Executor,
  installationId: number,
): Promise<(IncidentRow & { full_name: string })[]> {
  const res = await sql<IncidentRow & { full_name: string }>`
    select i.*, r.full_name
    from incidents i join repositories r on r.id = i.repository_id
    where r.installation_id = ${installationId}
    order by i.occurred_at, i.id`.execute(ex);
  return res.rows;
}
