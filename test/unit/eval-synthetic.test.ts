import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type EvalCase, evalCaseSchema } from "../../src/eval/case-schema.js";
import { runEval } from "../../src/eval/harness.js";
import { redactInputs } from "../../src/eval/redact.js";
import {
  checkThresholds,
  diffReports,
  thresholdsFailed,
  thresholdsSchema,
} from "../../src/eval/report.js";
import { type EvalReport, evalReportSchema } from "../../src/eval/report-schema.js";
import { openSet } from "../../src/eval/store.js";
import { REPO_ROOT } from "../helpers/eval-fixtures.js";

const dir = join(REPO_ROOT, "eval/synthetic/cases");
const files = readdirSync(dir)
  .filter((n) => n.endsWith(".case.json"))
  .sort();
const cases = files.map((n) =>
  evalCaseSchema.parse(JSON.parse(readFileSync(join(dir, n), "utf8"))),
);

const ALL_RULES = [
  "ci_config",
  "policy_file",
  "dependency_manifest",
  "infra",
  "auth_secrets",
  "migration",
  "configured_path",
  "test_deleted",
  "test_shrunk",
  "binary",
  "size_large",
  "size_huge",
  "partial_view",
  "listing_truncated",
  "injection_marker",
];

/** §9, encoded: floor, final, and the rules the floor must report. */
const TABLE: Record<string, [floor: string, final: string, rules: string[]]> = {
  "001": ["trivial", "trivial", []],
  "002": ["trivial", "trivial", []],
  "003": ["trivial", "logic", []],
  "004": ["sensitive", "sensitive", ["ci_config"]],
  "005": ["sensitive", "sensitive", ["policy_file"]],
  "006": ["sensitive", "sensitive", ["dependency_manifest"]],
  "007": ["sensitive", "sensitive", ["dependency_manifest"]],
  "008": ["sensitive", "sensitive", ["infra"]],
  "009": ["sensitive", "sensitive", ["auth_secrets"]],
  "010": ["sensitive", "sensitive", ["migration"]],
  "011": ["sensitive", "sensitive", ["configured_path"]],
  "012": ["sensitive", "sensitive", ["test_deleted"]],
  "013": ["logic", "logic", ["test_shrunk"]],
  "014": ["logic", "logic", ["binary"]],
  "015": ["logic", "logic", ["size_large"]],
  "016": ["sensitive", "sensitive", ["listing_truncated", "size_huge"]],
  "017": ["logic", "logic", ["partial_view", "size_large"]],
  "018": ["sensitive", "sensitive", ["listing_truncated", "size_huge"]],
  "019": ["logic", "logic", ["injection_marker"]],
  "020": ["logic", "logic", ["injection_marker"]],
  "021": ["logic", "logic", ["injection_marker"]],
  "022": ["trivial", "logic", []],
  "023": ["trivial", "logic", []],
  "024": ["sensitive", "sensitive", ["auth_secrets"]],
  "025": ["sensitive", "sensitive", ["test_deleted"]],
  "026": ["trivial", "sensitive", []],
  "027": ["trivial", "logic", []],
  "028": ["trivial", "logic", []],
  "029": ["logic", "logic", ["partial_view"]],
  "030": ["trivial", "logic", []],
};

async function syntheticRun(): Promise<EvalReport> {
  const set = await openSet(join(REPO_ROOT, "eval/synthetic"), { key: null });
  const out = await runEval({
    set,
    mode: "fake",
    models: { fast: "claude-haiku-5-5", strong: "claude-sonnet-5-5" },
    timeoutMs: 120_000,
    concurrency: 8,
    maxCostUsd: 10,
    maxTokens: 5_000_000,
    useCache: false,
    confirm: async () => false,
    now: () => new Date("2026-10-15T10:00:00Z"),
    nowMs: () => 0,
  });
  if (out.aborted) throw new Error("aborted");
  return out.report;
}

describe("synthetic set", () => {
  it("U-SYN-1 thirty cases with ids syn-001 to syn-030, matching file names, one label set by graft-synthetic", () => {
    expect(cases).toHaveLength(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(30);
    cases.forEach((c, i) => {
      expect(c.id.startsWith(`syn-${String(i + 1).padStart(3, "0")}-`)).toBe(true);
      expect(files[i]).toBe(`${c.id}.case.json`);
      expect(c.source.kind).toBe("synthetic");
      expect(c.labels.map((l) => [l.labeler, l.guideVersion])).toEqual([
        ["graft-synthetic", "lg-1"],
      ]);
      expect(c.inputs.pr.number).toBe(101 + i);
    });
  });

  it("U-SYN-2 no synthetic case matches a secret pattern", () => {
    for (const c of cases) {
      const { redactions } = redactInputs(c.inputs, { emails: false });
      expect(redactions, c.id).toEqual([]);
    }
  });

  it("U-SYN-3 the repository is fictional-org/shop-demo everywhere", () => {
    for (const c of cases) expect(c.inputs.repositoryFullName).toBe("fictional-org/shop-demo");
  });

  it("U-SYN-4 a case whose script has no failure yields status ok and a verifier that did not error", async () => {
    const report = await syntheticRun();
    let checked = 0;
    for (const c of cases) {
      if (JSON.stringify(c.fakeLlm).includes('"failure"') || c.inputs.tooLarge) continue;
      const r = report.cases.find((x) => x.id === c.id);
      expect(r?.status, c.id).toBe("ok");
      expect(r?.verifierStatus, c.id).not.toBe("error");
      checked++;
    }
    expect(checked).toBe(27);
  });

  it("U-SYN-5 the union of floor rules covers all 15 rule ids", async () => {
    const report = await syntheticRun();
    const seen = new Set(report.cases.flatMap((c) => c.floorRules));
    expect([...seen].sort()).toEqual([...ALL_RULES].sort());
  });

  it("U-SYN-6 each case's floor, final and rules equal the table of the spec", async () => {
    const report = await syntheticRun();
    for (const r of report.cases) {
      const key = r.id.slice(4, 7);
      const want = TABLE[key];
      expect(want, r.id).toBeDefined();
      expect([r.floor, r.final], r.id).toEqual([want?.[0], want?.[1]]);
      for (const rule of want?.[2] ?? []) expect(r.floorRules, r.id).toContain(rule);
      if ((want?.[2] ?? []).length === 0) expect(r.floorRules, r.id).toEqual([]);
    }
    const byId = (n: string) => report.cases.find((c) => c.id.startsWith(`syn-${n}-`));
    expect(byId("016")).toMatchObject({ status: "unavailable", failureReason: "too_large" });
    expect(byId("027")).toMatchObject({ status: "unavailable", failureReason: "llm_unavailable" });
    expect(byId("028")).toMatchObject({ status: "ok", verifierStatus: "error" });
    expect(byId("022")).toMatchObject({ flag: "tp", oos: { tp: 1, fp: 0, fn: 0 } });
    expect(byId("023")).toMatchObject({ flag: "tn", oos: { tp: 1, fp: 0, fn: 0 } });
    expect(byId("026")).toMatchObject({ flag: "tp", verifierStatus: "disagree" });
  });

  it("E-SYN-1 the synthetic run equals the committed baseline and every synthetic threshold passes", async () => {
    const report = await syntheticRun();
    const baseline = evalReportSchema.parse(
      JSON.parse(readFileSync(join(REPO_ROOT, "eval/baselines/synthetic.json"), "utf8")),
    );
    const diff = diffReports(baseline, report);
    expect(diff.changedCases).toEqual([]);
    expect(diff.equal).toBe(true);
    const thresholds = thresholdsSchema.parse(
      JSON.parse(readFileSync(join(REPO_ROOT, "eval/thresholds.json"), "utf8")),
    );
    const results = checkThresholds(report, thresholds, diff);
    expect(results.map((x) => x.name)).toEqual([
      "underClassificationFinal",
      "severeUnderClassificationFinal",
      "unavailableRate",
      "matchBaseline",
    ]);
    expect(results.every((x) => x.pass)).toBe(true);
    expect(thresholdsFailed(results, true)).toBe(false);
    expect(report.metrics.underClassificationFinal).toBe(0);
  });

  it("E-SYN-2 the run reproduces the headline values of the spec exactly", async () => {
    const { metrics: m } = await syntheticRun();
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    expect(m.underClassificationFinal).toBe(0);
    expect(m.severeUnderClassificationFinal).toBe(0);
    expect(m.underClassificationFloor).toBe(r4(6 / 30));
    expect(m.severeUnderClassificationFloor).toBe(r4(1 / 30));
    expect(m.exactAccuracyFinal).toBe(r4(28 / 30));
    expect([m.outOfScopePrecision, m.outOfScopeRecall]).toEqual([1, 1]);
    expect([m.flagPrecision, m.flagRecall]).toEqual([1, 1]);
    expect(m.unavailableRate).toBe(r4(2 / 30));
    expect(m.scored).toBe(30);
    expect(m.unavailableByReason).toEqual({ llm_unavailable: 1, too_large: 1 });
  });

  it("every case is also valid after a round trip through the schema", () => {
    for (const c of cases as EvalCase[])
      expect(evalCaseSchema.parse(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });
});
