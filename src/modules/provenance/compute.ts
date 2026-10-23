/** Pure aggregation of per-commit and PR-body trailers into one provenance result (§T6). */
import {
  extractGraftFields,
  type GraftField,
  type ProvenanceWarning,
  type WarningCode,
} from "./fields.js";
import { parseTrailerBlock } from "./trailers.js";

export interface CommitInput {
  sha: string;
  message: string;
}
export interface ProvenanceInput {
  commits: readonly CommitInput[];
  commitsTotal: number;
  truncated: boolean;
  prBody: string | null;
  prAuthor: { login: string; type: string };
  agentLogins: readonly string[];
  agentCoauthorEmails: readonly string[];
}
export interface ResolvedField {
  value: string;
  source: "commit" | "pr_body";
  commitSha?: string;
}
export type AuthorKindReason =
  | "trailer"
  | "bot_account"
  | "configured_login"
  | "agent_coauthor"
  | "none";
export interface ProvenanceResult {
  fields: Partial<Record<GraftField, ResolvedField>>;
  conflicts: Partial<Record<GraftField, string[]>>;
  perCommit: { sha: string; fields: Partial<Record<GraftField, string>> }[];
  prBodyFields: Partial<Record<GraftField, string>> | null;
  authorKind: "agent" | "human";
  authorKindReason: AuthorKindReason;
  warnings: ProvenanceWarning[];
  /** True when not every commit of the PR was scanned (more than 250 commits). */
  truncated: boolean;
  counts: { total: number; scanned: number; withTrailers: number; agentCoauthor: number };
}

export const MAX_WARNINGS = 50;
export const MAX_CONFLICT_VALUES = 5;
const FIELDS: readonly GraftField[] = ["agent", "model", "task", "session"];

interface Parsed {
  fields: Partial<Record<GraftField, string>>;
  warnings: ProvenanceWarning[];
  agentCoauthor: boolean;
}

function parseOne(
  text: string,
  hasTitle: boolean,
  source: "commit" | "pr_body",
  commitSha: string | undefined,
  agentCoauthorEmails: readonly string[],
): Parsed {
  const block = parseTrailerBlock(text, { hasTitle });
  const ex = extractGraftFields(block.trailers, { agentCoauthorEmails });
  const tag = (code: WarningCode, field?: GraftField): ProvenanceWarning => ({
    code,
    ...(field ? { field } : {}),
    ...(commitSha ? { commitSha } : {}),
    source,
  });
  const warnings: ProvenanceWarning[] = [];
  if (block.truncated) warnings.push(tag("message_truncated"));
  if (block.blockTooLong) warnings.push(tag("block_too_long"));
  for (const w of ex.warnings) warnings.push(tag(w.code, w.field));
  return { fields: ex.fields, warnings, agentCoauthor: ex.agentCoauthor };
}

export function computeProvenance(input: ProvenanceInput): ProvenanceResult {
  const warnings: ProvenanceWarning[] = [];
  const perCommit: ProvenanceResult["perCommit"] = [];
  let agentCoauthorCommits = 0;

  for (const c of input.commits) {
    const p = parseOne(c.message, true, "commit", c.sha, input.agentCoauthorEmails);
    warnings.push(...p.warnings);
    if (p.agentCoauthor) agentCoauthorCommits++;
    if (Object.keys(p.fields).length > 0) perCommit.push({ sha: c.sha, fields: p.fields });
  }

  let prBodyFields: Partial<Record<GraftField, string>> | null = null;
  if (input.prBody !== null && input.prBody !== "") {
    const p = parseOne(input.prBody, false, "pr_body", undefined, input.agentCoauthorEmails);
    warnings.push(...p.warnings);
    if (Object.keys(p.fields).length > 0) prBodyFields = p.fields;
  }

  // D9: newest commit first, then older ones, then the body.
  const fields: ProvenanceResult["fields"] = {};
  const conflicts: ProvenanceResult["conflicts"] = {};
  const newestFirst = [...perCommit].reverse();
  for (const f of FIELDS) {
    const distinct: string[] = [];
    const seen = (v: string) => {
      if (!distinct.includes(v)) distinct.push(v);
    };
    for (const c of newestFirst) {
      const v = c.fields[f];
      if (v === undefined) continue;
      seen(v);
      if (!fields[f]) fields[f] = { value: v, source: "commit", commitSha: c.sha };
    }
    const bodyValue = prBodyFields?.[f];
    if (bodyValue !== undefined) {
      seen(bodyValue);
      if (!fields[f]) fields[f] = { value: bodyValue, source: "pr_body" };
    }
    // D10: more than one distinct value is a conflict; the newest still wins.
    if (distinct.length > 1) conflicts[f] = distinct.slice(0, MAX_CONFLICT_VALUES);
  }

  // D11
  const login = input.prAuthor.login.toLowerCase();
  let authorKind: "agent" | "human" = "agent";
  let authorKindReason: AuthorKindReason;
  if (fields.agent) authorKindReason = "trailer";
  else if (input.prAuthor.type === "Bot") authorKindReason = "bot_account";
  else if (input.agentLogins.some((l) => l.toLowerCase() === login))
    authorKindReason = "configured_login";
  else if (agentCoauthorCommits > 0) authorKindReason = "agent_coauthor";
  else {
    authorKind = "human";
    authorKindReason = "none";
  }

  return {
    fields,
    conflicts,
    perCommit,
    prBodyFields,
    authorKind,
    authorKindReason,
    warnings: warnings.slice(0, MAX_WARNINGS),
    truncated: input.truncated,
    counts: {
      total: input.commitsTotal,
      scanned: input.commits.length,
      withTrailers: perCommit.length,
      agentCoauthor: agentCoauthorCommits,
    },
  };
}

export type McpReportState = "none" | "agrees" | "disagrees";

/**
 * Phase 1 step 6 (§8, D13): how an MCP provenance report compares with the trailers of its head.
 * It agrees iff the trailers were computed for that head, say an agent wrote it, and name the
 * same agent (case-insensitive); anything else disagrees, which makes the author fact `unknown`.
 */
export function mcpAgreement(
  trailers: { headSha: string; authorKind: "agent" | "human"; agent: string | null } | null,
  report: { headSha: string; agent: string } | null,
): McpReportState {
  if (report === null) return "none";
  if (trailers === null || trailers.headSha !== report.headSha) return "disagrees";
  if (trailers.authorKind !== "agent" || trailers.agent === null) return "disagrees";
  return trailers.agent.toLowerCase() === report.agent.toLowerCase() ? "agrees" : "disagrees";
}
