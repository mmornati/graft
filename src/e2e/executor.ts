/** Runs a scenario's steps (live) or prints them (dry run). */
import { type PrResult, performAct } from "./acts.js";
import { describeStep, performsWrite, type Scope, type Step, type StepCtx } from "./plan.js";
import type { AssertionResult } from "./report-schema.js";
import { describeError } from "./secrets.js";
import type { RunCtx } from "./types.js";
import { scaled, WaitTimeout, waitUntil } from "./waiters.js";

export const RUN_PRS_KEY = "run.prs";

export class StepFailure extends Error {
  constructor(
    readonly stepId: string,
    readonly original: unknown,
  ) {
    super(`step ${stepId} failed`);
    this.name = "StepFailure";
  }
}

export interface ExecResult {
  assertions: AssertionResult[];
  error?: { name: string; message: string };
}

/** The error text for a report: names and statuses, never request bodies or PR text. */
export function reportableError(stepId: string, err: unknown): { name: string; message: string } {
  const name = err instanceof Error ? err.name : "Error";
  if (err instanceof WaitTimeout) {
    return {
      name,
      message: `step ${stepId}: ${err.message}; last observation ${JSON.stringify(err.lastObservation)}`,
    };
  }
  return { name, message: `step ${stepId}: ${describeError(err)}` };
}

export interface ExecHooks {
  /** Called after every step (state.json is written there). */
  afterStep(step: Step): Promise<void>;
  /** The question prompt for manual steps. */
  confirm(instruction: string, question: string): Promise<string>;
  print(line: string): void;
}

export async function executeSteps(
  run: RunCtx,
  scope: Scope,
  scenario: string,
  steps: readonly Step[],
  hooks: ExecHooks,
): Promise<ExecResult> {
  const assertions: AssertionResult[] = [];
  let failure: { name: string; message: string } | undefined;
  const base: StepCtx = { run, scope, scenario, note: () => undefined };

  for (const step of steps) {
    if (failure && !("always" in step && step.always === true)) continue;
    let last: unknown;
    const sx: StepCtx = { ...base, note: (o) => (last = o) };
    try {
      switch (step.kind) {
        case "act": {
          const result = await performAct(sx, step.act);
          if (step.key) scope.set(step.key, result);
          if (step.act.act === "openPr") {
            const list = scope.get<number[]>(RUN_PRS_KEY) ?? [];
            const n = (result as PrResult).number;
            if (!list.includes(n)) scope.set(RUN_PRS_KEY, [...list, n]);
          }
          break;
        }
        case "wait": {
          const mode = run.llmMode ?? "live";
          const base = step.timeoutByMode ? step.timeoutByMode[mode] : step.timeoutMs;
          const value = await waitUntil(
            async () => step.probe(sx) as Promise<unknown>,
            { name: step.id, timeoutMs: scaled(base, run.opts.timeoutScale) },
            run.clock,
          ).catch((err: unknown) => {
            if (err instanceof WaitTimeout)
              throw new WaitTimeout(err.waitName, last ?? err.lastObservation);
            throw err;
          });
          if (step.key) scope.set(step.key, value);
          break;
        }
        case "observe":
          scope.set(step.key, await step.collect(sx));
          break;
        case "assert":
          assertions.push(...step.evaluate(sx));
          break;
        case "manual": {
          if (!run.opts.interactive) {
            hooks.print(`skipped (needs --interactive): ${step.instruction}\n`);
            break;
          }
          const answer = await hooks.confirm(step.instruction, step.question);
          await step.run(sx, answer);
          break;
        }
        case "ops": {
          const log: { method: string; url: string }[] = [];
          const res = await run.deps.ops(step.argv, {
            ...(step.baselineToken ? { baselineToken: run.actorToken, requestLog: log } : {}),
          });
          const nonGetToSource = log.filter(
            (r) => r.method !== "GET" && r.method !== "HEAD",
          ).length;
          scope.set(step.key, { ...res, nonGetToSource });
          break;
        }
        case "custom":
          await step.run(sx);
          break;
      }
      await hooks.afterStep(step);
    } catch (err) {
      failure = reportableError(step.id, err);
      await hooks.afterStep(step).catch(() => undefined);
    }
  }
  return failure ? { assertions, error: failure } : { assertions };
}

/** Prints what a live run would do; performs no write and no `ops` that writes. */
export function printPlan(
  scope: Scope,
  steps: readonly Step[],
  print: (line: string) => void,
): void {
  for (const step of steps) {
    if (step.kind === "observe" || step.kind === "assert" || step.kind === "custom") continue;
    print(`  ${describeStep(step, scope)}${performsWrite(step) ? "" : ""}\n`);
  }
}
