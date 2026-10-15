/**
 * The eval case format (E2, §6.1). zod is the source of truth; `eval/schema/eval-case.v1.schema.json`
 * is generated from it (`pnpm eval schema --write`) and pinned by a test.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { cardInputsSchema } from "../modules/intent/index.js";

export const CASE_SCHEMA_VERSION = 1;

const LABELER = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** An ISO 8601 date-time with a `Z` or numeric offset (a regex so that plain JSON Schema validators need no format plugin). */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA40 = /^[0-9a-f]{40}$/;

const isoDateTime = z.string().regex(ISO_DATETIME);

export const RISK_CLASSES = ["trivial", "logic", "sensitive"] as const;
export const riskClassSchema = z.enum(RISK_CLASSES);
export type RiskClass = z.infer<typeof riskClassSchema>;

export const labelSetSchema = z.strictObject({
  labeler: z.string().regex(LABELER),
  labeledAt: isoDateTime,
  guideVersion: z.string().regex(/^lg-\d+$/),
  risk: riskClassSchema,
  outOfScope: z.array(z.string()),
  goal: z.string().max(300),
  keyBehaviorChanges: z.array(z.string().max(300)).max(10),
  shouldFlag: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string().max(2000),
});
export type LabelSet = z.infer<typeof labelSetSchema>;

const LLM_FAILURES = [
  "timeout",
  "rate_limited",
  "unavailable",
  "auth",
  "bad_request",
  "refusal",
  "max_tokens",
  "invalid_json",
  "not_configured",
] as const;

const fakeEntrySchema = z.union([
  z.strictObject({ json: z.unknown() }),
  z.strictObject({ failure: z.enum(LLM_FAILURES) }),
]);
export type FakeEntry = z.infer<typeof fakeEntrySchema>;

export const fakeScriptSchema = z.strictObject({
  writer: fakeEntrySchema.optional(),
  writerEscalated: fakeEntrySchema.optional(),
  verifier: z.union([fakeEntrySchema, z.literal("agree")]).optional(),
});
export type FakeScript = z.infer<typeof fakeScriptSchema>;

const syntheticSource = z.strictObject({
  kind: z.literal("synthetic"),
  author: z.string().min(1).max(100),
  createdAt: z.string().regex(ISO_DATE),
});

const pilotSource = z.strictObject({
  kind: z.literal("pilot"),
  setId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(SHA40),
  baseSha: z.string().regex(SHA40),
  mergedAt: isoDateTime,
  exportedAt: isoDateTime,
  exportTool: z.literal("graft-eval-export/1"),
  authorKind: z.enum(["agent", "human"]),
  authorKindReason: z.enum([
    "trailer",
    "bot_account",
    "configured_login",
    "agent_coauthor",
    "none",
  ]),
  agent: z.string().nullable(),
  model: z.string().nullable(),
  redactions: z.array(z.strictObject({ kind: z.string(), count: z.number().int().nonnegative() })),
});

export const sourceSchema = z.discriminatedUnion("kind", [syntheticSource, pilotSource]);
export type CaseSource = z.infer<typeof sourceSchema>;

export const floorConfigSchema = z.strictObject({
  extraSensitiveGlobs: z.array(z.string().min(1).max(200)).max(100),
});

export const CASE_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

const sortedUnique = (a: readonly string[]): boolean =>
  a.every((x, i) => i === 0 || (a[i - 1] as string) < x);

/** Refinements that JSON Schema cannot express; also listed in the generated schema's description. */
export const CASE_REFINEMENTS = [
  "id equals the file name without the extension",
  "synthetic ids start with syn-; pilot ids start with <setId>--",
  "tags are unique; pilot fakeLlm is null",
  "pilot inputs.repositoryFullName equals source.repository and inputs.pr.number equals source.prNumber",
  "labels have unique labelers; every outOfScope list is sorted, unique and made of paths in inputs.files",
];

const caseObject = z.strictObject({
  schemaVersion: z.literal(CASE_SCHEMA_VERSION),
  id: z.string().regex(CASE_ID),
  source: sourceSchema,
  tags: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(20),
  floorConfig: floorConfigSchema,
  inputs: cardInputsSchema,
  labels: z.array(labelSetSchema).max(5),
  adjudicated: labelSetSchema.nullable(),
  fakeLlm: fakeScriptSchema.nullable(),
});

export const evalCaseSchema = caseObject.superRefine((c, ctx) => {
  const bad = (message: string, path: (string | number)[] = []) =>
    ctx.addIssue({ code: "custom", message, path });
  if (c.source.kind === "synthetic") {
    if (!c.id.startsWith("syn-")) bad("synthetic case ids must start with syn-", ["id"]);
  } else {
    if (!c.id.startsWith(`${c.source.setId}--`)) {
      bad("pilot case ids must start with <setId>--", ["id"]);
    }
    if (c.fakeLlm !== null) bad("a pilot case must not carry a fakeLlm script", ["fakeLlm"]);
    if (c.inputs.repositoryFullName !== c.source.repository) {
      bad("inputs.repositoryFullName must equal source.repository", [
        "inputs",
        "repositoryFullName",
      ]);
    }
    if (c.inputs.pr.number !== c.source.prNumber) {
      bad("inputs.pr.number must equal source.prNumber", ["inputs", "pr", "number"]);
    }
  }
  if (new Set(c.tags).size !== c.tags.length) bad("tags must be unique", ["tags"]);
  const labelers = c.labels.map((l) => l.labeler);
  if (new Set(labelers).size !== labelers.length) bad("labelers must be unique", ["labels"]);
  const paths = new Set(c.inputs.files.map((f) => f.path));
  const sets: [string, LabelSet][] = c.labels.map((l, i) => [`labels.${i}`, l]);
  if (c.adjudicated) sets.push(["adjudicated", c.adjudicated]);
  for (const [where, l] of sets) {
    if (!sortedUnique(l.outOfScope)) bad("outOfScope must be sorted and unique", [where]);
    for (const [i, p] of l.outOfScope.entries()) {
      if (!paths.has(p)) bad("outOfScope path is not in inputs.files", [where, "outOfScope", i]);
    }
  }
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

const sameLabel = (a: LabelSet, b: LabelSet): boolean =>
  a.risk === b.risk &&
  a.shouldFlag === b.shouldFlag &&
  JSON.stringify([...a.outOfScope].sort()) === JSON.stringify([...b.outOfScope].sort());

/** E17: the adjudicated set, else the first set when every set agrees on the scored fields. */
export function gold(c: EvalCase): LabelSet | null {
  if (c.adjudicated) return c.adjudicated;
  const first = c.labels[0];
  if (!first) return null;
  return c.labels.every((l) => sameLabel(first, l)) ? first : null;
}

export type GoldStatus = "gold" | "unlabeled" | "needs_adjudication";
export function goldStatus(c: EvalCase): GoldStatus {
  if (gold(c)) return "gold";
  return c.labels.length === 0 ? "unlabeled" : "needs_adjudication";
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Covers what the model sees and the floor config; not labels, tags or fake scripts. */
export function caseHash(c: EvalCase): string {
  return sha256(JSON.stringify([c.id, c.inputs, c.floorConfig]));
}

export function goldDigest(c: EvalCase): string {
  const g = gold(c);
  if (!g) return "none";
  return sha256(
    JSON.stringify({
      risk: g.risk,
      shouldFlag: g.shouldFlag,
      outOfScope: [...g.outOfScope].sort(),
    }),
  );
}

/** §8.13 */
export function caseSetHash(cases: readonly EvalCase[]): string {
  const parts = cases.map((c) => `${caseHash(c)}:${goldDigest(c)}`).sort();
  return sha256(JSON.stringify(parts));
}

export function evalCaseJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(caseObject, { target: "draft-2020-12" }) as Record<string, unknown>;
  return {
    $id: "https://graft.invalid/schema/eval-case.v1.json",
    title: "Graft eval case v1",
    description: `Generated from src/eval/case-schema.ts (pnpm eval schema --write). Rules a JSON Schema cannot express: ${CASE_REFINEMENTS.join("; ")}.`,
    ...schema,
  };
}
