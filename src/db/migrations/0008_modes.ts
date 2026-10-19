import { type Kysely, sql } from "kysely";

// Phase 1 step 1: modes (spec §5). Text columns with CHECK constraints so that the audit table
// stores from/to uniformly. `mode_changes` holds operator text (actor, reason) and no PR content;
// `service_state` holds server facts (the ceiling the worker last published) and no installation
// data.
const UP: string[] = [
  `ALTER TABLE repositories
    ADD COLUMN policy_mode text NOT NULL DEFAULT 'report' CHECK (policy_mode IN ('report','enforce')),
    ADD COLUMN guard_mode  text NOT NULL DEFAULT 'report' CHECK (guard_mode  IN ('report','enforce')),
    ADD COLUMN mcp_write   text NOT NULL DEFAULT 'off'    CHECK (mcp_write   IN ('off','on'))`,
  `ALTER TABLE installations
    ADD COLUMN permissions         jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN permissions_read_at timestamptz`,
  `CREATE TABLE mode_changes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    key           text NOT NULL CHECK (key IN ('policy_mode','guard_mode','mcp_write')),
    from_value    text NOT NULL,
    to_value      text NOT NULL,
    actor         text NOT NULL CHECK (actor ~ '^[A-Za-z0-9._@-]{1,64}$'),
    reason        text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
    created_at    timestamptz NOT NULL DEFAULT now(),
    applied_at    timestamptz,
    CHECK (from_value <> to_value),
    CHECK (CASE WHEN key = 'mcp_write'
      THEN from_value IN ('off','on') AND to_value IN ('off','on')
      ELSE from_value IN ('report','enforce') AND to_value IN ('report','enforce') END)
  )`,
  `CREATE INDEX mode_changes_repo_idx ON mode_changes (repository_id, created_at DESC)`,
  `CREATE INDEX mode_changes_unapplied_idx ON mode_changes (created_at) WHERE applied_at IS NULL`,
  `CREATE TABLE service_state (
    key        text PRIMARY KEY CHECK (key ~ '^[a-z_]{1,64}$'),
    value      text NOT NULL CHECK (char_length(value) <= 200),
    updated_at timestamptz NOT NULL
  )`,
  `ALTER TABLE policy_verdicts
    ADD COLUMN policy_mode text NOT NULL DEFAULT 'report' CHECK (policy_mode IN ('report','enforce'))`,
];

const DOWN: string[] = [
  `ALTER TABLE policy_verdicts DROP COLUMN IF EXISTS policy_mode`,
  `DROP TABLE IF EXISTS service_state`,
  `DROP TABLE IF EXISTS mode_changes`,
  `ALTER TABLE installations DROP COLUMN IF EXISTS permissions_read_at, DROP COLUMN IF EXISTS permissions`,
  `ALTER TABLE repositories DROP COLUMN IF EXISTS mcp_write, DROP COLUMN IF EXISTS guard_mode, DROP COLUMN IF EXISTS policy_mode`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
