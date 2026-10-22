/**
 * The post-merge guard's rules (Phase 1 step 4, spec §7). Pure: no database, no GitHub, no module
 * code and no clock (the caller passes `now`).
 *
 * - D3: a check run conclusion or a commit status state becomes `green`, `red` or `ignored`.
 * - D4: a check is keyed by its source: `run:<app_id>:<name>` or `status:<context>`.
 * - D7: a key that is red on commit N and green on the nearest earlier commit with a result is a
 *   transition; the commits after that green one, up to N, are the candidates. One PR behind all of
 *   them is the culprit; anything else is ambiguous or has no culprit.
 * - D9: a culprit is confirmed only when the failure persists.
 */

export type ResultClass = "green" | "red" | "ignored";

export type CommitPr =
  | { kind: "pr"; number: number }
  | { kind: "direct" }
  | { kind: "multiple" }
  | { kind: "unresolved" };

export interface ChainCommit {
  sha: string;
  seq: number;
  chainBreak: boolean;
  pr: CommitPr;
}

export interface KeyResult {
  key: string;
  sha: string;
  class: ResultClass;
  /** D17: the key is outside `guard.checks` at that commit (stored as `ignored`). */
  filtered?: boolean;
}

export type Transition =
  | { kind: "none"; why: "not_red" | "already_red" | "no_baseline" | "filtered" }
  | {
      kind: "new";
      key: string;
      failingSha: string;
      lastGreenSha: string;
      candidates: ChainCommit[];
    };

export type Classification =
  | { status: "culprit_found"; prNumber: number }
  | { status: "ambiguous"; prNumbers: number[]; unresolved: number }
  | { status: "no_culprit" };

export type ConfirmInput = {
  failingKeys: string[];
  failingSha: string;
  nextSha: string | null;
  resultsOnFailing: Record<string, ResultClass>;
  resultsOnNext: Record<string, ResultClass>;
  detectedAt: Date;
  now: Date;
  windowSeconds: number;
};

export type ConfirmStep = "confirmed" | "flaky" | "wait";
export type ConfirmReason = "next_commit" | "window" | "flaky_rerun" | "flaky_next";

/** D4: names and contexts are truncated to this many characters (code points) and stored. */
export const MAX_CHECK_NAME = 200;

const truncate = (s: string): string => Array.from(s).slice(0, MAX_CHECK_NAME).join("");

/** D3, check runs. A run that has not completed has a null conclusion: `ignored`. */
export function classifyConclusion(conclusion: string | null | undefined): ResultClass {
  switch (conclusion) {
    case "success":
      return "green";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "red";
    default:
      // neutral, skipped, cancelled, action_required, stale, null and anything unknown.
      return "ignored";
  }
}

/** D3, commit statuses. */
export function classifyStatusState(state: string | null | undefined): ResultClass {
  switch (state) {
    case "success":
      return "green";
    case "failure":
    case "error":
      return "red";
    default:
      return "ignored";
  }
}

/** D4: the stored name (truncated). */
export const checkName = (name: string): string => truncate(name);

/** D4: `run:<app_id>:<name>`. Another app's check with the same name is another key. */
export const checkRunKey = (appId: number, name: string): string =>
  `run:${appId}:${truncate(name)}`;

/** D4: `status:<context>`. */
export const statusKey = (context: string): string => `status:${truncate(context)}`;

/**
 * The chain a failing commit is judged on: from the failing commit back to the nearest chain
 * break (included), oldest first. `chain` is the repository's commits ordered by `seq`, newest
 * last; nothing before the nearest break at or before the failing commit is returned.
 */
export function chainUpTo(chain: readonly ChainCommit[], sha: string): ChainCommit[] {
  const at = chain.findIndex((c) => c.sha === sha);
  if (at < 0) return [];
  let start = 0;
  for (let i = at; i >= 0; i--) {
    if ((chain[i] as ChainCommit).chainBreak) {
      start = i;
      break;
    }
  }
  return chain.slice(start, at + 1);
}

/** D7: did `key` go red on commit `sha`? */
export function detectTransition(
  chain: readonly ChainCommit[],
  results: readonly KeyResult[],
  key: string,
  sha: string,
): Transition {
  const byCommit = new Map<string, KeyResult>();
  for (const r of results) if (r.key === key) byCommit.set(r.sha, r);
  const here = byCommit.get(sha);
  if (here?.filtered) return { kind: "none", why: "filtered" };
  if (here?.class !== "red") return { kind: "none", why: "not_red" };
  const line = chainUpTo(chain, sha);
  if (line.length === 0) return { kind: "none", why: "no_baseline" };
  // The nearest earlier commit (no break crossed) with a non-ignored result for the key.
  for (let i = line.length - 2; i >= 0; i--) {
    const c = line[i] as ChainCommit;
    const r = byCommit.get(c.sha);
    if (r === undefined || r.class === "ignored") continue;
    if (r.class === "red") return { kind: "none", why: "already_red" };
    return {
      kind: "new",
      key,
      failingSha: sha,
      lastGreenSha: c.sha,
      candidates: line.slice(i + 1),
    };
  }
  return { kind: "none", why: "no_baseline" };
}

/** D7: the one PR behind every candidate, or why there is none. */
export function classifyCandidates(candidates: readonly ChainCommit[]): Classification {
  const prs = new Set<number>();
  let unresolved = 0;
  let multiple = 0;
  let direct = 0;
  for (const c of candidates) {
    if (c.pr.kind === "pr") prs.add(c.pr.number);
    else if (c.pr.kind === "unresolved") unresolved++;
    else if (c.pr.kind === "multiple") multiple++;
    else direct++;
  }
  const prNumbers = [...prs].sort((a, b) => a - b);
  if (unresolved > 0 || multiple > 0) return { status: "ambiguous", prNumbers, unresolved };
  if (prs.size === 0) return { status: "no_culprit" };
  // A direct push next to a PR is a second origin (U-DET-8).
  if (prs.size === 1 && direct === 0) {
    return { status: "culprit_found", prNumber: prNumbers[0] as number };
  }
  return { status: "ambiguous", prNumbers, unresolved };
}

/** D9 with the reason the outcome was reached (`null` while waiting). */
export function confirmationDetail(i: ConfirmInput): {
  step: ConfirmStep;
  reason: ConfirmReason | null;
} {
  const keys = i.failingKeys;
  const onNext = (k: string) => (i.nextSha === null ? undefined : i.resultsOnNext[k]);
  // 1. Any failing key red on the next commit.
  if (keys.some((k) => onNext(k) === "red")) return { step: "confirmed", reason: "next_commit" };
  // 2. Every failing key green again, on the failing commit (re-run) or on the next one.
  if (
    keys.length > 0 &&
    keys.every((k) => i.resultsOnFailing[k] === "green" || onNext(k) === "green")
  ) {
    const rerun = keys.every((k) => i.resultsOnFailing[k] === "green");
    return { step: "flaky", reason: rerun ? "flaky_rerun" : "flaky_next" };
  }
  // 3. The window elapsed and a failing key is still red on the failing commit.
  const elapsed = i.now.getTime() - i.detectedAt.getTime() >= i.windowSeconds * 1000;
  if (elapsed && keys.some((k) => i.resultsOnFailing[k] === "red")) {
    return { step: "confirmed", reason: "window" };
  }
  return { step: "wait", reason: null };
}

/** D9, checked in the order of §7. */
export function confirmationStep(i: ConfirmInput): ConfirmStep {
  return confirmationDetail(i).step;
}
