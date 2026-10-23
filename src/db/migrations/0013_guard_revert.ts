import { type Kysely, sql } from "kysely";

// Phase 1 step 5: revert pull requests (spec §14). Two new statuses (`needs_human` ends an
// event's revert story; `revert_closed` is a revert PR closed without merge), the columns that
// let `guard.revert` resume after a crash (D17 b), and two indexes: at most one revert per culprit
// (D17 e) and the open-revert count (D13). `revert_pr_number` already exists (0001). Counts, SHAs
// and fixed reason codes only: no path, title or body is stored.
const CHECK_NAME = "guard_events_status_check";

const OLD_STATUSES = `'detected','confirming','culprit_found','ambiguous','no_culprit','flaky',
    'revert_opened','reverted','dismissed','error'`;
const NEW_STATUSES = `'detected','confirming','culprit_found','ambiguous','no_culprit','flaky','needs_human',
    'revert_opened','reverted','revert_closed','dismissed','error'`;

const UP: string[] = [
  `ALTER TABLE guard_events
    DROP CONSTRAINT ${CHECK_NAME},
    ADD CONSTRAINT ${CHECK_NAME} CHECK (status IN (${NEW_STATUSES})),
    ADD COLUMN revert_outcome     text CHECK (revert_outcome IN ('planned','opened','needs_human','skipped','error')),
    ADD COLUMN revert_reason      text CHECK (char_length(revert_reason) <= 40),
    ADD COLUMN revert_claimed_at  timestamptz,
    ADD COLUMN revert_plan_paths  integer,
    ADD COLUMN revert_conflicts   integer,
    ADD COLUMN revert_commit_sha  text CHECK (revert_commit_sha ~ '^[0-9a-f]{40}$'),
    ADD COLUMN revert_branch      text CHECK (revert_branch ~ '^graft-revert/[0-9a-f-]{36}$'),
    ADD COLUMN revert_labelled    boolean NOT NULL DEFAULT false,
    ADD COLUMN auto_merge_state   text CHECK (auto_merge_state IN ('enabled','not_eligible','unavailable','would')),
    ADD COLUMN auto_merge_reason  text CHECK (char_length(auto_merge_reason) <= 40),
    ADD COLUMN reverted_at        timestamptz`,
  `CREATE UNIQUE INDEX guard_events_one_revert_per_culprit
    ON guard_events (repository_id, culprit_change_id) WHERE revert_pr_number IS NOT NULL`,
  `CREATE INDEX guard_events_revert_open_idx ON guard_events (repository_id) WHERE status = 'revert_opened'`,
];

// Fails (the step 4 CHECK rejects it) if a row uses a status this migration added.
const DOWN: string[] = [
  `DROP INDEX IF EXISTS guard_events_revert_open_idx`,
  `DROP INDEX IF EXISTS guard_events_one_revert_per_culprit`,
  `ALTER TABLE guard_events
    DROP CONSTRAINT ${CHECK_NAME},
    ADD CONSTRAINT ${CHECK_NAME} CHECK (status IN (${OLD_STATUSES})),
    DROP COLUMN IF EXISTS reverted_at,
    DROP COLUMN IF EXISTS auto_merge_reason,
    DROP COLUMN IF EXISTS auto_merge_state,
    DROP COLUMN IF EXISTS revert_labelled,
    DROP COLUMN IF EXISTS revert_branch,
    DROP COLUMN IF EXISTS revert_commit_sha,
    DROP COLUMN IF EXISTS revert_conflicts,
    DROP COLUMN IF EXISTS revert_plan_paths,
    DROP COLUMN IF EXISTS revert_claimed_at,
    DROP COLUMN IF EXISTS revert_reason,
    DROP COLUMN IF EXISTS revert_outcome`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
