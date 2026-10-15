import { type Kysely, sql } from "kysely";

// Step 6: pilots and gate (spec §6). Numbers, ids, flags and counts only: no titles, bodies,
// paths, logins (not even hashed), SHAs or code. `pilot_purges` has no foreign key: it outlives
// the purge it records.
const UP: string[] = [
  `ALTER TABLE intent_spend ADD COLUMN cost_usd numeric(14,8)`,
  `CREATE TABLE pr_reviewers (
    change_id     uuid   NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    user_id       bigint NOT NULL,
    reason        text   NOT NULL CHECK (reason IN ('requested','reviewed')),
    first_seen_at timestamptz NOT NULL,
    PRIMARY KEY (change_id, user_id, reason)
  )`,
  `CREATE TABLE review_time_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id  bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    period         text   NOT NULL CHECK (period IN ('baseline','shadow')),
    from_date      date   NOT NULL,
    to_date        date   NOT NULL CHECK (to_date > from_date),
    base_ref       text   NOT NULL,
    extractor_version integer NOT NULL,
    pr_count       integer NOT NULL,
    excluded_count integer NOT NULL,
    aggregates     jsonb  NOT NULL,
    requests       integer NOT NULL,
    extracted_at   timestamptz NOT NULL
  )`,
  `CREATE INDEX review_time_runs_repo_idx ON review_time_runs (repository_id, period, extracted_at DESC)`,
  `CREATE TABLE review_time_prs (
    run_id        uuid    NOT NULL REFERENCES review_time_runs(id) ON DELETE CASCADE,
    pr_number     integer NOT NULL,
    state         text    NOT NULL CHECK (state IN ('merged','closed','open')),
    author_kind   text    NOT NULL CHECK (author_kind IN ('agent','human')),
    author_kind_reason text NOT NULL,
    size_bucket   text    NOT NULL CHECK (size_bucket IN ('S','M','L','XL')),
    start_basis   text    NOT NULL CHECK (start_basis IN ('review_requested','ready_for_review','opened')),
    minutes_to_first_approval numeric(12,1),
    minutes_to_merge numeric(12,1),
    review_rounds integer NOT NULL,
    merged_without_review boolean NOT NULL,
    paused_minutes numeric(12,1) NOT NULL,
    excluded_reason text CHECK (excluded_reason IN ('excluded_author','timeline_truncated','commits_truncated')),
    PRIMARY KEY (run_id, pr_number)
  )`,
  `CREATE TABLE incidents (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id      bigint  NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    culprit_pr_number  integer,
    fix_pr_number      integer,
    source             text    NOT NULL CHECK (source IN ('cli','label')),
    severity           smallint CHECK (severity BETWEEN 1 AND 4),
    occurred_at        timestamptz NOT NULL,
    recorded_at        timestamptz NOT NULL,
    UNIQUE NULLS NOT DISTINCT (repository_id, culprit_pr_number, fix_pr_number)
  )`,
  `CREATE TABLE metrics_daily (
    repository_id  bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    day            date   NOT NULL,
    rollup_version integer NOT NULL,
    counts         jsonb  NOT NULL,
    computed_at    timestamptz NOT NULL,
    PRIMARY KEY (repository_id, day)
  )`,
  `CREATE TABLE pilot_purges (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id  bigint NOT NULL,
    rows_deleted     jsonb  NOT NULL,
    purged_at        timestamptz NOT NULL
  )`,
];

const DOWN: string[] = [
  `DROP TABLE IF EXISTS pilot_purges`,
  `DROP TABLE IF EXISTS metrics_daily`,
  `DROP TABLE IF EXISTS incidents`,
  `DROP TABLE IF EXISTS review_time_prs`,
  `DROP TABLE IF EXISTS review_time_runs`,
  `DROP TABLE IF EXISTS pr_reviewers`,
  `ALTER TABLE intent_spend DROP COLUMN IF EXISTS cost_usd`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
