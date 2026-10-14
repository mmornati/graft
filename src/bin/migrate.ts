import { z } from "zod";
import { ConfigError } from "../config/index.js";
import { createDb } from "../db/client.js";
import { createMigrator, migrateDown, migrateToLatest } from "../db/migrator.js";
import { loadDotEnv } from "./env.js";

async function main(): Promise<number> {
  const command = process.argv[2];
  if (command !== "up" && command !== "down" && command !== "status") {
    console.error("usage: migrate.ts up | down | status");
    return 2;
  }
  loadDotEnv();
  // Migrations need only the database URL, not the GitHub App secrets.
  const parsed = z
    .string()
    .regex(/^postgres(ql)?:\/\/.+/)
    .safeParse(process.env.DATABASE_URL);
  if (!parsed.success) {
    throw new ConfigError("Invalid configuration:\n- DATABASE_URL: must be a postgres:// URL");
  }
  const db = createDb(parsed.data, { max: 2 });
  try {
    if (command === "up") {
      const applied = await migrateToLatest(db);
      console.log(
        applied.length === 0 ? "no pending migrations" : `applied: ${applied.join(", ")}`,
      );
    } else if (command === "down") {
      const rolled = await migrateDown(db);
      console.log(
        rolled.length === 0 ? "nothing to roll back" : `rolled back: ${rolled.join(", ")}`,
      );
    } else {
      for (const m of await createMigrator(db).getMigrations()) {
        console.log(`${m.executedAt ? "applied " : "pending "} ${m.name}`);
      }
    }
    return 0;
  } finally {
    await db.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
