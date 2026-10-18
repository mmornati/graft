import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../../src/core/logger.js";
import { agreeingVerifier, createFakeLlm, forbiddenLlm, scriptedLlm } from "../../src/llm/fake.js";
import {
  createAnthropicLlm,
  createLlmClient,
  isClaudeApi,
  unconfiguredLlm,
} from "../../src/llm/index.js";
import type { LlmRequest } from "../../src/llm/types.js";
import { testConfig } from "../helpers/config.js";
import { expectDuration } from "../helpers/perf.js";
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

interface Seen {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

function message(over: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5-20260101",
    content: [{ type: "text", text: '{"ok":true}' }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3,
    },
    ...over,
  };
}

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const seen: Seen[] = [];
  const fn: typeof fetch = async (input, init) => {
    const r = input instanceof Request ? input : undefined;
    const url = r ? r.url : String(input);
    const raw = init?.body ?? (r ? await r.text() : "{}");
    seen.push({
      url,
      body: JSON.parse(String(raw)) as Record<string, unknown>,
      headers: new Headers(init?.headers ?? r?.headers),
    });
    const next = responses[Math.min(seen.length - 1, responses.length - 1)];
    return (next as () => Response | Promise<Response>)();
  };
  return { fn, seen };
}
const ok =
  (body: unknown = message()) =>
  () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
const status = (code: number) => () =>
  new Response(
    JSON.stringify({ type: "error", error: { type: "x", message: "SECRET_ERROR_BODY" } }),
    {
      status: code,
      headers: { "content-type": "application/json" },
    },
  );

function client(
  f: typeof fetch,
  o: { maxRetries?: number; refusalFallback?: boolean; log?: ReturnType<typeof createLogger> } = {},
) {
  return createAnthropicLlm({
    apiKey: "sk-ant-test-key",
    maxRetries: o.maxRetries ?? 0,
    refusalFallback: o.refusalFallback ?? false,
    log: o.log ?? silentLog,
    fetch: f,
    baseURL: "https://api.anthropic.test",
  });
}

describe("anthropic client", () => {
  it("U-LLM-1 request shape", async () => {
    const { fn, seen } = fakeFetch([ok()]);
    await client(fn).complete(req());
    const b = seen[0]?.body ?? {};
    expect(seen[0]?.url).toBe("https://api.anthropic.test/v1/messages");
    expect(b.model).toBe("claude-haiku-5-5");
    expect(b.max_tokens).toBe(8192);
    expect(b.system).toEqual([
      { type: "text", text: "SYSTEM_CANARY_PROMPT", cache_control: { type: "ephemeral" } },
    ]);
    expect(b.messages).toEqual([{ role: "user", content: "USER_CANARY_DIFF" }]);
    expect(b.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema: SCHEMA },
    });
    for (const k of [
      "temperature",
      "top_p",
      "top_k",
      "tool_choice",
      "thinking",
      "betas",
      "fallbacks",
      "stream",
    ]) {
      expect(b, k).not.toHaveProperty(k);
    }
  });

  it("U-LLM-2 the refusal fallback is only for Sonnet/Opus and only when enabled", async () => {
    const sonnet = fakeFetch([ok()]);
    await client(sonnet.fn, { refusalFallback: true }).complete(
      req({ model: "claude-sonnet-5-5" }),
    );
    expect(sonnet.seen[0]?.url).toContain("/v1/messages");
    expect(sonnet.seen[0]?.url).toContain("beta=true");
    expect(sonnet.seen[0]?.body.fallbacks).toBe("default");
    expect(sonnet.seen[0]?.headers.get("anthropic-beta")).toContain(
      "server-side-fallback-2026-07-01",
    );
    expect(sonnet.seen[0]?.body).not.toHaveProperty("betas");

    const opus = fakeFetch([ok()]);
    await client(opus.fn, { refusalFallback: true }).complete(req({ model: "claude-opus-5-5" }));
    expect(opus.seen[0]?.body.fallbacks).toBe("default");

    const haiku = fakeFetch([ok()]);
    await client(haiku.fn, { refusalFallback: true }).complete(req({ model: "claude-haiku-5-5" }));
    expect(haiku.seen[0]?.body).not.toHaveProperty("fallbacks");
    expect(haiku.seen[0]?.url).not.toContain("beta=true");

    const off = fakeFetch([ok()]);
    await client(off.fn, { refusalFallback: false }).complete(req({ model: "claude-sonnet-5-5" }));
    expect(off.seen[0]?.body).not.toHaveProperty("fallbacks");
  });

  it("U-LLM-3 a good reply gives the parsed value, all four counters and the answering model", async () => {
    const { fn } = fakeFetch([ok()]);
    const r = await client(fn).complete(req());
    expect(r).toMatchObject({
      ok: true,
      value: { ok: true },
      model: "claude-haiku-5-5-20260101",
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 },
    });
    const { fn: fn2 } = fakeFetch([
      ok(
        message({
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
          },
        }),
      ),
    ]);
    const r2 = await client(fn2).complete(req());
    expect(r2.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("U-LLM-4 refusal, max_tokens and invalid JSON", async () => {
    const run = async (m: unknown) =>
      (await client(fakeFetch([ok(m)]).fn).complete(req())) as {
        ok: boolean;
        failure?: string;
        usage: { inputTokens: number };
      };
    expect(await run(message({ stop_reason: "refusal" }))).toMatchObject({
      ok: false,
      failure: "refusal",
    });
    expect(await run(message({ stop_reason: "max_tokens" }))).toMatchObject({
      ok: false,
      failure: "max_tokens",
      usage: { inputTokens: 11 },
    });
    expect(await run(message({ content: [{ type: "text", text: "not json" }] }))).toMatchObject({
      ok: false,
      failure: "invalid_json",
    });
    // thinking blocks are ignored and text blocks are joined
    const joined = await run(
      message({
        content: [
          { type: "thinking", thinking: "hmm", signature: "s" },
          { type: "text", text: '{"ok":' },
          { type: "text", text: "true}" },
        ],
      }),
    );
    expect(joined).toMatchObject({ ok: true });
  });

  it("U-LLM-5 HTTP errors map to failures and carry zero usage", async () => {
    for (const [code, failure] of [
      [429, "rate_limited"],
      [500, "unavailable"],
      [529, "unavailable"],
      [401, "auth"],
      [403, "auth"],
      [400, "bad_request"],
      [404, "bad_request"],
    ] as const) {
      const r = await client(fakeFetch([status(code)]).fn).complete(req());
      expect(r, String(code)).toMatchObject({
        ok: false,
        failure,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
    }
  });

  it("U-LLM-6 a request that never answers times out", async () => {
    const never: typeof fetch = (_i, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(new DOMException("aborted", "AbortError")),
        );
      });
    const r = await client(never).complete(req({ timeoutMs: 50 }));
    expect(r).toMatchObject({ ok: false, failure: "timeout" });
  });

  it("U-LLM-7 a connection failure is unavailable", async () => {
    const boom: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await client(boom).complete(req())).toMatchObject({ ok: false, failure: "unavailable" });
  });

  it("U-LLM-8 logs carry token counts and never the prompts, output or error bodies", async () => {
    let out = "";
    const stream = new Writable({
      write(chunk, _e, cb) {
        out += String(chunk);
        cb();
      },
    });
    const log = createLogger({ logLevel: "debug" }, stream);
    await client(
      fakeFetch([ok(message({ content: [{ type: "text", text: '{"leak":"RESPONSE_CANARY"}' }] }))])
        .fn,
      { log },
    ).complete(req());
    await client(fakeFetch([status(500)]).fn, { log }).complete(req());
    expect(out).toContain('"inputTokens":11');
    expect(out).toContain('"outputTokens":7');
    expect(out).toContain('"cacheReadTokens":5');
    expect(out).toContain('"cacheWriteTokens":3');
    for (const canary of [
      "SYSTEM_CANARY_PROMPT",
      "USER_CANARY_DIFF",
      "RESPONSE_CANARY",
      "SECRET_ERROR_BODY",
      "sk-ant-test-key",
    ]) {
      expect(out, canary).not.toContain(canary);
    }
  });

  it("U-LLM-9 the unconfigured client fails, and createLlmClient picks by API key", async () => {
    expect(await unconfiguredLlm().complete(req())).toMatchObject({
      ok: false,
      failure: "not_configured",
    });
    const cfg = testConfig();
    let lines = "";
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines += String(chunk);
        cb();
      },
    });
    const log = createLogger({ logLevel: "info" }, stream);
    const none = createLlmClient(cfg, log);
    expect(await none.complete(req())).toMatchObject({ failure: "not_configured" });
    expect(lines).toContain("llm client: unconfigured");
    const withKey = createLlmClient(testConfig({ ANTHROPIC_API_KEY: "sk-ant-x" }), log);
    expect(lines).toContain("llm client: anthropic");
    expect(withKey).not.toBe(none);
  });

  it("U-LLM-10 the SDK retries a 529 once with maxRetries 1", async () => {
    const { fn, seen } = fakeFetch([status(529), ok()]);
    const r = await client(fn, { maxRetries: 1 }).complete(req());
    expect(r).toMatchObject({ ok: true });
    expect(seen).toHaveLength(2);
  });

  it("U-LLM-11 only the text after the last fallback block is the answer", async () => {
    const reply = message({
      content: [
        { type: "text", text: '{"go' },
        { type: "fallback", model: "claude-sonnet-5-5" },
        { type: "text", text: '{"ok":' },
        { type: "text", text: "true}" },
      ],
    });
    const { fn } = fakeFetch([ok(reply)]);
    const r = await client(fn, { refusalFallback: true }).complete(
      req({ model: "claude-sonnet-5-5" }),
    );
    expect(r).toMatchObject({ ok: true, value: { ok: true } });
    // Without a fallback block all the text blocks are joined, as before.
    const two = message({
      content: [
        { type: "text", text: '{"ok"' },
        { type: "text", text: ":true}" },
      ],
    });
    expect(await client(fakeFetch([ok(two)]).fn).complete(req())).toMatchObject({
      ok: true,
      value: { ok: true },
    });
  });

  it("U-LLM-12 deadlineMs bounds the whole call, SDK retries included", async () => {
    let attempts = 0;
    const never: typeof fetch = (_i, init) =>
      new Promise((_res, rej) => {
        attempts += 1;
        init?.signal?.addEventListener("abort", () =>
          rej(new DOMException("aborted", "AbortError")),
        );
      });
    const started = Date.now();
    const r = await client(never, { maxRetries: 3 }).complete(
      req({ timeoutMs: 150, deadlineMs: 250 }),
    );
    expect(r).toMatchObject({ ok: false, failure: "timeout" });
    // Without the signal: 4 attempts of 150 ms plus backoff, well past a second.
    expectDuration(Date.now() - started, 700);
    expect(attempts).toBeLessThanOrEqual(2);
  });
});

describe("gateways and bearer tokens", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("U-LLM-13 a bearer token goes to the configured base URL, and the process env is never read", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-FROM-ENV");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://env.example.test");
    const f = fakeFetch([ok()]);
    const llm = createAnthropicLlm({
      authToken: "or-token-value",
      baseURL: "https://openrouter.ai/api",
      maxRetries: 0,
      refusalFallback: false,
      log: silentLog,
      fetch: f.fn,
    });
    expect(await llm.complete(req({ model: "anthropic/claude-haiku-5.5" }))).toMatchObject({
      ok: true,
    });
    expect(f.seen[0]?.url).toBe("https://openrouter.ai/api/v1/messages");
    expect(f.seen[0]?.headers.get("authorization")).toBe("Bearer or-token-value");
    expect(f.seen[0]?.headers.has("x-api-key")).toBe(false);
    expect(f.seen[0]?.body.model).toBe("anthropic/claude-haiku-5.5");

    // An API key alone sends only x-api-key, to the Claude API when no base URL is given.
    const g = fakeFetch([ok()]);
    await createAnthropicLlm({
      apiKey: "sk-ant-config",
      maxRetries: 0,
      refusalFallback: false,
      log: silentLog,
      fetch: g.fn,
    }).complete(req());
    expect(g.seen[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(g.seen[0]?.headers.get("x-api-key")).toBe("sk-ant-config");
    expect(g.seen[0]?.headers.has("authorization")).toBe(false);
  });

  it("U-LLM-14 the server-side refusal fallback is only offered on the Claude API", () => {
    expect(isClaudeApi(undefined)).toBe(true);
    expect(isClaudeApi("https://api.anthropic.com")).toBe(true);
    expect(isClaudeApi("https://openrouter.ai/api")).toBe(false);
    expect(isClaudeApi("https://bedrock-mantle.us-east-1.api.aws/anthropic")).toBe(false);

    const direct = createLlmClient(testConfig({ ANTHROPIC_API_KEY: "sk-ant-x" }), silentLog);
    expect(direct.serverRefusalFallback?.("claude-sonnet-5-5")).toBe(true);
    expect(direct.serverRefusalFallback?.("claude-haiku-5-5")).toBe(false);
    const gateway = createLlmClient(
      testConfig({
        ANTHROPIC_AUTH_TOKEN: "or-token",
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      }),
      silentLog,
    );
    expect(gateway.serverRefusalFallback?.("claude-sonnet-5-5")).toBe(false);
  });

  it("U-LLM-15 the client log names the gateway host, never the URL or the token", () => {
    let lines = "";
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines += String(chunk);
        cb();
      },
    });
    const log = createLogger({ logLevel: "info" }, stream);
    createLlmClient(
      testConfig({
        ANTHROPIC_AUTH_TOKEN: "TOKEN_CANARY",
        ANTHROPIC_BASE_URL: "https://user:URL_CANARY@gateway.example.test/v1",
      }),
      log,
    );
    expect(lines).toContain('"host":"gateway.example.test"');
    expect(lines).not.toContain("URL_CANARY");
    expect(lines).not.toContain("TOKEN_CANARY");
  });
});

describe("workload identity federation", () => {
  const RULE = "fdrl_01TestRule";
  const ORG = "00000000-0000-4000-8000-000000000000";
  const SVAC = "svac_01TestAccount";
  const WORKSPACE = "wrkspc_01TestWorkspace";
  let dir = "";
  let tokenFile = "";

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "graft-wif-"));
    tokenFile = path.join(dir, "token");
    await writeFile(tokenFile, "eyJhbGciOiJSUzI1NiJ9.ONE.sig\n");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  const federation = (over: { workspaceId?: string } = {}) => ({
    ruleId: RULE,
    organizationId: ORG,
    serviceAccountId: SVAC,
    workspaceId: over.workspaceId,
    identityTokenFile: tokenFile,
  });
  const exchanged = (token: string, expiresIn = 3600) =>
    ok({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
  const fedClient = (f: typeof fetch, o: { maxRetries?: number; log?: Logger } = {}) =>
    createAnthropicLlm({
      federation: federation({ workspaceId: WORKSPACE }),
      maxRetries: o.maxRetries ?? 0,
      refusalFallback: false,
      log: o.log ?? silentLog,
      fetch: f,
    });

  it("U-LLM-16 the identity token is exchanged (jwt-bearer) and the minted token is the Bearer; the env is never read", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-FROM-ENV");
    vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "fdrl_FROM_ENV");
    const f = fakeFetch([exchanged("sk-ant-oat01-MINTED"), ok(), ok()]);
    const llm = fedClient(f.fn);
    expect(await llm.complete(req())).toMatchObject({ ok: true });

    expect(f.seen[0]?.url).toBe("https://api.anthropic.com/v1/oauth/token");
    expect(f.seen[0]?.body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "eyJhbGciOiJSUzI1NiJ9.ONE.sig",
      federation_rule_id: RULE,
      organization_id: ORG,
      service_account_id: SVAC,
      workspace_id: WORKSPACE,
    });
    expect(f.seen[0]?.headers.get("anthropic-beta")).toContain("oidc-federation-2026-04-01");
    expect(f.seen[1]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(f.seen[1]?.headers.get("authorization")).toBe("Bearer sk-ant-oat01-MINTED");
    expect(f.seen[1]?.headers.has("x-api-key")).toBe(false);
    expect(f.seen[1]?.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");

    // The minted token is cached: the next call goes straight to the Messages API.
    expect(await llm.complete(req())).toMatchObject({ ok: true });
    expect(f.seen.map((s) => new URL(s.url).pathname)).toEqual([
      "/v1/oauth/token",
      "/v1/messages",
      "/v1/messages",
    ]);

    // A base URL is the host of both the exchange and the calls.
    const g = fakeFetch([exchanged("sk-ant-oat01-B"), ok()]);
    await createAnthropicLlm({
      federation: federation(),
      baseURL: "https://proxy.example.test/",
      maxRetries: 0,
      refusalFallback: false,
      log: silentLog,
      fetch: g.fn,
    }).complete(req());
    expect(g.seen[0]?.url).toBe("https://proxy.example.test/v1/oauth/token");
    expect(g.seen[0]?.body).not.toHaveProperty("workspace_id");
    expect(g.seen[1]?.url).toBe("https://proxy.example.test/v1/messages");
  });

  it("U-LLM-17 every refresh re-reads the token file (expiry and a 401 alike)", async () => {
    const f = fakeFetch([
      exchanged("sk-ant-oat01-FIRST", 10), // inside the mandatory refresh window
      ok(),
      exchanged("sk-ant-oat01-SECOND"),
      ok(),
      status(401),
      exchanged("sk-ant-oat01-THIRD"),
      ok(),
    ]);
    const llm = fedClient(f.fn, { maxRetries: 1 });
    expect(await llm.complete(req())).toMatchObject({ ok: true });
    await writeFile(tokenFile, "eyJhbGciOiJSUzI1NiJ9.TWO.sig");
    expect(await llm.complete(req())).toMatchObject({ ok: true });
    await writeFile(tokenFile, "eyJhbGciOiJSUzI1NiJ9.THREE.sig");
    expect(await llm.complete(req())).toMatchObject({ ok: true });

    const exchanges = f.seen.filter((s) => s.url.endsWith("/v1/oauth/token"));
    expect(exchanges.map((s) => s.body.assertion)).toEqual([
      "eyJhbGciOiJSUzI1NiJ9.ONE.sig",
      "eyJhbGciOiJSUzI1NiJ9.TWO.sig",
      "eyJhbGciOiJSUzI1NiJ9.THREE.sig",
    ]);
    const calls = f.seen.filter((s) => s.url.endsWith("/v1/messages"));
    expect(calls.map((s) => s.headers.get("authorization"))).toEqual([
      "Bearer sk-ant-oat01-FIRST",
      "Bearer sk-ant-oat01-SECOND",
      "Bearer sk-ant-oat01-SECOND",
      "Bearer sk-ant-oat01-THIRD",
    ]);
  });

  it("U-LLM-18 a failed exchange is an LLM failure, not a programmer error, and leaks nothing", async () => {
    let lines = "";
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines += String(chunk);
        cb();
      },
    });
    const log = createLogger({ logLevel: "info" }, stream);
    const cases: [string, () => Response | Promise<Response>, string][] = [
      ["401", status(401), "auth"],
      ["400", status(400), "auth"],
      ["403", status(403), "auth"],
      ["429", status(429), "rate_limited"],
      ["503", status(503), "unavailable"],
      [
        "network",
        () => {
          throw new TypeError("fetch failed");
        },
        "unavailable",
      ],
      ["no access_token", ok({ token_type: "Bearer", expires_in: 60 }), "auth"],
    ];
    for (const [name, response, failure] of cases) {
      const f = fakeFetch([response, ok()]);
      const r = await fedClient(f.fn, { log }).complete(req());
      expect(r, name).toMatchObject({ ok: false, failure });
      expect(
        f.seen.some((s) => s.url.endsWith("/v1/messages")),
        name,
      ).toBe(false);
    }

    // An unreadable or empty token file never reaches the network.
    for (const content of [null, "  \n"]) {
      if (content === null) await rm(tokenFile);
      else await writeFile(tokenFile, content);
      const f = fakeFetch([exchanged("sk-ant-oat01-X"), ok()]);
      expect(await fedClient(f.fn, { log }).complete(req())).toMatchObject({
        ok: false,
        failure: "auth",
      });
      expect(f.seen).toHaveLength(0);
    }

    expect(lines).toContain('"name":"FederationError"');
    expect(lines).not.toContain("SECRET_ERROR_BODY");
    expect(lines).not.toContain("eyJhbGciOiJSUzI1NiJ9");
    expect(lines).not.toContain(tokenFile);
  });

  it("U-LLM-19 the client log names the rule and the host, never the token, its path or the other IDs", async () => {
    let lines = "";
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines += String(chunk);
        cb();
      },
    });
    const log = createLogger({ logLevel: "info" }, stream);
    const llm = createLlmClient(
      testConfig({
        ANTHROPIC_FEDERATION_RULE_ID: RULE,
        ANTHROPIC_ORGANIZATION_ID: ORG,
        ANTHROPIC_SERVICE_ACCOUNT_ID: SVAC,
        ANTHROPIC_WORKSPACE_ID: WORKSPACE,
        ANTHROPIC_IDENTITY_TOKEN_FILE: tokenFile,
      }),
      log,
    );
    expect(llm.serverRefusalFallback?.("claude-sonnet-5-5")).toBe(true);
    expect(lines).toContain(`"federationRuleId":"${RULE}"`);
    expect(lines).toContain('"auth":"federation"');
    expect(lines).toContain('"host":"default"');
    for (const v of [ORG, SVAC, WORKSPACE, tokenFile]) expect(lines).not.toContain(v);

    // Redaction covers the federation settings wherever a config object is logged.
    lines = "";
    log.info(
      {
        config: testConfig({
          ANTHROPIC_FEDERATION_RULE_ID: RULE,
          ANTHROPIC_ORGANIZATION_ID: ORG,
          ANTHROPIC_SERVICE_ACCOUNT_ID: SVAC,
          ANTHROPIC_IDENTITY_TOKEN_FILE: tokenFile,
        }),
      },
      "x",
    );
    for (const v of [ORG, SVAC, tokenFile]) expect(lines).not.toContain(v);
  });
});

describe("fake LLM", () => {
  it("U-FAKE-1 scriptedLlm routes by purpose; agreeingVerifier returns every claim id; forbiddenLlm throws", async () => {
    const llm = scriptedLlm({
      writer: { json: { who: "writer" } },
      writerEscalated: () => ({ json: { who: "escalated" } }),
      verifier: agreeingVerifier,
    });
    expect(await llm.complete(req({ purpose: "writer" }))).toMatchObject({
      value: { who: "writer" },
    });
    expect(await llm.complete(req({ purpose: "writer_escalated" }))).toMatchObject({
      value: { who: "escalated" },
    });
    const card = JSON.stringify({ claims: [{ id: "goal" }, { id: "b1" }, { id: "o1" }] });
    const v = await llm.complete(
      req({
        purpose: "verifier",
        user: `x\n\n<untrusted_data_abc123 kind="intent_card">\n${card}\n</untrusted_data_abc123>\n\ny`,
      }),
    );
    expect((v as { value: { claims: { id: string }[] } }).value.claims.map((c) => c.id)).toEqual([
      "goal",
      "b1",
      "o1",
    ]);
    expect(llm.calls).toHaveLength(3);
    await expect(forbiddenLlm().complete(req())).rejects.toThrow(/must not be called/);

    const fail = createFakeLlm(() => ({ failure: "timeout" }));
    expect(await fail.complete(req())).toMatchObject({ ok: false, failure: "timeout" });
    const usage = createFakeLlm(() => ({ json: {}, usage: { inputTokens: 5 }, model: "m" }));
    expect(await usage.complete(req())).toMatchObject({
      usage: { inputTokens: 5, outputTokens: 100 },
      model: "m",
    });
    const unscripted = scriptedLlm({});
    await expect(unscripted.complete(req())).rejects.toThrow(/no script/);
  });
});
