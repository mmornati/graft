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

/** Upsert repositories as active (removed_at = NULL); renames update full_name. */
export async function upsertRepositories(
  ex: Executor,
  installationId: number,
  repos: readonly RepositoryInput[],
  now: Date,
): Promise<void> {
  for (const r of repos) {
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
