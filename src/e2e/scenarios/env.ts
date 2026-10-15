import type { RunCtx } from "../types.js";
import type { EvalEnv } from "./common.js";

/** What the evaluators need to know about the run. */
export function envOfCtx(run: RunCtx): EvalEnv {
  return {
    mode: run.llmMode ?? "none",
    interactive: run.opts.interactive,
    outsiderMode: !run.outsider
      ? "none"
      : run.sandbox.visibility === "private"
        ? "collaborator"
        : "fork",
    owner: run.owner,
    actor: run.actor.login,
    runDay: run.deps.now().toISOString().slice(0, 10),
    waitCron: run.opts.waitCron,
  };
}
