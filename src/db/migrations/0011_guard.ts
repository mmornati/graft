import { type Kysely, sql } from "kysely";

// Phase 1 step 4: the post-merge guard (spec §11). Two new tables, `main_commits` (the
// first-parent history of each default branch) and `ci_results` (the latest class per check and
// commit: name, source and class only, never output or logs), and the columns `guard_events`
// needs for detection and confirmation.
//
// The 0001 CHECK on `guard_events.status` is inline and unnamed, so Postgres named it
// `guard_events_status_check`; `up` asserts that name before dropping it.
//
// The number: step 3 (break-glass) takes 0010 and was built at the same time. Whichever of the two
// merges second checks the order (the migrator refuses migrations out of order).
const CHECK_NAME = "guard_events_status_check";
const SHA = "'^[0-9a-f]{40}$'";

const OLD_STATUSES = `'detected','culprit_found','revert_opened','reverted','dismissed','error'`;
const NEW_STATUSES = `'detected','confirming','culprit_found','ambiguous','no_culprit','flaky',
    'revert_opened','reverted','dismissed','error'`;

const UP: string[] = [
  `CREATE TABLE main_commits (
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    sha           text   NOT NULL CHECK (sha ~ ${SHA}),
    parent_sha    text            CHECK (parent_sha ~ ${SHA}),
    seq           bigint NOT NULL,
    chain_break   boolean NOT NULL DEFAULT false,
    pr_source     text NOT NULL CHECK (pr_source IN ('change','api','direct','multiple','unresolved')),
    change_id     uuid REFERENCES changes(id) ON DELETE SET NULL,
    pr_number     integer,
    committed_at  timestamptz,
    tracked_at    timestamptz NOT NULL,
    PRIMARY KEY (repository_id, sha),
    UNIQUE (repository_id, seq),
    CHECK ((pr_source IN ('change','api')) = (pr_number IS NOT NULL))
  )`,
  `CREATE TABLE ci_results (
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    sha           text   NOT NULL CHECK (sha ~ ${SHA}),
    key           text   NOT NULL CHECK (char_length(key) <= 240),
    name          text   NOT NULL CHECK (char_length(name) <= 200),
    source        text   NOT NULL CHECK (source IN ('check_run','status')),
    class         text   NOT NULL CHECK (class IN ('green','red','ignored')),
    filtered      boolean NOT NULL DEFAULT false,
    html_url      text   CHECK (char_length(html_url) <= 500),
    completed_at  timestamptz,
    observed_at   timestamptz NOT NULL,
    PRIMARY KEY (repository_id, sha, key)
  )`,
  `ALTER TABLE guard_events
    DROP CONSTRAINT ${CHECK_NAME},
    ADD CONSTRAINT ${CHECK_NAME} CHECK (status IN (${NEW_STATUSES})),
    ADD COLUMN last_green_sha   text CHECK (last_green_sha ~ ${SHA}),
    ADD COLUMN failing_checks   jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN candidates       jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN detected_at      timestamptz,
    ADD COLUMN confirmed_at     timestamptz,
    ADD COLUMN confirm_reason   text CHECK (confirm_reason IN ('next_commit','window','off','flaky_rerun','flaky_next')),
    ADD COLUMN comment_id       bigint,
    ADD COLUMN guard_mode       text CHECK (guard_mode IN ('report','enforce'))`,
  `CREATE INDEX guard_events_open_idx ON guard_events (repository_id) WHERE status = 'confirming'`,
];

// Fails (the old CHECK rejects it) if a row uses a status this migration added.
const DOWN: string[] = [
  `DROP INDEX IF EXISTS guard_events_open_idx`,
  `ALTER TABLE guard_events
    DROP CONSTRAINT ${CHECK_NAME},
    ADD CONSTRAINT ${CHECK_NAME} CHECK (status IN (${OLD_STATUSES})),
    DROP COLUMN IF EXISTS guard_mode,
    DROP COLUMN IF EXISTS comment_id,
    DROP COLUMN IF EXISTS confirm_reason,
    DROP COLUMN IF EXISTS confirmed_at,
    DROP COLUMN IF EXISTS detected_at,
    DROP COLUMN IF EXISTS candidates,
    DROP COLUMN IF EXISTS failing_checks,
    DROP COLUMN IF EXISTS last_green_sha`,
  `DROP TABLE IF EXISTS ci_results`,
  `DROP TABLE IF EXISTS main_commits`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  const found = await sql<{ n: number }>`
    select count(*)::int as n from pg_constraint
    where conrelid = 'guard_events'::regclass and conname = ${CHECK_NAME}`.execute(db);
  if (found.rows[0]?.n !== 1) {
    throw new Error(`0011_guard: constraint ${CHECK_NAME} not found on guard_events`);
  }
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
