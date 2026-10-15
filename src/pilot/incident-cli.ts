/** `pnpm graft incident add | list | remove` (step 6, T5). Numbers and timestamps only. */
import { sql } from "kysely";
import type { Db } from "../db/client.js";
import {
  findUnlinkedIncident,
  type IncidentRow,
  insertIncident,
  listIncidents,
} from "../modules/pilot/index.js";

export class IncidentUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentUsageError";
  }
}

export interface AddIncident {
  repo: string;
  pr: number;
  fixPr?: number | undefined;
  occurredAt?: Date | undefined;
  severity?: number | undefined;
}

export interface AddResult {
  outcome: "inserted" | "updated" | "exists";
  id: string | null;
  /** For stderr: the culprit PR is unknown to Graft. */
  warnings: string[];
}

export async function addIncident(db: Db, now: Date, a: AddIncident): Promise<AddResult> {
  if (
    a.severity !== undefined &&
    !(Number.isInteger(a.severity) && a.severity >= 1 && a.severity <= 4)
  ) {
    throw new IncidentUsageError("--severity must be 1 to 4");
  }
  const repo = await db
    .selectFrom("repositories")
    .select(["id", "full_name"])
    .where(sql<string>`lower(full_name)`, "=", a.repo.toLowerCase())
    .executeTakeFirst();
  if (!repo) throw new IncidentUsageError("repository not found");
  const warnings: string[] = [];
  const known = await sql<{ n: string }>`
    select (
      (select count(*) from changes where repository_id = ${repo.id} and pr_number = ${a.pr}) +
      (select count(*) from review_time_prs p join review_time_runs r on r.id = p.run_id
        where r.repository_id = ${repo.id} and p.pr_number = ${a.pr})
    )::text as n`.execute(db);
  if (Number(known.rows[0]?.n ?? 0) === 0) {
    warnings.push(
      `PR #${a.pr} is in neither the changes table nor any baseline run of this repository`,
    );
  }
  const occurredAt = a.occurredAt ?? now;

  if (a.fixPr !== undefined) {
    const unlinked = await findUnlinkedIncident(db, repo.id, a.fixPr);
    if (unlinked) {
      const taken = await db
        .selectFrom("incidents")
        .select("id")
        .where("repository_id", "=", repo.id)
        .where("culprit_pr_number", "=", a.pr)
        .where("fix_pr_number", "=", a.fixPr)
        .executeTakeFirst();
      if (taken) return { outcome: "exists", id: taken.id, warnings };
      await db
        .updateTable("incidents")
        .set({
          culprit_pr_number: a.pr,
          ...(a.severity !== undefined ? { severity: a.severity } : {}),
          ...(a.occurredAt !== undefined ? { occurred_at: a.occurredAt } : {}),
        })
        .where("id", "=", unlinked.id)
        .execute();
      return { outcome: "updated", id: unlinked.id, warnings };
    }
  }
  const inserted = await insertIncident(db, {
    repositoryId: repo.id,
    culpritPrNumber: a.pr,
    fixPrNumber: a.fixPr ?? null,
    source: "cli",
    severity: a.severity ?? null,
    occurredAt,
    recordedAt: now,
  });
  const row = await db
    .selectFrom("incidents")
    .select("id")
    .where("repository_id", "=", repo.id)
    .where("culprit_pr_number", "=", a.pr)
    .where(
      a.fixPr === undefined
        ? sql<boolean>`fix_pr_number is null`
        : sql<boolean>`fix_pr_number = ${a.fixPr}`,
    )
    .executeTakeFirst();
  return { outcome: inserted ? "inserted" : "exists", id: row?.id ?? null, warnings };
}

export async function incidentList(
  db: Db,
  installationId: number,
): Promise<(IncidentRow & { full_name: string })[]> {
  return listIncidents(db, installationId);
}

export async function removeIncident(db: Db, id: string): Promise<boolean> {
  const res = await db.deleteFrom("incidents").where("id", "=", id).returning("id").execute();
  return res.length > 0;
}
