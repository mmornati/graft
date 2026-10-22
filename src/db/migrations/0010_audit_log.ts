import { type Kysely, sql } from "kysely";

// Phase 1 step 3: break-glass and the audit log (spec §5). `audit_log` is append-only: one row per
// break-glass request Graft acted on (applied, ignored, stale, removed). Rows hold IDs, SHAs, the
// actor's id, login and role, and the mode; never the label name (configuration) or PR text. The
// partial unique indexes bound what repeated labelling can write (D7).
//
// `policy_verdicts.enforced_reason` gains `break_glass`. Its 0009 CHECK is inline and unnamed, so
// Postgres named it `policy_verdicts_enforced_reason_check`; `up` asserts that name first.
const REASON_CHECK = "policy_verdicts_enforced_reason_check";
const STEP2_REASONS = `'approved_by_policy','requirements_met','no_policy','policy_invalid','blocked',
      'reviews_truncated','changes_requested','approvals_missing','card_pending'`;

const UP: string[] = [
  `CREATE TABLE audit_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id   bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    change_id       uuid   NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    pr_number       integer NOT NULL,
    head_sha        text   NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
    kind            text   NOT NULL CHECK (kind IN ('applied','ignored','stale','removed')),
    reason          text   CHECK (reason IN ('role_too_low','bot','role_unverified','actor_unknown','head_moved')),
    actor_id        bigint,
    actor_login     text   CHECK (char_length(actor_login) <= 100),
    actor_role      text   CHECK (actor_role IN ('admin','maintain','write','triage','read','none')),
    self            boolean NOT NULL DEFAULT false,
    policy_mode     text   NOT NULL CHECK (policy_mode IN ('report','enforce')),
    label_event_at  timestamptz,
    created_at      timestamptz NOT NULL,
    CHECK ((kind IN ('ignored','stale')) = (reason IS NOT NULL))
  )`,
  `CREATE INDEX audit_log_change_idx ON audit_log (change_id, head_sha, created_at)`,
  `CREATE INDEX audit_log_repo_idx ON audit_log (repository_id, created_at DESC)`,
  `CREATE UNIQUE INDEX audit_log_ignored_once ON audit_log (change_id, head_sha, actor_id) WHERE kind = 'ignored'`,
  `CREATE UNIQUE INDEX audit_log_stale_once ON audit_log (change_id, head_sha) WHERE kind = 'stale'`,
  `ALTER TABLE policy_verdicts DROP CONSTRAINT ${REASON_CHECK}`,
  `ALTER TABLE policy_verdicts ADD CONSTRAINT ${REASON_CHECK}
    CHECK (enforced_reason IN (${STEP2_REASONS},'break_glass'))`,
];

// Fails (the restored CHECK rejects it) if a verdict row has `enforced_reason = 'break_glass'`.
const DOWN: string[] = [
  `ALTER TABLE policy_verdicts DROP CONSTRAINT ${REASON_CHECK}`,
  `ALTER TABLE policy_verdicts ADD CONSTRAINT ${REASON_CHECK}
    CHECK (enforced_reason IN (${STEP2_REASONS}))`,
  `DROP TABLE IF EXISTS audit_log`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  const found = await sql<{ n: number }>`
    select count(*)::int as n from pg_constraint
    where conrelid = 'policy_verdicts'::regclass and conname = ${REASON_CHECK}`.execute(db);
  if (found.rows[0]?.n !== 1) {
    throw new Error(`0010_audit_log: constraint ${REASON_CHECK} not found on policy_verdicts`);
  }
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
