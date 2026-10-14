/**
 * Card generation (T12): pure apart from the calls made through `llm`. This is the hook the
 * step 4 eval harness runs offline. Never throws for model failures; never logs prompts, diffs
 * or model output.
 */
import { createHash } from "node:crypto";
import type { Config } from "../../config/index.js";
import type { Logger } from "../../core/logger.js";
import type { RiskClass } from "../../db/schema.js";
import {
  type LlmClient,
  type LlmEffort,
  type LlmFailure,
  type LlmPurpose,
  type LlmUsage,
  ZERO_USAGE,
} from "../../llm/types.js";
import { chooseNonce, LIMITS, neutralizeUntrusted, type OmitReason, prepareDiff } from "./diff.js";
import type { CardInputs } from "./inputs.js";
import {
  parseVerifierOutput,
  parseWriterOutput,
  type VerifierOutput,
  type WriterOutput,
} from "./output.js";
import {
  buildVerifierData,
  buildVerifierUser,
  buildWriterUser,
  cardClaims,
  type MessageFacts,
  PROMPT_VERSION,
  VERIFIER_OUTPUT_SCHEMA,
  VERIFIER_SYSTEM_PROMPT,
  WRITER_OUTPUT_SCHEMA,
  WRITER_SYSTEM_PROMPT,
} from "./prompts.js";
import {
  combineRisk,
  computeRiskFloor,
  type FloorConfig,
  type FloorReason,
  type RaiseReason,
} from "./risk-floor.js";

export type FailureReason =
  | "not_configured"
  | "budget_exceeded"
  | "too_large"
  | "llm_timeout"
  | "llm_rate_limited"
  | "llm_unavailable"
  | "llm_auth"
  | "llm_bad_request"
  | "llm_refusal"
  | "invalid_output"
  | "deadline_exceeded";

export interface GenerateOptions {
  models: { fast: string; strong: string };
  floor: FloorConfig;
  /** Per call. */
  timeoutMs: number;
  /** Whole run; default 600_000. */
  deadlineMs: number;
  /** Injectable clock for the deadline. */
  nowMs: () => number;
  /** When the deadline starts counting (the job start); default: when `runCard` starts. */
  startedAtMs?: number;
  /** Metadata only. */
  log?: Logger;
}

export interface VerifierClaim {
  id: string;
  kind: "goal" | "behavior_change" | "out_of_scope";
  verdict: "supported" | "unsupported" | "contradicted";
  reason: string;
}

export interface InputStats {
  filesTotal: number;
  filesListed: number;
  filesFull: number;
  filesPartial: number;
  filesOmitted: number;
  /** At most 50. */
  omitted: { path: string; reason: OmitReason }[];
  linesAdded: number;
  linesDeleted: number;
  truncated: boolean;
  linkedIssueNumber: number | null;
}

export interface CardResult {
  promptVersion: string;
  inputHash: string;
  status: "ok" | "unavailable";
  failureReason: FailureReason | null;
  retryable: boolean;
  card: {
    goal: string;
    behaviorChanges: string[];
    outOfScopeEdits: { path: string; reason: string }[];
  } | null;
  risk: {
    final: RiskClass;
    floor: RiskClass;
    floorReasons: FloorReason[];
    writer: RiskClass | null;
    writerReason: string | null;
    firstPass: RiskClass | null;
    verifier: RiskClass | null;
    raisedBy: RaiseReason[];
  };
  verifier: {
    status: "agree" | "disagree" | "error" | "skipped";
    claims: VerifierClaim[];
    missing: string[];
    unexplained: string[];
    failure: FailureReason | null;
  };
  instructionsInData: boolean;
  models: { writer: string | null; firstPass: string | null; verifier: string | null };
  usage: LlmUsage & { calls: number };
  inputs: InputStats;
}

export interface PreparedCard {
  inputHash: string;
  floor: RiskClass;
  estimatedTokens: number;
  stats: InputStats;
  // Internals: opaque to callers.
  readonly floorReasons: FloorReason[];
  readonly nonce: string;
  readonly writerUser: string;
  readonly verifierData: string;
  readonly fileList: ReadonlySet<string>;
  readonly tooLarge: boolean;
}

export const EFFORTS = { fast: "low", strong: "medium", verifier: "medium" } as const;
export const MAX_OUTPUT_TOKENS = 8192;
const MIN_REMAINING_MS = 10_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function defaultGenerateOptions(config: Config, floor: FloorConfig): GenerateOptions {
  return {
    models: { fast: config.llmModelFast, strong: config.llmModelStrong },
    floor,
    timeoutMs: config.llmTimeoutMs,
    deadlineMs: 600_000,
    nowMs: () => Date.now(),
  };
}

/** Pure, no I/O. */
export function prepareCardInputs(inputs: CardInputs, o: GenerateOptions): PreparedCard {
  const title = neutralizeUntrusted(inputs.pr.title, LIMITS.titleChars);
  const body = neutralizeUntrusted(inputs.pr.body, LIMITS.bodyChars);
  const issue = inputs.issue
    ? {
        number: inputs.issue.number,
        title: neutralizeUntrusted(inputs.issue.title, LIMITS.issueTitleChars),
        body: neutralizeUntrusted(inputs.issue.body, LIMITS.issueBodyChars),
      }
    : null;
  const diff = prepareDiff(inputs.tooLarge ? [] : inputs.files, o.floor);
  const diffTemplate = diff.renderDiff("{nonce}");

  const { floor, reasons } = computeRiskFloor(
    {
      files: inputs.tooLarge ? [] : inputs.files,
      pr: inputs.pr,
      listingTruncated: inputs.listingTruncated,
      tooLarge: inputs.tooLarge,
      partialPaths: diff.partialPaths,
      untrustedTexts: [
        title,
        body,
        ...(issue ? [issue.title, issue.body] : []),
        ...diff.addedLines,
      ],
    },
    o.floor,
  );

  const canonical = JSON.stringify([
    PROMPT_VERSION,
    o.models.fast,
    o.models.strong,
    EFFORTS,
    { ...LIMITS, maxOutputTokens: MAX_OUTPUT_TOKENS },
    [...o.floor.extraSensitiveGlobs].sort(),
    title,
    body,
    issue,
    diff.fileListBlock,
    diffTemplate,
    inputs.tooLarge,
    inputs.listingTruncated,
  ]);
  const inputHash = sha256(canonical);
  const nonce = chooseNonce(canonical, [
    title,
    body,
    ...(issue ? [issue.title, issue.body] : []),
    diff.fileListBlock,
    diffTemplate,
  ]);

  const stats: InputStats = {
    filesTotal: inputs.pr.changedFiles,
    filesListed: inputs.files.length,
    filesFull: diff.stats.filesFull,
    filesPartial: diff.stats.filesPartial,
    filesOmitted: diff.stats.filesOmitted,
    omitted: diff.stats.omitted,
    linesAdded: inputs.pr.additions,
    linesDeleted: inputs.pr.deletions,
    truncated: inputs.tooLarge || inputs.listingTruncated || diff.partialPaths.length > 0,
    linkedIssueNumber: inputs.issue?.number ?? null,
  };
  const facts: MessageFacts = {
    nonce,
    repositoryFullName: inputs.repositoryFullName,
    prNumber: inputs.pr.number,
    filesTotal: stats.filesTotal,
    filesListed: stats.filesListed,
    listingTruncated: inputs.listingTruncated,
    linesAdded: stats.linesAdded,
    linesDeleted: stats.linesDeleted,
    filesFull: stats.filesFull,
    filesPartial: stats.filesPartial,
    filesOmitted: stats.filesOmitted,
    fileListBlock: diff.fileListBlock,
    diffBlock: diff.renderDiff(nonce),
  };
  const writerUser = buildWriterUser({ ...facts, title, body, issue });
  const verifierData = buildVerifierData(facts);
  const trivial = floor === "trivial";
  const estimatedTokens =
    Math.ceil(writerUser.length / 3) * (trivial ? 2 : 1) +
    Math.ceil(verifierData.length / 3) +
    MAX_OUTPUT_TOKENS * (trivial ? 3 : 2);

  return {
    inputHash,
    floor,
    estimatedTokens,
    stats,
    floorReasons: reasons,
    nonce,
    writerUser,
    verifierData,
    fileList: new Set(inputs.files.map((f) => f.path)),
    tooLarge: inputs.tooLarge,
  };
}

export const RETRYABLE: ReadonlySet<FailureReason> = new Set([
  "llm_timeout",
  "llm_rate_limited",
  "llm_unavailable",
  "invalid_output",
  "deadline_exceeded",
]);

interface Spent {
  usage: LlmUsage;
  calls: number;
}

function buildUnavailable(
  p: PreparedCard,
  reason: FailureReason,
  spent: Spent,
  extra: {
    firstPass?: RiskClass | null;
    firstPassModel?: string | null;
    instructions?: boolean;
  } = {},
): CardResult {
  const { final, raisedBy } = combineRisk({
    floor: p.floor,
    writer: null,
    firstPass: extra.firstPass ?? null,
    verifier: null,
    verifierStatus: "skipped",
    instructionsInData: extra.instructions ?? false,
    unavailable: true,
  });
  return {
    promptVersion: PROMPT_VERSION,
    inputHash: p.inputHash,
    status: "unavailable",
    failureReason: reason,
    retryable: RETRYABLE.has(reason),
    card: null,
    risk: {
      final,
      floor: p.floor,
      floorReasons: p.floorReasons,
      writer: null,
      writerReason: null,
      firstPass: extra.firstPass ?? null,
      verifier: null,
      raisedBy,
    },
    verifier: { status: "skipped", claims: [], missing: [], unexplained: [], failure: null },
    instructionsInData: extra.instructions ?? false,
    models: { writer: null, firstPass: extra.firstPassModel ?? null, verifier: null },
    usage: { ...spent.usage, calls: spent.calls },
    inputs: p.stats,
  };
}

/** A card without any model call: budget, too large, not configured. */
export function unavailableResult(p: PreparedCard, reason: FailureReason): CardResult {
  return buildUnavailable(p, reason, { usage: ZERO_USAGE, calls: 0 });
}

const FAILURE_MAP: Record<LlmFailure, FailureReason> = {
  timeout: "llm_timeout",
  rate_limited: "llm_rate_limited",
  unavailable: "llm_unavailable",
  auth: "llm_auth",
  bad_request: "llm_bad_request",
  refusal: "llm_refusal",
  max_tokens: "invalid_output",
  invalid_json: "invalid_output",
  not_configured: "not_configured",
};

export async function runCard(
  p: PreparedCard,
  llm: LlmClient,
  o: GenerateOptions,
): Promise<CardResult> {
  if (p.tooLarge) return unavailableResult(p, "too_large");

  const deadlineAt = (o.startedAtMs ?? o.nowMs()) + o.deadlineMs;
  const spent: Spent = { usage: { ...ZERO_USAGE }, calls: 0 };

  type Called<T> = { ok: true; out: T; model: string } | { ok: false; reason: FailureReason };

  /** One call, repeated once when the output is unusable (D6). Usage of every call is summed. */
  async function callValidated<T>(
    base: {
      purpose: LlmPurpose;
      model: string;
      system: string;
      user: string;
      outputSchema: Record<string, unknown>;
      effort: LlmEffort;
    },
    validate: (value: unknown) => { ok: true; out: T } | { ok: false },
  ): Promise<Called<T>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadlineAt - o.nowMs();
      if (remaining < MIN_REMAINING_MS) return { ok: false, reason: "deadline_exceeded" };
      const res = await llm.complete({
        ...base,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: Math.min(o.timeoutMs, remaining),
        deadlineMs: remaining,
      });
      spent.calls += 1;
      spent.usage = {
        inputTokens: spent.usage.inputTokens + res.usage.inputTokens,
        outputTokens: spent.usage.outputTokens + res.usage.outputTokens,
        cacheReadTokens: spent.usage.cacheReadTokens + res.usage.cacheReadTokens,
        cacheWriteTokens: spent.usage.cacheWriteTokens + res.usage.cacheWriteTokens,
      };
      if (res.ok) {
        const v = validate(res.value);
        if (v.ok) return { ok: true, out: v.out, model: res.model };
        continue;
      }
      if (res.failure === "invalid_json" || res.failure === "max_tokens") {
        continue;
      }
      return { ok: false, reason: FAILURE_MAP[res.failure] };
    }
    return { ok: false, reason: "invalid_output" };
  }

  // 2. First writer.
  const firstIsFast = p.floor === "trivial";
  const first = await callValidated(
    {
      purpose: "writer",
      model: firstIsFast ? o.models.fast : o.models.strong,
      system: WRITER_SYSTEM_PROMPT,
      user: p.writerUser,
      outputSchema: WRITER_OUTPUT_SCHEMA,
      effort: firstIsFast ? EFFORTS.fast : EFFORTS.strong,
    },
    (v) => parseWriterOutput(v, p.fileList),
  );
  if (!first.ok) return finishUnavailable(first.reason);

  let writer: WriterOutput = first.out;
  let writerModel = first.model;
  let firstPass: RiskClass | null = null;
  let firstPassModel: string | null = null;
  let instructions = first.out.instructionsInData;

  // 5. Escalation.
  if (firstIsFast && (first.out.riskClass !== "trivial" || first.out.instructionsInData)) {
    const second = await callValidated(
      {
        purpose: "writer_escalated",
        model: o.models.strong,
        system: WRITER_SYSTEM_PROMPT,
        user: p.writerUser,
        outputSchema: WRITER_OUTPUT_SCHEMA,
        effort: EFFORTS.strong,
      },
      (v) => parseWriterOutput(v, p.fileList),
    );
    if (!second.ok) {
      return finishUnavailable(second.reason, {
        firstPass: first.out.riskClass,
        firstPassModel: first.model,
        instructions,
      });
    }
    firstPass = first.out.riskClass;
    firstPassModel = first.model;
    writer = second.out;
    writerModel = second.model;
    instructions = instructions || second.out.instructionsInData;
  }

  function finishUnavailable(
    reason: FailureReason,
    extra: Parameters<typeof buildUnavailable>[3] = {},
  ): CardResult {
    const r = buildUnavailable(p, reason, spent, extra);
    o.log?.info(
      {
        inputHash: p.inputHash,
        status: r.status,
        failureReason: reason,
        floor: p.floor,
        final: r.risk.final,
        verifierStatus: r.verifier.status,
        calls: spent.calls,
        inputTokens: spent.usage.inputTokens,
        outputTokens: spent.usage.outputTokens,
      },
      "intent card generated",
    );
    return r;
  }

  // 6. Verifier.
  const card = {
    goal: writer.goal,
    behaviorChanges: writer.behaviorChanges,
    outOfScopeEdits: writer.outOfScopeEdits,
  };
  const claimList = cardClaims(card);
  const expectedIds = claimList.map((c) => c.id);
  const kindOf = new Map(claimList.map((c) => [c.id, c.kind] as const));
  const alreadyOutOfScope = new Set(writer.outOfScopeEdits.map((e) => e.path));
  const ver = await callValidated<VerifierOutput>(
    {
      purpose: "verifier",
      model: o.models.strong,
      system: VERIFIER_SYSTEM_PROMPT,
      user: buildVerifierUser(p.verifierData, p.nonce, card),
      outputSchema: VERIFIER_OUTPUT_SCHEMA,
      effort: EFFORTS.verifier,
    },
    (v) => parseVerifierOutput(v, expectedIds, p.fileList, alreadyOutOfScope),
  );

  let verifierResult: CardResult["verifier"];
  let verifierRisk: RiskClass | null = null;
  let verifierModel: string | null = null;
  if (ver.ok) {
    verifierRisk = ver.out.riskClass;
    verifierModel = ver.model;
    instructions = instructions || ver.out.instructionsInData;
    const claims: VerifierClaim[] = ver.out.claims.map((c) => ({
      id: c.id,
      kind: kindOf.get(c.id) as VerifierClaim["kind"],
      verdict: c.verdict,
      reason: c.reason,
    }));
    const disagree = claims.some((c) => c.verdict !== "supported") || ver.out.missing.length > 0;
    verifierResult = {
      status: disagree ? "disagree" : "agree",
      claims,
      missing: ver.out.missing,
      unexplained: ver.out.unexplained,
      failure: null,
    };
  } else {
    verifierResult = {
      status: "error",
      claims: [],
      missing: [],
      unexplained: [],
      failure: ver.reason,
    };
  }

  // 7. Final risk.
  const { final, raisedBy } = combineRisk({
    floor: p.floor,
    writer: writer.riskClass,
    firstPass,
    verifier: verifierRisk,
    verifierStatus: verifierResult.status,
    instructionsInData: instructions,
    unavailable: false,
  });

  const result: CardResult = {
    promptVersion: PROMPT_VERSION,
    inputHash: p.inputHash,
    status: "ok",
    failureReason: null,
    retryable: false,
    card,
    risk: {
      final,
      floor: p.floor,
      floorReasons: p.floorReasons,
      writer: writer.riskClass,
      writerReason: writer.riskReason,
      firstPass,
      verifier: verifierRisk,
      raisedBy,
    },
    verifier: verifierResult,
    instructionsInData: instructions,
    models: { writer: writerModel, firstPass: firstPassModel, verifier: verifierModel },
    usage: { ...spent.usage, calls: spent.calls },
    inputs: p.stats,
  };
  o.log?.info(
    {
      inputHash: p.inputHash,
      status: result.status,
      failureReason: null,
      floor: p.floor,
      final,
      verifierStatus: verifierResult.status,
      calls: spent.calls,
      inputTokens: spent.usage.inputTokens,
      outputTokens: spent.usage.outputTokens,
    },
    "intent card generated",
  );
  return result;
}

export function generateCard(
  inputs: CardInputs,
  llm: LlmClient,
  o: GenerateOptions,
): Promise<CardResult> {
  return runCard(prepareCardInputs(inputs, o), llm, o);
}
