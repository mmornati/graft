/** b2 (optional): `baseline --dry-run --auth token` on the public source repository. */
import { PROTECTED_REPOS } from "../guard.js";
import type { Step } from "../plan.js";
import type { AssertionResult } from "../report-schema.js";
import { type BaselineObs, parseBaselineOut, reviewTimeRuns } from "./b1.js";
import { assertion, type EvalEnv, type PlanContext, type ScenarioDef } from "./common.js";
import { plusDays } from "./s08.js";

export function evaluateB2(o: BaselineObs, _env: EvalEnv): AssertionResult[] {
  const parsed = parseBaselineOut(o.firstLine);
  return [
    assertion("system", "b2.exit", 0, o.code, o.code === 0),
    assertion("system", "b2.dry-run", "dry run: nothing written", parsed.dryRun, parsed.dryRun),
    assertion("system", "b2.get-only", 0, o.nonGetToSource ?? 0, (o.nonGetToSource ?? 0) === 0),
    assertion(
      "system",
      "b2.no-write",
      "review_time_runs unchanged",
      { before: o.runsBefore, after: o.runsAfter },
      o.runsBefore === o.runsAfter,
    ),
  ];
}

export const b2: ScenarioDef = {
  id: "b2",
  title: "Baseline dry run on the source (token)",
  needs: [],
  modelRuns: 0,
  plan(pc: PlanContext): Step[] {
    return [
      { kind: "observe", id: "b2.before", key: "b2.runsBefore", collect: reviewTimeRuns },
      {
        kind: "ops",
        id: "b2.baseline",
        key: "b2.ops",
        writes: false,
        baselineToken: true,
        argv: [
          "baseline",
          "--repo",
          PROTECTED_REPOS[0] as string,
          "--from",
          plusDays(pc.day, -84),
          "--to",
          pc.day,
          "--dry-run",
          "--auth",
          "token",
          "--max-requests",
          "500",
        ],
      },
      { kind: "observe", id: "b2.after", key: "b2.runsAfter", collect: reviewTimeRuns },
      {
        kind: "assert",
        id: "b2.assert",
        evaluate: (sx) => {
          const ops = sx.scope.require<{ code: number; out: string; nonGetToSource: number }>(
            "b2.ops",
          );
          return evaluateB2(
            {
              code: ops.code,
              firstLine: ops.out,
              prCount: parseBaselineOut(ops.out).prCount,
              runPrs: 0,
              runsBefore: sx.scope.require<number>("b2.runsBefore"),
              runsAfter: sx.scope.require<number>("b2.runsAfter"),
              nonGetToSource: ops.nonGetToSource,
            },
            { mode: "none" } as EvalEnv,
          );
        },
      },
    ];
  },
};
