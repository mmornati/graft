import { sql } from "kysely";
import type { Db } from "../../src/db/client.js";
import { createDb } from "../../src/db/client.js";
import { TABLE_NAMES } from "../../src/db/schema.js";
import { TEST_DATABASE_URL } from "./config.js";

export function testDb(): Db {
  return createDb(TEST_DATABASE_URL, { max: 5 });
}

/**
 * Truncate the app tables, and clear queued jobs if pg-boss is installed. Jobs a worker has already
 * fetched (left over from the previous test or test file) are let finish first, so their writes
 * cannot land between the truncate and the caller's seed. The wait is bounded for tests that
 * deliberately leave a job hanging.
 */
export async function truncateAll(db: Db, activeWaitMs = 5_000): Promise<void> {
  const installed = await sql<{
    r: string | null;
  }>`select to_regclass('pgboss.job')::text as r`.execute(db);
  const boss = Boolean(installed.rows[0]?.r);
  if (boss) {
    const deadline = Date.now() + activeWaitMs;
    while (Date.now() < deadline) {
      // A finishing job may enqueue follow-ups; drop them before a worker fetches them.
      await sql`delete from pgboss.job where state <> 'active'`.execute(db);
      const res = await sql<{
        n: string;
      }>`select count(*)::text as n from pgboss.job where state = 'active'`.execute(db);
      if (res.rows[0]?.n === "0") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await sql
    .raw(`TRUNCATE ${TABLE_NAMES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`)
    .execute(db);
  if (boss) {
    await sql`delete from pgboss.job`.execute(db);
  }
}

export async function countJobs(db: Db, name = "github.webhook"): Promise<number> {
  const res = await sql<{
    n: string;
  }>`select count(*)::text as n from pgboss.job where name = ${name}`.execute(db);
  return Number(res.rows[0]?.n ?? 0);
}
