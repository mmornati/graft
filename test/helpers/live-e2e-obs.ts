/** Canned observations for the scenario evaluators (no GitHub, no database). */
import type { CheckObs, PrObs } from "../../src/e2e/observe.js";
import { scenarioFails } from "../../src/e2e/report.js";
import type { AssertionResult, ScenarioResult } from "../../src/e2e/report-schema.js";

export const checks = (title = "Would auto-approve", conclusion = "neutral"): CheckObs[] =>
  ["graft/provenance", "graft/intent", "graft/policy"].map((name, i) => ({
    id: 10 + i,
    name,
    status: "completed",
    conclusion,
    title: name === "graft/intent" ? null : name === "graft/policy" ? title : "Agent-authored",
    completedAt: "2026-10-15T10:00:00.000Z",
    hasActions: name === "graft/intent",
  }));

/** A PrObs whose card, verdict, provenance and change exist. */
export type FullPr = PrObs & {
  card: NonNullable<PrObs["card"]>;
  verdict: NonNullable<PrObs["verdict"]>;
  provenance: NonNullable<PrObs["provenance"]>;
  change: NonNullable<PrObs["change"]>;
};

export function prObs(over: Partial<PrObs> = {}): FullPr {
  const base: PrObs = {
    number: 2,
    headSha: "a".repeat(40),
    change: {
      id: "c1",
      headSha: "a".repeat(40),
      graftCommentId: 500,
      taskIssueNumber: 1,
      state: "open",
    },
    provenance: {
      headSha: "a".repeat(40),
      authorKind: "agent",
      reason: "trailer",
      agent: "claude-code",
      model: "claude-sonnet-5-5",
      task: "#1",
      commitsTotal: 1,
      commitsWithTrailers: 1,
    },
    card: {
      id: "k1",
      status: "ok",
      failureReason: null,
      riskClass: "trivial",
      riskFloor: "trivial",
      floorRules: [],
      floorReasons: [],
      modelRiskClass: "trivial",
      verifierStatus: "agree",
      linkedIssue: 1,
      behaviorChanges: 1,
      outOfScopeEdits: 0,
      instructionsInData: false,
      writerModel: "claude-sonnet-5-5",
      firstPassModel: "claude-haiku-5-5",
      verifierModel: "claude-haiku-5-5",
      createdAt: "2026-10-15T10:00:00.000Z",
    },
    cardRowsForHead: 1,
    displaysForHead: 1,
    verdict: {
      id: "v1",
      headSha: "a".repeat(40),
      policyStatus: "ok",
      policyCommitSha: "b".repeat(40),
      policyHash: "h0",
      outcome: "would_approve",
      riskClass: "trivial",
      riskFinal: true,
      riskSource: "card",
      policyFileChanged: false,
      humans: null,
      teamConstraints: 0,
      approvalsCurrent: 0,
      approvalUsers: [],
      publishedAt: "2026-10-15T10:00:00.000Z",
      evaluatedAt: "2026-10-15T10:00:00.000Z",
    },
    checks: checks(),
    comment: {
      ours: [500],
      markerComments: 1,
      id: 500,
      updatedAt: "2026-10-15T10:00:05.000Z",
      sections: ["intent", "provenance", "policy"],
      markerCounts: {
        intent: { start: 1, end: 1 },
        provenance: { start: 1, end: 1 },
        policy: { start: 1, end: 1 },
      },
      markerOccurrences: 1,
      html: {
        present: true,
        userMention: false,
        teamMention: false,
        img: false,
        onerror: false,
        exampleHref: false,
        markdownAlert: true,
      },
      flags: {
        policyPlatformCodeSpan: false,
        policyBareTeamMention: false,
        policyVersionIgnored: false,
        provenanceNoTrailers: false,
        sectionInnerMarker: false,
      },
    },
    spend: { rows: 1, tokens: 1100, costUsd: 0.003, unpriced: 0 },
  };
  return { ...base, ...over } as FullPr;
}

/** A deep copy with a change applied to one place. */
export function tweak<T>(value: T, apply: (draft: T) => void): T {
  const copy = structuredClone(value);
  apply(copy);
  return copy;
}

export function asResult(assertions: AssertionResult[]): ScenarioResult {
  return {
    id: "x",
    title: "x",
    status: "pass",
    prs: [],
    startedAt: "2026-10-15T10:00:00.000Z",
    durationMs: 0,
    costUsd: 0,
    tokens: 0,
    assertions,
    invariants: [],
  };
}

export const fails = (assertions: AssertionResult[], lenient = false): boolean =>
  scenarioFails(asResult(assertions), lenient);

export const failedIds = (assertions: AssertionResult[]): string[] =>
  assertions.filter((a) => !a.ok).map((a) => a.id);

/** The element at `i`; a missing one is a bug in the test. */
export function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`no element at ${i}`);
  return v;
}
