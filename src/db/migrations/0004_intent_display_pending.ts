import { type Kysely, sql } from "kysely";

// The "outdated" note (D11) is a display: `pending` joins `ok` and `unavailable`.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(`ALTER TABLE intent_displays DROP CONSTRAINT intent_displays_status_check`)
    .execute(db);
  await sql
    .raw(
      `ALTER TABLE intent_displays ADD CONSTRAINT intent_displays_status_check
         CHECK (status IN ('ok','unavailable','pending'))`,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DELETE FROM intent_displays WHERE status = 'pending'`).execute(db);
  await sql
    .raw(`ALTER TABLE intent_displays DROP CONSTRAINT intent_displays_status_check`)
    .execute(db);
  await sql
    .raw(
      `ALTER TABLE intent_displays ADD CONSTRAINT intent_displays_status_check
         CHECK (status IN ('ok','unavailable'))`,
    )
    .execute(db);
}
