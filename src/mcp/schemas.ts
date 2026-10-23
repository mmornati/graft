/**
 * The MCP tools' contract (Phase 1 step 6, §7, D17, D18, D20, D21). Pure: zod only, no database, no
 * GitHub, no module code. Inputs are strict objects, so an unknown key fails the SDK's validation.
 * Strings an agent sends are bounded here; the trailer validators of the provenance module run in
 * the tools, which pass them to `buildPrBody` as a function.
 */
import { z } from "zod";

/** D20: every code a tool returns in `structuredContent.error`. */
export const TOOL_ERROR_CODES = [
  "forbidden_repository",
  "not_found",
  "stale_head",
  "pr_closed",
  "already_reported",
  "invalid_argument",
  "mcp_write_off",
  "invalid_head",
  "head_not_found",
  "base_not_found",
  "rate_limited",
  "internal",
] as const;
/** `github_<status>` is the one open-ended code (D20). */
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number] | `github_${number}`;

export const MAX_PR_NUMBER = 2 ** 31 - 1;
export const MAX_TITLE_CHARS = 256;
export const MAX_BODY_CHARS = 16_000;
/** The trailer validators' own cap on a raw value (step 2, `MAX_RAW_VALUE_CHARS`). */
const MAX_FIELD_CHARS = 2048;

const NAME_PART = "[A-Za-z0-9_.-]{1,100}";
export const REPOSITORY_RE = new RegExp(`^${NAME_PART}/${NAME_PART}$`);

/**
 * D17: a branch name `open_change` (and `get_policy`'s `base`) accepts. Plain characters only, so no
 * `owner:` form, no `..`, no leading `/` or `-`, no trailing `/` or `.lock`, and never the guard's
 * reserved `graft-revert/` namespace. Whether it is the default branch is the tool's check.
 */
export function validBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(name) &&
    !name.includes("..") &&
    !name.startsWith("/") &&
    !name.startsWith("-") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.startsWith("graft-revert/")
  );
}

const CONTROL_RE = /\p{Cc}/u;

/** D18: 1 to 256 characters once trimmed, no control characters (a newline included). */
export function validTitle(title: string): boolean {
  const t = title.trim();
  return t.length >= 1 && Array.from(t).length <= MAX_TITLE_CHARS && !CONTROL_RE.test(t);
}

const repository = z.string().regex(REPOSITORY_RE, "must be owner/name");
const prNumber = z.number().int().min(1).max(MAX_PR_NUMBER);
const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character lowercase hex SHA");
const field = z.string().min(1).max(MAX_FIELD_CHARS);
const branch = z.string().min(1).max(255);

export const getStatusInput = z.object({ repository, pr: prNumber }).strict();
export const getPolicyInput = z.object({ repository, base: branch.optional() }).strict();
export const reportProvenanceInput = z
  .object({
    repository,
    pr: prNumber,
    headSha: sha,
    agent: field,
    model: field.optional(),
    task: field.optional(),
    sessionUrl: field.optional(),
  })
  .strict();
export const provenanceArgument = z
  .object({
    agent: field.optional(),
    model: field.optional(),
    task: field.optional(),
    sessionUrl: field.optional(),
  })
  .strict();
export const openChangeInput = z
  .object({
    repository,
    head: branch,
    base: branch.optional(),
    title: z.string().max(1024).refine(validTitle, {
      message: "must be 1 to 256 characters without control characters",
    }),
    body: z.string().max(MAX_BODY_CHARS).optional(),
    draft: z.boolean().optional(),
    provenance: provenanceArgument.optional(),
  })
  .strict();

export type GetStatusInput = z.infer<typeof getStatusInput>;
export type GetPolicyInput = z.infer<typeof getPolicyInput>;
export type ReportProvenanceInput = z.infer<typeof reportProvenanceInput>;
export type OpenChangeInput = z.infer<typeof openChangeInput>;
export type ProvenanceArgument = z.infer<typeof provenanceArgument>;

// ---------------------------------------------------------------------------------------------
// Outputs (D21)
// ---------------------------------------------------------------------------------------------

const modeState = z.object({ effective: z.string(), reason: z.string() });
const risk = z.enum(["trivial", "logic", "sensitive"]);

export const getStatusOutput = z.object({
  pr: z.object({
    number: z.number().int(),
    state: z.enum(["open", "closed", "merged"]),
    headSha: z.string(),
    baseRef: z.string(),
    openedThroughMcp: z.boolean(),
  }),
  card: z
    .object({
      headSha: z.string(),
      current: z.boolean(),
      status: z.enum(["ok", "unavailable"]),
      riskClass: risk,
      goal: z.string().nullable(),
      behaviorChanges: z.array(z.string()),
      outOfScopeEdits: z.array(z.object({ path: z.string(), reason: z.string() })),
    })
    .nullable(),
  provenance: z
    .object({
      headSha: z.string(),
      current: z.boolean(),
      authorKind: z.enum(["agent", "human"]),
      agent: z.string().nullable(),
      model: z.string().nullable(),
      task: z.string().nullable(),
      sessionUrl: z.string().nullable(),
      conflicts: z.array(z.string()),
      mcp: z.object({
        report: z.enum(["none", "agrees", "disagrees"]),
        agent: z.string().nullable(),
        model: z.string().nullable(),
        task: z.string().nullable(),
        sessionUrl: z.string().nullable(),
      }),
    })
    .nullable(),
  policy: z
    .object({
      headSha: z.string(),
      current: z.boolean(),
      outcome: z.string(),
      policyMode: z.enum(["report", "enforce"]),
      published: z.string(),
      wouldBe: z.string().nullable(),
      wouldBeReason: z.string().nullable(),
      riskClass: risk.nullable(),
      approvals: z.object({ current: z.number().int(), stale: z.number().int() }),
      breakGlass: z.enum(["none", "applied", "would_bypass"]),
      evaluatedAt: z.string(),
    })
    .nullable(),
  guard: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      detectedAt: z.string().nullable(),
      failingChecks: z.array(z.string()),
      revertPrNumber: z.number().int().nullable(),
      revertOutcome: z.string().nullable(),
    }),
  ),
  modes: z.object({ policy: modeState, guard: modeState, mcpWrite: modeState }),
});

export const getPolicyOutput = z.object({
  base: z.string(),
  commitSha: z.string(),
  status: z.enum(["ok", "missing", "invalid"]),
  hash: z.string().nullable(),
  policy: z.record(z.string(), z.unknown()).nullable(),
  errors: z.array(
    z.object({ code: z.string(), line: z.number().int().optional(), path: z.string().optional() }),
  ),
  warnings: z.array(z.record(z.string(), z.unknown())),
  modes: z.object({
    ceiling: z.string(),
    policy: modeState,
    guard: modeState,
    mcpWrite: modeState,
  }),
});

export const reportProvenanceOutput = z.object({
  stored: z.literal(true),
  existing: z.boolean(),
  agreement: z.enum(["agrees", "disagrees", "pending"]),
});

export const openChangeOutput = z.object({
  prNumber: z.number().int(),
  url: z.string(),
  headSha: z.string(),
  existing: z.boolean(),
  warnings: z.array(z.string()),
});

export type GetStatusOutput = z.infer<typeof getStatusOutput>;
export type GetPolicyOutput = z.infer<typeof getPolicyOutput>;
export type ReportProvenanceOutput = z.infer<typeof reportProvenanceOutput>;
export type OpenChangeOutput = z.infer<typeof openChangeOutput>;

// ---------------------------------------------------------------------------------------------
// PR body (D18)
// ---------------------------------------------------------------------------------------------

export type ProvenanceKey = keyof ProvenanceArgument;
const TRAILER_OF: Record<ProvenanceKey, string> = {
  agent: "Graft-Agent",
  model: "Graft-Model",
  task: "Graft-Task",
  sessionUrl: "Graft-Session",
};
const ORDER: readonly ProvenanceKey[] = ["agent", "model", "task", "sessionUrl"];

/**
 * The body `open_change` sends: the agent's body, then, as the last paragraph, a trailer block of
 * the provenance values that pass `validate` (the trailer validators of step 2, passed in). An
 * invalid value is dropped and named in `warnings` (fixed text, never the value).
 */
export function buildPrBody(
  body: string | undefined,
  provenance: ProvenanceArgument | undefined,
  validate: (key: ProvenanceKey, raw: string) => string | null,
): { body: string; warnings: string[] } {
  const warnings: string[] = [];
  const lines: string[] = [];
  for (const key of ORDER) {
    const raw = provenance?.[key];
    if (raw === undefined) continue;
    const value = validate(key, raw);
    if (value === null) warnings.push(`provenance.${key} dropped: invalid value`);
    else lines.push(`${TRAILER_OF[key]}: ${value}`);
  }
  const text = (body ?? "").replace(/\s+$/, "");
  if (lines.length === 0) return { body: text, warnings };
  const block = lines.join("\n");
  return { body: text === "" ? block : `${text}\n\n${block}`, warnings };
}
