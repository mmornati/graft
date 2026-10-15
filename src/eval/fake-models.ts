/** Case script to `LlmClient` (T12, E18). Fake mode never reaches the network. */
import { agreeingVerifier, type FakeReply, scriptedLlm } from "../llm/fake.js";
import type { LlmClient } from "../llm/types.js";
import type { EvalCase, FakeEntry, FakeScript } from "./case-schema.js";

const toReply = (e: FakeEntry): FakeReply =>
  "failure" in e && e.failure !== undefined
    ? { failure: e.failure }
    : { json: (e as { json: unknown }).json };

/** Writer says `trivial` with no out-of-scope edits; the verifier agrees with everything. */
export const NULL_WRITER_REPLY: FakeReply = {
  json: {
    goal: "Changes the pull request as described.",
    behavior_changes: ["No observable behavior change."],
    risk_class: "trivial",
    risk_reason: "The null model always answers trivial.",
    out_of_scope_edits: [],
    instructions_in_data: false,
  },
};

export function nullModel(): LlmClient {
  return scriptedLlm({
    writer: NULL_WRITER_REPLY,
    writerEscalated: NULL_WRITER_REPLY,
    verifier: agreeingVerifier,
  });
}

export function llmFromScript(script: FakeScript): LlmClient {
  return scriptedLlm({
    ...(script.writer ? { writer: toReply(script.writer) } : {}),
    ...(script.writerEscalated ? { writerEscalated: toReply(script.writerEscalated) } : {}),
    ...(script.verifier !== undefined
      ? { verifier: script.verifier === "agree" ? agreeingVerifier : toReply(script.verifier) }
      : {}),
  });
}

/** The case's scripted replies, or the null model when it has none. */
export function llmForCase(c: Pick<EvalCase, "fakeLlm">): LlmClient {
  return c.fakeLlm ? llmFromScript(c.fakeLlm) : nullModel();
}
