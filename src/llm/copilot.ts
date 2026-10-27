/**
 * GitHub Copilot through `@github/copilot-sdk`, billed to the installation that owns the pull
 * request: each call runs with an installation token that has `copilot_requests: write`.
 *
 * Written against @github/copilot-sdk 1.0.19 and not yet run against a live installation. The SDK
 * is not one of Graft's dependencies (its native runtime is large): an operator who configures a
 * `copilot` provider installs it in the image, and until then every call fails `not_configured`.
 *
 * The runtime is an agent with tools, and Graft feeds it untrusted PR text, so every session is
 * empty by construction:
 * - the client runs in `"empty"` (multi-user server) mode with no logged-in user, and the runtime
 *   gets the same stripped environment as the CLI providers;
 * - `availableTools: []` enables no tool, `mcpServers: {}` no server, config discovery, skills,
 *   the session store and infinite sessions are off;
 * - the system message is replaced, not appended to;
 * - every permission request is rejected;
 * - each session runs in a fresh empty directory, and the call fails if a tool ran anyway.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "../core/logger.js";
import { cliEnvironment, failureForMessage, failureForStatus } from "./cli.js";
import { parseJsonAnswer } from "./openai-compatible.js";
import {
  type LlmCapabilities,
  type LlmClient,
  type LlmFailure,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  ZERO_USAGE,
} from "./types.js";

/** The slice of `@github/copilot-sdk` 1.0.x that Graft uses. */
export interface CopilotSdk {
  CopilotClient: new (options: Record<string, unknown>) => CopilotClientLike;
}
interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  createSession(config: Record<string, unknown>): Promise<CopilotSessionLike>;
}
interface CopilotSessionLike {
  sendAndWait(
    options: { prompt: string; responseSchema?: unknown },
    timeout?: number,
  ): Promise<{ data?: { content?: string } } | undefined>;
  on(handler: (event: { type: string; data?: Record<string, unknown> }) => void): () => void;
  disconnect(): Promise<void>;
}

/** A token for one installation, with `copilot_requests: write`. Never logged. */
export type CopilotTokenSource = (
  installationId: number,
) => Promise<{ token: string; expiresAt: string }>;

export interface CopilotLlmOptions {
  capabilities: LlmCapabilities;
  tokenFor: CopilotTokenSource;
  passEnv: readonly string[];
  log: Logger;
  /** Defaults to importing `@github/copilot-sdk`; tests inject a fake. */
  loadSdk?: () => Promise<CopilotSdk>;
  /** Tests only. */
  environment?: NodeJS.ProcessEnv;
}

const SDK = "@github/copilot-sdk";

async function importSdk(): Promise<CopilotSdk> {
  // A variable specifier: the package is optional and not in Graft's dependencies.
  const name: string = SDK;
  return (await import(name)) as CopilotSdk;
}

function classify(err: unknown): LlmFailure {
  const e = err as { status?: unknown; statusCode?: unknown; name?: unknown; message?: unknown };
  const status = typeof e?.statusCode === "number" ? e.statusCode : e?.status;
  if (typeof status === "number") return failureForStatus(status);
  const message = typeof e?.message === "string" ? e.message : "";
  if (e?.name === "TimeoutError" || /timed? ?out/i.test(message)) return "timeout";
  return failureForMessage(message);
}

export function createCopilotLlm(o: CopilotLlmOptions): LlmClient {
  const caps = o.capabilities;
  let started: Promise<CopilotClientLike | null> | null = null;

  /** One runtime per process, started on the first call; null when the SDK is not installed. */
  const client = (): Promise<CopilotClientLike | null> => {
    started ??= (async () => {
      let sdk: CopilotSdk;
      try {
        sdk = await (o.loadSdk ?? importSdk)();
      } catch {
        o.log.error({ package: SDK }, "copilot provider: the SDK is not installed");
        return null;
      }
      // The runtime's own state (no sessions are stored: the session store is off).
      const baseDirectory = await mkdtemp(path.join(tmpdir(), "graft-copilot-"));
      const c = new sdk.CopilotClient({
        mode: "empty",
        useLoggedInUser: false,
        logLevel: "none",
        baseDirectory,
        env: cliEnvironment(o.environment ?? process.env, o.passEnv),
      });
      await c.start();
      return c;
    })().catch((err: unknown) => {
      started = null; // a failed start is retried on the next call
      throw err;
    });
    return started;
  };

  return {
    capabilities: () => caps,
    async complete(req: LlmRequest): Promise<LlmResult> {
      const started_ = Date.now();
      const usage: LlmUsage = { ...ZERO_USAGE };
      let model = req.model;
      const finish = (r: { ok: true; value: unknown } | { ok: false; failure: LlmFailure }) => {
        const durationMs = Date.now() - started_;
        const u = caps.reportsUsage ? usage : ZERO_USAGE;
        // Metadata only: never the prompts, the output, the token or the SDK error.
        o.log.info(
          {
            purpose: req.purpose,
            model,
            ok: r.ok,
            ...(r.ok ? {} : { failure: r.failure }),
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadTokens,
            cacheWriteTokens: u.cacheWriteTokens,
            durationMs,
          },
          "llm call",
        );
        return r.ok
          ? ({ ok: true, value: r.value, usage: u, model, durationMs } as const)
          : ({ ok: false, failure: r.failure, usage: u, model, durationMs } as const);
      };

      const prefix = req.userCachePrefix;
      if (prefix !== undefined && (prefix === "" || !req.user.startsWith(prefix))) {
        throw new Error("userCachePrefix must be a non-empty prefix of user");
      }
      // The router only sends opted-in installations here.
      if (req.installationId === undefined) return finish({ ok: false, failure: "not_configured" });

      let runtime: CopilotClientLike | null;
      let token: { token: string; expiresAt: string };
      try {
        runtime = await client();
        if (!runtime) return finish({ ok: false, failure: "not_configured" });
        token = await o.tokenFor(req.installationId);
      } catch (err) {
        o.log.warn({ purpose: req.purpose, model: req.model, stage: "start" }, "llm call failed");
        return finish({ ok: false, failure: classify(err) });
      }

      const deadline = Math.max(
        1,
        Math.floor(Math.min(req.timeoutMs, req.deadlineMs ?? req.timeoutMs)),
      );
      const cwd = await mkdtemp(path.join(tmpdir(), "graft-copilot-call-"));
      let session: CopilotSessionLike | null = null;
      let toolRan = false;
      try {
        const expiresIn = Math.max(
          60,
          Math.floor((Date.parse(token.expiresAt) - Date.now()) / 1000),
        );
        session = await runtime.createSession({
          model: req.model,
          systemMessage: { mode: "replace", content: req.system },
          availableTools: [],
          mcpServers: {},
          enableConfigDiscovery: false,
          enableSkills: false,
          enableSessionStore: false,
          infiniteSessions: { enabled: false },
          workingDirectory: cwd,
          onPermissionRequest: () => ({ kind: "reject" }),
          gitHubTokenProvider: () => ({ kind: "token", accessToken: token.token, expiresIn }),
          ...(caps.effort ? { reasoningEffort: req.effort } : {}),
        });
        session.on((e) => {
          if (e.type === "assistant.usage") {
            const d = e.data ?? {};
            const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : 0);
            usage.inputTokens += n("inputTokens");
            usage.outputTokens += n("outputTokens");
            usage.cacheReadTokens += n("cacheReadTokens");
            usage.cacheWriteTokens += n("cacheWriteTokens");
            if (typeof d.model === "string") model = d.model;
          }
          if (e.type.startsWith("tool.execution")) toolRan = true;
        });
        let timer: NodeJS.Timeout | undefined;
        const reply = await Promise.race([
          session.sendAndWait(
            {
              prompt: req.user,
              ...(caps.nativeSchema ? { responseSchema: req.outputSchema } : {}),
            },
            deadline,
          ),
          new Promise<never>((_r, reject) => {
            timer = setTimeout(
              () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
              deadline,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        // Every tool is off: a tool that ran means the isolation failed, so nothing it produced is used.
        if (toolRan) return finish({ ok: false, failure: "bad_request" });
        const parsed = parseJsonAnswer(reply?.data?.content ?? "");
        return parsed.ok
          ? finish({ ok: true, value: parsed.value })
          : finish({ ok: false, failure: "invalid_json" });
      } catch (err) {
        o.log.warn({ purpose: req.purpose, model: req.model, stage: "call" }, "llm call failed");
        return finish({ ok: false, failure: toolRan ? "bad_request" : classify(err) });
      } finally {
        await session?.disconnect().catch(() => {});
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
