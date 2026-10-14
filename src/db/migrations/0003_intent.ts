import { type Kysely, sql } from "kysely";

const SHA = "'^[0-9a-f]{40}$'";
const RISK = "('trivial','logic','sensitive')";

// `intent_cards` from 0001 has never been written, so `up` replaces it.
// No column stores a diff, a patch, a prompt, a PR body or issue text. `goal`,
// `behavior_changes`, the reasons and the claims are model prose, which README §5 allows.
const UP: string[] = [
  `DROP TABLE intent_cards`,
  `CREATE TABLE intent_cards (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id             uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    head_sha              text NOT NULL CHECK (head_sha ~ ${SHA}),
    prompt_version        text NOT NULL,
    input_hash            text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    status                text NOT NULL CHECK (status IN ('ok','unavailable')),
    failure_reason        text CHECK (failure_reason IN ('not_configured','budget_exceeded','too_large',
                            'llm_timeout','llm_rate_limited','llm_unavailable','llm_auth','llm_bad_request',
                            'llm_refusal','invalid_output','deadline_exceeded')),
    goal                  text,
    behavior_changes      jsonb NOT NULL DEFAULT '[]',
    out_of_scope_edits    jsonb NOT NULL DEFAULT '[]',
    risk_class            text NOT NULL CHECK (risk_class IN ${RISK}),
    risk_floor            text NOT NULL CHECK (risk_floor IN ${RISK}),
    floor_reasons         jsonb NOT NULL DEFAULT '[]',
    model_risk_class      text CHECK (model_risk_class IN ${RISK}),
    model_risk_reason     text,
    first_pass_risk_class text CHECK (first_pass_risk_class IN ${RISK}),
    verifier_risk_class   text CHECK (verifier_risk_class IN ${RISK}),
    risk_raised_by        jsonb NOT NULL DEFAULT '[]',
    verifier_status       text NOT NULL CHECK (verifier_status IN ('agree','disagree','error','skipped')),
    verifier_failure      text,
    verifier_claims       jsonb NOT NULL DEFAULT '[]',
    verifier_missing      jsonb NOT NULL DEFAULT '[]',
    verifier_unexplained  jsonb NOT NULL DEFAULT '[]',
    instructions_in_data  boolean NOT NULL DEFAULT false,
    writer_model          text,
    first_pass_model      text,
    verifier_model        text,
    llm_calls             integer NOT NULL DEFAULT 0,
    input_tokens          integer NOT NULL DEFAULT 0,
    output_tokens         integer NOT NULL DEFAULT 0,
    cache_read_tokens     integer NOT NULL DEFAULT 0,
    cache_write_tokens    integer NOT NULL DEFAULT 0,
    files_total           integer NOT NULL,
    files_listed          integer NOT NULL,
    files_full            integer NOT NULL,
    files_partial         integer NOT NULL,
    files_omitted         integer NOT NULL,
    omitted_files         jsonb NOT NULL DEFAULT '[]',
    lines_added           integer NOT NULL,
    lines_deleted         integer NOT NULL,
    inputs_truncated      boolean NOT NULL,
    linked_issue_number   integer,
    comment_id            bigint,
    check_run_id          bigint,
    published_at          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (change_id, head_sha, prompt_version, input_hash),
    CHECK ((status = 'ok') = (goal IS NOT NULL)),
    CHECK (status = 'ok' OR failure_reason IS NOT NULL)
  )`,
  `CREATE INDEX intent_cards_change_idx ON intent_cards (change_id, created_at DESC)`,
  `CREATE INDEX intent_cards_published_idx ON intent_cards (change_id, published_at) WHERE published_at IS NOT NULL`,
  `CREATE INDEX intent_cards_created_idx ON intent_cards (created_at)`,

  `CREATE TABLE intent_feedback (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id       uuid NOT NULL REFERENCES intent_cards(id) ON DELETE CASCADE,
    change_id     uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    user_id       bigint NOT NULL,
    user_login    text NOT NULL,
    verdict       text NOT NULL CHECK (verdict IN ('up','down')),
    source        text NOT NULL CHECK (source IN ('reaction','check_action')),
    reacted_at    timestamptz NOT NULL,
    is_pr_author  boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (card_id, user_id, source)
  )`,
  `CREATE INDEX intent_feedback_change_idx ON intent_feedback (change_id)`,

  // Append-only: one row per model run, written with every save (also a dropped one), so retries,
  // re-runs and in-place regeneration of a card never reduce what a repository has spent today.
  `CREATE TABLE intent_spend (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id  bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    change_id      uuid REFERENCES changes(id) ON DELETE SET NULL,
    tokens         bigint NOT NULL CHECK (tokens > 0),
    llm_calls      integer NOT NULL DEFAULT 0,
    spent_at       timestamptz NOT NULL
  )`,
  `CREATE INDEX intent_spend_repo_idx ON intent_spend (repository_id, spent_at)`,

  // Append-only: every time a card (in a given status) became the one on screen. Reactions are
  // attributed to the display that was current when they were made.
  `CREATE TABLE intent_displays (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq        bigint GENERATED ALWAYS AS IDENTITY,
    change_id  uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    card_id    uuid NOT NULL REFERENCES intent_cards(id) ON DELETE CASCADE,
    status     text NOT NULL CHECK (status IN ('ok','unavailable')),
    shown_at   timestamptz NOT NULL
  )`,
  `CREATE INDEX intent_displays_change_idx ON intent_displays (change_id, shown_at)`,
];

// The 0001 definition, verbatim.
const DOWN: string[] = [
  `DROP TABLE intent_displays`,
  `DROP TABLE intent_spend`,
  `DROP TABLE intent_feedback`,
  `DROP TABLE intent_cards`,
  `CREATE TABLE intent_cards (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id           uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    head_sha            text NOT NULL CHECK (head_sha ~ ${SHA}),
    prompt_version      text NOT NULL,
    goal                text NOT NULL,
    behavior_changes    jsonb NOT NULL DEFAULT '[]',
    out_of_scope_edits  jsonb NOT NULL DEFAULT '[]',
    risk_class          text NOT NULL CHECK (risk_class IN ${RISK}),
    risk_floor          text NOT NULL CHECK (risk_floor IN ${RISK}),
    model_risk_class    text CHECK (model_risk_class IN ${RISK}),
    verifier_status     text NOT NULL CHECK (verifier_status IN ('pending','agree','disagree','error')),
    verifier_notes      text,
    writer_model        text NOT NULL,
    verifier_model      text,
    input_tokens        integer,
    output_tokens       integer,
    comment_id          bigint,
    check_run_id        bigint,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (change_id, head_sha, prompt_version)
  )`,
  `CREATE INDEX intent_cards_change_idx ON intent_cards (change_id, created_at DESC)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
