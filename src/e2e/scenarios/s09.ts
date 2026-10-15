/** s09: a push to main that edits graft.yaml re-evaluates every open run PR. */

import { POLICY_CHECK_NAME } from "../../modules/policy/index.js";
import { RUN_PRS_KEY } from "../executor.js";
import { changeRow, graftChecks, type PrObs } from "../observe.js";
import type { Step, StepCtx } from "../plan.js";
import type { AssertionResult } from "../report-schema.js";
import { TIMEOUTS } from "../waiters.js";
import {
  assertion,
  awaitDeliveryStep,
  collectPr,
  countDeliveriesStep,
  type EvalEnv,
  eq,
  type PlanContext,
  type ScenarioDef,
  truthy,
} from "./common.js";
import { envOfCtx } from "./env.js";

export interface PerPr {
  number: number;
  outcome: string | null;
  title: string;
  policyCommitSha: string | null;
  policyHash: string | null;
}

export interface S09Obs {
  p1: string;
  p2: string;
  restoreSkipped: boolean;
  mid: PerPr[];
  end: PerPr[];
  mainIsStarter: boolean;
  h0: string | null;
  prs1and7: number[];
  pr1: number | null;
}

/** Open run PRs: the numbers the executor recorded, whose pull request is still open. */
export async function openRunPrs(sx: StepCtx): Promise<number[]> {
  const numbers = sx.scope.get<number[]>(RUN_PRS_KEY) ?? [];
  const open: number[] = [];
  for (const n of numbers) {
    const { data } = await sx.run.actorOctokit.rest.pulls.get({
      owner: sx.run.owner,
      repo: sx.run.repo,
      pull_number: n,
    });
    if (data.state === "open") open.push(n);
  }
  return open;
}

async function perPr(sx: StepCtx, numbers: number[]): Promise<PerPr[]> {
  const out: PerPr[] = [];
  for (const n of numbers) {
    const ch = await changeRow(sx.run, n);
    if (!ch) {
      out.push({ number: n, outcome: null, title: "", policyCommitSha: null, policyHash: null });
      continue;
    }
    const v = await sx.run.db
      .selectFrom("policy_verdicts")
      .select(["head_sha", "outcome", "policy_commit_sha", "policy_hash"])
      .where("change_id", "=", ch.id)
      .where("head_sha", "=", ch.head_sha)
      .orderBy("evaluated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const checks = await graftChecks(sx.run, ch.head_sha);
    out.push({
      number: n,
      outcome: v?.outcome ?? null,
      title: checks.find((c) => c.name === POLICY_CHECK_NAME)?.title ?? "",
      policyCommitSha: v?.policy_commit_sha ?? null,
      policyHash: v?.policy_hash ?? null,
    });
  }
  return out;
}

export function evaluateS09(o: S09Obs, env: EvalEnv): AssertionResult[] {
  const out: AssertionResult[] = [];
  out.push(
    assertion(
      "system",
      "s09.mid.sha",
      "every open run PR has a verdict at the first push",
      o.mid.map((p) => p.policyCommitSha === o.p1),
      o.mid.length > 0 && o.mid.every((p) => p.policyCommitSha === o.p1),
    ),
  );
  for (const n of o.prs1and7) {
    const p = o.mid.find((x) => x.number === n);
    out.push(
      assertion(
        "system",
        `s09.mid.require2.pr${n}`,
        { outcome: "would_require", title: "Would require 2 humans..." },
        { outcome: p?.outcome, title: p?.title },
        p?.outcome === "would_require" && (p?.title ?? "").startsWith("Would require 2 humans"),
      ),
    );
  }
  out.push(
    assertion(
      "system",
      "s09.end.sha",
      "every open run PR has a verdict at the restore commit, with the original policy hash",
      o.end.map((p) => ({
        sha: p.policyCommitSha === o.p2,
        hash: o.h0 !== null && p.policyHash === o.h0,
      })),
      o.end.length > 0 &&
        o.end.every((p) => p.policyCommitSha === o.p2 && o.h0 !== null && p.policyHash === o.h0),
    ),
    truthy("system", "s09.main.restored", "main:graft.yaml equals the starter", o.mainIsStarter),
  );
  if (o.pr1 !== null) {
    const p = o.end.find((x) => x.number === o.pr1);
    if (env.mode === "live") {
      out.push(eq("model", "s09.end.pr1", "would_approve", p?.outcome ?? null));
    } else {
      out.push(
        assertion(
          "system",
          "s09.end.pr1",
          "would_require, 1 human",
          { outcome: p?.outcome, title: p?.title },
          p?.outcome === "would_require" && (p?.title ?? "").startsWith("Would require 1 human"),
        ),
      );
    }
  }
  return out;
}

function reevalWait(
  id: string,
  shaKey: string,
  opts: { titles2: boolean; always?: boolean },
): Step {
  return {
    kind: "wait",
    id,
    name: "reeval",
    timeoutMs: TIMEOUTS.reeval,
    describe: `every open run PR has a verdict at ${shaKey}`,
    ...(opts.always ? { always: true } : {}),
    probe: async (sx) => {
      const push = sx.scope.require<{ sha: string; skipped?: boolean }>(shaKey);
      if (push.skipped) return true;
      const open = await openRunPrs(sx);
      const rows = await perPr(sx, open);
      sx.note(rows.map((r) => ({ n: r.number, atSha: r.policyCommitSha === push.sha })));
      const pr1 = sx.scope.get<{ number: number }>("s01.pr")?.number;
      const pr7 = sx.scope.get<{ number: number }>("s07.pr")?.number;
      return !!(
        open.length > 0 &&
        rows.every((r) => {
          if (r.policyCommitSha !== push.sha) return false;
          if (opts.titles2 && (r.number === pr1 || r.number === pr7)) {
            return r.title.startsWith("Would require 2 humans");
          }
          return true;
        })
      );
    },
  };
}

export const s09: ScenarioDef = {
  id: "s09",
  title: "Policy push re-evaluates open PRs",
  needs: ["s01", "s07"],
  modelRuns: 0,
  plan(_pc: PlanContext): Step[] {
    return [
      countDeliveriesStep("s09.before", "s09.pushBefore", "push"),
      {
        kind: "act",
        id: "s09.push1",
        key: "s09.p1",
        act: {
          act: "pushMain",
          fixture: "graft.s09.yaml",
          message: "Require two humans for docs (graft-e2e)",
        },
      },
      awaitDeliveryStep("s09.push1.delivery", "s09.pushBefore", "push"),
      reevalWait("s09.push1.reeval", "s09.p1", { titles2: true }),
      {
        kind: "observe",
        id: "s09.mid",
        key: "s09.midObs",
        collect: async (sx) => perPr(sx, await openRunPrs(sx)),
      },
      countDeliveriesStep("s09.before2", "s09.pushBefore2", "push"),
      {
        kind: "act",
        id: "s09.push2",
        key: "s09.p2",
        always: true,
        act: {
          act: "pushMain",
          fixture: "graft.yaml",
          message: "Restore the starter policy (graft-e2e)",
          skipIfSame: true,
        },
      },
      {
        ...awaitDeliveryStep("s09.push2.delivery", "s09.pushBefore2", "push"),
        always: true,
      } as Step,
      reevalWait("s09.push2.reeval", "s09.p2", { titles2: false, always: true }),
      {
        kind: "observe",
        id: "s09.end",
        key: "s09.endObs",
        collect: async (sx) => perPr(sx, await openRunPrs(sx)),
      },
      {
        kind: "observe",
        id: "s09.main",
        key: "s09.mainIsStarter",
        collect: async (sx) => {
          const { data } = await sx.run.actorOctokit.rest.repos.getContent({
            owner: sx.run.owner,
            repo: sx.run.repo,
            path: "graft.yaml",
            ref: sx.run.sandbox.defaultBranch,
          });
          const text =
            !Array.isArray(data) && data.type === "file" && "content" in data
              ? Buffer.from(data.content, "base64").toString("utf8")
              : "";
          return text === sx.run.fixtures.get("graft.yaml");
        },
      },
      {
        kind: "assert",
        id: "s09.assert",
        evaluate: (sx) => {
          const pr1 = sx.scope.get<{ number: number }>("s01.pr")?.number ?? null;
          const pr7 = sx.scope.get<{ number: number }>("s07.pr")?.number ?? null;
          return evaluateS09(
            {
              p1: sx.scope.require<{ sha: string }>("s09.p1").sha,
              p2: sx.scope.require<{ sha: string }>("s09.p2").sha,
              restoreSkipped: sx.scope.require<{ skipped?: boolean }>("s09.p2").skipped === true,
              mid: sx.scope.require<PerPr[]>("s09.midObs"),
              end: sx.scope.require<PerPr[]>("s09.endObs"),
              mainIsStarter: sx.scope.require<boolean>("s09.mainIsStarter"),
              h0: sx.scope.get<string>("run.h0") ?? null,
              prs1and7: [pr1, pr7].filter((n): n is number => n !== null),
              pr1,
            },
            envOfCtx(sx.run),
          );
        },
      },
    ];
  },
};

export type { PrObs };
export { collectPr };
