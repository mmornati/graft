import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/logger.js";
import { agreeingVerifier, createFakeLlm, forbiddenLlm, scriptedLlm } from "../../src/llm/fake.js";
import { createAnthropicLlm, createLlmClient, unconfiguredLlm } from "../../src/llm/index.js";
import type { LlmRequest } from "../../src/llm/types.js";
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
    expect(Date.now() - started).toBeLessThan(700);
    expect(attempts).toBeLessThanOrEqual(2);
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
