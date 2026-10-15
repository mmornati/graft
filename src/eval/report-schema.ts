/** The eval report (§6.6). Carries ids, classes, counts and numbers only (E8): never code or prose. */
import { z } from "zod";
import { riskClassSchema } from "./case-schema.js";

const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(1).nullable();
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const usageSchema = z.strictObject({
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  calls: count,
});
export type ReportUsage = z.infer<typeof usageSchema>;

export const FLAG_OUTCOMES = ["tp", "fp", "fn", "tn", "na"] as const;

export const caseRowSchema = z.strictObject({
  id: z.string(),
  tags: z.array(z.string()),
  gold: z
    .strictObject({ risk: riskClassSchema, shouldFlag: z.boolean(), outOfScopeCount: count })
    .nullable(),
  floor: riskClassSchema,
  model: riskClassSchema.nullable(),
  final: riskClassSchema,
  status: z.enum(["ok", "unavailable", "skipped"]),
  failureReason: z.string().nullable(),
  verifierStatus: z.enum(["agree", "disagree", "error", "skipped"]),
  raisedBy: z.array(z.string()),
  floorRules: z.array(z.string()),
  instructionsInData: z.boolean(),
  oos: z.strictObject({ tp: count, fp: count, fn: count }),
  flag: z.enum(FLAG_OUTCOMES),
  usage: usageSchema,
  costUsd: z.number().nonnegative(),
  cached: z.boolean(),
  skipped: z.literal("budget").nullable(),
});
export type CaseRow = z.infer<typeof caseRowSchema>;

const matrixSchema = z.strictObject({
  n: count,
  /** Rows: gold; columns: predicted; order trivial, logic, sensitive. */
  counts: z.array(z.array(count)),
  precision: z.array(rate),
  recall: z.array(rate),
});
export type ConfusionMatrix = z.infer<typeof matrixSchema>;

export const metricsSchema = z.strictObject({
  scored: count,
  runCases: count,
  okCases: count,
  underClassificationFloor: rate,
  underClassificationModel: rate,
  underClassificationFinal: rate,
  severeUnderClassificationFloor: rate,
  severeUnderClassificationModel: rate,
  severeUnderClassificationFinal: rate,
  overClassificationFloor: rate,
  overClassificationModel: rate,
  overClassificationFinal: rate,
  exactAccuracyFloor: rate,
  exactAccuracyModel: rate,
  exactAccuracyFinal: rate,
  trivialRecall: rate,
  confusion: z.strictObject({ floor: matrixSchema, model: matrixSchema, final: matrixSchema }),
  byTag: z.record(
    z.string(),
    z.strictObject({
      n: count,
      underClassificationFloor: rate,
      underClassificationModel: rate,
      underClassificationFinal: rate,
    }),
  ),
  outOfScopePrecision: rate,
  outOfScopeRecall: rate,
  outOfScopeExactRate: rate,
  flagPrecision: rate,
  flagRecall: rate,
  flagCounts: z.strictObject({ tp: count, fp: count, fn: count, tn: count }),
  verifierErrorRate: rate,
  unavailableRate: rate,
  unavailableByReason: z.record(z.string(), count),
  injectionDetection: rate,
  cardAcceptableRate: rate,
  tokens: usageSchema,
  costUsd: z.number().nonnegative(),
  costUsdThisRun: z.number().nonnegative(),
  costPerCaseUsd: z.number().nonnegative().nullable(),
});
export type Metrics = z.infer<typeof metricsSchema>;

export const thresholdResultSchema = z.strictObject({
  name: z.string(),
  value: z.number().nullable(),
  limit: z.string(),
  pass: z.boolean(),
  provisional: z.boolean(),
});
export type ThresholdResult = z.infer<typeof thresholdResultSchema>;

export const evalReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string(),
  createdAt: z.string().regex(ISO),
  set: z.strictObject({
    setId: z.string(),
    kind: z.enum(["synthetic", "pilot"]),
    caseSetHash: z.string().regex(/^[0-9a-f]{64}$/),
    cases: count,
    scored: count,
    unlabeled: count,
    needsAdjudication: count,
  }),
  prompt: z.strictObject({ promptVersion: z.string(), promptFingerprint: z.string() }),
  models: z.strictObject({ fast: z.string(), strong: z.string() }),
  llm: z.enum(["fake", "live"]),
  git: z.strictObject({ commit: z.string().nullable(), dirty: z.boolean().nullable() }),
  run: z.strictObject({
    complete: z.boolean(),
    skippedBudget: count,
    cachedResults: count,
    durationMs: count,
  }),
  metrics: metricsSchema,
  cases: z.array(caseRowSchema),
  thresholds: z.array(thresholdResultSchema),
  pass: z.boolean(),
});
export type EvalReport = z.infer<typeof evalReportSchema>;

export function evalReportJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(evalReportSchema, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  return {
    $id: "https://graft.invalid/schema/eval-report.v1.json",
    title: "Graft eval report v1",
    description:
      "Generated from src/eval/report-schema.ts (pnpm eval schema --write). Ids, classes, counts and numbers only: never paths, titles, bodies, diffs or model prose.",
    ...schema,
  };
}
