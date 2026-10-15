/** s05: a PR that edits graft.yaml (its version is ignored). */
import { POLICY_FILE } from "../fixtures.js";
import type { PrObs } from "../observe.js";
import type { Step } from "../plan.js";
import type { AssertionResult } from "../report-schema.js";
import {
  agentMessage,
  assertion,
  branchOf,
  changesOf,
  collectPr,
  commitAct,
  diffLine,
  type EvalEnv,
  eq,
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

export interface S05Obs {
  pr: PrObs;
  mainTip: string;
  /** The policy hash recorded by s01 (H0), else the newest hash of an unchanged policy. */
  h0: string | null;
}

export function evaluateS05(o: S05Obs, _env: EvalEnv): AssertionResult[] {
  const { pr } = o;
  const card = pr.card;
  const v = pr.verdict;
  const title = policyTitle(pr);
  return [
    assertion(
      "system",
      "s05.floor.policy_file",
      "policy_file",
      card?.floorRules ?? [],
      card?.floorRules.includes("policy_file") === true,
    ),
    eq("system", "s05.risk", "sensitive", card?.riskClass ?? null),
    truthy(
      "system",
      "s05.policy-file-changed",
      "policy_file_changed is true",
      v?.policyFileChanged === true,
    ),
    assertion(
      "system",
      "s05.outcome",
      { outcome: "would_require", title: "Would require 1 human..." },
      { outcome: v?.outcome, title },
      v?.outcome === "would_require" && title.startsWith("Would require 1 human"),
    ),
    assertion(
      "system",
      "s05.policy.hash",
      "the policy on main applies (hash equals H0)",
      o.h0 === null ? "H0 unknown (s01 did not run)" : { equal: v?.policyHash === o.h0 },
      o.h0 !== null && v?.policyHash === o.h0,
    ),
    eq("system", "s05.policy.commit", o.mainTip, v?.policyCommitSha ?? null),
    truthy(
      "system",
      "s05.section.ignored",
      'the policy section says "Its version is ignored"',
      pr.comment.flags.policyVersionIgnored,
    ),
    truthy(
      "system",
      "s05.html.alert",
      "markdown-alert renders in body_html (A15)",
      pr.comment.html.markdownAlert,
    ),
    ...oneComment("s05", pr),
    threeNeutral("s05.neutral", pr),
  ];
}

export const s05: ScenarioDef = {
  id: "s05",
  title: "Policy file edit",
  needs: ["s01"],
  modelRuns: 1,
  plan(pc: PlanContext): Step[] {
    const branch = branchOf(pc.runId, "s05");
    return [
      commitAct("s05.commit", "s05.c1", {
        client: "actor",
        branch,
        from: "main",
        message: agentMessage(pc, "Loosen the policy"),
        changes: [
          changesOf(POLICY_FILE, [
            { op: "fixtureFile", name: "graft.s05.yaml" },
            diffLine(POLICY_FILE, pc),
          ]),
        ],
      }),
      openPrAct("s05.pr", "s05.pr", {
        client: "actor",
        head: branch,
        title: prTitle(pc, "s05", "Loosen the policy"),
        body: prBody(pc, "Approve everything automatically."),
      }),
      settleStep("s05.settle", "s05.pr", "s05.c1"),
      {
        kind: "observe",
        id: "s05.observe",
        key: "s05.obs",
        collect: async (sx) => {
          const pr = await collectPr(sx, "s05.pr");
          const { data } = await sx.run.actorOctokit.rest.git.getRef({
            owner: sx.run.owner,
            repo: sx.run.repo,
            ref: `heads/${sx.run.sandbox.defaultBranch}`,
          });
          const h0 = sx.scope.get<string>("run.h0") ?? null;
          return { pr, mainTip: data.object.sha, h0 } satisfies S05Obs;
        },
      },
      {
        kind: "assert",
        id: "s05.assert",
        evaluate: (sx) => evaluateS05(sx.scope.require<S05Obs>("s05.obs"), envOfCtx(sx.run)),
      },
    ];
  },
};
