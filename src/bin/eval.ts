/**
 * `pnpm eval <command>`: the evaluation tool (T15, §7). `main` takes everything it touches as
 * injectable dependencies so the whole CLI is testable offline. Exit codes: 0 ok, 1 check
 * failed, 2 usage or configuration error, 3 aborted (declined, budget, rate-limit wait).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { pino } from "pino";
import { ZodError } from "zod";
import { cacheKey, readCache } from "../eval/cache.js";
import { evalCaseJsonSchema, goldStatus } from "../eval/case-schema.js";
import { EvalCryptoError, generateKey, parseKey } from "../eval/crypto.js";
import { type EvalEnv, EvalEnvError, parseEvalEnv } from "../eval/env.js";
import { type AuthorFilter, buildExportClient, ExportError, exportPrs } from "../eval/export.js";
import { type Estimate, EvalConfigError, runEval } from "../eval/harness.js";
import { computeAgreement } from "../eval/kappa.js";
import {
  adjudicate,
  applyLabels,
  assignDouble,
  checkHandle,
  labelInteractive,
} from "../eval/label.js";
import { EvalAbort } from "../eval/rate-limit.js";
import { validateRedactPattern } from "../eval/redact.js";
import {
  checkThresholds,
  diffReports,
  renderMarkdown,
  thresholdsFailed,
  thresholdsSchema,
} from "../eval/report.js";
import { type EvalReport, evalReportJsonSchema, evalReportSchema } from "../eval/report-schema.js";
import {
  type CaseSet,
  createSet,
  EvalCaseError,
  EvalLocationError,
  EvalStoreError,
  insideGitWorkingTree,
  listCaseIds,
  openSet,
  purgeSet,
  readCase,
  strayCaseFiles,
  writePlain,
} from "../eval/store.js";
import { renderCase } from "../eval/terminal.js";
import {
  type AnthropicCredential,
  type AnthropicSettings,
  createAnthropicLlm,
  isClaudeApi,
} from "../llm/anthropic.js";
import type { LlmClient, LlmRequest, LlmResult } from "../llm/types.js";
import { prepareCardInputs } from "../modules/intent/index.js";
import { loadDotEnv } from "./env.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type AnthropicLlmFactoryOptions = AnthropicCredential & AnthropicSettings;

export interface CliDeps {
  env: Record<string, string | undefined>;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  isTTY: boolean;
  fetch: typeof fetch | undefined;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  llmFactory: (o: AnthropicLlmFactoryOptions) => LlmClient;
  git: () => { commit: string | null; dirty: boolean | null };
  cwd: string;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const USAGE = `usage: pnpm eval <command> [flags]
commands:
  keygen                                  print a new GRAFT_EVAL_KEY
  init --set <dir> --kind pilot --consent-ref <text> [--sensitive-paths a,b] [--description t]
  export --set <dir> --repo owner/name --from YYYY-MM-DD --to YYYY-MM-DD [--author agent|bot|any]
         [--sample N] [--dry-run] [--auth app --installation-id N | --auth token] ...
  validate --set <dir>
  show --set <dir> --case <id> [--with-result]
  assign-double --set <dir> [--fraction 0.2] [--min 20] [--seed 1]
  label --set <dir> --as <handle> [--case <id>] [--double-only] [--apply labels.json]
  adjudicate --set <dir> --as <handle> [--case <id>]
  agreement --set <dir> [--json]
  run --set <dir> [--live] [--yes] [--concurrency N] [--max-cost-usd N] [--max-tokens N]
      [--cases a,b] [--tag t] [--no-cache] [--baseline f] [--save-baseline f] [--check] [--strict] [--out dir]
  purge --set <dir> --confirm <setId>
  schema [--write]
exit codes: 0 ok, 1 check failed, 2 usage or configuration error, 3 aborted`;

const OPTIONS = {
  set: { type: "string" },
  kind: { type: "string" },
  "consent-ref": { type: "string" },
  "sensitive-paths": { type: "string" },
  description: { type: "string" },
  repo: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  author: { type: "string" },
  "agent-logins": { type: "string" },
  "agent-coauthor-emails": { type: "string" },
  sample: { type: "string" },
  "min-per-stratum": { type: "string" },
  "max-candidates": { type: "string" },
  seed: { type: "string" },
  redact: { type: "string", multiple: true },
  "redact-host": { type: "string", multiple: true },
  "redact-pattern": { type: "string", multiple: true },
  auth: { type: "string" },
  "installation-id": { type: "string" },
  "min-remaining": { type: "string" },
  "max-wait": { type: "string" },
  "max-requests": { type: "string" },
  "dry-run": { type: "boolean" },
  case: { type: "string" },
  "with-result": { type: "boolean" },
  as: { type: "string" },
  apply: { type: "string" },
  "double-only": { type: "boolean" },
  fraction: { type: "string" },
  min: { type: "string" },
  json: { type: "boolean" },
  live: { type: "boolean" },
  yes: { type: "boolean" },
  concurrency: { type: "string" },
  "max-cost-usd": { type: "string" },
  "max-tokens": { type: "string" },
  cases: { type: "string" },
  tag: { type: "string" },
  "no-cache": { type: "boolean" },
  baseline: { type: "string" },
  "save-baseline": { type: "string" },
  check: { type: "boolean" },
  strict: { type: "boolean" },
  out: { type: "string" },
  confirm: { type: "string" },
  write: { type: "boolean" },
} as const;

type Args = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

function intFlag(
  name: string,
  v: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be an integer`);
  const n = Number(v);
  if (n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}`);
  return n;
}

function numFlag(
  name: string,
  v: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new UsageError(`--${name} must be a number between ${min} and ${max}`);
  }
  return n;
}

function durationMs(name: string, v: string | undefined, defMs: number): number {
  if (v === undefined) return defMs;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(v);
  if (!m) throw new UsageError(`--${name} must look like 30s, 15m or 1h`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "s") as "ms" | "s" | "m" | "h"];
  return Number(m[1]) * unit;
}

function isoDay(name: string, v: string | undefined): Date {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new UsageError(`--${name} must be a date like 2026-06-01`);
  }
  return new Date(`${v}T00:00:00Z`);
}

const csvList = (v: string | undefined, def: readonly string[]): string[] =>
  v === undefined
    ? [...def]
    : v
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x !== "");

function realGit(): { commit: string | null; dirty: boolean | null } {
  try {
    const run = (args: string[]) =>
      execFileSync("git", args, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    return {
      commit: run(["rev-parse", "HEAD"]).trim(),
      dirty: run(["status", "--porcelain"]).trim() !== "",
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

const silentLogger = () => pino({ level: "silent" });

export function realDeps(): CliDeps {
  return {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: Boolean(process.stdin.isTTY),
    fetch: undefined,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    llmFactory: (o) => createAnthropicLlm({ ...o, log: silentLogger() }),
    git: realGit,
    cwd: process.cwd(),
  };
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const pct = (v: number | null): string => (v === null ? "n/a" : String(v));

export async function main(argv: string[], partial: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...realDeps(), ...partial };
  const out = (s: string) => void deps.stdout.write(s);
  const err = (s: string) => void deps.stderr.write(s);
  try {
    return await dispatch(argv, deps, out);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n${USAGE}\n`);
      return 2;
    }
    if (e instanceof EvalAbort) {
      err(`${e.message}\n`);
      return 3;
    }
    if (
      e instanceof EvalStoreError ||
      e instanceof EvalLocationError ||
      e instanceof EvalCryptoError ||
      e instanceof EvalEnvError ||
      e instanceof EvalConfigError ||
      e instanceof EvalCaseError ||
      e instanceof ExportError
    ) {
      err(`${e.message}\n`);
      return 2;
    }
    if (e instanceof ZodError) {
      err(
        `invalid input: ${e.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}\n`,
      );
      return 2;
    }
    throw e;
  }
}

async function dispatch(argv: string[], deps: CliDeps, out: (s: string) => void): Promise<number> {
  const first = argv[0];
  const command = first === undefined || first.startsWith("-") ? "run" : first;
  const rest =
    command === "run" && (first === undefined || first.startsWith("-")) ? argv : argv.slice(1);
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : "bad arguments");
  }
  if (parsed.positionals.length > 0) {
    throw new UsageError(`unexpected argument: ${parsed.positionals[0]}`);
  }
  const a: Args = parsed.values;
  const env = parseEvalEnv(deps.env);

  const setDir = (): string => {
    if (!a.set) throw new UsageError("--set <dir> is required");
    return path.resolve(deps.cwd, a.set);
  };
  const openIt = async (): Promise<CaseSet> =>
    openSet(setDir(), { key: env.evalKey ? parseKey(env.evalKey) : null });
  const evalRoot = (): string =>
    path.resolve(env.evalDir ?? path.join(os.homedir(), ".graft-eval"));

  switch (command) {
    case "keygen":
      out(`${generateKey()}\n`);
      return 0;

    case "schema": {
      const files: [string, Record<string, unknown>][] = [
        ["eval-case.v1.schema.json", evalCaseJsonSchema()],
        ["eval-report.v1.schema.json", evalReportJsonSchema()],
      ];
      if (a.write) {
        const dir = path.join(REPO_ROOT, "eval", "schema");
        await fs.mkdir(dir, { recursive: true });
        for (const [name, schema] of files) await fs.writeFile(path.join(dir, name), json(schema));
        out(`wrote ${files.map(([n]) => `eval/schema/${n}`).join(", ")}\n`);
      } else {
        for (const [, schema] of files) out(json(schema));
      }
      return 0;
    }

    case "init": {
      const dir = setDir();
      const kind = a.kind ?? "pilot";
      if (kind !== "pilot" && kind !== "synthetic")
        throw new UsageError("--kind must be pilot or synthetic");
      if (kind === "pilot" && !env.evalKey) {
        throw new EvalStoreError(
          "GRAFT_EVAL_KEY is required to create a pilot set (pnpm eval keygen)",
        );
      }
      const setId = path.basename(dir).toLowerCase();
      const set = await createSet(
        dir,
        {
          setId,
          kind,
          description: a.description ?? "",
          encrypted: kind === "pilot",
          consentRef: kind === "pilot" ? (a["consent-ref"] ?? null) : null,
          defaultFloorConfig: { extraSensitiveGlobs: csvList(a["sensitive-paths"], []) },
        },
        { key: env.evalKey ? parseKey(env.evalKey) : null, now: deps.now() },
      );
      out(`created ${set.meta.kind} set ${set.meta.setId}\n`);
      return 0;
    }

    case "validate": {
      const set = await openIt();
      const ids = await listCaseIds(set);
      const stray = await strayCaseFiles(set);
      let invalid = 0;
      let labeled = 0;
      let golds = 0;
      let needs = 0;
      let unlabeled = 0;
      for (const id of ids) {
        try {
          const c = await readCase(set, id);
          if (c.labels.length > 0 || c.adjudicated) labeled += 1;
          const s = goldStatus(c);
          if (s === "gold") golds += 1;
          else if (s === "needs_adjudication") needs += 1;
          else unlabeled += 1;
        } catch (e) {
          if (!(e instanceof EvalCaseError)) throw e;
          invalid += 1;
          out(`INVALID ${e.message}\n`);
        }
      }
      for (const f of stray) out(`INVALID stray file in cases/: ${f}\n`);
      out(
        `${ids.length} cases, ${labeled} labeled, ${golds} gold, ${needs} need adjudication, ${unlabeled} unlabeled\n`,
      );
      return invalid + stray.length > 0 ? 1 : 0;
    }

    case "show": {
      const set = await openIt();
      if (!a.case) throw new UsageError("--case <id> is required");
      const c = await readCase(set, a.case);
      let withResult = null;
      if (a["with-result"]) {
        const prepared = prepareCardInputs(c.inputs, {
          models: { fast: env.modelFast, strong: env.modelStrong },
          floor: c.floorConfig,
          timeoutMs: env.llmTimeoutMs,
          deadlineMs: 600_000,
          nowMs: () => deps.now().getTime(),
        });
        withResult =
          (await readCache(set, cacheKey(prepared.inputHash), prepared.inputHash))?.result ?? null;
        if (!withResult) out("(no cached live result for this case)\n");
      }
      out(renderCase(c, { withResult }));
      return 0;
    }

    case "assign-double": {
      const set = await openIt();
      const r = await assignDouble(set, {
        fraction: numFlag("fraction", a.fraction, 0.2, 0, 1),
        min: intFlag("min", a.min, 20, 0, 100000),
        seed: intFlag("seed", a.seed, 1, 0, 2 ** 31),
      });
      out(`double-label target ${r.target}; newly tagged ${r.tagged.length}\n`);
      for (const id of r.tagged) out(`tagged ${id}\n`);
      return 0;
    }

    case "label": {
      const set = await openIt();
      if (!a.as) throw new UsageError("--as <handle> is required");
      checkHandle(a.as);
      if (a.apply) {
        const text = await fs.readFile(path.resolve(deps.cwd, a.apply), "utf8");
        const r = await applyLabels(set, { as: a.as, json: text, now: deps.now() });
        out(`labeled ${r.labeled} cases as ${a.as}\n`);
        return 0;
      }
      const r = await labelInteractive(set, {
        as: a.as,
        ...(a.case ? { caseId: a.case } : {}),
        doubleOnly: Boolean(a["double-only"]),
        io: { input: deps.stdin, output: deps.stdout },
        now: deps.now,
      });
      out(`labeled ${r.labeled} cases as ${a.as}\n`);
      return 0;
    }

    case "adjudicate": {
      const set = await openIt();
      if (!a.as) throw new UsageError("--as <handle> is required");
      const r = await adjudicate(set, {
        as: a.as,
        ...(a.case ? { caseId: a.case } : {}),
        io: { input: deps.stdin, output: deps.stdout },
        now: deps.now,
      });
      out(`adjudicated ${r.adjudicated} cases\n`);
      return 0;
    }

    case "agreement": {
      const set = await openIt();
      const cases = [];
      for (const id of await listCaseIds(set)) cases.push(await readCase(set, id));
      const pairs = computeAgreement(cases);
      if (a.json) {
        out(json(pairs));
        return 0;
      }
      if (pairs.length === 0) out("no labeler pair shares at least 5 cases\n");
      for (const p of pairs) {
        out(
          `${p.a} / ${p.b}: n=${p.n}; risk agreement ${p.risk.agreement}, kappa ${pct(p.risk.kappa)}, weighted ${pct(p.risk.weightedKappa)}; flag kappa ${pct(p.shouldFlag.kappa)}; out-of-scope kappa ${pct(p.outOfScope.kappa)}\n`,
        );
        if (p.disagreeing.length > 0) out(`  disagreeing: ${p.disagreeing.join(", ")}\n`);
        if (p.risk.kappa !== null && p.risk.kappa < 0.6) {
          out(
            "  risk kappa is below 0.6: revise the labeling guide and relabel before trusting metrics\n",
          );
        }
      }
      return 0;
    }

    case "purge": {
      if (!a.confirm) throw new UsageError("purge needs --confirm <setId>");
      const dir = setDir();
      const r = await purgeSet(dir, {
        confirm: a.confirm,
        by: os.userInfo().username,
        now: deps.now(),
        evalRoot: evalRoot(),
      });
      out(`purged ${a.confirm} (${r.caseCount} cases)\n`);
      return 0;
    }

    case "export":
      return runExport(a, env, deps, out, openIt);

    case "run":
      return runCommand(a, env, deps, out, openIt);

    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

async function runExport(
  a: Args,
  env: EvalEnv,
  deps: CliDeps,
  out: (s: string) => void,
  openIt: () => Promise<CaseSet>,
): Promise<number> {
  const from = isoDay("from", a.from);
  const to = isoDay("to", a.to);
  if (!a.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a.repo)) {
    throw new UsageError("--repo owner/name is required");
  }
  const author = a.author ?? "agent";
  if (author !== "agent" && author !== "bot" && author !== "any") {
    throw new UsageError("--author must be agent, bot or any");
  }
  const auth = a.auth ?? "app";
  if (auth !== "app" && auth !== "token") throw new UsageError("--auth must be app or token");
  const redactKinds = a.redact ?? [];
  for (const k of redactKinds) if (k !== "emails") throw new UsageError("--redact accepts: emails");
  const patterns = a["redact-pattern"] ?? [];
  for (const p of patterns) {
    try {
      validateRedactPattern(p);
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : "bad --redact-pattern");
    }
  }
  const lower = (v: string | undefined, def: readonly string[]) =>
    csvList(v, def).map((x) => x.toLowerCase());
  const set = await openIt();
  const { octokit, stats } = await buildExportClient({
    auth,
    ...(a["installation-id"]
      ? { installationId: intFlag("installation-id", a["installation-id"], 0, 1, 2 ** 53) }
      : {}),
    env: {
      GITHUB_APP_ID: env.githubAppId,
      GITHUB_APP_PRIVATE_KEY_PATH: env.githubAppPrivateKeyPath,
      GITHUB_API_URL: env.githubApiUrl,
      GRAFT_EVAL_GITHUB_TOKEN: env.githubToken,
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    sleep: deps.sleep,
    nowMs: () => deps.now().getTime(),
    minRemaining: intFlag("min-remaining", a["min-remaining"], 50, 0, 100000),
    maxWaitMs: durationMs("max-wait", a["max-wait"], 15 * 60_000),
    maxRequests: intFlag("max-requests", a["max-requests"], 5000, 1, 10_000_000),
  });
  const requestLine = () => {
    const w = stats.waits();
    return `requests: ${stats.requests()}, rate-limit waits: ${w.count} (${Math.round(w.totalMs / 1000)}s)\n`;
  };
  try {
    const summary = await exportPrs({
      set,
      repo: a.repo,
      from,
      toExclusive: new Date(to.getTime() + 86_400_000),
      author: author as AuthorFilter,
      agentLogins: lower(a["agent-logins"], env.agentLogins),
      agentCoauthorEmails: lower(a["agent-coauthor-emails"], env.agentCoauthorEmails),
      sample: intFlag("sample", a.sample, 40, 0, 100000),
      minPerStratum: intFlag("min-per-stratum", a["min-per-stratum"], 2, 0, 1000),
      maxCandidates: intFlag("max-candidates", a["max-candidates"], 400, 1, 100000),
      seed: intFlag("seed", a.seed, 1, 0, 2 ** 31),
      redact: {
        emails: redactKinds.includes("emails"),
        hosts: a["redact-host"] ?? [],
        patterns,
      },
      dryRun: Boolean(a["dry-run"]),
      octokit,
      now: deps.now,
      out: (line) => out(`${line}\n`),
    });
    out(
      `done: ${summary.exported} exported, ${summary.skippedNotFound} skipped (not found), ${summary.existing} already present\n`,
    );
  } catch (e) {
    // What was written stays; `main` maps the error to exit 2 (GitHub) or 3 (rate limit).
    out(requestLine());
    throw e;
  }
  out(requestLine());
  return 0;
}

async function runCommand(
  a: Args,
  env: EvalEnv,
  deps: CliDeps,
  out: (s: string) => void,
  openIt: () => Promise<CaseSet>,
): Promise<number> {
  const live = Boolean(a.live);
  if (live && !env.anthropicApiKey && !env.anthropicAuthToken) {
    throw new EvalConfigError("--live needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN");
  }
  const set = await openIt();
  const maxCostUsd = numFlag("max-cost-usd", a["max-cost-usd"], 10, 0, 100000);
  const maxTokens = intFlag("max-tokens", a["max-tokens"], 5_000_000, 0, Number.MAX_SAFE_INTEGER);
  const concurrency = intFlag("concurrency", a.concurrency, live ? 4 : 8, 1, 64);
  const ids = a.cases ? new Set(csvList(a.cases, [])) : null;

  let client: LlmClient | null = null;
  const lazy: LlmClient = {
    complete(req: LlmRequest): Promise<LlmResult> {
      client ??= deps.llmFactory({
        ...(env.anthropicApiKey
          ? { apiKey: env.anthropicApiKey }
          : { authToken: env.anthropicAuthToken as string }),
        ...(env.anthropicBaseUrl ? { baseURL: env.anthropicBaseUrl } : {}),
        maxRetries: env.llmMaxRetries,
        refusalFallback: env.llmRefusalFallback && isClaudeApi(env.anthropicBaseUrl),
      });
      return client.complete(req);
    },
  };

  const confirm = async (e: Estimate): Promise<boolean> => {
    out(
      `estimate: ${e.casesToCall} cases to call, ${e.casesCached} cached, about ${e.estimatedTokens} tokens, upper bound $${e.upperBoundUsd.toFixed(4)} (cap $${maxCostUsd})\n`,
    );
    if (a.yes) return true;
    if (!deps.isTTY) {
      out("no terminal to ask on and no --yes: aborting before any call\n");
      return false;
    }
    out("Continue? [y/N] ");
    const rl = createInterface({ input: deps.stdin });
    try {
      const it = rl[Symbol.asyncIterator]();
      const line = await it.next();
      return !line.done && /^\s*y(es)?\s*$/i.test(line.value);
    } finally {
      rl.close();
    }
  };

  const outcome = await runEval({
    set,
    mode: live ? "live" : "fake",
    ...(live ? { llm: lazy } : {}),
    models: {
      fast: env.modelFast,
      strong: env.modelStrong,
      ...(env.llmRefusalFallbackModel ? { refusalFallback: env.llmRefusalFallbackModel } : {}),
    },
    timeoutMs: env.llmTimeoutMs,
    concurrency,
    maxCostUsd,
    maxTokens,
    useCache: !a["no-cache"],
    ...(ids || a.tag
      ? {
          caseFilter: (id: string, tags: string[]) =>
            (!ids || ids.has(id)) && (!a.tag || tags.includes(a.tag)),
        }
      : {}),
    confirm,
    now: deps.now,
    nowMs: () => deps.now().getTime(),
  });
  if (outcome.aborted) {
    out(
      outcome.reason === "over_budget"
        ? `aborted: the estimate ($${outcome.estimate.upperBoundUsd.toFixed(4)}) exceeds the cap; raise --max-cost-usd or --max-tokens\n`
        : "aborted: not confirmed\n",
    );
    return 3;
  }
  const report: EvalReport = outcome.report;
  report.git = deps.git();

  // Baseline.
  const explicit = a.baseline !== undefined;
  const baselinePath = explicit
    ? path.resolve(deps.cwd, a.baseline as string)
    : set.meta.kind === "synthetic"
      ? path.join(REPO_ROOT, "eval", "baselines", "synthetic.json")
      : path.join(set.dir, "baseline.json");
  let baseline: EvalReport | null = null;
  try {
    baseline = evalReportSchema.parse(JSON.parse(await fs.readFile(baselinePath, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new EvalConfigError("the baseline file is not a valid eval report");
    }
    if (explicit || (a.check && set.meta.kind === "synthetic")) {
      throw new EvalConfigError("the baseline file does not exist");
    }
  }
  const diff = baseline ? diffReports(baseline, report) : null;

  const thresholds = thresholdsSchema.parse(
    JSON.parse(await fs.readFile(path.join(REPO_ROOT, "eval", "thresholds.json"), "utf8")),
  );
  report.thresholds = checkThresholds(report, thresholds, diff);
  report.pass = report.thresholds.every((t) => t.pass);
  const validated = evalReportSchema.parse(report);

  // Output.
  const dirRel = `runs/${report.runId}`;
  const reportJson = json(validated);
  const reportMd = renderMarkdown(validated, diff);
  let where: string;
  if (a.out) {
    const dir = path.resolve(deps.cwd, a.out);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "report.json"), reportJson);
    await fs.writeFile(path.join(dir, "report.md"), reportMd);
    where = dir;
  } else {
    await writePlain(set, `${dirRel}/report.json`, reportJson);
    await writePlain(set, `${dirRel}/report.md`, reportMd);
    where = path.join(set.dir, dirRel);
  }
  if (a["save-baseline"]) {
    const target = path.resolve(deps.cwd, a["save-baseline"]);
    if (set.meta.kind === "pilot" && (await insideGitWorkingTree(path.dirname(target)))) {
      throw new EvalLocationError("a pilot baseline must not be saved inside a git working tree");
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, reportJson);
    out(`baseline saved to ${target}\n`);
  }

  // Summary: ids, classes and numbers only.
  const m = validated.metrics;
  out(
    `${validated.set.setId} (${validated.set.kind}), ${validated.llm} mode, ${validated.set.cases} cases, ${m.scored} scored, prompt ${validated.prompt.promptVersion}\n`,
  );
  out(
    `under-classification: floor ${pct(m.underClassificationFloor)}, model ${pct(m.underClassificationModel)}, final ${pct(m.underClassificationFinal)}; severe final ${pct(m.severeUnderClassificationFinal)}\n`,
  );
  out(
    `accuracy: floor ${pct(m.exactAccuracyFloor)}, final ${pct(m.exactAccuracyFinal)}; unavailable ${pct(m.unavailableRate)}; out-of-scope P/R ${pct(m.outOfScopePrecision)}/${pct(m.outOfScopeRecall)}; flag P/R ${pct(m.flagPrecision)}/${pct(m.flagRecall)}\n`,
  );
  out(
    `cost $${m.costUsd} (${m.tokens.calls} calls)${validated.llm === "fake" ? " [fake: not real spend]" : ""}\n`,
  );
  for (const t of validated.thresholds) {
    const status =
      t.value === null ? "n/a" : t.pass ? "pass" : t.provisional ? "FAIL (provisional)" : "FAIL";
    out(`threshold ${t.name}: ${pct(t.value)} (${t.limit}) ${status}\n`);
  }
  if (diff) {
    for (const r of diff.notComparable) out(`baseline not comparable: ${r}\n`);
    for (const w of diff.warnings) out(`warning: ${w}\n`);
    if (!diff.equal) {
      out("differences from the baseline:\n");
      for (const c of diff.changedCases)
        out(`  ${c.id}: ${c.field} ${c.baseline} -> ${c.current}\n`);
      for (const id of diff.addedCases) out(`  ${id}: added\n`);
      for (const id of diff.removedCases) out(`  ${id}: removed\n`);
      for (const c of diff.metricChanges.filter((x) => !x.name.startsWith("cost"))) {
        out(`  metric ${c.name}: ${pct(c.baseline)} -> ${pct(c.current)}\n`);
      }
    }
  }
  out(`report: ${where}\n`);

  if (a.check) {
    if (thresholdsFailed(validated.thresholds, Boolean(a.strict))) return 1;
    if (!validated.run.complete) return 1;
  }
  return 0;
}

/**
 * `.env` supplies ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) and the GitHub App settings, but never the case-set key
 * (E6: the key lives in the password manager and the shell). A `GRAFT_EVAL_KEY` that only
 * `.env` provided is dropped with a warning on stderr.
 */
export function loadEvalDotEnv(
  env: NodeJS.ProcessEnv,
  load: () => void,
  warn: (s: string) => void,
): void {
  const before = env.GRAFT_EVAL_KEY;
  load();
  if (before === undefined && env.GRAFT_EVAL_KEY !== undefined) {
    delete env.GRAFT_EVAL_KEY;
    warn("warning: GRAFT_EVAL_KEY in .env is ignored; export it in the shell instead\n");
  }
}

// Run only when this file is the entry point (tests import `main`).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadEvalDotEnv(process.env, loadDotEnv, (s) => void process.stderr.write(s));
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      // An unmapped error may carry a snippet of a pilot file: print only its class.
      const detail = process.env.GRAFT_EVAL_DEBUG === "1" && e instanceof Error ? e.message : "";
      console.error(
        `unexpected error (${e instanceof Error ? e.name : "unknown"})${detail ? `: ${detail}` : ""}`,
      );
      process.exit(1);
    },
  );
}
