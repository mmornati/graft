/**
 * `pnpm graft policy check <file> [--json]` and `pnpm graft policy schema [--write | --check]`.
 *
 * Lints a `graft.yaml` the same way the service does. It imports only `src/policy` (the pure
 * parts) and `node:*`: no env, no database, no config, no network. Exit codes: 0 valid, 1 invalid
 * (or schema drift), 2 usage error or an unreadable or missing file.
 */
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { LIMITS } from "../policy/constants.js";
import {
  formatPolicyError,
  type PolicyError,
  type PolicyWarning,
  policyWarningMessage,
} from "../policy/errors.js";
import { policyJsonSchema } from "../policy/json-schema.js";
import { parsePolicyText } from "../policy/parse.js";

const USAGE = `usage:
  graft policy check <file> [--json]
  graft policy schema [--write | --check] [--path <file>]
  graft pilot doctor|sync-reviewers|purge ...   (see the README, "Pilots and gate")
  graft baseline | gate report | metrics rollup | incident add|list|remove ...
  graft e2e setup|run|verify|report|cleanup ...   (see docs/e2e/runbook.md)
`;

const OPS_GROUPS = new Set(["pilot", "baseline", "gate", "incident", "metrics"]);

const DEFAULT_SCHEMA_PATH = fileURLToPath(
  new URL("../../schema/graft.v1.schema.json", import.meta.url),
);

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: CliIo = {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
};

const fileError = (): PolicyError => ({
  code: "file_not_regular",
  location: null,
  line: null,
  column: null,
});

function errorLine(file: string, e: PolicyError): string {
  const message = formatPolicyError(e).replace(/^line \d+, column \d+, /, "");
  const text = e.location !== null ? message.replace(`${e.location}: `, "") : message;
  return `${file}:${e.line ?? 1}:${e.column ?? 1}: error ${e.code} ${e.location ?? "-"}: ${text.replace(/ \([a-z_]+\)$/, "")}`;
}

function warningLine(file: string, w: PolicyWarning): string {
  return `${file}:${w.line ?? 1}:${w.column ?? 1}: warning ${w.code} ${w.location}: ${policyWarningMessage(w)}`;
}

async function check(args: string[], io: CliIo): Promise<number> {
  let parsed: { values: { json?: boolean | undefined }; positionals: string[] };
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
  } catch {
    io.err(USAGE);
    return 2;
  }
  const file = parsed.positionals[0];
  if (file === undefined || parsed.positionals.length !== 1) {
    io.err(USAGE);
    return 2;
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(file);
  } catch {
    io.err(`${file}: cannot read the file\n`);
    return 2;
  }
  let errors: PolicyError[];
  let warnings: PolicyWarning[] = [];
  let summary = "";
  if (!info.isFile()) {
    // A symlink, directory or other non-file (D7): the same answer as on the server.
    errors = [fileError()];
  } else if (info.size > LIMITS.fileBytes) {
    // Checked before the file is read, as on the server (D6).
    errors = [
      { code: "file_too_large", location: null, line: null, column: null, detail: info.size },
    ];
  } else {
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      io.err(`${file}: cannot read the file\n`);
      return 2;
    }
    const res = parsePolicyText(bytes);
    if (res.ok) {
      errors = [];
      warnings = res.warnings;
      summary = `${file}: OK (version 1, ${res.policy.rules.length} rules, ${res.policy.sensitivePaths.length} sensitive paths)\n`;
    } else {
      errors = res.errors;
    }
  }
  if (parsed.values.json) {
    io.out(`${JSON.stringify({ ok: errors.length === 0, errors, warnings })}\n`);
  } else {
    if (errors.length === 0) io.out(summary);
    else for (const e of errors) io.out(`${errorLine(file, e)}\n`);
    // Warnings never change the exit code; they follow the errors (or the OK line).
    for (const w of warnings) io.out(`${warningLine(file, w)}\n`);
  }
  return errors.length === 0 ? 0 : 1;
}

async function schema(args: string[], io: CliIo): Promise<number> {
  let parsed: {
    values: { write?: boolean | undefined; check?: boolean | undefined; path?: string | undefined };
  };
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      options: {
        write: { type: "boolean" },
        check: { type: "boolean" },
        path: { type: "string" },
      },
    });
  } catch {
    io.err(USAGE);
    return 2;
  }
  if (parsed.values.write && parsed.values.check) {
    io.err(USAGE);
    return 2;
  }
  const target = path.resolve(parsed.values.path ?? DEFAULT_SCHEMA_PATH);
  const text = `${JSON.stringify(policyJsonSchema(), null, 2)}\n`;
  if (parsed.values.write) {
    await writeFile(target, text);
    io.out(`wrote ${target}\n`);
    return 0;
  }
  if (parsed.values.check) {
    let current: string;
    try {
      current = await readFile(target, "utf8");
    } catch {
      io.err(`${target}: cannot read the file\n`);
      return 2;
    }
    if (current !== text) {
      io.err(`${target} is out of date; run pnpm graft policy schema --write\n`);
      return 1;
    }
    io.out("schema is up to date\n");
    return 0;
  }
  io.out(text);
  return 0;
}

/** The live e2e runner (docs/e2e/runbook.md). Loaded on demand like the operations half. */
async function e2e(args: string[], io: CliIo): Promise<number> {
  const [{ e2eMain }, { createGitPusher }, { childEnv }, ops, { forToken }, env] =
    await Promise.all([
      import("../e2e/cli.js"),
      import("../e2e/git-pusher.js"),
      import("../e2e/child-env.js"),
      import("./graft-ops.js"),
      import("../github/client-factory.js"),
      import("./env.js"),
    ]);
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline/promises");
  const { createDb } = await import("../db/client.js");
  const { readFileSync } = await import("node:fs");
  const { parseEnv } = await import("node:util");
  const rootDir = fileURLToPath(new URL("../../", import.meta.url));
  const runSpawn = (
    command: string,
    argv: string[],
    o: { env?: Record<string, string>; cwd?: string } = {},
  ) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      // An argv array and no shell: nothing is interpreted.
      const child = spawn(command, argv, {
        // The runner's tokens stay in the runner, and git starts from a clean GIT_* slate.
        env: childEnv(process.env, command, o.env ?? {}),
        ...(o.cwd ? { cwd: o.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", () => resolve({ code: 127, stdout: "", stderr: "" }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  const deps: import("../e2e/types.js").E2eDeps = {
    loadConfig() {
      env.loadDotEnv();
      return ops.defaultDeps.loadConfig();
    },
    env: process.env,
    readDotEnv() {
      try {
        return parseEnv(readFileSync(`${rootDir}.env`, "utf8")) as Record<string, string>;
      } catch {
        return null;
      }
    },
    openReadOnlyDb: (url) => createDb(url, { max: 4, readOnly: true }),
    async ops(argv, o = {}) {
      let out = "";
      let err = "";
      const code = await ops.main(
        argv,
        {
          out: (s) => {
            out += s;
          },
          err: (s) => {
            err += s;
          },
        },
        {
          ...ops.defaultDeps,
          ...(o.baselineToken === undefined
            ? {}
            : {
                baselineToken: () => o.baselineToken,
                tokenClient: (token, config) => forToken(token, { baseUrl: config.githubApiUrl }),
                onTokenRequest: (method, url) => {
                  o.requestLog?.push({ method, url });
                },
              }),
        },
      );
      return { code, out, err };
    },
    async readyz() {
      try {
        const port = Number(process.env.PORT ?? 3000);
        const res = await fetch(`http://localhost:${port}/readyz`, {
          signal: AbortSignal.timeout(5000),
        });
        return res.status === 200;
      } catch {
        return false;
      }
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async prompt(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    spawn: runSpawn,
    outDir: `${rootDir}e2e-runs`,
    isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    rootDir,
    gitPusher: createGitPusher(runSpawn),
  };
  return e2eMain(args, io, deps);
}

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === "e2e") {
    return e2e(command === undefined ? [] : [command, ...rest], io);
  }
  if (group === "policy" && command === "check") return check(rest, io);
  if (group === "policy" && command === "schema") return schema(rest, io);
  if (group !== undefined && OPS_GROUPS.has(group)) {
    // Loaded on demand: the operations half needs the database and the configuration, which
    // `graft policy check` must run without (the static imports above stay free of them).
    const ops = await import("./graft-ops.js");
    return ops.main([group, ...(command === undefined ? [] : [command]), ...rest], io);
  }
  io.err(USAGE);
  return 2;
}

// Run only when this file is the entry point (tests import `main`).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      // Never print file text: the class name is enough.
      console.error(`unexpected error (${e instanceof Error ? e.name : "unknown"})`);
      process.exit(1);
    },
  );
}
