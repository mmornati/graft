/**
 * The gate report: its JSON schema (`gateReportSchema`, schemaVersion 1) and the markdown (§11).
 * The report holds counts, ratios, installation ids and organisation account names. It never holds
 * a voter login, a title, a body or a path.
 */
import { z } from "zod";

const ratio = z.number().min(0).max(1).nullable();
const interval = z.object({ lower: z.number(), upper: z.number() }).nullable();

export const gateReasonSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("below_min_votes"), n: z.number(), required: z.number() }),
  z.object({ code: z.literal("below_min_prs"), prs: z.number(), required: z.number() }),
  z.object({ code: z.literal("below_min_voters"), voters: z.number(), required: z.number() }),
  z.object({
    code: z.literal("pilot_below_min"),
    installationId: z.number(),
    votes: z.number(),
    required: z.number(),
  }),
  z.object({
    code: z.literal("fewer_than_two_pilots"),
    installations: z.number(),
    required: z.number(),
  }),
  z.object({ code: z.literal("window_too_short"), days: z.number(), required: z.number() }),
  z.object({ code: z.literal("inconclusive"), accuracy: z.number(), lower: z.number() }),
  z.object({ code: z.literal("upper_below_target"), upper: z.number(), target: z.number() }),
  z.object({ code: z.literal("coverage_cards"), ratio: ratio, required: z.number() }),
  z.object({ code: z.literal("coverage_provenance"), ratio: ratio, required: z.number() }),
  z.object({ code: z.literal("point_estimate_decides"), accuracy: z.number(), n: z.number() }),
  z.object({
    code: z.literal("dominant_voter"),
    /** The top voter's share of the eligible votes. */
    share: z.number(),
    accuracy: z.number(),
    accuracyWithoutTop: ratio,
    lowerWithoutTop: z.number().nullable(),
  }),
  z.object({ code: z.literal("pass"), accuracy: z.number(), lower: z.number(), n: z.number() }),
]);
export type GateReason = z.infer<typeof gateReasonSchema>;

const accuracyRow = z.object({
  up: z.number().int(),
  down: z.number().int(),
  n: z.number().int(),
  accuracy: ratio,
  wilson: interval,
});
const summary = z.object({
  n: z.number().int(),
  p50: z.number().nullable(),
  p75: z.number().nullable(),
  p90: z.number().nullable(),
});
const coverage = z.object({
  count: z.number().int(),
  total: z.number().int(),
  ratio: ratio,
});

export const gateReportSchema = z.object({
  schemaVersion: z.literal(1),
  window: z.object({
    since: z.string(),
    until: z.string(),
    days: z.number(),
    /** First to last eligible vote, in days: what the 14-day minimum is measured on. */
    dataSpanDays: z.number(),
  }),
  installations: z.array(
    z.object({ id: z.number().int(), account: z.string(), repositories: z.number().int() }),
  ),
  allowList: z.object({ count: z.number().int(), sha256: z.string() }).nullable(),
  verdict: z.enum(["PASS", "FAIL", "INSUFFICIENT_DATA"]),
  reasons: z.array(gateReasonSchema),
  accuracy: accuracyRow.extend({
    prs: z.number().int(),
    voters: z.number().int(),
    cards: z.object({
      rated: z.number().int(),
      accurate: z.number().int(),
      inaccurate: z.number().int(),
    }),
    bySource: z.object({ reaction: z.number().int(), check_action: z.number().int() }),
    perInstallation: z.array(
      accuracyRow.extend({
        installationId: z.number().int(),
        prs: z.number().int(),
        voters: z.number().int(),
      }),
    ),
    dropped: z.object({
      author: z.number().int(),
      bot_or_agent: z.number().int(),
      not_reviewer: z.number().int(),
    }),
    votesWithoutReviewerSync: z.number().int(),
  }),
  coverage: z.object({ cards: coverage, provenance: coverage }),
  warnings: z.array(z.enum(["dominant_voter", "rollup_incomplete", "votes_without_reviewer_sync"])),
  policy: z.object({
    merged: z.number().int(),
    wouldApprove: z.number().int(),
    wouldRequire: z.number().int(),
    wouldBlock: z.number().int(),
    noPolicy: z.number().int(),
    policyInvalid: z.number().int(),
    noVerdict: z.number().int(),
    wouldApproveAgent: z.number().int(),
    mergedAgent: z.number().int(),
    mergedTrivial: z.number().int(),
  }),
  cards: z.object({
    created: z.number().int(),
    ok: z.number().int(),
    unavailable: z.number().int(),
    verifier: z.object({
      agree: z.number().int(),
      disagree: z.number().int(),
      error: z.number().int(),
      skipped: z.number().int(),
    }),
    unavailableByReason: z.array(z.object({ reason: z.string(), count: z.number().int() })),
    prsWithDisplay: z.number().int(),
    prsLastUnavailable: z.number().int(),
    costUsd: z.string(),
    pricedPrs: z.number().int(),
    tokens: z.number().int(),
    unpricedRuns: z.number().int(),
    unpricedTokens: z.number().int(),
  }),
  reviewTimeScope: z.object({
    pairedRepositories: z.number().int(),
    baselineOnly: z.number().int(),
    shadowOnly: z.number().int(),
  }),
  reviewTime: z.array(
    z.object({
      group: z.enum(["all", "agent", "human"]),
      baseline: z.object({
        firstApproval: summary,
        merge: summary,
        prs: z.number().int(),
        open: z.number().int(),
      }),
      shadow: z.object({
        firstApproval: summary,
        merge: summary,
        prs: z.number().int(),
        open: z.number().int(),
      }),
      deltaFirstApprovalPct: z.number().nullable(),
      deltaMergePct: z.number().nullable(),
    }),
  ),
  escapedDefects: z.object({
    incidents: z.number().int(),
    merged: z.number().int(),
    per100: z.number().nullable(),
    agentIncidents: z.number().int(),
    agentMerged: z.number().int(),
    humanIncidents: z.number().int(),
    humanMerged: z.number().int(),
    onWouldApproveIncidents: z.number().int(),
    onWouldApproveMerged: z.number().int(),
    bySource: z.object({ cli: z.number().int(), label: z.number().int() }),
    baselineIncidents: z.number().int(),
    baselineMerged: z.number().int(),
    baselinePer100: z.number().nullable(),
  }),
});
export type GateReport = z.infer<typeof gateReportSchema>;

const VERDICT_TEXT: Record<GateReport["verdict"], string> = {
  PASS: "PASS",
  FAIL: "FAIL",
  INSUFFICIENT_DATA: "INSUFFICIENT DATA",
};

export function reasonText(r: GateReason): string {
  switch (r.code) {
    case "below_min_votes":
      return `below_min_votes (${r.n} of ${r.required})`;
    case "below_min_prs":
      return `below_min_prs (${r.prs} of ${r.required})`;
    case "below_min_voters":
      return `below_min_voters (${r.voters} of ${r.required})`;
    case "pilot_below_min":
      return `pilot_below_min (inst ${r.installationId}: ${r.votes} of ${r.required})`;
    case "fewer_than_two_pilots":
      return `fewer_than_two_pilots (${r.installations} of ${r.required})`;
    case "window_too_short":
      return `window_too_short (${r.days} of ${r.required} days; the first day counts as a full day)`;
    case "inconclusive":
      return `inconclusive (accuracy ${pct(r.accuracy)}, lower bound ${pct(r.lower)})`;
    case "upper_below_target":
      return `upper_below_target (upper bound ${pct(r.upper)}, target ${pct(r.target)})`;
    case "coverage_cards":
      return `coverage_cards (${pct(r.ratio)}, required ${pct(r.required)})`;
    case "coverage_provenance":
      return `coverage_provenance (${pct(r.ratio)}, required ${pct(r.required)})`;
    case "point_estimate_decides":
      return `point_estimate_decides (accuracy ${pct(r.accuracy)} at ${r.n} votes)`;
    case "dominant_voter":
      return `dominant_voter (the top voter cast ${pct(r.share, 0)} of the votes; accuracy ${pct(r.accuracy)} with, ${pct(r.accuracyWithoutTop)} without them, lower bound without them ${pct(r.lowerWithoutTop)}: the PASS rule does not hold without that voter)`;
    case "pass":
      return `passed: accuracy ${pct(r.accuracy)} ≥ 90% and Wilson lower bound ${pct(r.lower)} ≥ 85% at ${r.n} votes`;
  }
}

export const pct = (x: number | null, digits = 1): string =>
  x === null ? "n/a" : `${(x * 100).toFixed(digits)}%`;
const usd = (s: string): string => `$${s}`;
const signed = (x: number | null): string =>
  x === null ? "n/a" : `${x < 0 ? "−" : x > 0 ? "+" : ""}${Math.abs(Math.round(x * 100))}%`;
const mins = (x: number | null): string => (x === null ? "n/a" : `${Math.round(x)}`);
const share = (n: number, d: number): string => (d === 0 ? "n/a" : pct(n / d, 0));
const wilsonText = (w: { lower: number; upper: number } | null): string =>
  w === null ? "n/a" : `${(w.lower * 100).toFixed(1)}–${(w.upper * 100).toFixed(1)}%`;

/** Byte-stable markdown for a report. */
export function renderGateMarkdown(r: GateReport): string {
  const lines: string[] = [];
  lines.push(`# Graft Phase 0 gate — ${r.window.since} to ${r.window.until}`, "");
  const reasons =
    r.reasons.length > 0 ? ` — ${r.reasons.map((x) => reasonText(x)).join(", ")}` : "";
  lines.push(`**Verdict: ${VERDICT_TEXT[r.verdict]}**${reasons}`, "");
  const through = new Date(Date.parse(`${r.window.until}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const instText = r.installations
    .map(
      (i) => `${i.id} (${i.account}, ${i.repositories} ${i.repositories === 1 ? "repo" : "repos"})`,
    )
    .join(", ");
  const allow = r.allowList
    ? `${r.allowList.count} ${r.allowList.count === 1 ? "login" : "logins"} (sha256 ${r.allowList.sha256.slice(0, 8)}…)`
    : "none";
  lines.push(`Installations: ${instText}. Data through ${through}. Allow-list: ${allow}.`, "");

  lines.push("## Card accuracy (eligible reviewer votes)");
  lines.push("| Scope | 👍 | 👎 | n | Accuracy | Wilson 95% | PRs | Voters |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const a = r.accuracy;
  lines.push(
    `| All | ${a.up} | ${a.down} | ${a.n} | ${pct(a.accuracy)} | ${wilsonText(a.wilson)} | ${a.prs} | ${a.voters} |`,
  );
  for (const p of a.perInstallation) {
    lines.push(
      `| ${p.installationId} | ${p.up} | ${p.down} | ${p.n} | ${pct(p.accuracy)} | ${wilsonText(p.wilson)} | ${p.prs} | ${p.voters} |`,
    );
  }
  lines.push(
    `Dropped votes: author ${a.dropped.author}, bot/agent ${a.dropped.bot_or_agent}, not a reviewer ${a.dropped.not_reviewer}. Card-level accuracy: ${
      a.cards.rated === 0 ? "n/a" : pct(a.cards.accurate / a.cards.rated)
    } (${a.cards.accurate} of ${a.cards.rated} cards). Votes by source: reaction ${a.bySource.reaction}, button ${a.bySource.check_action}.`,
  );
  lines.push(
    `Coverage: cards ${pct(r.coverage.cards.ratio)} (≥ 98%), provenance ${pct(r.coverage.provenance.ratio)} (≥ 98%).`,
  );
  const warn = r.warnings.map((w) =>
    w === "votes_without_reviewer_sync"
      ? `votes_without_reviewer_sync (${a.votesWithoutReviewerSync} PRs with votes have no reviewer row)`
      : w,
  );
  lines.push(`Warnings: ${warn.length === 0 ? "none" : warn.join(", ")}.`);
  lines.push(
    `Data span ${r.window.dataSpanDays} days (first to last eligible vote). The interval treats votes as independent; votes are clustered by PR and reviewer, so it is optimistic and a pass near the thresholds deserves a look at the votes.`,
    "",
  );

  const p = r.policy;
  lines.push("## Policy (merged PRs)");
  lines.push(
    `Would approve ${share(p.wouldApprove, p.merged)} (target ≥ 30%; agent PRs ${share(p.wouldApproveAgent, p.mergedAgent)}) | require ${share(p.wouldRequire, p.merged)} | block ${share(p.wouldBlock, p.merged)} | no policy ${share(p.noPolicy, p.merged)} | invalid ${share(p.policyInvalid, p.merged)} | no verdict ${share(p.noVerdict, p.merged)} | trivial ${share(p.mergedTrivial, p.merged)} (of ${p.merged} merged)`,
    "",
  );

  const c = r.cards;
  const pairs = c.verifier.agree + c.verifier.disagree;
  const reasonsText =
    c.unavailableByReason.length === 0
      ? "none"
      : c.unavailableByReason.map((x) => `${x.reason} ${x.count}`).join(", ");
  lines.push("## Cards");
  lines.push(
    `verifier disagrees ${pairs === 0 ? "n/a" : pct(c.verifier.disagree / pairs)} (error ${c.verifier.error}, skipped ${c.verifier.skipped}) | unavailable ${c.created === 0 ? "n/a" : pct(c.unavailable / c.created)} (${reasonsText}); PRs whose last card is unavailable ${c.prsWithDisplay === 0 ? "n/a" : pct(c.prsLastUnavailable / c.prsWithDisplay)} | cost/PR ${
      c.pricedPrs === 0 ? "n/a" : usd(perPr(c.costUsd, c.pricedPrs))
    } (${c.tokens} tokens; unpriced runs ${c.unpricedRuns}, unpriced tokens ${c.unpricedTokens})`,
    "",
  );

  lines.push("## Review time (indicative: shadow mode, Graft blocks nothing)");
  lines.push(
    "| Group | First approval p50 baseline → shadow | Δ | Merge p50 baseline → shadow | Δ |",
  );
  lines.push("| --- | --- | --- | --- | --- |");
  for (const g of r.reviewTime) {
    const target = g.group === "agent" ? " (Phase 1 target ≤ −50%)" : "";
    lines.push(
      `| ${g.group} | ${mins(g.baseline.firstApproval.p50)} → ${mins(g.shadow.firstApproval.p50)} min | ${signed(g.deltaFirstApprovalPct)}${target} | ${mins(g.baseline.merge.p50)} → ${mins(g.shadow.merge.p50)} min | ${signed(g.deltaMergePct)} |`,
    );
  }
  const sc = r.reviewTimeScope;
  lines.push(
    "",
    `Repositories with both a baseline and a shadow run: ${sc.pairedRepositories}; left out: ${sc.baselineOnly} with a baseline only, ${sc.shadowOnly} with a shadow run only.`,
  );
  lines.push(
    `Unfinished PRs (right-censored, left out of the percentiles, so a short shadow window biases its p50 low): ${r.reviewTime
      .map(
        (g) =>
          `${g.group} baseline ${g.baseline.open} of ${g.baseline.prs}, shadow ${g.shadow.open} of ${g.shadow.prs}`,
      )
      .join("; ")}.`,
  );
  lines.push("");

  const e = r.escapedDefects;
  lines.push("## Escaped defects");
  lines.push(
    `${e.per100 === null ? "n/a" : e.per100.toFixed(1)} incidents per 100 merged PRs (${e.incidents} of ${e.merged}; baseline ${
      e.baselinePer100 === null ? "n/a" : e.baselinePer100.toFixed(1)
    }) | agent ${e.agentIncidents} of ${e.agentMerged}, human ${e.humanIncidents} of ${e.humanMerged} | on would-approve PRs: ${e.onWouldApproveIncidents} of ${e.onWouldApproveMerged} | recorded incidents by source: cli ${e.bySource.cli}, label ${e.bySource.label} (review label incidents with incident list)`,
  );
  return `${lines.join("\n")}\n`;
}

/** Decimal-string division to $0.000 precision without floating point drift in the sum. */
function perPr(total: string, prs: number): string {
  const per = Number(total) / prs;
  return per.toFixed(3);
}
