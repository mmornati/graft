/**
 * The Phase 1 gate (Phase 1 step 7, D14 to D19, §8). `decidePhase1` is pure; `gatherPhase1Gate`
 * reads the database only (never GitHub, never a payload) and computes every number from raw rows
 * at report time: no pre-aggregated table is read. Each metric is computed twice: measured (rows
 * whose mode was `enforce`) and projected (every row, report rows counted by what enforce would
 * have done). The gate verdict uses measured values only; the preview never sets an exit code.
 */
import { sql } from "kysely";
import type { Config } from "../config/index.js";
import type { Db } from "../db/client.js";
import { resolveCeiling } from "../modules/modes/cli.js";
import { modesOf } from "../modules/modes/effective.js";
import { listRepositoryModeRows } from "../modules/modes/store.js";
import {
  GUARD_CLASSES,
  type GuardClass,
  MERGED_CLASSES,
  type MergedClass,
  type Phase1GateReport,
  type Phase1Reason,
  type Phase1ReasonCode,
  type Phase1Repository,
  type Phase1Verdict,
  phase1GateReportSchema,
} from "./gate-phase1-render.js";
import { binomialUpperTail, percentile, wilson } from "./stats.js";

/**
 * Every threshold of the Phase 1 gate (§8.7) and of the readiness numbers the runbook reads, in
 * one place: changing a target, a minimum or the retention target is a one-line change here.
 * The values are the spec's; the product owner may still change them (HUMAN-TODO, step 7).
 */
export const PHASE1 = {
  m1: {
    target: 0.3,
    lowerSlack: 0.05,
    minMerged: 200,
    minInstallations: 3,
    minRowsPerInstallation: 20,
    /** First to last measured merge, counting the first day in full (as Phase 0). */
    minWindowDays: 14,
    failFromN: 50,
    pointEstimateFromN: 400,
  },
  m2: { target: -0.5, minRowsPerSide: 30, minRepositories: 2 },
  m3: { target: 0.8, minBreakages: 10, minRepositories: 2 },
  m4: { defectLagDays: 14, pValue: 0.05, minWindow: 100, minBaseline: 100, minAuto: 50 },
  /** Reported, not decided (D19): retained installations, of 5 pilots. */
  retention: { target: 3, minAgeDays: 30, activeDays: 7 },
  /** The per-repository `last7` window. */
  recentDays: 7,
} as const;

/**
 * The runbook's stage 2 go criteria (D20, §9), read from `repositories[]`. U-DOC-3 checks that the
 * runbook quotes these values, so the document and the code cannot drift apart.
 */
export const RUNBOOK_STAGE2 = {
  minMerged: 30,
  minDays: 14,
  maxWouldFailShare: 0.1,
} as const;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Classes (pure)
// ---------------------------------------------------------------------------------------------

/** §8.1: the class of a merged row, from its merge-head verdict's `enforced_reason`. */
export function mergedClass(enforcedReason: string | null | undefined): MergedClass {
  switch (enforcedReason) {
    case "approved_by_policy":
      return "auto";
    case "requirements_met":
      return "human";
    case "break_glass":
      return "break_glass";
    case "no_policy":
    case "policy_invalid":
    case "blocked":
    case "reviews_truncated":
    case "changes_requested":
    case "approvals_missing":
      return "would_fail";
    case "card_pending":
      return "pending";
    default:
      return "no_verdict";
  }
}

export interface GuardRow {
  status: string;
  confirm_reason: string | null;
  revert_pr_number: number | null;
  revert_outcome: string | null;
}

/** §8.4: the class of a guard event, tested in the table's order. */
export function guardClass(g: GuardRow): GuardClass {
  if (g.status === "detected" || g.status === "confirming") return "open";
  if (g.status === "culprit_found" && g.revert_outcome === null) return "open";
  if (g.status === "flaky") {
    if (g.confirm_reason === "flaky_rerun" || g.confirm_reason === "flaky_next") return "flaky";
    // D17: an unconfirmed flake is neither a caught breakage nor a flake.
    if (g.confirm_reason === null) return "flaky_unconfirmed";
  }
  if (g.status === "dismissed") return "dismissed";
  if (g.revert_pr_number !== null) return "caught";
  if (g.revert_outcome === "planned") return "would_catch";
  return "missed";
}

/**
 * §8.4: the M3 ratio of a list of classes. Measured: `caught / (caught + would_catch + missed)` (a
 * `would_catch` cannot occur in enforce mode; if it does, it counts as missed). Projected:
 * `(caught + would_catch) / (…)`. Every other class is outside both terms.
 */
export function m3Ratio(
  classes: readonly GuardClass[],
  side: "measured" | "projected",
): { numerator: number; denominator: number } {
  const caught = classes.filter((c) => c === "caught").length;
  const would = classes.filter((c) => c === "would_catch").length;
  const missed = classes.filter((c) => c === "missed").length;
  return {
    numerator: side === "projected" ? caught + would : caught,
    denominator: caught + would + missed,
  };
}

/** §8.3: the review minutes of a review-time row. */
export function reviewMinutes(p: {
  merged_without_review: boolean;
  minutes_to_first_approval: number | null;
  minutes_to_merge: number | null;
}): number | null {
  if (p.merged_without_review) return 0;
  if (p.minutes_to_first_approval !== null) return p.minutes_to_first_approval;
  return p.minutes_to_merge;
}

/** §8.3: a `phase1` row's projected minutes: 0 for a report-mode row of class `auto`. */
export function projectedMinutes(minutes: number, mode: "report" | "enforce", cls: MergedClass) {
  return mode === "report" && cls === "auto" ? 0 : minutes;
}

// ---------------------------------------------------------------------------------------------
// Decision (pure, §8.7)
// ---------------------------------------------------------------------------------------------

export interface M1Input {
  n: number;
  x: number;
  /** Every installation with its row count (rows of this side). */
  installations: readonly { id: number; n: number }[];
  /** First to last `merged_at` of this side's rows, in days. */
  spanDays: number;
}
export interface M2Input {
  baseline: readonly number[];
  phase1: readonly number[];
  repositories: number;
}
export interface M3Input {
  numerator: number;
  denominator: number;
  repositories: number;
}
export interface Rate {
  x: number;
  n: number;
}
export interface M4Input {
  /** `until − 14 days > since`. */
  lagOk: boolean;
  all: Rate;
  auto: Rate;
  baseline: Rate;
}
export interface Phase1Inputs {
  m1: { measured: M1Input; projected: M1Input };
  m2: { measured: M2Input; projected: M2Input };
  m3: { measured: M3Input; projected: M3Input };
  /** `auto` of the projected side is criterion (b) on every `auto` row (the preview). */
  m4: { measured: M4Input; projected: M4Input };
}

export interface Decision {
  verdict: Phase1Verdict;
  reasons: Phase1Reason[];
}

const r = (
  metric: Phase1Reason["metric"],
  code: Phase1ReasonCode,
  value: number | null = null,
  required: number | null = null,
): Phase1Reason => ({ metric, code, value, required });

export function decideM1(m: M1Input): Decision {
  const c = PHASE1.m1;
  const w = wilson(m.x, m.n);
  const share = m.n === 0 ? 0 : m.x / m.n;
  const withRows = m.installations.filter((i) => i.n > 0).length;
  if (m.n >= c.failFromN && w !== null && w.upper < c.target && withRows >= c.minInstallations) {
    return { verdict: "FAIL", reasons: [r("m1", "m1_upper_below_target", w.upper, c.target)] };
  }
  const missing: Phase1Reason[] = [];
  if (m.n < c.minMerged) missing.push(r("m1", "m1_below_min_merged", m.n, c.minMerged));
  const broad = m.installations.filter((i) => i.n >= c.minRowsPerInstallation).length;
  if (broad < c.minInstallations) {
    missing.push(r("m1", "m1_below_min_installations", broad, c.minInstallations));
  }
  if (m.spanDays + 1 < c.minWindowDays) {
    missing.push(r("m1", "m1_window_too_short", m.spanDays, c.minWindowDays));
  }
  if (missing.length > 0) return { verdict: "INSUFFICIENT_DATA", reasons: missing };
  if (m.n >= c.pointEstimateFromN) {
    return {
      verdict: share >= c.target ? "PASS" : "FAIL",
      reasons: [r("m1", "m1_point_estimate_decides", share, c.target)],
    };
  }
  const lower = w?.lower ?? 0;
  if (share >= c.target && lower >= c.target - c.lowerSlack) {
    return { verdict: "PASS", reasons: [r("m1", "pass", share, c.target)] };
  }
  return {
    verdict: "INSUFFICIENT_DATA",
    reasons: [r("m1", "m1_inconclusive", lower, c.target - c.lowerSlack)],
  };
}

/** p50 by `percentile` type 7, and Δ against the baseline; null when the baseline p50 is 0. */
export function m2Delta(baseline: readonly number[], phase1: readonly number[]): number | null {
  const b = percentile(
    [...baseline].sort((a, z) => a - z),
    0.5,
  );
  const p = percentile(
    [...phase1].sort((a, z) => a - z),
    0.5,
  );
  if (b === null || p === null || b === 0) return null;
  return (p - b) / b;
}

export function decideM2(m: M2Input): Decision {
  const c = PHASE1.m2;
  const missing: Phase1Reason[] = [];
  const fewest = Math.min(m.baseline.length, m.phase1.length);
  if (fewest < c.minRowsPerSide) {
    missing.push(r("m2", "m2_below_min_rows", fewest, c.minRowsPerSide));
  }
  if (m.repositories < c.minRepositories) {
    missing.push(r("m2", "m2_below_min_repositories", m.repositories, c.minRepositories));
  }
  if (missing.length > 0) return { verdict: "INSUFFICIENT_DATA", reasons: missing };
  const delta = m2Delta(m.baseline, m.phase1);
  if (delta === null) {
    return { verdict: "INSUFFICIENT_DATA", reasons: [r("m2", "m2_baseline_zero")] };
  }
  return delta <= c.target
    ? { verdict: "PASS", reasons: [r("m2", "pass", delta, c.target)] }
    : { verdict: "FAIL", reasons: [r("m2", "m2_above_target", delta, c.target)] };
}

export function decideM3(m: M3Input): Decision {
  const c = PHASE1.m3;
  const missing: Phase1Reason[] = [];
  if (m.denominator < c.minBreakages) {
    missing.push(r("m3", "m3_below_min_breakages", m.denominator, c.minBreakages));
  }
  if (m.repositories < c.minRepositories) {
    missing.push(r("m3", "m3_below_min_repositories", m.repositories, c.minRepositories));
  }
  if (missing.length > 0) return { verdict: "INSUFFICIENT_DATA", reasons: missing };
  const share = m.numerator / m.denominator;
  return share >= c.target
    ? { verdict: "PASS", reasons: [r("m3", "pass", share, c.target)] }
    : { verdict: "FAIL", reasons: [r("m3", "m3_below_target", share, c.target)] };
}

export interface CriterionResult {
  verdict: Phase1Verdict;
  pValue: number | null;
  reasons: Phase1Reason[];
}

/** §8.5: one criterion against the baseline, with the exact conditional binomial test. */
export function decideCriterion(
  w: Rate,
  b: Rate,
  min: { n: number; code: Phase1ReasonCode },
): CriterionResult {
  const c = PHASE1.m4;
  const missing: Phase1Reason[] = [];
  if (w.n < min.n) missing.push(r("m4", min.code, w.n, min.n));
  // (b) has no baseline minimum of its own, but a rate needs a baseline to compare with.
  const baseMin = min.code === "m4_below_min_window" ? c.minBaseline : 1;
  if (b.n < baseMin) missing.push(r("m4", "m4_below_min_baseline", b.n, baseMin));
  if (missing.length > 0) return { verdict: "INSUFFICIENT_DATA", pValue: null, reasons: missing };
  const pValue = binomialUpperTail(w.x, w.x + b.x, w.n / (w.n + b.n));
  const rises = w.x / w.n > b.x / b.n;
  if (rises && pValue < c.pValue) {
    return { verdict: "FAIL", pValue, reasons: [r("m4", "m4_rise", pValue, c.pValue)] };
  }
  return { verdict: "PASS", pValue, reasons: [r("m4", "pass", pValue, c.pValue)] };
}

export function decideM4(m: M4Input): Decision & { all: CriterionResult; auto: CriterionResult } {
  const c = PHASE1.m4;
  if (!m.lagOk) {
    const lag: CriterionResult = {
      verdict: "INSUFFICIENT_DATA",
      pValue: null,
      reasons: [r("m4", "m4_defect_lag", null, c.defectLagDays)],
    };
    return { verdict: "INSUFFICIENT_DATA", reasons: lag.reasons, all: lag, auto: lag };
  }
  const all = decideCriterion(m.all, m.baseline, { n: c.minWindow, code: "m4_below_min_window" });
  const auto = decideCriterion(m.auto, m.baseline, { n: c.minAuto, code: "m4_below_min_auto" });
  return { ...combine([all, auto]), all, auto };
}

/** FAIL if any FAILs, PASS if all PASS, otherwise INSUFFICIENT DATA, with the deciding reasons. */
export function combine(parts: readonly Decision[]): Decision {
  const pick = (v: Phase1Verdict) => parts.filter((p) => p.verdict === v).flatMap((p) => p.reasons);
  if (parts.some((p) => p.verdict === "FAIL")) return { verdict: "FAIL", reasons: pick("FAIL") };
  if (parts.every((p) => p.verdict === "PASS")) return { verdict: "PASS", reasons: pick("PASS") };
  return { verdict: "INSUFFICIENT_DATA", reasons: pick("INSUFFICIENT_DATA") };
}

export interface Phase1Decision extends Decision {
  preview: Decision;
  m1: Decision & { preview: Decision };
  m2: Decision & { preview: Decision };
  m3: Decision & { preview: Decision };
  m4: Decision & {
    preview: Decision;
    all: CriterionResult;
    auto: CriterionResult;
    autoPreview: CriterionResult;
  };
}

/**
 * §8.7. The gate verdict combines the measured decisions; the preview applies the same rules (the
 * measured minimums included) to the projected values. Nothing projected reaches the gate verdict.
 */
export function decidePhase1(i: Phase1Inputs): Phase1Decision {
  const m1 = decideM1(i.m1.measured);
  const m2 = decideM2(i.m2.measured);
  const m3 = decideM3(i.m3.measured);
  const m4 = decideM4(i.m4.measured);
  const p1 = decideM1(i.m1.projected);
  const p2 = decideM2(i.m2.projected);
  const p3 = decideM3(i.m3.projected);
  const p4 = decideM4(i.m4.projected);
  const gate = combine([m1, m2, m3, m4]);
  return {
    ...gate,
    preview: combine([p1, p2, p3, p4]),
    m1: { ...m1, preview: p1 },
    m2: { ...m2, preview: p2 },
    m3: { ...m3, preview: p3 },
    m4: {
      verdict: m4.verdict,
      reasons: m4.reasons,
      preview: { verdict: p4.verdict, reasons: p4.reasons },
      all: m4.all,
      auto: m4.auto,
      autoPreview: p4.auto,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Gathering (database only, §8)
// ---------------------------------------------------------------------------------------------

export class Phase1GateUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase1GateUsageError";
  }
}

export interface Phase1GateOptions {
  installationIds: number[];
  since: Date;
  /** Exclusive. */
  until: Date;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const num = (v: unknown): number => Number(v ?? 0);
const nullableNum = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const inList = (ids: readonly (string | number)[]) => sql.join(ids.map((x) => sql`${x}`));
const emptyClasses = (): Record<MergedClass, number> =>
  Object.fromEntries(MERGED_CLASSES.map((c) => [c, 0])) as Record<MergedClass, number>;
const emptyGuard = (): Record<GuardClass, number> =>
  Object.fromEntries(GUARD_CLASSES.map((c) => [c, 0])) as Record<GuardClass, number>;

/** The merge-head verdict of `ch` (§8): the newest verdict for its current head. */
const MERGE_HEAD_VERDICT = sql`left join lateral (
    select pv.policy_mode, pv.enforced_conclusion, pv.enforced_reason,
      coalesce((pv.approvals->>'counted')::int, 0) as counted
    from policy_verdicts pv
    where pv.change_id = ch.id and pv.head_sha = ch.head_sha
    order by pv.facts_read_at desc, pv.created_at desc
    limit 1) v on true`;

interface MergedRow {
  repositoryId: number;
  installationId: number;
  prNumber: number;
  mergedAt: Date;
  authorKind: string;
  mode: "report" | "enforce";
  reason: string | null;
  cls: MergedClass;
  counted: number;
  incidents: number;
}

interface ReviewRow {
  repositoryId: number;
  period: "baseline" | "phase1";
  minutes: number;
  mode: "report" | "enforce";
  cls: MergedClass;
}

function spanDays(rows: readonly MergedRow[]): number {
  if (rows.length === 0) return 0;
  const t = rows.map((x) => x.mergedAt.getTime());
  return Math.round(((Math.max(...t) - Math.min(...t)) / DAY_MS) * 100) / 100;
}

function m1Side(rows: readonly MergedRow[], installationIds: readonly number[]) {
  const x = rows.filter((row) => row.cls === "auto").length;
  return {
    n: rows.length,
    x,
    share: rows.length === 0 ? null : x / rows.length,
    wilson: wilson(x, rows.length),
    installations: installationIds.map((id) => ({
      id,
      n: rows.filter((row) => row.installationId === id).length,
    })),
    spanDays: spanDays(rows),
  };
}

function shareOf(rows: readonly MergedRow[]) {
  const x = rows.filter((row) => row.cls === "auto").length;
  return {
    n: rows.length,
    x,
    share: rows.length === 0 ? null : x / rows.length,
    wilson: wilson(x, rows.length),
  };
}

function minutesSide(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 0.5)),
    p75: round(percentile(sorted, 0.75)),
    mean: sorted.length === 0 ? null : round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
}

const per100 = (x: number, n: number): number | null => (n === 0 ? null : (x / n) * 100);

export async function gatherPhase1Gate(
  db: Db,
  config: Pick<Config, "metricsExcludedAuthors" | "modeCeiling">,
  o: Phase1GateOptions,
): Promise<Phase1GateReport> {
  const ids = [...new Set(o.installationIds)].sort((a, b) => a - b);
  if (!(o.until.getTime() > o.since.getTime())) {
    throw new Phase1GateUsageError("--until must be after --since");
  }
  const insts = await sql<{
    id: number;
    account_login: string;
    repos: string;
  }>`
    select i.id, i.account_login,
      (select count(*) from repositories r where r.installation_id = i.id and r.removed_at is null)::text as repos
    from installations i where i.id in (${inList(ids)}) order by i.id`.execute(db);
  if (insts.rows.length !== ids.length) {
    throw new Phase1GateUsageError("an installation id does not exist");
  }
  const excluded = config.metricsExcludedAuthors.length > 0 ? config.metricsExcludedAuthors : [""];
  const days = Math.round((o.until.getTime() - o.since.getTime()) / DAY_MS);

  // §8.1: the merged population, with the merge-head verdict and each PR's incident count.
  const mergedRes = await sql<{
    repository_id: number;
    installation_id: number;
    pr_number: number;
    merged_at: Date;
    author_kind: string;
    mode: "report" | "enforce";
    enforced_reason: string | null;
    counted: number;
    incidents: string;
  }>`
    select ch.repository_id, r.installation_id, ch.pr_number, ch.merged_at,
      coalesce(cp.author_kind, 'human') as author_kind,
      coalesce(v.policy_mode, 'report') as mode,
      v.enforced_reason, coalesce(v.counted, 0) as counted,
      (select count(*) from incidents i
        where i.repository_id = ch.repository_id and i.culprit_pr_number = ch.pr_number)::text as incidents
    from changes ch
    join repositories r on r.id = ch.repository_id
    left join change_provenance cp on cp.change_id = ch.id
    ${MERGE_HEAD_VERDICT}
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and ch.state = 'merged' and ch.merged_at >= ${o.since} and ch.merged_at < ${o.until}
      and lower(ch.author_login) not in (${sql.join(excluded)})
      and not exists (select 1 from guard_events g
        where g.repository_id = ch.repository_id and g.revert_pr_number = ch.pr_number)`.execute(
    db,
  );
  const merged: MergedRow[] = mergedRes.rows.map((x) => ({
    repositoryId: num(x.repository_id),
    installationId: num(x.installation_id),
    prNumber: num(x.pr_number),
    mergedAt: new Date(x.merged_at),
    authorKind: x.author_kind,
    mode: x.mode,
    reason: x.enforced_reason,
    cls: mergedClass(x.enforced_reason),
    counted: num(x.counted),
    incidents: num(x.incidents),
  }));
  const measured = merged.filter((x) => x.mode === "enforce");
  const classesOf = (rows: readonly MergedRow[]) => {
    const c = emptyClasses();
    for (const row of rows) c[row.cls]++;
    return c;
  };
  const failing = (row: MergedRow) => row.cls === "would_fail" || row.cls === "pending";

  // §8.3: review-time rows of the newest baseline and phase1 run per repository.
  const reviewRes = await sql<{
    repository_id: number;
    period: "baseline" | "phase1";
    merged_without_review: boolean;
    minutes_to_first_approval: string | null;
    minutes_to_merge: string | null;
    mode: "report" | "enforce";
    enforced_reason: string | null;
  }>`
    select run.repository_id, run.period, p.merged_without_review,
      p.minutes_to_first_approval, p.minutes_to_merge,
      coalesce(v.policy_mode, 'report') as mode, v.enforced_reason
    from review_time_runs run
    join repositories r on r.id = run.repository_id
    join review_time_prs p on p.run_id = run.id
    left join changes ch on ch.repository_id = run.repository_id and ch.pr_number = p.pr_number
      and run.period = 'phase1'
    ${MERGE_HEAD_VERDICT}
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and run.period in ('baseline', 'phase1')
      and p.state = 'merged' and p.excluded_reason is null and p.author_kind = 'agent'
      and run.id = (
        select x.id from review_time_runs x
        where x.repository_id = run.repository_id and x.period = run.period
        order by x.extracted_at desc, x.id desc limit 1)`.execute(db);
  const reviewRows: ReviewRow[] = [];
  for (const x of reviewRes.rows) {
    const minutes = reviewMinutes({
      merged_without_review: x.merged_without_review,
      minutes_to_first_approval: nullableNum(x.minutes_to_first_approval),
      minutes_to_merge: nullableNum(x.minutes_to_merge),
    });
    if (minutes === null) continue;
    reviewRows.push({
      repositoryId: num(x.repository_id),
      period: x.period,
      minutes,
      mode: x.period === "phase1" ? x.mode : "report",
      cls: mergedClass(x.enforced_reason),
    });
  }
  const runsRes = await sql<{
    repository_id: number;
    full_name: string;
    period: "baseline" | "phase1";
    from_date: string;
    to_date: string;
    extracted_at: Date;
  }>`
    select run.repository_id, r.full_name, run.period, run.from_date::text as from_date,
      run.to_date::text as to_date, run.extracted_at
    from review_time_runs run join repositories r on r.id = run.repository_id
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and run.period in ('baseline', 'phase1')
      and run.id = (
        select x.id from review_time_runs x
        where x.repository_id = run.repository_id and x.period = run.period
        order by x.extracted_at desc, x.id desc limit 1)
    order by r.full_name, run.period`.execute(db);
  const withRun = (period: string) =>
    new Set(runsRes.rows.filter((x) => x.period === period).map((x) => num(x.repository_id)));
  const baseRepos = withRun("baseline");
  const paired = new Set([...withRun("phase1")].filter((x) => baseRepos.has(x)));
  const pairedRows = reviewRows.filter((x) => paired.has(x.repositoryId));
  const p1Measured = pairedRows.filter((x) => x.period === "phase1" && x.mode === "enforce");
  const measuredRepos = new Set(p1Measured.map((x) => x.repositoryId));
  const baseMeasured = pairedRows.filter(
    (x) => x.period === "baseline" && measuredRepos.has(x.repositoryId),
  );
  const p1All = pairedRows.filter((x) => x.period === "phase1");
  const baseAll = pairedRows.filter((x) => x.period === "baseline");
  const projected = p1All.map((x) => projectedMinutes(x.minutes, x.mode, x.cls));
  const projectedZeros = p1All.filter(
    (x) => x.minutes !== 0 && projectedMinutes(x.minutes, x.mode, x.cls) === 0,
  ).length;
  const m2In = {
    measured: {
      baseline: baseMeasured.map((x) => x.minutes),
      phase1: p1Measured.map((x) => x.minutes),
      repositories: measuredRepos.size,
    },
    projected: {
      baseline: baseAll.map((x) => x.minutes),
      phase1: projected,
      repositories: new Set(p1All.map((x) => x.repositoryId)).size,
    },
  };

  // §8.4: guard events detected in the window.
  const guardRes = await sql<{
    repository_id: number;
    status: string;
    confirm_reason: string | null;
    revert_pr_number: number | null;
    revert_outcome: string | null;
    revert_reason: string | null;
    mode: "report" | "enforce";
    auto_merge_state: string | null;
  }>`
    select g.repository_id, g.status, g.confirm_reason, g.revert_pr_number, g.revert_outcome,
      g.revert_reason, coalesce(g.guard_mode, 'report') as mode, g.auto_merge_state
    from guard_events g join repositories r on r.id = g.repository_id
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and coalesce(g.detected_at, g.created_at) >= ${o.since}
      and coalesce(g.detected_at, g.created_at) < ${o.until}`.execute(db);
  const guard = guardRes.rows.map((g) => ({
    ...g,
    repositoryId: num(g.repository_id),
    revert_pr_number: g.revert_pr_number === null ? null : num(g.revert_pr_number),
    cls: guardClass(g),
  }));
  const guardClasses = (rows: typeof guard) => {
    const c = emptyGuard();
    for (const g of rows) c[g.cls]++;
    return c;
  };
  const inRatio = (g: (typeof guard)[number]) =>
    g.cls === "caught" || g.cls === "would_catch" || g.cls === "missed";
  const gMeasured = guard.filter((g) => g.mode === "enforce" && inRatio(g));
  const gAll = guard.filter(inRatio);
  const m3Side = (rows: typeof guard, projectedSide: boolean) => {
    const caught = rows.filter((g) => g.cls === "caught").length;
    const wouldCatch = rows.filter((g) => g.cls === "would_catch").length;
    const missed = rows.filter((g) => g.cls === "missed").length;
    const { numerator } = m3Ratio(
      rows.map((g) => g.cls),
      projectedSide ? "projected" : "measured",
    );
    return {
      caught,
      wouldCatch,
      missed,
      denominator: rows.length,
      share: rows.length === 0 ? null : numerator / rows.length,
      wilson: wilson(numerator, rows.length),
      repositories: new Set(rows.map((g) => g.repositoryId)).size,
      numerator,
    };
  };
  const m3Measured = m3Side(gMeasured, false);
  const m3Projected = m3Side(gAll, true);
  const missedBy = new Map<
    string,
    { status: string; outcome: string | null; reason: string | null; n: number }
  >();
  for (const g of guard) {
    // Measured, a `planned` outcome in enforce mode counts as missed, so it is listed here too.
    const missedNow = g.cls === "missed" || (g.cls === "would_catch" && g.mode === "enforce");
    if (!missedNow) continue;
    const outcome = g.status === "culprit_found" ? g.revert_outcome : null;
    const reason = g.status === "culprit_found" ? g.revert_reason : null;
    const key = `${g.status}\u0000${outcome}\u0000${reason}`;
    const e = missedBy.get(key) ?? { status: g.status, outcome, reason, n: 0 };
    e.n++;
    missedBy.set(key, e);
  }
  const caughtRows = guard.filter((g) => g.cls === "caught");

  // §8.5: escaped defects, with the 14-day lag.
  const mergedBefore = new Date(o.until.getTime() - PHASE1.m4.defectLagDays * DAY_MS);
  const lagOk = mergedBefore.getTime() > o.since.getTime();
  const lagged = merged.filter((x) => x.mergedAt.getTime() < mergedBefore.getTime());
  const rate = (rows: readonly MergedRow[]): Rate => ({
    x: rows.reduce((a, row) => a + row.incidents, 0),
    n: rows.length,
  });
  const baselineRes = await sql<{ merged: string; incidents: string }>`
    select count(*)::text as merged,
      coalesce(sum((select count(*) from incidents i
        where i.repository_id = run.repository_id and i.culprit_pr_number = p.pr_number)), 0)::text as incidents
    from review_time_runs run
    join repositories r on r.id = run.repository_id
    join review_time_prs p on p.run_id = run.id
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and run.period = 'baseline' and p.state = 'merged' and p.excluded_reason is null
      and run.id = (
        select x.id from review_time_runs x
        where x.repository_id = run.repository_id and x.period = 'baseline'
        order by x.extracted_at desc, x.id desc limit 1)`.execute(db);
  const baseline: Rate = {
    x: num(baselineRes.rows[0]?.incidents),
    n: num(baselineRes.rows[0]?.merged),
  };
  const unlinkedRes = await sql<{ n: string }>`
    select count(*)::text as n from incidents i join repositories r on r.id = i.repository_id
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and i.culprit_pr_number is null
      and i.occurred_at >= ${o.since} and i.occurred_at < ${o.until}`.execute(db);
  const m4All = rate(lagged);
  const m4Auto = rate(lagged.filter((x) => x.mode === "enforce" && x.cls === "auto"));
  const m4AutoPreview = rate(lagged.filter((x) => x.cls === "auto"));

  // The decision.
  const decision = decidePhase1({
    m1: { measured: m1Side(measured, ids), projected: m1Side(merged, ids) },
    m2: m2In,
    m3: {
      measured: {
        numerator: m3Measured.numerator,
        denominator: m3Measured.denominator,
        repositories: m3Measured.repositories,
      },
      projected: {
        numerator: m3Projected.numerator,
        denominator: m3Projected.denominator,
        repositories: m3Projected.repositories,
      },
    },
    m4: {
      measured: { lagOk, all: m4All, auto: m4Auto, baseline },
      projected: { lagOk, all: m4All, auto: m4AutoPreview, baseline },
    },
  });

  // §8.6: reported, not decided.
  const overridesRes = await sql<{ kind: string; policy_mode: string; n: string }>`
    select a.kind, a.policy_mode, count(*)::text as n
    from audit_log a join repositories r on r.id = a.repository_id
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and a.created_at >= ${o.since} and a.created_at < ${o.until}
    group by a.kind, a.policy_mode order by a.kind, a.policy_mode`.execute(db);
  const mcpRes = await sql<{
    tokens: string;
    reports: string;
    disagreements: string;
  }>`
    select
      (select count(*) from mcp_tokens t join repositories r on r.id = t.repository_id
        where r.installation_id in (${inList(ids)}) and r.removed_at is null
          and t.created_at < ${o.until} and t.expires_at > ${o.until}
          and (t.revoked_at is null or t.revoked_at >= ${o.until}))::text as tokens,
      (select count(*) from provenance p join changes ch on ch.id = p.change_id
        join repositories r on r.id = ch.repository_id
        where r.installation_id in (${inList(ids)}) and r.removed_at is null
          and p.source = 'mcp' and p.created_at >= ${o.since} and p.created_at < ${o.until})::text as reports,
      (select count(*) from change_provenance cp join changes ch on ch.id = cp.change_id
        join repositories r on r.id = ch.repository_id
        where r.installation_id in (${inList(ids)}) and r.removed_at is null
          and cp.mcp_report = 'disagrees'
          and cp.computed_at >= ${o.since} and cp.computed_at < ${o.until})::text as disagreements`.execute(
    db,
  );
  // D9 (a): PRs, never claims; the open time is the PR's, never the row's.
  const mcpPrsRes = await sql<{ repository_id: number; n: string }>`
    select m.repository_id, count(distinct m.pr_number)::text as n
    from mcp_changes m
    join repositories r on r.id = m.repository_id
    join changes ch on ch.repository_id = m.repository_id and ch.pr_number = m.pr_number
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and m.pr_number is not null
      and ch.opened_at >= ${o.since} and ch.opened_at < ${o.until}
    group by m.repository_id`.execute(db);
  const mcpPrs = new Map(mcpPrsRes.rows.map((x) => [num(x.repository_id), num(x.n)]));
  const retentionRes = await sql<{ n: string }>`
    select count(*)::text as n from installations i
    where i.id in (${inList(ids)})
      and i.created_at <= ${new Date(o.until.getTime() - PHASE1.retention.minAgeDays * DAY_MS)}
      and i.deleted_at is null and i.suspended_at is null
      and exists (
        select 1 from webhook_deliveries d
        where (d.installation_id = i.id
            or d.repository_id in (select r.id from repositories r where r.installation_id = i.id))
          and d.received_at >= ${new Date(o.until.getTime() - PHASE1.retention.activeDays * DAY_MS)}
          and d.received_at < ${o.until})`.execute(db);

  // Per repository: the runbook's numbers.
  const ceiling = await resolveCeiling(db, config);
  const modeRows = (
    await Promise.all(ids.map((id) => listRepositoryModeRows(db, { installationId: id })))
  ).flat();
  const sinceRes = await sql<{ repository_id: number; key: string; applied_at: Date }>`
    select distinct on (mc.repository_id, mc.key) mc.repository_id, mc.key, mc.applied_at
    from mode_changes mc join repositories r on r.id = mc.repository_id
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and mc.key in ('policy_mode', 'guard_mode') and mc.to_value = 'enforce'
      and mc.applied_at is not null
    order by mc.repository_id, mc.key, mc.created_at desc, mc.id desc`.execute(db);
  const appliedRes = await sql<{ repository_id: number; n: string }>`
    select a.repository_id, count(*)::text as n
    from audit_log a join repositories r on r.id = a.repository_id
    where r.installation_id in (${inList(ids)}) and r.removed_at is null and a.kind = 'applied'
      and a.created_at >= ${o.since} and a.created_at < ${o.until}
    group by a.repository_id`.execute(db);
  const applied = new Map(appliedRes.rows.map((x) => [num(x.repository_id), num(x.n)]));
  const privRes = await sql<{ id: number; private: boolean }>`
    select r.id, r.private from repositories r
    where r.installation_id in (${inList(ids)}) and r.removed_at is null`.execute(db);
  const priv = new Map(privRes.rows.map((x) => [num(x.id), x.private]));
  const recent = o.until.getTime() - PHASE1.recentDays * DAY_MS;
  const invalid = (row: MergedRow) => row.reason === "no_policy" || row.reason === "policy_invalid";

  const repositories: Phase1Repository[] = modeRows
    .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.repositoryId - b.repositoryId)
    .map((row) => {
      const id = row.repositoryId;
      const modes = modesOf(row, ceiling.ceiling);
      const mine = merged.filter((x) => x.repositoryId === id);
      const reportFailing = mine.filter((x) => x.mode === "report" && x.cls === "would_fail");
      const byReason: Record<string, number> = {};
      for (const x of reportFailing) {
        const k = x.reason ?? "none";
        byReason[k] = (byReason[k] ?? 0) + 1;
      }
      const last7 = mine.filter((x) => x.mergedAt.getTime() >= recent);
      const enforceSince = (key: "policy_mode" | "guard_mode") => {
        if (row.requested[key] !== "enforce") return null;
        const hit = sinceRes.rows.find((x) => num(x.repository_id) === id && x.key === key);
        return hit ? ymd(new Date(hit.applied_at)) : null;
      };
      const g = guard.filter((x) => x.repositoryId === id);
      const view = (s: { requested: string; effective: string; reason: string }) => ({
        requested: s.requested,
        effective: s.effective,
        reason: s.reason,
      });
      return {
        fullName: row.fullName,
        private: priv.get(id) ?? true,
        modes: {
          policy: view(modes.policy),
          guard: view(modes.guard),
          mcpWrite: view(modes.mcpWrite),
        },
        enforceSince: { policy: enforceSince("policy_mode"), guard: enforceSince("guard_mode") },
        merged: {
          total: mine.length,
          byMode: {
            enforce: mine.filter((x) => x.mode === "enforce").length,
            report: mine.filter((x) => x.mode === "report").length,
          },
          byClass: classesOf(mine),
        },
        wouldFailAtMerge: { total: reportFailing.length, byReason },
        invalidOrMissingPolicy: mine.filter(invalid).length,
        mergedWhileFailing: mine.filter((x) => x.mode === "enforce" && failing(x)).length,
        incidentsOnAuto: mine
          .filter((x) => x.mode === "enforce" && x.cls === "auto")
          .reduce((a, x) => a + x.incidents, 0),
        last7: {
          total: last7.length,
          byClass: classesOf(last7),
          wouldFailAtMerge: last7.filter((x) => x.mode === "report" && x.cls === "would_fail")
            .length,
          invalidOrMissingPolicy: last7.filter(invalid).length,
        },
        breakGlassApplied: applied.get(id) ?? 0,
        guard: guardClasses(g),
        needsHuman: g.filter((x) => x.status === "needs_human").length,
        mcpPrsOpened: mcpPrs.get(id) ?? 0,
      };
    });

  const criterion = (c: CriterionResult, rt: Rate) => ({
    verdict: c.verdict,
    incidents: rt.x,
    merged: rt.n,
    per100: per100(rt.x, rt.n),
    pValue: c.pValue,
  });
  const agentMeasured = measured.filter((x) => x.authorKind === "agent");
  const agentAll = merged.filter((x) => x.authorKind === "agent");
  const m2Side = (side: typeof m2In.measured) => ({
    baseline: minutesSide(side.baseline),
    phase1: minutesSide(side.phase1),
    delta: m2Delta(side.baseline, side.phase1),
    repositories: side.repositories,
  });
  const strip = ({ numerator: _n, ...rest }: ReturnType<typeof m3Side>) => rest;

  const report: Phase1GateReport = {
    schemaVersion: 1,
    phase: 1,
    window: { since: ymd(o.since), until: ymd(o.until), days },
    installations: insts.rows.map((i) => ({
      id: num(i.id),
      account: i.account_login,
      repositories: num(i.repos),
    })),
    verdict: decision.verdict,
    reasons: decision.reasons,
    preview: decision.preview,
    metrics: {
      m1: {
        verdict: decision.m1.verdict,
        reasons: decision.m1.reasons,
        preview: decision.m1.preview,
        measured: m1Side(measured, ids),
        projected: m1Side(merged, ids),
        agent: { measured: shareOf(agentMeasured), projected: shareOf(agentAll) },
        classes: {
          enforce: classesOf(measured),
          report: classesOf(merged.filter((x) => x.mode === "report")),
        },
        autoWithHumanApproval: measured.filter((x) => x.cls === "auto" && x.counted > 0).length,
        mergedWhileFailing: measured.filter(failing).length,
      },
      m2: {
        verdict: decision.m2.verdict,
        reasons: decision.m2.reasons,
        preview: decision.m2.preview,
        measured: m2Side(m2In.measured),
        projected: m2Side(m2In.projected),
        projectedZeros,
        pairedRepositories: paired.size,
      },
      m3: {
        verdict: decision.m3.verdict,
        reasons: decision.m3.reasons,
        preview: decision.m3.preview,
        measured: strip(m3Measured),
        projected: strip(m3Projected),
        classes: {
          enforce: guardClasses(guard.filter((g) => g.mode === "enforce")),
          report: guardClasses(guard.filter((g) => g.mode === "report")),
        },
        missedBy: [...missedBy.values()].sort(
          (a, b) =>
            b.n - a.n ||
            a.status.localeCompare(b.status) ||
            String(a.outcome).localeCompare(String(b.outcome)) ||
            String(a.reason).localeCompare(String(b.reason)),
        ),
        caughtBy: {
          reverted: caughtRows.filter((g) => g.status === "reverted").length,
          revertClosed: caughtRows.filter((g) => g.status === "revert_closed").length,
          revertOpened: caughtRows.filter((g) => g.status === "revert_opened").length,
          autoMergeEnabled: caughtRows.filter((g) => g.auto_merge_state === "enabled").length,
        },
      },
      m4: {
        verdict: decision.m4.verdict,
        reasons: decision.m4.reasons,
        preview: decision.m4.preview,
        lagDays: PHASE1.m4.defectLagDays,
        mergedBefore: ymd(mergedBefore),
        all: criterion(decision.m4.all, m4All),
        auto: criterion(decision.m4.auto, m4Auto),
        autoPreview: criterion(decision.m4.autoPreview, m4AutoPreview),
        baseline: {
          incidents: baseline.x,
          merged: baseline.n,
          per100: per100(baseline.x, baseline.n),
        },
        unlinked: num(unlinkedRes.rows[0]?.n),
      },
    },
    overrides: overridesRes.rows.map((x) => ({
      kind: x.kind,
      policyMode: x.policy_mode,
      n: num(x.n),
    })),
    mcp: {
      activeTokens: num(mcpRes.rows[0]?.tokens),
      prsOpened: [...mcpPrs.values()].reduce((a, b) => a + b, 0),
      provenanceReports: num(mcpRes.rows[0]?.reports),
      disagreements: num(mcpRes.rows[0]?.disagreements),
    },
    retention: {
      retained: num(retentionRes.rows[0]?.n),
      of: ids.length,
      target: PHASE1.retention.target,
    },
    repositories,
    runs: runsRes.rows.map((x) => ({
      repository: x.full_name,
      period: x.period,
      fromDate: x.from_date,
      toDate: x.to_date,
      extractedAt: new Date(x.extracted_at).toISOString(),
    })),
  };
  return phase1GateReportSchema.parse(report);
}
