/**
 * The operations half of `pnpm graft` (step 6, T9): `pilot`, `baseline`, `gate`, `incident` and
 * `metrics`. `graft.ts` loads this file with a dynamic import so that `graft policy check` keeps
 * running with an empty environment and without `db`, `config` or `modules` (U-CLI-6).
 *
 * Every command loads `.env` and the configuration (a ConfigError prints its message only and
 * exits 2), opens the database, checks for pending migrations (exit 2, "run pnpm db:migrate"), and
 * closes the database. Exit codes: 0 ok, 1 check failed, 2 usage or configuration error, 3 aborted,
 * 4 `gate report --check` found insufficient data.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { type Config, ConfigError, loadConfig } from "../config/index.js";
import type { JobContext } from "../core/context.js";
import { createLogger } from "../core/logger.js";
import { noSignals } from "../core/signals.js";
import { createDb, type Db } from "../db/client.js";
import { pendingMigrations } from "../db/migrator.js";
import { toTerminalSafe } from "../eval/terminal.js";
import { createGitHubClientFactory, type GitHubClientFactory } from "../github/client-factory.js";
import { classifyGitHubError } from "../github/errors.js";
import { RateLimitAbort } from "../github/rate-limit.js";
import { unconfiguredLlm } from "../llm/index.js";
import { rollupRange, syncReviewers } from "../modules/pilot/index.js";
import {
  type AllowList,
  AllowListError,
  AllowListResolveError,
  parseAllowList,
  resolveAllowList,
} from "../pilot/allow-list.js";
import { writeFileAtomic } from "../pilot/atomic-write.js";
import {
  BaselineUsageError,
  type Period,
  renderAggregates,
  runBaseline,
} from "../pilot/baseline.js";
import { doctorFailed, runDoctor } from "../pilot/doctor.js";
import { GateUsageError, gatherGate } from "../pilot/gate.js";
import { gateReportSchema, renderGateMarkdown } from "../pilot/gate-render.js";
import {
  addIncident,
  IncidentUsageError,
  incidentList,
  removeIncident,
} from "../pilot/incident-cli.js";
import { PurgeRefused, purgeInstallation } from "../pilot/purge.js";
import { PermanentJobError } from "../queue/errors.js";
import { loadDotEnv } from "./env.js";

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** What a command touches; tests inject their own. */
export interface OpsDeps {
  loadConfig(): Config;
  openDb(url: string): Db;
  github(config: Config): GitHubClientFactory;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Replaces a file atomically (tests inject a failing one). */
  writeFileAtomic?(file: string, data: string): Promise<void>;
}

export const defaultDeps: OpsDeps = {
  loadConfig() {
    loadDotEnv();
    return loadConfig(process.env);
  },
  openDb: (url) => createDb(url),
  github: (config) =>
    createGitHubClientFactory({
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
      baseUrl: config.githubApiUrl,
    }),
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const USAGE = `usage:
  graft pilot doctor --installation <id> [--json]
  graft pilot sync-reviewers --installation <id> --since <YYYY-MM-DD>
  graft pilot allow-list resolve <file> --installation <id>
  graft pilot purge --installation <id> --confirm <account login> [--dry-run] [--even-if-active]
  graft baseline --repo <owner/repo> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--period baseline|shadow]
                 [--base <branch>] [--max-requests <n>] [--max-wait <15m>] [--dry-run]
  graft gate report --installation <id> [--installation <id> ...] --since <YYYY-MM-DD>
                    [--until <YYYY-MM-DD>] [--allow-file <path>] [--out <dir>] [--json] [--check]
  graft metrics rollup --installation <id> --from <YYYY-MM-DD> --to <YYYY-MM-DD>
  graft incident add --repo <owner/repo> --pr <n> [--fix-pr <n>] [--occurred-at <ISO>] [--severity 1-4]
  graft incident list --installation <id> [--json]
  graft incident remove --id <uuid>
`;

class UsageError extends Error {
  constructor(message?: string) {
    super(message ?? "usage");
    this.name = "UsageError";
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(name: string, v: string | undefined): Date {
  if (v === undefined || !DATE.test(v)) throw new UsageError(`${name} must be YYYY-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new UsageError(`${name} must be a real date (YYYY-MM-DD)`);
  }
  return d;
}
function parseInstallation(v: string | undefined): number {
  if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1 || !Number.isSafeInteger(Number(v))) {
    throw new UsageError("--installation must be a positive integer");
  }
  return Number(v);
}
function parsePositiveInt(name: string, v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError(`${name} must be a positive integer`);
  return Number(v);
}
function requirePositiveInt(name: string, v: string | undefined): number {
  if (v === undefined) throw new UsageError(`${name} is required`);
  return parsePositiveInt(name, v, 0);
}
function parseDuration(name: string, v: string | undefined, dfltMs: number): number {
  if (v === undefined) return dfltMs;
  const m = /^(\d+)(s|m|h)?$/.exec(v);
  if (!m) throw new UsageError(`${name} must look like 30s, 15m or 1h`);
  const unit = m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1000;
  return Number(m[1]) * unit;
}
const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

function args<T extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>>(
  argv: string[],
  options: T,
) {
  try {
    const r = parseArgs({ args: argv, options, allowPositionals: false, strict: true });
    return r.values as Record<string, string | boolean | string[] | undefined>;
  } catch {
    throw new UsageError();
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A job queue that refuses to be used: CLI-run jobs must not enqueue anything. */
const noQueue = {
  async start() {},
  async stop() {},
  async send() {
    throw new Error("the CLI does not enqueue jobs");
  },
  async schedule() {
    throw new Error("the CLI does not schedule jobs");
  },
  async unschedule() {
    throw new Error("the CLI does not schedule jobs");
  },
  async ping() {
    return false;
  },
} as unknown as JobContext["queue"];

function cliContext(
  config: Config,
  db: Db,
  github: GitHubClientFactory,
  now: () => Date,
): JobContext {
  return {
    db,
    queue: noQueue,
    github,
    log: createLogger({ logLevel: "silent" }),
    clock: { now },
    config,
    llm: unconfiguredLlm(),
    signals: noSignals,
  };
}

interface Run {
  config: Config;
  db: Db;
  deps: OpsDeps;
  out: (s: string) => void;
  err: (s: string) => void;
}

async function pilot(sub: string | undefined, rest: string[], r: Run): Promise<number> {
  if (sub === "doctor") {
    const v = args(rest, { installation: { type: "string" }, json: { type: "boolean" } });
    const checks = await runDoctor(r.db, r.config, {
      installationId: parseInstallation(str(v.installation)),
      now: r.deps.now(),
    });
    if (v.json) r.out(`${JSON.stringify({ checks })}\n`);
    else for (const c of checks) r.out(`${c.status.padEnd(4)}  ${c.id}: ${c.detail}\n`);
    return doctorFailed(checks) ? 1 : 0;
  }
  if (sub === "sync-reviewers") {
    const v = args(rest, { installation: { type: "string" }, since: { type: "string" } });
    const installationId = parseInstallation(str(v.installation));
    const since = parseDate("--since", str(v.since));
    const ctx = cliContext(r.config, r.db, r.deps.github(r.config), r.deps.now);
    const changes = await r.db
      .selectFrom("changes as ch")
      .innerJoin("repositories as r", "r.id", "ch.repository_id")
      .select(["ch.pr_number", "r.id as repository_id", "r.full_name"])
      .where("r.installation_id", "=", installationId)
      .where("r.removed_at", "is", null)
      .where("ch.opened_at", ">=", since)
      .orderBy("ch.opened_at")
      .execute();
    let synced = 0;
    let skipped = 0;
    for (const c of changes) {
      const [owner = "", repo = ""] = c.full_name.split("/");
      try {
        const outcome = await syncReviewers(ctx, {
          installationId,
          repositoryId: c.repository_id,
          owner,
          repo,
          prNumber: c.pr_number,
        });
        if (outcome === "synced") synced++;
        else skipped++;
      } catch (e) {
        if (!(e instanceof PermanentJobError)) throw e;
        skipped++;
      }
    }
    r.out(`reviewers synced for ${synced} PRs, ${skipped} skipped\n`);
    return 0;
  }
  if (sub === "allow-list") {
    if (rest[0] !== "resolve" || rest[1] === undefined || rest[1].startsWith("-")) {
      throw new UsageError();
    }
    const file = rest[1];
    const v = args(rest.slice(2), { installation: { type: "string" } });
    const installationId = parseInstallation(str(v.installation));
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new UsageError("the allow-list file cannot be read");
    }
    // Public user data: an installation token only gives the request a rate limit of its own.
    const octokit = await r.deps.github(r.config).forInstallation(installationId);
    try {
      const res = await resolveAllowList(text, async (login) => {
        try {
          const u = await octokit.rest.users.getByUsername({ username: login });
          return u.data.id;
        } catch (e) {
          if (classifyGitHubError(e) === "not_found") return undefined;
          throw e;
        }
      });
      if (res.resolved > 0) await (r.deps.writeFileAtomic ?? writeFileAtomic)(file, res.text);
      r.out(`resolved ${res.resolved} logins to user IDs\n`);
      if (res.resolved > 0) {
        r.out(
          "check each resolved ID against the person you mean (a login can belong to someone else today)\n",
        );
      }
      return 0;
    } catch (e) {
      if (e instanceof AllowListError) throw new UsageError(e.message);
      if (e instanceof AllowListResolveError) {
        r.err(`${e.message}\n`);
        return 3;
      }
      throw e;
    }
  }
  if (sub === "purge") {
    const v = args(rest, {
      installation: { type: "string" },
      confirm: { type: "string" },
      "dry-run": { type: "boolean" },
      "even-if-active": { type: "boolean" },
    });
    const installationId = parseInstallation(str(v.installation));
    const confirm = str(v.confirm);
    if (confirm === undefined || confirm === "") throw new UsageError("--confirm is required");
    try {
      const res = await purgeInstallation(r.db, {
        installationId,
        schema: r.config.pgbossSchema,
        now: r.deps.now(),
        dryRun: v["dry-run"] === true,
        confirm,
        evenIfActive: v["even-if-active"] === true,
      });
      r.out(`${res.dryRun ? "would delete" : "deleted"} for installation ${installationId}:\n`);
      for (const [table, n] of Object.entries(res.counts)) r.out(`  ${table}: ${n}\n`);
      if (res.purgeId !== null) r.out(`pilot_purges id: ${res.purgeId}\n`);
      return 0;
    } catch (e) {
      if (e instanceof PurgeRefused) {
        r.err(`${e.message}\n`);
        return e.reason === "not_found" ? 2 : 3;
      }
      throw e;
    }
  }
  throw new UsageError();
}

async function baseline(rest: string[], r: Run): Promise<number> {
  const v = args(rest, {
    repo: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    period: { type: "string" },
    base: { type: "string" },
    "max-requests": { type: "string" },
    "max-wait": { type: "string" },
    "dry-run": { type: "boolean" },
  });
  const repo = str(v.repo);
  if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new UsageError("--repo must be owner/repo");
  }
  const from = parseDate("--from", str(v.from));
  const to = parseDate("--to", str(v.to));
  const period = str(v.period) ?? "baseline";
  if (period !== "baseline" && period !== "shadow") {
    throw new UsageError("--period must be baseline or shadow");
  }
  const dryRun = v["dry-run"] === true;
  try {
    const res = await runBaseline(
      {
        db: r.db,
        github: r.deps.github(r.config),
        config: r.config,
        now: () => r.deps.now().getTime(),
        sleep: r.deps.sleep,
        onWait: (ms) => r.err(`waiting ${Math.round(ms / 1000)}s for the GitHub rate limit\n`),
      },
      {
        repo,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        period: period as Period,
        base: str(v.base),
        maxRequests: parsePositiveInt("--max-requests", str(v["max-requests"]), 5000),
        maxWaitMs: parseDuration("--max-wait", str(v["max-wait"]), 15 * 60_000),
        dryRun,
      },
    );
    r.out(
      `${dryRun ? "dry run: nothing written. " : ""}${res.prCount} PRs (${res.excludedCount} excluded), ${res.requests} requests${res.runId ? `, run ${res.runId}` : ""}\n`,
    );
    r.out(`${renderAggregates(res.aggregates)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof RateLimitAbort) {
      r.err(`${e.message}\n`);
      return 3;
    }
    if (e instanceof BaselineUsageError) throw new UsageError(e.message);
    throw e;
  }
}

async function gate(sub: string | undefined, rest: string[], r: Run): Promise<number> {
  if (sub !== "report") throw new UsageError();
  const v = args(rest, {
    installation: { type: "string", multiple: true },
    since: { type: "string" },
    until: { type: "string" },
    "allow-file": { type: "string" },
    out: { type: "string" },
    json: { type: "boolean" },
    check: { type: "boolean" },
  });
  const list = (v.installation as string[] | undefined) ?? [];
  if (list.length === 0) throw new UsageError("--installation is required");
  const installationIds = list.map((x) => parseInstallation(x));
  const since = parseDate("--since", str(v.since));
  const until =
    str(v.until) === undefined ? startOfUtcDay(r.deps.now()) : parseDate("--until", str(v.until));
  let allow: AllowList | null = null;
  const allowFile = str(v["allow-file"]);
  if (allowFile !== undefined) {
    let text: string;
    try {
      text = await readFile(allowFile, "utf8");
    } catch {
      throw new UsageError("--allow-file cannot be read");
    }
    try {
      allow = parseAllowList(text);
    } catch (e) {
      if (e instanceof AllowListError) throw new UsageError(e.message);
      throw e;
    }
  }
  let report: Awaited<ReturnType<typeof gatherGate>>;
  try {
    report = await gatherGate(r.db, r.config, { installationIds, since, until, allow });
  } catch (e) {
    if (e instanceof GateUsageError) throw new UsageError(e.message);
    throw e;
  }
  const markdown = renderGateMarkdown(report);
  const json = `${JSON.stringify(gateReportSchema.parse(report), null, 2)}\n`;
  const outDir = str(v.out);
  if (outDir !== undefined) {
    const base = path.join(outDir, `gate-${report.window.until}`);
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    await writeFile(`${base}.md`, markdown, { mode: 0o600 });
    await writeFile(`${base}.json`, json, { mode: 0o600 });
    // writeFile applies the mode only to new files; make an existing report private as well.
    await chmod(`${base}.md`, 0o600);
    await chmod(`${base}.json`, 0o600);
    r.out(`wrote ${base}.md and ${base}.json\nverdict: ${report.verdict}\n`);
  } else {
    r.out(v.json ? json : markdown);
  }
  if (v.check) {
    return report.verdict === "PASS" ? 0 : report.verdict === "FAIL" ? 1 : 4;
  }
  return 0;
}

async function metrics(sub: string | undefined, rest: string[], r: Run): Promise<number> {
  if (sub !== "rollup") throw new UsageError();
  const v = args(rest, {
    installation: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
  });
  const installationId = parseInstallation(str(v.installation));
  const from = parseDate("--from", str(v.from));
  const to = parseDate("--to", str(v.to));
  if (to.getTime() <= from.getTime()) throw new UsageError("--to must be after --from");
  const ctx = cliContext(r.config, r.db, r.deps.github(r.config), r.deps.now);
  const res = await rollupRange(ctx, { installationId, from, to });
  r.out(`rolled up ${res.days} days for ${res.repositories} repositories\n`);
  return 0;
}

async function incident(sub: string | undefined, rest: string[], r: Run): Promise<number> {
  try {
    if (sub === "add") {
      const v = args(rest, {
        repo: { type: "string" },
        pr: { type: "string" },
        "fix-pr": { type: "string" },
        "occurred-at": { type: "string" },
        severity: { type: "string" },
      });
      const repo = str(v.repo);
      if (repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        throw new UsageError("--repo must be owner/repo");
      }
      const occurred = str(v["occurred-at"]);
      const occurredAt = occurred === undefined ? undefined : new Date(occurred);
      if (occurredAt !== undefined && Number.isNaN(occurredAt.getTime())) {
        throw new UsageError("--occurred-at must be an ISO timestamp");
      }
      const res = await addIncident(r.db, r.deps.now(), {
        repo,
        pr: requirePositiveInt("--pr", str(v.pr)),
        fixPr:
          str(v["fix-pr"]) === undefined
            ? undefined
            : requirePositiveInt("--fix-pr", str(v["fix-pr"])),
        occurredAt,
        severity: str(v.severity) === undefined ? undefined : Number(str(v.severity)),
      });
      for (const w of res.warnings) r.err(`warning: ${w}\n`);
      r.out(`incident ${res.outcome}${res.id ? ` ${res.id}` : ""}\n`);
      return 0;
    }
    if (sub === "list") {
      const v = args(rest, { installation: { type: "string" }, json: { type: "boolean" } });
      const rows = await incidentList(r.db, parseInstallation(str(v.installation)));
      if (v.json) {
        r.out(
          `${JSON.stringify(
            rows.map((x) => ({
              id: x.id,
              repository: x.full_name,
              culpritPr: x.culprit_pr_number,
              fixPr: x.fix_pr_number,
              source: x.source,
              severity: x.severity,
              occurredAt: x.occurred_at.toISOString(),
            })),
          )}\n`,
        );
      } else {
        for (const x of rows) {
          r.out(
            `${x.id}  ${x.full_name}  culprit ${x.culprit_pr_number === null ? "-" : `#${x.culprit_pr_number}`}  fix ${x.fix_pr_number === null ? "-" : `#${x.fix_pr_number}`}  ${x.source}  severity ${x.severity ?? "-"}  ${x.occurred_at.toISOString()}\n`,
          );
        }
      }
      return 0;
    }
    if (sub === "remove") {
      const v = args(rest, { id: { type: "string" } });
      const id = str(v.id);
      if (id === undefined || !/^[0-9a-f-]{36}$/.test(id))
        throw new UsageError("--id must be a uuid");
      const removed = await removeIncident(r.db, id);
      r.out(removed ? "removed\n" : "no such incident\n");
      return removed ? 0 : 1;
    }
  } catch (e) {
    if (e instanceof IncidentUsageError) throw new UsageError(e.message);
    throw e;
  }
  throw new UsageError();
}

export async function main(
  argv: string[],
  io: CliIo,
  deps: OpsDeps = defaultDeps,
): Promise<number> {
  const out = (s: string) => io.out(toTerminalSafe(s));
  const err = (s: string) => io.err(toTerminalSafe(s));
  const [group, sub, ...rest] = argv;
  if (!["pilot", "baseline", "gate", "incident", "metrics"].includes(group ?? "")) {
    err(USAGE);
    return 2;
  }
  let config: Config;
  try {
    config = deps.loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const db = deps.openDb(config.databaseUrl);
  try {
    const pending = await pendingMigrations(db);
    if (pending.length > 0) {
      err("run pnpm db:migrate\n");
      return 2;
    }
    const run: Run = { config, db, deps, out, err };
    // `baseline` has no sub-command: its flags start at the first argument.
    if (group === "baseline")
      return await baseline(
        [sub, ...rest].filter((x) => x !== undefined),
        run,
      );
    if (group === "pilot") return await pilot(sub, rest, run);
    if (group === "gate") return await gate(sub, rest, run);
    if (group === "metrics") return await metrics(sub, rest, run);
    return await incident(sub, rest, run);
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message === "usage" ? USAGE : `${e.message}\n${USAGE}`);
      return 2;
    }
    // Error names and messages only: never a stack, which could hold request or file text.
    err(`unexpected error (${e instanceof Error ? e.name : "unknown"})\n`);
    return 1;
  } finally {
    await db.destroy();
  }
}
