import { type Kysely, sql } from "kysely";

const UP: string[] = [
  `ALTER TABLE changes
     ADD COLUMN pr_updated_at    timestamptz,
     ADD COLUMN author_is_bot    boolean NOT NULL DEFAULT false,
     ADD COLUMN graft_comment_id bigint`,

  `ALTER TABLE provenance DROP CONSTRAINT provenance_source_check`,
  `ALTER TABLE provenance ADD CONSTRAINT provenance_source_check
     CHECK (source IN ('trailer','pr_body','mcp'))`,

  `CREATE TABLE change_provenance (
    change_id              uuid PRIMARY KEY REFERENCES changes(id) ON DELETE CASCADE,
    head_sha               text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
    author_kind            text NOT NULL CHECK (author_kind IN ('agent','human')),
    author_kind_reason     text NOT NULL CHECK (author_kind_reason IN ('trailer','bot_account','configured_login','agent_coauthor','none')),
    agent                  text,
    model                  text,
    task_external_id       text,
    session_url            text,
    field_sources          jsonb NOT NULL DEFAULT '{}',
    conflicts              jsonb NOT NULL DEFAULT '{}',
    warnings               jsonb NOT NULL DEFAULT '[]',
    commits_total          integer NOT NULL,
    commits_scanned        integer NOT NULL,
    commits_with_trailers  integer NOT NULL,
    agent_coauthor_commits integer NOT NULL,
    commits_truncated      boolean NOT NULL DEFAULT false,
    check_run_id           bigint,
    computed_at            timestamptz NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX change_provenance_author_kind_idx ON change_provenance (author_kind)`,
];

const DOWN: string[] = [
  `DROP TABLE IF EXISTS change_provenance`,
  `DELETE FROM provenance WHERE source = 'pr_body'`,
  `ALTER TABLE provenance DROP CONSTRAINT provenance_source_check`,
  `ALTER TABLE provenance ADD CONSTRAINT provenance_source_check CHECK (source IN ('trailer','mcp'))`,
  `ALTER TABLE changes DROP COLUMN graft_comment_id, DROP COLUMN author_is_bot, DROP COLUMN pr_updated_at`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
