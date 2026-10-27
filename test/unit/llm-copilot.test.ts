import { existsSync } from "node:fs";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/logger.js";
import { createGitHubClientFactory } from "../../src/github/client-factory.js";
import { type CopilotSdk, createCopilotLlm } from "../../src/llm/copilot.js";
import { agreeingVerifier, createFakeLlm, scriptedLlm } from "../../src/llm/fake.js";
import { createRegistryLlm, createRouterLlm } from "../../src/llm/index.js";
import {
  type CopilotProvider,
  DEFAULT_CAPABILITIES,
  type LlmProvider,
  parseRegistry,
} from "../../src/llm/registry.js";
import { FULL_CAPABILITIES, type LlmRequest } from "../../src/llm/types.js";
import { generateCard } from "../../src/modules/intent/index.js";
import { TEST_PRIVATE_KEY, testConfig } from "../helpers/config.js";
import { genOptions, inputs } from "../helpers/intent-inputs.js";
import { silentLog } from "../helpers/stubs.js";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } };
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  purpose: "writer",
  model: "claude-sonnet-4.5",
  system: "SYSTEM_CANARY_PROMPT",
  user: "USER_CANARY_DIFF",
  outputSchema: SCHEMA,
  maxOutputTokens: 8192,
  effort: "low",
  timeoutMs: 5000,
  installationId: 7,
  ...over,
});

const REGISTRY = `
providers:
  - id: claude
    kind: anthropic
  - id: copilot
    kind: copilot
    installations: [7]
    fallbackModels:
      claude-sonnet-4.5: claude/claude-sonnet-5-5
      gpt-5-mini: claude/claude-haiku-5-5
roles:
  fast: copilot/gpt-5-mini
  strong: copilot/claude-sonnet-4.5
`;

const problems = (doc: string) =>
  parseRegistry("SRC", doc, {}, { credential: { apiKey: "k" }, baseUrl: undefined }).problems.join(
    "\n",
  );

describe("copilot provider: registry", () => {
  it("U-COP-1 a copilot entry: its installations, its fallbacks, allowed on a hosted deployment", () => {
    const cfg = testConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
      GRAFT_DEPLOYMENT: "hosted",
      GRAFT_LLM_PROVIDERS: REGISTRY,
    });
    const p = cfg.llmRegistry?.providers[1] as CopilotProvider;
    expect(p.kind).toBe("copilot");
    expect([...p.installations]).toEqual([7]);
    expect(p.fallbackModels["claude-sonnet-4.5"]).toBe("claude/claude-sonnet-5-5");
    expect(p.capabilities).toEqual(DEFAULT_CAPABILITIES.copilot);
    expect(cfg.llmModelStrong).toBe("copilot/claude-sonnet-4.5");
  });

  it("U-COP-2 every role on copilot needs a fallback on a provider that is not copilot", () => {
    const base = (
      fallbacks: string,
      roles = "roles: {fast: copilot/gpt-5-mini, strong: claude/claude-sonnet-5-5}",
    ) =>
      `providers:\n  - {id: claude, kind: anthropic}\n  - {id: copilot, kind: copilot, installations: [7], fallbackModels: {${fallbacks}}}\n  - {id: other, kind: copilot, installations: [8], fallbackModels: {}}\n${roles}`;
    expect(problems(base(""))).toContain(
      "roles.fast: has no fallbackModels entry on provider copilot",
    );
    expect(problems(base("gpt-5-mini: other/gpt-5-mini"))).toContain(
      "must not be another copilot provider",
    );
    expect(problems(base("gpt-5-mini: nowhere/x"))).toContain("names no configured provider");
    expect(problems(base("gpt-5-mini: claude/gpt-5"))).toContain(
      "must be a Claude model ID for a anthropic provider",
    );
    expect(problems(base("gpt-5-mini: claude/claude-haiku-5-5"))).toBe("");
    expect(
      problems(
        `providers:\n  - {id: c, kind: copilot, installations: [7], fallbackModels: {}, passEnv: [GITHUB_TOKEN]}\nroles: {fast: c/m, strong: c/m}`,
      ),
    ).toContain("never passes to the Copilot runtime");
    expect(
      problems(
        `providers:\n  - {id: c, kind: copilot, installations: [], fallbackModels: {}}\nroles: {fast: c/m, strong: c/m}`,
      ),
    ).toContain("providers[0].installations");
  });
});

describe("copilot provider: routing", () => {
  function routed() {
    const reg = testConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
      GRAFT_LLM_PROVIDERS: REGISTRY,
    }).llmRegistry;
    const [claudeP, copilotP] = (reg?.providers ?? []) as LlmProvider[];
    const claude = createFakeLlm(() => ({ json: { ok: "claude" } }));
    const copilot = Object.assign(
      createFakeLlm(() => ({ json: { ok: "copilot" } })),
      {
        capabilities: () => ({ ...FULL_CAPABILITIES, promptCache: false }),
      },
    );
    const fallbackCaps = { ...FULL_CAPABILITIES, nativeSchema: false };
    const llm = createRouterLlm([
      {
        provider: claudeP as LlmProvider,
        client: Object.assign(claude, { capabilities: () => fallbackCaps }),
      },
      { provider: copilotP as LlmProvider, client: copilot },
    ]);
    return { llm, claude, copilot, fallbackCaps };
  }

  it("U-COP-3 an opted-in installation reaches Copilot; any other, or none, gets the fallback model", async () => {
    const { llm, claude, copilot, fallbackCaps } = routed();
    expect(
      await llm.complete(req({ model: "copilot/claude-sonnet-4.5", installationId: 7 })),
    ).toMatchObject({
      ok: true,
      model: "copilot/claude-sonnet-4.5",
    });
    expect(copilot.calls[0]?.model).toBe("claude-sonnet-4.5");

    expect(
      await llm.complete(req({ model: "copilot/claude-sonnet-4.5", installationId: 8 })),
    ).toMatchObject({
      ok: true,
      model: "claude/claude-sonnet-5-5",
    });
    const { installationId: _, ...noInstallation } = req();
    expect(await llm.complete({ ...noInstallation, model: "copilot/gpt-5-mini" })).toMatchObject({
      model: "claude/claude-haiku-5-5",
    });
    expect(claude.calls.map((c) => c.model)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(copilot.calls).toHaveLength(1);
    // Capabilities and the server-side fallback follow the provider that will answer.
    expect(llm.capabilities?.("copilot/claude-sonnet-4.5", 8)).toEqual(fallbackCaps);
    expect(llm.capabilities?.("copilot/claude-sonnet-4.5", 7)?.nativeSchema).toBe(true);
  });

  it("U-COP-4 generateCard passes the installation to every call and to the capability check", async () => {
    const llm = Object.assign(
      scriptedLlm({
        writer: {
          json: {
            goal: "Retry failed deliveries.",
            behavior_changes: ["Deliveries are retried."],
            risk_class: "trivial",
            risk_reason: "Small change.",
            out_of_scope_edits: [],
            instructions_in_data: false,
          },
        },
        verifier: agreeingVerifier,
      }),
      {
        seen: [] as (number | undefined)[],
      },
    );
    llm.capabilities = (_m: string, installationId?: number) => {
      llm.seen.push(installationId);
      return FULL_CAPABILITIES;
    };
    await generateCard(inputs(), llm, genOptions({ installationId: 42 }));
    expect(llm.calls.map((c) => c.installationId)).toEqual([42, 42]);
    expect(llm.seen).toEqual([42, 42]);
    // Without one, requests carry no installationId key at all (unchanged for existing tests).
    const plain = scriptedLlm({ writer: { failure: "unavailable" } });
    await generateCard(inputs(), plain, genOptions());
    expect(plain.calls[0]).not.toHaveProperty("installationId");
  });
});

interface FakeSession {
  config: Record<string, unknown>;
  sent: { prompt: string; responseSchema?: unknown; timeout?: number }[];
  disconnected: boolean;
}

function fakeSdk(behavior: {
  reply?: () => Promise<{ data?: { content?: string } } | undefined>;
  events?: { type: string; data?: Record<string, unknown> }[];
  startFails?: boolean;
}) {
  const sessions: FakeSession[] = [];
  const clients: Record<string, unknown>[] = [];
  const sdk: CopilotSdk = {
    CopilotClient: class {
      constructor(options: Record<string, unknown>) {
        clients.push(options);
      }
      async start() {
        if (behavior.startFails) throw new Error("runtime failed to start");
      }
      async stop() {}
      async createSession(config: Record<string, unknown>) {
        const s: FakeSession = { config, sent: [], disconnected: false };
        sessions.push(s);
        let handler: ((e: { type: string; data?: Record<string, unknown> }) => void) | null = null;
        return {
          on(h: (e: { type: string; data?: Record<string, unknown> }) => void) {
            handler = h;
            return () => {};
          },
          async sendAndWait(o: { prompt: string; responseSchema?: unknown }, timeout?: number) {
            s.sent.push({ ...o, ...(timeout !== undefined ? { timeout } : {}) });
            for (const e of behavior.events ?? []) handler?.(e);
            return behavior.reply ? behavior.reply() : { data: { content: '{"ok":true}' } };
          },
          async disconnect() {
            s.disconnected = true;
          },
        };
      }
    } as unknown as CopilotSdk["CopilotClient"],
  };
  return { sdk, sessions, clients };
}

const tokenFor = async () => ({
  token: "ghs_TOKEN_CANARY",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});

function copilotLlm(
  sdk: CopilotSdk | null,
  over: Partial<Parameters<typeof createCopilotLlm>[0]> = {},
) {
  return createCopilotLlm({
    capabilities: DEFAULT_CAPABILITIES.copilot,
    tokenFor,
    passEnv: [],
    log: silentLog,
    loadSdk: sdk ? async () => sdk : async () => Promise.reject(new Error("Cannot find package")),
    environment: {
      PATH: "/usr/bin",
      HOME: "/home/graft",
      GITHUB_APP_PRIVATE_KEY: "GH_KEY_CANARY",
      DATABASE_URL: "postgres://DB_CANARY",
    },
    ...over,
  });
}

describe("copilot provider: client", () => {
  it("U-COP-5 every session is empty: no tools, no MCP, no discovery, a replaced system message, every permission rejected", async () => {
    const f = fakeSdk({
      events: [
        {
          type: "assistant.usage",
          data: {
            model: "claude-sonnet-4.5",
            inputTokens: 900,
            outputTokens: 40,
            cacheReadTokens: 100,
          },
        },
        {
          type: "assistant.usage",
          data: { model: "claude-sonnet-4.5", inputTokens: 100, outputTokens: 10 },
        },
      ],
    });
    const llm = copilotLlm(f.sdk);
    const r = await llm.complete(req());
    expect(r).toMatchObject({
      ok: true,
      value: { ok: true },
      model: "claude-sonnet-4.5",
      usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 0 },
    });
    expect(f.clients).toHaveLength(1);
    const client = f.clients[0] as Record<string, unknown>;
    expect(client).toMatchObject({ mode: "empty", useLoggedInUser: false, logLevel: "none" });
    expect(client.env).toEqual({ PATH: "/usr/bin", HOME: "/home/graft" });
    const s = f.sessions[0] as FakeSession;
    expect(s.config).toMatchObject({
      model: "claude-sonnet-4.5",
      systemMessage: { mode: "replace", content: "SYSTEM_CANARY_PROMPT" },
      availableTools: [],
      mcpServers: {},
      enableConfigDiscovery: false,
      enableSkills: false,
      enableSessionStore: false,
      infiniteSessions: { enabled: false },
      reasoningEffort: "low",
    });
    const onPermission = s.config.onPermissionRequest as () => unknown;
    expect(onPermission()).toEqual({ kind: "reject" });
    const tokenProvider = s.config.gitHubTokenProvider as () => {
      kind: string;
      accessToken: string;
      expiresIn: number;
    };
    expect(tokenProvider()).toMatchObject({ kind: "token", accessToken: "ghs_TOKEN_CANARY" });
    expect(tokenProvider().expiresIn).toBeGreaterThan(3000);
    expect(s.sent[0]?.prompt).toBe("USER_CANARY_DIFF");
    expect(s.sent[0]?.responseSchema).toEqual(SCHEMA);
    expect(s.disconnected).toBe(true);
    expect(existsSync(String(s.config.workingDirectory))).toBe(false);

    // One runtime per process.
    await llm.complete(req());
    expect(f.clients).toHaveLength(1);
    expect(f.sessions).toHaveLength(2);
  });

  it("U-COP-6 failures: no SDK, no installation, a token or call error, a tool that ran, a timeout, bad JSON", async () => {
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
    expect(await copilotLlm(null, { log }).complete(req())).toMatchObject({
      ok: false,
      failure: "not_configured",
    });
    expect(out).toContain("the SDK is not installed");
    const { installationId: _, ...none } = req();
    expect(await copilotLlm(fakeSdk({}).sdk).complete(none)).toMatchObject({
      failure: "not_configured",
    });
    expect(
      await copilotLlm(fakeSdk({}).sdk, {
        tokenFor: () =>
          Promise.reject(Object.assign(new Error("Bad credentials"), { status: 401 })),
      }).complete(req()),
    ).toMatchObject({ failure: "auth" });
    expect(
      await copilotLlm(
        fakeSdk({ reply: () => Promise.reject(Object.assign(new Error("x"), { statusCode: 429 })) })
          .sdk,
      ).complete(req()),
    ).toMatchObject({ failure: "rate_limited" });
    expect(
      await copilotLlm(
        fakeSdk({ events: [{ type: "tool.execution_start", data: { toolName: "bash" } }] }).sdk,
      ).complete(req()),
    ).toMatchObject({ failure: "bad_request" });
    expect(
      await copilotLlm(fakeSdk({ reply: () => new Promise(() => {}) }).sdk).complete(
        req({ timeoutMs: 50, deadlineMs: 50 }),
      ),
    ).toMatchObject({ failure: "timeout" });
    expect(
      await copilotLlm(
        fakeSdk({ reply: async () => ({ data: { content: "Sure!" } }) }).sdk,
      ).complete(req()),
    ).toMatchObject({ failure: "invalid_json" });
    const failing = fakeSdk({ startFails: true });
    expect(await copilotLlm(failing.sdk).complete(req())).toMatchObject({
      ok: false,
      failure: "unavailable",
    });
    for (const canary of ["SYSTEM_CANARY_PROMPT", "USER_CANARY_DIFF", "ghs_TOKEN_CANARY"]) {
      expect(out, canary).not.toContain(canary);
    }
  });

  it("U-COP-7 the registry client builds the copilot provider with the installation token source", async () => {
    const minted: number[] = [];
    const llm = createRegistryLlm(
      testConfig({ ANTHROPIC_API_KEY: "sk-ant-x", GRAFT_LLM_PROVIDERS: REGISTRY })
        .llmRegistry as never,
      { llmMaxRetries: 0, llmRefusalFallback: false },
      silentLog,
      {
        copilotToken: async (id) => {
          minted.push(id);
          return tokenFor();
        },
      },
    );
    expect(llm.capabilities?.("copilot/gpt-5-mini", 7)).toEqual(DEFAULT_CAPABILITIES.copilot);
    expect(minted).toEqual([]); // nothing is minted before a call
  });
});

describe("copilot installation tokens", () => {
  it("U-COP-8 copilotToken mints a token limited to copilot_requests: write through the guarded App client", async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    const factory = createGitHubClientFactory({
      appId: 1,
      privateKey: TEST_PRIVATE_KEY,
      baseUrl: "https://api.github.test",
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(
          JSON.stringify({ token: "ghs_minted", expires_at: "2026-10-27T12:00:00Z" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    });
    expect(await factory.copilotToken?.(77)).toEqual({
      token: "ghs_minted",
      expiresAt: "2026-10-27T12:00:00Z",
    });
    expect(seen).toEqual([
      {
        url: "https://api.github.test/app/installations/77/access_tokens",
        method: "POST",
        body: { permissions: { copilot_requests: "write" } },
      },
    ]);
  });
});
