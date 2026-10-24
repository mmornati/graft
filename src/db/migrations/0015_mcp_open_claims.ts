import { type Kysely, sql } from "kysely";

// Phase 1 step 6, review 1 (finding 7): the D9 (c) hourly cap held under concurrent calls.
// `open_change` claims its slot before `pulls.create`: a `mcp_changes` row with no PR number and no
// head yet, inserted in a short transaction that counts the rolling hour under the repository row
// lock. The claim becomes the PR's row after the create, or is deleted when the create fails. A
// claim left by a crash counts for one hour, then is dropped by the next claim. Both columns are
// null together; a PR row is unchanged (`UNIQUE (repository_id, pr_number)` ignores nulls).
const UP: string[] = [
  `ALTER TABLE mcp_changes ALTER COLUMN pr_number DROP NOT NULL, ALTER COLUMN head_sha DROP NOT NULL`,
  `ALTER TABLE mcp_changes ADD CONSTRAINT mcp_changes_claim_shape
    CHECK ((pr_number IS NULL) = (head_sha IS NULL))`,
];

const DOWN: string[] = [
  `DELETE FROM mcp_changes WHERE pr_number IS NULL`,
  `ALTER TABLE mcp_changes DROP CONSTRAINT IF EXISTS mcp_changes_claim_shape`,
  `ALTER TABLE mcp_changes ALTER COLUMN pr_number SET NOT NULL, ALTER COLUMN head_sha SET NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
