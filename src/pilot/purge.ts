/**
 * Offboarding (step 6, T11, D11): delete everything Graft holds for one installation, and write a
 * `pilot_purges` row (installation id, counts, time; no login) that outlives it. The application
 * tables are deleted by the foreign-key cascade from `installations`; `webhook_deliveries` (no FK)
 * and the pg-boss jobs (whose data holds webhook payloads) are deleted explicitly.
 */
import { type RawBuilder, sql } from "kysely";
import type { Db } from "../db/client.js";
import type { TABLE_NAMES } from "../db/schema.js";

/**
 * `pilot_purges` records the purge itself. `service_state` holds server facts (the ceiling the
 * worker last published) and no installation data, so there is nothing of an installation in it.
 */
export type PurgedTable = Exclude<(typeof TABLE_NAMES)[number], "pilot_purges" | "service_state">;

const repos = (i: number) => sql`(select id from repositories where installation_id = ${i})`;
const changes = (i: number) =>
  sql`(select ch.id from changes ch where ch.repository_id in ${repos(i)})`;

/**
 * Per table, the rows that belong to an installation. This map is the purge's verification: its
 * type (and I-PURGE-2) require an entry for every table in `TABLE_NAMES` except `pilot_purges`
 * (no personal data; it records the purge) and `service_state` (no installation data), so a future
 * table without a purge path fails.
 */
export const OWNED_ROWS: Record<PurgedTable, (installationId: number) => RawBuilder<unknown>> = {
  installations: (i) => sql`select count(*) as n from installations where id = ${i}`,
  repositories: (i) => sql`select count(*) as n from repositories where installation_id = ${i}`,
  tasks: (i) => sql`select count(*) as n from tasks where repository_id in ${repos(i)}`,
  changes: (i) => sql`select count(*) as n from changes where repository_id in ${repos(i)}`,
  provenance: (i) => sql`select count(*) as n from provenance where change_id in ${changes(i)}`,
  change_provenance: (i) =>
    sql`select count(*) as n from change_provenance where change_id in ${changes(i)}`,
  intent_cards: (i) => sql`select count(*) as n from intent_cards where change_id in ${changes(i)}`,
  intent_feedback: (i) =>
    sql`select count(*) as n from intent_feedback where change_id in ${changes(i)}`,
  intent_spend: (i) =>
    sql`select count(*) as n from intent_spend where repository_id in ${repos(i)}`,
  intent_displays: (i) =>
    sql`select count(*) as n from intent_displays where change_id in ${changes(i)}`,
  policy_verdicts: (i) =>
    sql`select count(*) as n from policy_verdicts where change_id in ${changes(i)}`,
  guard_events: (i) =>
    sql`select count(*) as n from guard_events where repository_id in ${repos(i)}`,
  webhook_deliveries: (i) =>
    sql`select count(*) as n from webhook_deliveries where installation_id = ${i} or repository_id in ${repos(i)}`,
  pr_reviewers: (i) => sql`select count(*) as n from pr_reviewers where change_id in ${changes(i)}`,
  reviewer_check_denials: (i) =>
    sql`select count(*) as n from reviewer_check_denials where change_id in ${changes(i)}`,
  review_time_runs: (i) =>
    sql`select count(*) as n from review_time_runs where repository_id in ${repos(i)}`,
  review_time_prs: (i) =>
    sql`select count(*) as n from review_time_prs where run_id in (select id from review_time_runs where repository_id in ${repos(i)})`,
  incidents: (i) => sql`select count(*) as n from incidents where repository_id in ${repos(i)}`,
  metrics_daily: (i) =>
    sql`select count(*) as n from metrics_daily where repository_id in ${repos(i)}`,
  mode_changes: (i) =>
    sql`select count(*) as n from mode_changes where repository_id in ${repos(i)}`,
  // Phase 1 step 3: break-glass rows hold actor logins; they cascade from `repositories`.
  audit_log: (i) => sql`select count(*) as n from audit_log where repository_id in ${repos(i)}`,
};

export class PurgeRefused extends Error {
  constructor(readonly reason: "confirm_mismatch" | "active" | "not_found") {
    super(
      reason === "confirm_mismatch"
        ? "--confirm does not match the account login of the installation"
        : reason === "active"
          ? "the installation is still active (not uninstalled); use --even-if-active"
          : "installation not found",
    );
    this.name = "PurgeRefused";
  }
}

export interface PurgeResult {
  dryRun: boolean;
  /** Rows per table, plus `pgboss_jobs`. */
  counts: Record<string, number>;
  purgeId: string | null;
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export async function purgeInstallation(
  db: Db,
  o: {
    installationId: number;
    schema: string;
    now: Date;
    dryRun: boolean;
    /** Must equal the account login (case-insensitive) when given. */
    confirm?: string | undefined;
    evenIfActive?: boolean | undefined;
  },
): Promise<PurgeResult> {
  return db.transaction().execute(async (tx) => {
    const inst = await tx
      .selectFrom("installations")
      .select(["account_login", "deleted_at"])
      .where("id", "=", o.installationId)
      .executeTakeFirst();
    if (!inst) throw new PurgeRefused("not_found");
    if (o.confirm !== undefined && o.confirm.toLowerCase() !== inst.account_login.toLowerCase()) {
      throw new PurgeRefused("confirm_mismatch");
    }
    // A dry run deletes nothing, so it may look at an installation that is still active.
    if (inst.deleted_at === null && o.evenIfActive !== true && !o.dryRun) {
      throw new PurgeRefused("active");
    }

    const counts: Record<string, number> = {};
    for (const table of Object.keys(OWNED_ROWS) as PurgedTable[]) {
      const res = await (OWNED_ROWS[table](o.installationId) as RawBuilder<{ n: string }>).execute(
        tx,
      );
      counts[table] = Number(res.rows[0]?.n ?? 0);
    }
    const id = String(o.installationId);
    const jobWhere = sql`data->>'installationId' = ${id} or data->'payload'->'installation'->>'id' = ${id}`;
    const hasBoss = (
      await sql<{
        r: string | null;
      }>`select to_regclass(${`${quote(o.schema)}.job`})::text as r`.execute(tx)
    ).rows[0]?.r;
    let jobs = 0;
    if (hasBoss) {
      const res = await sql<{ n: string }>`
        select count(*)::text as n from ${sql.raw(quote(o.schema))}.job where ${jobWhere}`.execute(
        tx,
      );
      jobs = Number(res.rows[0]?.n ?? 0);
    }
    counts.pgboss_jobs = jobs;
    if (o.dryRun) return { dryRun: true, counts, purgeId: null };

    await sql`delete from webhook_deliveries
      where installation_id = ${o.installationId}
         or repository_id in ${repos(o.installationId)}`.execute(tx);
    if (hasBoss) {
      // The parent table holds every queue's rows (job_common and any per-queue partition).
      await sql`delete from ${sql.raw(quote(o.schema))}.job where ${jobWhere}`.execute(tx);
    }
    await tx.deleteFrom("installations").where("id", "=", o.installationId).execute();
    const row = await tx
      .insertInto("pilot_purges")
      .values({
        installation_id: o.installationId,
        rows_deleted: JSON.stringify(counts),
        purged_at: o.now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { dryRun: false, counts, purgeId: row.id };
  });
}
