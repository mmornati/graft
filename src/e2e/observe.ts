/**
 * Observations (reads only): what the database and GitHub say about a run PR. The scenario
 * expectation functions work on these plain objects, so they can be tested on canned values.
 * Observations hold ids, statuses, counts, enum values and booleans; never PR text, model prose
 * or check-run titles of the intent check (policy and provenance titles are Graft's own words).
 */
import { sql } from "kysely";
import type { GitHubClient } from "../github/client-factory.js";
import { isOurComment, MANAGED_COMMENT_MARKER } from "../github/managed-comment.js";
import { INTENT_CHECK_NAME } from "../modules/intent/index.js";
import { POLICY_CHECK_NAME } from "../modules/policy/index.js";
import { PROVENANCE_CHECK_NAME } from "../modules/provenance/index.js";
import type { RunCtx } from "./types.js";

export const GRAFT_CHECKS = [PROVENANCE_CHECK_NAME, INTENT_CHECK_NAME, POLICY_CHECK_NAME] as const;

export interface CheckObs {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** Policy and provenance titles are Graft's fixed vocabulary; the intent title is not kept. */
  title: string | null;
  completedAt: string | null;
  hasActions: boolean;
  /** The JSON keys of the check-run object (A05 evidence). */
  keys?: string[];
}

export interface CardObs {
  id: string;
  status: "ok" | "unavailable";
  failureReason: string | null;
  riskClass: string;
  riskFloor: string;
  floorRules: string[];
  floorReasons: { rule: string; paths: string[] }[];
  modelRiskClass: string | null;
  verifierStatus: string;
  linkedIssue: number | null;
  behaviorChanges: number;
  outOfScopeEdits: number;
  instructionsInData: boolean;
  writerModel: string | null;
  firstPassModel: string | null;
  verifierModel: string | null;
  createdAt: string;
}

export interface VerdictObs {
  id: string;
  headSha: string;
  policyStatus: string;
  policyCommitSha: string;
  policyHash: string | null;
  outcome: string;
  riskClass: string | null;
  riskFinal: boolean;
  riskSource: string | null;
  policyFileChanged: boolean;
  humans: number | null;
  teamConstraints: number;
  approvalsCurrent: number;
  approvalUsers: string[];
  publishedAt: string | null;
  evaluatedAt: string;
}

export interface ProvenanceObs {
  headSha: string;
  authorKind: string;
  reason: string;
  agent: string | null;
  model: string | null;
  task: string | null;
  commitsTotal: number;
  commitsWithTrailers: number;
}

export interface CommentObs {
  /** Ours (marker first line and A01 ownership). */
  ours: number[];
  /** Comments whose first line is the marker, ours or not. */
  markerComments: number;
  id: number | null;
  updatedAt: string | null;
  /** Section start markers in order of appearance. */
  sections: string[];
  /** Per section: how often its start and end markers occur. */
  markerCounts: Record<string, { start: number; end: number }>;
  /** `<!-- graft:managed-comment v1 -->` occurrences in the body. */
  markerOccurrences: number;
  html: {
    present: boolean;
    userMention: boolean;
    teamMention: boolean;
    img: boolean;
    onerror: boolean;
    exampleHref: boolean;
    markdownAlert: boolean;
  };
  /** Phrases of Graft's own fixed vocabulary found in a section. */
  flags: {
    policyPlatformCodeSpan: boolean;
    policyBareTeamMention: boolean;
    policyVersionIgnored: boolean;
    provenanceNoTrailers: boolean;
    sectionInnerMarker: boolean;
  };
}

export interface PrObs {
  number: number;
  /** The head as GitHub reports it. */
  headSha: string;
  change: {
    id: string;
    headSha: string;
    graftCommentId: number | null;
    taskIssueNumber: number | null;
    state: string;
  } | null;
  provenance: ProvenanceObs | null;
  /** The newest card row for the change's current head. */
  card: CardObs | null;
  cardRowsForHead: number;
  displaysForHead: number;
  verdict: VerdictObs | null;
  checks: CheckObs[];
  comment: CommentObs;
  /** `intent_spend` of the change. */
  spend: { rows: number; tokens: number; costUsd: number; unpriced: number };
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Text between the start and end markers of a section, or "". */
function sectionText(body: string, name: string): string {
  const start = `<!-- graft:section:${name}:start -->`;
  const end = `<!-- graft:section:${name}:end -->`;
  const i = body.indexOf(start);
  const j = body.indexOf(end);
  return i >= 0 && j > i ? body.slice(i + start.length, j) : "";
}

const stripCodeSpans = (s: string): string => s.replace(/`[^`\n]*`/g, "");

export function commentObs(
  comments: readonly {
    id: number;
    body?: string | null;
    body_html?: string | null;
    updated_at?: string;
    user?: { login: string; type?: string } | null;
    performed_via_github_app?: { id: number } | null;
  }[],
  o: { appId: number; slug: string | undefined; knownId: number | null; owner: string },
): CommentObs {
  const botLogin = o.slug === undefined ? undefined : `${o.slug}[bot]`;
  const marked = comments.filter(
    (c) => (c.body ?? "").replace(/\r\n?/g, "\n").split("\n", 1)[0] === MANAGED_COMMENT_MARKER,
  );
  const ours = marked.filter((c) => isOurComment(c, { appId: o.appId, appBotLogin: botLogin }));
  const pick = ours.find((c) => c.id === o.knownId) ?? ours[0];
  const body = pick?.body ?? "";
  const html = pick?.body_html ?? "";
  const sections = [...body.matchAll(/<!-- graft:section:([a-z][a-z0-9-]*):start -->/g)].map(
    (m) => m[1] as string,
  );
  const markerCounts: CommentObs["markerCounts"] = {};
  for (const name of new Set(sections)) {
    markerCounts[name] = {
      start: countOf(body, `<!-- graft:section:${name}:start -->`),
      end: countOf(body, `<!-- graft:section:${name}:end -->`),
    };
  }
  const policy = sectionText(body, "policy");
  const provenance = sectionText(body, "provenance");
  return {
    ours: ours.map((c) => c.id),
    markerComments: marked.length,
    id: pick?.id ?? null,
    updatedAt: pick?.updated_at ?? null,
    sections,
    markerCounts,
    markerOccurrences: countOf(body, MANAGED_COMMENT_MARKER),
    html: {
      present: html !== "",
      userMention: /user-mention/.test(html),
      teamMention: /team-mention/.test(html),
      img: /<img\b/i.test(html),
      onerror: /onerror/i.test(html),
      exampleHref: /href="https:\/\/example\.invalid/.test(html),
      markdownAlert: /markdown-alert/.test(html),
    },
    flags: {
      policyPlatformCodeSpan: new RegExp(`\`@${o.owner}/platform\``, "i").test(policy),
      policyBareTeamMention: /@[\w.-]+\/platform|@platform/.test(stripCodeSpans(policy)),
      policyVersionIgnored: /Its version is ignored/.test(policy),
      provenanceNoTrailers:
        /trailers found/.test(provenance) && /no `?Graft-\*`? trailers/.test(provenance),
      sectionInnerMarker: false,
    },
  };
}

async function allPages<T>(
  octokit: GitHubClient,
  method: Parameters<GitHubClient["paginate"]>[0],
  params: Record<string, unknown>,
): Promise<T[]> {
  return (await octokit.paginate(method as never, { per_page: 100, ...params } as never)) as T[];
}

/** All Graft check runs on a head, every page, filtered by app id. */
export async function graftChecks(
  ctx: RunCtx,
  headSha: string,
  octokit: GitHubClient = ctx.actorOctokit,
): Promise<CheckObs[]> {
  const runs = (await octokit.paginate(octokit.rest.checks.listForRef, {
    owner: ctx.owner,
    repo: ctx.repo,
    ref: headSha,
    per_page: 100,
  })) as unknown as {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    completed_at?: string | null;
    app?: { id: number } | null;
    output?: { title?: string | null };
    actions?: unknown[];
  }[];
  return runs
    .filter((r) => r.app?.id === ctx.config.githubAppId)
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion ?? null,
      title: r.name === INTENT_CHECK_NAME ? null : (r.output?.title ?? null),
      completedAt: r.completed_at ?? null,
      hasActions: Array.isArray(r.actions) && r.actions.length > 0,
    }));
}

export async function prComments(ctx: RunCtx, prNumber: number, octokit = ctx.actorOctokit) {
  return allPages<{
    id: number;
    body?: string | null;
    body_html?: string | null;
    updated_at?: string;
    user?: { login: string; type?: string } | null;
    performed_via_github_app?: { id: number } | null;
  }>(octokit, octokit.rest.issues.listComments, {
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: prNumber,
    mediaType: { format: "full" },
  });
}

export async function changeRow(ctx: RunCtx, prNumber: number) {
  return ctx.db
    .selectFrom("changes as c")
    .leftJoin("tasks as t", "t.id", "c.task_id")
    .select([
      "c.id",
      "c.head_sha",
      "c.graft_comment_id",
      "c.state",
      "c.pr_number",
      "t.issue_number as task_issue",
    ])
    .where("c.repository_id", "=", ctx.repositoryId)
    .where("c.pr_number", "=", prNumber)
    .executeTakeFirst();
}

export async function observePr(ctx: RunCtx, prNumber: number): Promise<PrObs> {
  const { data: pull } = await ctx.actorOctokit.rest.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: prNumber,
  });
  const headSha = pull.head.sha;
  const ch = await changeRow(ctx, prNumber);
  const changeHead = ch?.head_sha ?? "";

  let provenance: ProvenanceObs | null = null;
  let card: CardObs | null = null;
  let cardRows = 0;
  let displays = 0;
  let verdict: VerdictObs | null = null;
  let spend = { rows: 0, tokens: 0, costUsd: 0, unpriced: 0 };
  if (ch) {
    const p = await ctx.db
      .selectFrom("change_provenance")
      .selectAll()
      .where("change_id", "=", ch.id)
      .executeTakeFirst();
    if (p) {
      provenance = {
        headSha: p.head_sha,
        authorKind: p.author_kind,
        reason: p.author_kind_reason,
        agent: p.agent,
        model: p.model,
        task: p.task_external_id,
        commitsTotal: p.commits_total,
        commitsWithTrailers: p.commits_with_trailers,
      };
    }
    const cards = await ctx.db
      .selectFrom("intent_cards")
      .selectAll()
      .where("change_id", "=", ch.id)
      .where("head_sha", "=", changeHead)
      .orderBy("created_at", "desc")
      .execute();
    cardRows = cards.length;
    const c = cards[0];
    if (c) {
      const reasons = (c.floor_reasons as { rule?: string; paths?: string[] }[]) ?? [];
      card = {
        id: c.id,
        status: c.status,
        failureReason: c.failure_reason,
        riskClass: c.risk_class,
        riskFloor: c.risk_floor,
        floorRules: reasons.map((r) => String(r.rule)),
        floorReasons: reasons.map((r) => ({ rule: String(r.rule), paths: r.paths ?? [] })),
        modelRiskClass: c.model_risk_class,
        verifierStatus: c.verifier_status,
        linkedIssue: c.linked_issue_number,
        behaviorChanges: (c.behavior_changes as string[]).length,
        outOfScopeEdits: (c.out_of_scope_edits as unknown[]).length,
        instructionsInData: c.instructions_in_data,
        writerModel: c.writer_model,
        firstPassModel: c.first_pass_model,
        verifierModel: c.verifier_model,
        createdAt: c.created_at.toISOString(),
      };
    }
    const d = await ctx.db
      .selectFrom("intent_displays as d")
      .innerJoin("intent_cards as k", "k.id", "d.card_id")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("d.change_id", "=", ch.id)
      .where("k.head_sha", "=", changeHead)
      .executeTakeFirst();
    displays = num(d?.n);
    const v = await ctx.db
      .selectFrom("policy_verdicts")
      .selectAll()
      .where("change_id", "=", ch.id)
      .where("head_sha", "=", changeHead)
      .orderBy("evaluated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (v) {
      const required = v.required as {
        humans?: number;
        constraints?: { teamCount?: number }[];
      };
      const approvals = v.approvals as { current?: number; users?: string[] };
      verdict = {
        id: v.id,
        headSha: v.head_sha,
        policyStatus: v.policy_status,
        policyCommitSha: v.policy_commit_sha,
        policyHash: v.policy_hash,
        outcome: v.outcome,
        riskClass: v.risk_class,
        riskFinal: v.risk_final,
        riskSource: v.risk_source,
        policyFileChanged: v.policy_file_changed,
        humans: typeof required.humans === "number" ? required.humans : null,
        teamConstraints: (required.constraints ?? []).filter((c) => (c.teamCount ?? 0) > 0).length,
        approvalsCurrent: approvals.current ?? 0,
        approvalUsers: approvals.users ?? [],
        publishedAt: v.published_at?.toISOString() ?? null,
        evaluatedAt: v.evaluated_at.toISOString(),
      };
    }
    const s = await ctx.db
      .selectFrom("intent_spend")
      .select([
        sql<string>`count(*)`.as("rows"),
        sql<string>`coalesce(sum(tokens), 0)`.as("tokens"),
        sql<string>`coalesce(sum(cost_usd), 0)`.as("cost"),
        sql<string>`count(*) filter (where cost_usd is null)`.as("unpriced"),
      ])
      .where("change_id", "=", ch.id)
      .executeTakeFirst();
    spend = {
      rows: num(s?.rows),
      tokens: num(s?.tokens),
      costUsd: num(s?.cost),
      unpriced: num(s?.unpriced),
    };
  }
  const checks = await graftChecks(ctx, headSha);
  const comments = await prComments(ctx, prNumber);
  const comment = commentObs(comments, {
    appId: ctx.config.githubAppId,
    slug: ctx.config.githubAppSlug,
    knownId: ch?.graft_comment_id ?? null,
    owner: ctx.owner,
  });
  return {
    number: prNumber,
    headSha,
    change: ch
      ? {
          id: ch.id,
          headSha: ch.head_sha,
          graftCommentId: ch.graft_comment_id,
          taskIssueNumber: ch.task_issue,
          state: ch.state,
        }
      : null,
    provenance,
    card,
    cardRowsForHead: cardRows,
    displaysForHead: displays,
    verdict,
    checks,
    comment,
    spend,
  };
}

/** The PR's own body rendered as HTML (the s04 control). */
export async function prBodyHtml(ctx: RunCtx, prNumber: number): Promise<string> {
  const res = await ctx.actorOctokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: prNumber,
    mediaType: { format: "full" },
  });
  return String((res.data as { body_html?: string }).body_html ?? "");
}

/** Webhook deliveries Graft recorded for the sandbox installation. */
export async function deliveryCount(
  ctx: RunCtx,
  f: { event: string; action?: string },
): Promise<number> {
  let q = ctx.db
    .selectFrom("webhook_deliveries")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("installation_id", "=", ctx.installationId)
    .where("event", "=", f.event);
  if (f.action !== undefined) q = q.where("action", "=", f.action);
  const row = await q.executeTakeFirst();
  return num(row?.n);
}
