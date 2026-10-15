import { type Kysely, sql } from "kysely";

// Vote eligibility hardening.
// - `pr_reviewers` rows written by the step 6 rules were never checked against the repository (an
//   outsider's APPROVED review or a sock-puppet review request was enough) and cannot be
//   re-verified from the table alone. Existing rows therefore become `verified = false` (the
//   default) and the gate ignores them until `pilot sync-reviewers` re-verifies them against
//   GitHub. Rows are kept, not deleted: they are the audit trail of what the old rules accepted.
// - `changes.author_id`: the PR author's immutable user id, so the author's votes are excluded by
//   id and a rename cannot defeat the exclusion. Null for rows stored before (filled on the next
//   upsert of the pull).
// - `reviewer_check_denials`: the last permission check of a (change, user) that GitHub answered
//   with 403 or 404 (fail closed). User ids and a status only; `pilot doctor` counts them so a
//   missing App permission is visible instead of silently making every reviewer ineligible.
const UP: string[] = [
  `ALTER TABLE pr_reviewers ADD COLUMN verified boolean NOT NULL DEFAULT false`,
  `ALTER TABLE changes ADD COLUMN author_id bigint`,
  `CREATE TABLE reviewer_check_denials (
    change_id  uuid   NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    user_id    bigint NOT NULL,
    status     smallint NOT NULL CHECK (status IN (403, 404)),
    checked_at timestamptz NOT NULL,
    PRIMARY KEY (change_id, user_id)
  )`,
];

const DOWN: string[] = [
  `DROP TABLE IF EXISTS reviewer_check_denials`,
  `ALTER TABLE changes DROP COLUMN IF EXISTS author_id`,
  `ALTER TABLE pr_reviewers DROP COLUMN IF EXISTS verified`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
