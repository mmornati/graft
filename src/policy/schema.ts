/**
 * The zod schema of `graft.yaml` v1 (spec §6, §7) and the normalised `Policy` types.
 *
 * Structure lives in the zod schema; every leaf sets `{ error: "<catalogue code>" }`. The rules
 * that look across fields (exactly one action, approve restrictions, size bounds, unique names,
 * glob validity, counts) live in `crossChecks`, which always runs on the raw value so that one
 * structural error does not hide the others. Both emit the same codes (`RawIssue`).
 */
import { z } from "zod";
import { LIMITS } from "./constants.js";
import { POLICY_ERROR_CODES, type PolicyErrorCode } from "./errors.js";
import { validateGlob } from "./globs.js";

export type RiskClass = "trivial" | "logic" | "sensitive";

export interface Policy {
  version: 1;
  sensitivePaths: string[];
  default: { humans: number; teams: string[] };
  rules: PolicyRule[];
  /**
   * Phase 1 step 4 (§9): the post-merge guard's scope. Absent when the file has no `guard` key, so
   * the canonical form (and the policy hash) of a file without it is unchanged. The evaluator
   * ignores it.
   */
  guard?: { checks?: string[] };
}
export interface PolicyRule {
  index: number;
  name: string | null;
  match: {
    risk?: RiskClass[];
    paths?: string[];
    onlyPaths?: string[];
    author?: "agent" | "human";
    agents?: string[];
    labels?: string[];
    size?: { minLines?: number; maxLines?: number; minFiles?: number; maxFiles?: number };
  };
  action:
    | { kind: "approve" }
    | { kind: "require"; humans: number; teams: string[] }
    | { kind: "block" };
}

export const TEAM_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/;
export const RULE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,79}$/;
/** The step 2 `Graft-Agent` value rule. */
export const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+()-]{0,99}$/;
const LABEL_RE = /^[^\p{Cc}]{1,50}$/u;
/** Phase 1 step 4: a check name or status context, 1-200 characters, no control character. */
export const GUARD_CHECK_RE = /^[^\p{Cc}]{1,200}$/u;

const oneOrList = <T extends z.ZodType, L extends z.ZodType>(item: T, list: L) =>
  z.union([item, list]);

const humans = z
  .number({ error: "humans_invalid" })
  .int({ error: "humans_invalid" })
  .min(1, { error: "humans_invalid" })
  .max(10, { error: "humans_invalid" });
const team = z.string({ error: "team_invalid" }).regex(TEAM_RE, { error: "team_invalid" });
const sizeBound = z
  .number({ error: "size_invalid" })
  .int({ error: "size_invalid" })
  .min(0, { error: "size_invalid" })
  .max(LIMITS.sizeMax, { error: "size_invalid" });
const glob = z.string({ error: "wrong_type" });
const globList = (max: number) =>
  z
    .array(glob, { error: "wrong_type" })
    .min(1, { error: "wrong_type" })
    .max(max, { error: "too_many_items" });

const requireSchema = z.strictObject(
  {
    humans: humans.optional(),
    team: oneOrList(
      team,
      z
        .array(team, { error: "team_invalid" })
        .min(1, { error: "team_invalid" })
        .max(LIMITS.teams, { error: "too_many_items" }),
    ).optional(),
  },
  { error: "wrong_type" },
);

const riskItem = z.enum(["trivial", "logic", "sensitive"], { error: "risk_invalid" });
const agentItem = z.string({ error: "agent_invalid" }).regex(AGENT_RE, { error: "agent_invalid" });

const matchSchema = z.strictObject(
  {
    risk: oneOrList(
      riskItem,
      z.array(riskItem, { error: "risk_invalid" }).min(1, { error: "risk_invalid" }),
    ).optional(),
    paths: globList(LIMITS.matchGlobs).optional(),
    only_paths: globList(LIMITS.matchGlobs).optional(),
    author: z.enum(["agent", "human"], { error: "author_invalid" }).optional(),
    agent: oneOrList(
      agentItem,
      z
        .array(agentItem, { error: "agent_invalid" })
        .min(1, { error: "agent_invalid" })
        .max(LIMITS.agents, { error: "too_many_items" }),
    ).optional(),
    labels: z
      .array(z.string({ error: "label_invalid" }).regex(LABEL_RE, { error: "label_invalid" }), {
        error: "label_invalid",
      })
      .min(1, { error: "label_invalid" })
      .max(LIMITS.labels, { error: "too_many_items" })
      .optional(),
    size: z
      .strictObject(
        {
          min_lines: sizeBound.optional(),
          max_lines: sizeBound.optional(),
          min_files: sizeBound.optional(),
          max_files: sizeBound.optional(),
        },
        { error: "size_invalid" },
      )
      .optional(),
  },
  { error: "match_missing" },
);

const ruleSchema = z.strictObject(
  {
    name: z
      .string({ error: "name_invalid" })
      .regex(RULE_NAME_RE, { error: "name_invalid" })
      .optional(),
    match: matchSchema,
    approve: z.literal("auto", { error: "approve_invalid" }).optional(),
    require: requireSchema.optional(),
    block: z.literal(true, { error: "block_invalid" }).optional(),
  },
  { error: "wrong_type" },
);

const guardSchema = z.strictObject(
  {
    checks: z
      .array(z.string({ error: "wrong_type" }).regex(GUARD_CHECK_RE, { error: "wrong_type" }), {
        error: "wrong_type",
      })
      .min(1, { error: "wrong_type" })
      .max(LIMITS.guardChecks, { error: "too_many_items" })
      .optional(),
  },
  { error: "wrong_type" },
);

export const policySchema = z.strictObject(
  {
    version: z.literal(1),
    sensitive_paths: globList(LIMITS.sensitivePaths).optional(),
    default: z.strictObject({ require: requireSchema }, { error: "default_invalid" }).optional(),
    rules: z
      .array(ruleSchema, { error: "wrong_type" })
      .max(LIMITS.rules, { error: "too_many_rules" })
      .optional(),
    guard: guardSchema.optional(),
  },
  { error: "wrong_type" },
);
export type RawPolicy = z.infer<typeof policySchema>;

/** Rules a JSON Schema cannot express; listed in the generated schema's description. */
export const POLICY_REFINEMENTS = [
  "approve: auto may use only risk, only_paths and size (not author, agent, labels or paths)",
  "size: min is not above max",
  "rule names are unique",
  "globs use only letters, digits and _ . - / * ? [ ] @ + = ~ # % , and space, with no .. or empty segment, at most 4 ** segments, at most 3 * per segment, at most 200 characters, at most 48 characters other than * in a segment and 96 in a glob, no / inside [ ], no run of three stars and no ]+; a path over 1,024 characters or 128 segments is treated as matching every sensitive and require rule and no approve rule",
  "at most 500 globs in the file",
];

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

export type PathSeg = string | number;
export interface RawIssue {
  code: PolicyErrorCode;
  /** 0-based indices. */
  path: PathSeg[];
  /** unknown_key: the offending key (the path is its parent). */
  key?: string;
  detail?: number;
}

const CODES = new Set<string>(POLICY_ERROR_CODES);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function valueAt(root: unknown, path: readonly PathSeg[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (Array.isArray(cur) && typeof seg === "number") cur = cur[seg];
    else if (isRecord(cur) && typeof seg === "string" && Object.hasOwn(cur, seg)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

function mapZodIssue(
  issue: z.core.$ZodIssue,
  base: readonly PathSeg[],
  raw: unknown,
  out: RawIssue[],
): void {
  const path: PathSeg[] = [...base, ...(issue.path as PathSeg[])];
  if (issue.code === "unrecognized_keys") {
    for (const key of issue.keys) {
      const isDefault = path.length === 1 && path[0] === "default";
      out.push(
        isDefault && (key === "approve" || key === "block")
          ? { code: "default_invalid", path }
          : { code: "unknown_key", path, key: key.slice(0, 40) },
      );
    }
    return;
  }
  if (issue.code === "invalid_union") {
    const value = valueAt(raw, path);
    const branch = issue.errors[Array.isArray(value) ? 1 : 0] ?? [];
    for (const inner of branch) mapZodIssue(inner, path, raw, out);
    return;
  }
  if (path.length === 1 && path[0] === "version") {
    out.push({
      code: valueAt(raw, path) === undefined ? "version_missing" : "version_unsupported",
      path,
    });
    return;
  }
  if (
    path.length === 2 &&
    path[0] === "default" &&
    path[1] === "require" &&
    valueAt(raw, path) === undefined
  ) {
    out.push({ code: "default_invalid", path: ["default"] });
    return;
  }
  const code = CODES.has(issue.message) ? (issue.message as PolicyErrorCode) : "wrong_type";
  out.push({ code, path });
}

/** Structural issues from the zod schema, mapped to the catalogue. */
export function structuralIssues(raw: unknown): { issues: RawIssue[]; data: RawPolicy | null } {
  const res = policySchema.safeParse(raw);
  if (res.success) return { issues: [], data: res.data };
  const out: RawIssue[] = [];
  for (const i of res.error.issues) mapZodIssue(i, [], raw, out);
  return { issues: out, data: null };
}

const has = (o: Record<string, unknown>, k: string): boolean => Object.hasOwn(o, k);

/** The refinements of §7: they always run, on whatever the raw value looks like. */
export function crossChecks(raw: unknown): RawIssue[] {
  const out: RawIssue[] = [];
  if (!isRecord(raw)) return out;
  let globCount = 0;
  const checkGlobs = (value: unknown, path: PathSeg[]) => {
    if (!Array.isArray(value)) return;
    value.forEach((g, j) => {
      if (typeof g !== "string") return;
      globCount++;
      const detail = validateGlob(g);
      if (detail !== null) out.push({ code: "glob_invalid", path: [...path, j], detail });
    });
  };
  checkGlobs(raw.sensitive_paths, ["sensitive_paths"]);

  if (isRecord(raw.default) && isRecord(raw.default.require)) {
    if (Object.keys(raw.default.require).length === 0)
      out.push({ code: "require_empty", path: ["default", "require"] });
  }

  if (Array.isArray(raw.rules)) {
    const names = new Set<string>();
    raw.rules.forEach((r, i) => {
      if (!isRecord(r)) return;
      const rp: PathSeg[] = ["rules", i];
      const actions = ["approve", "require", "block"].filter((k) => has(r, k));
      if (actions.length === 0) out.push({ code: "action_missing", path: rp });
      if (actions.length > 1) out.push({ code: "action_conflict", path: rp });

      if (typeof r.name === "string") {
        if (names.has(r.name)) out.push({ code: "name_duplicate", path: [...rp, "name"] });
        names.add(r.name);
      }
      if (has(r, "require") && isRecord(r.require) && Object.keys(r.require).length === 0) {
        out.push({ code: "require_empty", path: [...rp, "require"] });
      }
      const m = r.match;
      if (!isRecord(m)) return;
      const mp: PathSeg[] = [...rp, "match"];
      if (Object.keys(m).length === 0) out.push({ code: "match_missing", path: mp });
      if (has(r, "approve")) {
        for (const k of ["author", "agent", "labels"]) {
          if (has(m, k)) out.push({ code: "approve_untrusted_key", path: [...mp, k] });
        }
        if (has(m, "paths")) out.push({ code: "approve_any_path", path: [...mp, "paths"] });
      }
      checkGlobs(m.paths, [...mp, "paths"]);
      checkGlobs(m.only_paths, [...mp, "only_paths"]);
      const s = m.size;
      if (isRecord(s)) {
        const keys = ["min_lines", "max_lines", "min_files", "max_files"];
        const bad =
          !keys.some((k) => has(s, k)) ||
          (typeof s.min_lines === "number" &&
            typeof s.max_lines === "number" &&
            s.min_lines > s.max_lines) ||
          (typeof s.min_files === "number" &&
            typeof s.max_files === "number" &&
            s.min_files > s.max_files);
        if (bad) out.push({ code: "size_invalid", path: [...mp, "size"] });
      }
    });
  }
  if (globCount > LIMITS.globs) out.push({ code: "too_many_globs", path: [] });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------------

const dedupe = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const asList = <T>(v: T | T[] | undefined): T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

/** From a structurally valid parse result. Lists are deduplicated, scalars become lists. */
export function normalizePolicy(data: RawPolicy): Policy {
  const rules: PolicyRule[] = (data.rules ?? []).map((r, i) => {
    const m = r.match;
    const match: PolicyRule["match"] = {};
    const risk = asList(m.risk);
    if (risk) match.risk = dedupe(risk);
    if (m.paths) match.paths = dedupe(m.paths);
    if (m.only_paths) match.onlyPaths = dedupe(m.only_paths);
    if (m.author) match.author = m.author;
    const agents = asList(m.agent);
    if (agents) match.agents = dedupe(agents);
    if (m.labels) match.labels = dedupe(m.labels);
    if (m.size) {
      const size: NonNullable<PolicyRule["match"]["size"]> = {};
      if (m.size.min_lines !== undefined) size.minLines = m.size.min_lines;
      if (m.size.max_lines !== undefined) size.maxLines = m.size.max_lines;
      if (m.size.min_files !== undefined) size.minFiles = m.size.min_files;
      if (m.size.max_files !== undefined) size.maxFiles = m.size.max_files;
      match.size = size;
    }
    let action: PolicyRule["action"];
    if (r.block !== undefined) action = { kind: "block" };
    else if (r.require !== undefined)
      action = {
        kind: "require",
        humans: r.require.humans ?? 1,
        teams: dedupe(asList(r.require.team) ?? []),
      };
    else action = { kind: "approve" };
    return { index: i + 1, name: r.name ?? null, match, action };
  });
  const def = data.default?.require;
  const policy: Policy = {
    version: 1,
    sensitivePaths: dedupe(data.sensitive_paths ?? []),
    default: { humans: def?.humans ?? 1, teams: dedupe(asList(def?.team) ?? []) },
    rules,
  };
  // Only when present: a file without `guard` keeps its canonical form and its hash.
  if (data.guard !== undefined) {
    policy.guard = data.guard.checks === undefined ? {} : { checks: dedupe(data.guard.checks) };
  }
  return policy;
}
