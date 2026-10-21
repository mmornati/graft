/**
 * The policy evaluator (spec §9). Pure, total and deterministic: no I/O, never throws on valid
 * input, and the only place where the rule semantics live.
 *
 * Safety properties, all tested: block wins, a matching require beats approve, an unknown fact
 * never loosens (it matches as `uncertain` in tightening rules and must hold for every possible
 * value in approve rules), and `would_approve` needs a matching approve rule and nothing else.
 */
import { GlobBudget, globMatcher, pathOverLimit } from "../core/glob.js";
import { POLICY_FILE_GLOBS } from "./constants.js";
import type { Policy, PolicyRule, RiskClass } from "./schema.js";

export interface PolicyFacts {
  files: { path: string; previousPath: string | null }[];
  listingComplete: boolean;
  /** pull.additions + deletions; pull.changed_files */
  size: { lines: number; files: number };
  risk: { value: RiskClass; final: boolean; source: "card" | "card_unavailable" | "card_pending" };
  author: { kind: "agent" | "human" | "unknown"; agent: string | null };
  labels: string[];
}

/**
 * Why a verdict leans on the strict side for a reason other than the facts (review 2): a changed
 * path over the length caps, or the shared glob work budget ran out.
 */
export type VerdictLimit = "path_too_long" | "budget_exhausted";

export type MatchKey = "risk" | "paths" | "only_paths" | "author" | "agent" | "labels" | "size";
export interface MatchReason {
  key: MatchKey;
  uncertain: boolean;
  /** At most 5, in code-point order. For `labels` these are the matching PR labels. */
  paths: string[];
  count: number;
}
export interface MatchedRule {
  index: number;
  action: "approve" | "require" | "block";
  reasons: MatchReason[];
  overridden: boolean;
}
/** `rules` = indices of the contributing rules; `[]` for the default; `[0]` for the built-in. */
export interface Constraint {
  humans: number;
  teams: string[];
  rules: number[];
}
export interface EffectiveRisk {
  value: RiskClass;
  final: boolean;
  source: PolicyFacts["risk"]["source"];
  raisedBy: ("sensitive_paths" | "policy_file")[];
}
export type PolicyVerdict =
  | {
      outcome: "would_approve";
      matched: MatchedRule[];
      effectiveRisk: EffectiveRisk;
      policyFileChanged: false;
      limits?: VerdictLimit[];
    }
  | {
      outcome: "would_require";
      matched: MatchedRule[];
      effectiveRisk: EffectiveRisk;
      policyFileChanged: boolean;
      humans: number;
      constraints: Constraint[];
      usedDefault: boolean;
      builtIn: "policy_file_changed" | null;
      limits?: VerdictLimit[];
    }
  | {
      outcome: "would_block";
      matched: MatchedRule[];
      effectiveRisk: EffectiveRisk;
      policyFileChanged: boolean;
      blockedBy: number[];
      limits?: VerdictLimit[];
    };

const RANK: Record<RiskClass, number> = { trivial: 0, logic: 1, sensitive: 2 };
const CLASSES: RiskClass[] = ["trivial", "logic", "sensitive"];

function compareCodePoints(a: string, b: string): number {
  // No allocation (paths are sorted by this, up to 1,000 of them per rule): walk both strings.
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(j) as number;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  const rest = (s: string, k: number): number => {
    let n = 0;
    while (k < s.length) {
      k += (s.codePointAt(k) as number) > 0xffff ? 2 : 1;
      n++;
    }
    return n;
  };
  return rest(a, i) - rest(b, j);
}

const top5 = (xs: readonly string[]): { paths: string[]; count: number } => {
  const sorted = [...new Set(xs)].sort(compareCodePoints);
  return { paths: sorted.slice(0, 5), count: sorted.length };
};

type Mode = "tighten" | "approve";

interface FileLike {
  path: string;
  previousPath: string | null;
}

const fileHits = (match: (p: string) => boolean, f: FileLike): boolean =>
  match(f.path) || (f.previousPath !== null && match(f.previousPath));

function evalKey(
  key: MatchKey,
  rule: PolicyRule,
  mode: Mode,
  facts: PolicyFacts,
  possible: readonly RiskClass[],
  budget: GlobBudget,
): MatchReason | null {
  const m = rule.match;
  const reason = (uncertain: boolean, paths: string[] = [], count = paths.length): MatchReason => ({
    key,
    uncertain,
    paths,
    count,
  });
  switch (key) {
    case "risk": {
      const want = m.risk ?? [];
      if (mode === "approve") {
        return possible.every((c) => want.includes(c)) ? reason(false) : null;
      }
      return possible.some((c) => want.includes(c)) ? reason(possible.length > 1) : null;
    }
    case "paths": {
      // Already out of budget: no need to look at the files (strict answer, uncertain).
      if (budget.exhausted) return mode === "tighten" ? reason(true) : null;
      // A path over the length caps matches a tightening rule and never an approve rule.
      const match = globMatcher(m.paths ?? [], { onLimit: mode === "tighten", budget });
      const limitsBefore = budget.limitHits;
      const hits = facts.files.filter((f) => fileHits(match, f)).map((f) => f.path);
      // A limit (path caps, a spent budget) answered for some file: a tightening rule is assumed
      // to match, flagged uncertain so that an assumed hit reads differently from a real one;
      // an approve rule never matches.
      if (budget.limitHits > limitsBefore) {
        if (mode !== "tighten") return null;
        // Cheap and bounded: the sort compares code points of (possibly 1,000-character) paths.
        const t = top5(hits.slice(0, 50));
        return reason(true, t.paths, hits.length);
      }
      if (hits.length > 0) {
        const t = top5(hits);
        return reason(false, t.paths, t.count);
      }
      // Tightening only: with an incomplete listing a hidden file could match.
      if (mode === "tighten" && !facts.listingComplete) return reason(true);
      return null;
    }
    case "only_paths": {
      if (!facts.listingComplete || facts.files.length === 0 || budget.exhausted) return null;
      const match = globMatcher(m.onlyPaths ?? [], { nocase: false, onLimit: false, budget });
      const limitsBefore = budget.limitHits;
      const all = facts.files.every(
        (f) => match(f.path) && (f.previousPath === null || match(f.previousPath)),
      );
      if (budget.limitHits > limitsBefore) return null;
      return all ? reason(false, [], facts.files.length) : null;
    }
    case "author": {
      const kind = facts.author.kind;
      if (kind === m.author) return reason(false);
      if (kind === "unknown" && mode === "tighten") return reason(true);
      return null;
    }
    case "agent": {
      const want = (m.agents ?? []).map((a) => a.toLowerCase());
      const { kind, agent } = facts.author;
      if (kind === "agent" && agent !== null) {
        return want.includes(agent.toLowerCase()) ? reason(false) : null;
      }
      if (mode === "approve") return null;
      if (kind === "human") return null;
      return reason(true); // kind unknown, or an agent whose name was not reported
    }
    case "labels": {
      const want = new Set((m.labels ?? []).map((l) => l.toLowerCase()));
      const hits = facts.labels.filter((l) => want.has(l.toLowerCase()));
      if (hits.length === 0) return null;
      const t = top5(hits);
      return reason(false, t.paths, t.count);
    }
    case "size": {
      const s = m.size ?? {};
      const { lines, files } = facts.size;
      const ok =
        (s.minLines === undefined || lines >= s.minLines) &&
        (s.maxLines === undefined || lines <= s.maxLines) &&
        (s.minFiles === undefined || files >= s.minFiles) &&
        (s.maxFiles === undefined || files <= s.maxFiles);
      return ok ? reason(false) : null;
    }
  }
}

const KEY_ORDER: { key: MatchKey; present: (m: PolicyRule["match"]) => boolean }[] = [
  { key: "risk", present: (m) => m.risk !== undefined },
  { key: "paths", present: (m) => m.paths !== undefined },
  { key: "only_paths", present: (m) => m.onlyPaths !== undefined },
  { key: "author", present: (m) => m.author !== undefined },
  { key: "agent", present: (m) => m.agents !== undefined },
  { key: "labels", present: (m) => m.labels !== undefined },
  { key: "size", present: (m) => m.size !== undefined },
];

function evalRule(
  rule: PolicyRule,
  facts: PolicyFacts,
  possible: readonly RiskClass[],
  budget: GlobBudget,
): MatchReason[] | null {
  const mode: Mode = rule.action.kind === "approve" ? "approve" : "tighten";
  const reasons: MatchReason[] = [];
  let any = false;
  for (const { key, present } of KEY_ORDER) {
    if (!present(rule.match)) continue;
    any = true;
    const r = evalKey(key, rule, mode, facts, possible, budget);
    if (r === null) return null;
    reasons.push(r);
  }
  // A rule with an empty match never matches (the parser rejects it; the evaluator is total).
  return any ? reasons : null;
}

const teamKey = (teams: readonly string[]) => teams.join("\u0000");

export interface EvaluateOptions {
  /** Share one work budget with the risk floor of the same job. */
  budget?: GlobBudget;
  /** A seam for tests: the budget of the built-in policy-file globs. */
  policyBudget?: GlobBudget;
}

export function evaluatePolicy(
  policy: Policy,
  facts: PolicyFacts,
  opts: EvaluateOptions = {},
): PolicyVerdict {
  // Effective risk (D12).
  // One deterministic work budget for the whole evaluation (the globs are author-controlled).
  const budget = opts.budget ?? new GlobBudget();
  const sensitiveMatch = globMatcher(policy.sensitivePaths, { onLimit: true, budget });
  const sensitiveHit = facts.files.some((f) => fileHits(sensitiveMatch, f));
  // The built-in policy-file globs are tiny; they get their own budget so that a spent shared one
  // cannot turn into a false "changes graft.yaml". A path over the length caps is not a match:
  // it is a different reason (`path_too_long`) and, like an incomplete listing, "may change".
  const policyBudget = opts.policyBudget ?? new GlobBudget();
  const policyMatch = globMatcher(POLICY_FILE_GLOBS, { onLimit: false, budget: policyBudget });
  const tooLong = facts.files.some(
    (f) => pathOverLimit(f.path) || (f.previousPath !== null && pathOverLimit(f.previousPath)),
  );
  const policyFileChanged = facts.files.some((f) => fileHits(policyMatch, f));
  const raisedBy: EffectiveRisk["raisedBy"] = [];
  let value = facts.risk.value;
  if (RANK[value] < RANK.sensitive) {
    if (sensitiveHit) raisedBy.push("sensitive_paths");
    if (policyFileChanged) raisedBy.push("policy_file");
    if (raisedBy.length > 0) value = "sensitive";
  }
  const effectiveRisk: EffectiveRisk = {
    value,
    final: facts.risk.final,
    source: facts.risk.source,
    raisedBy,
  };
  const possible: RiskClass[] =
    facts.risk.final || value === "sensitive"
      ? [value]
      : CLASSES.filter((c) => RANK[c] >= RANK[value]);

  // The PR may change the policy file without the list showing it (D5, D11).
  const mayChangePolicy = (): boolean =>
    !facts.listingComplete || tooLong || budget.exhausted || policyBudget.exhausted;

  // 1. every rule, in file order
  const matched: MatchedRule[] = [];
  for (const rule of policy.rules) {
    const reasons = evalRule(rule, facts, possible, budget);
    if (reasons) {
      matched.push({ index: rule.index, action: rule.action.kind, reasons, overridden: false });
    }
  }
  const limits = (): { limits?: VerdictLimit[] } => {
    const l: VerdictLimit[] = [];
    if (tooLong) l.push("path_too_long");
    if (budget.exhausted) l.push("budget_exhausted");
    return l.length > 0 ? { limits: l } : {};
  };
  const actionOf = new Map(policy.rules.map((r) => [r.index, r.action]));

  // 2. block wins
  const blocks = matched.filter((m) => m.action === "block");
  if (blocks.length > 0) {
    for (const m of matched) m.overridden = m.action !== "block";
    return {
      outcome: "would_block",
      matched,
      effectiveRisk,
      policyFileChanged,
      blockedBy: blocks.map((b) => b.index),
      ...limits(),
    };
  }

  // 3. a matching require beats approve
  const requires = matched.filter((m) => m.action === "require");
  if (requires.length > 0) {
    for (const m of matched) m.overridden = m.action === "approve";
    const byTeams = new Map<string, Constraint>();
    for (const m of requires) {
      const action = actionOf.get(m.index);
      if (action?.kind !== "require") continue;
      const teams = [...new Set(action.teams)].sort(compareCodePoints);
      const k = teamKey(teams);
      const existing = byTeams.get(k);
      if (existing) {
        existing.humans = Math.max(existing.humans, action.humans);
        existing.rules.push(m.index);
      } else {
        byTeams.set(k, { humans: action.humans, teams, rules: [m.index] });
      }
    }
    // Team constraints in rule order, then the anyone constraint.
    const all = [...byTeams.values()];
    const constraints = [
      ...all.filter((c) => c.teams.length > 0),
      ...all.filter((c) => c.teams.length === 0),
    ];
    return {
      outcome: "would_require",
      matched,
      effectiveRisk,
      policyFileChanged,
      humans: Math.max(...constraints.map((c) => c.humans)),
      constraints,
      usedDefault: false,
      builtIn: null,
      ...limits(),
    };
  }

  // 4. approve. With an incomplete listing the PR may change the policy file (D5, D11: an unknown
  // fact never loosens), so the built-in applies there too, without claiming that it did.
  if (matched.some((m) => m.action === "approve")) {
    if (policyFileChanged || mayChangePolicy()) {
      for (const m of matched) m.overridden = true;
      return {
        outcome: "would_require",
        matched,
        effectiveRisk,
        policyFileChanged,
        humans: 1,
        constraints: [{ humans: 1, teams: [], rules: [0] }],
        usedDefault: false,
        builtIn: "policy_file_changed",
        ...limits(),
      };
    }
    return {
      outcome: "would_approve",
      matched,
      effectiveRisk,
      policyFileChanged: false,
      ...limits(),
    };
  }

  // 5. nothing matched: the default
  const teams = [...new Set(policy.default.teams)].sort(compareCodePoints);
  return {
    outcome: "would_require",
    matched,
    effectiveRisk,
    policyFileChanged,
    humans: policy.default.humans,
    constraints: [{ humans: policy.default.humans, teams, rules: [] }],
    usedDefault: true,
    builtIn: policyFileChanged ? "policy_file_changed" : null,
    ...limits(),
  };
}

// ---------------------------------------------------------------------------------------------
// Approvals (D13)
// ---------------------------------------------------------------------------------------------

export interface ReviewLike {
  user: { id: number; login: string; type: string } | null;
  state: string;
  commit_id: string | null;
  submitted_at: string | null;
}
export interface ApprovalCount {
  current: number;
  stale: number;
  /** Current approvers, login order, at most 10. */
  users: string[];
  truncated: boolean;
  /** Every current approver, login order (Phase 1 step 2; the D17 bound is applied later). */
  currentApprovers: { id: number; login: string }[];
  /** Users whose latest counted review is CHANGES_REQUESTED, on any commit, login order. */
  changesRequested: { id: number; login: string }[];
}

const COUNTED = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

export function countApprovals(
  reviews: readonly ReviewLike[],
  o: { headSha: string; prAuthorLogin: string; truncated: boolean },
): ApprovalCount {
  const latest = new Map<number, { review: ReviewLike; at: number; order: number }>();
  reviews.forEach((review, order) => {
    const u = review.user;
    if (!u || u.type === "Bot") return;
    if (u.login.toLowerCase() === o.prAuthorLogin.toLowerCase()) return;
    if (!COUNTED.has(review.state)) return;
    const at = review.submitted_at ? Date.parse(review.submitted_at) : Number.NEGATIVE_INFINITY;
    const prev = latest.get(u.id);
    if (!prev || at > prev.at || (at === prev.at && order > prev.order)) {
      latest.set(u.id, { review, at: Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at, order });
    }
  });
  let current = 0;
  let stale = 0;
  const approvers: { id: number; login: string }[] = [];
  const changesRequested: { id: number; login: string }[] = [];
  for (const { review } of latest.values()) {
    if (!review.user) continue;
    const who = { id: review.user.id, login: review.user.login };
    if (review.state === "CHANGES_REQUESTED") {
      changesRequested.push(who);
      continue;
    }
    if (review.state !== "APPROVED") continue;
    if (review.commit_id === o.headSha) {
      current++;
      approvers.push(who);
    } else stale++;
  }
  approvers.sort(byLogin);
  changesRequested.sort(byLogin);
  return {
    current,
    stale,
    users: approvers.slice(0, 10).map((u) => u.login),
    truncated: o.truncated,
    currentApprovers: approvers,
    changesRequested,
  };
}

/** Case-insensitive login order, code points as the tie-break. */
function byLogin(a: { login: string }, b: { login: string }): number {
  const la = a.login.toLowerCase();
  const lb = b.login.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : compareCodePoints(a.login, b.login);
}
