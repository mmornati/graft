import pg from "pg";
import { createDb } from "../src/db/client.js";
import { migrateToLatest } from "../src/db/migrator.js";

export const DEFAULT_TEST_DATABASE_URL = "postgres://graft:graft@localhost:55432/graft_test";

export default async function setup(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const target = new URL(testUrl);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error("unsafe test database name");

  const admin = new URL(testUrl);
  admin.pathname = "/postgres";
  const client = new pg.Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
  } catch {
    throw new Error(
      `Postgres not reachable at ${target.hostname}:${target.port || "5432"}; run pnpm db:up`,
    );
  }
  try {
    await client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await client.end();
  }

  const db = createDb(testUrl, { max: 2 });
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
}
