import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/index.js";
import { createLogger } from "../../src/core/logger.js";
import { openSet, readCase } from "../../src/eval/store.js";
import { BASE_ENV, cliEnvironment, createCliLlm } from "../../src/llm/cli.js";
import { claudeCliAdapter } from "../../src/llm/cli-claude.js";
import { type CliProvider, DEFAULT_CAPABILITIES, parseRegistry } from "../../src/llm/registry.js";
import { createRouterLlm } from "../../src/llm/router.js";
import { type LlmRequest, ZERO_USAGE } from "../../src/llm/types.js";
import { generateCard } from "../../src/modules/intent/index.js";
import { testConfig } from "../helpers/config.js";
import { REPO_ROOT } from "../helpers/eval-fixtures.js";
import { genOptions } from "../helpers/intent-inputs.js";
import { silentLog } from "../helpers/stubs.js";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } };
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  purpose: "writer",
  model: "claude-haiku-5-5",
  system: "SYSTEM_CANARY_PROMPT",
  user: "USER_CANARY_DIFF",
  outputSchema: SCHEMA,
  maxOutputTokens: 8192,
  effort: "low",
  timeoutMs: 10_000,
  ...over,
});

const success = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  stop_reason: "tool_use",
  result: '{"ok":true}',
  structured_output: { ok: true },
  usage: {
    input_tokens: 20,
    output_tokens: 50,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 1185,
  },
  modelUsage: { "claude-haiku-5-5": {} },
  ...over,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graft-fake-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Record_ {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  entries: string[];
  stdin: string;
}

/**
 * A stand-in `claude`: records what it was given, then runs `behavior` (JavaScript with `input`,
 * `fs` and `cp` in scope). Each call appends one record.
 */
async function fakeCli(
  behavior: string,
): Promise<{ command: string; records: () => Promise<Record_[]> }> {
  const recordFile = path.join(dir, "records.jsonl");
  const command = path.join(dir, "claude");
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
    argv: process.argv.slice(2), env: process.env, cwd: process.cwd(),
    entries: fs.readdirSync(process.cwd()), stdin: input,
  }) + "\\n");
  ${behavior}
});
`,
  );
  await chmod(command, 0o755);
  return {
    command,
    records: async () =>
      existsSync(recordFile)
        ? (await readFile(recordFile, "utf8"))
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Record_)
        : [],
  };
}

const reply = (body: unknown, code = 0) =>
  `process.stdout.write(${JSON.stringify(JSON.stringify(body))}); process.exit(${code});`;

const HOSTILE_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/home/graft",
  GITHUB_APP_PRIVATE_KEY: "GH_KEY_CANARY",
  GITHUB_WEBHOOK_SECRET: "GH_SECRET_CANARY",
  DATABASE_URL: "postgres://DB_CANARY",
  GRAFT_LLM_PROVIDERS: "REGISTRY_CANARY",
  OPENROUTER_API_KEY: "OTHER_PROVIDER_CANARY",
  CLAUDE_CODE_OAUTH_TOKEN: "passed-on-purpose",
};

function cliLlm(command: string, over: Partial<Parameters<typeof createCliLlm>[0]> = {}) {
  return createCliLlm({
    command,
    adapter: claudeCliAdapter,
    capabilities: DEFAULT_CAPABILITIES["cli:claude"],
    passEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
    log: silentLog,
    environment: HOSTILE_ENV,
    ...over,
  });
}

/** Allowed in the child: the base set, what the operator passed, and what the OS adds itself. */
const allowedChildEnv = (k: string) =>
  (BASE_ENV as readonly string[]).includes(k) ||
  k === "CLAUDE_CODE_OAUTH_TOKEN" ||
  k === "CLAUDE_CODE_MAX_OUTPUT_TOKENS" ||
  k.startsWith("__CF") ||
  k === "PWD" ||
  k === "SHLVL" ||
  k === "_";

describe("CLI transport", () => {
  it("U-CLI-T-1 the claude CLI gets tools, MCP, settings and sessions off, the PR text on stdin, and nothing secret", async () => {
    const fake = await fakeCli(reply(success()));
    const r = await cliLlm(fake.command).complete(req());
    expect(r).toMatchObject({
      ok: true,
      value: { ok: true },
      model: "claude-haiku-5-5",
      usage: { inputTokens: 20, outputTokens: 50, cacheReadTokens: 7, cacheWriteTokens: 1185 },
    });
    const [rec] = await fake.records();
    expect(rec?.argv).toEqual([
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--model",
      "claude-haiku-5-5",
      "--system-prompt",
      "SYSTEM_CANARY_PROMPT",
      "--effort",
      "low",
      "--json-schema",
      JSON.stringify(SCHEMA),
    ]);
    expect(rec?.stdin).toBe("USER_CANARY_DIFF");
    // An empty directory of its own, removed afterwards.
    expect(rec?.entries).toEqual([]);
    expect(path.basename(rec?.cwd ?? "")).toMatch(/^graft-cli-/);
    expect(existsSync(rec?.cwd ?? "/")).toBe(false);
    // Only the allow-list reaches it.
    const env = rec?.env ?? {};
    expect(Object.keys(env).filter((k) => !allowedChildEnv(k))).toEqual([]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("passed-on-purpose");
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8192");
    const all = JSON.stringify(env);
    for (const canary of [
      "GH_KEY_CANARY",
      "GH_SECRET_CANARY",
      "DB_CANARY",
      "REGISTRY_CANARY",
      "OTHER_PROVIDER_CANARY",
    ]) {
      expect(all, canary).not.toContain(canary);
    }
  });

  it("U-CLI-T-2 forbidden variables never pass, even when named", () => {
    expect(
      cliEnvironment(HOSTILE_ENV, ["GITHUB_WEBHOOK_SECRET", "DATABASE_URL", "GRAFT_LLM_PROVIDERS"]),
    ).toEqual({ PATH: HOSTILE_ENV.PATH, HOME: "/home/graft" });
  });

  it("U-CLI-T-3 without effort or native schema the flags are left out", async () => {
    const fake = await fakeCli(reply(success({ structured_output: null })));
    const r = await cliLlm(fake.command, {
      capabilities: { ...DEFAULT_CAPABILITIES["cli:claude"], effort: false, nativeSchema: false },
    }).complete(req());
    expect(r).toMatchObject({ ok: true, value: { ok: true } }); // parsed from `result`
    const [rec] = await fake.records();
    expect(rec?.argv).not.toContain("--effort");
    expect(rec?.argv).not.toContain("--json-schema");
  });

  it("U-CLI-T-4 failures map onto Graft's classes", async () => {
    const cases: [string, string][] = [
      [reply(success({ is_error: true, api_error_status: 401, result: "x" })), "auth"],
      [reply(success({ is_error: true, api_error_status: 429, result: "x" })), "rate_limited"],
      [reply(success({ is_error: true, api_error_status: 529, result: "x" })), "unavailable"],
      [reply(success({ is_error: true, api_error_status: 404, result: "x" })), "bad_request"],
      [
        reply(success({ subtype: "error_max_structured_output_retries", structured_output: null })),
        "invalid_json",
      ],
      [reply(success({ stop_reason: "refusal", structured_output: null })), "refusal"],
      [reply(success({ stop_reason: "max_tokens", structured_output: null })), "max_tokens"],
      [reply(success({ is_error: true, result: "Not logged in. Please run /login" }), 1), "auth"],
      [reply(success({ structured_output: null, result: "Sure, here you go" })), "invalid_json"],
      ["process.stderr.write('boom'); process.exit(1);", "unavailable"],
      ["process.stdout.write('not json'); process.exit(0);", "invalid_json"],
      [
        "process.stdout.write('x'.repeat(5 * 1024 * 1024)); setTimeout(() => {}, 5000);",
        "invalid_json",
      ],
    ];
    for (const [behavior, failure] of cases) {
      const fake = await fakeCli(behavior);
      expect(await cliLlm(fake.command).complete(req()), failure).toMatchObject({
        ok: false,
        failure,
      });
    }
    expect(await cliLlm("/nonexistent/claude").complete(req())).toMatchObject({
      ok: false,
      failure: "unavailable",
      usage: ZERO_USAGE,
    });
  });

  it("U-CLI-T-5 the deadline kills the CLI and everything it started", async () => {
    const pidFile = path.join(dir, "grandchild.pid");
    const fake = await fakeCli(
      `const g = cp.spawn("sleep", ["30"], { stdio: "ignore" }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setTimeout(() => {}, 30000);`,
    );
    const started = Date.now();
    const r = await cliLlm(fake.command).complete(req({ timeoutMs: 1500, deadlineMs: 1500 }));
    expect(r).toMatchObject({ ok: false, failure: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number(await readFile(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 200));
    expect(() => process.kill(pid, 0)).toThrow(); // ESRCH: gone with the group
  });

  it("U-CLI-T-6 logs carry counts and the CLI name, never prompts, output or stderr", async () => {
    let out = "";
    const log = createLogger(
      { logLevel: "debug" },
      new Writable({
        write(chunk, _e, cb) {
          out += String(chunk);
          cb();
        },
      }),
    );
    const ok = await fakeCli(reply(success({ structured_output: { leak: "RESPONSE_CANARY" } })));
    await cliLlm(ok.command, { log }).complete(req());
    const bad = await fakeCli("process.stderr.write('STDERR_CANARY'); process.exit(3);");
    await cliLlm(bad.command, { log }).complete(req());
    expect(out).toContain('"cli":"claude"');
    expect(out).toContain('"inputTokens":20');
    for (const canary of [
      "SYSTEM_CANARY_PROMPT",
      "USER_CANARY_DIFF",
      "RESPONSE_CANARY",
      "STDERR_CANARY",
    ]) {
      expect(out, canary).not.toContain(canary);
    }
  });
});

describe("CLI providers in the registry", () => {
  const yaml = (
    entry: string,
    roles = "roles: {fast: c/claude-haiku-5-5, strong: c/claude-sonnet-5-5}",
  ) => `providers:\n  - ${entry}\n${roles}`;

  it("U-CLI-T-7 a cli:claude entry: its defaults, its command, Claude model IDs only", () => {
    const r = parseRegistry(
      "SRC",
      yaml("{id: c, kind: 'cli:claude', passEnv: [CLAUDE_CODE_OAUTH_TOKEN]}"),
      {},
      {
        credential: null,
        baseUrl: undefined,
      },
    );
    expect(r.problems).toEqual([]);
    const p = r.registry?.providers[0] as CliProvider;
    expect(p).toMatchObject({
      kind: "cli:claude",
      command: "claude",
      passEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });
    expect(p.capabilities).toEqual(DEFAULT_CAPABILITIES["cli:claude"]);
    const bad = parseRegistry(
      "SRC",
      yaml("{id: c, kind: 'cli:claude'}", "roles: {fast: c/gpt-5, strong: c/claude-sonnet-5-5}"),
      {},
      { credential: null, baseUrl: undefined },
    );
    expect(bad.problems.join("\n")).toContain("roles.fast: must be a Claude model ID");
  });

  it("U-CLI-T-8 refused on a hosted deployment, and for secrets or other providers' keys", () => {
    const hosted = () =>
      testConfig({
        GRAFT_DEPLOYMENT: "hosted",
        GRAFT_LLM_PROVIDERS: yaml("{id: c, kind: 'cli:claude'}"),
      });
    expect(hosted).toThrow(ConfigError);
    expect(hosted).toThrow(
      "cli:claude uses a personal CLI login and is refused when GRAFT_DEPLOYMENT=hosted",
    );
    expect(
      testConfig({ GRAFT_LLM_PROVIDERS: yaml("{id: c, kind: 'cli:claude'}") }).deployment,
    ).toBe("self-hosted");

    const problems = (doc: string, env: Record<string, string> = {}) =>
      parseRegistry("SRC", doc, env, { credential: null, baseUrl: undefined }).problems.join("\n");
    expect(problems(yaml("{id: c, kind: 'cli:claude', passEnv: [GITHUB_TOKEN]}"))).toContain(
      "names a variable Graft never passes to a CLI",
    );
    expect(problems(yaml("{id: c, kind: 'cli:claude', passEnv: [DATABASE_URL]}"))).toContain(
      "names a variable Graft never passes to a CLI",
    );
    expect(
      problems(
        `providers:\n  - {id: o, kind: openai-compatible, baseUrl: 'http://x.test/v1', apiKeyEnv: OR_KEY}\n  - {id: c, kind: 'cli:claude', passEnv: [OR_KEY]}\nroles: {fast: c/claude-haiku-5-5, strong: o/m}`,
        { OR_KEY: "k" },
      ),
    ).toContain("providers[1].passEnv[0]: is another provider's key");
    expect(problems(yaml("{id: c, kind: 'cli:claude', command: 'claude --dangerous'}"))).toContain(
      "must be a command name or an absolute path",
    );
  });
});

describe("CLI providers and prompt injection", () => {
  it("U-CLI-T-9 the injection cases syn-019, 020, 021 and 030 never get a tool, a setting or a secret", async () => {
    const fake = await fakeCli(
      `process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,api_error_status:null,result:"",structured_output: null,usage:{input_tokens:1,output_tokens:1},modelUsage:{}})); process.exit(0);`,
    );
    const provider = parseRegistry(
      "SRC",
      `providers:\n  - {id: local, kind: 'cli:claude', command: ${JSON.stringify(fake.command)}}\nroles: {fast: local/claude-haiku-5-5, strong: local/claude-sonnet-5-5}`,
      {},
      { credential: null, baseUrl: undefined },
    ).registry?.providers[0] as CliProvider;
    const llm = createRouterLlm([{ provider, client: cliLlm(fake.command, { passEnv: [] }) }]);
    const set = await openSet(path.join(REPO_ROOT, "eval/synthetic"), { key: null });
    const opts = genOptions({
      models: { fast: "local/claude-haiku-5-5", strong: "local/claude-sonnet-5-5" },
    });
    for (const id of [
      "syn-019-injection-body",
      "syn-020-injection-diff",
      "syn-021-injection-zero-width",
      "syn-030-soft-injection",
    ]) {
      const c = await readCase(set, id);
      await generateCard(c.inputs, llm, { ...opts, floor: c.floorConfig });
    }
    const records = await fake.records();
    expect(records.length).toBeGreaterThanOrEqual(4);
    for (const rec of records) {
      expect(rec.argv.slice(0, 10)).toEqual([
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
      ]);
      // The untrusted text only ever travels on stdin, never as an argument the CLI interprets.
      expect(rec.argv.filter((a) => /untrusted_data_[0-9a-f]{16}/.test(a))).toEqual([]);
      expect(rec.stdin).toMatch(/untrusted_data_[0-9a-f]{16}/);
      expect(rec.entries).toEqual([]);
      expect(Object.keys(rec.env).filter((k) => !allowedChildEnv(k))).toEqual([]);
    }
  });
});
