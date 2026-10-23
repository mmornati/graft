/**
 * The Phase 1 gate report (Phase 1 step 7, D14, §10): its JSON schema (`phase1GateReportSchema`,
 * `schemaVersion: 1`, `phase: 1`) and its markdown. The report holds counts, ratios, minutes,
 * installation ids, account and repository names, dates and reason codes. It never holds a login,
 * a title, a body, a path list or YAML (I-P1G-9).
 */
import { z } from "zod";

const verdict = z.enum(["PASS", "FAIL", "INSUFFICIENT_DATA"]);
export type Phase1Verdict = z.infer<typeof verdict>;

export const PHASE1_REASON_CODES = [
  "m1_upper_below_target",
  "m1_below_min_merged",
  "m1_below_min_installations",
  "m1_window_too_short",
  "m1_inconclusive",
  "m1_point_estimate_decides",
  "m2_below_min_rows",
  "m2_below_min_repositories",
  "m2_baseline_zero",
  /** Not in the spec's list: a FAIL of M2 decided by its value (recorded in decisions.md). */
  "m2_above_target",
  "m3_below_min_breakages",
  "m3_below_min_repositories",
  /** Not in the spec's list: a FAIL of M3 decided by its value (recorded in decisions.md). */
  "m3_below_target",
  "m4_defect_lag",
  "m4_below_min_window",
  "m4_below_min_baseline",
  "m4_below_min_auto",
  "m4_rise",
  "pass",
] as const;
export type Phase1ReasonCode = (typeof PHASE1_REASON_CODES)[number];

/** A reason: its code, the metric, and the value and requirement it compared when there is one. */
const reason = z.object({
  metric: z.enum(["m1", "m2", "m3", "m4"]),
  code: z.enum(PHASE1_REASON_CODES),
  value: z.number().nullable(),
  required: z.number().nullable(),
});
export type Phase1Reason = z.infer<typeof reason>;

const decision = z.object({ verdict, reasons: z.array(reason) });
const ratio = z.number().min(0).max(1).nullable();
const interval = z.object({ lower: z.number(), upper: z.number() }).nullable();
const count = z.number().int().min(0);

export const MERGED_CLASSES = [
  "auto",
  "human",
  "break_glass",
  "would_fail",
  "pending",
  "no_verdict",
] as const;
export type MergedClass = (typeof MERGED_CLASSES)[number];
const classCounts = z.object(
  Object.fromEntries(MERGED_CLASSES.map((c) => [c, count])) as Record<MergedClass, typeof count>,
);

export const GUARD_CLASSES = [
  "open",
  "flaky",
  "flaky_unconfirmed",
  "dismissed",
  "caught",
  "would_catch",
  "missed",
] as const;
export type GuardClass = (typeof GUARD_CLASSES)[number];
const guardCounts = z.object(
  Object.fromEntries(GUARD_CLASSES.map((c) => [c, count])) as Record<GuardClass, typeof count>,
);

const share = z.object({ n: count, x: count, share: ratio, wilson: interval });
const m1Side = share.extend({
  installations: z.array(z.object({ id: z.number().int(), n: count })),
  spanDays: z.number(),
});
const minutesSide = z.object({
  n: count,
  p50: z.number().nullable(),
  p75: z.number().nullable(),
  mean: z.number().nullable(),
});
const m2Side = z.object({
  baseline: minutesSide,
  phase1: minutesSide,
  delta: z.number().nullable(),
  repositories: count,
});
const m3Side = z.object({
  caught: count,
  wouldCatch: count,
  missed: count,
  denominator: count,
  share: ratio,
  wilson: interval,
  repositories: count,
});
const criterion = z.object({
  verdict,
  incidents: count,
  merged: count,
  per100: z.number().nullable(),
  pValue: z.number().nullable(),
});

const repository = z.object({
  fullName: z.string(),
  private: z.boolean(),
  modes: z.object({
    policy: z.object({ requested: z.string(), effective: z.string(), reason: z.string() }),
    guard: z.object({ requested: z.string(), effective: z.string(), reason: z.string() }),
    mcpWrite: z.object({ requested: z.string(), effective: z.string(), reason: z.string() }),
  }),
  enforceSince: z.object({ policy: z.string().nullable(), guard: z.string().nullable() }),
  merged: z.object({
    total: count,
    byMode: z.object({ enforce: count, report: count }),
    byClass: classCounts,
  }),
  wouldFailAtMerge: z.object({ total: count, byReason: z.record(z.string(), count) }),
  invalidOrMissingPolicy: count,
  mergedWhileFailing: count,
  incidentsOnAuto: count,
  last7: z.object({
    total: count,
    byClass: classCounts,
    wouldFailAtMerge: count,
    invalidOrMissingPolicy: count,
  }),
  breakGlassApplied: count,
  guard: guardCounts,
  needsHuman: count,
  mcpPrsOpened: count,
});
export type Phase1Repository = z.infer<typeof repository>;

export const phase1GateReportSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.literal(1),
  window: z.object({ since: z.string(), until: z.string(), days: z.number() }),
  installations: z.array(
    z.object({ id: z.number().int(), account: z.string(), repositories: count }),
  ),
  verdict,
  reasons: z.array(reason),
  preview: decision,
  metrics: z.object({
    m1: decision.extend({
      preview: decision,
      measured: m1Side,
      projected: m1Side,
      agent: z.object({ measured: share, projected: share }),
      classes: z.object({ enforce: classCounts, report: classCounts }),
      autoWithHumanApproval: count,
      mergedWhileFailing: count,
    }),
    m2: decision.extend({
      preview: decision,
      measured: m2Side,
      projected: m2Side,
      projectedZeros: count,
      pairedRepositories: count,
    }),
    m3: decision.extend({
      preview: decision,
      measured: m3Side,
      projected: m3Side,
      classes: z.object({ enforce: guardCounts, report: guardCounts }),
      missedBy: z.array(
        z.object({
          status: z.string(),
          outcome: z.string().nullable(),
          reason: z.string().nullable(),
          n: count,
        }),
      ),
      caughtBy: z.object({
        reverted: count,
        revertClosed: count,
        revertOpened: count,
        autoMergeEnabled: count,
      }),
    }),
    m4: decision.extend({
      preview: decision,
      lagDays: z.number().int(),
      mergedBefore: z.string(),
      all: criterion,
      auto: criterion,
      autoPreview: criterion,
      baseline: z.object({ incidents: count, merged: count, per100: z.number().nullable() }),
      unlinked: count,
    }),
  }),
  overrides: z.array(z.object({ kind: z.string(), policyMode: z.string(), n: count })),
  mcp: z.object({
    activeTokens: count,
    prsOpened: count,
    provenanceReports: count,
    disagreements: count,
  }),
  retention: z.object({ retained: count, of: count, target: count }),
  repositories: z.array(repository),
  runs: z.array(
    z.object({
      repository: z.string(),
      period: z.enum(["baseline", "phase1"]),
      fromDate: z.string(),
      toDate: z.string(),
      extractedAt: z.string(),
    }),
  ),
});
export type Phase1GateReport = z.infer<typeof phase1GateReportSchema>;

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

const VERDICT_TEXT: Record<Phase1Verdict, string> = {
  PASS: "PASS",
  FAIL: "FAIL",
  INSUFFICIENT_DATA: "INSUFFICIENT DATA",
};

const pct = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
const pct0 = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);
const signedPct = (x: number | null): string =>
  x === null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(Math.round(x * 100))}%`;
const num1 = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 10) / 10}`);
const wilsonText = (w: { lower: number; upper: number } | null): string =>
  w === null ? "" : `, Wilson ${pct0(w.lower)}–${pct0(w.upper)}`;

function reasonText(r: Phase1Reason): string {
  if (r.value === null) return r.code;
  if (r.required === null) return `${r.code} (${num1(r.value)})`;
  return `${r.code} (${num1(r.value)} of ${num1(r.required)})`;
}

function reasonsText(reasons: readonly Phase1Reason[]): string {
  return reasons.length === 0 ? "" : ` — ${reasons.map(reasonText).join("; ")}`;
}

function criterionText(c: z.infer<typeof criterion>): string {
  const p = c.pValue === null ? "" : ` (p ${c.pValue.toFixed(2)})`;
  return `${num1(c.per100)} per 100${p}`;
}

/** §10: the gate verdict, the preview line, the metrics table, the details and the per-repo table. */
export function renderPhase1Markdown(r: Phase1GateReport): string {
  const { m1, m2, m3, m4 } = r.metrics;
  const lines: string[] = [];
  lines.push(`# Graft Phase 1 gate — ${r.window.since} to ${r.window.until}`, "");
  lines.push(`**Verdict: ${VERDICT_TEXT[r.verdict]}**${reasonsText(r.reasons)}`);
  lines.push(
    `**Preview (projected from report mode): ${VERDICT_TEXT[r.preview.verdict]}** (never decides the gate)`,
    "",
  );
  const insts = r.installations
    .map((i) => `${i.id} (${i.account}, ${i.repositories} repos)`)
    .join(", ");
  lines.push(
    `Installations: ${insts}. Data until ${r.window.until} (exclusive). Retained ${r.retention.retained} of ${r.retention.of} (target ${r.retention.target} of 5; not part of the verdict).`,
    "",
  );
  lines.push("| Metric | Target | Measured (enforce) | Projected (all) | Verdict |");
  lines.push("| --- | --- | --- | --- | --- |");
  lines.push(
    `| M1 merged with no human | ≥ 30% | ${pct(m1.measured.share)} (n ${m1.measured.n}${wilsonText(m1.measured.wilson)}) | ${pct(m1.projected.share)} (n ${m1.projected.n}) | ${VERDICT_TEXT[m1.verdict]} |`,
  );
  lines.push(
    `| M2 agent review minutes p50 | ≤ −50% | ${num1(m2.measured.baseline.p50)} → ${num1(m2.measured.phase1.p50)} min, ${signedPct(m2.measured.delta)} (n ${m2.measured.baseline.n} / ${m2.measured.phase1.n}) | ${signedPct(m2.projected.delta)} (n ${m2.projected.baseline.n} / ${m2.projected.phase1.n}) | ${VERDICT_TEXT[m2.verdict]} |`,
  );
  lines.push(
    `| M3 breakages caught | ≥ 80% | ${m3.measured.caught} of ${m3.measured.denominator}, ${pct0(m3.measured.share)}${wilsonText(m3.measured.wilson)} | ${m3.projected.caught + m3.projected.wouldCatch} of ${m3.projected.denominator}, ${pct0(m3.projected.share)} | ${VERDICT_TEXT[m3.verdict]} |`,
  );
  lines.push(
    `| M4 escaped defects | no rise | all ${criterionText(m4.all)}; auto ${criterionText(m4.auto)}; baseline ${num1(m4.baseline.per100)} per 100 | auto ${criterionText(m4.autoPreview)} (not a projection) | ${VERDICT_TEXT[m4.verdict]} |`,
  );
  lines.push("");

  lines.push("## M1 detail", "");
  const classLine = (c: Record<string, number>) =>
    Object.entries(c)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  lines.push(`- Enforce: ${classLine(m1.classes.enforce)}`);
  lines.push(`- Report: ${classLine(m1.classes.report)}`);
  lines.push(
    `- Agent PRs: measured ${pct(m1.agent.measured.share)} (n ${m1.agent.measured.n}), projected ${pct(m1.agent.projected.share)} (n ${m1.agent.projected.n})`,
  );
  lines.push(
    `- Auto with a human approval anyway: ${m1.autoWithHumanApproval}. Merged while Graft's check failed or was pending (enforce): ${m1.mergedWhileFailing}`,
  );
  lines.push(`- Preview: ${VERDICT_TEXT[m1.preview.verdict]}${reasonsText(m1.preview.reasons)}`);
  lines.push("");

  lines.push("## M2 detail", "");
  const side = (s: z.infer<typeof minutesSide>) =>
    `n ${s.n}, p50 ${num1(s.p50)}, p75 ${num1(s.p75)}, mean ${num1(s.mean)} min`;
  lines.push(`- Measured baseline: ${side(m2.measured.baseline)}`);
  lines.push(`- Measured Phase 1: ${side(m2.measured.phase1)} (${m2.measured.repositories} repos)`);
  lines.push(`- Projected baseline: ${side(m2.projected.baseline)}`);
  lines.push(
    `- Projected Phase 1: ${side(m2.projected.phase1)}; ${m2.projectedZeros} rows set to 0 (report mode, class auto)`,
  );
  lines.push(`- Paired repositories: ${m2.pairedRepositories}`);
  lines.push(`- Preview: ${VERDICT_TEXT[m2.preview.verdict]}${reasonsText(m2.preview.reasons)}`);
  lines.push("");

  lines.push("## M3 detail", "");
  lines.push(`- Enforce: ${classLine(m3.classes.enforce)}`);
  lines.push(`- Report: ${classLine(m3.classes.report)}`);
  const flakyU = m3.classes.enforce.flaky_unconfirmed + m3.classes.report.flaky_unconfirmed;
  lines.push(`- Flaky (unconfirmed): ${flakyU}, not counted as a flake nor as a breakage`);
  if (m3.missedBy.length > 0) {
    lines.push(
      `- Missed: ${m3.missedBy
        .map(
          (m) =>
            `${m.status}${m.outcome ? ` ${m.outcome}` : ""}${m.reason ? ` ${m.reason}` : ""} ${m.n}`,
        )
        .join(", ")}`,
    );
  }
  lines.push(
    `- Caught: reverted ${m3.caughtBy.reverted}, revert closed ${m3.caughtBy.revertClosed}, still open ${m3.caughtBy.revertOpened}; auto-merge enabled ${m3.caughtBy.autoMergeEnabled}`,
  );
  lines.push("- The denominator holds only breakages the guard detected.");
  lines.push(`- Preview: ${VERDICT_TEXT[m3.preview.verdict]}${reasonsText(m3.preview.reasons)}`);
  lines.push("");

  lines.push("## M4 detail", "");
  lines.push(
    `- PRs merged before ${m4.mergedBefore} (${m4.lagDays}-day lag). All: ${m4.all.incidents} incidents over ${m4.all.merged} PRs, ${VERDICT_TEXT[m4.all.verdict]}. Auto (enforce): ${m4.auto.incidents} over ${m4.auto.merged}, ${VERDICT_TEXT[m4.auto.verdict]}.`,
  );
  lines.push(
    `- Baseline: ${m4.baseline.incidents} incidents over ${m4.baseline.merged} PRs. Unlinked incidents: ${m4.unlinked}.`,
  );
  lines.push(
    `- Preview, auto in every mode: ${m4.autoPreview.incidents} over ${m4.autoPreview.merged}, ${VERDICT_TEXT[m4.autoPreview.verdict]}. Not a projection: report-mode PRs were reviewed by people.`,
  );
  lines.push("");

  lines.push("## Reported, not decided", "");
  lines.push(
    `- Overrides: ${r.overrides.length === 0 ? "none" : r.overrides.map((o) => `${o.kind} (${o.policyMode}) ${o.n}`).join(", ")}`,
  );
  lines.push(
    `- MCP: ${r.mcp.activeTokens} active tokens, ${r.mcp.prsOpened} PRs opened, ${r.mcp.provenanceReports} provenance reports, ${r.mcp.disagreements} disagreeing`,
  );
  lines.push("");

  lines.push("## Per repository", "");
  lines.push(
    "| Repository | Policy | Guard | Merged (enforce / report) | Would fail at merge | Invalid or missing policy | Last 7 days | Break-glass | Guard caught / missed | MCP PRs | Private |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const p of r.repositories) {
    const mode = (m: { effective: string }, since: string | null) =>
      `${m.effective}${since ? ` since ${since}` : ""}`;
    lines.push(
      `| ${p.fullName} | ${mode(p.modes.policy, p.enforceSince.policy)} | ${mode(p.modes.guard, p.enforceSince.guard)} | ${p.merged.total} (${p.merged.byMode.enforce} / ${p.merged.byMode.report}) | ${p.wouldFailAtMerge.total} of ${p.merged.total} | ${p.invalidOrMissingPolicy} | ${p.last7.total} merged, ${p.last7.wouldFailAtMerge} would fail, ${p.last7.invalidOrMissingPolicy} invalid | ${p.breakGlassApplied} | ${p.guard.caught} / ${p.guard.missed} | ${p.mcpPrsOpened} | ${p.private ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  if (r.runs.length > 0) {
    lines.push("## Review-time runs", "");
    for (const run of r.runs) {
      lines.push(
        `- ${run.repository} ${run.period}: ${run.fromDate} to ${run.toDate}, extracted ${run.extractedAt}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
}
