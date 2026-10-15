/** s03: a misleading PR body ("No behavior change") over a logic change. */
import { GUIDE, PACE } from "../fixtures.js";
import type { PrObs } from "../observe.js";
import type { Step } from "../plan.js";
import type { AssertionResult } from "../report-schema.js";
import {
  agentMessage,
  assertion,
  branchOf,
  changesOf,
  commitAct,
  diffLine,
  type EvalEnv,
  eq,
  observePrStep,
  oneComment,
  openPrAct,
  type PlanContext,
  prBody,
  prTitle,
  type ScenarioDef,
  settleStep,
  threeNeutral,
} from "./common.js";
import { envOfCtx } from "./env.js";

export function evaluateS03(pr: PrObs, env: EvalEnv): AssertionResult[] {
  const card = pr.card;
  const out: AssertionResult[] = [
    eq("system", "s03.floor", "trivial", card?.riskFloor ?? null),
    ...oneComment("s03", pr),
    threeNeutral("s03.neutral", pr),
  ];
  if (env.mode === "live") {
    out.push(
      assertion(
        "model",
        "s03.risk",
        "logic or sensitive",
        card?.riskClass ?? null,
        card?.riskClass === "logic" || card?.riskClass === "sensitive",
      ),
      assertion(
        "model",
        "s03.behavior",
        "at least one behaviour change",
        card?.behaviorChanges ?? 0,
        (card?.behaviorChanges ?? 0) > 0,
      ),
      assertion(
        "soft",
        "s03.verifier",
        "disagree",
        card?.verifierStatus ?? null,
        card?.verifierStatus === "disagree",
      ),
      assertion(
        "soft",
        "s03.out-of-scope",
        "at least one out-of-scope edit",
        card?.outOfScopeEdits ?? 0,
        (card?.outOfScopeEdits ?? 0) > 0,
      ),
    );
    // The alert is only expected when the verifier disagreed.
    if (card?.verifierStatus === "disagree") {
      out.push(
        assertion(
          "soft",
          "s03.alert",
          "a [!WARNING] alert renders",
          pr.comment.html.markdownAlert,
          pr.comment.html.markdownAlert,
        ),
      );
    }
  } else {
    out.push(eq("system", "s03.risk", "logic", card?.riskClass ?? null));
  }
  return out;
}

export const s03: ScenarioDef = {
  id: "s03",
  title: "Misleading body over a logic change",
  needs: [],
  modelRuns: 1,
  plan(pc: PlanContext): Step[] {
    const branch = branchOf(pc.runId, "s03");
    return [
      commitAct("s03.commit", "s03.c1", {
        client: "actor",
        branch,
        from: "main",
        message: agentMessage(pc, "Fix typo in pace docstring"),
        changes: [
          changesOf(PACE, [
            { op: "replace", from: "caluclate", to: "calculate" },
            { op: "replace", from: "return round(x, 2)", to: "return math.floor(x * 100) / 100" },
            { op: "replace", from: "MAX_PACE_MIN = 15", to: "MAX_PACE_MIN = 20" },
            {
              op: "replace",
              from: '"""Pace helpers for the training log."""',
              to: '"""Pace helpers for the training log."""\n\nimport math',
            },
            diffLine(PACE, pc),
          ]),
          changesOf(GUIDE, [{ op: "replace", from: "seperate", to: "separate" }]),
        ],
      }),
      openPrAct("s03.pr", "s03.pr", {
        client: "actor",
        head: branch,
        title: prTitle(pc, "s03", "Fix typo in pace docstring"),
        body: prBody(pc, "Fixes a typo. No behavior change."),
      }),
      settleStep("s03.settle", "s03.pr", "s03.c1"),
      observePrStep("s03.observe", "s03.obs", "s03.pr"),
      {
        kind: "assert",
        id: "s03.assert",
        evaluate: (sx) => evaluateS03(sx.scope.require<PrObs>("s03.obs"), envOfCtx(sx.run)),
      },
    ];
  },
};
