import pg from "pg";
// Graft's own migrations: the console is tested against the schema Graft really creates.
import { createDb } from "../../src/db/client.js";
import { migrateToLatest } from "../../src/db/migrator.js";
import { CONSOLE_TEST_DATABASE_URL } from "./db-url.js";

export default async function setup(): Promise<void> {
  const target = new URL(CONSOLE_TEST_DATABASE_URL);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error("unsafe test database name");
  const admin = new URL(CONSOLE_TEST_DATABASE_URL);
  admin.pathname = "/postgres";
  const client = new pg.Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
  } catch {
    throw new Error(
      `Postgres not reachable at ${target.hostname}:${target.port || "5432"}; run pnpm db:up at the repository root`,
    );
  }
  try {
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await client.end();
  }
  const db = createDb(CONSOLE_TEST_DATABASE_URL, { max: 2 });
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}
