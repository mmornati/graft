import { type MigrationResultSet, Migrator } from "kysely/migration";
import type { Db } from "./client.js";
import { migrations } from "./migrations/index.js";

export function createMigrator(db: Db): Migrator {
  return new Migrator({ db, provider: { getMigrations: async () => migrations } });
}

function assertOk({ error, results }: MigrationResultSet): void {
  if (error) throw error instanceof Error ? error : new Error(String(error));
  const failed = results?.find((r) => r.status === "Error");
  if (failed) throw new Error(`migration ${failed.migrationName} failed`);
}

export async function migrateToLatest(db: Db): Promise<string[]> {
  const set = await createMigrator(db).migrateToLatest();
  assertOk(set);
  return (set.results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}

/** Roll back every applied migration. */
export async function migrateDown(db: Db): Promise<string[]> {
  const migrator = createMigrator(db);
  const rolled: string[] = [];
  for (;;) {
    const applied = (await migrator.getMigrations()).filter((m) => m.executedAt !== undefined);
    if (applied.length === 0) return rolled;
    const set = await migrator.migrateDown();
    assertOk(set);
    for (const r of set.results ?? []) rolled.push(r.migrationName);
  }
}

export async function pendingMigrations(db: Db): Promise<string[]> {
  const all = await createMigrator(db).getMigrations();
  return all.filter((m) => m.executedAt === undefined).map((m) => m.name);
}
