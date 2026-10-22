/**
 * Every integration file starts from empty app tables and an empty queue. Files leave rows and
 * queued jobs behind (an active installation, a pull_request webhook not yet run), and a file that
 * starts a worker before its own first truncate would run them: I-E2E-1 saw installation-token
 * calls from another file's provenance and reviewer jobs. This hook is registered before the
 * file's own, so it runs before any of its workers start. No worker of this file exists yet, so
 * a job still marked active belongs to a finished file: nothing waits for it.
 */
import { sql } from "kysely";
import { afterAll, beforeAll } from "vitest";
import { testDb, truncateAll } from "./helpers/db.js";

const db = testDb();
beforeAll(async () => {
  await truncateAll(db, 0);
  const schedules = await sql<{
    r: string | null;
  }>`select to_regclass('pgboss.schedule')::text as r`.execute(db);
  if (schedules.rows[0]?.r) await sql`delete from pgboss.schedule`.execute(db);
});
afterAll(() => db.destroy());
