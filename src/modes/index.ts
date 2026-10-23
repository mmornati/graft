/**
 * Modes (Phase 1 step 1, spec §6). Pure: no database, no GitHub, no clock. The effective mode of a
 * repository is the lower of what the operator asked for and the server ceiling, lowered further
 * whenever the installation lacks a permission the mode needs. Every rule fails toward report/off.
 * Nothing here is read from a repository: `graft.yaml`, labels and PR text cannot change a mode.
 */

export type Mode = "report" | "enforce";
export type Switch = "off" | "on";
export type ModeKey = "policy_mode" | "guard_mode" | "mcp_write";
export type PermissionLevel = "read" | "write" | "admin";

export type ModeReason =
  /** effective = requested */
  | "repository"
  /** lowered by GRAFT_MODE_CEILING */
  | "ceiling"
  /** a needed permission is absent or too low */
  | "permission_missing"
  /** permissions never read */
  | "permissions_unknown"
  | "installation_inactive"
  | "repository_removed";

export interface ModeState<V> {
  requested: V;
  effective: V;
  reason: ModeReason;
  /** `"contents:write"`: the first permission that is missing, for `permission_missing`. */
  missing?: string;
}

export interface EffectiveModes {
  ceiling: Mode;
  policy: ModeState<Mode>;
  guard: ModeState<Mode>;
  mcpWrite: ModeState<Switch>;
}

/** The permissions each mode needs on top of Phase 0's. `policy_mode` needs none in step 1. */
export const PERMISSION_NEEDS = {
  policy_mode: [],
  guard_mode: [["contents", "write"]],
  mcp_write: [["pull_requests", "write"]],
} as const satisfies Record<ModeKey, readonly (readonly [string, PermissionLevel])[]>;

const LEVEL: Record<PermissionLevel, number> = { read: 1, write: 2, admin: 3 };

/** The lower of two values; both orders are `low < high` (report < enforce, off < on). */
export function lowest<V extends string>(order: readonly [V, V], a: V, b: V): V {
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

/**
 * Phase 1 step 7 (D2): the ceiling a process computes with is the lower of its own
 * `GRAFT_MODE_CEILING` and the value the last worker start stored in `service_state`. A missing row
 * (no worker ever started) means the process's value alone; any stored value other than `report` or
 * `enforce` means `report`. A worker start can therefore only lower the ceiling of every process
 * that runs this code, so a rolling restart that lowers it is safe once the first new worker starts.
 */
export function effectiveCeiling(env: Mode, stored: string | null | undefined): Mode {
  if (stored === null || stored === undefined) return env;
  const worker: Mode = stored === "enforce" ? "enforce" : "report";
  return lowest(["report", "enforce"], env, worker);
}

export interface EffectiveModesInput {
  ceiling: Mode;
  requested: { policy_mode: Mode; guard_mode: Mode; mcp_write: Switch };
  /** null: never read. */
  permissions: Readonly<Record<string, PermissionLevel>> | null;
  installationActive: boolean;
  repositoryActive: boolean;
}

function state<V extends string>(
  key: ModeKey,
  floor: V,
  requested: V,
  i: EffectiveModesInput,
): ModeState<V> {
  const lowered = (reason: ModeReason, missing?: string): ModeState<V> => ({
    requested,
    effective: floor,
    reason,
    ...(missing === undefined ? {} : { missing }),
  });
  if (!i.installationActive) return lowered("installation_inactive");
  if (!i.repositoryActive) return lowered("repository_removed");
  if (requested === floor) return { requested, effective: floor, reason: "repository" };
  if (i.ceiling === "report") return lowered("ceiling");
  for (const [name, level] of PERMISSION_NEEDS[key]) {
    if (i.permissions === null) return lowered("permissions_unknown");
    const have = i.permissions[name];
    // An unrecognised level counts as missing: the rule always fails toward report.
    if (have === undefined || !Object.hasOwn(LEVEL, have) || LEVEL[have] < LEVEL[level]) {
      return lowered("permission_missing", `${name}:${level}`);
    }
  }
  return { requested, effective: requested, reason: "repository" };
}

/**
 * Phase 1 step 2 (D15): whether the stored installation permissions include `members` at read or
 * above. null (never read) and an unknown level count as missing. `policy_mode` does not need it:
 * without it, team constraints are unverified and never met.
 */
export function hasMembersRead(
  permissions: Readonly<Record<string, string>> | null | undefined,
): boolean {
  if (permissions === null || permissions === undefined) return false;
  if (!Object.hasOwn(permissions, "members")) return false;
  const have = permissions.members as string;
  return Object.hasOwn(LEVEL, have) && LEVEL[have as PermissionLevel] >= LEVEL.read;
}

/**
 * Phase 1 step 4 (D2): whether the stored permissions include `statuses` at read or above. Without
 * it the guard reads check runs only. null (never read) and an unknown level count as missing.
 */
export function hasStatusesRead(
  permissions: Readonly<Record<string, string>> | null | undefined,
): boolean {
  if (permissions === null || permissions === undefined) return false;
  if (!Object.hasOwn(permissions, "statuses")) return false;
  const have = permissions.statuses as string;
  return Object.hasOwn(LEVEL, have) && LEVEL[have as PermissionLevel] >= LEVEL.read;
}

export function effectiveModes(input: EffectiveModesInput): EffectiveModes {
  const r = input.requested;
  return {
    ceiling: input.ceiling,
    policy: state("policy_mode", "report", r.policy_mode, input),
    guard: state("guard_mode", "report", r.guard_mode, input),
    mcpWrite: state("mcp_write", "off", r.mcp_write, input),
  };
}
