import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/index.js";
import { openSet, readCase } from "../../src/eval/store.js";
import { type CliAdapter, createCliLlm } from "../../src/llm/cli.js";
import { CODEX_FEATURES_OFF, codexCliAdapter } from "../../src/llm/cli-codex.js";
import { opencodeCliAdapter, opencodeConfig } from "../../src/llm/cli-opencode.js";
import { type CliProvider, DEFAULT_CAPABILITIES, parseRegistry } from "../../src/llm/registry.js";
import { createRouterLlm } from "../../src/llm/router.js";
import type { LlmRequest } from "../../src/llm/types.js";
import { generateCard } from "../../src/modules/intent/index.js";
import { testConfig } from "../helpers/config.js";
import { REPO_ROOT } from "../helpers/eval-fixtures.js";
import { genOptions } from "../helpers/intent-inputs.js";
import { silentLog } from "../helpers/stubs.js";

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  purpose: "writer",
  model: "openrouter/qwen/qwen3-coder",
  system: 'SYSTEM_CANARY "quoted"\nsecond line',
  user: "USER_CANARY_DIFF",
  outputSchema: { type: "object" },
  maxOutputTokens: 8192,
  effort: "low",
  timeoutMs: 10_000,
  ...over,
});
const jsonl = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");
const SCRATCH = { scratchDir: "/tmp/graft-cli-x/scratch" };

describe("opencode adapter", () => {
  it("U-OC-1 the call carries its own locked-down config and keeps every store in the scratch directory", () => {
    const run = opencodeCliAdapter.build(req(), DEFAULT_CAPABILITIES["cli:opencode"], SCRATCH);
    expect(run.args).toEqual([
      "run",
      "--pure",
      "--agent",
      "graft",
      "--format",
      "json",
      "-m",
      "openrouter/qwen/qwen3-coder",
    ]);
    expect(run.stdin).toBe("USER_CANARY_DIFF");
    const env = run.env ?? {};
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/graft-cli-x/scratch/config");
    expect(env.XDG_DATA_HOME).toBe("/tmp/graft-cli-x/scratch/data");
    expect(env.XDG_STATE_HOME).toBe("/tmp/graft-cli-x/scratch/state");
    for (const flag of [
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_CLAUDE_CODE",
      "OPENCODE_DISABLE_DEFAULT_PLUGINS",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_LSP_DOWNLOAD",
    ]) {
      expect(env[flag], flag).toBe("1");
    }
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(config).toMatchObject({ mcp: {}, plugin: [], instructions: [], share: "disabled" });
    expect(config.agent.graft.prompt).toBe(req().system);
    expect(config.agent.graft.permission).toEqual({ "*": "deny" });
    // `"*": false` alone still offered bash: every tool is named.
    for (const tool of ["*", "bash", "edit", "write", "read", "webfetch", "task"]) {
      expect(config.agent.graft.tools[tool], tool).toBe(false);
    }
    expect(Object.values(config.agent.graft.tools).every((v) => v === false)).toBe(true);
    expect(opencodeConfig("x")).toBe(opencodeConfig("x"));

    const withEffort = opencodeCliAdapter.build(
      req(),
      { ...DEFAULT_CAPABILITIES["cli:opencode"], effort: true },
      SCRATCH,
    );
    expect(withEffort.args.slice(-2)).toEqual(["--variant", "low"]);
  });

  // Recorded from opencode 1.19.3 (`--format json`).
  const step = (
    text: string,
    tokens = { input: 142, output: 1, reasoning: 66 },
    reason = "stop",
  ) => [
    { type: "step_start", part: { type: "step-start" } },
    { type: "text", part: { type: "text", text } },
    {
      type: "step_finish",
      part: { type: "step-finish", reason, tokens: { ...tokens, cache: { write: 0, read: 10 } } },
    },
  ];

  it("U-OC-2 the answer is the last step's text; usage is summed over steps", () => {
    const r = opencodeCliAdapter.parse({
      stdout: jsonl([
        ...step("thinking aloud"),
        { type: "tool_use", part: { tool: "invalid", state: { status: "error" } } },
        ...step('```json\n{"ok": true}\n```'),
      ]),
      stderr: "",
      code: 0,
    });
    expect(r).toEqual({
      ok: true,
      value: { ok: true },
      usage: { inputTokens: 284, outputTokens: 134, cacheReadTokens: 20, cacheWriteTokens: 0 },
    });
  });

  it("U-OC-3 failures: a tool that ran, API errors, length, content filter, no events", () => {
    const parse = (events: unknown[], code = 0) =>
      opencodeCliAdapter.parse({ stdout: jsonl(events), stderr: "", code });
    expect(
      parse([
        { type: "tool_use", part: { tool: "bash", state: { status: "completed" } } },
        ...step('{"ok":true}'),
      ]),
    ).toMatchObject({ ok: false, failure: "bad_request" });
    expect(
      parse([
        {
          type: "error",
          error: { name: "APIError", data: { statusCode: 401, message: "expired" } },
        },
      ]),
    ).toMatchObject({ ok: false, failure: "auth" });
    expect(
      parse([{ type: "error", error: { name: "APIError", data: { statusCode: 429 } } }]),
    ).toMatchObject({ failure: "rate_limited" });
    expect(
      parse([
        { type: "error", error: { name: "ProviderInitError", data: { message: "no endpoints" } } },
      ]),
    ).toMatchObject({ failure: "unavailable" });
    expect(parse(step('{"ok":', undefined, "length"))).toMatchObject({ failure: "max_tokens" });
    expect(parse(step("", undefined, "content-filter"))).toMatchObject({ failure: "refusal" });
    expect(parse(step("Sure! Here it is."))).toMatchObject({ failure: "invalid_json" });
    expect(parse([], 1)).toMatchObject({ failure: "unavailable" });
    expect(parse([], 0)).toMatchObject({ failure: "invalid_json" });
  });
});

describe("codex adapter", () => {
  it("U-CX-1 exec with JSON events, nothing saved, no user config or rules, a read-only sandbox and every tool feature off", () => {
    const run = codexCliAdapter.build(
      req({ model: "gpt-5.5" }),
      DEFAULT_CAPABILITIES["cli:codex"],
      SCRATCH,
    );
    const a = run.args;
    expect(a.slice(0, 12)).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-m",
      "gpt-5.5",
    ]);
    const configs = a.flatMap((x, i) => (a[i - 1] === "-c" ? [x] : []));
    expect(configs).toEqual([
      `developer_instructions=${JSON.stringify(req().system)}`,
      'web_search="disabled"',
      "mcp_servers={}",
      "project_doc_max_bytes=0",
      'shell_environment_policy.inherit="none"',
      'model_reasoning_effort="low"',
    ]);
    const disabled = a.flatMap((x, i) => (a[i - 1] === "--disable" ? [x] : []));
    expect(disabled).toEqual([...CODEX_FEATURES_OFF]);
    for (const f of [
      "shell_tool",
      "unified_exec",
      "browser_use",
      "computer_use",
      "apps",
      "plugins",
      "hooks",
      "multi_agent",
    ]) {
      expect(disabled, f).toContain(f);
    }
    expect(a.at(-1)).toBe("-");
    expect(run.stdin).toBe("USER_CANARY_DIFF");
    // The untrusted text never becomes an argument.
    expect(a.some((x) => x.includes("USER_CANARY_DIFF"))).toBe(false);
  });

  const done = (text: string) => [
    { type: "thread.started", thread_id: "t" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "i0", type: "reasoning", text: "..." } },
    { type: "item.completed", item: { id: "i1", type: "agent_message", text } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 1200,
        cached_input_tokens: 200,
        output_tokens: 80,
        reasoning_output_tokens: 30,
      },
    },
  ];

  it("U-CX-2 the last agent message is the answer; transient errors before a completed turn do not count", () => {
    const r = codexCliAdapter.parse({
      stdout: jsonl([
        { type: "error", message: "Reconnecting... 2/5 (stream disconnected)" },
        {
          type: "item.completed",
          item: { id: "e", type: "error", message: "Falling back to HTTPS" },
        },
        ...done('{"ok":true}'),
      ]),
      stderr: "",
      code: 0,
    });
    expect(r).toEqual({
      ok: true,
      value: { ok: true },
      usage: { inputTokens: 1000, outputTokens: 80, cacheReadTokens: 200, cacheWriteTokens: 0 },
    });
  });

  it("U-CX-3 failures: a tool item, a failed turn, only errors, no events", () => {
    const parse = (events: unknown[], code = 0) =>
      codexCliAdapter.parse({ stdout: jsonl(events), stderr: "", code });
    for (const type of [
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
      "browser_action",
    ]) {
      expect(
        parse([{ type: "item.started", item: { type } }, ...done('{"ok":true}')]),
        type,
      ).toMatchObject({ ok: false, failure: "bad_request" });
    }
    // Recorded from codex-cli 0.162.1 with no login.
    expect(
      parse(
        [
          { type: "thread.started" },
          { type: "turn.started" },
          {
            type: "error",
            message: "Reconnecting... 5/5 (unexpected status 401 Unauthorized: Missing bearer)",
          },
          {
            type: "turn.failed",
            error: { message: "unexpected status 401 Unauthorized: Missing bearer" },
          },
        ],
        1,
      ),
    ).toMatchObject({ ok: false, failure: "auth" });
    expect(parse([{ type: "error", message: "429 Too Many Requests" }], 1)).toMatchObject({
      failure: "rate_limited",
    });
    expect(parse(done("Sure, here you go"))).toMatchObject({ failure: "invalid_json" });
    expect(parse([], 2)).toMatchObject({ failure: "unavailable" });
  });
});

describe("codex and opencode providers", () => {
  it("U-CLI-K-1 both kinds parse with their defaults and are refused on a hosted deployment", () => {
    const doc = `providers:
  - {id: cx, kind: 'cli:codex', passEnv: [CODEX_API_KEY]}
  - {id: oc, kind: 'cli:opencode', passEnv: [OPENCODE_AUTH_CONTENT]}
roles: {fast: oc/openrouter/qwen/qwen3-coder, strong: cx/gpt-5.5}`;
    const r = parseRegistry("SRC", doc, {}, { credential: null, baseUrl: undefined });
    expect(r.problems).toEqual([]);
    const [cx, oc] = (r.registry?.providers ?? []) as CliProvider[];
    expect(cx).toMatchObject({ kind: "cli:codex", command: "codex" });
    expect(oc).toMatchObject({ kind: "cli:opencode", command: "opencode" });
    expect(cx?.capabilities.nativeSchema).toBe(false);
    expect(oc?.capabilities).toEqual(DEFAULT_CAPABILITIES["cli:opencode"]);
    expect(() => testConfig({ GRAFT_DEPLOYMENT: "hosted", GRAFT_LLM_PROVIDERS: doc })).toThrow(
      ConfigError,
    );
    expect(() => testConfig({ GRAFT_DEPLOYMENT: "hosted", GRAFT_LLM_PROVIDERS: doc })).toThrow(
      "cli:codex uses a personal CLI login",
    );
  });
});

describe("codex and opencode against prompt injection", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "graft-fake-agent-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fakeCli(name: string, output: string) {
    const recordFile = path.join(dir, `${name}.jsonl`);
    const command = path.join(dir, name);
    await writeFile(
      command,
      `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), stdin: input }) + "\\n");
  process.stdout.write(${JSON.stringify(output)});
});
`,
    );
    await chmod(command, 0o755);
    return {
      command,
      records: async () =>
        (await readFile(recordFile, "utf8"))
          .trim()
          .split("\n")
          .map(
            (l) =>
              JSON.parse(l) as {
                argv: string[];
                env: Record<string, string>;
                entries: string[];
                stdin: string;
              },
          ),
    };
  }

  const kinds: [CliProvider["kind"], CliAdapter, string][] = [
    ["cli:codex", codexCliAdapter, jsonl([{ type: "turn.completed", usage: {} }])],
    [
      "cli:opencode",
      opencodeCliAdapter,
      jsonl([{ type: "step_finish", part: { reason: "stop" } }]),
    ],
  ];

  it.each(kinds)(
    "U-CLI-K-2 %s: the injection cases reach it only on stdin, with no secret and an empty directory",
    async (kind, adapter, output) => {
      const fake = await fakeCli(kind.replace(":", "-"), output);
      const provider = parseRegistry(
        "SRC",
        `providers:\n  - {id: local, kind: '${kind}', command: ${JSON.stringify(fake.command)}}\nroles: {fast: local/m, strong: local/m}`,
        {},
        { credential: null, baseUrl: undefined },
      ).registry?.providers[0] as CliProvider;
      const client = createCliLlm({
        command: fake.command,
        adapter,
        capabilities: provider.capabilities,
        passEnv: [],
        log: silentLog,
        environment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: "/home/graft",
          GITHUB_APP_PRIVATE_KEY: "GH_KEY_CANARY",
          DATABASE_URL: "postgres://DB_CANARY",
          OPENAI_API_KEY: "OTHER_KEY_CANARY",
        },
      });
      const llm = createRouterLlm([{ provider, client }]);
      const set = await openSet(path.join(REPO_ROOT, "eval/synthetic"), { key: null });
      const opts = genOptions({ models: { fast: "local/m", strong: "local/m" } });
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
        expect(rec.argv.filter((a) => /untrusted_data_[0-9a-f]{16}/.test(a))).toEqual([]);
        expect(rec.stdin).toMatch(/untrusted_data_[0-9a-f]{16}/);
        expect(rec.entries).toEqual([]);
        const env = JSON.stringify(rec.env);
        for (const canary of ["GH_KEY_CANARY", "DB_CANARY", "OTHER_KEY_CANARY"]) {
          expect(env, canary).not.toContain(canary);
        }
        // Its stores point into the call's scratch directory, removed with it.
        if (kind === "cli:opencode") {
          expect(rec.env.XDG_DATA_HOME).toMatch(/graft-cli-[^/]+\/scratch\/data$/);
          expect(existsSync(rec.env.XDG_DATA_HOME ?? "/")).toBe(false);
        }
      }
    },
  );
});
