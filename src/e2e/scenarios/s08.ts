/** s08: votes and eligibility (needs a live card and an outsider). */
import { GUIDE } from "../fixtures.js";
import { changeRow, type PrObs } from "../observe.js";
import { ref, type Step, type StepCtx } from "../plan.js";
import type { AssertionResult } from "../report-schema.js";
import { TIMEOUTS } from "../waiters.js";
import {
  assertion,
  branchOf,
  changesOf,
  collectPr,
  commitAct,
  diffLine,
  type EvalEnv,
  eq,
  humanMessage,
  openPrAct,
  type PlanContext,
  prBody,
  prTitle,
  type ScenarioDef,
  settleStep,
  truthy,
} from "./common.js";
import { envOfCtx } from "./env.js";

export interface GateNums {
  n: number;
  up: number;
  droppedAuthor: number;
  droppedNotReviewer: number;
  droppedBot: number;
  reaction: number;
  checkAction: number;
}

export function gateNums(json: string): GateNums {
  const g = JSON.parse(json) as {
    accuracy: {
      n: number;
      up: number;
      dropped: { author: number; not_reviewer: number; bot_or_agent: number };
      bySource: { reaction: number; check_action: number };
    };
  };
  return {
    n: g.accuracy.n,
    up: g.accuracy.up,
    droppedAuthor: g.accuracy.dropped.author,
    droppedNotReviewer: g.accuracy.dropped.not_reviewer,
    droppedBot: g.accuracy.dropped.bot_or_agent,
    reaction: g.accuracy.bySource.reaction,
    checkAction: g.accuracy.bySource.check_action,
  };
}

export interface S08Obs {
  pr8: PrObs;
  pr1: PrObs;
  reviewers: {
    actorReviewed: { verified: boolean } | null;
    actorRequested: { verified: boolean } | null;
    denials: number;
  };
  votes: {
    actorPr8: { verdict: string; source: string } | null;
    actorPr1: { verdict: string; isPrAuthor: boolean } | null;
    outsiderPr1: { verdict: string; source: string } | null;
  };
  approvals: { current: number; users: string[] };
  gate0: GateNums;
  gate1: GateNums;
  /** The actor saw the buttons (A05); false downgrades the button expectation to a soft one. */
  buttonsVisible: boolean;
  /** Public mode: no requested-reviewer evidence. */
  requestedExpected: boolean;
}

export function evaluateS08(o: S08Obs, env: EvalEnv): AssertionResult[] {
  const d = (k: keyof GateNums) => o.gate1[k] - o.gate0[k];
  const out: AssertionResult[] = [
    truthy(
      "system",
      "s08.reviewer.reviewed",
      "the actor is a verified reviewer (reviewed)",
      o.reviewers.actorReviewed?.verified === true,
    ),
    eq("system", "s08.reviewer.denials", 0, o.reviewers.denials),
    eq("system", "s08.vote.actor-pr8", "up", o.votes.actorPr8?.verdict ?? null),
    eq(
      "system",
      "s08.vote.actor-pr1",
      { verdict: "up", isPrAuthor: true },
      {
        verdict: o.votes.actorPr1?.verdict,
        isPrAuthor: o.votes.actorPr1?.isPrAuthor,
      },
    ),
    eq("system", "s08.vote.outsider-pr1", "down", o.votes.outsiderPr1?.verdict ?? null),
    assertion(
      "system",
      "s08.approvals",
      { current: 1, includesActor: true },
      o.approvals,
      o.approvals.current === 1 &&
        o.approvals.users.some((u) => u.toLowerCase() === env.actor.toLowerCase()),
    ),
    eq("system", "s08.gate.n", 1, d("n")),
    eq("system", "s08.gate.up", 1, d("up")),
    eq("system", "s08.gate.dropped.author", 1, d("droppedAuthor")),
    eq("system", "s08.gate.dropped.not_reviewer", 1, d("droppedNotReviewer")),
    eq("system", "s08.gate.dropped.bot", 0, d("droppedBot")),
  ];
  if (o.requestedExpected) {
    out.push(
      truthy(
        "system",
        "s08.reviewer.requested",
        "the actor is a verified reviewer (requested)",
        o.reviewers.actorRequested?.verified === true,
      ),
    );
  }
  if (env.interactive) {
    out.push(
      assertion(
        o.buttonsVisible ? "system" : "soft",
        "s08.gate.by-source",
        { check_action: 1, reaction: 0 },
        { check_action: d("checkAction"), reaction: d("reaction") },
        d("checkAction") === 1 && d("reaction") === 0,
      ),
    );
  } else {
    out.push(
      eq(
        "system",
        "s08.gate.by-source",
        { reaction: 1, check_action: 0 },
        {
          reaction: d("reaction"),
          check_action: d("checkAction"),
        },
      ),
    );
  }
  return out;
}

async function latestVote(
  sx: StepCtx,
  o: { prNumber: number; userId: number },
): Promise<{ verdict: string; source: string; isPrAuthor: boolean } | null> {
  const ch = await changeRow(sx.run, o.prNumber);
  if (!ch) return null;
  const rows = await sx.run.db
    .selectFrom("intent_feedback")
    .select(["verdict", "source", "is_pr_author", "reacted_at"])
    .where("change_id", "=", ch.id)
    .where("user_id", "=", o.userId)
    .orderBy("reacted_at", "desc")
    .execute();
  const r = rows[0];
  return r ? { verdict: r.verdict, source: r.source, isPrAuthor: r.is_pr_author } : null;
}

/**
 * Whether `s08.clicks` may stop waiting: each button click a person reported (the actor's on
 * PR 8 when the buttons were visible, the outsider's on PR 1 when they answered "clicked") is
 * that user's latest recorded vote.
 */
export function clicksRecorded(o: {
  buttons: boolean;
  outsiderClicked: boolean;
  actorPr8: string | null;
  outsiderPr1: string | null;
}): boolean {
  if (o.buttons && o.actorPr8 !== "check_action") return false;
  if (o.outsiderClicked && o.outsiderPr1 !== "check_action") return false;
  return true;
}

const gateArgv = (installationId: number, day: string, until: string): string[] => [
  "gate",
  "report",
  "--installation",
  String(installationId),
  "--since",
  day,
  "--until",
  until,
  "--json",
];

const plusDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const s08: ScenarioDef = {
  id: "s08",
  title: "Votes and reviewer eligibility",
  needs: ["s01", "s06"],
  requiresOutsider: true,
  requiresLiveLlm: true,
  modelRuns: 1,
  plan(pc: PlanContext): Step[] {
    const branch = branchOf(pc.runId, "s08");
    const outsider = pc.outsider ?? "outsider";
    const until = plusDays(pc.day, 2);
    const steps: Step[] = [
      {
        kind: "ops",
        id: "s08.gate0",
        key: "s08.gate0",
        writes: false,
        argv: gateArgv(pc.installationId, pc.day, until),
      },
    ];
    if (pc.outsiderMode === "fork") {
      steps.push(
        { kind: "act", id: "s08.fork", act: { act: "fork", client: "outsider" } },
        { kind: "act", id: "s08.sync", act: { act: "syncFork", client: "outsider" } },
      );
    }
    steps.push(
      commitAct("s08.commit", "s08.c1", {
        client: "outsider",
        branch,
        from: "main",
        message: humanMessage(pc, "Fix a spelling mistake"),
        changes: [
          changesOf(GUIDE, [
            { op: "replace", from: "occured", to: "occurred" },
            diffLine(GUIDE, pc),
          ]),
        ],
      }),
      openPrAct("s08.pr", "s08.pr", {
        client: "outsider",
        head: branch,
        title: prTitle(pc, "s08", "Fix a spelling mistake (outsider)"),
        body: prBody(pc, "A spelling fix from an outside contributor."),
      }),
    );
    // The reviewer is requested as the PR is opened, the usual path in the GitHub UI: Graft's
    // sync may run before its `changes` row exists and must still keep the request.
    if (pc.outsiderMode === "collaborator") {
      steps.push({
        kind: "act",
        id: "s08.request",
        act: {
          act: "requestReviewers",
          client: "outsider",
          pr: ref("s08.pr"),
          reviewers: [pc.actor],
        },
      });
      // Graft records the request from the webhook; the approval must not come first.
      steps.push({
        kind: "wait",
        id: "s08.request.recorded",
        name: "reeval",
        timeoutMs: TIMEOUTS.reeval,
        describe: "Graft recorded the reviewer request",
        probe: async (sx) => {
          const ch = await changeRow(sx.run, sx.scope.require<{ number: number }>("s08.pr").number);
          if (!ch) return false;
          const row = await sx.run.db
            .selectFrom("pr_reviewers")
            .select("verified")
            .where("change_id", "=", ch.id)
            .where("user_id", "=", sx.run.actor.id)
            .where("reason", "=", "requested")
            .executeTakeFirst();
          sx.note({ row: row ?? null });
          return row !== undefined;
        },
      });
    }
    steps.push(
      settleStep("s08.settle", "s08.pr", "s08.c1"),
      {
        kind: "act",
        id: "s08.approve",
        act: { act: "review", client: "actor", pr: ref("s08.pr"), event: "APPROVE" },
      },
      {
        kind: "wait",
        id: "s08.approvals",
        name: "reeval",
        timeoutMs: TIMEOUTS.reeval,
        describe: "PR 8's verdict counts the approval",
        probe: async (sx) => {
          const pr = await collectPr(sx, "s08.pr");
          sx.note({ approvals: pr.verdict?.approvalsCurrent ?? null });
          return (pr.verdict?.approvalsCurrent ?? 0) >= 1;
        },
      },
      {
        kind: "observe",
        id: "s08.comments",
        key: "s08.comments",
        collect: async (sx) => {
          const c8 = await changeRow(sx.run, sx.scope.require<{ number: number }>("s08.pr").number);
          const c1 = await changeRow(sx.run, sx.scope.require<{ number: number }>("s01.pr").number);
          if (!c8?.graft_comment_id || !c1?.graft_comment_id) {
            throw new Error("a Graft comment is missing before the votes");
          }
          return { pr8: c8.graft_comment_id, pr1: c1.graft_comment_id };
        },
      },
      {
        kind: "act",
        id: "s08.up8",
        act: { act: "react", client: "actor", comment: ref("s08.comments.pr8"), content: "+1" },
      },
      {
        kind: "act",
        id: "s08.up1",
        act: { act: "react", client: "actor", comment: ref("s08.comments.pr1"), content: "+1" },
      },
    );
    if (pc.interactive) {
      steps.push(
        {
          kind: "manual",
          id: "s08.click.wrong",
          instruction: `As ${outsider}, open PR 1 on GitHub, the Checks tab, graft/intent, and click "Card is wrong".`,
          question: `Outsider: did you click "Card is wrong" on PR 1's graft/intent? (clicked / no buttons / no access)`,
          run: async (sx, answer) => {
            sx.scope.set("s08.answer.outsider", answer.trim().toLowerCase());
          },
        },
        {
          kind: "manual",
          id: "s08.click.accurate",
          instruction: `As ${pc.actor}, open PR 8, the Checks tab, graft/intent, and click "Card is accurate".`,
          question: "Do you see Card is accurate / Card is wrong on graft/intent? y/n",
          run: async (sx, answer) => {
            sx.scope.set("s08.answer.buttons", answer.trim().toLowerCase());
          },
        },
        {
          kind: "wait",
          id: "s08.clicks",
          name: "delivery",
          timeoutMs: TIMEOUTS.delivery,
          describe: "the recorded button votes (check_action)",
          probe: async (sx) => {
            const buttons = sx.scope.get("s08.answer.buttons") === "y";
            const outsiderClicked = sx.scope.get("s08.answer.outsider") === "clicked";
            const pr8 = buttons
              ? await latestVote(sx, {
                  prNumber: sx.scope.require<{ number: number }>("s08.pr").number,
                  userId: sx.run.actor.id,
                })
              : null;
            const pr1 = outsiderClicked
              ? await latestVote(sx, {
                  prNumber: sx.scope.require<{ number: number }>("s01.pr").number,
                  userId: sx.run.outsider?.id ?? 0,
                })
              : null;
            sx.note({ actorClick: pr8?.source ?? null, outsiderClick: pr1?.source ?? null });
            return clicksRecorded({
              buttons,
              outsiderClicked,
              actorPr8: pr8?.source ?? null,
              outsiderPr1: pr1?.source ?? null,
            });
          },
        },
      );
    } else {
      steps.push({
        kind: "act",
        id: "s08.down1",
        act: { act: "react", client: "outsider", comment: ref("s08.comments.pr1"), content: "-1" },
      });
    }
    if (pc.waitCron) {
      steps.push({
        kind: "wait",
        id: "s08.cron",
        name: "cron",
        timeoutMs: TIMEOUTS.cron,
        describe: "the scheduled poll records the actor's reaction (A04)",
        probe: async (sx) => {
          const v = await latestVote(sx, {
            prNumber: sx.scope.require<{ number: number }>("s08.pr").number,
            userId: sx.run.actor.id,
          });
          return v !== null;
        },
      });
    } else {
      steps.push({
        kind: "ops",
        id: "s08.sweep",
        key: "s08.sweep",
        writes: true,
        argv: ["pilot", "sweep-feedback", "--installation", String(pc.installationId)],
      });
    }
    steps.push(
      {
        kind: "ops",
        id: "s08.sync-reviewers",
        key: "s08.sync",
        writes: true,
        argv: [
          "pilot",
          "sync-reviewers",
          "--installation",
          String(pc.installationId),
          "--since",
          pc.day,
        ],
      },
      {
        kind: "ops",
        id: "s08.gate1",
        key: "s08.gate1",
        writes: false,
        argv: gateArgv(pc.installationId, pc.day, until),
      },
      {
        kind: "observe",
        id: "s08.observe",
        key: "s08.obs",
        collect: async (sx) => {
          const pr8 = await collectPr(sx, "s08.pr");
          const pr1 = await collectPr(sx, "s01.pr");
          const ch8 = await changeRow(sx.run, pr8.number);
          const reviewers = ch8
            ? await sx.run.db
                .selectFrom("pr_reviewers")
                .select(["reason", "verified"])
                .where("change_id", "=", ch8.id)
                .where("user_id", "=", sx.run.actor.id)
                .execute()
            : [];
          const denials = ch8
            ? await sx.run.db
                .selectFrom("reviewer_check_denials")
                .select((eb) => eb.fn.countAll<string>().as("n"))
                .where("change_id", "=", ch8.id)
                .where("user_id", "=", sx.run.actor.id)
                .executeTakeFirst()
            : undefined;
          const outsiderId = sx.run.outsider?.id ?? 0;
          const g = (key: string) => gateNums(sx.scope.require<{ out: string }>(key).out);
          const reviewedRow = reviewers.find((r) => r.reason === "reviewed");
          const requestedRow = reviewers.find((r) => r.reason === "requested");
          const v8 = await latestVote(sx, { prNumber: pr8.number, userId: sx.run.actor.id });
          const v1a = await latestVote(sx, { prNumber: pr1.number, userId: sx.run.actor.id });
          const v1o = await latestVote(sx, { prNumber: pr1.number, userId: outsiderId });
          return {
            pr8,
            pr1,
            reviewers: {
              actorReviewed: reviewedRow ? { verified: reviewedRow.verified } : null,
              actorRequested: requestedRow ? { verified: requestedRow.verified } : null,
              denials: Number(denials?.n ?? 0),
            },
            votes: {
              actorPr8: v8 ? { verdict: v8.verdict, source: v8.source } : null,
              actorPr1: v1a ? { verdict: v1a.verdict, isPrAuthor: v1a.isPrAuthor } : null,
              outsiderPr1: v1o ? { verdict: v1o.verdict, source: v1o.source } : null,
            },
            approvals: {
              current: pr8.verdict?.approvalsCurrent ?? 0,
              users: pr8.verdict?.approvalUsers ?? [],
            },
            gate0: g("s08.gate0"),
            gate1: g("s08.gate1"),
            buttonsVisible: !pc.interactive || sx.scope.get("s08.answer.buttons") === "y",
            requestedExpected: pc.outsiderMode === "collaborator",
          } satisfies S08Obs;
        },
      },
      {
        kind: "assert",
        id: "s08.assert",
        evaluate: (sx) => evaluateS08(sx.scope.require<S08Obs>("s08.obs"), envOfCtx(sx.run)),
      },
    );
    return steps;
  },
};

export { gateArgv, plusDays };
