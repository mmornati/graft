import { type Kysely, sql } from "kysely";

const SHA = "'^[0-9a-f]{40}$'";
const RISK = "('trivial','logic','sensitive')";

const UP: string[] = [
  `CREATE TABLE installations (
    id                    bigint PRIMARY KEY,
    account_id            bigint NOT NULL,
    account_login         text   NOT NULL,
    account_type          text   NOT NULL CHECK (account_type IN ('User','Organization','Enterprise')),
    repository_selection  text   NOT NULL CHECK (repository_selection IN ('all','selected')),
    suspended_at          timestamptz,
    deleted_at            timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX installations_account_login_idx ON installations (lower(account_login))`,

  `CREATE TABLE repositories (
    id               bigint PRIMARY KEY,
    installation_id  bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
    full_name        text   NOT NULL,
    private          boolean NOT NULL,
    default_branch   text,
    removed_at       timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX repositories_installation_idx ON repositories (installation_id) WHERE removed_at IS NULL`,
  `CREATE INDEX repositories_full_name_idx ON repositories (lower(full_name))`,

  `CREATE TABLE tasks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id   bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    external_id     text   NOT NULL,
    issue_number    integer,
    issue_url       text,
    goal            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repository_id, external_id)
  )`,

  `CREATE TABLE changes (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id    bigint  NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    pr_number        integer NOT NULL,
    pr_node_id       text    NOT NULL,
    task_id          uuid    REFERENCES tasks(id) ON DELETE SET NULL,
    head_sha         text    NOT NULL CHECK (head_sha ~ ${SHA}),
    base_ref         text    NOT NULL,
    author_login     text    NOT NULL,
    state            text    NOT NULL CHECK (state IN ('open','closed','merged')),
    merge_commit_sha text    CHECK (merge_commit_sha ~ ${SHA}),
    opened_at        timestamptz NOT NULL,
    closed_at        timestamptz,
    merged_at        timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repository_id, pr_number)
  )`,
  `CREATE INDEX changes_task_idx ON changes (task_id) WHERE task_id IS NOT NULL`,
  `CREATE INDEX changes_repo_state_idx ON changes (repository_id, state)`,

  `CREATE TABLE provenance (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id         uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    source            text NOT NULL CHECK (source IN ('trailer','mcp')),
    commit_sha        text CHECK (commit_sha ~ ${SHA}),
    agent             text,
    model             text,
    task_external_id  text,
    session_url       text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (change_id, source, commit_sha)
  )`,
  `CREATE INDEX provenance_change_idx ON provenance (change_id)`,

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

  `CREATE TABLE policy_verdicts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    change_id           uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    head_sha            text NOT NULL CHECK (head_sha ~ ${SHA}),
    policy_sha          text,
    mode                text NOT NULL CHECK (mode IN ('report','enforce')),
    status              text NOT NULL CHECK (status IN ('pending','pass','fail','blocked','error')),
    check_conclusion    text CHECK (check_conclusion IN ('success','failure','neutral','action_required')),
    risk_class          text CHECK (risk_class IN ${RISK}),
    rules_matched       jsonb NOT NULL DEFAULT '[]',
    approvals_required  jsonb NOT NULL DEFAULT '{}',
    approvals_present   jsonb NOT NULL DEFAULT '{}',
    check_run_id        bigint,
    evaluated_at        timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX policy_verdicts_change_idx ON policy_verdicts (change_id, evaluated_at DESC)`,

  `CREATE TABLE guard_events (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id      bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    branch             text NOT NULL,
    failing_sha        text NOT NULL CHECK (failing_sha ~ ${SHA}),
    ci_run_url         text,
    culprit_change_id  uuid REFERENCES changes(id) ON DELETE SET NULL,
    revert_pr_number   integer,
    status             text NOT NULL CHECK (status IN ('detected','culprit_found','revert_opened','reverted','dismissed','error')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repository_id, failing_sha)
  )`,

  `CREATE TABLE webhook_deliveries (
    delivery_id      text PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 100),
    event            text NOT NULL,
    action           text,
    installation_id  bigint,
    repository_id    bigint,
    status           text NOT NULL CHECK (status IN ('enqueued','ignored')),
    job_id           uuid,
    received_at      timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX webhook_deliveries_received_idx ON webhook_deliveries (received_at)`,
];

const DROP_ORDER = [
  "webhook_deliveries",
  "guard_events",
  "policy_verdicts",
  "intent_cards",
  "provenance",
  "changes",
  "tasks",
  "repositories",
  "installations",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) {
    await sql.raw(stmt).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of DROP_ORDER) {
    await sql.raw(`DROP TABLE IF EXISTS ${table}`).execute(db);
  }
}
