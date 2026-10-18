/** `graft e2e run`: preflight, scenarios, invariants, assumptions and the report. */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { RateLimitAbort } from "../github/rate-limit.js";
import { PROMPT_VERSION } from "../modules/intent/index.js";
import {
  capEvidence,
  collectEvidence,
  type Evidence,
  evaluateAssumptions,
  humanTodoStatus,
  readManifest,
} from "./assumptions.js";
import { Capture } from "./capture.js";
import { mayStart, PRICING_VERIFIED_AT, runCostBoundUsd } from "./cost.js";
import { executeSteps, printPlan, RUN_PRS_KEY } from "./executor.js";
import { loadFixtureFiles } from "./fixtures.js";
import { GuardRefusal, RUN_ID_RE } from "./guard.js";
import { evaluateInv5, inv1, inv2, inv3, inv4, spendFacts as inv5Facts } from "./invariants.js";
import { Scope } from "./plan.js";
import { Abort, openSession, type Session } from "./preflight.js";
import { buildReport, scenarioFails, writeReport } from "./report.js";
import type { InvariantResult, ScenarioResult, SkipReason } from "./report-schema.js";
import type { PlanContext, ScenarioDef } from "./scenarios/common.js";
import { selectScenarios } from "./scenarios/index.js";
import { addIdentityToken, describeError, SecretRegistry, safeIo } from "./secrets.js";
import { newSentinels } from "./sentinels.js";
import { loadState, newRunId, type RunState, runDirOf, saveState } from "./state.js";
import type { E2eDeps, IoLike, RunCtx, RunOptions } from "./types.js";

/** Scenarios that open PRs plant sentinels (one set per scenario). */
const SENTINEL_SCENARIOS = new Set(["s01", "s02", "s03", "s04", "s05", "s07", "s08"]);

async function gitInfo(deps: E2eDeps): Promise<{ commit: string; dirty: boolean }> {
  try {
    const head = await deps.spawn("git", ["rev-parse", "HEAD"], { cwd: deps.rootDir });
    const status = await deps.spawn("git", ["status", "--porcelain"], { cwd: deps.rootDir });
    return {
      commit: head.code === 0 ? head.stdout.trim().slice(0, 40) : "unknown",
      dirty: status.code === 0 && status.stdout.trim() !== "",
    };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

export function planBoundUsd(
  selected: readonly ScenarioDef[],
  strongModel: string,
  llm: "auto" | "live" | "none",
): number {
  if (llm === "none") return 0;
  const per = runCostBoundUsd(strongModel);
  return selected.reduce((n, s) => n + s.modelRuns * per, 0);
}

function planContext(run: RunCtx, state: RunState, id: string, day: string): PlanContext {
  return {
    runId: run.runId,
    installationId: run.installationId,
    owner: run.owner,
    repo: run.repo,
    actor: run.actor.login,
    outsider: run.outsider?.login,
    sentinels: state.sentinels[id] ?? newSentinels(run.deps.random),
    interactive: run.opts.interactive,
    outsiderMode: !run.outsider
      ? "none"
      : run.sandbox.visibility === "private"
        ? "collaborator"
        : "fork",
    waitCron: run.opts.waitCron,
    day,
    mode: () => run.llmMode ?? "live",
    sentinelsOf: (scenario) => state.sentinels[scenario] ?? newSentinels(run.deps.random),
  };
}

export async function runInvariants(
  run: RunCtx,
  state: RunState,
  scope: Scope,
  o: { since: Date; afterRetention?: boolean },
): Promise<{ results: InvariantResult[]; hits: ReturnType<typeof classified> }> {
  const prs = scope.get<number[]>(RUN_PRS_KEY) ?? [];
  const guarded = async (
    id: string,
    fn: () => Promise<InvariantResult>,
  ): Promise<InvariantResult> => {
    try {
      return await fn();
    } catch (err) {
      return { id, status: "fail", detail: `could not be checked: ${describeError(err)}` };
    }
  };
  const results: InvariantResult[] = [];
  results.push(await guarded("INV-1", () => inv1(run, prs)));
  results.push(await guarded("INV-2", () => inv2(run, prs)));
  const sentinels = Object.values(state.sentinels).flatMap((s) => [s.T, s.B, s.C, s.D]);
  let hits: ReturnType<typeof classified> = [];
  results.push(
    await guarded("INV-3", async () => {
      const r = await inv3(run, { sentinels, afterRetention: o.afterRetention === true });
      hits = classified(r.hits, state);
      return r.result;
    }),
  );
  const mode = run.llmMode ?? "none";
  results.push(await guarded("INV-4", () => inv4(run, mode)));
  results.push(
    await guarded("INV-5", async () => {
      const changeIds: string[] = [];
      for (const n of prs) {
        const ch = await run.db
          .selectFrom("changes")
          .select("id")
          .where("repository_id", "=", run.repositoryId)
          .where("pr_number", "=", n)
          .executeTakeFirst();
        if (ch) changeIds.push(ch.id);
      }
      return evaluateInv5(mode, await inv5Facts(run, { since: o.since, changeIds }));
    }),
  );
  return { results, hits };
}

function classified(
  hits: readonly {
    sentinel: string;
    kind: string;
    table: string;
    key: string;
    class: "echo" | "accounted" | "fail";
    deadline?: string;
  }[],
  state: RunState,
): RunState["sentinelHits"] {
  const owner = new Map<string, string>();
  for (const [scenario, s] of Object.entries(state.sentinels)) {
    for (const v of [s.T, s.B, s.C, s.D]) owner.set(v, scenario);
  }
  const seen = new Set<string>();
  const out: RunState["sentinelHits"] = [];
  for (const h of hits) {
    const scenario = owner.get(h.sentinel) ?? "?";
    const id = `${scenario}|${h.kind}|${h.table}|${h.key}|${h.class}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      scenario,
      kind: h.kind,
      table: h.table,
      key: h.key,
      class: h.class,
      ...(h.deadline ? { deadline: h.deadline } : {}),
    });
  }
  return out;
}

function skipResult(def: ScenarioDef, reason: SkipReason, at: Date): ScenarioResult {
  return {
    id: def.id,
    title: def.title,
    status: "skipped",
    skipReason: reason,
    prs: [],
    startedAt: at.toISOString(),
    durationMs: 0,
    costUsd: 0,
    tokens: 0,
    assertions: [],
    invariants: [],
  };
}

const SKIP_NOTICE: Record<SkipReason, string> = {
  needs_outsider: "needs an outsider token (GRAFT_E2E_OUTSIDER_TOKEN)",
  needs_live_llm: "needs a live card (the model is not configured)",
  budget: "the cost bound would cross --max-cost-usd",
  dependency_failed: "a scenario it needs did not pass",
  not_selected: "not selected",
};

function freshState(
  run: RunCtx,
  git: { commit: string; dirty: boolean },
  estimate: number,
): RunState {
  return {
    version: 1,
    runId: run.runId,
    target: run.deps.target ?? "github",
    startedAt: run.deps.now().toISOString(),
    finishedAt: null,
    sandbox: {
      repo: run.sandbox.repo,
      visibility: run.sandbox.visibility,
      outsiderMode: !run.outsider
        ? "none"
        : run.sandbox.visibility === "private"
          ? "collaborator"
          : "fork",
      installationId: run.installationId,
      repositoryId: run.repositoryId,
    },
    actor: run.actor,
    outsider: run.outsider ?? null,
    options: {
      interactive: run.opts.interactive,
      dryRun: run.opts.dryRun,
      lenientModel: run.opts.lenientModel,
      maxCostUsd: run.opts.maxCostUsd,
      estimateUsd: estimate,
      llmFlag: run.opts.llm,
      waitCron: run.opts.waitCron,
      withSourceBaseline: run.opts.withSourceBaseline,
    },
    graft: {
      appId: run.config.githubAppId,
      gitCommit: git.commit,
      dirty: git.dirty,
      promptVersion: PROMPT_VERSION,
      pricingVerifiedAt: PRICING_VERIFIED_AT,
    },
    llmMode: null,
    scope: {},
    sentinels: {},
    issueNumber: null,
    scenarios: [],
    evidence: {},
    sentinelHits: [],
    lastDeliveryAt: null,
    spentUsd: 0,
    tokens: 0,
    assumptions: [],
    exitCode: null,
  };
}

async function spendBetween(
  run: RunCtx,
  from: Date,
  to: Date,
): Promise<{ usd: number; tokens: number }> {
  const r = await sql<{ usd: string; tokens: string }>`
    select coalesce(sum(cost_usd), 0)::text as usd, coalesce(sum(tokens), 0)::text as tokens
    from intent_spend where repository_id = ${run.repositoryId}
      and spent_at >= ${from} and spent_at <= ${new Date(to.getTime() + 2000)}`.execute(run.db);
  return { usd: Number(r.rows[0]?.usd ?? 0), tokens: Number(r.rows[0]?.tokens ?? 0) };
}

export async function runCommand(deps: E2eDeps, rawIo: IoLike, opts: RunOptions): Promise<number> {
  if (opts.onlyOffline) return runOffline(deps, rawIo, opts);
  let session: Session | undefined;
  try {
    session = await openSession(deps, rawIo, {
      command: "run",
      sandboxFlag: opts.sandbox,
      confirm: opts.confirm,
      ...(opts.runId ? { runId: opts.runId } : {}),
      acquireLock: !opts.dryRun,
    });
    return await runWithSession(deps, rawIo, session, opts);
  } catch (err) {
    return abortCode(err, rawIo, session?.secrets);
  } finally {
    await session?.releaseLock().catch(() => undefined);
    await session?.close();
  }
}

export function abortCode(err: unknown, io: IoLike, secrets?: SecretRegistry): number {
  const say = (s: string) => io.err(`${secrets ? secrets.redact(s) : s}\n`);
  if (err instanceof Abort) {
    say(err.line);
    return err.code;
  }
  if (err instanceof GuardRefusal) {
    say(err.message);
    return 3;
  }
  if (err instanceof RateLimitAbort) {
    say(err.message);
    return 3;
  }
  say(`unexpected error (${err instanceof Error ? err.name : "unknown"}): ${describeError(err)}`);
  return 1;
}

const plusDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Builds the run context shared by `run` and `verify`. */
export function buildRunCtx(
  deps: E2eDeps,
  rawIo: IoLike,
  s: Session,
  opts: RunOptions,
  runId: string,
  fixtures: Map<string, string>,
): RunCtx {
  const io = safeIo(rawIo, s.secrets);
  return {
    deps,
    io,
    secrets: s.secrets,
    config: s.config,
    sandboxConfig: s.sandboxConfig,
    sandbox: s.sandbox,
    owner: s.owner,
    repo: s.repo,
    runId,
    opts,
    clients: s.clients,
    db: s.db,
    actor: s.actor,
    actorToken: s.actorToken,
    outsider: s.outsider,
    installationId: s.installationId,
    repositoryId: s.repositoryId,
    clock: { now: () => deps.now().getTime(), sleep: deps.sleep },
    runDir: runDirOf(deps.outDir, runId),
    llmMode: opts.llm === "auto" ? undefined : opts.llm,
    pullRequestIds: s.guard.pullRequestIds,
    get forkVerified() {
      return s.guard.forkVerified;
    },
    set forkVerified(v: boolean) {
      s.guard.forkVerified = v;
    },
    fixtures,
    actorOctokit: s.clients.actor,
  };
}

async function runWithSession(
  deps: E2eDeps,
  rawIo: IoLike,
  s: Session,
  opts: RunOptions,
): Promise<number> {
  const random = deps.random ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const now = deps.now();
  const day = now.toISOString().slice(0, 10);
  const runId = opts.runId ?? newRunId(now, random);
  s.guard.deletableRuns = runId;
  if (!RUN_ID_RE.test(runId)) throw new Abort(2, "--run-id must look like e2e-YYYYMMDD-xxxxxx");
  const fixtures = await loadFixtureFiles(deps.rootDir);
  const run = buildRunCtx(deps, rawIo, s, opts, runId, fixtures);
  const io = run.io;

  const existing = opts.runId ? await loadState(deps.outDir, runId) : null;
  const strong = s.config.llmModelStrong;
  let selected = selectScenarios(opts.scenarios, opts.withSourceBaseline);
  if (existing) {
    // Reuse the PRs of an earlier run: needs that already passed are not run again.
    const done = new Set(existing.scenarios.filter((x) => x.status === "pass").map((x) => x.id));
    selected = selected.filter((d) => opts.scenarios.includes(d.id) || !done.has(d.id));
  }
  const estimate = planBoundUsd(selected, strong, opts.llm);
  if (estimate > opts.maxCostUsd) {
    throw new Abort(
      3,
      `budget: the plan's cost bound $${estimate.toFixed(2)} exceeds --max-cost-usd $${opts.maxCostUsd}`,
    );
  }
  const git = await gitInfo(deps);
  const state = existing ?? freshState(run, git, estimate);
  if (existing) run.llmMode = opts.llm === "auto" ? (existing.llmMode ?? undefined) : opts.llm;
  state.options.estimateUsd = estimate;
  const scope = new Scope(state.scope);
  for (const d of selected) {
    if (SENTINEL_SCENARIOS.has(d.id) && !state.sentinels[d.id])
      state.sentinels[d.id] = newSentinels(random);
  }

  io.out(
    `Graft live e2e run ${runId} on ${s.sandbox.repo} (${opts.dryRun ? "dry run" : "live"})\n`,
  );
  io.out(
    `cost bound $${estimate.toFixed(2)} of $${opts.maxCostUsd.toFixed(2)}; outsider: ${run.outsider ? "yes" : "no"}\n`,
  );

  // ---- dry run -----------------------------------------------------------------------------
  if (opts.dryRun) {
    const ids = new Set(selected.map((d) => d.id));
    for (const def of selected) {
      io.out(`== ${def.id} ${def.title}\n`);
      const reason = skipReasonFor(def, run, ids);
      if (reason) io.out(`  would be skipped: ${SKIP_NOTICE[reason]}\n`);
      printPlan(new Scope({}), def.plan(planContext(run, state, def.id, day)), (l) => io.out(l));
    }
    return 0;
  }

  await mkdir(deps.outDir, { recursive: true, mode: 0o700 });
  const capture = opts.capture
    ? new Capture(path.join(run.runDir, "capture"), s.secrets, {
        runId,
        graftCommit: git.commit,
        sandbox: s.sandbox.repo,
        appId: s.config.githubAppId,
        createdAt: now.toISOString(),
      })
    : undefined;
  let currentScenario = "run";
  if (capture) {
    s.exchange.fn = (ex) =>
      void capture.api(ex, currentScenario, deps.now().toISOString()).catch(() => undefined);
  }

  const save = () => saveState(deps.outDir, state, s.secrets);
  await save();
  const statusOf = new Map<string, "pass" | "fail" | "skipped">();
  for (const r of existing?.scenarios ?? []) statusOf.set(r.id, r.status);
  const manifest = await readManifest(deps.rootDir);
  const lenient = opts.lenientModel;
  let stop = false;

  const hooks = {
    afterStep: async () => {
      state.llmMode = run.llmMode ?? null;
      await save();
    },
    confirm: async (instruction: string, question: string) => {
      io.out(`\n${instruction}\n`);
      return deps.prompt(`${question} `);
    },
    print: (l: string) => io.out(l),
  };

  for (const def of selected) {
    const startedAt = deps.now();
    currentScenario = def.id;
    const finish = async (r: ScenarioResult) => {
      state.scenarios = [...state.scenarios.filter((x) => x.id !== r.id), r];
      statusOf.set(r.id, r.status);
      await save();
    };
    const reason = stop
      ? "dependency_failed"
      : skipReasonFor(def, run, new Set(selected.map((d) => d.id)), statusOf, {
          spent: state.spentUsd,
          max: opts.maxCostUsd,
          bound: runCostBoundUsd(strong) * def.modelRuns,
        });
    if (reason) {
      io.out(`${def.id}: skipped, ${SKIP_NOTICE[reason]}\n`);
      await finish(skipResult(def, reason, startedAt));
      continue;
    }
    io.out(`${def.id}: ${def.title}\n`);
    const steps = def.plan(planContext(run, state, def.id, day));
    const exec = await executeSteps(run, scope, def.id, steps, hooks);
    if (exec.error?.name === "LlmStop") stop = true;
    const finished = deps.now();
    const inv = await runInvariants(run, state, scope, { since: startedAt });
    state.sentinelHits = inv.hits;
    const spend = await spendBetween(run, startedAt, finished).catch(() => ({ usd: 0, tokens: 0 }));
    state.spentUsd += spend.usd;
    state.tokens += spend.tokens;
    const prs: ScenarioResult["prs"] = [];
    const prValue = scope.get<{ number: number; url: string; headSha: string }>(`${def.id}.pr`);
    if (prValue) {
      let head = prValue.headSha;
      try {
        const { data } = await run.actorOctokit.rest.pulls.get({
          owner: run.owner,
          repo: run.repo,
          pull_number: prValue.number,
        });
        head = data.head.sha;
      } catch {
        // keep the head recorded at creation
      }
      prs.push({ key: `${def.id}.pr`, number: prValue.number, url: prValue.url, headSha: head });
    }
    if (capture) {
      await capture
        .webhooks(run.clients.app, {
          since: startedAt,
          scenario: def.id,
          installationId: run.installationId,
        })
        .catch(() => 0);
    }
    const result: ScenarioResult = {
      id: def.id,
      title: def.title,
      status: "pass",
      prs,
      startedAt: startedAt.toISOString(),
      durationMs: finished.getTime() - startedAt.getTime(),
      costUsd: spend.usd,
      tokens: spend.tokens,
      assertions: exec.assertions,
      invariants: inv.results,
      ...(exec.error ? { error: exec.error } : {}),
    };
    result.status = scenarioFails(result, lenient) ? "fail" : "pass";
    io.out(`${def.id}: ${result.status}\n`);
    await finish(result);
  }

  // ---- assumptions ---------------------------------------------------------------------------
  const scenarioStatus: Record<string, "pass" | "fail" | "skipped" | undefined> = {};
  for (const r of state.scenarios) scenarioStatus[r.id] = r.status;
  let evidence: Evidence = (state.evidence ?? {}) as Evidence;
  try {
    evidence = await collectEvidence(run, {
      scenarios: scenarioStatus,
      scope: state.scope,
      prior: evidence,
      afterRetention: false,
      runStartedAt: new Date(state.startedAt),
    });
  } catch (err) {
    io.err(`evidence collection stopped: ${describeError(err)}\n`);
  }
  state.evidence = evidence as RunState["evidence"];
  const assumptions = evaluateAssumptions({
    evidence,
    scenarios: scenarioStatus,
    interactive: opts.interactive,
    waitCron: opts.waitCron,
    llmMode: run.llmMode,
    appId: s.config.githubAppId,
    slug: s.config.githubAppSlug,
    models: { fast: s.config.llmModelFast, strong },
    manifest,
  }).map((a) => ({ ...a, evidence: capEvidence(a.evidence, s.secrets) }));
  state.assumptions = assumptions;

  const failedAny = state.scenarios.some((r) => r.status === "fail");
  state.exitCode = failedAny ? 1 : 0;
  state.finishedAt = deps.now().toISOString();
  await save();
  const report = buildReport(state, {
    assumptions,
    humanTodo: humanTodoStatus(assumptions, scenarioStatus),
    exitCode: state.exitCode,
    finishedAt: state.finishedAt,
  });
  const written = await writeReport(run.runDir, report, s.secrets);
  io.out(`\nreport: ${written.mdPath}\n`);
  if (opts.json) io.out(`${JSON.stringify(report)}\n`);
  return state.exitCode;
}

function skipReasonFor(
  def: ScenarioDef,
  run: RunCtx,
  selectedIds: ReadonlySet<string>,
  statusOf?: ReadonlyMap<string, "pass" | "fail" | "skipped">,
  budget?: { spent: number; max: number; bound: number },
): SkipReason | null {
  if (statusOf) {
    for (const need of def.needs) {
      const st = statusOf.get(need);
      if (st === "fail" || st === "skipped" || (st === undefined && selectedIds.has(need))) {
        return "dependency_failed";
      }
    }
  }
  if (def.requiresOutsider && !run.outsider) return "needs_outsider";
  if (def.requiresLiveLlm && run.llmMode === "none") return "needs_live_llm";
  if (budget && !mayStart({ maxUsd: budget.max, spentUsd: budget.spent }, budget.bound))
    return "budget";
  return null;
}

/** D17: the whole suite against the fake world, run by vitest (fakes stay in `test/`). */
async function runOffline(deps: E2eDeps, rawIo: IoLike, opts: RunOptions): Promise<number> {
  // The child's output can echo anything in the environment: redact the tokens we hold.
  const secrets = new SecretRegistry();
  for (const [k, v] of Object.entries(deps.env)) {
    if (
      k.startsWith("GRAFT_E2E_") ||
      k === "ANTHROPIC_API_KEY" ||
      k === "ANTHROPIC_AUTH_TOKEN" ||
      k === "SMEE_URL"
    )
      secrets.add(v);
  }
  await addIdentityToken(secrets, deps.env.ANTHROPIC_IDENTITY_TOKEN_FILE);
  const io = safeIo(rawIo, secrets);
  const random = deps.random ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const id = newRunId(deps.now(), random);
  const out = path.join(deps.outDir, `offline-${id}`);
  const env: Record<string, string> = { GRAFT_E2E_OFFLINE_OUT: out };
  if (opts.llm !== "auto") env.GRAFT_E2E_OFFLINE_LLM = opts.llm;
  if (opts.scenarios.length > 0) env.GRAFT_E2E_OFFLINE_SCENARIOS = opts.scenarios.join(",");
  const res = await deps.spawn(
    "pnpm",
    ["exec", "vitest", "run", "--project", "integration", "test/integration/live-e2e.test.ts"],
    { env, cwd: deps.rootDir },
  );
  if (res.code !== 0) {
    io.err("the offline suite failed; last output follows\n");
    io.err(
      `${res.stdout.split("\n").slice(-30).join("\n")}\n${res.stderr.split("\n").slice(-10).join("\n")}\n`,
    );
    return 1;
  }
  io.out(`${path.join(out, "report.md")}\n`);
  return 0;
}

export { plusDays };
