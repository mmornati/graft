/** s02: an agent adds a CI workflow (floor: ci_config). */
import { CI_WORKFLOW_YAML, ciWorkflowPath } from "../fixtures.js";
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
  policyTitle,
  prBody,
  prTitle,
  type ScenarioDef,
  settleStep,
  threeNeutral,
  truthy,
} from "./common.js";
import { envOfCtx } from "./env.js";

export interface S02Obs {
  pr: PrObs;
  workflowPath: string;
}

export function evaluateS02(o: S02Obs, env: EvalEnv): AssertionResult[] {
  const { pr } = o;
  const card = pr.card;
  const ci = card?.floorReasons.find((r) => r.rule === "ci_config");
  const title = policyTitle(pr);
  return [
    assertion(
      "system",
      "s02.floor.ci_config",
      `ci_config lists ${o.workflowPath}`,
      ci?.paths ?? null,
      Boolean(ci?.paths.includes(o.workflowPath)),
    ),
    eq("system", "s02.risk", "sensitive", card?.riskClass ?? null),
    assertion(
      "system",
      "s02.outcome",
      { outcome: "would_require", title: "Would require 1 human..." },
      { outcome: pr.verdict?.outcome, title },
      pr.verdict?.outcome === "would_require" && title.startsWith("Would require 1 human"),
    ),
    assertion(
      "system",
      "s02.required.team",
      `a team constraint, and the policy title names @${env.owner}/platform`,
      { constraints: pr.verdict?.teamConstraints ?? 0, title },
      (pr.verdict?.teamConstraints ?? 0) >= 1 &&
        title.toLowerCase().includes(`@${env.owner.toLowerCase()}/platform`),
    ),
    truthy(
      "system",
      "s02.policy.team-code-span",
      "the team appears as a code span",
      pr.comment.flags.policyPlatformCodeSpan,
    ),
    truthy(
      "system",
      "s02.policy.no-bare-mention",
      "no team mention outside code spans",
      !pr.comment.flags.policyBareTeamMention,
    ),
    assertion(
      "system",
      "s02.html.no-mention",
      "no user-mention or team-mention in Graft's rendered comment",
      {
        html: pr.comment.html.present,
        user: pr.comment.html.userMention,
        team: pr.comment.html.teamMention,
      },
      pr.comment.html.present && !pr.comment.html.userMention && !pr.comment.html.teamMention,
    ),
    ...oneComment("s02", pr),
    threeNeutral("s02.neutral", pr),
  ];
}

export const s02: ScenarioDef = {
  id: "s02",
  title: "CI config change",
  needs: [],
  modelRuns: 1,
  plan(pc: PlanContext): Step[] {
    const branch = branchOf(pc.runId, "s02");
    const path = ciWorkflowPath(pc.runId);
    return [
      commitAct("s02.commit", "s02.c1", {
        client: "actor",
        branch,
        from: "main",
        message: agentMessage(pc, "Add a manual CI workflow"),
        changes: [
          changesOf(path, [{ op: "create", content: CI_WORKFLOW_YAML }, diffLine(path, pc)]),
        ],
      }),
      openPrAct("s02.pr", "s02.pr", {
        client: "actor",
        head: branch,
        title: prTitle(pc, "s02", "Add a manual CI workflow"),
        body: prBody(pc, "Add a workflow that only runs by hand."),
      }),
      settleStep("s02.settle", "s02.pr", "s02.c1"),
      observePrStep("s02.observe", "s02.pr.obs", "s02.pr"),
      {
        kind: "custom",
        id: "s02.collect",
        describe: "collect the observation",
        run: async (sx) => {
          sx.scope.set("s02.obs", {
            pr: sx.scope.require<PrObs>("s02.pr.obs"),
            workflowPath: path,
          } satisfies S02Obs);
        },
      },
      {
        kind: "assert",
        id: "s02.assert",
        evaluate: (sx) => evaluateS02(sx.scope.require<S02Obs>("s02.obs"), envOfCtx(sx.run)),
      },
    ];
  },
};
