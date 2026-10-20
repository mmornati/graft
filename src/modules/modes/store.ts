import { type Selectable, sql, type Transaction } from "kysely";
import type { Db } from "../../db/client.js";
import type { Database, ModeChangesTable } from "../../db/schema.js";
import type { Mode, ModeKey, PermissionLevel, Switch } from "../../modes/index.js";

type Executor = Db | Transaction<Database>;
export type ModeChangeRow = Selectable<ModeChangesTable>;

/** What `effectiveModes` needs about one repository, read in one query. */
export interface RepositoryModeRow {
  repositoryId: number;
  installationId: number;
  fullName: string;
  requested: { policy_mode: Mode; guard_mode: Mode; mcp_write: Switch };
  repositoryActive: boolean;
  installationActive: boolean;
  /** null: never read. */
  permissions: Record<string, PermissionLevel> | null;
  permissionsReadAt: Date | null;
}

function toRow(r: {
  id: number;
  installation_id: number;
  full_name: string;
  removed_at: Date | null;
  policy_mode: Mode;
  guard_mode: Mode;
  mcp_write: Switch;
  suspended_at: Date | null;
  deleted_at: Date | null;
  permissions: Record<string, PermissionLevel>;
  permissions_read_at: Date | null;
}): RepositoryModeRow {
  return {
    repositoryId: r.id,
    installationId: r.installation_id,
    fullName: r.full_name,
    requested: { policy_mode: r.policy_mode, guard_mode: r.guard_mode, mcp_write: r.mcp_write },
    repositoryActive: r.removed_at === null,
    installationActive: r.suspended_at === null && r.deleted_at === null,
    permissions: r.permissions_read_at === null ? null : r.permissions,
    permissionsReadAt: r.permissions_read_at,
  };
}

const COLUMNS = [
  "r.id",
  "r.installation_id",
  "r.full_name",
  "r.removed_at",
  "r.policy_mode",
  "r.guard_mode",
  "r.mcp_write",
  "i.suspended_at",
  "i.deleted_at",
  "i.permissions",
  "i.permissions_read_at",
] as const;

function base(ex: Executor) {
  return ex
    .selectFrom("repositories as r")
    .innerJoin("installations as i", "i.id", "r.installation_id");
}

export async function getRepositoryModeRow(
  ex: Executor,
  repositoryId: number,
): Promise<RepositoryModeRow | undefined> {
  const row = await base(ex).select(COLUMNS).where("r.id", "=", repositoryId).executeTakeFirst();
  return row ? toRow(row) : undefined;
}

/** Active repositories only; the name is compared case-insensitively. */
export async function findActiveRepositoryByName(
  ex: Executor,
  installationId: number,
  owner: string,
  repo: string,
): Promise<RepositoryModeRow | undefined> {
  const row = await base(ex)
    .select(COLUMNS)
    .where("r.installation_id", "=", installationId)
    .where("r.removed_at", "is", null)
    .where(sql<string>`lower(r.full_name)`, "=", `${owner}/${repo}`.toLowerCase())
    .executeTakeFirst();
  return row ? toRow(row) : undefined;
}

/** Active repositories of an installation, or the active repository of that name. */
export async function listRepositoryModeRows(
  ex: Executor,
  where: { installationId: number } | { fullName: string },
): Promise<RepositoryModeRow[]> {
  let q = base(ex).select(COLUMNS).where("r.removed_at", "is", null);
  q =
    "installationId" in where
      ? q.where("r.installation_id", "=", where.installationId)
      : q.where(sql<string>`lower(r.full_name)`, "=", where.fullName.toLowerCase());
  return (await q.orderBy("r.full_name").orderBy("r.id").execute()).map(toRow);
}

export interface NewModeChange {
  repositoryId: number;
  key: ModeKey;
  from: string;
  to: string;
  actor: string;
  reason: string;
}

export async function insertModeChanges(
  tx: Transaction<Database>,
  changes: readonly NewModeChange[],
  now: Date,
): Promise<void> {
  if (changes.length === 0) return;
  await tx
    .insertInto("mode_changes")
    .values(
      changes.map((c) => ({
        repository_id: c.repositoryId,
        key: c.key,
        from_value: c.from,
        to_value: c.to,
        actor: c.actor,
        reason: c.reason,
        created_at: now,
      })),
    )
    .execute();
}

/** Oldest first; rows another worker holds are skipped, so two runs claim disjoint rows. */
export async function claimUnappliedModeChanges(
  tx: Transaction<Database>,
  limit = 50,
): Promise<ModeChangeRow[]> {
  return tx
    .selectFrom("mode_changes")
    .selectAll()
    .where("applied_at", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();
}

export async function markApplied(
  tx: Transaction<Database>,
  ids: readonly string[],
  at: Date,
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .updateTable("mode_changes")
    .set({ applied_at: at })
    .where("id", "in", [...ids])
    .execute();
}

export async function countUnapplied(ex: Executor, repositoryId: number): Promise<number> {
  const row = await ex
    .selectFrom("mode_changes")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("repository_id", "=", repositoryId)
    .where("applied_at", "is", null)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

export async function listModeChanges(
  ex: Executor,
  repositoryId: number,
  limit: number,
): Promise<ModeChangeRow[]> {
  return ex
    .selectFrom("mode_changes")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
}

export async function getServiceState(
  ex: Executor,
  key: string,
): Promise<{ value: string; updatedAt: Date } | undefined> {
  const row = await ex
    .selectFrom("service_state")
    .select(["value", "updated_at"])
    .where("key", "=", key)
    .executeTakeFirst();
  return row ? { value: row.value, updatedAt: row.updated_at } : undefined;
}

/**
 * Compare-and-set: stores `value` and returns what was there before (null on the first write).
 * The row lock serialises workers that start together: the one that updates sees the old value,
 * the others see the new one and so report no change. An equal value is not rewritten.
 * `inTx` runs in the same transaction after a change of an existing value, so work that must not
 * be lost (a job enqueue) commits or rolls back together with the new value.
 */
export async function casServiceState(
  db: Db,
  key: string,
  value: string,
  now: Date,
  inTx?: (tx: Transaction<Database>, previous: string) => Promise<void>,
): Promise<string | null> {
  return db.transaction().execute(async (tx) => {
    for (;;) {
      const current = await tx
        .selectFrom("service_state")
        .select("value")
        .where("key", "=", key)
        .forUpdate()
        .executeTakeFirst();
      if (current) {
        if (current.value !== value) {
          await tx
            .updateTable("service_state")
            .set({ value, updated_at: now })
            .where("key", "=", key)
            .execute();
          if (inTx) await inTx(tx, current.value);
        }
        return current.value;
      }
      const inserted = await tx
        .insertInto("service_state")
        .values({ key, value, updated_at: now })
        .onConflict((oc) => oc.column("key").doNothing())
        .returning("key")
        .executeTakeFirst();
      // A concurrent first start won the insert: read its row on the next turn.
      if (inserted) return null;
    }
  });
}
