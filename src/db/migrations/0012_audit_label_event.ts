import { type Kysely, sql } from "kysely";

// Phase 1 step 3, review 1. Two changes to `audit_log` (0010 is released and is not edited):
//
// - `label_event_id`: the issue event id of the `labeled` event an `applied` row was verified
//   from (finding 2). A later label trigger compares it with the newest `labeled` event, so a
//   bypass never outlives the label action that created it. NULL on other kinds and on rows
//   written before this migration (those count as unbound and are re-verified).
// - `audit_log_ignored_once` becomes NULLS NOT DISTINCT (nit 7), so the database itself keeps one
//   `ignored` row per (change, head) for the unknown actor too, not only the store under the lock.
//   `up` fails if duplicates already exist; the store has always prevented them.
const UP: string[] = [
  `ALTER TABLE audit_log ADD COLUMN label_event_id bigint CHECK (label_event_id > 0)`,
  `DROP INDEX audit_log_ignored_once`,
  `CREATE UNIQUE INDEX audit_log_ignored_once ON audit_log (change_id, head_sha, actor_id)
    NULLS NOT DISTINCT WHERE kind = 'ignored'`,
];

const DOWN: string[] = [
  `DROP INDEX audit_log_ignored_once`,
  `CREATE UNIQUE INDEX audit_log_ignored_once ON audit_log (change_id, head_sha, actor_id)
    WHERE kind = 'ignored'`,
  `ALTER TABLE audit_log DROP COLUMN label_event_id`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const stmt of UP) await sql.raw(stmt).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const stmt of DOWN) await sql.raw(stmt).execute(db);
}
