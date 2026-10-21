import { type Kysely, sql } from "kysely";

// Phase 1 step 2: the enforce conclusion (spec §11). `enforced_conclusion` and `enforced_reason`
// are what enforce mode would publish, computed and stored in every mode (D10); NULL on rows
// written before this migration. `check_conclusion` (what was published) gains `pending`, for a
// check published `in_progress` while the intent card is written (D9).
//
// The 0005 CHECK on `check_conclusion` is inline and unnamed, so Postgres named it
// `policy_verdicts_check_conclusion_check`; `up` asserts that name before dropping it.
const CHECK_NAME = "policy_verdicts_check_conclusion_check";

const UP: string[] = [
  `ALTER TABLE policy_verdicts
    ADD COLUMN enforced_conclusion text CHECK (enforced_conclusion IN ('success','failure','pending')),
    ADD COLUMN enforced_reason     text CHECK (enforced_reason IN (
      'approved_by_policy','requirements_met','no_policy','policy_invalid','blocked',
      'reviews_truncated','changes_requested','approvals_missing','card_pending')),
    ADD CONSTRAINT policy_verdicts_enforced_pair_check
      CHECK ((enforced_conclusion IS NULL) = (enforced_reason IS NULL))`,
  `ALTER TABLE policy_verdicts DROP CONSTRAINT ${CHECK_NAME}`,
  `ALTER TABLE policy_verdicts ADD CONSTRAINT ${CHECK_NAME}
    CHECK (check_conclusion IN ('neutral','success','failure','action_required','pending'))`,
];

// Fails (the old CHECK rejects it) if a row was published `pending`: such a row cannot be stored
// under the step 1 schema.
const DOWN: string[] = [
  `ALTER TABLE policy_verdicts DROP CONSTRAINT ${CHECK_NAME}`,
  `ALTER TABLE policy_verdicts ADD CONSTRAINT ${CHECK_NAME}
    CHECK (check_conclusion IN ('neutral','success','failure','action_required'))`,
  `ALTER TABLE policy_verdicts
    DROP CONSTRAINT IF EXISTS policy_verdicts_enforced_pair_check,
    DROP COLUMN IF EXISTS enforced_reason,
    DROP COLUMN IF EXISTS enforced_conclusion`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  const found = await sql<{ n: number }>`
    select count(*)::int as n from pg_constraint
    where conrelid = 'policy_verdicts'::regclass and conname = ${CHECK_NAME}`.execute(db);
  if (found.rows[0]?.n !== 1) {
    throw new Error(`0009_enforce: constraint ${CHECK_NAME} not found on policy_verdicts`);
  }
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
