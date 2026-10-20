import { describe, expect, it } from "vitest";
import type { PrObs } from "../../src/e2e/observe.js";
import type { AssertionResult } from "../../src/e2e/report-schema.js";
import { b1, evaluateB1 } from "../../src/e2e/scenarios/b1.js";
import { evaluateB2 } from "../../src/e2e/scenarios/b2.js";
import type { EvalEnv } from "../../src/e2e/scenarios/common.js";
import { evaluateS01 } from "../../src/e2e/scenarios/s01.js";
import { evaluateS02 } from "../../src/e2e/scenarios/s02.js";
import { evaluateS03 } from "../../src/e2e/scenarios/s03.js";
import { evaluateS04 } from "../../src/e2e/scenarios/s04.js";
import { evaluateS05 } from "../../src/e2e/scenarios/s05.js";
import { evaluateS06 } from "../../src/e2e/scenarios/s06.js";
import { evaluateS07 } from "../../src/e2e/scenarios/s07.js";
import {
  clicksRecorded,
  evaluateS08,
  type GateNums,
  type S08Obs,
} from "../../src/e2e/scenarios/s08.js";
import { evaluateS09, type PerPr, type S09Obs } from "../../src/e2e/scenarios/s09.js";
import { evaluateS10, type S10Obs } from "../../src/e2e/scenarios/s10.js";
import {
  at,
  checks,
  type FullPr,
  failedIds,
  fails,
  prObs,
  tweak,
} from "../helpers/live-e2e-obs.js";

void b1;
const env = (mode: "live" | "none", over: Partial<EvalEnv> = {}): EvalEnv => ({
  mode,
  interactive: false,
  outsiderMode: "collaborator",
  owner: "mmornati",
  actor: "mmornati",
  runDay: "2026-10-15",
  waitCron: false,
  ...over,
});

/** Every system and model assertion of `good` passes; each breaker makes exactly its assertion fail. */
function exhaustive<T>(
  evaluate: (o: T, e: EvalEnv) => AssertionResult[],
  good: T,
  e: EvalEnv,
  breakers: Record<string, (draft: T) => void>,
) {
  const base = evaluate(good, e);
  expect(failedIds(base)).toEqual([]);
  expect(fails(base)).toBe(false);
  for (const [id, apply] of Object.entries(breakers)) {
    const bad = evaluate(tweak(good, apply), e);
    const hit = bad.find((a) => a.id === id);
    expect(hit, `assertion ${id} exists`).toBeDefined();
    expect(hit?.ok, `${id} fails when its observation is wrong`).toBe(false);
    if (hit?.kind === "soft") {
      expect(fails(bad), `${id} is soft: never fails the scenario`).toBe(false);
    } else if (hit?.kind === "model") {
      expect(fails(bad), `${id} is a model assertion`).toBe(true);
      expect(fails(bad, true), `${id} is only a warning with --lenient-model`).toBe(false);
    } else {
      expect(fails(bad), `${id} is a system assertion`).toBe(true);
      expect(fails(bad, true), `${id} fails even with --lenient-model`).toBe(true);
    }
  }
}

const platformPr = (over: (p: FullPr) => void = () => undefined): FullPr =>
  tweak(prObs(), (p) => {
    p.card = {
      ...(p.card as NonNullable<PrObs["card"]>),
      riskClass: "sensitive",
      riskFloor: "sensitive",
      floorRules: ["ci_config"],
      floorReasons: [{ rule: "ci_config", paths: [".github/workflows/graft-e2e-x.yml"] }],
    };
    p.verdict = {
      ...(p.verdict as NonNullable<PrObs["verdict"]>),
      outcome: "would_require",
      humans: 1,
      teamConstraints: 1,
    };
    p.checks = checks("Would require 1 human (1 from @mmornati/platform)");
    p.comment.flags.policyPlatformCodeSpan = true;
    over(p);
  });

describe("scenario expectations", () => {
  it("U-LIVE-SCEN-1 s01: live and none variants; one failing observation per S and M assertion flips the scenario; M12 logic is not an acceptable live risk", () => {
    const live = { pr: prObs(), issue: 1, mainTip: "b".repeat(40) };
    exhaustive(evaluateS01, live, env("live"), {
      "s01.prov.kind": (d) => {
        d.pr.provenance.authorKind = "human";
      },
      "s01.prov.agent": (d) => {
        d.pr.provenance.model = "other";
      },
      "s01.prov.task": (d) => {
        d.pr.provenance.task = "#9";
      },
      "s01.card.linked-issue": (d) => {
        d.pr.card.linkedIssue = null;
      },
      "s01.policy.hash": (d) => {
        d.pr.verdict.policyHash = null;
      },
      "s01.task.issue": (d) => {
        d.pr.change.taskIssueNumber = null;
      },
      "s01.floor": (d) => {
        d.pr.card.floorReasons = [{ rule: "ci_config", paths: [] }];
      },
      "s01.sections": (d) => {
        d.pr.comment.sections = ["provenance", "intent", "policy"];
      },
      "s01.one-comment": (d) => {
        d.pr.comment.ours = [500, 501];
      },
      "s01.marker-once": (d) => {
        d.pr.comment.markerCounts.intent = { start: 2, end: 1 };
      },
      "s01.neutral": (d) => {
        at(d.pr.checks, 2).conclusion = "success";
      },
      "s01.policy.status": (d) => {
        d.mainTip = "c".repeat(40);
      },
      "s01.card.status": (d) => {
        d.pr.card.status = "unavailable";
      },
      "s01.card.risk": (d) => {
        d.pr.card.riskClass = "sensitive";
      },
      "s01.card.verifier": (d) => {
        d.pr.card.verifierStatus = "disagree";
      },
      "s01.policy.outcome": (d) => {
        d.pr.verdict.outcome = "would_require";
      },
    });
    // M12: "logic" is not trivial.
    const logic = evaluateS01(
      tweak(live, (d) => {
        d.pr.card.riskClass = "logic";
      }),
      env("live"),
    );
    expect(logic.find((a) => a.id === "s01.card.risk")).toMatchObject({ kind: "model", ok: false });
    expect(fails(logic)).toBe(true);
    expect(fails(logic, true)).toBe(false);

    const none = {
      pr: tweak(prObs(), (p) => {
        p.card = {
          ...p.card,
          status: "unavailable",
          failureReason: "not_configured",
          riskClass: "logic",
        };
        p.verdict = { ...p.verdict, outcome: "would_require", humans: 1 };
        p.checks = checks("Would require 1 human (default)");
      }),
      issue: 1,
      mainTip: "b".repeat(40),
    };
    exhaustive(evaluateS01, none, env("none"), {
      "s01.card.unavailable": (d) => {
        d.pr.card.failureReason = "llm_auth";
      },
      "s01.card.risk": (d) => {
        d.pr.card.riskClass = "trivial";
      },
      "s01.policy.outcome": (d) => {
        d.pr.verdict.outcome = "would_approve";
      },
    });
  });

  it("U-LIVE-SCEN-2 s02: ci_config lists the file, team shown as a code span, no mention renders", () => {
    const good = { pr: platformPr(), workflowPath: ".github/workflows/graft-e2e-x.yml" };
    for (const mode of ["live", "none"] as const) {
      exhaustive(evaluateS02, good, env(mode), {
        "s02.floor.ci_config": (d) => {
          d.pr.card.floorReasons = [];
        },
        "s02.risk": (d) => {
          d.pr.card.riskClass = "logic";
        },
        "s02.outcome": (d) => {
          d.pr.verdict.outcome = "would_approve";
        },
        "s02.required.team": (d) => {
          d.pr.verdict.teamConstraints = 0;
        },
        "s02.policy.team-code-span": (d) => {
          d.pr.comment.flags.policyPlatformCodeSpan = false;
        },
        "s02.policy.no-bare-mention": (d) => {
          d.pr.comment.flags.policyBareTeamMention = true;
        },
        "s02.html.no-mention": (d) => {
          d.pr.comment.html.teamMention = true;
        },
        "s02.neutral": (d) => {
          at(d.pr.checks, 0).status = "in_progress";
        },
      });
    }
  });

  it("U-LIVE-SCEN-2 s02: a different team in the title fails the team check", () => {
    const wrong = {
      pr: platformPr((p) => {
        p.checks = checks("Would require 1 human (1 from @mmornati/security)");
      }),
      workflowPath: ".github/workflows/graft-e2e-x.yml",
    };
    expect(failedIds(evaluateS02(wrong, env("live")))).toEqual(["s02.required.team"]);
  });

  it("U-LIVE-SCEN-3 s03: floor trivial; live model bounds; the verifier and the alert are soft; none requires logic", () => {
    const live = tweak(prObs(), (p) => {
      p.card = {
        ...p.card,
        riskClass: "logic",
        behaviorChanges: 2,
        verifierStatus: "disagree",
        outOfScopeEdits: 1,
      };
    });
    exhaustive(evaluateS03, live, env("live"), {
      "s03.floor": (d) => {
        d.card.riskFloor = "sensitive";
      },
      "s03.risk": (d) => {
        d.card.riskClass = "trivial";
      },
      "s03.behavior": (d) => {
        d.card.behaviorChanges = 0;
      },
      "s03.verifier": (d) => {
        d.card.verifierStatus = "agree";
      },
      "s03.out-of-scope": (d) => {
        d.card.outOfScopeEdits = 0;
      },
      "s03.alert": (d) => {
        d.comment.html.markdownAlert = false;
      },
    });
  });

  it("U-LIVE-SCEN-3 s03: a verifier that does not disagree still passes", () => {
    const agree = tweak(prObs(), (p) => {
      p.card = { ...p.card, riskClass: "logic", behaviorChanges: 1, verifierStatus: "agree" };
    });
    const res = evaluateS03(agree, env("live"));
    expect(res.find((a) => a.id === "s03.verifier")).toMatchObject({ kind: "soft", ok: false });
    expect(res.find((a) => a.id === "s03.alert")).toBeUndefined();
    expect(fails(res)).toBe(false);
    const none = tweak(prObs(), (p) => {
      p.card = { ...p.card, status: "unavailable", riskClass: "logic" };
    });
    expect(fails(evaluateS03(none, env("none")))).toBe(false);
    expect(
      fails(
        evaluateS03(
          tweak(none, (p) => {
            p.card.riskClass = "trivial";
          }),
          env("none"),
        ),
      ),
    ).toBe(true);
  });

  it("U-LIVE-SCEN-4 s04: injection marker, clean rendering, the control mention; instructions_in_data is soft", () => {
    const good = {
      pr: tweak(prObs(), (p) => {
        p.card = {
          ...p.card,
          riskClass: "logic",
          floorRules: ["injection_marker"],
          floorReasons: [{ rule: "injection_marker", paths: [] }],
          instructionsInData: true,
        };
      }),
      controlHasUserMention: true,
    };
    exhaustive(evaluateS04, good, env("live"), {
      "s04.floor.injection": (d) => {
        d.pr.card.floorRules = [];
      },
      "s04.risk": (d) => {
        d.pr.card.riskClass = "trivial";
      },
      "s04.one-comment": (d) => {
        d.pr.comment.ours = [];
      },
      "s04.marker-once": (d) => {
        d.pr.comment.markerOccurrences = 2;
      },
      "s04.html.clean": (d) => {
        d.pr.comment.html.img = true;
      },
      "s04.control.mention": (d) => {
        d.controlHasUserMention = false;
      },
      "s04.instructions-in-data": (d) => {
        d.pr.card.instructionsInData = false;
      },
    });
    // none mode has no soft model check.
    expect(evaluateS04(good, env("none")).some((a) => a.id === "s04.instructions-in-data")).toBe(
      false,
    );
  });

  it("U-LIVE-SCEN-5 s05: policy_file, sensitive, ignored version, hash equals H0, alert renders", () => {
    const good = {
      pr: tweak(prObs(), (p) => {
        p.card = {
          ...p.card,
          riskClass: "sensitive",
          floorRules: ["policy_file"],
          floorReasons: [{ rule: "policy_file", paths: ["graft.yaml"] }],
        };
        p.verdict = { ...p.verdict, outcome: "would_require", humans: 1, policyFileChanged: true };
        p.checks = checks("Would require 1 human (default)");
        p.comment.flags.policyVersionIgnored = true;
      }),
      mainTip: "b".repeat(40),
      h0: "h0",
    };
    for (const mode of ["live", "none"] as const) {
      exhaustive(evaluateS05, good, env(mode), {
        "s05.floor.policy_file": (d) => {
          d.pr.card.floorRules = [];
        },
        "s05.risk": (d) => {
          d.pr.card.riskClass = "logic";
        },
        "s05.policy-file-changed": (d) => {
          d.pr.verdict.policyFileChanged = false;
        },
        "s05.outcome": (d) => {
          d.pr.verdict.outcome = "would_approve";
        },
        "s05.policy.hash": (d) => {
          d.pr.verdict.policyHash = "other";
        },
        "s05.policy.commit": (d) => {
          d.mainTip = "c".repeat(40);
        },
        "s05.section.ignored": (d) => {
          d.pr.comment.flags.policyVersionIgnored = false;
        },
        "s05.html.alert": (d) => {
          d.pr.comment.html.markdownAlert = false;
        },
      });
    }
    // Without H0 (s01 not run) the hash check fails: it is no longer vacuous.
    expect(failedIds(evaluateS05({ ...good, h0: null }, env("live")))).toEqual(["s05.policy.hash"]);
  });

  it("U-LIVE-SCEN-6 s06: same comment, advanced updated_at, two commits with trailers; live and none", () => {
    const before = prObs();
    const after = tweak(prObs(), (p) => {
      p.headSha = "d".repeat(40);
      p.change.headSha = "d".repeat(40);
      p.comment.updatedAt = "2026-10-15T10:05:00.000Z";
      p.provenance = { ...p.provenance, commitsTotal: 2, commitsWithTrailers: 2 };
    });
    const good = { pr: after, before, newHead: "d".repeat(40) };
    exhaustive(evaluateS06, good, env("live"), {
      "s06.head": (d) => {
        d.newHead = "e".repeat(40);
      },
      "s06.card.row": (d) => {
        d.pr.displaysForHead = 0;
      },
      "s06.comment.same": (d) => {
        d.pr.comment.id = 501;
      },
      "s06.comment.updated": (d) => {
        d.pr.comment.updatedAt = d.before.comment.updatedAt;
      },
      "s06.one-comment": (d) => {
        d.pr.comment.ours = [500, 501];
      },
      "s06.neutral": (d) => {
        at(d.pr.checks, 0).conclusion = "failure";
      },
      "s06.commits": (d) => {
        d.pr.provenance.commitsWithTrailers = 1;
      },
      "s06.risk": (d) => {
        d.pr.card.riskClass = "logic";
      },
      "s06.outcome": (d) => {
        d.pr.verdict.outcome = "would_require";
      },
    });
    const none = tweak(good, (d) => {
      d.pr.card = { ...d.pr.card, status: "unavailable", riskClass: "logic" };
      d.pr.verdict = { ...d.pr.verdict, outcome: "would_require", humans: 1 };
      d.pr.checks = checks("Would require 1 human (default)");
    });
    exhaustive(evaluateS06, none, env("none"), {
      "s06.card.unavailable": (d) => {
        d.pr.card.status = "ok";
      },
      "s06.outcome": (d) => {
        d.pr.verdict.outcome = "would_approve";
      },
    });
  });

  it("U-LIVE-SCEN-7 s07: author kind flips, one comment id throughout, the card cache (live)", () => {
    const human = (p: FullPr) => {
      p.provenance = {
        ...p.provenance,
        authorKind: "human",
        reason: "none",
        agent: null,
        model: null,
        task: null,
      };
      p.checks = checks("Would auto-approve").map((c) =>
        c.name === "graft/provenance" ? { ...c, title: "Human-authored (no agent provenance)" } : c,
      );
      p.comment.flags.provenanceNoTrailers = true;
    };
    const a = tweak(prObs(), human);
    const d = prObs();
    const e = tweak(prObs(), human);
    const good = {
      a,
      d,
      e,
      cache: { spendAfterD: 2, spendAfterE: 2, cardsForC1AfterA: 1, cardsForC1AfterE: 1 },
      deliveries: { readyForReview: true, reviewSubmitted: true },
    };
    exhaustive(evaluateS07, good, env("live"), {
      "s07.a.human": (x) => {
        x.a.provenance.authorKind = "agent";
      },
      "s07.a.title": (x) => {
        at(x.a.checks, 0).title = "Agent-authored";
      },
      "s07.a.no-trailers": (x) => {
        x.a.comment.flags.provenanceNoTrailers = false;
      },
      "s07.b.ready": (x) => {
        x.deliveries.readyForReview = false;
      },
      "s07.c.review": (x) => {
        x.deliveries.reviewSubmitted = false;
      },
      "s07.d.agent": (x) => {
        x.d.provenance.authorKind = "human";
      },
      "s07.e.human": (x) => {
        x.e.provenance.authorKind = "agent";
      },
      "s07.comment.same": (x) => {
        x.d.comment.id = 777;
      },
      "s07.cache.cards": (x) => {
        x.cache.cardsForC1AfterE = 2;
      },
      "s07.cache.spend": (x) => {
        x.cache.spendAfterE = 3;
      },
      "s07.a.outcome": (x) => {
        x.a.verdict.outcome = "would_require";
      },
    });
    const none = tweak(good, (x) => {
      x.a.card = { ...x.a.card, status: "unavailable", riskClass: "logic" };
      x.a.verdict = { ...x.a.verdict, outcome: "would_require", humans: 1 };
      x.a.checks = checks("Would require 1 human (default)").map((c) =>
        c.name === "graft/provenance" ? { ...c, title: "Human-authored (no agent provenance)" } : c,
      );
      x.cache = { spendAfterD: 0, spendAfterE: 0, cardsForC1AfterA: 1, cardsForC1AfterE: 2 };
    });
    // The cache is a live-mode expectation only.
    expect(failedIds(evaluateS07(none, env("none")))).toEqual([]);
  });

  it("U-LIVE-SCEN-8 s08: eligibility, feedback, approvals and the gate deltas; interactive uses the button source", () => {
    const g0: GateNums = {
      n: 0,
      up: 0,
      droppedAuthor: 0,
      droppedNotReviewer: 0,
      droppedBot: 0,
      reaction: 0,
      checkAction: 0,
    };
    const pr8 = tweak(prObs(), (p) => {
      p.verdict = { ...p.verdict, approvalsCurrent: 1, approvalUsers: ["mmornati"] };
    });
    const good: S08Obs = {
      pr8,
      pr1: prObs(),
      reviewers: {
        actorReviewed: { verified: true },
        actorRequested: { verified: true },
        denials: 0,
      },
      votes: {
        actorPr8: { verdict: "up", source: "reaction" },
        actorPr1: { verdict: "up", isPrAuthor: true },
        outsiderPr1: { verdict: "down", source: "reaction" },
      },
      approvals: { current: 1, users: ["mmornati"] },
      gate0: g0,
      gate1: { ...g0, n: 1, up: 1, droppedAuthor: 1, droppedNotReviewer: 1, reaction: 1 },
      buttonsVisible: true,
      requestedExpected: true,
    };
    exhaustive(evaluateS08, good, env("live"), {
      "s08.reviewer.reviewed": (x) => {
        x.reviewers.actorReviewed = null;
      },
      "s08.reviewer.requested": (x) => {
        x.reviewers.actorRequested = { verified: false };
      },
      "s08.reviewer.denials": (x) => {
        x.reviewers.denials = 1;
      },
      "s08.vote.actor-pr8": (x) => {
        x.votes.actorPr8 = { verdict: "down", source: "reaction" };
      },
      "s08.vote.actor-pr1": (x) => {
        x.votes.actorPr1 = { verdict: "up", isPrAuthor: false };
      },
      "s08.vote.outsider-pr1": (x) => {
        x.votes.outsiderPr1 = null;
      },
      "s08.approvals": (x) => {
        x.approvals = { current: 0, users: [] };
      },
      "s08.gate.n": (x) => {
        x.gate1.n = 2;
      },
      "s08.gate.up": (x) => {
        x.gate1.up = 0;
      },
      "s08.gate.dropped.author": (x) => {
        x.gate1.droppedAuthor = 0;
      },
      "s08.gate.dropped.not_reviewer": (x) => {
        x.gate1.droppedNotReviewer = 2;
      },
      "s08.gate.dropped.bot": (x) => {
        x.gate1.droppedBot = 1;
      },
      "s08.gate.by-source": (x) => {
        x.gate1.reaction = 0;
      },
    });
    // Public mode: no requested-reviewer evidence is expected.
    expect(
      evaluateS08({ ...good, requestedExpected: false }, env("live")).some(
        (a) => a.id === "s08.reviewer.requested",
      ),
    ).toBe(false);
    // Interactive: the actor's click is its latest vote.
    const clicked = { ...good, gate1: { ...good.gate1, reaction: 0, checkAction: 1 } };
    expect(failedIds(evaluateS08(clicked, env("live", { interactive: true })))).toEqual([]);
    // Without visible buttons the source check is only a warning.
    const hidden = evaluateS08(
      {
        ...clicked,
        gate1: { ...clicked.gate1, checkAction: 0, reaction: 1 },
        buttonsVisible: false,
      },
      env("live", { interactive: true }),
    );
    expect(hidden.find((a) => a.id === "s08.gate.by-source")).toMatchObject({
      kind: "soft",
      ok: false,
    });
  });

  it("U-LIVE-SCEN-8 s08: the clicks wait holds until every reported click is the clicker's latest vote", () => {
    const base = { buttons: true, outsiderClicked: true };
    expect(clicksRecorded({ ...base, actorPr8: "check_action", outsiderPr1: "check_action" })).toBe(
      true,
    );
    // The outsider's delivery is not recorded yet: the actor's click alone is not enough.
    expect(clicksRecorded({ ...base, actorPr8: "check_action", outsiderPr1: null })).toBe(false);
    expect(clicksRecorded({ ...base, actorPr8: "check_action", outsiderPr1: "reaction" })).toBe(
      false,
    );
    expect(clicksRecorded({ ...base, actorPr8: null, outsiderPr1: "check_action" })).toBe(false);
    // A click nobody reported is not waited for.
    expect(
      clicksRecorded({
        buttons: true,
        outsiderClicked: false,
        actorPr8: "check_action",
        outsiderPr1: null,
      }),
    ).toBe(true);
    expect(
      clicksRecorded({
        buttons: false,
        outsiderClicked: true,
        actorPr8: null,
        outsiderPr1: "check_action",
      }),
    ).toBe(true);
    expect(
      clicksRecorded({ buttons: false, outsiderClicked: false, actorPr8: null, outsiderPr1: null }),
    ).toBe(true);
  });

  it("U-LIVE-SCEN-9 s09: every open run PR is re-evaluated at both pushes; the starter is restored", () => {
    const mid: PerPr[] = [
      {
        number: 2,
        outcome: "would_require",
        title: "Would require 2 humans (default)",
        policyCommitSha: "p1",
        policyHash: "h1",
      },
      {
        number: 7,
        outcome: "would_require",
        title: "Would require 2 humans (default)",
        policyCommitSha: "p1",
        policyHash: "h1",
      },
      {
        number: 3,
        outcome: "would_require",
        title: "Would require 1 human",
        policyCommitSha: "p1",
        policyHash: "h1",
      },
    ];
    const end: PerPr[] = mid.map((p) => ({
      ...p,
      outcome: "would_approve",
      title: "Would auto-approve",
      policyCommitSha: "p2",
      policyHash: "h0",
    }));
    const good: S09Obs = {
      p1: "p1",
      p2: "p2",
      restoreSkipped: false,
      mid,
      end,
      mainIsStarter: true,
      h0: "h0",
      prs1and7: [2, 7],
      pr1: 2,
    };
    exhaustive(evaluateS09, good, env("live"), {
      "s09.mid.sha": (x) => {
        at(x.mid, 2).policyCommitSha = "old";
      },
      "s09.mid.require2.pr2": (x) => {
        at(x.mid, 0).title = "Would require 1 human";
      },
      "s09.mid.require2.pr7": (x) => {
        at(x.mid, 1).outcome = "would_approve";
      },
      "s09.end.sha": (x) => {
        at(x.end, 1).policyHash = "h1";
      },
      "s09.main.restored": (x) => {
        x.mainIsStarter = false;
      },
      "s09.end.pr1": (x) => {
        at(x.end, 0).outcome = "would_require";
      },
    });
    const none = tweak(good, (x) => {
      for (const p of x.end) {
        Object.assign(p, { outcome: "would_require", title: "Would require 1 human (default)" });
      }
    });
    exhaustive(evaluateS09, none, env("none"), {
      "s09.end.pr1": (x) => {
        at(x.end, 0).title = "Would require 2 humans";
      },
    });
  });

  it("U-LIVE-SCEN-10 s10: the attempt is a 2xx redelivery and nothing changes", () => {
    const good: S10Obs = {
      attempt: { redelivery: true, statusCode: 200, sameGuid: true },
      fingerprintStable: true,
      changed: [],
      logDuplicate: null,
    };
    exhaustive(evaluateS10, good, env("live"), {
      "s10.attempt": (x) => {
        x.attempt = { redelivery: true, statusCode: 500, sameGuid: true };
      },
      "s10.stable": (x) => {
        x.fingerprintStable = false;
        x.changed = ["cards"];
      },
    });
    expect(
      evaluateS10(
        tweak(good, (x) => {
          x.logDuplicate = false;
        }),
        env("live"),
      ).find((a) => a.id === "s10.log.duplicate")?.ok,
    ).toBe(false);
    expect(
      failedIds(
        evaluateS10(
          tweak(good, (x) => {
            x.logDuplicate = true;
          }),
          env("live"),
        ),
      ),
    ).toEqual([]);
    // A new guid is evidence (A17), not a failure of the scenario.
    expect(
      failedIds(
        evaluateS10(
          { ...good, attempt: { redelivery: true, statusCode: 202, sameGuid: false } },
          env("live"),
        ),
      ),
    ).toEqual([]);
  });

  it("U-LIVE-SCEN-11 b1: exit 0, dry run, PR count and no new baseline run", () => {
    const good = {
      code: 0,
      firstLine: "dry run: nothing written. 8 PRs (0 excluded), 40 requests\n",
      prCount: 8,
      runPrs: 7,
      runsBefore: 0,
      runsAfter: 0,
    };
    exhaustive(evaluateB1, good, env("live"), {
      "b1.exit": (x) => {
        x.code = 1;
      },
      "b1.dry-run": (x) => {
        x.firstLine = "8 PRs (0 excluded)";
      },
      "b1.pr-count": (x) => {
        x.prCount = 3;
      },
      "b1.no-write": (x) => {
        x.runsAfter = 1;
      },
    });
  });

  it("U-LIVE-SCEN-12 b2: GET only against the source and nothing written", () => {
    const good = {
      code: 0,
      firstLine: "dry run: nothing written. 0 PRs (0 excluded), 3 requests\n",
      prCount: 0,
      runPrs: 0,
      runsBefore: 0,
      runsAfter: 0,
      nonGetToSource: 0,
    };
    exhaustive(evaluateB2, good, env("live"), {
      "b2.exit": (x) => {
        x.code = 2;
      },
      "b2.dry-run": (x) => {
        x.firstLine = "1 PRs";
      },
      "b2.get-only": (x) => {
        x.nonGetToSource = 1;
      },
      "b2.no-write": (x) => {
        x.runsAfter = 1;
      },
    });
  });
});
