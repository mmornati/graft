import { type Kysely, sql } from "kysely";

const SHA = "'^[0-9a-f]{40}$'";

// Step 5: the policy verdicts table (spec §11). The 0001 table was never written by any code, so
// `up` drops and recreates it. Rows hold rule indices, reason codes, PR paths, counts, SHAs and
// the policy hash; never globs, rule names, team slugs or YAML text.
const UP: string[] = [
  `DROP TABLE policy_verdicts`,
  `CREATE TABLE policy_verdicts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id           uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    head_sha            text NOT NULL CHECK (head_sha ~ ${SHA}),
    base_ref            text NOT NULL,
    policy_commit_sha   text NOT NULL CHECK (policy_commit_sha ~ ${SHA}),
    policy_file_sha     text CHECK (policy_file_sha ~ ${SHA}),
    policy_status       text NOT NULL CHECK (policy_status IN ('ok','missing','invalid')),
    policy_hash         text CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
    mode                text NOT NULL DEFAULT 'report' CHECK (mode IN ('report','enforce')),
    outcome             text NOT NULL CHECK (outcome IN ('would_approve','would_require','would_block','no_policy','policy_invalid')),
    check_conclusion    text NOT NULL DEFAULT 'neutral' CHECK (check_conclusion IN ('neutral','success','failure','action_required')),
    risk_class          text CHECK (risk_class IN ('trivial','logic','sensitive')),
    risk_final          boolean NOT NULL DEFAULT false,
    risk_source         text CHECK (risk_source IN ('card','card_unavailable','card_pending')),
    author_kind         text CHECK (author_kind IN ('agent','human','unknown')),
    policy_file_changed boolean NOT NULL DEFAULT false,
    rules_matched       jsonb NOT NULL DEFAULT '[]',
    required            jsonb NOT NULL DEFAULT '{}',
    approvals           jsonb NOT NULL DEFAULT '{}',
    errors              jsonb NOT NULL DEFAULT '[]',
    facts_hash          text NOT NULL CHECK (facts_hash ~ '^[0-9a-f]{64}$'),
    facts_read_at       timestamptz NOT NULL,
    check_run_id        bigint,
    published_at        timestamptz,
    evaluated_at        timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK ((policy_status = 'ok') = (policy_hash IS NOT NULL)),
    UNIQUE NULLS NOT DISTINCT (change_id, head_sha, policy_file_sha)
  )`,
  `CREATE INDEX policy_verdicts_change_idx ON policy_verdicts (change_id, facts_read_at DESC)`,
];

// The 0001 definition, exactly.
const DOWN: string[] = [
  `DROP TABLE policy_verdicts`,
  `CREATE TABLE policy_verdicts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id           uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    head_sha            text NOT NULL CHECK (head_sha ~ ${SHA}),
    policy_sha          text,
    mode                text NOT NULL CHECK (mode IN ('report','enforce')),
    status              text NOT NULL CHECK (status IN ('pending','pass','fail','blocked','error')),
    check_conclusion    text CHECK (check_conclusion IN ('success','failure','neutral','action_required')),
    risk_class          text CHECK (risk_class IN ('trivial','logic','sensitive')),
    rules_matched       jsonb NOT NULL DEFAULT '[]',
    approvals_required  jsonb NOT NULL DEFAULT '{}',
    approvals_present   jsonb NOT NULL DEFAULT '{}',
    check_run_id        bigint,
    evaluated_at        timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX policy_verdicts_change_idx ON policy_verdicts (change_id, evaluated_at DESC)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
