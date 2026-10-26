import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/index.js";
import { createLogger } from "../../src/core/logger.js";
import {
  createAnthropicLlm,
  createLlmClient,
  createRouterLlm,
  parseRegistry,
  splitModelRef,
} from "../../src/llm/index.js";
import type { AnthropicProvider } from "../../src/llm/registry.js";
import { FULL_CAPABILITIES, type LlmRequest, ZERO_USAGE } from "../../src/llm/types.js";
import { systemWithSchema } from "../../src/modules/intent/generate.js";
import { testConfig } from "../helpers/config.js";
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
  timeoutMs: 5000,
  ...over,
});

function fakeFetch() {
  const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fn: typeof fetch = async (input, init) => {
    const r = input instanceof Request ? input : undefined;
    seen.push({
      url: r ? r.url : String(input),
      body: JSON.parse(String(init?.body ?? (r ? await r.text() : "{}"))),
      headers: new Headers(init?.headers ?? r?.headers),
    });
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model ?? "unknown",
        content: [{ type: "text", text: '{"ok":true}' }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fn, seen };
}

function capture() {
  let out = "";
  const stream = new Writable({
    write(chunk, _e, cb) {
      out += String(chunk);
      cb();
    },
  });
  return { log: createLogger({ logLevel: "info" }, stream), text: () => out };
}

const TWO_PROVIDERS = `
providers:
  - id: claude
    kind: anthropic
  - id: gateway
    kind: anthropic
    baseUrl: https://gateway.example.test/api
    authTokenEnv: GATEWAY_TOKEN
    capabilities: { nativeSchema: false }
    prices:
      anthropic/claude-sonnet-5.5: { input: 3, output: 15 }
roles:
  fast: claude/claude-haiku-5-5
  strong: gateway/anthropic/claude-sonnet-5.5
  refusalFallback: claude/claude-sonnet-5-5
`;

const problemsOf = (env: Record<string, string>): string => {
  try {
    testConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("expected a ConfigError");
};

describe("provider registry: backward compatibility", () => {
  it("U-PROV-1 without a registry the config and the client are exactly what they were", () => {
    const cfg = testConfig({ ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(cfg.llmRegistry).toBeUndefined();
    expect(cfg.llmModelFast).toBe("claude-haiku-5-5");
    expect(cfg.llmModelStrong).toBe("claude-sonnet-5-5");
    expect(cfg.llmRefusalFallbackModel).toBeUndefined();
    const c = capture();
    const llm = createLlmClient(cfg, c.log);
    expect(c.text()).toContain("llm client: anthropic");
    expect(c.text()).not.toContain("registry");
    // No router: bare model IDs, no provider prefix anywhere.
    expect(llm.serverRefusalFallback?.("claude-sonnet-5-5")).toBe(true);
    expect(llm.costOf).toBeUndefined();
    expect(llm.capabilities?.("claude-haiku-5-5")).toEqual(FULL_CAPABILITIES);
  });

  it("U-PROV-2 the model variables keep their Claude-only check without a registry", () => {
    expect(problemsOf({ GRAFT_LLM_MODEL_FAST: "gpt-5" })).toContain(
      "GRAFT_LLM_MODEL_FAST: must be a Claude model ID",
    );
  });
});

describe("provider registry: parsing", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "graft-providers-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("U-PROV-3 inline YAML: two providers, the roles become the model settings", () => {
    const cfg = testConfig({
      ANTHROPIC_API_KEY: "sk-ant-SHARED",
      GATEWAY_TOKEN: "GATEWAY_SECRET",
      GRAFT_LLM_PROVIDERS: TWO_PROVIDERS,
    });
    const reg = cfg.llmRegistry;
    expect(reg?.providers.map((p) => p.id)).toEqual(["claude", "gateway"]);
    expect(cfg.llmModelFast).toBe("claude/claude-haiku-5-5");
    expect(cfg.llmModelStrong).toBe("gateway/anthropic/claude-sonnet-5.5");
    expect(cfg.llmRefusalFallbackModel).toBe("claude/claude-sonnet-5-5");
    const [claude, gateway] = (reg?.providers ?? []) as AnthropicProvider[];
    expect(claude?.sharedCredential).toBe(true);
    expect(claude?.credential()).toEqual({ apiKey: "sk-ant-SHARED" });
    expect(gateway?.credential()).toEqual({ authToken: "GATEWAY_SECRET" });
    expect(gateway?.capabilities).toEqual({ ...FULL_CAPABILITIES, nativeSchema: false });
    // Unpriced cache rates cost what input does.
    expect(gateway?.prices["anthropic/claude-sonnet-5.5"]).toEqual({
      input: 3,
      output: 15,
      cacheRead: 3,
      cacheWrite: 3,
    });
    // Secrets live in closures: serializing the config never shows them.
    const json = JSON.stringify(cfg);
    expect(json).not.toContain("GATEWAY_SECRET");
    expect(json.match(/sk-ant-SHARED/g)?.length ?? 0).toBe(1); // only anthropicApiKey itself
  });

  it("U-PROV-4 the file form takes JSON as well as YAML", async () => {
    const file = path.join(dir, "providers.json");
    await writeFile(
      file,
      JSON.stringify({
        providers: [{ id: "claude", kind: "anthropic", apiKeyEnv: "MY_KEY" }],
        roles: { fast: "claude/claude-haiku-5-5", strong: "claude/claude-sonnet-5-5" },
      }),
    );
    const cfg = testConfig({ MY_KEY: "k", GRAFT_LLM_PROVIDERS_FILE: file });
    expect(cfg.llmRegistry?.roles).toEqual({
      fast: "claude/claude-haiku-5-5",
      strong: "claude/claude-sonnet-5-5",
      refusalFallback: undefined,
    });
    expect(problemsOf({ GRAFT_LLM_PROVIDERS_FILE: path.join(dir, "missing.yaml") })).toContain(
      "GRAFT_LLM_PROVIDERS_FILE: file cannot be read",
    );
  });

  it("U-PROV-5 every rule names the field, never a value", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-x", SECRET_A: "VALUE_CANARY" };
    const cases: [Record<string, string>, string][] = [
      [
        { GRAFT_LLM_PROVIDERS: TWO_PROVIDERS, GRAFT_LLM_PROVIDERS_FILE: "/x" },
        "GRAFT_LLM_PROVIDERS / GRAFT_LLM_PROVIDERS_FILE: set at most one",
      ],
      [
        { GRAFT_LLM_PROVIDERS: TWO_PROVIDERS, GRAFT_LLM_MODEL_STRONG: "claude-opus-5-5" },
        "GRAFT_LLM_MODEL_STRONG: unset with a provider registry",
      ],
      [{ GRAFT_LLM_PROVIDERS: "providers: [VALUE_CANARY" }, "is not valid YAML or JSON"],
      [{ GRAFT_LLM_PROVIDERS: TWO_PROVIDERS }, "providers[1].authTokenEnv: names a variable"],
      [
        {
          GRAFT_LLM_PROVIDERS:
            "providers: [{id: a, kind: anthropic, apiKeyEnv: SECRET_A, authTokenEnv: SECRET_A}]\nroles: {fast: a/claude-haiku-5-5, strong: a/claude-sonnet-5-5}",
        },
        "set at most one, not both",
      ],
      [
        {
          GRAFT_LLM_PROVIDERS:
            "providers: [{id: a, kind: anthropic, baseUrl: 'https://x.test'}]\nroles: {fast: a/claude-haiku-5-5, strong: a/claude-sonnet-5-5}",
        },
        "providers[0].baseUrl: an entry using the ANTHROPIC_* credential uses ANTHROPIC_BASE_URL",
      ],
      [
        {
          GRAFT_LLM_PROVIDERS:
            "providers: [{id: a, kind: anthropic}, {id: a, kind: anthropic}]\nroles: {fast: a/claude-haiku-5-5, strong: a/claude-sonnet-5-5}",
        },
        "providers[1].id: is used by another provider",
      ],
      [
        {
          GRAFT_LLM_PROVIDERS:
            "providers: [{id: a, kind: anthropic}]\nroles: {fast: b/claude-haiku-5-5, strong: a/claude-sonnet-5-5}",
        },
        "roles.fast: names no configured provider",
      ],
      [
        {
          GRAFT_LLM_PROVIDERS:
            "providers: [{id: a, kind: anthropic}]\nroles: {fast: a/gpt-5, strong: a/claude-sonnet-5-5}",
        },
        "roles.fast: must be a Claude model ID for a anthropic provider",
      ],
      [
        {
          GRAFT_LLM_PROVIDERS:
            "providers: [{id: a, kind: anthropic}]\nroles: {fast: claude-haiku-5-5, strong: a/claude-sonnet-5-5}",
        },
        "roles.fast: must be <provider id>/<model>",
      ],
      [
        {
          GRAFT_LLM_PROVIDERS: "providers: [{id: a, kind: cobol}]\nroles: {fast: a/x, strong: a/y}",
        },
        "providers[0].kind",
      ],
      [
        {
          GRAFT_LLM_PROVIDERS:
            "providers: [{id: a, kind: anthropic, apiKey: VALUE_CANARY}]\nroles: {fast: a/claude-haiku-5-5, strong: a/claude-sonnet-5-5}",
        },
        "GRAFT_LLM_PROVIDERS: providers[0]",
      ],
    ];
    for (const [env, expected] of cases) {
      const msg = problemsOf({ ...base, ...env });
      expect(msg, expected).toContain(expected);
      expect(msg).not.toContain("VALUE_CANARY");
      expect(msg).not.toContain("sk-ant-x");
    }
    // With no ANTHROPIC_* credential an entry without its own key has none.
    expect(
      problemsOf({
        GRAFT_LLM_PROVIDERS:
          "providers: [{id: a, kind: anthropic}]\nroles: {fast: a/claude-haiku-5-5, strong: a/claude-sonnet-5-5}",
      }),
    ).toContain("providers[0]: has no credential");
  });

  it("U-PROV-6 parseRegistry and splitModelRef on their own", () => {
    expect(splitModelRef("gateway/anthropic/claude-sonnet-5.5")).toEqual({
      provider: "gateway",
      model: "anthropic/claude-sonnet-5.5",
    });
    expect(splitModelRef("claude-haiku-5-5")).toBeNull();
    expect(splitModelRef("/x")).toBeNull();
    expect(splitModelRef("x/")).toBeNull();
    const r = parseRegistry(
      "SRC",
      TWO_PROVIDERS,
      { GATEWAY_TOKEN: "t" },
      {
        credential: { apiKey: "k" },
        baseUrl: "https://shared.example.test",
      },
    );
    expect(r.problems).toEqual([]);
    expect((r.registry?.providers[0] as AnthropicProvider | undefined)?.baseUrl).toBe(
      "https://shared.example.test",
    );
  });
});

describe("provider registry: routing", () => {
  it("U-PROV-7 the router sends the bare model to its provider and qualifies the answer", async () => {
    const a = fakeFetch();
    const b = fakeFetch();
    const reg = testConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
      GATEWAY_TOKEN: "gw",
      GRAFT_LLM_PROVIDERS: TWO_PROVIDERS,
    }).llmRegistry;
    const [claude, gateway] = (reg?.providers ?? []) as AnthropicProvider[];
    const llm = createRouterLlm([
      {
        provider: claude as AnthropicProvider,
        client: createAnthropicLlm({
          apiKey: "sk-ant-x",
          baseURL: "https://api.anthropic.test",
          maxRetries: 0,
          refusalFallback: false,
          log: silentLog,
          fetch: a.fn,
        }),
      },
      {
        provider: gateway as AnthropicProvider,
        client: createAnthropicLlm({
          authToken: "gw",
          baseURL: "https://gateway.example.test/api",
          maxRetries: 0,
          refusalFallback: false,
          capabilities: gateway?.capabilities,
          log: silentLog,
          fetch: b.fn,
        }),
      },
    ]);

    const r1 = await llm.complete(req({ model: "claude/claude-haiku-5-5" }));
    expect(r1).toMatchObject({ ok: true, model: "claude/claude-haiku-5-5" });
    expect(a.seen[0]?.body.model).toBe("claude-haiku-5-5");

    const r2 = await llm.complete(req({ model: "gateway/anthropic/claude-sonnet-5.5" }));
    expect(r2).toMatchObject({ ok: true, model: "gateway/anthropic/claude-sonnet-5.5" });
    expect(b.seen[0]?.url).toBe("https://gateway.example.test/api/v1/messages");
    expect(b.seen[0]?.body.model).toBe("anthropic/claude-sonnet-5.5");
    // nativeSchema off: effort is still sent, the schema is not.
    expect(b.seen[0]?.body.output_config).toEqual({ effort: "low" });
    expect(a.seen).toHaveLength(1);

    expect(llm.capabilities?.("gateway/x").nativeSchema).toBe(false);
    expect(llm.capabilities?.("claude/x").nativeSchema).toBe(true);
    await expect(llm.complete(req({ model: "nowhere/claude-haiku-5-5" }))).rejects.toThrow(
      "no configured provider",
    );
    await expect(llm.complete(req({ model: "claude-haiku-5-5" }))).rejects.toThrow();
  });

  it("U-PROV-8 costs: the operator's prices first, then the Claude table for Anthropic-format providers", () => {
    const llm = createLlmClient(
      testConfig({
        ANTHROPIC_API_KEY: "sk-ant-x",
        GATEWAY_TOKEN: "gw",
        GRAFT_LLM_PROVIDERS: TWO_PROVIDERS,
      }),
      silentLog,
    );
    const usage = { ...ZERO_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(llm.costOf?.(usage, "gateway/anthropic/claude-sonnet-5.5")).toBe(18);
    expect(llm.costOf?.(usage, "claude/claude-haiku-5-5-20260101")).toBeCloseTo(0.6);
    expect(llm.costOf?.(usage, "claude/claude-unknown-9")).toBeNull();
    expect(llm.serverRefusalFallback?.("claude/claude-sonnet-5-5")).toBe(true);
    expect(llm.serverRefusalFallback?.("gateway/anthropic/claude-sonnet-5.5")).toBe(false);
  });

  it("U-PROV-9 the startup log lists providers by id, kind and host, never credentials", () => {
    const c = capture();
    createLlmClient(
      testConfig({
        ANTHROPIC_API_KEY: "sk-ant-KEY_CANARY",
        GATEWAY_TOKEN: "TOKEN_CANARY",
        GRAFT_LLM_PROVIDERS: TWO_PROVIDERS.replace(
          "https://gateway.example.test/api",
          "https://user:URL_CANARY@gateway.example.test/api",
        ),
      }),
      c.log,
    );
    const out = c.text();
    expect(out).toContain("llm client: registry");
    expect(out).toContain('"id":"gateway","kind":"anthropic","host":"gateway.example.test"');
    expect(out).toContain('"auth":"shared"');
    for (const canary of ["KEY_CANARY", "TOKEN_CANARY", "URL_CANARY"]) {
      expect(out, canary).not.toContain(canary);
    }
  });

  it("U-PROV-10 a provider without native schema gets the schema in the system prompt", () => {
    expect(systemWithSchema("S", SCHEMA, true)).toBe("S");
    const withSchema = systemWithSchema("S", SCHEMA, false);
    expect(withSchema.startsWith("S\n\n")).toBe(true);
    expect(withSchema).toContain(JSON.stringify(SCHEMA));
  });
});
