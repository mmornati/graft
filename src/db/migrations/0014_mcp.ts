import { type Kysely, sql } from "kysely";

// Phase 1 step 6: the MCP server (spec §11). Per-repository tokens (a SHA-256 hash and an 8-character
// prefix, never the token), the PRs `open_change` opened (numbers and SHAs), and the merge result
// of an MCP provenance report. Both new tables cascade from `repositories`, so the pilot purge
// covers them. `provenance` already allows `source = 'mcp'` (0001, 0002); for those rows
// `commit_sha` holds the reported head (D14), so the Phase 0 note "NULL for mcp" no longer holds.
// No token, title, body, branch name or tool argument is stored.
const UP: string[] = [
  `CREATE TABLE mcp_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id   bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    token_hash      text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    token_prefix    text NOT NULL CHECK (token_prefix ~ '^[A-Za-z0-9_-]{8}$'),
    created_by      text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 100),
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    last_used_at    timestamptz,
    revoked_at      timestamptz,
    revoked_by      text CHECK (char_length(revoked_by) BETWEEN 1 AND 100),
    revoke_reason   text CHECK (char_length(revoke_reason) BETWEEN 1 AND 200),
    CHECK (expires_at > created_at),
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
  )`,
  `CREATE UNIQUE INDEX mcp_tokens_active_name ON mcp_tokens (repository_id, name) WHERE revoked_at IS NULL`,
  `CREATE INDEX mcp_tokens_repository_idx ON mcp_tokens (repository_id)`,
  `CREATE TABLE mcp_changes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id   bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    token_id        uuid NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
    pr_number       integer NOT NULL CHECK (pr_number > 0),
    head_sha        text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repository_id, pr_number)
  )`,
  `CREATE INDEX mcp_changes_rate_idx ON mcp_changes (repository_id, created_at)`,
  `ALTER TABLE change_provenance
    ADD COLUMN mcp_report text NOT NULL DEFAULT 'none' CHECK (mcp_report IN ('none','agrees','disagrees'))`,
];

const DOWN: string[] = [
  `DELETE FROM provenance WHERE source = 'mcp'`,
  `ALTER TABLE change_provenance DROP COLUMN IF EXISTS mcp_report`,
  `DROP INDEX IF EXISTS mcp_changes_rate_idx`,
  `DROP TABLE IF EXISTS mcp_changes`,
  `DROP INDEX IF EXISTS mcp_tokens_repository_idx`,
  `DROP INDEX IF EXISTS mcp_tokens_active_name`,
  `DROP TABLE IF EXISTS mcp_tokens`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
