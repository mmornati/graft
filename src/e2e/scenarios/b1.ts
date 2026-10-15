/** b1: `baseline --dry-run` on the sandbox writes nothing. */
import { sql } from "kysely";
import type { Step, StepCtx } from "../plan.js";
import type { AssertionResult } from "../report-schema.js";
import { assertion, type EvalEnv, type PlanContext, type ScenarioDef } from "./common.js";
import { plusDays } from "./s08.js";

export interface BaselineObs {
  code: number;
  firstLine: string;
  prCount: number | null;
  runPrs: number;
  runsBefore: number;
  runsAfter: number;
  /** b2 only: non-GET requests that targeted the source repository. */
  nonGetToSource?: number;
}

export function parseBaselineOut(out: string): { dryRun: boolean; prCount: number | null } {
  const dryRun = out.startsWith("dry run: nothing written");
  const m = /(\d+) PRs \(/.exec(out);
  return { dryRun, prCount: m ? Number(m[1]) : null };
}

export function evaluateB1(o: BaselineObs, _env: EvalEnv): AssertionResult[] {
  const parsed = parseBaselineOut(o.firstLine);
  return [
    assertion("system", "b1.exit", 0, o.code, o.code === 0),
    assertion("system", "b1.dry-run", "dry run: nothing written", parsed.dryRun, parsed.dryRun),
    assertion(
      "system",
      "b1.pr-count",
      `at least ${o.runPrs} PRs`,
      o.prCount,
      o.prCount !== null && o.prCount >= o.runPrs,
    ),
    assertion(
      "system",
      "b1.no-write",
      "review_time_runs unchanged",
      { before: o.runsBefore, after: o.runsAfter },
      o.runsBefore === o.runsAfter,
    ),
  ];
}

export async function reviewTimeRuns(sx: StepCtx): Promise<number> {
  const r = await sql<{ n: string }>`select count(*)::text as n from review_time_runs`.execute(
    sx.run.db,
  );
  return Number(r.rows[0]?.n ?? 0);
}

export const b1: ScenarioDef = {
  id: "b1",
  title: "Baseline dry run on the sandbox",
  needs: ["s07"],
  modelRuns: 0,
  plan(pc: PlanContext): Step[] {
    return [
      { kind: "observe", id: "b1.before", key: "b1.runsBefore", collect: reviewTimeRuns },
      {
        kind: "ops",
        id: "b1.baseline",
        key: "b1.ops",
        writes: false,
        argv: [
          "baseline",
          "--repo",
          `${pc.owner}/${pc.repo}`,
          "--from",
          plusDays(pc.day, -7),
          "--to",
          plusDays(pc.day, 1),
          "--dry-run",
          "--max-requests",
          "300",
        ],
      },
      { kind: "observe", id: "b1.after", key: "b1.runsAfter", collect: reviewTimeRuns },
      {
        kind: "assert",
        id: "b1.assert",
        evaluate: (sx) => {
          const ops = sx.scope.require<{ code: number; out: string }>("b1.ops");
          const parsed = parseBaselineOut(ops.out);
          return evaluateB1(
            {
              code: ops.code,
              firstLine: ops.out,
              prCount: parsed.prCount,
              runPrs: (sx.scope.get<number[]>("run.prs") ?? []).length,
              runsBefore: sx.scope.require<number>("b1.runsBefore"),
              runsAfter: sx.scope.require<number>("b1.runsAfter"),
            },
            { mode: "none" } as EvalEnv,
          );
        },
      },
    ];
  },
};
