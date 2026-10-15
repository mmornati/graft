/**
 * `pnpm graft e2e ...` (T5). Loaded with a dynamic import by `src/bin/graft.ts`, which passes the
 * real dependencies; tests inject fakes. Exit codes: 0 ok, 1 a scenario or invariant failed,
 * 2 usage or configuration, 3 aborted (preflight, guard refusal, budget, declined).
 */
import { parseArgs } from "node:util";
import { cleanupCommand } from "./cleanup.js";
import { runCommand } from "./run.js";
import { SCENARIO_IDS } from "./scenarios/index.js";
import { setupCommand } from "./setup.js";
import type { E2eDeps, IoLike, LlmFlag, RunOptions } from "./types.js";
import { reportCommand, verifyCommand } from "./verify.js";

export const USAGE = `usage:
  graft e2e setup   [--sandbox o/r] [--create] [--yes] [--invite-outsider] [--dry-run] [--confirm o/r]
  graft e2e run     [--sandbox o/r] [--scenario <id>]... [--run-id <id>] [--dry-run] [--interactive]
                    [--llm auto|live|none] [--max-cost-usd 5] [--lenient-model] [--wait-cron]
                    [--with-source-baseline] [--server-log <file>] [--worker-log <file>]
                    [--capture] [--timeout-scale 1] [--confirm o/r] [--json]
  graft e2e run --only-offline            (the whole suite against the fake world; no network)
  graft e2e verify  [--run-id <id>] [--after-retention] [--server-log <file>] [--worker-log <file>]
  graft e2e report  [--run-id <id>] [--update-human-todo]
  graft e2e cleanup [--run-id <id> | --all] [--yes] [--dry-run]
scenarios: ${SCENARIO_IDS.join(", ")}
`;

class UsageError extends Error {
  constructor(message?: string) {
    super(message ?? "usage");
    this.name = "UsageError";
  }
}

function parse<T extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>>(
  argv: string[],
  options: T,
) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false, strict: true })
      .values as Record<string, string | boolean | string[] | undefined>;
  } catch {
    throw new UsageError();
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const flag = (v: unknown): boolean => v === true;

function positive(name: string, v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${name} must be a positive number`);
  return n;
}

export function parseRun(argv: string[]): RunOptions {
  const v = parse(argv, {
    sandbox: { type: "string" },
    scenario: { type: "string", multiple: true },
    "run-id": { type: "string" },
    "dry-run": { type: "boolean" },
    interactive: { type: "boolean" },
    llm: { type: "string" },
    "max-cost-usd": { type: "string" },
    "lenient-model": { type: "boolean" },
    "wait-cron": { type: "boolean" },
    "with-source-baseline": { type: "boolean" },
    "server-log": { type: "string" },
    "worker-log": { type: "string" },
    capture: { type: "boolean" },
    "timeout-scale": { type: "string" },
    confirm: { type: "string" },
    json: { type: "boolean" },
    "only-offline": { type: "boolean" },
  });
  const scenarios = (v.scenario as string[] | undefined) ?? [];
  for (const id of scenarios) {
    if (!SCENARIO_IDS.includes(id)) throw new UsageError(`unknown scenario ${id}`);
  }
  const llm = str(v.llm) ?? "auto";
  if (llm !== "auto" && llm !== "live" && llm !== "none")
    throw new UsageError("--llm must be auto, live or none");
  const opts: RunOptions = {
    sandbox: str(v.sandbox),
    scenarios,
    runId: str(v["run-id"]),
    dryRun: flag(v["dry-run"]),
    interactive: flag(v.interactive),
    llm: llm as LlmFlag,
    maxCostUsd: positive("--max-cost-usd", str(v["max-cost-usd"]), 5),
    lenientModel: flag(v["lenient-model"]),
    waitCron: flag(v["wait-cron"]),
    withSourceBaseline: flag(v["with-source-baseline"]),
    serverLog: str(v["server-log"]),
    workerLog: str(v["worker-log"]),
    capture: flag(v.capture),
    timeoutScale: positive("--timeout-scale", str(v["timeout-scale"]), 1),
    confirm: str(v.confirm),
    json: flag(v.json),
    onlyOffline: flag(v["only-offline"]),
  };
  if (opts.onlyOffline) {
    // Every option but --scenario and --llm is ignored.
    return {
      sandbox: undefined,
      scenarios: opts.scenarios,
      runId: undefined,
      dryRun: false,
      interactive: false,
      llm: opts.llm,
      maxCostUsd: 5,
      lenientModel: false,
      waitCron: false,
      withSourceBaseline: false,
      capture: false,
      timeoutScale: 1,
      json: false,
      onlyOffline: true,
    };
  }
  return opts;
}

export async function e2eMain(argv: string[], io: IoLike, deps: E2eDeps): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case "setup": {
        const v = parse(rest, {
          sandbox: { type: "string" },
          create: { type: "boolean" },
          yes: { type: "boolean" },
          "invite-outsider": { type: "boolean" },
          "dry-run": { type: "boolean" },
          confirm: { type: "string" },
        });
        return await setupCommand(deps, io, {
          sandbox: str(v.sandbox),
          create: flag(v.create),
          yes: flag(v.yes),
          inviteOutsider: flag(v["invite-outsider"]),
          dryRun: flag(v["dry-run"]),
          confirm: str(v.confirm),
        });
      }
      case "run":
        return await runCommand(deps, io, parseRun(rest));
      case "verify": {
        const v = parse(rest, {
          sandbox: { type: "string" },
          "run-id": { type: "string" },
          "after-retention": { type: "boolean" },
          "server-log": { type: "string" },
          "worker-log": { type: "string" },
          confirm: { type: "string" },
        });
        return await verifyCommand(deps, io, {
          runId: str(v["run-id"]),
          afterRetention: flag(v["after-retention"]),
          serverLog: str(v["server-log"]),
          workerLog: str(v["worker-log"]),
          sandbox: str(v.sandbox),
          confirm: str(v.confirm),
        });
      }
      case "report": {
        const v = parse(rest, {
          "run-id": { type: "string" },
          "update-human-todo": { type: "boolean" },
        });
        return await reportCommand(deps, io, {
          runId: str(v["run-id"]),
          updateHumanTodo: flag(v["update-human-todo"]),
        });
      }
      case "cleanup": {
        const v = parse(rest, {
          sandbox: { type: "string" },
          "run-id": { type: "string" },
          all: { type: "boolean" },
          yes: { type: "boolean" },
          "dry-run": { type: "boolean" },
          confirm: { type: "string" },
        });
        if (flag(v.all) === (str(v["run-id"]) !== undefined)) {
          throw new UsageError("pass exactly one of --run-id <id> and --all");
        }
        return await cleanupCommand(deps, io, {
          sandbox: str(v.sandbox),
          runId: str(v["run-id"]),
          all: flag(v.all),
          yes: flag(v.yes),
          dryRun: flag(v["dry-run"]),
          confirm: str(v.confirm),
        });
      }
      default:
        throw new UsageError();
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message === "usage" ? USAGE : `${e.message}\n${USAGE}`);
      return 2;
    }
    io.err(`unexpected error (${e instanceof Error ? e.name : "unknown"})\n`);
    return 1;
  }
}
