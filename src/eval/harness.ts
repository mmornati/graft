/**
 * runEval (T13, E18 to E21): load, estimate, confirm, run, cache, collect. Fake mode needs no
 * key and never touches the network or the cache. Live results are cached by input hash and
 * prompt fingerprint.
 */
import { randomBytes } from "node:crypto";
import type { LlmClient, LlmUsage } from "../llm/types.js";
import {
  type CardResult,
  type GenerateOptions,
  MAX_OUTPUT_TOKENS,
  maxRisk,
  PROMPT_VERSION,
  type PreparedCard,
  prepareCardInputs,
  promptFingerprint,
  runCard,
} from "../modules/intent/index.js";
import { cacheKey, isCacheable, readCache, writeCache } from "./cache.js";
import { caseSetHash, type EvalCase, gold, goldStatus, type LabelSet } from "./case-schema.js";
import { llmForCase } from "./fake-models.js";
import { type MeteredCall, meteredLlm } from "./metered.js";
import { computeMetrics } from "./metrics.js";
import { cost, costOfCalls, priceFor, roundUsd } from "./pricing.js";
import type { CaseRow, EvalReport } from "./report-schema.js";
import { type CaseSet, EvalCaseError, listCaseIds, readCase } from "./store.js";

export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalConfigError";
  }
}

export interface Estimate {
  casesToCall: number;
  casesCached: number;
  estimatedTokens: number;
  upperBoundUsd: number;
}

export interface RunOptions {
  set: CaseSet;
  mode: "fake" | "live";
  /** The live client, injected by the CLI (tests inject a fake). */
  llm?: LlmClient;
  /**
   * Prices calls on provider-qualified models (a registry); absent means the built-in Claude
   * table. Null means unpriced, which a live run refuses before any call.
   */
  costOf?: (usage: LlmUsage, model: string) => number | null;
  models: { fast: string; strong: string; refusalFallback?: string };
  timeoutMs: number;
  concurrency: number;
  maxCostUsd: number;
  maxTokens: number;
  useCache: boolean;
  caseFilter?: (id: string, tags: string[]) => boolean;
  confirm: (estimate: Estimate) => Promise<boolean>;
  now: () => Date;
  nowMs: () => number;
  /** Ids and classes only. */
  progress?: (line: string) => void;
}

export type RunOutcome =
  | { report: EvalReport; aborted: false }
  | { aborted: true; reason: "declined" | "over_budget"; estimate: Estimate };

/** One input token: enough to tell a priced model from an unpriced one. */
const PRICE_PROBE: LlmUsage = {
  inputTokens: 1,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const sortedUnique = (a: readonly string[]): string[] => [...new Set(a)].sort();

/** §8.12: an upper bound that ignores caching and the cheaper fast model. */
export function estimateCase(
  p: PreparedCard,
  strong: string,
  costOf: (usage: LlmUsage, model: string) => number | null = cost,
): { tokens: number; usd: number } {
  if (p.tooLarge) return { tokens: 0, usd: 0 };
  const out = MAX_OUTPUT_TOKENS * (p.floor === "trivial" ? 3 : 2);
  const input = Math.max(0, p.estimatedTokens - out);
  const usd =
    costOf(
      { inputTokens: input, outputTokens: out, cacheReadTokens: 0, cacheWriteTokens: 0 },
      strong,
    ) ?? 0;
  return { tokens: p.estimatedTokens, usd };
}

export function rowFromResult(
  c: EvalCase,
  g: LabelSet | null,
  result: CardResult,
  o: { costUsd: number; cached: boolean },
): CaseRow {
  const r = result.risk;
  const written = r.writer ?? r.firstPass ?? r.verifier;
  const ok = result.status === "ok";
  const predicted = new Set<string>();
  if (ok) {
    for (const e of result.card?.outOfScopeEdits ?? []) predicted.add(e.path);
    for (const p of result.verifier.unexplained) predicted.add(p);
  }
  const goldSet = new Set(g?.outOfScope ?? []);
  let tp = 0;
  for (const p of predicted) if (goldSet.has(p)) tp += 1;
  const scoredOk = g !== null && ok;
  const flagged = result.verifier.status === "agree" || result.verifier.status === "disagree";
  let flag: CaseRow["flag"] = "na";
  if (g !== null && ok && flagged) {
    // The reviewer is alerted by a disagreement or by the "Also changed" list (intent-v5).
    const predictedFlag =
      result.verifier.status === "disagree" || result.verifier.missing.length > 0;
    flag = predictedFlag ? (g.shouldFlag ? "tp" : "fp") : g.shouldFlag ? "fn" : "tn";
  }
  return {
    id: c.id,
    tags: [...c.tags],
    gold: g
      ? { risk: g.risk, shouldFlag: g.shouldFlag, outOfScopeCount: g.outOfScope.length }
      : null,
    floor: r.floor,
    model: written === null ? null : maxRisk(r.writer, r.firstPass, r.verifier),
    final: r.final,
    status: result.status,
    failureReason: result.failureReason,
    verifierStatus: result.verifier.status,
    raisedBy: [...r.raisedBy],
    floorRules: sortedUnique(r.floorReasons.map((x) => x.rule)),
    instructionsInData: result.instructionsInData,
    oos: scoredOk
      ? { tp, fp: predicted.size - tp, fn: goldSet.size - tp }
      : { tp: 0, fp: 0, fn: 0 },
    flag,
    usage: { ...result.usage },
    costUsd: o.costUsd,
    cached: o.cached,
    skipped: null,
  };
}

function skippedRow(c: EvalCase, g: LabelSet | null, p: PreparedCard): CaseRow {
  return {
    id: c.id,
    tags: [...c.tags],
    gold: g
      ? { risk: g.risk, shouldFlag: g.shouldFlag, outOfScopeCount: g.outOfScope.length }
      : null,
    floor: p.floor,
    model: null,
    final: p.floor,
    status: "skipped",
    failureReason: null,
    verifierStatus: "skipped",
    raisedBy: [],
    floorRules: sortedUnique(p.floorReasons.map((x) => x.rule)),
    instructionsInData: false,
    oos: { tp: 0, fp: 0, fn: 0 },
    flag: "na",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 },
    costUsd: 0,
    cached: false,
    skipped: "budget",
  };
}

const runIdFor = (d: Date): string =>
  `${d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}-${randomBytes(2).toString("hex")}`;

const tokensOf = (u: CardResult["usage"]): number =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

export async function runEval(o: RunOptions): Promise<RunOutcome> {
  const startedMs = o.nowMs();
  const live = o.mode === "live";
  if (live) {
    if (!o.llm) throw new EvalConfigError("live mode needs an LLM client");
    for (const m of [o.models.fast, o.models.strong, o.models.refusalFallback]) {
      if (m === undefined) continue;
      if (o.costOf ? o.costOf(PRICE_PROBE, m) === null : !priceFor(m)) {
        throw new EvalConfigError(
          o.costOf
            ? `no price for model ${m}: add it to its provider's prices`
            : `no price for model ${m}: update src/eval/pricing.ts`,
        );
      }
    }
  }

  // Load and validate every case first: a bad case aborts with its id before any call.
  const all: EvalCase[] = [];
  for (const id of await listCaseIds(o.set)) all.push(await readCase(o.set, id));
  const cases = o.caseFilter ? all.filter((c) => o.caseFilter?.(c.id, c.tags)) : all;

  const genOpts = (c: EvalCase): GenerateOptions => ({
    models: o.models,
    floor: c.floorConfig,
    timeoutMs: o.timeoutMs,
    deadlineMs: 600_000,
    nowMs: o.nowMs,
  });
  const items = cases.map((c) => {
    const prepared = prepareCardInputs(c.inputs, genOpts(c));
    return { c, g: gold(c), prepared, key: cacheKey(prepared.inputHash) };
  });

  // Cache lookups (live only), then the estimate.
  const cachedEntries = new Map<string, Awaited<ReturnType<typeof readCache>>>();
  if (live && o.useCache) {
    for (const it of items) {
      const hit = await readCache(o.set, it.key, it.prepared.inputHash);
      if (hit) cachedEntries.set(it.c.id, hit);
    }
  }
  const estimates = new Map(
    items.map((it) => [it.c.id, estimateCase(it.prepared, o.models.strong, o.costOf)]),
  );
  if (live) {
    const toCall = items.filter((it) => !cachedEntries.has(it.c.id) && !it.prepared.tooLarge);
    const estimate: Estimate = {
      casesToCall: toCall.length,
      casesCached: cachedEntries.size,
      estimatedTokens: toCall.reduce((n, it) => n + (estimates.get(it.c.id)?.tokens ?? 0), 0),
      upperBoundUsd: roundUsd(toCall.reduce((n, it) => n + (estimates.get(it.c.id)?.usd ?? 0), 0)),
    };
    if (estimate.upperBoundUsd > o.maxCostUsd || estimate.estimatedTokens > o.maxTokens) {
      return { aborted: true, reason: "over_budget", estimate };
    }
    if (!(await o.confirm(estimate))) return { aborted: true, reason: "declined", estimate };
  }

  // The pool.
  const rows = new Array<CaseRow>(items.length);
  let next = 0;
  let spentUsd = 0;
  let reservedUsd = 0;
  let spentTokens = 0;
  let reservedTokens = 0;

  const runOne = async (i: number): Promise<void> => {
    const it = items[i] as (typeof items)[number];
    const { c, g, prepared } = it;
    const hit = cachedEntries.get(c.id);
    if (hit) {
      rows[i] = rowFromResult(c, g, hit.result, { costUsd: hit.costUsd, cached: true });
      o.progress?.(`${c.id}: ${hit.result.risk.final} (cached)`);
      return;
    }
    const est = estimates.get(c.id) ?? { tokens: 0, usd: 0 };
    if (live && !prepared.tooLarge) {
      if (
        spentUsd + reservedUsd + est.usd > o.maxCostUsd ||
        spentTokens + reservedTokens + est.tokens > o.maxTokens
      ) {
        rows[i] = skippedRow(c, g, prepared);
        o.progress?.(`${c.id}: skipped (budget)`);
        return;
      }
      reservedUsd += est.usd;
      reservedTokens += est.tokens;
    }
    const metered = meteredLlm(live ? (o.llm as LlmClient) : llmForCase(c));
    let result: CardResult;
    try {
      result = await runCard(prepared, metered.client, genOpts(c));
    } catch (err) {
      // Only a synthetic (fictional, committed) set may echo the message; a pilot set never does.
      const detail =
        !live && o.set.meta.kind === "synthetic"
          ? String(err instanceof Error ? err.message : err)
          : err instanceof Error
            ? err.name
            : "error";
      throw new EvalCaseError(c.id, `unexpected error while generating the card (${detail})`);
    } finally {
      if (live && !prepared.tooLarge) {
        reservedUsd -= est.usd;
        reservedTokens -= est.tokens;
      }
    }
    const calls: MeteredCall[] = metered.calls;
    const costUsd = o.costOf
      ? roundUsd(calls.reduce((sum, c) => sum + (o.costOf?.(c.usage, c.model) ?? 0), 0))
      : costOfCalls(calls);
    spentUsd += costUsd;
    spentTokens += tokensOf(result.usage);
    if (live && isCacheable(result)) {
      await writeCache(o.set, it.key, { result, calls, costUsd });
    }
    rows[i] = rowFromResult(c, g, result, { costUsd, cached: false });
    o.progress?.(
      `${c.id}: floor ${result.risk.floor}, final ${result.risk.final}, ${result.status}`,
    );
  };

  // After an unexpected error no worker takes another case (and so none calls the API again).
  let failed = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        await runOne(i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const width = Math.max(1, Math.min(o.concurrency, items.length));
  await Promise.all(Array.from({ length: width }, worker));

  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const metrics = computeMetrics(sorted);
  const skippedBudget = sorted.filter((r) => r.skipped !== null).length;
  const report: EvalReport = {
    schemaVersion: 1,
    runId: runIdFor(o.now()),
    createdAt: o.now().toISOString(),
    set: {
      setId: o.set.meta.setId,
      kind: o.set.meta.kind,
      caseSetHash: caseSetHash(cases),
      cases: cases.length,
      scored: metrics.scored,
      unlabeled: cases.filter((c) => goldStatus(c) === "unlabeled").length,
      needsAdjudication: cases.filter((c) => goldStatus(c) === "needs_adjudication").length,
    },
    prompt: { promptVersion: PROMPT_VERSION, promptFingerprint: promptFingerprint() },
    models: { fast: o.models.fast, strong: o.models.strong },
    llm: o.mode,
    git: { commit: null, dirty: null },
    run: {
      complete: skippedBudget === 0,
      skippedBudget,
      cachedResults: sorted.filter((r) => r.cached).length,
      durationMs: Math.max(0, Math.round(o.nowMs() - startedMs)),
    },
    metrics,
    cases: sorted,
    thresholds: [],
    pass: true,
  };
  return { report, aborted: false };
}
