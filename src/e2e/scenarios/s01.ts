/** s01: an agent fixes a typo. Decides the LLM mode in `auto`. */
import { AGENT_MODEL, AGENT_NAME, GUIDE } from "../fixtures.js";
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
  ISSUE_KEY,
  LABEL,
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

export interface S01Obs {
  pr: PrObs;
  issue: number;
  mainTip: string;
}

export function evaluateS01(o: S01Obs, env: EvalEnv): AssertionResult[] {
  const { pr } = o;
  const p = pr.provenance;
  const card = pr.card;
  const v = pr.verdict;
  const out: AssertionResult[] = [
    eq("system", "s01.prov.kind", ["agent", "trailer"], [p?.authorKind, p?.reason]),
    eq("system", "s01.prov.agent", [AGENT_NAME, AGENT_MODEL], [p?.agent, p?.model]),
    eq("system", "s01.prov.task", `#${o.issue}`, p?.task ?? null),
    eq("system", "s01.task.issue", o.issue, pr.change?.taskIssueNumber ?? null),
    // The card's own input: the Graft-Task issue of this head, whichever job ran first.
    eq("system", "s01.card.linked-issue", o.issue, card?.linkedIssue ?? null),
    truthy("system", "s01.policy.hash", "a policy hash is recorded (H0)", Boolean(v?.policyHash)),
    eq(
      "system",
      "s01.floor",
      { floor: "trivial", reasons: 0 },
      {
        floor: card?.riskFloor,
        reasons: card?.floorReasons.length,
      },
    ),
    eq("system", "s01.sections", ["intent", "provenance", "policy"], pr.comment.sections),
    ...oneComment("s01", pr),
    threeNeutral("s01.neutral", pr),
    eq(
      "system",
      "s01.policy.status",
      { status: "ok", commit: o.mainTip },
      {
        status: v?.policyStatus,
        commit: v?.policyCommitSha,
      },
    ),
  ];
  const title = policyTitle(pr);
  if (env.mode === "live") {
    out.push(
      eq("system", "s01.card.status", "ok", card?.status ?? null),
      eq("model", "s01.card.risk", "trivial", card?.riskClass ?? null),
      eq("model", "s01.card.verifier", "agree", card?.verifierStatus ?? null),
      assertion(
        "model",
        "s01.policy.outcome",
        { outcome: "would_approve", title: "Would auto-approve" },
        { outcome: v?.outcome, title },
        v?.outcome === "would_approve" && title === "Would auto-approve",
      ),
    );
  } else {
    out.push(
      eq(
        "system",
        "s01.card.unavailable",
        { status: "unavailable", reason: "not_configured" },
        {
          status: card?.status,
          reason: card?.failureReason,
        },
      ),
      eq("system", "s01.card.risk", "logic", card?.riskClass ?? null),
      assertion(
        "system",
        "s01.policy.outcome",
        { outcome: "would_require", title: "Would require 1 human..." },
        { outcome: v?.outcome, title },
        v?.outcome === "would_require" && title.startsWith("Would require 1 human"),
      ),
    );
  }
  out.push(
    truthy(
      "system",
      "s01.prov.title",
      "provenance check has a title",
      provenanceTitle(pr).length > 0,
    ),
  );
  return out;
}

export const s01: ScenarioDef = {
  id: "s01",
  title: "Agent typo fix",
  needs: [],
  modelRuns: 1,
  plan(pc: PlanContext): Step[] {
    const branch = branchOf(pc.runId, "s01");
    return [
      {
        kind: "act",
        id: "s01.issue",
        key: ISSUE_KEY,
        act: {
          act: "createIssue",
          client: "actor",
          title: `[graft-e2e ${pc.runId}] e2e task`,
          body: "Tracking issue of a Graft e2e run. Safe to close.",
          labels: [LABEL],
        },
      },
      commitAct("s01.commit", "s01.c1", {
        client: "actor",
        branch,
        from: "main",
        message: agentMessage(pc, "Fix a typo in the guide"),
        changes: [
          changesOf(GUIDE, [
            { op: "replace", from: "recieve", to: "receive" },
            diffLine(GUIDE, pc),
          ]),
        ],
      }),
      openPrAct("s01.pr", "s01.pr", {
        client: "actor",
        head: branch,
        title: prTitle(pc, "s01", "Fix a typo in the guide"),
        body: prBody(pc, "Fix a typo in the guide."),
      }),
      settleStep("s01.settle", "s01.pr", "s01.c1"),
      {
        kind: "observe",
        id: "s01.observe",
        key: "s01.obs",
        collect: async (sx) => {
          const pr = await collectPr(sx, "s01.pr");
          const { data } = await sx.run.actorOctokit.rest.git.getRef({
            owner: sx.run.owner,
            repo: sx.run.repo,
            ref: `heads/${sx.run.sandbox.defaultBranch}`,
          });
          return {
            pr,
            issue: sx.scope.require<{ number: number }>(ISSUE_KEY).number,
            mainTip: data.object.sha,
          } satisfies S01Obs;
        },
      },
      {
        kind: "custom",
        id: "s01.h0",
        describe: "record the policy hash H0",
        run: async (sx) => {
          const o = sx.scope.require<S01Obs>("s01.obs");
          if (o.pr.verdict?.policyHash) sx.scope.set("run.h0", o.pr.verdict.policyHash);
        },
      },
      {
        kind: "assert",
        id: "s01.assert",
        evaluate: (sx) => evaluateS01(sx.scope.require<S01Obs>("s01.obs"), envOfCtx(sx.run)),
      },
    ];
  },
};
