/** `report.json` (§9.2): schemaVersion 1. Values are short strings, numbers and booleans only. */
import { z } from "zod";

export const STATUS = z.enum(["pass", "fail", "skipped"]);
export const SKIP_REASON = z.enum([
  "needs_outsider",
  "needs_live_llm",
  "budget",
  "dependency_failed",
  "not_selected",
]);
export type SkipReason = z.infer<typeof SKIP_REASON>;

export const assertionSchema = z.object({
  id: z.string(),
  kind: z.enum(["system", "model", "soft"]),
  expected: z.unknown(),
  observed: z.unknown(),
  ok: z.boolean(),
});
export type AssertionResult = z.infer<typeof assertionSchema>;

export const invariantSchema = z.object({
  id: z.string(),
  status: z.enum(["pass", "fail", "warn", "accounted"]),
  detail: z.string(),
});
export type InvariantResult = z.infer<typeof invariantSchema>;

export const scenarioResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: STATUS,
  skipReason: SKIP_REASON.optional(),
  prs: z.array(
    z.object({ key: z.string(), number: z.number(), url: z.string(), headSha: z.string() }),
  ),
  startedAt: z.string(),
  durationMs: z.number(),
  costUsd: z.number(),
  tokens: z.number(),
  assertions: z.array(assertionSchema),
  invariants: z.array(invariantSchema),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
});
export type ScenarioResult = z.infer<typeof scenarioResultSchema>;

export const assumptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  anchor: z.string().nullable(),
  status: z.enum(["pass", "fail", "unverified", "skipped"]),
  evidence: z.unknown(),
});
export type AssumptionResult = z.infer<typeof assumptionSchema>;

export const reportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  mode: z.object({
    target: z.enum(["github", "offline"]),
    llm: z.enum(["live", "none"]),
    interactive: z.boolean(),
    dryRun: z.boolean(),
    lenientModel: z.boolean(),
  }),
  sandbox: z.object({
    repo: z.string(),
    visibility: z.enum(["private", "public"]),
    outsiderMode: z.enum(["collaborator", "fork", "none"]),
    installationId: z.number(),
    repositoryId: z.number(),
  }),
  graft: z.object({
    appId: z.number(),
    gitCommit: z.string(),
    dirty: z.boolean(),
    promptVersion: z.string(),
    pricingVerifiedAt: z.string(),
  }),
  cost: z.object({
    maxUsd: z.number(),
    estimateUsd: z.number(),
    spentUsd: z.number(),
    tokens: z.number(),
  }),
  scenarios: z.array(scenarioResultSchema),
  assumptions: z.array(assumptionSchema),
  sentinels: z.object({
    planted: z.number(),
    hits: z.array(
      z.object({
        scenario: z.string(),
        kind: z.string(),
        table: z.string(),
        key: z.string(),
        class: z.enum(["echo", "accounted", "fail"]),
        deadline: z.string().optional(),
      }),
    ),
  }),
  humanTodo: z.array(
    z.object({
      anchor: z.string(),
      kind: z.enum(["tick", "note"]),
      assumptions: z.array(z.string()),
      resolvable: z.boolean(),
    }),
  ),
  exitCode: z.number().int(),
});
export type Report = z.infer<typeof reportSchema>;
