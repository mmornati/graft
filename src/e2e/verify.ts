/** `graft e2e verify` and `graft e2e report`: re-check or re-render a finished run (T13). */
import path from "node:path";
import {
  capEvidence,
  collectEvidence,
  type Evidence,
  evaluateAssumptions,
  humanTodoStatus,
  readManifest,
} from "./assumptions.js";
import { loadFixtureFiles } from "./fixtures.js";
import { Scope } from "./plan.js";
import { Abort, openSession, type Session } from "./preflight.js";
import { buildReport, updateHumanTodoFile, writeReport } from "./report.js";
import type { ScenarioResult } from "./report-schema.js";
import { abortCode, buildRunCtx, runInvariants } from "./run.js";
import { SecretRegistry, safeIo } from "./secrets.js";
import { loadState, newestRunId, type RunState, saveState } from "./state.js";
import type { E2eDeps, IoLike, RunOptions } from "./types.js";

/** `github.webhook` jobs live one hour after they finish; the last delivery plus a margin. */
export const RETENTION_WAIT_SECONDS = 3900;

export interface VerifyOptions {
  runId?: string | undefined;
  afterRetention: boolean;
  serverLog?: string | undefined;
  workerLog?: string | undefined;
  sandbox?: string | undefined;
  confirm?: string | undefined;
}

async function pickRun(deps: E2eDeps, runId: string | undefined): Promise<RunState> {
  const id = runId ?? (await newestRunId(deps.outDir));
  if (!id) throw new Abort(2, "no run found in the output directory");
  const state = await loadState(deps.outDir, id);
  if (!state) throw new Abort(2, `no state.json for run ${id}`);
  return state;
}

function optionsOf(state: RunState, v: VerifyOptions): RunOptions {
  return {
    sandbox: v.sandbox,
    scenarios: [],
    runId: state.runId,
    dryRun: false,
    interactive: state.options.interactive,
    llm: state.options.llmFlag,
    maxCostUsd: state.options.maxCostUsd,
    lenientModel: state.options.lenientModel,
    waitCron: state.options.waitCron,
    withSourceBaseline: state.options.withSourceBaseline,
    serverLog: v.serverLog,
    workerLog: v.workerLog,
    capture: false,
    timeoutScale: 1,
    confirm: v.confirm,
    json: false,
    onlyOffline: false,
  };
}

export async function verifyCommand(
  deps: E2eDeps,
  rawIo: IoLike,
  v: VerifyOptions,
): Promise<number> {
  let session: Session | undefined;
  try {
    const state = await pickRun(deps, v.runId);
    session = await openSession(deps, rawIo, {
      command: "verify",
      sandboxFlag: v.sandbox ?? state.sandbox.repo,
      confirm: v.confirm,
      runId: state.runId,
    });
    const s = session;
    const io = safeIo(rawIo, s.secrets);
    const opts = optionsOf(state, v);
    if (v.afterRetention) {
      const last = await s.db
        .selectFrom("webhook_deliveries")
        .select((eb) => eb.fn.max("received_at").as("at"))
        .where("installation_id", "=", state.sandbox.installationId)
        .where("received_at", ">=", new Date(state.startedAt))
        .executeTakeFirst();
      const at = last?.at ? new Date(last.at as unknown as string | Date) : null;
      if (at && deps.now().getTime() - at.getTime() < RETENTION_WAIT_SECONDS * 1000) {
        throw new Abort(
          3,
          `too early for --after-retention: wait until ${new Date(at.getTime() + RETENTION_WAIT_SECONDS * 1000).toISOString()}`,
        );
      }
    }
    const fixtures = await loadFixtureFiles(deps.rootDir);
    const run = buildRunCtx(deps, rawIo, s, opts, state.runId, fixtures);
    run.llmMode = state.llmMode ?? undefined;
    const scope = new Scope(state.scope);
    const inv = await runInvariants(run, state, scope, {
      since: new Date(state.startedAt),
      afterRetention: v.afterRetention,
    });
    state.sentinelHits = inv.hits;

    const synthetic: ScenarioResult = {
      id: "verify",
      title: `Verification${v.afterRetention ? " after retention" : ""}`,
      status: inv.results.some((r) => r.status === "fail") ? "fail" : "pass",
      prs: [],
      startedAt: deps.now().toISOString(),
      durationMs: 0,
      costUsd: 0,
      tokens: 0,
      assertions: [],
      invariants: inv.results,
    };
    state.scenarios = [...state.scenarios.filter((r) => r.id !== "verify"), synthetic];

    const statuses: Record<string, "pass" | "fail" | "skipped" | undefined> = {};
    for (const r of state.scenarios) if (r.id !== "verify") statuses[r.id] = r.status;
    const evidence = await collectEvidence(run, {
      scenarios: statuses,
      scope: state.scope,
      prior: state.evidence as Evidence,
      afterRetention: v.afterRetention,
      runStartedAt: new Date(state.startedAt),
    });
    state.evidence = evidence as RunState["evidence"];
    const manifest = await readManifest(deps.rootDir);
    const assumptions = evaluateAssumptions({
      evidence,
      scenarios: statuses,
      interactive: state.options.interactive,
      waitCron: state.options.waitCron,
      llmMode: state.llmMode ?? undefined,
      appId: s.config.githubAppId,
      slug: s.config.githubAppSlug,
      models: { fast: s.config.llmModelFast, strong: s.config.llmModelStrong },
      manifest,
    }).map((a) => ({ ...a, evidence: capEvidence(a.evidence, s.secrets) }));
    state.assumptions = assumptions;
    const failed = state.scenarios.some((r) => r.status === "fail");
    state.exitCode = failed ? 1 : 0;
    state.finishedAt = deps.now().toISOString();
    await saveState(deps.outDir, state, s.secrets);
    const report = buildReport(state, {
      assumptions,
      humanTodo: humanTodoStatus(assumptions, statuses),
      exitCode: state.exitCode,
      finishedAt: state.finishedAt,
    });
    const written = await writeReport(run.runDir, report, s.secrets);
    for (const r of inv.results) io.out(`${r.id}: ${r.status} ${r.detail}\n`);
    io.out(`report: ${written.mdPath}\n`);
    return state.exitCode;
  } catch (err) {
    return abortCode(err, rawIo, session?.secrets);
  } finally {
    await session?.releaseLock().catch(() => undefined);
    await session?.close();
  }
}

export interface ReportOptions {
  runId?: string | undefined;
  updateHumanTodo: boolean;
}

/** Re-renders the report from `state.json` (no network); optionally ticks HUMAN-TODO. */
export async function reportCommand(
  deps: E2eDeps,
  rawIo: IoLike,
  o: ReportOptions,
): Promise<number> {
  const secrets = new SecretRegistry();
  try {
    const state = await pickRun(deps, o.runId);
    const io = safeIo(rawIo, secrets);
    const statuses: Record<string, "pass" | "fail" | "skipped" | undefined> = {};
    for (const r of state.scenarios) if (r.id !== "verify") statuses[r.id] = r.status;
    const humanTodo = humanTodoStatus(state.assumptions, statuses);
    const report = buildReport(state, {
      assumptions: state.assumptions,
      humanTodo,
      exitCode: state.exitCode ?? 0,
      finishedAt: state.finishedAt ?? deps.now().toISOString(),
    });
    const written = await writeReport(path.join(deps.outDir, state.runId), report, secrets);
    io.out(`report: ${written.mdPath}\n`);
    if (o.updateHumanTodo) {
      const file = path.join(deps.rootDir, "docs", "phase-0", "HUMAN-TODO.md");
      const res = await updateHumanTodoFile(
        file,
        humanTodo
          .filter((h) => h.resolvable)
          .map((h) => ({ anchor: h.anchor, kind: h.kind, assumptions: h.assumptions })),
        { runId: state.runId, date: deps.now().toISOString().slice(0, 10) },
      );
      io.out(
        res.ticked.length + res.noted.length === 0
          ? "HUMAN-TODO: nothing to update\n"
          : `HUMAN-TODO: ticked ${res.ticked.join(", ") || "-"}; noted ${res.noted.join(", ") || "-"}\n`,
      );
    }
    return 0;
  } catch (err) {
    return abortCode(err, rawIo);
  }
}
