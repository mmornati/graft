/**
 * Deterministic LLM doubles. Shipped in `src/` so the step 4 eval harness can use them too.
 * They make no network calls.
 */
import {
  type LlmClient,
  type LlmFailure,
  type LlmPurpose,
  type LlmRequest,
  type LlmResult,
  type LlmUsage,
  ZERO_USAGE,
} from "./types.js";

export type FakeReply =
  | { json: unknown; usage?: Partial<LlmUsage>; model?: string }
  | { failure: LlmFailure };

export type FakeHandler = (req: LlmRequest, i: number) => FakeReply | Promise<FakeReply>;

export const DEFAULT_FAKE_USAGE: LlmUsage = Object.freeze({
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function createFakeLlm(handler: FakeHandler): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete(req: LlmRequest): Promise<LlmResult> {
      const i = calls.length;
      calls.push(req);
      const reply = await handler(req, i);
      if ("failure" in reply) {
        return {
          ok: false,
          failure: reply.failure,
          usage: ZERO_USAGE,
          model: req.model,
          durationMs: 0,
        };
      }
      return {
        ok: true,
        value: reply.json,
        usage: { ...DEFAULT_FAKE_USAGE, ...reply.usage },
        model: reply.model ?? req.model,
        durationMs: 0,
      };
    },
  };
}

/** Fails the test (throws) if it is ever called. */
export function forbiddenLlm(): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    async complete(req: LlmRequest): Promise<LlmResult> {
      calls.push(req);
      throw new Error(`the LLM must not be called (purpose: ${req.purpose})`);
    },
  };
}

type Scripted = FakeReply | FakeHandler;

/** Routes by `req.purpose`; a purpose without an entry is a test bug and throws. */
export function scriptedLlm(script: {
  writer?: Scripted;
  writerEscalated?: Scripted;
  verifier?: Scripted;
}): LlmClient & { calls: LlmRequest[] } {
  const key: Record<LlmPurpose, keyof typeof script> = {
    writer: "writer",
    writer_escalated: "writerEscalated",
    verifier: "verifier",
  };
  return createFakeLlm((req, i) => {
    const entry = script[key[req.purpose]];
    if (entry === undefined) throw new Error(`scriptedLlm: no script for ${req.purpose}`);
    return typeof entry === "function" ? entry(req, i) : entry;
  });
}

/** Reads the claim ids from the card block of a verifier request and supports all of them. */
export function agreeingVerifier(req: LlmRequest): FakeReply {
  const m = /<untrusted_data_[0-9a-f]+ kind="intent_card">\n([\s\S]*?)\n<\/untrusted_data_/.exec(
    req.user,
  );
  const card = JSON.parse(m?.[1] ?? '{"claims":[]}') as { claims: { id: string }[] };
  return {
    json: {
      claims: card.claims.map((c) => ({
        id: c.id,
        verdict: "supported",
        reason: "Shown in the diff.",
      })),
      missing_behavior_changes: [],
      unexplained_files: [],
      risk_class: "trivial",
      risk_reason: "The diff cannot change runtime behavior.",
      instructions_in_data: false,
    },
  };
}
