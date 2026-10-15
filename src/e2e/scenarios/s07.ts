/** s07: a human PR (opened as a draft), reviews, then a rewritten history flips the author kind. */
import { agentTrailers, GUIDE } from "../fixtures.js";
import type { PrObs } from "../observe.js";
import { ref, type Step } from "../plan.js";
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
  diffLine,
  type EvalEnv,
  eq,
  humanMessage,
  oneComment,
  openPrAct,
  type PlanContext,
  policyTitle,
  prBody,
  provenanceTitle,
  prTitle,
  type ScenarioDef,
  settleStep,
  threeNeutral,
  truthy,
} from "./common.js";
import { envOfCtx } from "./env.js";

export interface S07Obs {
  a: PrObs;
  d: PrObs;
  e: PrObs;
  /** Spend rows of the change before and after step (e), and card rows for C1 before and after. */
  cache: {
    spendAfterD: number;
    spendAfterE: number;
    cardsForC1AfterA: number;
    cardsForC1AfterE: number;
  };
  /** Delivery counts that increased after (b) and (c). */
  deliveries: { readyForReview: boolean; reviewSubmitted: boolean };
}

export function evaluateS07(o: S07Obs, env: EvalEnv): AssertionResult[] {
  const { a, d, e } = o;
  const out: AssertionResult[] = [
    eq(
      "system",
      "s07.a.human",
      ["human", "none"],
      [a.provenance?.authorKind, a.provenance?.reason],
    ),
    eq("system", "s07.a.title", "Human-authored (no agent provenance)", provenanceTitle(a)),
    truthy(
      "system",
      "s07.a.no-trailers",
      "the section says no `Graft-*` trailers found",
      a.comment.flags.provenanceNoTrailers,
    ),
    truthy(
      "system",
      "s07.b.ready",
      "pull_request.ready_for_review delivered after markReady",
      o.deliveries.readyForReview,
    ),
    truthy(
      "system",
      "s07.c.review",
      "pull_request_review.submitted delivered after the review",
      o.deliveries.reviewSubmitted,
    ),
    eq(
      "system",
      "s07.d.agent",
      ["agent", "trailer"],
      [d.provenance?.authorKind, d.provenance?.reason],
    ),
    eq(
      "system",
      "s07.e.human",
      ["human", "none"],
      [e.provenance?.authorKind, e.provenance?.reason],
    ),
    assertion(
      "system",
      "s07.comment.same",
      "the same comment id throughout",
      [a.comment.id, d.comment.id, e.comment.id],
      a.comment.id !== null && a.comment.id === d.comment.id && d.comment.id === e.comment.id,
    ),
    ...oneComment("s07.a", a),
    ...oneComment("s07.e", e),
    threeNeutral("s07.e.neutral", e),
  ];
  const titleA = policyTitle(a);
  if (env.mode === "live") {
    out.push(
      eq("system", "s07.cache.cards", o.cache.cardsForC1AfterA, o.cache.cardsForC1AfterE),
      eq("system", "s07.cache.spend", o.cache.spendAfterD, o.cache.spendAfterE),
      eq("model", "s07.a.outcome", "would_approve", a.verdict?.outcome ?? null),
    );
  } else {
    out.push(
      assertion(
        "system",
        "s07.a.outcome",
        "would_require, 1 human",
        { outcome: a.verdict?.outcome, title: titleA },
        a.verdict?.outcome === "would_require" && titleA.startsWith("Would require 1 human"),
      ),
    );
  }
  return out;
}

export const s07: ScenarioDef = {
  id: "s07",
  title: "Human PR, draft, review and history rewrite",
  needs: [],
  modelRuns: 2,
  plan(pc: PlanContext): Step[] {
    const branch = branchOf(pc.runId, "s07");
    return [
      commitAct("s07.a.commit", "s07.c1", {
        client: "actor",
        branch,
        from: "main",
        message: humanMessage(pc, "Fix a spelling mistake"),
        changes: [
          changesOf(GUIDE, [
            { op: "replace", from: "definately", to: "definitely" },
            diffLine(GUIDE, pc),
          ]),
        ],
      }),
      openPrAct("s07.a.pr", "s07.pr", {
        client: "actor",
        head: branch,
        title: prTitle(pc, "s07", "Fix a spelling mistake"),
        body: prBody(pc, "Fix a spelling mistake in the guide."),
        draft: true,
      }),
      settleStep("s07.a.settle", "s07.pr", "s07.c1"),
      {
        kind: "observe",
        id: "s07.a.observe",
        key: "s07.a",
        collect: async (sx) => collectPr(sx, "s07.pr"),
      },
      {
        kind: "observe",
        id: "s07.a.cards",
        key: "s07.cardsC1A",
        collect: async (sx) => {
          const a = sx.scope.require<PrObs>("s07.a");
          return a.cardRowsForHead;
        },
      },
      countDeliveriesStep("s07.b.before", "s07.readyBefore", "pull_request", "ready_for_review"),
      { kind: "act", id: "s07.b.ready", act: { act: "markReady", pr: ref("s07.pr") } },
      awaitDeliveryStep(
        "s07.b.delivery",
        "s07.readyBefore",
        "pull_request",
        "ready_for_review",
        "s07.readyAfter",
      ),
      countDeliveriesStep("s07.c.before", "s07.reviewBefore", "pull_request_review", "submitted"),
      {
        kind: "act",
        id: "s07.c.review",
        act: { act: "review", client: "actor", pr: ref("s07.pr"), event: "COMMENT" },
      },
      awaitDeliveryStep(
        "s07.c.delivery",
        "s07.reviewBefore",
        "pull_request_review",
        "submitted",
        "s07.reviewAfter",
      ),
      commitAct("s07.d.commit", "s07.c2", {
        client: "actor",
        branch,
        from: "branch",
        message: agentMessage(pc, "Fix a spelling mistake"),
        changes: [],
        sameTreeAs: ref("s07.c1"),
        force: true,
      }),
      settleStep("s07.d.settle", "s07.pr", "s07.c2"),
      {
        kind: "observe",
        id: "s07.d.observe",
        key: "s07.d",
        collect: async (sx) => collectPr(sx, "s07.pr"),
      },
      {
        kind: "act",
        id: "s07.e.reset",
        key: "s07.c3",
        act: {
          act: "commit",
          client: "actor",
          branch,
          from: "branch",
          message: "",
          changes: [],
          resetTo: ref("s07.c1"),
          force: true,
        },
      },
      settleStep("s07.e.settle", "s07.pr", "s07.c3"),
      {
        kind: "observe",
        id: "s07.e.observe",
        key: "s07.e",
        collect: async (sx) => collectPr(sx, "s07.pr"),
      },
      {
        kind: "custom",
        id: "s07.collect",
        describe: "combine the observations",
        run: async (sx) => {
          const a = sx.scope.require<PrObs>("s07.a");
          const d = sx.scope.require<PrObs>("s07.d");
          const e = sx.scope.require<PrObs>("s07.e");
          sx.scope.set("s07.obs", {
            a,
            d,
            e,
            cache: {
              spendAfterD: d.spend.rows,
              spendAfterE: e.spend.rows,
              cardsForC1AfterA: sx.scope.require<number>("s07.cardsC1A"),
              cardsForC1AfterE: e.cardRowsForHead,
            },
            deliveries: {
              readyForReview:
                (sx.scope.get<number>("s07.readyAfter") ?? 0) >
                (sx.scope.get<number>("s07.readyBefore") ?? 0),
              reviewSubmitted:
                (sx.scope.get<number>("s07.reviewAfter") ?? 0) >
                (sx.scope.get<number>("s07.reviewBefore") ?? 0),
            },
          } satisfies S07Obs);
        },
      },
      {
        kind: "assert",
        id: "s07.assert",
        evaluate: (sx) => evaluateS07(sx.scope.require<S07Obs>("s07.obs"), envOfCtx(sx.run)),
      },
    ];
  },
};

export { agentTrailers };
