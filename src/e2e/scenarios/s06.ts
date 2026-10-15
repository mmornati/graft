/** s06: a second commit on PR 1 refreshes the same comment. */
import { GUIDE } from "../fixtures.js";
import type { PrObs } from "../observe.js";
import type { Step } from "../plan.js";
import type { AssertionResult } from "../report-schema.js";
import {
  agentMessage,
  assertion,
  awaitDeliveryStep,
  branchOf,
  changesOf,
  collectPr,
  commitAct,
  countDeliveriesStep,
  type EvalEnv,
  eq,
  oneComment,
  type PlanContext,
  policyTitle,
  type ScenarioDef,
  settleStep,
  threeNeutral,
} from "./common.js";
import { envOfCtx } from "./env.js";

export interface S06Obs {
  pr: PrObs;
  /** PR 1 as s01 saw it. */
  before: PrObs;
  newHead: string;
}

export function evaluateS06(o: S06Obs, env: EvalEnv): AssertionResult[] {
  const { pr, before } = o;
  const advanced =
    pr.comment.updatedAt !== null &&
    before.comment.updatedAt !== null &&
    Date.parse(pr.comment.updatedAt) > Date.parse(before.comment.updatedAt);
  const title = policyTitle(pr);
  const out: AssertionResult[] = [
    eq("system", "s06.head", o.newHead, pr.change?.headSha ?? null),
    assertion(
      "system",
      "s06.card.row",
      "a card row and a display for the new head",
      { cards: pr.cardRowsForHead, displays: pr.displaysForHead },
      pr.cardRowsForHead >= 1 && pr.displaysForHead >= 1,
    ),
    assertion(
      "system",
      "s06.comment.same",
      "same comment id as s01 (changes.graft_comment_id unchanged)",
      { id: pr.comment.id, stored: pr.change?.graftCommentId ?? null, s01: before.comment.id },
      pr.comment.id !== null &&
        pr.comment.id === before.comment.id &&
        pr.change?.graftCommentId === before.change?.graftCommentId,
    ),
    assertion("system", "s06.comment.updated", "updated_at advanced", { advanced }, advanced),
    ...oneComment("s06", pr),
    threeNeutral("s06.neutral", pr),
    eq(
      "system",
      "s06.commits",
      { total: 2, withTrailers: 2 },
      {
        total: pr.provenance?.commitsTotal,
        withTrailers: pr.provenance?.commitsWithTrailers,
      },
    ),
  ];
  if (env.mode === "live") {
    out.push(
      eq("model", "s06.risk", "trivial", pr.card?.riskClass ?? null),
      eq("model", "s06.outcome", "would_approve", pr.verdict?.outcome ?? null),
    );
  } else {
    out.push(
      eq("system", "s06.card.unavailable", "unavailable", pr.card?.status ?? null),
      assertion(
        "system",
        "s06.outcome",
        "would_require, 1 human",
        { outcome: pr.verdict?.outcome, title },
        pr.verdict?.outcome === "would_require" && title.startsWith("Would require 1 human"),
      ),
    );
  }
  return out;
}

export const s06: ScenarioDef = {
  id: "s06",
  title: "Second commit on PR 1",
  needs: ["s01"],
  modelRuns: 1,
  plan(pc: PlanContext): Step[] {
    const branch = branchOf(pc.runId, "s01");
    const sentinels = pc.sentinelsOf("s01");
    return [
      countDeliveriesStep("s06.before", "s06.pushBefore", "push"),
      commitAct("s06.commit", "s06.c1", {
        client: "actor",
        branch,
        from: "branch",
        message: agentMessage({ ...pc, sentinels }, "Fix another typo in the guide"),
        changes: [changesOf(GUIDE, [{ op: "replace", from: "untill", to: "until" }])],
      }),
      awaitDeliveryStep("s06.push", "s06.pushBefore", "push"),
      settleStep("s06.settle", "s01.pr", "s06.c1"),
      {
        kind: "observe",
        id: "s06.observe",
        key: "s06.obs",
        collect: async (sx) => {
          const pr = await collectPr(sx, "s01.pr");
          return {
            pr,
            before: sx.scope.require<{ pr: PrObs }>("s01.obs").pr,
            newHead: sx.scope.require<{ sha: string }>("s06.c1").sha,
          } satisfies S06Obs;
        },
      },
      {
        kind: "assert",
        id: "s06.assert",
        evaluate: (sx) => evaluateS06(sx.scope.require<S06Obs>("s06.obs"), envOfCtx(sx.run)),
      },
    ];
  },
};
