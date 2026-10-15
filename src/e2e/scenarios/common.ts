/** Shared building blocks of the scenario modules: assertions, plan context, step helpers. */
import { INTENT_CHECK_NAME } from "../../modules/intent/index.js";
import { POLICY_CHECK_NAME } from "../../modules/policy/index.js";
import { PROVENANCE_CHECK_NAME } from "../../modules/provenance/index.js";
import {
  AGENT_MODEL,
  AGENT_NAME,
  agentTrailers,
  commitMessageOf,
  type FileChange,
} from "../fixtures.js";
import { decideLlmMode } from "../llm-mode.js";
import { deliveryCount, observePr, type PrObs } from "../observe.js";
import { type Act, type Ref, ref, type Step, type StepCtx } from "../plan.js";
import type { AssertionResult } from "../report-schema.js";
import {
  bodySentinelLine,
  commitSentinelParagraph,
  diffSentinelLine,
  type Sentinels,
  withTitleSentinel,
} from "../sentinels.js";
import { isSettled, settleState } from "../settle.js";
import type { LlmMode } from "../types.js";
import { TIMEOUTS } from "../waiters.js";

export type AssertKind = "system" | "model" | "soft";

export function assertion(
  kind: AssertKind,
  id: string,
  expected: unknown,
  observed: unknown,
  ok: boolean,
): AssertionResult {
  return { id, kind, expected, observed, ok };
}

export const eq = (kind: AssertKind, id: string, expected: unknown, observed: unknown) =>
  assertion(kind, id, expected, observed, JSON.stringify(expected) === JSON.stringify(observed));

export const truthy = (kind: AssertKind, id: string, expected: string, observed: boolean) =>
  assertion(kind, id, expected, observed, observed);

/** What the evaluators know about the run. */
export interface EvalEnv {
  mode: LlmMode;
  interactive: boolean;
  outsiderMode: "collaborator" | "fork" | "none";
  owner: string;
  actor: string;
  runDay: string;
  waitCron: boolean;
}

export interface ScenarioDef {
  id: string;
  title: string;
  needs: string[];
  /** Skipped without an outsider token. */
  requiresOutsider?: boolean;
  /** Skipped when the LLM mode is none. */
  requiresLiveLlm?: boolean;
  /** Model runs the scenario is expected to cause (live mode), for the cost bound. */
  modelRuns: number;
  plan(pc: PlanContext): Step[];
}

export interface PlanContext {
  runId: string;
  installationId: number;
  owner: string;
  repo: string;
  actor: string;
  outsider: string | undefined;
  sentinels: Sentinels;
  interactive: boolean;
  outsiderMode: "collaborator" | "fork" | "none";
  waitCron: boolean;
  day: string;
  mode(): LlmMode;
  /** The sentinels planted by another scenario (s06 reuses s01's). */
  sentinelsOf(scenario: string): Sentinels;
}

export const LABEL = "graft-e2e";
export const branchOf = (runId: string, scenario: string): string =>
  `graft-e2e/${runId}/${scenario}`;
export const titlePrefix = (runId: string, scenario: string): string =>
  `[graft-e2e ${runId} ${scenario}] `;

// ---------------------------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------------------------

export const ISSUE_KEY = "run.issue";

export function agentMessage(pc: PlanContext, subject: string): string {
  // The run's issue number is only known at run time: `{{run.issue.number}}` is substituted by
  // the executor (Scope.resolve).
  return commitMessageOf({
    subject,
    sentinel: commitSentinelParagraph(pc.sentinels),
    trailers: agentTrailers(0).map(([k, v]) => [
      k,
      k === "Graft-Task" ? "#{{run.issue.number}}" : v,
    ]),
  });
}

export function humanMessage(pc: PlanContext, subject: string): string {
  return commitMessageOf({ subject, sentinel: commitSentinelParagraph(pc.sentinels) });
}

export function diffLine(path: string, pc: PlanContext): { op: "appendLine"; line: string } {
  return { op: "appendLine", line: diffSentinelLine(path, pc.sentinels) };
}

export function prTitle(pc: PlanContext, scenario: string, title: string): string {
  return `${titlePrefix(pc.runId, scenario)}${withTitleSentinel(title, pc.sentinels)}`;
}

export function prBody(pc: PlanContext, text: string): string {
  return `${text}\n\n${bodySentinelLine(pc.sentinels)}`;
}

export const commitAct = (
  id: string,
  key: string,
  a: Omit<Extract<Act, { act: "commit" }>, "act">,
): Step => ({ kind: "act", id, key, act: { act: "commit", ...a } });

export const openPrAct = (
  id: string,
  key: string,
  a: Omit<Extract<Act, { act: "openPr" }>, "act" | "labels">,
): Step => ({ kind: "act", id, key, act: { act: "openPr", labels: [LABEL], ...a } });

export const changesOf = (path: string, ops: FileChange["ops"]): FileChange => ({ path, ops });

/** The wait for everything Graft publishes for a head (prSettled, T8). */
export function settleStep(id: string, prKey: string, commitKey: string): Step {
  return {
    kind: "wait",
    id,
    name: "prSettled",
    timeoutMs: TIMEOUTS.cardLive,
    timeoutByMode: { live: TIMEOUTS.cardLive, none: TIMEOUTS.cardNone },
    describe: `${prKey} head ${commitKey}: card, final policy verdict and 3 completed checks`,
    probe: async (sx) => {
      const pr = sx.scope.require<{ number: number }>(prKey);
      const c = sx.scope.require<{ sha: string }>(commitKey);
      const state = await settleState(sx.run, pr.number, c.sha);
      sx.note(state);
      if (!isSettled(state)) return false;
      // D11: the first card of the run decides the LLM mode (when it is not forced).
      if (sx.run.llmMode === undefined)
        decideLlmMode(sx.run, (await observePr(sx.run, pr.number)).card);
      return state;
    },
  };
}

export async function collectPr(sx: StepCtx, prKey: string): Promise<PrObs> {
  const pr = sx.scope.require<{ number: number }>(prKey);
  return observePr(sx.run, pr.number);
}

export const observePrStep = (id: string, key: string, prKey: string): Step => ({
  kind: "observe",
  id,
  key,
  collect: (sx: StepCtx) => collectPr(sx, prKey),
});

export const obsOf = <T = PrObs>(sx: StepCtx, key: string): T => sx.scope.require<T>(key);

export const CHECK_NAMES = {
  provenance: PROVENANCE_CHECK_NAME,
  intent: INTENT_CHECK_NAME,
  policy: POLICY_CHECK_NAME,
} as const;

export type { Ref };
export { AGENT_MODEL, AGENT_NAME, ref };

// ---------------------------------------------------------------------------------------------
// Shared assertions over a PrObs
// ---------------------------------------------------------------------------------------------

export function checkTitle(pr: PrObs, name: string): string {
  return pr.checks.find((c) => c.name === name)?.title ?? "";
}

export const policyTitle = (pr: PrObs): string => checkTitle(pr, POLICY_CHECK_NAME);
export const provenanceTitle = (pr: PrObs): string => checkTitle(pr, PROVENANCE_CHECK_NAME);

export function threeNeutral(id: string, pr: PrObs): AssertionResult {
  const graft = pr.checks.filter((c) => (Object.values(CHECK_NAMES) as string[]).includes(c.name));
  const names = new Set(graft.map((c) => c.name));
  const allNeutral = graft.every((c) => c.status === "completed" && c.conclusion === "neutral");
  return assertion(
    "system",
    id,
    "3 Graft checks completed with conclusion neutral",
    `${names.size} checks: ${graft.map((c) => `${c.name.replace("graft/", "")}=${c.conclusion}`).join(",")}`,
    names.size === 3 && allNeutral,
  );
}

export function oneComment(id: string, pr: PrObs): AssertionResult[] {
  const c = pr.comment;
  const markers = Object.values(c.markerCounts).every((m) => m.start === 1 && m.end === 1);
  return [
    assertion("system", `${id}.one-comment`, "1 Graft comment", c.ours.length, c.ours.length === 1),
    assertion(
      "system",
      `${id}.marker-once`,
      "managed marker once; each section marker once",
      { marker: c.markerOccurrences, sections: c.sections },
      c.markerOccurrences === 1 && markers,
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------------------------

/** Stores the current number of `event[.action]` deliveries under `key`. */
export const countDeliveriesStep = (
  id: string,
  key: string,
  event: string,
  action?: string,
): Step => ({
  kind: "observe",
  id,
  key,
  collect: (sx) => deliveryCount(sx.run, action === undefined ? { event } : { event, action }),
});

/** Waits until more `event[.action]` deliveries were recorded than the count stored at `beforeKey`. */
export const awaitDeliveryStep = (
  id: string,
  beforeKey: string,
  event: string,
  action?: string,
  key?: string,
): Step => ({
  kind: "wait",
  id,
  name: "delivery",
  ...(key ? { key } : {}),
  timeoutMs: TIMEOUTS.delivery,
  describe: `a ${event}${action ? `.${action}` : ""} delivery is recorded`,
  probe: async (sx) => {
    const before = sx.scope.require<number>(beforeKey);
    const now = await deliveryCount(sx.run, action === undefined ? { event } : { event, action });
    sx.note({ before, now });
    return now > before ? now : false;
  },
});
