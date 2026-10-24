import { type Kysely, sql } from "kysely";

// Phase 1 step 7 (D16): M2 compares Phase 1 review time with the pre-Graft baseline on the same
// definition, so `pnpm graft baseline --period phase1` stores its runs next to the baseline and
// shadow ones. `0006` declared the CHECK inline, so Postgres named it `review_time_runs_period_check`.
// Nothing else is stored: D8's `mcpExclusion` lives in `policy_verdicts.approvals` and D13 uses the
// existing `guard_events.guard_mode`.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE review_time_runs DROP CONSTRAINT review_time_runs_period_check,
    ADD CONSTRAINT review_time_runs_period_check CHECK (period IN ('baseline','shadow','phase1'))`.execute(
    db,
  );
}

/** Refuses while a `phase1` run exists: the rollback never drops measured data. */
export async function down(db: Kysely<unknown>): Promise<void> {
  const rows = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM review_time_runs WHERE period = 'phase1'`.execute(db);
  if (Number(rows.rows[0]?.n ?? 0) > 0) {
    throw new Error("0016_phase1_gate down: phase1 review time runs exist; delete them first");
  }
  await sql`ALTER TABLE review_time_runs DROP CONSTRAINT review_time_runs_period_check,
    ADD CONSTRAINT review_time_runs_period_check CHECK (period IN ('baseline','shadow'))`.execute(
    db,
  );
}
