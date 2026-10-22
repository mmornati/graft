import { type Selectable, sql, type Transaction } from "kysely";
import type { Db } from "../../db/client.js";
import type { Database, RepositoriesTable } from "../../db/schema.js";

type Executor = Db | Transaction<Database>;

export interface InstallationInput {
  id: number;
  accountId: number;
  accountLogin: string;
  accountType: "User" | "Organization" | "Enterprise";
  repositorySelection: "all" | "selected";
}

export interface RepositoryInput {
  id: number;
  fullName: string;
  private: boolean;
}

export type ActiveRepository = Selectable<RepositoriesTable>;

/** Upsert; `reactivate` clears deleted_at and suspended_at (installation.created). */
export async function upsertInstallation(
  ex: Executor,
  i: InstallationInput,
  now: Date,
  opts: { reactivate: boolean },
): Promise<void> {
  await ex
    .insertInto("installations")
    .values({
      id: i.id,
      account_id: i.accountId,
      account_login: i.accountLogin,
      account_type: i.accountType,
      repository_selection: i.repositorySelection,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        account_id: i.accountId,
        account_login: i.accountLogin,
        account_type: i.accountType,
        repository_selection: i.repositorySelection,
        updated_at: now,
        ...(opts.reactivate ? { deleted_at: null, suspended_at: null } : {}),
      }),
    )
    .execute();
}

const MODE_FLOORS = { policy_mode: "report", guard_mode: "report", mcp_write: "off" } as const;

/**
 * Phase 1 step 2, D13: a repository that moves to another installation, or comes back after
 * removal, returns to report/report/off, with one `mode_changes` row per key that changed (actor
 * `system`, `applied_at` NULL so that `modes.apply` republishes). An `enforce` set for one owner
 * must not follow the repository to another. A rename within the same installation keeps them.
 * Call it in the transaction that reactivates the row, before the upsert.
 */
export async function resetModesOnTransfer(
  ex: Executor,
  installationId: number,
  repositoryId: number,
  now: Date,
): Promise<number> {
  const row = await ex
    .selectFrom("repositories")
    .select(["installation_id", "removed_at", "policy_mode", "guard_mode", "mcp_write"])
    .where("id", "=", repositoryId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return 0;
  const moved = row.installation_id !== installationId;
  if (!moved && row.removed_at === null) return 0;
  const changed = (Object.keys(MODE_FLOORS) as (keyof typeof MODE_FLOORS)[]).filter(
    (key) => row[key] !== MODE_FLOORS[key],
  );
  if (changed.length === 0) return 0;
  await ex
    .updateTable("repositories")
    .set({ ...MODE_FLOORS, updated_at: now })
    .where("id", "=", repositoryId)
    .execute();
  await ex
    .insertInto("mode_changes")
    .values(
      changed.map((key) => ({
        repository_id: repositoryId,
        key,
        from_value: row[key],
        to_value: MODE_FLOORS[key],
        actor: "system",
        reason: moved ? "installation changed" : "repository re-added",
        created_at: now,
      })),
    )
    .execute();
  return changed.length;
}

/** Upsert repositories as active (removed_at = NULL); renames update full_name. */
export async function upsertRepositories(
  ex: Executor,
  installationId: number,
  repos: readonly RepositoryInput[],
  now: Date,
): Promise<void> {
  for (const r of repos) {
    await resetModesOnTransfer(ex, installationId, r.id, now);
    await ex
      .insertInto("repositories")
      .values({
        id: r.id,
        installation_id: installationId,
        full_name: r.fullName,
        private: r.private,
        removed_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          installation_id: installationId,
          full_name: r.fullName,
          private: r.private,
          removed_at: null,
          updated_at: now,
        }),
      )
      .execute();
  }
}

export async function markRepositoriesRemoved(
  ex: Executor,
  installationId: number,
  repoIds: readonly number[],
  now: Date,
): Promise<void> {
  if (repoIds.length === 0) return;
  await ex
    .updateTable("repositories")
    .set({ removed_at: now, updated_at: now })
    .where("installation_id", "=", installationId)
    .where("id", "in", [...repoIds])
    .where("removed_at", "is", null)
    .execute();
}

export async function markAllRepositoriesRemoved(
  ex: Executor,
  installationId: number,
  now: Date,
): Promise<void> {
  await ex
    .updateTable("repositories")
    .set({ removed_at: now, updated_at: now })
    .where("installation_id", "=", installationId)
    .where("removed_at", "is", null)
    .execute();
}

export async function setInstallationDeleted(ex: Executor, id: number, now: Date): Promise<void> {
  await ex
    .updateTable("installations")
    .set({ deleted_at: sql<Date>`coalesce(deleted_at, ${now})`, updated_at: now })
    .where("id", "=", id)
    .execute();
}

export async function setInstallationSuspended(
  ex: Executor,
  id: number,
  suspendedAt: Date | null,
  now: Date,
): Promise<void> {
  await ex
    .updateTable("installations")
    .set({
      // Keep the first suspension time when the same event is processed again.
      suspended_at: suspendedAt === null ? null : sql<Date>`coalesce(suspended_at, ${suspendedAt})`,
      updated_at: now,
    })
    .where("id", "=", id)
    .execute();
}

export async function setRepositorySelection(
  ex: Executor,
  id: number,
  selection: "all" | "selected",
  now: Date,
): Promise<void> {
  await ex
    .updateTable("installations")
    .set({ repository_selection: selection, updated_at: now })
    .where("id", "=", id)
    .execute();
}

export async function getActiveRepository(
  ex: Executor,
  id: number,
): Promise<ActiveRepository | undefined> {
  return ex
    .selectFrom("repositories")
    .selectAll()
    .where("id", "=", id)
    .where("removed_at", "is", null)
    .executeTakeFirst();
}

export async function listActiveRepositories(
  ex: Executor,
  installationId: number,
): Promise<ActiveRepository[]> {
  return ex
    .selectFrom("repositories")
    .selectAll()
    .where("installation_id", "=", installationId)
    .where("removed_at", "is", null)
    .orderBy("id")
    .execute();
}

/**
 * Make sure a repository row exists (a repo created after an `all` install has none).
 * Active rows get their name/visibility/default branch refreshed; a removed row is left alone.
 *
 * `other_installation`: the row is active but belongs to another installation (a transfer whose
 * `installation_repositories.added` has not arrived yet). The row is neither moved nor reset here;
 * that is `upsertRepositories`' job, which resets the modes (step 2 D13). A caller that acts on the
 * row's modes must not act on another installation's (step 2 review 1, finding 6).
 */
export async function ensureRepository(
  ex: Executor,
  installationId: number,
  repo: { id: number; full_name: string; private: boolean; default_branch: string },
  now: Date,
): Promise<"active" | "removed" | "other_installation"> {
  await ex
    .insertInto("repositories")
    .values({
      id: repo.id,
      installation_id: installationId,
      full_name: repo.full_name,
      private: repo.private,
      default_branch: repo.default_branch,
      removed_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  const updated = await ex
    .updateTable("repositories")
    .set({
      full_name: repo.full_name,
      private: repo.private,
      default_branch: repo.default_branch,
      updated_at: now,
    })
    .where("id", "=", repo.id)
    .where("removed_at", "is", null)
    .returning(["id", "installation_id"])
    .executeTakeFirst();
  if (!updated) return "removed";
  return Number(updated.installation_id) === installationId ? "active" : "other_installation";
}

/** The installation row when it exists and is neither deleted nor suspended. */
export async function getActiveInstallation(ex: Executor, id: number) {
  return ex
    .selectFrom("installations")
    .selectAll()
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .where("suspended_at", "is", null)
    .executeTakeFirst();
}
