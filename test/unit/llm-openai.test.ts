import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/config/index.js";
import { createLogger, type Logger } from "../../src/core/logger.js";
import {
  createLlmClient,
  createOpenAiCompatibleLlm,
  parseJsonAnswer,
} from "../../src/llm/index.js";
import type { OpenAiCompatibleOptions } from "../../src/llm/openai-compatible.js";
import { DEFAULT_CAPABILITIES, type OpenAiCompatibleProvider } from "../../src/llm/registry.js";
import { type LlmRequest, ZERO_USAGE } from "../../src/llm/types.js";
import { testConfig } from "../helpers/config.js";
import { silentLog } from "../helpers/stubs.js";

const OBJECT_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } };
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  purpose: "writer",
  model: "qwen3-coder-30b-a3b",
  system: "SYSTEM_CANARY_PROMPT",
  user: "USER_CANARY_DIFF",
  outputSchema: { anyOf: [OBJECT_SCHEMA] },
  maxOutputTokens: 8192,
  effort: "low",
  timeoutMs: 5000,
  ...over,
});

function completion(over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "qwen3-coder:30b",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: '{"ok":true}', refusal: null, ...message },
      },
    ],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 200 },
    },
    ...over,
  };
}

interface Seen {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}
function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const seen: Seen[] = [];
  const fn: typeof fetch = async (input, init) => {
    const r = input instanceof Request ? input : undefined;
    seen.push({
      url: r ? r.url : String(input),
      body: JSON.parse(String(init?.body ?? (r ? await r.text() : "{}"))),
      headers: new Headers(init?.headers ?? r?.headers),
    });
    const next = responses[Math.min(seen.length - 1, responses.length - 1)];
    return (next as () => Response | Promise<Response>)();
  };
  return { fn, seen };
}
const ok =
  (body: unknown = completion()) =>
  () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
const status = (code: number) => () =>
  new Response(JSON.stringify({ error: { message: "SECRET_ERROR_BODY" } }), {
    status: code,
    headers: { "content-type": "application/json" },
  });

function client(f: typeof fetch, over: Partial<OpenAiCompatibleOptions> = {}) {
  return createOpenAiCompatibleLlm({
    baseURL: "http://ollama.test:11434/v1",
    apiKey: undefined,
    maxRetries: 0,
    capabilities: DEFAULT_CAPABILITIES["openai-compatible"],
    zeroRetention: false,
    maxTokensParam: "max_tokens",
    log: silentLog,
    fetch: f,
    ...over,
  });
}

function capture(): { log: Logger; text: () => string } {
  let out = "";
  const stream = new Writable({
    write(chunk, _e, cb) {
      out += String(chunk);
      cb();
    },
  });
  return { log: createLogger({ logLevel: "debug" }, stream), text: () => out };
}

describe("openai-compatible client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("U-OAI-1 request shape: system and user messages, a JSON schema, the token limit, nothing else", async () => {
    const { fn, seen } = fakeFetch([ok(), ok()]);
    await client(fn).complete(req());
    const s = seen[0] as Seen;
    expect(s.url).toBe("http://ollama.test:11434/v1/chat/completions");
    expect(s.body.model).toBe("qwen3-coder-30b-a3b");
    expect(s.body.messages).toEqual([
      { role: "system", content: "SYSTEM_CANARY_PROMPT" },
      { role: "user", content: "USER_CANARY_DIFF" },
    ]);
    expect(s.body.max_tokens).toBe(8192);
    // An anyOf root cannot be strict; an object root is.
    expect(s.body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "graft_output", schema: { anyOf: [OBJECT_SCHEMA] }, strict: false },
    });
    for (const k of [
      "reasoning_effort",
      "provider",
      "temperature",
      "tools",
      "stream",
      "max_completion_tokens",
    ]) {
      expect(s.body, k).not.toHaveProperty(k);
    }

    await client(fn, {
      capabilities: { ...DEFAULT_CAPABILITIES["openai-compatible"], effort: true },
      maxTokensParam: "max_completion_tokens",
    }).complete(req({ outputSchema: OBJECT_SCHEMA, effort: "medium" }));
    const t = seen[1] as Seen;
    expect(t.body.reasoning_effort).toBe("medium");
    expect(t.body.max_completion_tokens).toBe(8192);
    expect(t.body).not.toHaveProperty("max_tokens");
    expect(
      (t.body.response_format as { json_schema: { strict: boolean } }).json_schema.strict,
    ).toBe(true);
  });

  it("U-OAI-2 without native schema support no response_format is sent", async () => {
    const { fn, seen } = fakeFetch([ok()]);
    await client(fn, {
      capabilities: { ...DEFAULT_CAPABILITIES["openai-compatible"], nativeSchema: false },
    }).complete(req());
    expect(seen[0]?.body).not.toHaveProperty("response_format");
  });

  it("U-OAI-3 a good reply: the value, usage with cache reads counted apart, the answering model", async () => {
    const r = await client(fakeFetch([ok()]).fn).complete(req());
    expect(r).toMatchObject({
      ok: true,
      value: { ok: true },
      model: "qwen3-coder:30b",
      usage: { inputTokens: 1000, outputTokens: 80, cacheReadTokens: 200, cacheWriteTokens: 0 },
    });
    const noUsage = await client(fakeFetch([ok()]).fn, {
      capabilities: { ...DEFAULT_CAPABILITIES["openai-compatible"], reportsUsage: false },
    }).complete(req());
    expect(noUsage.usage).toEqual(ZERO_USAGE);
  });

  it("U-OAI-4 refusal, content filter, length, bad JSON and an empty reply", async () => {
    const cases: [unknown, string][] = [
      [completion({}, { content: null, refusal: "I can't." }), "refusal"],
      [
        completion({
          choices: [
            {
              index: 0,
              finish_reason: "content_filter",
              message: { role: "assistant", content: "" },
            },
          ],
        }),
        "refusal",
      ],
      [
        completion({
          choices: [
            {
              index: 0,
              finish_reason: "length",
              message: { role: "assistant", content: '{"ok":' },
            },
          ],
        }),
        "max_tokens",
      ],
      [completion({}, { content: "Sure! Here it is." }), "invalid_json"],
      [completion({ choices: [] }), "invalid_json"],
    ];
    for (const [body, failure] of cases) {
      expect(await client(fakeFetch([ok(body)]).fn).complete(req()), failure).toMatchObject({
        ok: false,
        failure,
      });
    }
  });

  it("U-OAI-5 one Markdown fence around the answer is accepted, nothing else is repaired", () => {
    expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonAnswer('```\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonAnswer('  {"a":1}\n')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonAnswer('Here: {"a":1}')).toEqual({ ok: false });
    expect(parseJsonAnswer('```json\n{"a":1}\n```\nDone.')).toEqual({ ok: false });
  });

  it("U-OAI-6 HTTP and connection errors map to failures with zero usage", async () => {
    for (const [code, failure] of [
      [400, "bad_request"],
      [401, "auth"],
      [403, "auth"],
      [404, "bad_request"],
      [429, "rate_limited"],
      [500, "unavailable"],
      [503, "unavailable"],
    ] as const) {
      expect(
        await client(fakeFetch([status(code)]).fn).complete(req()),
        String(code),
      ).toMatchObject({ ok: false, failure, usage: ZERO_USAGE });
    }
    const refused: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await client(refused).complete(req())).toMatchObject({ failure: "unavailable" });
    const never: typeof fetch = (_i, init) =>
      new Promise((_r, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    expect(await client(never).complete(req({ timeoutMs: 50, deadlineMs: 50 }))).toMatchObject({
      failure: "timeout",
    });
  });

  it("U-OAI-7 OpenRouter gets provider routing, with zero retention when asked", async () => {
    const { fn, seen } = fakeFetch([ok(), ok()]);
    await client(fn, { baseURL: "https://openrouter.ai/api/v1", apiKey: "or-key" }).complete(req());
    expect(seen[0]?.body.provider).toEqual({ require_parameters: true });
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer or-key");
    await client(fn, {
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "or-key",
      zeroRetention: true,
    }).complete(req());
    expect(seen[1]?.body.provider).toEqual({
      require_parameters: true,
      zdr: true,
      data_collection: "deny",
    });
  });

  it("U-OAI-8 the OPENAI_* environment is never used and the SDK never logs", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-FROM-ENV");
    vi.stubEnv("OPENAI_BASE_URL", "https://env.example.test/v1");
    vi.stubEnv("OPENAI_ORG_ID", "org-FROM-ENV");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-FROM-ENV");
    vi.stubEnv("OPENAI_LOG", "debug");
    const spies = (["log", "debug", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const { fn, seen } = fakeFetch([ok()]);
    await client(fn).complete(req());
    const s = seen[0] as Seen;
    expect(s.url.startsWith("http://ollama.test:11434/v1")).toBe(true);
    expect(s.headers.get("authorization")).toBe("Bearer no-key");
    expect(s.headers.has("openai-organization")).toBe(false);
    expect(s.headers.has("openai-project")).toBe(false);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("U-OAI-9 logs carry token counts and never the prompts, output, key or error bodies", async () => {
    const c = capture();
    await client(fakeFetch([ok(completion({}, { content: '{"leak":"RESPONSE_CANARY"}' }))]).fn, {
      log: c.log,
      apiKey: "KEY_CANARY",
    }).complete(req());
    await client(fakeFetch([status(500)]).fn, { log: c.log, apiKey: "KEY_CANARY" }).complete(req());
    const out = c.text();
    expect(out).toContain('"inputTokens":1000');
    for (const canary of [
      "SYSTEM_CANARY_PROMPT",
      "USER_CANARY_DIFF",
      "RESPONSE_CANARY",
      "SECRET_ERROR_BODY",
      "KEY_CANARY",
    ]) {
      expect(out, canary).not.toContain(canary);
    }
  });
});

const OLLAMA = `
providers:
  - id: claude
    kind: anthropic
  - id: ollama
    kind: openai-compatible
    baseUrl: http://ollama:11434/v1
    prices:
      qwen3-coder: { input: 0, output: 0 }
  - id: openai
    kind: openai-compatible
    baseUrl: https://api.openai.com/v1
    apiKeyEnv: OPENAI_KEY
roles:
  fast: ollama/qwen3-coder:30b
  strong: claude/claude-sonnet-5-5
  refusalFallback: openai/gpt-5.5
`;

describe("openai-compatible providers in the registry", () => {
  it("U-OAI-10 an openai-compatible entry: generic model IDs, its own defaults, the OpenAI token field", () => {
    const cfg = testConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
      OPENAI_KEY: "sk-openai",
      GRAFT_LLM_PROVIDERS: OLLAMA,
    });
    const [, ollama, openai] = (cfg.llmRegistry?.providers ?? []) as OpenAiCompatibleProvider[];
    expect(cfg.llmModelFast).toBe("ollama/qwen3-coder:30b");
    expect(ollama?.capabilities).toEqual(DEFAULT_CAPABILITIES["openai-compatible"]);
    expect(ollama?.credential()).toBeUndefined();
    expect(ollama?.maxTokensParam).toBe("max_tokens");
    expect(openai?.credential()).toBe("sk-openai");
    expect(openai?.maxTokensParam).toBe("max_completion_tokens");
    expect(JSON.stringify(cfg)).not.toContain("sk-openai");

    const llm = createLlmClient(cfg, silentLog);
    expect(llm.capabilities?.("ollama/qwen3-coder:30b").effort).toBe(false);
    const usage = { ...ZERO_USAGE, inputTokens: 1_000_000 };
    expect(llm.costOf?.(usage, "ollama/qwen3-coder:30b")).toBe(0);
    // No built-in price table for other formats: unpriced unless the entry says.
    expect(llm.costOf?.(usage, "openai/gpt-5.5")).toBeNull();
    expect(llm.serverRefusalFallback?.("ollama/qwen3-coder:30b")).toBe(false);
  });

  it("U-OAI-11 entry rules: baseUrl required, zeroRetention only on OpenRouter, Claude-only stays on anthropic", () => {
    const problems = (yaml: string, env: Record<string, string> = {}): string => {
      try {
        testConfig({ GRAFT_LLM_PROVIDERS: yaml, ...env });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      throw new Error("expected a ConfigError");
    };
    const roles = "roles: {fast: o/m, strong: o/m}";
    expect(problems(`providers: [{id: o, kind: openai-compatible}]\n${roles}`)).toContain(
      "providers[0].baseUrl",
    );
    expect(
      problems(
        `providers: [{id: o, kind: openai-compatible, baseUrl: 'http://x.test/v1', zeroRetention: true}]\n${roles}`,
      ),
    ).toContain("providers[0].zeroRetention: is only understood by OpenRouter");
    expect(
      problems(
        `providers: [{id: o, kind: openai-compatible, baseUrl: 'http://x.test/v1', apiKeyEnv: NOPE}]\n${roles}`,
      ),
    ).toContain("providers[0].apiKeyEnv: names a variable that is not set");
    expect(
      problems(
        `providers: [{id: o, kind: openai-compatible, baseUrl: 'http://x.test/v1'}]\nroles: {fast: o/has space, strong: o/m}`,
      ),
    ).toContain("roles.fast: must be a model ID for a openai-compatible provider");
    expect(
      problems(
        `providers: [{id: o, kind: openai-compatible, baseUrl: 'http://x.test/v1', authTokenEnv: X}]\n${roles}`,
      ),
    ).toContain("providers[0]");
  });
});
