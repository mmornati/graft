/**
 * The CLI transport: a coding agent's command-line tool (`claude`, `codex`, `opencode`) run once
 * per call, logged in with whatever the operator set up on this machine.
 *
 * These tools are agents with tools, and Graft feeds them untrusted PR text. The isolation is
 * enforced here, not left to each adapter:
 * - the binary is spawned with an argument array, never a shell;
 * - it runs in a fresh, empty temporary directory, and anything it stores goes to a scratch
 *   directory next to it; both are removed afterwards;
 * - its environment is rebuilt from a short allow-list plus the variables the operator named,
 *   so no GitHub key, database URL or other provider's key reaches it;
 * - each adapter turns tools, MCP servers, settings, plugins and session storage off;
 * - the whole process group is killed at the deadline, and output is capped.
 *
 * Only self-hosted, single-tenant deployments may use these providers (see the registry).
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "../core/logger.js";
import {
  type LlmCapabilities,
  type LlmClient,
  type LlmFailure,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  ZERO_USAGE,
} from "./types.js";

/** Passed through when set: what any CLI needs to find itself, its login and a temp dir. */
export const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"] as const;

/** Never passed to a CLI, whatever the registry says: Graft's own secrets and settings. */
export const FORBIDDEN_ENV = /^(GITHUB_|GRAFT_|PG|SMEE_)|DATABASE_URL$|_PRIVATE_KEY(_PATH)?$/;

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface CliRun {
  /** Arguments after the command. */
  args: readonly string[];
  /** Written to stdin, then closed. */
  stdin: string;
  /** Extra variables for this call only (an output-token limit, say). */
  env?: Readonly<Record<string, string>>;
  /** Files written into the scratch directory before the run (a schema file, say). */
  files?: Readonly<Record<string, string>>;
}

export interface CliContext {
  /**
   * A directory of this call's own, outside the working directory and removed afterwards: for the
   * CLI's session storage and config, so no PR text stays on disk.
   */
  scratchDir: string;
}

export type CliParsed =
  | { ok: true; value: unknown; usage: LlmUsage; model?: string }
  | { ok: false; failure: LlmFailure; usage: LlmUsage; model?: string };

export interface CliAdapter {
  /** For logs. */
  readonly name: string;
  build(req: LlmRequest, caps: LlmCapabilities, ctx: CliContext): CliRun;
  /** Called for every run that exited by itself; `code` is its exit status. */
  parse(out: { stdout: string; stderr: string; code: number | null }): CliParsed;
}

export interface CliLlmOptions {
  /** A bare name looked up on PATH, or an absolute path. */
  command: string;
  adapter: CliAdapter;
  capabilities: LlmCapabilities;
  /** Variable names the operator passes through on top of `BASE_ENV`. */
  passEnv: readonly string[];
  log: Logger;
  /** Tests only. */
  environment?: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
}

/** An HTTP status a CLI reports for its model call, as a failure class. */
export function failureForStatus(status: number): LlmFailure {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  if (status === 401 || status === 403) return "auth";
  return "bad_request";
}

/** A CLI error with no status: its text is matched, never logged. */
export function failureForMessage(message: string): LlmFailure {
  if (/\b(401|403)\b|unauthori[sz]ed|log ?in|credential|api key|auth/i.test(message)) return "auth";
  if (/\b429\b|rate.?limit|quota/i.test(message)) return "rate_limited";
  return "unavailable";
}

/** The environment a CLI gets: `BASE_ENV` and `passEnv`, minus anything `FORBIDDEN_ENV` names. */
export function cliEnvironment(
  from: NodeJS.ProcessEnv,
  passEnv: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...BASE_ENV, ...passEnv]) {
    const v = from[name];
    if (v !== undefined && !FORBIDDEN_ENV.test(name)) out[name] = v;
  }
  return { ...out, ...extra };
}

type Exit =
  | { kind: "exited"; code: number | null; stdout: string; stderr: string }
  | { kind: "timeout" }
  | { kind: "too_much_output" }
  | { kind: "spawn_failed"; code: string };

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL"); // the CLI and anything it started
  } catch {
    child.kill("SIGKILL");
  }
}

async function runOnce(
  o: CliLlmOptions,
  run: CliRun,
  cwd: string,
  deadlineMs: number,
): Promise<Exit> {
  const spawn = o.spawn ?? nodeSpawn;
  return new Promise<Exit>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (e: Exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(e);
    };
    const child = spawn(o.command, [...run.args], {
      cwd,
      env: cliEnvironment(o.environment ?? process.env, o.passEnv, run.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: true, // its own process group, so the deadline can kill all of it
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    timer = setTimeout(
      () => {
        killGroup(child);
        done({ kind: "timeout" });
      },
      Math.max(1, Math.floor(deadlineMs)),
    );

    child.on("error", (e: NodeJS.ErrnoException) => {
      done({ kind: "spawn_failed", code: e.code ?? "error" });
    });
    child.stdout?.on("data", (b: Buffer) => {
      outBytes += b.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        killGroup(child);
        done({ kind: "too_much_output" });
        return;
      }
      out.push(b);
    });
    child.stderr?.on("data", (b: Buffer) => {
      if (errBytes < MAX_STDERR_BYTES) err.push(b.subarray(0, MAX_STDERR_BYTES - errBytes));
      errBytes += b.length;
    });
    child.on("close", (code) => {
      done({
        kind: "exited",
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    // A CLI that exits before reading stdin closes the pipe: that is its exit, not ours.
    child.stdin?.on("error", () => {});
    child.stdin?.end(run.stdin);
  });
}

export function createCliLlm(o: CliLlmOptions): LlmClient {
  const caps = o.capabilities;
  return {
    capabilities: () => caps,
    async complete(req: LlmRequest): Promise<LlmResult> {
      const started = Date.now();
      const finish = (p: CliParsed): LlmResult => {
        const durationMs = Date.now() - started;
        const model = p.model ?? req.model;
        const usage = caps.reportsUsage ? p.usage : ZERO_USAGE;
        // Metadata only: never the prompts, the arguments, the output or stderr.
        o.log.info(
          {
            purpose: req.purpose,
            model,
            cli: o.adapter.name,
            ok: p.ok,
            ...(p.ok ? {} : { failure: p.failure }),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            durationMs,
          },
          "llm call",
        );
        return p.ok
          ? { ok: true, value: p.value, usage, model, durationMs }
          : { ok: false, failure: p.failure, usage, model, durationMs };
      };

      const prefix = req.userCachePrefix;
      if (prefix !== undefined && (prefix === "" || !req.user.startsWith(prefix))) {
        throw new Error("userCachePrefix must be a non-empty prefix of user");
      }

      const root = await mkdtemp(path.join(tmpdir(), "graft-cli-"));
      let exit: Exit;
      try {
        const cwd = path.join(root, "work");
        const scratchDir = path.join(root, "scratch");
        await mkdir(cwd, { mode: 0o700 });
        await mkdir(scratchDir, { mode: 0o700 });
        const run = o.adapter.build(req, caps, { scratchDir });
        for (const [name, content] of Object.entries(run.files ?? {})) {
          if (name.includes("/") || name.startsWith(".")) throw new Error("bad scratch file name");
          await writeFile(path.join(scratchDir, name), content, { mode: 0o600 });
        }
        exit = await runOnce(o, run, cwd, Math.min(req.timeoutMs, req.deadlineMs ?? req.timeoutMs));
      } finally {
        await rm(root, { recursive: true, force: true });
      }

      if (exit.kind !== "exited") {
        const failure: LlmFailure =
          exit.kind === "timeout"
            ? "timeout"
            : exit.kind === "too_much_output"
              ? "invalid_json"
              : "unavailable";
        o.log.warn(
          {
            purpose: req.purpose,
            model: req.model,
            cli: o.adapter.name,
            reason: exit.kind,
            ...(exit.kind === "spawn_failed" ? { code: exit.code } : {}),
          },
          "llm call failed",
        );
        return finish({ ok: false, failure, usage: ZERO_USAGE });
      }
      const parsed = o.adapter.parse(exit);
      if (!parsed.ok) {
        o.log.warn(
          { purpose: req.purpose, model: req.model, cli: o.adapter.name, exitCode: exit.code },
          "llm call failed",
        );
      }
      return finish(parsed);
    },
  };
}
