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
import { formatPolicyError, type PolicyError } from "../policy/errors.js";
import { policyJsonSchema } from "../policy/json-schema.js";
import { parsePolicyText } from "../policy/parse.js";

const USAGE = `usage:
  graft policy check <file> [--json]
  graft policy schema [--write | --check] [--path <file>]
`;

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
      summary = `${file}: OK (version 1, ${res.policy.rules.length} rules, ${res.policy.sensitivePaths.length} sensitive paths)\n`;
    } else {
      errors = res.errors;
    }
  }
  if (parsed.values.json) {
    io.out(`${JSON.stringify({ ok: errors.length === 0, errors })}\n`);
  } else if (errors.length === 0) {
    io.out(summary);
  } else {
    for (const e of errors) io.out(`${errorLine(file, e)}\n`);
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

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === "policy" && command === "check") return check(rest, io);
  if (group === "policy" && command === "schema") return schema(rest, io);
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
