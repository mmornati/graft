/** Report building, baseline diff, threshold check and markdown (T14, §6.5, §6.6). Ids and numbers only (E8). */
import { z } from "zod";
import type { CaseRow, EvalReport, Metrics, ThresholdResult } from "./report-schema.js";

// ---------------------------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------------------------

export const thresholdsSchema = z.strictObject({
  synthetic: z.record(z.string(), z.unknown()),
  pilot: z.record(z.string(), z.unknown()),
});
export type Thresholds = z.infer<typeof thresholdsSchema>;

/** Largest allowed worsening is checked in the direction that is worse for the metric. */
const HIGHER_IS_BETTER =
  /^(exactAccuracy|trivialRecall|outOfScope(Precision|Recall|ExactRate)|flag(Precision|Recall)|injectionDetection|cardAcceptableRate)/;

export function metricValue(m: Metrics, name: string): number | null {
  const v = (m as unknown as Record<string, unknown>)[name];
  if (v === null) return null;
  if (typeof v !== "number")
    throw new Error(`threshold names an unknown or non-numeric metric: ${name}`);
  return v;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function checkThresholds(
  r: EvalReport,
  t: Thresholds,
  diff: BaselineDiff | null,
): ThresholdResult[] {
  const block = r.set.kind === "synthetic" ? t.synthetic : t.pilot;
  const provisional = block.provisional === true;
  const out: ThresholdResult[] = [];
  const push = (name: string, value: number | null, limit: string, pass: boolean) =>
    out.push({ name, value, limit, pass, provisional });
  for (const [name, spec] of Object.entries(block)) {
    if (name === "provisional") continue;
    if (name === "matchBaseline") {
      if (spec !== true) continue;
      if (diff === null) push(name, null, "equal to baseline (no baseline)", true);
      else push(name, diff.equal ? 1 : 0, "equal to baseline", diff.comparable && diff.equal);
      continue;
    }
    if (name === "regressionVsBaseline") {
      if (!isObject(spec)) continue;
      for (const [metric, allowed] of Object.entries(spec)) {
        const label = `regression ${metric}`;
        if (typeof allowed !== "number") continue;
        if (diff === null || !diff.comparable) {
          push(label, null, `worsening <= ${allowed} (no comparable baseline)`, true);
          continue;
        }
        const cur = metricValue(r.metrics, metric);
        const base = diff.baselineMetrics ? metricValue(diff.baselineMetrics, metric) : null;
        if (cur === null || base === null) {
          push(label, null, `worsening <= ${allowed}`, true);
          continue;
        }
        const worse = HIGHER_IS_BETTER.test(metric) ? base - cur : cur - base;
        push(
          label,
          Math.round(worse * 1e4) / 1e4,
          `worsening <= ${allowed}`,
          worse <= allowed + 1e-9,
        );
      }
      continue;
    }
    if (!isObject(spec)) continue;
    const value = metricValue(r.metrics, name);
    const max = typeof spec.max === "number" ? spec.max : undefined;
    const min = typeof spec.min === "number" ? spec.min : undefined;
    const limit = [max !== undefined ? `max ${max}` : "", min !== undefined ? `min ${min}` : ""]
      .filter(Boolean)
      .join(", ");
    if (value === null) {
      push(name, null, limit, true);
      continue;
    }
    push(
      name,
      value,
      limit,
      (max === undefined || value <= max) && (min === undefined || value >= min),
    );
  }
  return out;
}

/** A failing, non-provisional result, or any failure with `strict`. */
export function thresholdsFailed(results: readonly ThresholdResult[], strict: boolean): boolean {
  return results.some((x) => !x.pass && (!x.provisional || strict));
}

// ---------------------------------------------------------------------------------------------
// Baseline diff
// ---------------------------------------------------------------------------------------------

export interface BaselineDiff {
  /** Same case set and models and mode: the two reports measure the same thing. */
  comparable: boolean;
  notComparable: string[];
  warnings: string[];
  /** Everything but run identity and derived threshold fields is equal. */
  equal: boolean;
  metricChanges: {
    name: string;
    baseline: number | null;
    current: number | null;
    delta: number | null;
  }[];
  changedCases: { id: string; field: string; baseline: string; current: string }[];
  addedCases: string[];
  removedCases: string[];
  baselineMetrics: Metrics | null;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The comparable part of a report: run identity and derived fields removed. */
function comparable(r: EvalReport): unknown {
  const { runId: _r, createdAt: _c, git: _g, thresholds: _t, pass: _p, ...rest } = r;
  const { durationMs: _d, cachedResults: _cr, ...run } = rest.run;
  // The cost of this run (not of the cases) is 0 for a run served from the cache.
  const { costUsdThisRun: _cost, ...metrics } = rest.metrics;
  return {
    ...rest,
    metrics,
    run,
    cases: rest.cases.map(({ cached: _cached, ...row }) => row),
  };
}

const ROW_FIELDS: (keyof CaseRow)[] = [
  "tags",
  "gold",
  "floor",
  "model",
  "final",
  "status",
  "failureReason",
  "verifierStatus",
  "raisedBy",
  "floorRules",
  "instructionsInData",
  "oos",
  "flag",
  "usage",
  "costUsd",
  "skipped",
];

export function diffReports(baseline: EvalReport, current: EvalReport): BaselineDiff {
  const notComparable: string[] = [];
  if (baseline.set.caseSetHash !== current.set.caseSetHash) notComparable.push("case set differs");
  if (stable(baseline.models) !== stable(current.models)) notComparable.push("models differ");
  if (baseline.llm !== current.llm) notComparable.push("run mode differs");
  const warnings: string[] = [];
  if (
    baseline.prompt.promptFingerprint !== current.prompt.promptFingerprint &&
    baseline.prompt.promptVersion === current.prompt.promptVersion
  ) {
    warnings.push("prompt or schema text changed without a PROMPT_VERSION bump");
  }
  if (baseline.prompt.promptVersion !== current.prompt.promptVersion) {
    warnings.push("PROMPT_VERSION differs from the baseline");
  }

  const metricChanges: BaselineDiff["metricChanges"] = [];
  const bm = baseline.metrics as unknown as Record<string, unknown>;
  const cm = current.metrics as unknown as Record<string, unknown>;
  for (const name of Object.keys(cm)) {
    if (name === "costUsdThisRun") continue; // run identity: 0 when served from the cache
    const a = bm[name];
    const b = cm[name];
    if (
      (typeof b === "number" || b === null) &&
      (typeof a === "number" || a === null || a === undefined)
    ) {
      const x = a ?? null;
      if (x !== b) {
        metricChanges.push({
          name,
          baseline: x,
          current: b,
          delta: x === null || b === null ? null : Math.round((b - x) * 1e6) / 1e6,
        });
      }
    }
  }

  const baseRows = new Map(baseline.cases.map((c) => [c.id, c]));
  const curRows = new Map(current.cases.map((c) => [c.id, c]));
  const changedCases: BaselineDiff["changedCases"] = [];
  for (const [id, row] of curRows) {
    const was = baseRows.get(id);
    if (!was) continue;
    for (const f of ROW_FIELDS) {
      if (stable(was[f]) !== stable(row[f])) {
        changedCases.push({ id, field: f, baseline: stable(was[f]), current: stable(row[f]) });
      }
    }
  }
  changedCases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.field < b.field ? -1 : 1));

  return {
    comparable: notComparable.length === 0,
    notComparable,
    warnings,
    equal: stable(comparable(baseline)) === stable(comparable(current)),
    metricChanges,
    changedCases,
    addedCases: [...curRows.keys()].filter((id) => !baseRows.has(id)).sort(),
    removedCases: [...baseRows.keys()].filter((id) => !curRows.has(id)).sort(),
    baselineMetrics: baseline.metrics,
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

const fmt = (v: number | null | undefined): string =>
  v === null || v === undefined ? "n/a" : String(v);

const HEADLINE: [string, string][] = [
  ["underClassificationFinal", "Under-classification (final) - safety"],
  ["severeUnderClassificationFinal", "Severe under-classification (final)"],
  ["underClassificationFloor", "Under-classification (floor)"],
  ["underClassificationModel", "Under-classification (model)"],
  ["overClassificationFinal", "Over-classification (final)"],
  ["exactAccuracyFinal", "Exact accuracy (final)"],
  ["exactAccuracyFloor", "Exact accuracy (floor)"],
  ["exactAccuracyModel", "Exact accuracy (model)"],
  ["trivialRecall", "Trivial recall"],
  ["outOfScopePrecision", "Out-of-scope precision"],
  ["outOfScopeRecall", "Out-of-scope recall"],
  ["outOfScopeExactRate", "Out-of-scope exact-set rate"],
  ["flagPrecision", "Verifier flag precision"],
  ["flagRecall", "Verifier flag recall"],
  ["verifierErrorRate", "Verifier error rate"],
  ["unavailableRate", "Unavailable rate"],
  ["injectionDetection", "Injection detection"],
  ["cardAcceptableRate", "Card acceptable rate"],
  ["costUsd", "Cost (USD)"],
  ["costUsdThisRun", "Cost this run (USD)"],
];

export function renderMarkdown(r: EvalReport, diff: BaselineDiff | null): string {
  const L: string[] = [];
  const m = r.metrics;
  L.push(`# Eval report ${r.runId}`, "");
  L.push(
    `- set: ${r.set.setId} (${r.set.kind}); cases ${r.set.cases}, scored ${r.set.scored}, unlabeled ${r.set.unlabeled}, needs adjudication ${r.set.needsAdjudication}`,
    `- prompt: ${r.prompt.promptVersion} (${r.prompt.promptFingerprint.slice(0, 12)})`,
    `- models: fast ${r.models.fast}, strong ${r.models.strong}`,
    `- mode: ${r.llm}; complete: ${r.run.complete}; skipped (budget): ${r.run.skippedBudget}; cached results: ${r.run.cachedResults}`,
    `- case set hash: ${r.set.caseSetHash.slice(0, 12)}`,
    "",
    "## Metrics",
    "",
    "| Metric | Value | Baseline | Delta |",
    "| --- | --- | --- | --- |",
  );
  const bm = diff?.baselineMetrics as unknown as Record<string, unknown> | null | undefined;
  for (const [key, label] of HEADLINE) {
    const v = (m as unknown as Record<string, number | null>)[key] ?? null;
    const b = bm ? ((bm[key] as number | null | undefined) ?? null) : null;
    const delta = v !== null && b !== null ? Math.round((v - b) * 1e6) / 1e6 : null;
    L.push(`| ${label} | ${fmt(v)} | ${bm ? fmt(b) : "-"} | ${bm ? fmt(delta) : "-"} |`);
  }
  for (const which of ["floor", "model", "final"] as const) {
    const c = m.confusion[which];
    L.push("", `## Confusion matrix: ${which} (rows gold, columns predicted; n = ${c.n})`, "");
    L.push(
      "| gold \\ predicted | trivial | logic | sensitive | recall |",
      "| --- | --- | --- | --- | --- |",
    );
    ["trivial", "logic", "sensitive"].forEach((name, i) => {
      const row = c.counts[i] as number[];
      L.push(`| ${name} | ${row[0]} | ${row[1]} | ${row[2]} | ${fmt(c.recall[i])} |`);
    });
    L.push(`| precision | ${c.precision.map(fmt).join(" | ")} | |`);
  }
  L.push(
    "",
    "## Under-classification per tag",
    "",
    "| Tag | n | floor | model | final |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const [tag, v] of Object.entries(m.byTag)) {
    L.push(
      `| ${tag} | ${v.n} | ${fmt(v.underClassificationFloor)} | ${fmt(v.underClassificationModel)} | ${fmt(v.underClassificationFinal)} |`,
    );
  }
  L.push("", "## Thresholds", "");
  if (r.thresholds.length === 0) L.push("(none)");
  for (const t of r.thresholds) {
    const status =
      t.value === null ? "n/a" : t.pass ? "pass" : t.provisional ? "FAIL (provisional)" : "FAIL";
    L.push(`- ${t.name}: ${fmt(t.value)} (${t.limit}) ${status}`);
  }
  L.push("", "## Changed cases", "");
  if (!diff) L.push("(no baseline)");
  else {
    for (const reason of diff.notComparable) L.push(`- NOT COMPARABLE: ${reason}`);
    for (const w of diff.warnings) L.push(`- warning: ${w}`);
    if (
      diff.changedCases.length === 0 &&
      diff.addedCases.length === 0 &&
      diff.removedCases.length === 0
    ) {
      L.push("(none)");
    }
    for (const c of diff.changedCases)
      L.push(`- ${c.id}: ${c.field} ${c.baseline} -> ${c.current}`);
    for (const id of diff.addedCases) L.push(`- ${id}: added`);
    for (const id of diff.removedCases) L.push(`- ${id}: removed`);
  }
  L.push("");
  return L.join("\n");
}
