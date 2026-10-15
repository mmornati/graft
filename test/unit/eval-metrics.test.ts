import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caseSetHash } from "../../src/eval/case-schema.js";
import { rowFromResult } from "../../src/eval/harness.js";
import { computeMetrics } from "../../src/eval/metrics.js";
import { cost, priceFor } from "../../src/eval/pricing.js";
import {
  checkThresholds,
  diffReports,
  renderMarkdown,
  type Thresholds,
  thresholdsFailed,
} from "../../src/eval/report.js";
import { type EvalReport, evalReportSchema } from "../../src/eval/report-schema.js";
import type { CardResult } from "../../src/modules/intent/index.js";
import { cardInputs, cf, labelSet, REPO_ROOT, row, synCase } from "../helpers/eval-fixtures.js";

const g = (risk: "trivial" | "logic" | "sensitive", shouldFlag = false) => ({
  risk,
  shouldFlag,
  outOfScopeCount: 0,
});

describe("eval pricing", () => {
  it("U-PRICE-1 cost for 1M of each counter on Sonnet is 2 + 10 + 0.20 + 2.50", () => {
    const m = 1_000_000;
    const c = cost(
      { inputTokens: m, outputTokens: m, cacheReadTokens: m, cacheWriteTokens: m },
      "claude-sonnet-5-5",
    );
    expect(c).toBeCloseTo(2 + 10 + 0.2 + 2.5, 9);
    expect(
      cost(
        { inputTokens: m, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        "claude-haiku-5-5",
      ),
    ).toBeCloseTo(0.1, 9);
  });

  it("U-PRICE-2 a dated model id is priced as its family; an unknown model has no price", () => {
    expect(priceFor("claude-sonnet-5-5-20260901")).toEqual(priceFor("claude-sonnet-5-5"));
    expect(priceFor("claude-sonnet-5-50")).toBeNull();
    expect(priceFor("claude-unknown-1")).toBeNull();
    expect(
      cost(
        { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        "claude-unknown-1",
      ),
    ).toBeNull();
  });
});

describe("eval metrics", () => {
  const six = [
    row({ id: "r1", gold: g("trivial"), floor: "trivial", model: "trivial", final: "trivial" }),
    row({ id: "r2", gold: g("logic"), floor: "trivial", model: "logic", final: "logic" }),
    row({
      id: "r3",
      gold: g("logic"),
      floor: "logic",
      model: null,
      final: "logic",
      status: "unavailable",
      failureReason: "llm_unavailable",
      flag: "na",
      verifierStatus: "skipped",
    }),
    row({ id: "r4", gold: g("sensitive"), floor: "trivial", model: "trivial", final: "sensitive" }),
    row({ id: "r5", gold: g("sensitive"), floor: "sensitive", model: "logic", final: "sensitive" }),
    row({ id: "r6", gold: g("trivial"), floor: "logic", model: "trivial", final: "logic" }),
  ];

  it("U-MET-1 UC, SUC, OC and ACC on a six-row fixture for floor, model and final", () => {
    const m = computeMetrics(six);
    expect([
      m.underClassificationFloor,
      m.severeUnderClassificationFloor,
      m.overClassificationFloor,
      m.exactAccuracyFloor,
    ]).toEqual([0.3333, 0.1667, 0.1667, 0.5]);
    expect([
      m.underClassificationModel,
      m.severeUnderClassificationModel,
      m.overClassificationModel,
      m.exactAccuracyModel,
    ]).toEqual([0.4, 0.2, 0, 0.6]);
    expect([
      m.underClassificationFinal,
      m.severeUnderClassificationFinal,
      m.overClassificationFinal,
      m.exactAccuracyFinal,
    ]).toEqual([0, 0, 0.1667, 0.8333]);
    expect(m.trivialRecall).toBe(0.5);
    expect(m.scored).toBe(6);
  });

  it("U-MET-2 a row without a model risk leaves S_M but stays in S_R", () => {
    const m = computeMetrics(six);
    expect(m.confusion.model.n).toBe(5);
    expect(m.confusion.final.n).toBe(6);
    expect(m.confusion.floor.n).toBe(6);
  });

  it("U-MET-3 confusion matrix with per-class precision and recall; an empty column gives null", () => {
    const m = computeMetrics(six);
    expect(m.confusion.final.counts).toEqual([
      [1, 1, 0],
      [0, 2, 0],
      [0, 0, 2],
    ]);
    expect(m.confusion.final.precision).toEqual([1, 0.6667, 1]);
    expect(m.confusion.final.recall).toEqual([0.5, 1, 1]);
    // the model never said sensitive: that column has no precision
    expect(m.confusion.model.precision[2]).toBeNull();
    expect(m.byTag).toEqual({});
  });

  it("U-MET-4 out-of-scope micro precision and recall over ok rows only", () => {
    const m = computeMetrics([
      row({ id: "a", oos: { tp: 2, fp: 0, fn: 0 } }),
      row({ id: "b", oos: { tp: 1, fp: 1, fn: 2 } }),
      row({ id: "c", oos: { tp: 0, fp: 0, fn: 0 } }),
      row({
        id: "d",
        status: "unavailable",
        failureReason: "llm_timeout",
        oos: { tp: 9, fp: 9, fn: 9 },
        flag: "na",
      }),
    ]);
    expect(m.outOfScopePrecision).toBe(0.75);
    expect(m.outOfScopeRecall).toBe(0.6);
    expect(m.outOfScopeExactRate).toBe(0.6667);
  });

  it("U-MET-4 the verifier's unexplained files count as predicted out-of-scope files in a row", () => {
    const result = {
      status: "ok",
      failureReason: null,
      card: {
        goal: "g",
        behaviorChanges: ["b"],
        outOfScopeEdits: [{ path: "src/a.ts", reason: "r" }],
      },
      risk: {
        final: "logic",
        floor: "trivial",
        floorReasons: [],
        writer: "logic",
        firstPass: null,
        verifier: "logic",
        raisedBy: [],
      },
      verifier: {
        status: "agree",
        claims: [],
        missing: [],
        unexplained: ["src/b.ts"],
        failure: null,
      },
      instructionsInData: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2 },
    } as unknown as CardResult;
    const c = synCase("syn-901-a", {
      inputs: cardInputs([cf("src/a.ts"), cf("src/b.ts"), cf("src/c.ts")]),
      labels: [
        labelSet({
          labeler: "graft-synthetic",
          risk: "logic",
          outOfScope: ["src/a.ts", "src/b.ts"],
        }),
      ],
    });
    const r = rowFromResult(c, c.labels[0] ?? null, result, { costUsd: 0, cached: false });
    expect(r.oos).toEqual({ tp: 2, fp: 0, fn: 0 });
    expect(r.flag).toBe("tn");
    expect(r.model).toBe("logic");
    // a path the card lists that the gold does not is a false positive
    const withExtra = {
      ...result,
      verifier: { ...result.verifier, unexplained: ["src/c.ts"] },
    } as CardResult;
    expect(
      rowFromResult(c, c.labels[0] ?? null, withExtra, { costUsd: 0, cached: false }).oos,
    ).toEqual({ tp: 1, fp: 1, fn: 1 });
  });

  it("U-MET-5 flag metrics count tp, fp, fn and tn and leave out na rows", () => {
    const m = computeMetrics([
      row({ id: "a", flag: "tp" }),
      row({ id: "b", flag: "tp" }),
      row({ id: "c", flag: "fp" }),
      row({ id: "d", flag: "fn" }),
      row({ id: "e", flag: "tn" }),
      row({ id: "f", flag: "na", verifierStatus: "error" }),
    ]);
    expect(m.flagCounts).toEqual({ tp: 2, fp: 1, fn: 1, tn: 1 });
    expect(m.flagPrecision).toBe(0.6667);
    expect(m.flagRecall).toBe(0.6667);
    expect(m.verifierErrorRate).toBe(0.1667);
  });

  it("U-MET-6 the unavailable rate counts cases without a gold label and excludes skipped ones", () => {
    const m = computeMetrics([
      row({ id: "a" }),
      row({ id: "b" }),
      row({ id: "c", gold: null, status: "unavailable", failureReason: "too_large", flag: "na" }),
      row({ id: "d", gold: null }),
      row({ id: "e", skipped: "budget", status: "skipped" }),
    ]);
    expect(m.runCases).toBe(4);
    expect(m.unavailableRate).toBe(0.25);
    expect(m.unavailableByReason).toEqual({ too_large: 1 });
    expect(m.scored).toBe(2);
  });

  it("U-MET-7 injection detection over cases tagged injection", () => {
    const m = computeMetrics([
      row({ id: "a", tags: ["injection"], floorRules: ["injection_marker"] }),
      row({ id: "b", tags: ["injection"], instructionsInData: true }),
      row({ id: "c", tags: ["injection"] }),
      row({ id: "d", tags: ["docs"] }),
    ]);
    expect(m.injectionDetection).toBe(0.6667);
    expect(computeMetrics([row({ tags: ["docs"] })]).injectionDetection).toBeNull();
  });

  it("U-MET-8 cardAcceptableRate needs the right class, the right out-of-scope set and a correct flag", () => {
    const m = computeMetrics([
      row({ id: "a" }),
      row({ id: "b", final: "sensitive" }),
      row({ id: "c", oos: { tp: 0, fp: 1, fn: 0 } }),
      row({ id: "d", flag: "fn" }),
      row({ id: "e", flag: "na", verifierStatus: "error" }),
      row({ id: "f", flag: "tp", gold: g("logic", true) }),
    ]);
    expect(m.cardAcceptableRate).toBe(0.5);
  });

  it("U-MET-9 empty input gives null rates and zero counts", () => {
    const m = computeMetrics([]);
    expect(m.scored).toBe(0);
    expect(m.runCases).toBe(0);
    for (const k of [
      "underClassificationFinal",
      "exactAccuracyFloor",
      "outOfScopePrecision",
      "flagRecall",
      "unavailableRate",
      "cardAcceptableRate",
      "trivialRecall",
      "injectionDetection",
    ] as const) {
      expect(m[k]).toBeNull();
    }
    expect(m.tokens.calls).toBe(0);
    expect(m.costPerCaseUsd).toBeNull();
  });

  it("per-tag under-classification and token sums", () => {
    const m = computeMetrics([
      row({ id: "a", tags: ["x"], gold: g("sensitive"), final: "logic" }),
      row({ id: "b", tags: ["x"] }),
      row({ id: "c", tags: ["y"] }),
    ]);
    expect(m.byTag.x).toMatchObject({ n: 2, underClassificationFinal: 0.5 });
    expect(m.byTag.y).toMatchObject({ n: 1, underClassificationFinal: 0 });
    expect(m.tokens).toEqual({
      inputTokens: 3000,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 6,
    });
    expect(m.costUsd).toBe(0.009);
    expect(m.costPerCaseUsd).toBe(0.003);
  });

  it("U-MET-10 caseSetHash changes when a gold risk changes, not when a goal text or a tag changes", () => {
    const base = synCase("syn-901-a");
    const h = caseSetHash([base]);
    expect(
      caseSetHash([
        { ...base, labels: [labelSet({ labeler: "graft-synthetic", goal: "another goal" })] },
      ]),
    ).toBe(h);
    expect(caseSetHash([{ ...base, tags: ["new-tag"] }])).toBe(h);
    expect(
      caseSetHash([{ ...base, labels: [labelSet({ labeler: "graft-synthetic", risk: "logic" })] }]),
    ).not.toBe(h);
    expect(caseSetHash([{ ...base, labels: [] }])).not.toBe(h);
  });
});

describe("eval report", () => {
  const baseline = (): EvalReport =>
    evalReportSchema.parse(
      JSON.parse(readFileSync(join(REPO_ROOT, "eval/baselines/synthetic.json"), "utf8")),
    );
  const copy = <T>(v: T): T => structuredClone(v);

  it("U-RPT-1 reports that differ only in run identity are equal", () => {
    const a = baseline();
    const b = copy(a);
    b.runId = "other";
    b.createdAt = "2027-01-01T00:00:00Z";
    b.git = { commit: "abc", dirty: true };
    b.run.durationMs += 500;
    b.run.cachedResults = 3;
    b.metrics.costUsdThisRun = 0; // a live re-run served from the cache
    a.metrics.costUsdThisRun = 1.25;
    b.thresholds = [];
    b.pass = false;
    const d = diffReports(a, b);
    expect(d.equal).toBe(true);
    expect(d.comparable).toBe(true);
    expect(d.changedCases).toEqual([]);
    expect(d.metricChanges).toEqual([]);
  });

  it("U-RPT-2 a changed final is listed and the matchBaseline threshold fails", () => {
    const a = baseline();
    const b = copy(a);
    const r = b.cases.find((c) => c.id === "syn-004-ci-workflow");
    if (!r) throw new Error("fixture");
    r.final = "logic";
    const d = diffReports(a, b);
    expect(d.equal).toBe(false);
    expect(d.changedCases).toEqual([
      { id: "syn-004-ci-workflow", field: "final", baseline: '"sensitive"', current: '"logic"' },
    ]);
    const t: Thresholds = { synthetic: { matchBaseline: true }, pilot: {} };
    const res = checkThresholds(b, t, d);
    expect(res).toEqual([
      {
        name: "matchBaseline",
        value: 0,
        limit: "equal to baseline",
        pass: false,
        provisional: false,
      },
    ]);
    expect(thresholdsFailed(res, false)).toBe(true);
  });

  it("U-RPT-3 another case set or other models are not comparable; a fingerprint change without a version bump warns", () => {
    const a = baseline();
    const b = copy(a);
    b.set.caseSetHash = "f".repeat(64);
    b.models.strong = "claude-sonnet-9-9";
    const d = diffReports(a, b);
    expect(d.comparable).toBe(false);
    expect(d.notComparable).toEqual(["case set differs", "models differ"]);
    const c = copy(a);
    c.prompt.promptFingerprint = "0".repeat(64);
    const dc = diffReports(a, c);
    expect(dc.comparable).toBe(true);
    expect(dc.warnings).toEqual(["prompt or schema text changed without a PROMPT_VERSION bump"]);
    expect(dc.equal).toBe(false);
  });

  it("U-RPT-4 checkThresholds: max and min, null passes as n/a, regression against the baseline, provisional pilot", () => {
    const a = baseline();
    const pilot = (over: Partial<EvalReport["metrics"]>): EvalReport => {
      const r = copy(a);
      r.set.kind = "pilot";
      r.metrics = { ...r.metrics, ...over };
      return r;
    };
    const t: Thresholds = {
      synthetic: {},
      pilot: {
        underClassificationFinal: { max: 0.02 },
        exactAccuracyFinal: { min: 0.75 },
        outOfScopeRecall: { min: 0.6 },
        regressionVsBaseline: { underClassificationFinal: 0, exactAccuracyFinal: 0.05 },
        provisional: true,
      },
    };
    const base = pilot({
      underClassificationFinal: 0,
      exactAccuracyFinal: 0.9,
      outOfScopeRecall: 1,
    });
    const cur = pilot({
      underClassificationFinal: 0.03,
      exactAccuracyFinal: 0.8,
      outOfScopeRecall: null,
    });
    const d = diffReports(base, cur);
    const res = checkThresholds(cur, t, d);
    const by = Object.fromEntries(res.map((x) => [x.name, x]));
    expect(by.underClassificationFinal).toMatchObject({
      value: 0.03,
      pass: false,
      provisional: true,
      limit: "max 0.02",
    });
    expect(by.exactAccuracyFinal).toMatchObject({ value: 0.8, pass: true });
    expect(by.outOfScopeRecall).toMatchObject({ value: null, pass: true });
    expect(by["regression underClassificationFinal"]).toMatchObject({ value: 0.03, pass: false });
    expect(by["regression exactAccuracyFinal"]).toMatchObject({ value: 0.1, pass: false });
    // provisional failures are not fatal without --strict
    expect(thresholdsFailed(res, false)).toBe(false);
    expect(thresholdsFailed(res, true)).toBe(true);
    // without a baseline the regression checks are n/a
    expect(
      checkThresholds(cur, t, null)
        .filter((x) => x.name.startsWith("regression"))
        .every((x) => x.value === null && x.pass),
    ).toBe(true);
    // a non-provisional block fails for real
    const hard = checkThresholds(
      cur,
      { synthetic: {}, pilot: { underClassificationFinal: { max: 0.02 } } },
      null,
    );
    expect(thresholdsFailed(hard, false)).toBe(true);
  });

  it("U-RPT-5 the markdown has the metric table and the changed-case ids, and no paths or titles", () => {
    const a = baseline();
    const b = copy(a);
    const r = b.cases.find((c) => c.id === "syn-009-auth-session");
    if (!r) throw new Error("fixture");
    r.final = "logic";
    b.metrics = computeMetrics(b.cases);
    const md = renderMarkdown(b, diffReports(a, b));
    expect(md).toContain("| Under-classification (final) - safety |");
    expect(md).toContain("## Confusion matrix: final");
    expect(md).toContain("syn-009-auth-session: final");
    const cases = [
      "src/pricing/discount.ts",
      "Round discounts down",
      "Fix typo in README",
      "Extend session lifetime",
      ".github/workflows/ci.yml",
    ];
    for (const s of cases) expect(md).not.toContain(s);
    expect(renderMarkdown(a, null)).toContain("(no baseline)");
  });
});
