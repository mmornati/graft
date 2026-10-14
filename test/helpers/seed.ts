import type { Db } from "../../src/db/client.js";
import { INSTALLATION_ID, OWNER, REPO, REPO_ID } from "./github-builders.js";

/** Installation 1000001 with repository 2000001 (graft-sandbox/sample-ts), both active. */
export async function seedWorld(
  db: Db,
  o: { suspended?: boolean; deleted?: boolean; repoRemoved?: boolean } = {},
): Promise<void> {
  const now = new Date("2026-10-01T00:00:00Z");
  await db
    .insertInto("installations")
    .values({
      id: INSTALLATION_ID,
      account_id: 9000001,
      account_login: OWNER,
      account_type: "Organization",
      repository_selection: "selected",
      suspended_at: o.suspended ? now : null,
      deleted_at: o.deleted ? now : null,
    })
    .execute();
  await db
    .insertInto("repositories")
    .values({
      id: REPO_ID,
      installation_id: INSTALLATION_ID,
      full_name: `${OWNER}/${REPO}`,
      private: true,
      default_branch: "main",
      removed_at: o.repoRemoved ? now : null,
    })
    .execute();
}
