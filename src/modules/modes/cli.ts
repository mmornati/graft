/**
 * What `pnpm graft mode` prints and accepts (Phase 1 step 1, spec §8). No GitHub, no queue: the
 * CLI writes `mode_changes` rows and the worker acts on them (D6).
 */
import type { Config } from "../../config/index.js";
import type { Db } from "../../db/client.js";
import {
  type EffectiveModes,
  hasMembersRead,
  hasStatusesRead,
  type Mode,
  type ModeKey,
  type ModeReason,
  type ModeState,
} from "../../modes/index.js";

export const TEAMS_NOTE =
  "note: team constraints cannot be verified (no members:read); they will fail";
/** Phase 1 step 4 (§10). */
export const GUARD_STATUSES_NOTE = "note: guard reads check runs only (no statuses:read)";
export const GUARD_OFF_NOTE = "note: guard detection is off on this shell's config";
/** Phase 1 step 5 (§13). */
export const GUARD_REVERT_OFF_NOTE = "note: guard reverts are off on this shell's config";

/** What `show` needs from this shell's configuration (Phase 1 steps 4 and 5). */
export interface ShowOptions {
  /** `GRAFT_GUARD_DETECTION` of this shell; omitted means on. */
  guardDetection?: boolean;
  /** `GRAFT_GUARD_REVERT` of this shell; omitted means on. */
  guardRevert?: boolean;
}

import { CEILING_STATE_KEY } from "./ceiling.js";
import { modesOf } from "./effective.js";
import { countUnapplied, getServiceState, type RepositoryModeRow } from "./store.js";

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export interface CeilingInfo {
  /** The ceiling `effective` is computed with. */
  ceiling: Mode;
  source: "worker" | "shell";
  /** When the worker last stored a different value. */
  since: Date | null;
  /** This shell's value, when the worker's differs from it. */
  shell: Mode;
  worker: Mode | null;
}

/** The worker's ceiling (`service_state`) wins; the shell's own configuration is the fallback. */
export async function resolveCeiling(
  db: Db,
  config: Pick<Config, "modeCeiling">,
): Promise<CeilingInfo> {
  const stored = await getServiceState(db, CEILING_STATE_KEY);
  const worker = stored?.value === "report" || stored?.value === "enforce" ? stored.value : null;
  return worker === null
    ? {
        ceiling: config.modeCeiling,
        source: "shell",
        since: null,
        shell: config.modeCeiling,
        worker,
      }
    : {
        ceiling: worker,
        source: "worker",
        since: stored?.updatedAt ?? null,
        shell: config.modeCeiling,
        worker,
      };
}

export interface RepositoryView {
  row: RepositoryModeRow;
  modes: EffectiveModes;
  pending: number;
}

export async function viewRepository(
  db: Db,
  row: RepositoryModeRow,
  ceiling: CeilingInfo,
): Promise<RepositoryView> {
  return {
    row,
    modes: modesOf(row, ceiling.ceiling),
    pending: await countUnapplied(db, row.repositoryId),
  };
}

function reasonText(s: ModeState<string>): string {
  if (s.reason === "repository") return "";
  return s.missing === undefined ? s.reason : `${s.reason} ${s.missing}`;
}

function modeLine(label: string, s: ModeState<string>): string {
  const tail = reasonText(s);
  return `  ${label.padEnd(11)}requested ${s.requested.padEnd(7)}  effective ${s.effective.padEnd(7)}${tail === "" ? "" : `  ${tail}`}`.trimEnd();
}

function ceilingLine(c: CeilingInfo): string {
  const where =
    c.source === "worker"
      ? `worker: ${c.worker}${c.since ? ` since ${iso(c.since)}` : ""}`
      : "worker: not seen; using this shell's GRAFT_MODE_CEILING";
  return `  ${"ceiling".padEnd(11)}${c.ceiling}  (${where})`;
}

export function renderRepository(
  v: RepositoryView,
  ceiling: CeilingInfo,
  opts: ShowOptions = {},
): string {
  const { row, modes } = v;
  const lines = [
    `${row.fullName} (repository ${row.repositoryId}, installation ${row.installationId})`,
    ceilingLine(ceiling),
    modeLine("policy", modes.policy),
    modeLine("guard", modes.guard),
    modeLine("mcp_write", modes.mcpWrite),
    row.permissions === null || row.permissionsReadAt === null
      ? "  permissions  not read"
      : `  permissions  ${
          Object.entries(row.permissions)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, level]) => `${name}:${level}`)
            .join(" ") || "none"
        }  (read ${iso(row.permissionsReadAt)})`,
  ];
  // Phase 1 step 2 (T10): enforcing without `members: read` fails every team constraint.
  if (modes.policy.effective === "enforce" && !hasMembersRead(row.permissions)) {
    lines.push(`  ${TEAMS_NOTE}`);
  }
  // Phase 1 step 4 (§10, D2): without statuses:read the guard works on check runs alone.
  if (!hasStatusesRead(row.permissions)) lines.push(`  ${GUARD_STATUSES_NOTE}`);
  if (opts.guardDetection === false) lines.push(`  ${GUARD_OFF_NOTE}`);
  if (opts.guardRevert === false) lines.push(`  ${GUARD_REVERT_OFF_NOTE}`);
  if (v.pending > 0) {
    lines.push(
      `  ${"pending".padEnd(11)}${v.pending} ${v.pending === 1 ? "change" : "changes"} not yet applied by the worker`,
    );
  }
  return lines.join("\n");
}

/** The warning when this shell's ceiling is not the one the worker runs with. */
export function ceilingWarning(c: CeilingInfo): string | null {
  return c.worker !== null && c.worker !== c.shell
    ? `warning: this shell's GRAFT_MODE_CEILING is ${c.shell}; the worker runs with ${c.worker}`
    : null;
}

export function renderShow(
  views: readonly RepositoryView[],
  ceiling: CeilingInfo,
  opts: ShowOptions = {},
): string {
  const warning = ceilingWarning(ceiling);
  const blocks = views.map((v) => renderRepository(v, ceiling, opts));
  return `${warning === null ? "" : `${warning}\n`}${blocks.join("\n\n")}\n`;
}

export function showJson(views: readonly RepositoryView[], ceiling: CeilingInfo): unknown {
  return {
    repositories: views.map((v) => ({
      fullName: v.row.fullName,
      repositoryId: v.row.repositoryId,
      installationId: v.row.installationId,
      ceiling: ceiling.ceiling,
      ceilingSource: ceiling.source,
      policy: v.modes.policy,
      guard: v.modes.guard,
      mcpWrite: v.modes.mcpWrite,
      permissions: v.row.permissions ?? {},
      permissionsReadAt: v.row.permissionsReadAt?.toISOString() ?? null,
      pendingChanges: v.pending,
    })),
  };
}

const SHORT: Record<ModeKey, string> = {
  policy_mode: "policy",
  guard_mode: "guard",
  mcp_write: "mcp_write",
};

/** `note:` lines for the keys of a `set` whose requested value will not be effective. */
export function notEffectiveNotes(v: RepositoryView, keys: readonly ModeKey[]): string[] {
  const states: Record<ModeKey, ModeState<string>> = {
    policy_mode: v.modes.policy,
    guard_mode: v.modes.guard,
    mcp_write: v.modes.mcpWrite,
  };
  return keys.flatMap((key) => {
    const s = states[key];
    if (s.requested === s.effective) return [];
    const why: ModeReason = s.reason;
    const tail = s.missing === undefined ? why : `${why} ${s.missing}`;
    return [
      `note: ${SHORT[key]} is requested ${s.requested} but effective ${s.effective} (${tail})`,
    ];
  });
}

const REASON = /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,200}$/u;
const ACTOR = /^[A-Za-z0-9._@-]{1,64}$/;

/** D15: 1 to 200 printable characters, no newline. */
export const validReason = (s: string): boolean => REASON.test(s) && Array.from(s).length <= 200;
export const validActor = (s: string): boolean => ACTOR.test(s);
