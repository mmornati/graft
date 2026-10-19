import type { Config } from "../../config/index.js";
import type { Db } from "../../db/client.js";
import type { MutationGate } from "../../github/mutation-guard.js";
import { type EffectiveModes, effectiveModes } from "../../modes/index.js";
import {
  findActiveRepositoryByName,
  getRepositoryModeRow,
  type RepositoryModeRow,
} from "./store.js";

export function modesOf(row: RepositoryModeRow, ceiling: Config["modeCeiling"]): EffectiveModes {
  return effectiveModes({
    ceiling,
    requested: row.requested,
    permissions: row.permissions,
    installationActive: row.installationActive,
    repositoryActive: row.repositoryActive,
  });
}

/** The effective modes of a repository, read from the database now. An unknown id throws. */
export async function getEffectiveModes(
  db: Db,
  repositoryId: number,
  config: Pick<Config, "modeCeiling">,
): Promise<EffectiveModes> {
  const row = await getRepositoryModeRow(db, repositoryId);
  if (!row) throw new Error("unknown repository");
  return modesOf(row, config.modeCeiling);
}

/**
 * The gate behind every Phase 1 write (D12): the mode is read at request time, never cached, so a
 * rollback takes effect on the next request.
 */
export function mutationGate(db: Db, config: Pick<Config, "modeCeiling">): MutationGate {
  return async ({ installationId, owner, repo, feature }) => {
    const row = await findActiveRepositoryByName(db, installationId, owner, repo);
    if (!row) return { allowed: false, reason: "repository_unknown" };
    const modes = modesOf(row, config.modeCeiling);
    if (feature === "guard") {
      return modes.guard.effective === "enforce"
        ? { allowed: true }
        : { allowed: false, reason: "mode_report" };
    }
    return modes.mcpWrite.effective === "on"
      ? { allowed: true }
      : { allowed: false, reason: "mode_off" };
  };
}
