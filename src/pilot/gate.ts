/**
 * The Phase 0 gate (step 6, T7, §8.1 and §8.3). `gatherGate` reads the database only (no GitHub
 * call), `decideGate` is pure, and the result is a `GateReport` (counts and ratios; no voter login,
 * title or body ever reaches it).
 */
import { sql } from "kysely";
import type { Config } from "../config/index.js";
import type { Db } from "../db/client.js";
import { type EffectiveVote, effectiveVotes } from "../modules/intent/index.js";
import type { AllowList } from "./allow-list.js";
import type { Aggregates } from "./baseline.js";
import { type GateReason, type GateReport, gateReportSchema } from "./gate-render.js";
import { summarize, wilson } from "./stats.js";

export type GateVerdict = "PASS" | "FAIL" | "INSUFFICIENT_DATA";
export type { GateReason };

export const GATE = {
  target: 0.9,
  lowerFloor: 0.85,
  minVotes: 150,
  minPrs: 50,
  minVoters: 6,
  minInstallations: 2,
  minVotesPerInstallation: 40,
  minWindowDays: 14,
  failFromN: 50,
  pointEstimateFromN: 400,
  coverage: 0.98,
  dominantVoterPct: 40,
} as const;

export interface GateInputs {
  up: number;
  down: number;
  /** Distinct PRs and distinct voters among the eligible votes. */
  prs: number;
  voters: number;
  /** Every installation of the report with its eligible vote count. */
  installations: readonly { id: number; votes: number }[];
  /**
   * First to last eligible vote, in days, exact (not floored, and not the operator's --since to
   * --until). The first day counts as a full day: 14 days of voting means a span of 13.
   */
  windowDays: number;
  coverage: {
    cards: { count: number; total: number };
    provenance: { count: number; total: number };
  };
  /** The voter with the most eligible votes: how many, and how many of them were up. */
  topVoter?: { votes: number; up: number };
}

const ratioOf = (c: { count: number; total: number }): number | null =>
  c.total === 0 ? null : c.count / c.total;

/** §8.1.6, in order. */
export function decideGate(o: GateInputs): { verdict: GateVerdict; reasons: GateReason[] } {
  const n = o.up + o.down;
  const w = wilson(o.up, n);
  const p = n === 0 ? 0 : o.up / n;

  // An early FAIL needs a sample that is not one voter or one pilot talking (the minimum voters
  // and pilots); with fewer the evidence is still collected below as INSUFFICIENT DATA.
  const heardFrom = o.installations.filter((i) => i.votes > 0).length;
  const broadEnough = o.voters >= GATE.minVoters && heardFrom >= GATE.minInstallations;
  if (n >= GATE.failFromN && w !== null && w.upper < GATE.target && broadEnough) {
    return {
      verdict: "FAIL",
      reasons: [{ code: "upper_below_target", upper: w.upper, target: GATE.target }],
    };
  }

  const missing: GateReason[] = [];
  if (n < GATE.minVotes) missing.push({ code: "below_min_votes", n, required: GATE.minVotes });
  if (o.prs < GATE.minPrs)
    missing.push({ code: "below_min_prs", prs: o.prs, required: GATE.minPrs });
  if (o.voters < GATE.minVoters) {
    missing.push({ code: "below_min_voters", voters: o.voters, required: GATE.minVoters });
  }
  if (o.installations.length < GATE.minInstallations) {
    missing.push({
      code: "fewer_than_two_pilots",
      installations: o.installations.length,
      required: GATE.minInstallations,
    });
  }
  for (const i of o.installations) {
    if (i.votes < GATE.minVotesPerInstallation) {
      missing.push({
        code: "pilot_below_min",
        installationId: i.id,
        votes: i.votes,
        required: GATE.minVotesPerInstallation,
      });
    }
  }
  if (o.windowDays + 1 < GATE.minWindowDays) {
    missing.push({ code: "window_too_short", days: o.windowDays, required: GATE.minWindowDays });
  }
  if (missing.length > 0) return { verdict: "INSUFFICIENT_DATA", reasons: missing };

  const coverage: GateReason[] = [];
  const cards = ratioOf(o.coverage.cards);
  const prov = ratioOf(o.coverage.provenance);
  if (cards === null || cards < GATE.coverage) {
    coverage.push({ code: "coverage_cards", ratio: cards, required: GATE.coverage });
  }
  if (prov === null || prov < GATE.coverage) {
    coverage.push({ code: "coverage_provenance", ratio: prov, required: GATE.coverage });
  }
  if (coverage.length > 0) return { verdict: "FAIL", reasons: coverage };

  // The PASS rule, on all votes and (leave-one-out) without the top voter.
  const passes = (up: number, total: number): boolean => {
    if (total === 0) return false;
    const ratio = up / total;
    if (total >= GATE.pointEstimateFromN) return ratio >= GATE.target;
    const ci = wilson(up, total);
    return ratio >= GATE.target && ci !== null && ci.lower >= GATE.lowerFloor;
  };
  const top = o.topVoter;
  if (passes(o.up, n) && top && n > 0) {
    const restUp = o.up - top.up;
    const rest = n - top.votes;
    if (!passes(restUp, rest)) {
      const ci = wilson(restUp, rest);
      return {
        verdict: "INSUFFICIENT_DATA",
        reasons: [
          {
            code: "dominant_voter",
            share: top.votes / n,
            accuracy: p,
            accuracyWithoutTop: rest === 0 ? null : restUp / rest,
            lowerWithoutTop: ci?.lower ?? null,
          },
        ],
      };
    }
  }

  if (n >= GATE.pointEstimateFromN) {
    return {
      verdict: p >= GATE.target ? "PASS" : "FAIL",
      reasons: [{ code: "point_estimate_decides", accuracy: p, n }],
    };
  }
  const lower = (w as { lower: number }).lower;
  if (p >= GATE.target && lower >= GATE.lowerFloor) {
    return { verdict: "PASS", reasons: [{ code: "pass", accuracy: p, lower, n }] };
  }
  return { verdict: "INSUFFICIENT_DATA", reasons: [{ code: "inconclusive", accuracy: p, lower }] };
}

// ---------------------------------------------------------------------------------------------
// Eligibility (pure)
// ---------------------------------------------------------------------------------------------

export type DropCause = "author" | "bot_or_agent" | "not_reviewer";

export interface EligibilityResult {
  kept: EffectiveVote[];
  dropped: Record<DropCause, number>;
}

/**
 * D5, in the order author, bot or agent, not a reviewer. `reviewers` holds `${changeId}:${userId}`
 * for every `pr_reviewers` row; `allow` holds lowercased logins.
 */
export function filterEligible(
  votes: readonly EffectiveVote[],
  o: {
    agentLogins: readonly string[];
    reviewers: ReadonlySet<string>;
    allow: ReadonlySet<string>;
    /** user id → the login of that user's newest vote: the allow-list matches by it. */
    latestLogin?: ReadonlyMap<number, string>;
  },
): EligibilityResult {
  const agents = new Set(o.agentLogins.map((l) => l.toLowerCase()));
  const kept: EffectiveVote[] = [];
  const dropped = { author: 0, bot_or_agent: 0, not_reviewer: 0 };
  for (const v of votes) {
    if (v.cardStatus !== "ok") continue;
    const login = v.userLogin.toLowerCase();
    if (v.isPrAuthor) dropped.author++;
    else if (login.endsWith("[bot]") || agents.has(login)) dropped.bot_or_agent++;
    else if (
      o.reviewers.has(`${v.changeId}:${v.userId}`) ||
      o.allow.has(login) ||
      o.allow.has((o.latestLogin?.get(v.userId) ?? login).toLowerCase())
    ) {
      kept.push(v);
    } else dropped.not_reviewer++;
  }
  return { kept, dropped };
}

/** `dominant_voter`: one voter cast more than 40% of the eligible votes (41% warns, 40% does not). */
export const isDominantVoter = (maxVotes: number, n: number): boolean =>
  n > 0 && maxVotes * 100 > GATE.dominantVoterPct * n;

export function accuracyRow(up: number, down: number) {
  const n = up + down;
  return { up, down, n, accuracy: n === 0 ? null : up / n, wilson: wilson(up, n) };
}

// ---------------------------------------------------------------------------------------------
// Gathering (database only)
// ---------------------------------------------------------------------------------------------

export class GateUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateUsageError";
  }
}

export interface GateOptions {
  installationIds: number[];
  since: Date;
  /** Exclusive. */
  until: Date;
  allow: AllowList | null;
}

const DAY_MS = 86_400_000;
const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const num = (v: unknown): number => Number(v ?? 0);
const inList = (ids: readonly (string | number)[]) => sql.join(ids.map((i) => sql`${i}`));

function addDecimal(a: string, b: string): string {
  const scale = (s: string) => {
    const [i = "0", f = ""] = s.split(".");
    return BigInt(i) * 100_000_000n + BigInt(f.padEnd(8, "0").slice(0, 8));
  };
  const total = scale(a) + scale(b);
  const whole = total / 100_000_000n;
  const frac = (total % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

export async function gatherGate(
  db: Db,
  config: Pick<Config, "agentLogins" | "metricsExcludedAuthors">,
  o: GateOptions,
): Promise<GateReport> {
  const ids = [...new Set(o.installationIds)];
  const insts = await sql<{ id: number; account_login: string; repos: string }>`
    select i.id, i.account_login,
      (select count(*) from repositories r where r.installation_id = i.id and r.removed_at is null)::text as repos
    from installations i where i.id in (${inList(ids)}) order by i.id`.execute(db);
  if (insts.rows.length !== ids.length) {
    throw new GateUsageError("an installation id does not exist");
  }
  const days = Math.round((o.until.getTime() - o.since.getTime()) / DAY_MS);
  if (!(o.until.getTime() > o.since.getTime()))
    throw new GateUsageError("--until must be after --since");

  // 1. Votes and eligibility.
  const votes = await effectiveVotes(db, { installationIds: ids, since: o.since, until: o.until });
  const okVotes = votes.filter((v) => v.cardStatus === "ok");
  const changeIds = [...new Set(okVotes.map((v) => v.changeId))];
  const reviewers = new Set<string>();
  const synced = new Set<string>();
  if (changeIds.length > 0) {
    const rows = await sql<{ change_id: string; user_id: number }>`
      select change_id, user_id from pr_reviewers where change_id in (${inList(changeIds)})`.execute(
      db,
    );
    for (const r of rows.rows) {
      reviewers.add(`${r.change_id}:${num(r.user_id)}`);
      synced.add(r.change_id);
    }
  }
  // A reviewer who renamed matches the allow-list by the login of their newest vote.
  const latest = await sql<{ user_id: number; user_login: string }>`
    select distinct on (f.user_id) f.user_id, f.user_login
    from intent_feedback f join changes ch on ch.id = f.change_id
    join repositories r on r.id = ch.repository_id
    where r.installation_id in (${inList(ids)})
    order by f.user_id, f.reacted_at desc, f.created_at desc`.execute(db);
  const latestLogin = new Map(latest.rows.map((r) => [num(r.user_id), r.user_login] as const));
  const { kept, dropped } = filterEligible(votes, {
    agentLogins: config.agentLogins,
    reviewers,
    allow: o.allow?.logins ?? new Set(),
    latestLogin,
  });
  const votesWithoutSync = new Set(
    okVotes.filter((v) => !v.isPrAuthor && !synced.has(v.changeId)).map((v) => v.changeId),
  ).size;

  const up = kept.filter((v) => v.verdict === "up").length;
  const down = kept.length - up;
  const prs = new Set(kept.map((v) => v.changeId)).size;
  const voterCounts = new Map<number, number>();
  for (const v of kept) voterCounts.set(v.userId, (voterCounts.get(v.userId) ?? 0) + 1);
  const voters = voterCounts.size;
  const maxVoter = Math.max(0, ...voterCounts.values());
  const topEntry = [...voterCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const topVoter = topEntry
    ? {
        votes: topEntry[1],
        up: kept.filter((v) => v.userId === topEntry[0] && v.verdict === "up").length,
      }
    : undefined;
  // The 14-day minimum is measured on the data (first to last eligible vote), not on --since.
  const times = kept.map((v) => v.reactedAt.getTime());
  const dataSpanDays =
    times.length === 0
      ? 0
      : Math.round(((Math.max(...times) - Math.min(...times)) / DAY_MS) * 100) / 100;

  const perInstallation = insts.rows.map((i) => {
    const mine = kept.filter((v) => v.installationId === num(i.id));
    const u = mine.filter((v) => v.verdict === "up").length;
    return {
      installationId: num(i.id),
      ...accuracyRow(u, mine.length - u),
      prs: new Set(mine.map((v) => v.changeId)).size,
      voters: new Set(mine.map((v) => v.userId)).size,
    };
  });

  // Card-level accuracy: a card with any eligible down is inaccurate.
  const perCard = new Map<string, { up: number; down: number }>();
  for (const v of kept) {
    const c = perCard.get(v.cardId) ?? { up: 0, down: 0 };
    c[v.verdict]++;
    perCard.set(v.cardId, c);
  }
  let accurate = 0;
  let inaccurate = 0;
  for (const c of perCard.values()) {
    if (c.down > 0) inaccurate++;
    else if (c.up > 0) accurate++;
  }

  // 2. Coverage over the PRs opened in the window.
  const excluded = config.metricsExcludedAuthors.length > 0 ? config.metricsExcludedAuthors : [""];
  const cov = await sql<{ total: string; cards: string; prov: string }>`
    select count(*)::text as total,
      count(*) filter (where exists (select 1 from intent_displays d where d.change_id = ch.id))::text as cards,
      count(*) filter (where exists (select 1 from change_provenance cp where cp.change_id = ch.id))::text as prov
    from changes ch join repositories r on r.id = ch.repository_id
    where r.installation_id in (${inList(ids)})
      and ch.opened_at >= ${o.since} and ch.opened_at < ${o.until}
      and lower(ch.author_login) not in (${sql.join(excluded)})
      and not (ch.closed_at is not null and ch.closed_at < ch.opened_at + interval '10 minutes')`.execute(
    db,
  );
  const covRow = cov.rows[0];
  const coverage = {
    cards: { count: num(covRow?.cards), total: num(covRow?.total) },
    provenance: { count: num(covRow?.prov), total: num(covRow?.total) },
  };

  // 3. The decision.
  const decision = decideGate({
    up,
    down,
    prs,
    voters,
    installations: perInstallation.map((p) => ({ id: p.installationId, votes: p.n })),
    windowDays: dataSpanDays,
    coverage,
    ...(topVoter ? { topVoter } : {}),
  });
  const warnings: GateReport["warnings"] = [];
  if (isDominantVoter(maxVoter, kept.length)) {
    warnings.push("dominant_voter");
  }
  if (votesWithoutSync > 0) warnings.push("votes_without_reviewer_sync");

  // 4. Side metrics: rollup sums over the window.
  const sums = await sql<Record<string, string | null>>`
    select m.repository_id,
      count(*)::text as days,
      ${sql.join(
        [
          "prs_merged",
          "merged_would_approve",
          "merged_would_require",
          "merged_would_block",
          "merged_no_policy",
          "merged_policy_invalid",
          "merged_no_verdict",
          "merged_would_approve_agent",
          "merged_agent",
          "merged_trivial",
          "verifier_agree",
          "verifier_disagree",
          "verifier_error",
          "verifier_skipped",
          "cards_ok",
          "cards_unavailable",
          "spend_tokens",
          "unpriced_runs",
          "unpriced_tokens",
        ].map((k) => sql`coalesce(sum((m.counts->>${k})::bigint), 0)::text as ${sql.ref(k)}`),
      )},
      coalesce(sum((m.counts->>'cost_usd')::numeric), 0)::text as cost_usd
    from metrics_daily m join repositories r on r.id = m.repository_id
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and m.day >= ${ymd(o.since)}::date and m.day < ${ymd(o.until)}::date
    group by m.repository_id`.execute(db);
  const tot: Record<string, number> = {};
  let rollupDays = 0;
  let costUsd = "0";
  for (const r of sums.rows) {
    rollupDays += num(r.days);
    for (const [k, v] of Object.entries(r)) {
      if (k === "repository_id" || k === "days") continue;
      if (k === "cost_usd") costUsd = addDecimal(costUsd, String(v ?? "0"));
      else tot[k] = (tot[k] ?? 0) + num(v);
    }
  }
  const repoCount = (
    await sql<{ n: string }>`
      select count(*)::text as n from repositories r
      where r.installation_id in (${inList(ids)}) and r.removed_at is null`.execute(db)
  ).rows[0];
  if (rollupDays < days * num(repoCount?.n)) warnings.push("rollup_incomplete");
  const t = (k: string): number => tot[k] ?? 0;

  // Raw: unavailable reasons, PRs by last display, priced PR count.
  const reasons = await sql<{ reason: string | null; n: string }>`
    select c.failure_reason as reason, count(*)::text as n
    from intent_cards c join changes ch on ch.id = c.change_id
    join repositories r on r.id = ch.repository_id
    where r.installation_id in (${inList(ids)}) and c.status = 'unavailable'
      and c.created_at >= ${o.since} and c.created_at < ${o.until}
    group by 1 order by 2 desc, 1`.execute(db);
  const lastDisplay = await sql<{ with_display: string; last_unavailable: string }>`
    select count(*)::text as with_display,
      count(*) filter (where last.status = 'unavailable')::text as last_unavailable
    from changes ch join repositories r on r.id = ch.repository_id
    join lateral (
      select d.status from intent_displays d
      where d.change_id = ch.id and d.status <> 'pending' and d.shown_at < ${o.until}
      order by d.shown_at desc, d.seq desc limit 1
    ) last on true
    where r.installation_id in (${inList(ids)})
      and ch.opened_at >= ${o.since} and ch.opened_at < ${o.until}
      and lower(ch.author_login) not in (${sql.join(excluded)})`.execute(db);
  const priced = await sql<{ prs: string }>`
    select count(distinct s.change_id)::text as prs from intent_spend s
    join repositories r on r.id = s.repository_id
    where r.installation_id in (${inList(ids)}) and s.change_id is not null
      and s.spent_at >= ${o.since} and s.spent_at < ${o.until}`.execute(db);

  // 5. Review time: the latest baseline and shadow run per repository, pooled.
  const { reviewTime, scope: reviewTimeScope } = await reviewTimeComparison(db, ids);

  // 6. Escaped defects.
  const defects = await escapedDefects(db, ids, o.since, o.until, excluded);

  const report: GateReport = {
    schemaVersion: 1,
    window: { since: ymd(o.since), until: ymd(o.until), days, dataSpanDays },
    installations: insts.rows.map((i) => ({
      id: num(i.id),
      account: i.account_login,
      repositories: num(i.repos),
    })),
    allowList: o.allow ? { count: o.allow.count, sha256: o.allow.sha256 } : null,
    verdict: decision.verdict,
    reasons: decision.reasons,
    accuracy: {
      ...accuracyRow(up, down),
      prs,
      voters,
      cards: { rated: perCard.size, accurate, inaccurate },
      bySource: {
        reaction: kept.filter((v) => v.source === "reaction").length,
        check_action: kept.filter((v) => v.source === "check_action").length,
      },
      perInstallation,
      dropped,
      votesWithoutReviewerSync: votesWithoutSync,
    },
    coverage: {
      cards: { ...coverage.cards, ratio: ratioOf(coverage.cards) },
      provenance: { ...coverage.provenance, ratio: ratioOf(coverage.provenance) },
    },
    warnings,
    policy: {
      merged: t("prs_merged"),
      wouldApprove: t("merged_would_approve"),
      wouldRequire: t("merged_would_require"),
      wouldBlock: t("merged_would_block"),
      noPolicy: t("merged_no_policy"),
      policyInvalid: t("merged_policy_invalid"),
      noVerdict: t("merged_no_verdict"),
      wouldApproveAgent: t("merged_would_approve_agent"),
      mergedAgent: t("merged_agent"),
      mergedTrivial: t("merged_trivial"),
    },
    cards: {
      created: t("cards_ok") + t("cards_unavailable"),
      ok: t("cards_ok"),
      unavailable: t("cards_unavailable"),
      verifier: {
        agree: t("verifier_agree"),
        disagree: t("verifier_disagree"),
        error: t("verifier_error"),
        skipped: t("verifier_skipped"),
      },
      unavailableByReason: reasons.rows.map((r) => ({
        reason: r.reason ?? "unknown",
        count: num(r.n),
      })),
      prsWithDisplay: num(lastDisplay.rows[0]?.with_display),
      prsLastUnavailable: num(lastDisplay.rows[0]?.last_unavailable),
      costUsd,
      pricedPrs: num(priced.rows[0]?.prs),
      tokens: t("spend_tokens"),
      unpricedRuns: t("unpriced_runs"),
      unpricedTokens: t("unpriced_tokens"),
    },
    reviewTimeScope,
    reviewTime,
    escapedDefects: defects,
  };
  return gateReportSchema.parse(report);
}

type RunRow = {
  repository_id: number;
  state: string;
  author_kind: string;
  minutes_to_first_approval: string | null;
  minutes_to_merge: string | null;
};

async function latestRunRows(db: Db, ids: readonly number[], period: "baseline" | "shadow") {
  const res = await sql<RunRow>`
    select run.repository_id, p.state, p.author_kind, p.minutes_to_first_approval, p.minutes_to_merge
    from review_time_runs run
    join repositories r on r.id = run.repository_id
    join review_time_prs p on p.run_id = run.id
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and run.period = ${period} and p.excluded_reason is null
      and run.id = (
        select x.id from review_time_runs x
        where x.repository_id = run.repository_id and x.period = ${period}
        order by x.extracted_at desc, x.id desc limit 1)`.execute(db);
  return res.rows;
}

/** Repositories with a run in a period (even a run with no rows). */
async function repositoriesWithRun(db: Db, ids: readonly number[], period: "baseline" | "shadow") {
  const res = await sql<{ repository_id: number }>`
    select distinct run.repository_id
    from review_time_runs run join repositories r on r.id = run.repository_id
    where r.installation_id in (${inList(ids)}) and r.removed_at is null
      and run.period = ${period}`.execute(db);
  return new Set(res.rows.map((r) => num(r.repository_id)));
}

/**
 * Only repositories that have both a baseline and a shadow run are compared (D4): a repository
 * with one side would shift that side's percentile and give a wrong delta. The rows of the paired
 * repositories are pooled and the percentiles recomputed.
 */
async function reviewTimeComparison(
  db: Db,
  ids: readonly number[],
): Promise<{ reviewTime: GateReport["reviewTime"]; scope: GateReport["reviewTimeScope"] }> {
  const [baseRepos, shadowRepos] = [
    await repositoriesWithRun(db, ids, "baseline"),
    await repositoriesWithRun(db, ids, "shadow"),
  ];
  const paired = new Set([...baseRepos].filter((r) => shadowRepos.has(r)));
  const keep = (rows: RunRow[]) => rows.filter((r) => paired.has(num(r.repository_id)));
  const base = keep(await latestRunRows(db, ids, "baseline"));
  const shadow = keep(await latestRunRows(db, ids, "shadow"));
  const inGroup = (rows: RunRow[], group: string) =>
    rows.filter((r) => group === "all" || r.author_kind === group);
  const pick = (
    rows: RunRow[],
    group: string,
    f: "minutes_to_first_approval" | "minutes_to_merge",
  ) => summarize(inGroup(rows, group).flatMap((r) => (r[f] === null ? [] : [Number(r[f])])));
  const delta = (b: number | null, s: number | null): number | null =>
    b === null || s === null || b === 0 ? null : (s - b) / b;
  const side = (rows: RunRow[], group: string) => ({
    firstApproval: pick(rows, group, "minutes_to_first_approval"),
    merge: pick(rows, group, "minutes_to_merge"),
    prs: inGroup(rows, group).length,
    open: inGroup(rows, group).filter((r) => r.state === "open").length,
  });
  const reviewTime = (["all", "agent", "human"] as const).map((group) => {
    const b = side(base, group);
    const s = side(shadow, group);
    return {
      group,
      baseline: b,
      shadow: s,
      deltaFirstApprovalPct: delta(b.firstApproval.p50, s.firstApproval.p50),
      deltaMergePct: delta(b.merge.p50, s.merge.p50),
    };
  });
  return {
    reviewTime,
    scope: {
      pairedRepositories: paired.size,
      baselineOnly: [...baseRepos].filter((r) => !shadowRepos.has(r)).length,
      shadowOnly: [...shadowRepos].filter((r) => !baseRepos.has(r)).length,
    },
  };
}

async function escapedDefects(
  db: Db,
  ids: readonly number[],
  since: Date,
  until: Date,
  excluded: readonly string[],
): Promise<GateReport["escapedDefects"]> {
  const merged = await sql<{
    merged: string;
    incidents: string;
    agent_merged: string;
    agent_incidents: string;
    human_merged: string;
    human_incidents: string;
    wa_merged: string;
    wa_incidents: string;
  }>`
    with m as (
      select ch.id, ch.repository_id, ch.pr_number,
        coalesce(cp.author_kind, 'human') as kind,
        coalesce((
          select pv.outcome = 'would_approve' from policy_verdicts pv
          where pv.change_id = ch.id and pv.head_sha = ch.head_sha
          order by pv.facts_read_at desc, pv.created_at desc limit 1), false) as wa,
        (select count(*) from incidents i
          where i.repository_id = ch.repository_id and i.culprit_pr_number = ch.pr_number) as inc
      from changes ch
      join repositories r on r.id = ch.repository_id
      left join change_provenance cp on cp.change_id = ch.id
      where r.installation_id in (${inList(ids)}) and ch.state = 'merged'
        and ch.merged_at >= ${since} and ch.merged_at < ${until}
        and lower(ch.author_login) not in (${sql.join(excluded)}))
    select count(*)::text as merged, coalesce(sum(inc), 0)::text as incidents,
      count(*) filter (where kind = 'agent')::text as agent_merged,
      coalesce(sum(inc) filter (where kind = 'agent'), 0)::text as agent_incidents,
      count(*) filter (where kind = 'human')::text as human_merged,
      coalesce(sum(inc) filter (where kind = 'human'), 0)::text as human_incidents,
      count(*) filter (where wa)::text as wa_merged,
      coalesce(sum(inc) filter (where wa), 0)::text as wa_incidents
    from m`.execute(db);
  const m = merged.rows[0];
  const baseline = await sql<{ merged: string; incidents: string }>`
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
  const b = baseline.rows[0];
  const sources = await sql<{ source: string; n: string }>`
    select i.source, count(*)::text as n from incidents i
    join repositories r on r.id = i.repository_id
    where r.installation_id in (${inList(ids)})
      and i.occurred_at >= ${since} and i.occurred_at < ${until}
    group by i.source`.execute(db);
  const bySource = { cli: 0, label: 0 };
  for (const r of sources.rows)
    if (r.source === "cli" || r.source === "label") bySource[r.source] = num(r.n);
  const per100 = (inc: number, n: number): number | null => (n === 0 ? null : (inc / n) * 100);
  return {
    incidents: num(m?.incidents),
    merged: num(m?.merged),
    per100: per100(num(m?.incidents), num(m?.merged)),
    agentIncidents: num(m?.agent_incidents),
    agentMerged: num(m?.agent_merged),
    humanIncidents: num(m?.human_incidents),
    humanMerged: num(m?.human_merged),
    onWouldApproveIncidents: num(m?.wa_incidents),
    onWouldApproveMerged: num(m?.wa_merged),
    bySource,
    baselineIncidents: num(b?.incidents),
    baselineMerged: num(b?.merged),
    baselinePer100: per100(num(b?.incidents), num(b?.merged)),
  };
}

export type { Aggregates };
