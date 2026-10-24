import { describe, expect, it } from "vitest";
import {
  combine,
  decideCriterion,
  decideM1,
  decideM2,
  decideM3,
  decideM4,
  decidePhase1,
  guardClass,
  type M1Input,
  m3Ratio,
  mergedClass,
  type Phase1Inputs,
  projectedMinutes,
  reviewMinutes,
} from "../../src/pilot/gate-phase1.js";
import {
  type Phase1GateReport,
  phase1GateReportSchema,
  renderPhase1Markdown,
} from "../../src/pilot/gate-phase1-render.js";
import { binomialUpperTail } from "../../src/pilot/stats.js";

const codes = (d: { reasons: { code: string }[] }) => d.reasons.map((x) => x.code);

const m1 = (n: number, x: number, inst: number[], spanDays = 20): M1Input => ({
  n,
  x,
  installations: inst.map((k, i) => ({ id: i + 1, n: k })),
  spanDays,
});

describe("Phase 1 gate: classes (§8.1, §8.3, §8.4)", () => {
  it("U-P1G-1 the class of every enforced_reason, a null reason and no verdict", () => {
    const table: [string | null | undefined, string][] = [
      ["approved_by_policy", "auto"],
      ["requirements_met", "human"],
      ["break_glass", "break_glass"],
      ["no_policy", "would_fail"],
      ["policy_invalid", "would_fail"],
      ["blocked", "would_fail"],
      ["reviews_truncated", "would_fail"],
      ["changes_requested", "would_fail"],
      ["approvals_missing", "would_fail"],
      ["card_pending", "pending"],
      [null, "no_verdict"],
      [undefined, "no_verdict"],
    ];
    for (const [reason, cls] of table) expect(mergedClass(reason), String(reason)).toBe(cls);
  });

  it("U-P1G-5 review minutes: merged without review 0, first approval, else minutes to merge; the projection zeroes a report auto row only", () => {
    expect(
      reviewMinutes({
        merged_without_review: true,
        minutes_to_first_approval: 5,
        minutes_to_merge: 9,
      }),
    ).toBe(0);
    expect(
      reviewMinutes({
        merged_without_review: false,
        minutes_to_first_approval: 5,
        minutes_to_merge: 9,
      }),
    ).toBe(5);
    expect(
      reviewMinutes({
        merged_without_review: false,
        minutes_to_first_approval: null,
        minutes_to_merge: 9,
      }),
    ).toBe(9);
    expect(projectedMinutes(40, "report", "auto")).toBe(0);
    expect(projectedMinutes(40, "enforce", "auto")).toBe(40);
    expect(projectedMinutes(40, "report", "human")).toBe(40);
  });

  it("U-P1G-6 guard classes in order; flaky with a null reason is out of both terms; planned in enforce is missed in measured", () => {
    const g = (o: Partial<Parameters<typeof guardClass>[0]>) =>
      guardClass({
        status: "culprit_found",
        confirm_reason: "next_commit",
        revert_pr_number: null,
        revert_outcome: null,
        ...o,
      });
    expect(g({ status: "detected" })).toBe("open");
    expect(g({ status: "confirming" })).toBe("open");
    expect(g({ status: "culprit_found", revert_outcome: null })).toBe("open");
    expect(g({ status: "flaky", confirm_reason: "flaky_rerun" })).toBe("flaky");
    expect(g({ status: "flaky", confirm_reason: "flaky_next" })).toBe("flaky");
    expect(g({ status: "flaky", confirm_reason: null })).toBe("flaky_unconfirmed");
    expect(g({ status: "dismissed" })).toBe("dismissed");
    expect(g({ status: "revert_opened", revert_pr_number: 5, revert_outcome: "opened" })).toBe(
      "caught",
    );
    expect(g({ status: "revert_closed", revert_pr_number: 5, revert_outcome: "opened" })).toBe(
      "caught",
    );
    expect(g({ status: "reverted", revert_pr_number: 5, revert_outcome: "opened" })).toBe("caught");
    expect(g({ revert_outcome: "planned" })).toBe("would_catch");
    expect(g({ revert_outcome: "skipped" })).toBe("missed");
    expect(g({ revert_outcome: "error" })).toBe("missed");
    for (const status of ["ambiguous", "no_culprit", "needs_human", "error"]) {
      expect(g({ status }), status).toBe("missed");
    }
    // Out of both terms: flaky (unconfirmed), flaky, open, dismissed.
    expect(
      m3Ratio(["flaky_unconfirmed", "flaky", "open", "dismissed", "caught"], "measured"),
    ).toEqual({ numerator: 1, denominator: 1 });
    // `planned` in enforce: denominator only in measured; both terms in projected.
    expect(m3Ratio(["caught", "would_catch", "missed"], "measured")).toEqual({
      numerator: 1,
      denominator: 3,
    });
    expect(m3Ratio(["caught", "would_catch", "missed"], "projected")).toEqual({
      numerator: 2,
      denominator: 3,
    });
  });
});

describe("Phase 1 gate: decisions (§8.7)", () => {
  it("U-P1G-2 M1: PASS with the Wilson rule; 0.30 inconclusive; n 400 point estimate; an early FAIL needs 3 installations", () => {
    const pass = decideM1(m1(200, 68, [70, 70, 60]));
    expect(pass.verdict).toBe("PASS");
    expect(codes(pass)).toEqual(["pass"]);
    const flat = decideM1(m1(200, 60, [70, 70, 60]));
    expect(flat.verdict).toBe("INSUFFICIENT_DATA");
    expect(codes(flat)).toEqual(["m1_inconclusive"]);
    const point = decideM1(m1(400, 120, [140, 140, 120]));
    expect(point.verdict).toBe("PASS");
    expect(codes(point)).toEqual(["m1_point_estimate_decides"]);
    expect(decideM1(m1(400, 119, [140, 140, 120])).verdict).toBe("FAIL");
    const fail = decideM1(m1(60, 8, [20, 20, 20]));
    expect(fail.verdict).toBe("FAIL");
    expect(codes(fail)).toEqual(["m1_upper_below_target"]);
    const two = decideM1(m1(60, 8, [30, 30]));
    expect(two.verdict).toBe("INSUFFICIENT_DATA");
    expect(codes(two)).not.toContain("m1_upper_below_target");
  });

  it("U-P1G-3 M1 minimums: 199 rows, 2 installations, an installation with 19 rows, a 12-day span: one reason each", () => {
    expect(codes(decideM1(m1(199, 68, [70, 70, 59])))).toEqual(["m1_below_min_merged"]);
    expect(codes(decideM1(m1(200, 68, [100, 100])))).toEqual(["m1_below_min_installations"]);
    expect(codes(decideM1(m1(200, 68, [100, 81, 19])))).toEqual(["m1_below_min_installations"]);
    expect(codes(decideM1(m1(200, 68, [70, 70, 60], 12)))).toEqual(["m1_window_too_short"]);
    // 13 days of span is 14 days of data: enough.
    expect(decideM1(m1(200, 68, [70, 70, 60], 13)).verdict).toBe("PASS");
  });

  it("U-P1G-4 M2: Δ −0.50 PASS, −0.49 FAIL; 29 rows, one repository, a zero baseline p50: INSUFFICIENT DATA", () => {
    const rows = (n: number, v: number) => Array.from({ length: n }, () => v);
    expect(decideM2({ baseline: rows(30, 100), phase1: rows(30, 50), repositories: 2 })).toEqual({
      verdict: "PASS",
      reasons: [{ metric: "m2", code: "pass", value: -0.5, required: -0.5 }],
    });
    const fail = decideM2({ baseline: rows(30, 100), phase1: rows(30, 51), repositories: 2 });
    expect(fail.verdict).toBe("FAIL");
    expect(codes(fail)).toEqual(["m2_above_target"]);
    expect(
      codes(decideM2({ baseline: rows(30, 100), phase1: rows(29, 50), repositories: 2 })),
    ).toEqual(["m2_below_min_rows"]);
    expect(
      codes(decideM2({ baseline: rows(30, 100), phase1: rows(30, 50), repositories: 1 })),
    ).toEqual(["m2_below_min_repositories"]);
    expect(
      codes(decideM2({ baseline: rows(30, 0), phase1: rows(30, 50), repositories: 2 })),
    ).toEqual(["m2_baseline_zero"]);
  });

  it("U-P1G-7 M3: 8 of 10 PASS; 7 of 10 FAIL; 9 rows and one repository INSUFFICIENT DATA", () => {
    expect(decideM3({ numerator: 8, denominator: 10, repositories: 2 }).verdict).toBe("PASS");
    const fail = decideM3({ numerator: 7, denominator: 10, repositories: 2 });
    expect(fail.verdict).toBe("FAIL");
    expect(codes(fail)).toEqual(["m3_below_target"]);
    expect(codes(decideM3({ numerator: 9, denominator: 9, repositories: 2 }))).toEqual([
      "m3_below_min_breakages",
    ]);
    expect(codes(decideM3({ numerator: 10, denominator: 10, repositories: 1 }))).toEqual([
      "m3_below_min_repositories",
    ]);
  });

  it("U-P1G-8 binomialUpperTail pinned values; M4 criteria (a) and (b)", () => {
    expect(binomialUpperTail(0, 0, 0.5)).toBe(1);
    expect(Math.abs(binomialUpperTail(3, 10, 0.5) - 0.9453125)).toBeLessThan(1e-12);
    expect(Math.abs(binomialUpperTail(12, 20, 0.3) - 0.005138161535121408)).toBeLessThan(1e-12);
    expect(Math.abs(binomialUpperTail(50, 500, 0.08) - 0.06218822244881943)).toBeLessThan(1e-12);
    expect(binomialUpperTail(11, 10, 0.5)).toBe(0);

    const base = { x: 4, n: 200 };
    const a = (x: number, n = 200) =>
      decideCriterion({ x, n }, base, { n: 100, code: "m4_below_min_window" });
    const rise = a(12);
    expect(rise.verdict).toBe("FAIL");
    expect(codes(rise)).toEqual(["m4_rise"]);
    expect(rise.pValue).toBeCloseTo(0.0384063720703125, 12);
    const noisy = a(8);
    expect(noisy.verdict).toBe("PASS");
    expect(noisy.pValue).toBeCloseTo(0.19384765625, 12);
    expect(a(2).verdict).toBe("PASS");
    expect(codes(a(1, 99))).toEqual(["m4_below_min_window"]);
    expect(
      codes(
        decideCriterion({ x: 1, n: 200 }, { x: 0, n: 99 }, { n: 100, code: "m4_below_min_window" }),
      ),
    ).toEqual(["m4_below_min_baseline"]);

    const m4 = decideM4({
      lagOk: true,
      all: { x: 2, n: 200 },
      auto: { x: 0, n: 49 },
      baseline: base,
    });
    expect(m4.all.verdict).toBe("PASS");
    expect(codes(m4.auto)).toEqual(["m4_below_min_auto"]);
    expect(m4.verdict).toBe("INSUFFICIENT_DATA");
    expect(
      decideM4({ lagOk: true, all: { x: 2, n: 200 }, auto: { x: 0, n: 50 }, baseline: base })
        .verdict,
    ).toBe("PASS");
    expect(
      decideM4({ lagOk: true, all: { x: 12, n: 200 }, auto: { x: 0, n: 49 }, baseline: base })
        .verdict,
    ).toBe("FAIL");
    expect(
      codes(
        decideM4({ lagOk: false, all: { x: 2, n: 200 }, auto: { x: 0, n: 50 }, baseline: base }),
      ),
    ).toEqual(["m4_defect_lag"]);
  });

  it("U-P1G-9 the gate: any FAIL fails, all PASS passes, otherwise INSUFFICIENT DATA; the preview never feeds the verdict", () => {
    const P = { verdict: "PASS" as const, reasons: [] };
    const F = { verdict: "FAIL" as const, reasons: [] };
    const I = { verdict: "INSUFFICIENT_DATA" as const, reasons: [] };
    expect(combine([P, F, I, P]).verdict).toBe("FAIL");
    expect(combine([P, P, P, P]).verdict).toBe("PASS");
    expect(combine([P, I, P, P]).verdict).toBe("INSUFFICIENT_DATA");

    // Every projected value passes, nothing is measured: the gate is INSUFFICIENT DATA, the
    // preview PASS.
    const rows = (n: number, v: number) => Array.from({ length: n }, () => v);
    const inputs: Phase1Inputs = {
      m1: { measured: m1(0, 0, [0, 0, 0], 0), projected: m1(200, 68, [70, 70, 60]) },
      m2: {
        measured: { baseline: [], phase1: [], repositories: 0 },
        projected: { baseline: rows(30, 100), phase1: rows(30, 40), repositories: 2 },
      },
      m3: {
        measured: { numerator: 0, denominator: 0, repositories: 0 },
        projected: { numerator: 9, denominator: 10, repositories: 2 },
      },
      m4: {
        measured: {
          lagOk: true,
          all: { x: 2, n: 200 },
          auto: { x: 0, n: 0 },
          baseline: { x: 4, n: 200 },
        },
        projected: {
          lagOk: true,
          all: { x: 2, n: 200 },
          auto: { x: 0, n: 60 },
          baseline: { x: 4, n: 200 },
        },
      },
    };
    const d = decidePhase1(inputs);
    expect(d.verdict).toBe("INSUFFICIENT_DATA");
    expect(d.preview.verdict).toBe("PASS");
    // A failing preview does not change the gate either.
    const worse = decidePhase1({
      ...inputs,
      m3: { ...inputs.m3, projected: { numerator: 1, denominator: 10, repositories: 2 } },
    });
    expect(worse.preview.verdict).toBe("FAIL");
    expect(worse.verdict).toBe("INSUFFICIENT_DATA");
  });
});

const zeroClasses = {
  auto: 0,
  human: 0,
  break_glass: 0,
  would_fail: 0,
  pending: 0,
  no_verdict: 0,
};
const zeroGuard = {
  open: 0,
  flaky: 0,
  flaky_unconfirmed: 0,
  dismissed: 0,
  caught: 0,
  would_catch: 0,
  missed: 0,
};
const ins = { verdict: "INSUFFICIENT_DATA" as const, reasons: [] };
const minutes = { n: 0, p50: null, p75: null, mean: null };
const crit = {
  verdict: "INSUFFICIENT_DATA" as const,
  incidents: 0,
  merged: 0,
  per100: null,
  pValue: null,
};

/** A fixed report for the byte-for-byte rendering test. */
export const P1_REPORT: Phase1GateReport = {
  schemaVersion: 1,
  phase: 1,
  window: { since: "2026-12-01", until: "2027-01-26", days: 56 },
  installations: [{ id: 123, account: "acme", repositories: 2 }],
  verdict: "INSUFFICIENT_DATA",
  reasons: [{ metric: "m3", code: "m3_below_min_breakages", value: 6, required: 10 }],
  preview: { verdict: "PASS", reasons: [] },
  metrics: {
    m1: {
      verdict: "PASS",
      reasons: [{ metric: "m1", code: "m1_point_estimate_decides", value: 0.341, required: 0.3 }],
      preview: { verdict: "PASS", reasons: [] },
      measured: {
        n: 412,
        x: 140,
        share: 140 / 412,
        wilson: { lower: 0.297, upper: 0.388 },
        installations: [{ id: 123, n: 412 }],
        spanDays: 40,
      },
      projected: {
        n: 655,
        x: 236,
        share: 236 / 655,
        wilson: null,
        installations: [{ id: 123, n: 655 }],
        spanDays: 55,
      },
      agent: {
        measured: { n: 100, x: 50, share: 0.5, wilson: null },
        projected: { n: 150, x: 70, share: 70 / 150, wilson: null },
      },
      classes: {
        enforce: { ...zeroClasses, auto: 140, human: 272 },
        report: { ...zeroClasses, auto: 96, would_fail: 147 },
      },
      autoWithHumanApproval: 3,
      mergedWhileFailing: 0,
    },
    m2: {
      ...ins,
      preview: ins,
      measured: {
        baseline: { n: 140, p50: 212, p75: 300, mean: 250.5 },
        phase1: { n: 96, p50: 88, p75: 120, mean: 101 },
        delta: (88 - 212) / 212,
        repositories: 2,
      },
      projected: { baseline: minutes, phase1: minutes, delta: null, repositories: 0 },
      projectedZeros: 4,
      pairedRepositories: 2,
    },
    m3: {
      ...ins,
      preview: ins,
      measured: {
        caught: 5,
        wouldCatch: 0,
        missed: 1,
        denominator: 6,
        share: 5 / 6,
        wilson: { lower: 0.44, upper: 0.97 },
        repositories: 2,
      },
      projected: {
        caught: 5,
        wouldCatch: 4,
        missed: 2,
        denominator: 11,
        share: 9 / 11,
        wilson: null,
        repositories: 2,
      },
      classes: {
        enforce: { ...zeroGuard, caught: 5, missed: 1, flaky: 3 },
        report: { ...zeroGuard, would_catch: 4, missed: 1, flaky_unconfirmed: 2, open: 1 },
      },
      missedBy: [{ status: "needs_human", outcome: null, reason: null, n: 1 }],
      caughtBy: { reverted: 3, revertClosed: 1, revertOpened: 1, autoMergeEnabled: 0 },
    },
    m4: {
      ...ins,
      preview: ins,
      lagDays: 14,
      mergedBefore: "2027-01-12",
      all: { ...crit, verdict: "PASS", incidents: 3, merged: 330, per100: 0.909, pValue: 0.71 },
      auto: crit,
      autoPreview: crit,
      baseline: { incidents: 4, merged: 360, per100: 1.111 },
      unlinked: 1,
    },
  },
  overrides: [{ kind: "applied", policyMode: "enforce", n: 2 }],
  mcp: { activeTokens: 1, prsOpened: 2, provenanceReports: 3, disagreements: 0 },
  retention: { retained: 1, of: 1, target: 3 },
  repositories: [
    {
      fullName: "acme/api",
      private: true,
      modes: {
        policy: { requested: "enforce", effective: "enforce", reason: "repository" },
        guard: { requested: "report", effective: "report", reason: "repository" },
        mcpWrite: { requested: "off", effective: "off", reason: "repository" },
      },
      enforceSince: { policy: "2026-12-15", guard: null },
      merged: {
        total: 48,
        byMode: { enforce: 30, report: 18 },
        byClass: { ...zeroClasses, auto: 20, human: 26, would_fail: 2 },
      },
      wouldFailAtMerge: { total: 2, byReason: { approvals_missing: 2 } },
      invalidOrMissingPolicy: 0,
      mergedWhileFailing: 0,
      incidentsOnAuto: 0,
      last7: {
        total: 6,
        byClass: { ...zeroClasses, auto: 3, human: 3 },
        wouldFailAtMerge: 0,
        invalidOrMissingPolicy: 0,
      },
      breakGlassApplied: 2,
      guard: { ...zeroGuard, caught: 3, missed: 1 },
      needsHuman: 1,
      mcpPrsOpened: 2,
    },
  ],
  runs: [
    {
      repository: "acme/api",
      period: "baseline",
      fromDate: "2026-09-01",
      toDate: "2026-11-30",
      extractedAt: "2026-12-01T09:00:00.000Z",
    },
  ],
};

const P1_EXPECTED_MD = `# Graft Phase 1 gate — 2026-12-01 to 2027-01-26

**Verdict: INSUFFICIENT DATA** — m3_below_min_breakages (6 of 10)
**Preview (projected from report mode): PASS** (never decides the gate)

Installations: 123 (acme, 2 repos). Data until 2027-01-26 (exclusive). Retained 1 of 1 (target 3 of 5; not part of the verdict).

| Metric | Target | Measured (enforce) | Projected (all) | Verdict |
| --- | --- | --- | --- | --- |
| M1 merged with no human | ≥ 30% | 34.0% (n 412, Wilson 30%–39%) | 36.0% (n 655) | PASS |
| M2 agent review minutes p50 | ≤ −50% | 212 → 88 min, −58% (n 140 / 96) | — (n 0 / 0) | INSUFFICIENT DATA |
| M3 breakages caught | ≥ 80% | 5 of 6, 83%, Wilson 44%–97% | 9 of 11, 82% | INSUFFICIENT DATA |
| M4 escaped defects | no rise | all 0.9 per 100 (p 0.71); auto — per 100; baseline 1.1 per 100 | auto — per 100 (not a projection) | INSUFFICIENT DATA |

## M1 detail

- Enforce: auto 140, human 272, break_glass 0, would_fail 0, pending 0, no_verdict 0
- Report: auto 96, human 0, break_glass 0, would_fail 147, pending 0, no_verdict 0
- Agent PRs: measured 50.0% (n 100), projected 46.7% (n 150)
- Auto with a human approval anyway: 3. Merged while Graft's check failed or was pending (enforce): 0
- Preview: PASS

## M2 detail

- Measured baseline: n 140, p50 212, p75 300, mean 250.5 min
- Measured Phase 1: n 96, p50 88, p75 120, mean 101 min (2 repos)
- Projected baseline: n 0, p50 —, p75 —, mean — min
- Projected Phase 1: n 0, p50 —, p75 —, mean — min; 4 rows set to 0 (report mode, class auto)
- Paired repositories: 2
- Preview: INSUFFICIENT DATA

## M3 detail

- Enforce: open 0, flaky 3, flaky_unconfirmed 0, dismissed 0, caught 5, would_catch 0, missed 1
- Report: open 1, flaky 0, flaky_unconfirmed 2, dismissed 0, caught 0, would_catch 4, missed 1
- Flaky (unconfirmed): 2, not counted as a flake nor as a breakage
- Missed: needs_human 1
- Caught: reverted 3, revert closed 1, still open 1; auto-merge enabled 0
- The denominator holds only breakages the guard detected.
- Preview: INSUFFICIENT DATA

## M4 detail

- PRs merged before 2027-01-12 (14-day lag). All: 3 incidents over 330 PRs, PASS. Auto (enforce): 0 over 0, INSUFFICIENT DATA.
- Baseline: 4 incidents over 360 PRs. Unlinked incidents: 1.
- Preview, auto in every mode: 0 over 0, INSUFFICIENT DATA. Not a projection: report-mode PRs were reviewed by people.

## Reported, not decided

- Overrides: applied (enforce) 2
- MCP: 1 active tokens, 2 PRs opened, 3 provenance reports, 0 disagreeing

## Per repository

| Repository | Policy | Guard | Merged (enforce / report) | Would fail at merge | Invalid or missing policy | Last 7 days | Break-glass | Guard caught / missed | MCP PRs | Private |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| acme/api | enforce since 2026-12-15 | report | 48 (30 / 18) | 2 of 48 | 0 | 6 merged, 0 would fail, 0 invalid | 2 | 3 / 1 | 2 | yes |

## Review-time runs

- acme/api baseline: 2026-09-01 to 2026-11-30, extracted 2026-12-01T09:00:00.000Z
`;

describe("Phase 1 gate: the report", () => {
  it("U-P1G-10 the markdown is byte for byte stable; the JSON parses with phase1GateReportSchema", () => {
    expect(renderPhase1Markdown(P1_REPORT)).toBe(P1_EXPECTED_MD);
    const json = JSON.parse(JSON.stringify(P1_REPORT));
    expect(phase1GateReportSchema.safeParse(json).success).toBe(true);
    expect(phase1GateReportSchema.safeParse({ ...json, phase: 0 }).success).toBe(false);
    expect(phase1GateReportSchema.safeParse({ ...json, schemaVersion: 2 }).success).toBe(false);
    expect(
      phase1GateReportSchema.safeParse({ ...json, reasons: [{ metric: "m1", code: "nope" }] })
        .success,
    ).toBe(false);
  });
});
