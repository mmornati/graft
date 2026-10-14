import { sql } from "kysely";
import type { Db } from "../../src/db/client.js";
import { createDb } from "../../src/db/client.js";
import { TABLE_NAMES } from "../../src/db/schema.js";
import { TEST_DATABASE_URL } from "./config.js";

export function testDb(): Db {
  return createDb(TEST_DATABASE_URL, { max: 5 });
}

/** Truncate the nine app tables, and clear queued webhook jobs if pg-boss is installed. */
export async function truncateAll(db: Db): Promise<void> {
  await sql
    .raw(`TRUNCATE ${TABLE_NAMES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`)
    .execute(db);
  const installed = await sql<{
    r: string | null;
  }>`select to_regclass('pgboss.job')::text as r`.execute(db);
  if (installed.rows[0]?.r) {
    await sql`delete from pgboss.job`.execute(db);
  }
}

export async function countJobs(db: Db, name = "github.webhook"): Promise<number> {
  const res = await sql<{
    n: string;
  }>`select count(*)::text as n from pgboss.job where name = ${name}`.execute(db);
  return Number(res.rows[0]?.n ?? 0);
}
