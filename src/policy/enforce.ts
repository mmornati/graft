/**
 * The enforce conclusion (Phase 1 step 2, spec §6 and §7). Pure: no database, no GitHub, no
 * module code. This file is the ONLY place that names a non-neutral check conclusion: the policy
 * job passes the value through and publishes it only when the effective `policy_mode` is
 * `enforce`. Every rule fails toward `failure`: anything Graft could not verify (a team, a
 * permission, a review list that was cut) never counts toward a constraint.
 */
import type { Constraint, PolicyVerdict } from "./evaluate.js";

/** Why a team could not be verified. An unverified team contributes no approver. */
export type Unverified =
  | "no_permission"
  | "owner_not_org"
  | "team_not_found"
  | "team_unreadable"
  | "check_limit";

export interface ApproverFacts {
  /** Current approvers with write access or more (D2), login order. */
  counted: { id: number; login: string }[];
  /** Current approvers that did not count, with why. */
  notCounted: { login: string; why: "no_write_access" | "permission_denied" | "check_limit" }[];
  /** Change requesters with write access (D5), login order. */
  changesRequestedBy: string[];
  /** Per team slug: verified active members among `counted`, or why the team is unverified. */
  teams: Record<string, { members: string[] } | { unverified: Unverified }>;
  reviewsTruncated: boolean;
}

export interface ConstraintStatus {
  humans: number;
  teams: string[];
  rules: number[];
  /** Counted approvers that satisfy it, login order, at most 10 (display only). */
  approvedBy: string[];
  /** How many counted approvers satisfy it (the full count, which `met` uses). */
  approvedCount: number;
  met: boolean;
  /** Teams of this constraint that could not be verified, with why. */
  unverified: { team: string; why: Unverified }[];
}

const MAX_SHOWN = 10;

/** D6: each constraint on its own; one approver may satisfy several. */
export function satisfyConstraints(
  constraints: readonly Constraint[],
  a: ApproverFacts,
): ConstraintStatus[] {
  return constraints.map((c) => {
    const unverified: ConstraintStatus["unverified"] = [];
    let qualifies: (login: string) => boolean;
    if (c.teams.length === 0) {
      qualifies = () => true;
    } else {
      const members = new Set<string>();
      for (const t of c.teams) {
        const entry = Object.hasOwn(a.teams, t) ? a.teams[t] : undefined;
        if (entry === undefined) {
          // Not looked up at all: the same as a team Graft could not read.
          unverified.push({ team: t, why: "check_limit" });
        } else if ("unverified" in entry) {
          unverified.push({ team: t, why: entry.unverified });
        } else {
          for (const m of entry.members) members.add(m.toLowerCase());
        }
      }
      qualifies = (login) => members.has(login.toLowerCase());
    }
    const approved = a.counted.map((u) => u.login).filter(qualifies);
    return {
      humans: c.humans,
      teams: [...c.teams],
      rules: [...c.rules],
      approvedBy: approved.slice(0, MAX_SHOWN),
      approvedCount: approved.length,
      met: c.humans > 0 && approved.length >= c.humans,
      unverified,
    };
  });
}

export type EnforcedReason =
  | "approved_by_policy"
  | "requirements_met"
  | "no_policy"
  | "policy_invalid"
  | "blocked"
  | "reviews_truncated"
  | "changes_requested"
  | "approvals_missing"
  | "card_pending"
  /** Phase 1 step 3 (D5): a verified break-glass for the current head. */
  | "break_glass";

export type EnforcedConclusion = "success" | "failure" | "pending";

export interface Enforced {
  conclusion: EnforcedConclusion;
  reason: EnforcedReason;
  /** `[]` unless the verdict is `would_require`. */
  constraints: ConstraintStatus[];
}

export interface EnforceInput {
  state: "ok" | "missing" | "invalid";
  verdict: PolicyVerdict | null;
  /** null when `state !== "ok"`. */
  approvers: ApproverFacts | null;
  /** D9: the card is pending and the head is inside the wait window. */
  cardWait: boolean;
  /**
   * Phase 1 step 3 (D5): a break-glass Graft verified for the CURRENT head. Absent or null: none.
   * It wins over every other rule; the job sets it only from an `applied` audit row (D6).
   */
  breakGlass?: { applied: true } | null;
}

const failure = (reason: EnforcedReason, constraints: ConstraintStatus[] = []): Enforced => ({
  conclusion: "failure",
  reason,
  constraints,
});

/**
 * §7: the first rule that applies wins. Block and policy errors win over everything, except a
 * break-glass (step 3, D5), which is checked first: it is a bypass, so it must bypass a block too.
 * The constraints are still computed, so that the details show what was bypassed.
 */
export function enforcedConclusion(i: EnforceInput): Enforced {
  if (i.breakGlass?.applied === true) {
    return { conclusion: "success", reason: "break_glass", constraints: constraintsOf(i) };
  }
  if (i.state === "missing") return failure("no_policy");
  if (i.state === "invalid" || i.verdict === null) return failure("policy_invalid");
  const v = i.verdict;
  if (v.outcome === "would_block") return failure("blocked");
  const constraints =
    v.outcome === "would_require" && i.approvers !== null
      ? satisfyConstraints(v.constraints, i.approvers)
      : v.outcome === "would_require"
        ? satisfyConstraints(v.constraints, EMPTY)
        : [];
  if (i.cardWait) return { conclusion: "pending", reason: "card_pending", constraints };
  // No approver facts for a valid policy: nothing could be verified.
  if (i.approvers === null) return failure("approvals_missing", constraints);
  if (i.approvers.reviewsTruncated) return failure("reviews_truncated", constraints);
  if (i.approvers.changesRequestedBy.length > 0) return failure("changes_requested", constraints);
  if (v.outcome === "would_approve") {
    return { conclusion: "success", reason: "approved_by_policy", constraints };
  }
  return constraints.length > 0 && constraints.every((c) => c.met)
    ? { conclusion: "success", reason: "requirements_met", constraints }
    : failure("approvals_missing", constraints);
}

/** The constraint statuses of a valid `would_require` verdict, else `[]`. */
function constraintsOf(i: EnforceInput): ConstraintStatus[] {
  if (i.state !== "ok" || i.verdict?.outcome !== "would_require") return [];
  return satisfyConstraints(i.verdict.constraints, i.approvers ?? EMPTY);
}

const EMPTY: ApproverFacts = {
  counted: [],
  notCounted: [],
  changesRequestedBy: [],
  teams: {},
  reviewsTruncated: false,
};

/** The conclusion the policy check is published with: neutral unless the policy enforces. */
export interface PublishedCheck {
  status: "completed" | "in_progress";
  /** null with `in_progress`. */
  conclusion: "neutral" | "success" | "failure" | null;
  /** What `policy_verdicts.check_conclusion` stores (D10). */
  stored: "neutral" | "success" | "failure" | "pending";
}

/**
 * D10 and §9: report mode publishes `completed` + `neutral` whatever `enforced` says; enforce mode
 * publishes the enforced conclusion, and `pending` as `in_progress` with no conclusion.
 */
export function publishedCheck(mode: "report" | "enforce", enforced: Enforced): PublishedCheck {
  if (mode !== "enforce") return { status: "completed", conclusion: "neutral", stored: "neutral" };
  if (enforced.conclusion === "pending") {
    return { status: "in_progress", conclusion: null, stored: "pending" };
  }
  return { status: "completed", conclusion: enforced.conclusion, stored: enforced.conclusion };
}
