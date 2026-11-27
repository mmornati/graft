import type { Db } from "../../db/client.js";

export class BillingTeamError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "BillingTeamError";
  }
}

export interface BillingTeamView {
  id: string;
  name: string;
  archivedAt: string | null;
  repositories: { id: number; fullName: string }[];
}

function teamName(value: string): string {
  const name = value.trim();
  const hasControl = [...name].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );
  if (!name || name.length > 100 || hasControl) {
    throw new BillingTeamError(400, "Team name must be 1–100 printable characters.");
  }
  return name;
}

function duplicate(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

export async function listBillingTeams(db: Db): Promise<BillingTeamView[]> {
  const teams = await db
    .selectFrom("billing_teams")
    .select(["id", "name", "archived_at"])
    .orderBy("archived_at", "asc")
    .orderBy("name", "asc")
    .execute();
  const memberships = await db
    .selectFrom("billing_team_repositories as tr")
    .innerJoin("repositories as r", "r.id", "tr.repository_id")
    .select(["tr.team_id", "r.id", "r.full_name"])
    .where("r.removed_at", "is", null)
    .orderBy("r.full_name")
    .execute();
  const byTeam = new Map<string, { id: number; fullName: string }[]>();
  for (const row of memberships) {
    const repositories = byTeam.get(row.team_id) ?? [];
    repositories.push({ id: Number(row.id), fullName: row.full_name });
    byTeam.set(row.team_id, repositories);
  }
  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    archivedAt: team.archived_at?.toISOString() ?? null,
    repositories: byTeam.get(team.id) ?? [],
  }));
}

export async function createBillingTeam(
  db: Db,
  o: { name: string; actor: string; now: Date },
): Promise<{ id: string; name: string }> {
  try {
    return await db
      .insertInto("billing_teams")
      .values({ name: teamName(o.name), created_by: o.actor, created_at: o.now })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
  } catch (err) {
    if (duplicate(err)) throw new BillingTeamError(409, "A billing team with that name exists.");
    throw err;
  }
}

export async function renameBillingTeam(db: Db, o: { id: string; name: string }): Promise<void> {
  try {
    const changed = await db
      .updateTable("billing_teams")
      .set({ name: teamName(o.name) })
      .where("id", "=", o.id)
      .where("archived_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!changed) throw new BillingTeamError(404, "Active billing team not found.");
  } catch (err) {
    if (duplicate(err)) throw new BillingTeamError(409, "A billing team with that name exists.");
    throw err;
  }
}

export async function archiveBillingTeam(db: Db, o: { id: string; now: Date }): Promise<void> {
  const changed = await db
    .updateTable("billing_teams")
    .set({ archived_at: o.now })
    .where("id", "=", o.id)
    .where("archived_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!changed) throw new BillingTeamError(404, "Active billing team not found.");
}

export async function setBillingTeamRepository(
  db: Db,
  o: { teamId: string; repositoryId: number; actor: string; now: Date; attached: boolean },
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const team = await tx
      .selectFrom("billing_teams")
      .select("id")
      .where("id", "=", o.teamId)
      .where("archived_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!team) throw new BillingTeamError(404, "Active billing team not found.");
    const repo = await tx
      .selectFrom("repositories")
      .select("id")
      .where("id", "=", o.repositoryId)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    if (!repo) throw new BillingTeamError(404, "Active Graft repository not found.");
    if (o.attached) {
      await tx
        .insertInto("billing_team_repositories")
        .values({
          team_id: o.teamId,
          repository_id: o.repositoryId,
          created_by: o.actor,
          created_at: o.now,
        })
        .onConflict((oc) => oc.columns(["team_id", "repository_id"]).doNothing())
        .execute();
    } else {
      await tx
        .deleteFrom("billing_team_repositories")
        .where("team_id", "=", o.teamId)
        .where("repository_id", "=", o.repositoryId)
        .execute();
    }
  });
}
