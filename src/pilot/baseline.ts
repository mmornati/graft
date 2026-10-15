/**
 * Review-time baseline and shadow extraction (step 6, T8, §8.2, D3, D4).
 *
 * Reads historical PRs, their timelines and commits through the GitHub API, computes per-PR NUMBERS
 * (minutes, rounds, flags, size bucket, author kind) and aggregates them, then writes one run and its
 * rows in a single transaction. Nothing else is kept: no titles, bodies, paths, logins (not even
 * hashed) or SHAs. Titles and bodies are read in memory only (the body for the provenance
 * classifier) and never logged or printed.
 */
import { sql } from "kysely";
import { z } from "zod";
import type { Config } from "../config/index.js";
import { sizeBucket } from "../core/size.js";
import type { Db } from "../db/client.js";
import type { GitHubClient, GitHubClientFactory } from "../github/client-factory.js";
import { installRateLimit, RateLimitAbort } from "../github/rate-limit.js";
import { computeProvenance, fetchPrCommits } from "../modules/provenance/index.js";
import { summarize } from "./stats.js";
import { type PrReviewTimes, reviewTimes, type TimelineEvent } from "./timeline.js";

export const EXTRACTOR_VERSION = 1;
export const MAX_TIMELINE_PAGES = 10;
const DAY_MS = 86_400_000;

export type Period = "baseline" | "shadow";
export type AuthorKind = "agent" | "human";
export type Bucket = "S" | "M" | "L" | "XL";
export type ExcludedReason = "excluded_author" | "timeline_truncated" | "commits_truncated";

export interface PrRow {
  prNumber: number;
  state: "merged" | "closed" | "open";
  authorKind: AuthorKind;
  authorKindReason: string;
  sizeBucket: Bucket;
  startBasis: PrReviewTimes["startBasis"];
  minutesToFirstApproval: number | null;
  minutesToMerge: number | null;
  reviewRounds: number;
  mergedWithoutReview: boolean;
  pausedMinutes: number;
  excludedReason: ExcludedReason | null;
}

const summarySchema = z.object({
  n: z.number().int().min(0),
  p50: z.number().nullable(),
  p75: z.number().nullable(),
  p90: z.number().nullable(),
});
const groupSchema = z.object({
  prs: z.number().int().min(0),
  merged: z.number().int().min(0),
  mergedWithoutReview: z.number().int().min(0),
  open: z.number().int().min(0),
  firstApproval: summarySchema,
  merge: summarySchema,
  rounds: summarySchema,
});
export type GroupAggregate = z.infer<typeof groupSchema>;

/** Group keys: `all`, `agent`, `human` and `agent:S` ... `human:XL`. */
export type GroupKey = "all" | AuthorKind | `${AuthorKind}:${Bucket}`;
export const GROUP_KEYS: readonly GroupKey[] = [
  "all",
  "agent",
  "human",
  ...(["agent", "human"] as const).flatMap((k) =>
    (["S", "M", "L", "XL"] as const).map((b): GroupKey => `${k}:${b}`),
  ),
];

export const aggregatesSchema = z.object(
  Object.fromEntries(GROUP_KEYS.map((k) => [k, groupSchema])) as Record<
    GroupKey,
    typeof groupSchema
  >,
);
export type Aggregates = Record<GroupKey, GroupAggregate>;

function aggregateGroup(rows: readonly PrRow[]): GroupAggregate {
  const merged = rows.filter((r) => r.state === "merged");
  return {
    prs: rows.length,
    merged: merged.length,
    mergedWithoutReview: merged.filter((r) => r.mergedWithoutReview).length,
    open: rows.filter((r) => r.state === "open").length,
    firstApproval: summarize(
      rows.flatMap((r) => (r.minutesToFirstApproval === null ? [] : [r.minutesToFirstApproval])),
    ),
    merge: summarize(rows.flatMap((r) => (r.minutesToMerge === null ? [] : [r.minutesToMerge]))),
    rounds: summarize(merged.map((r) => r.reviewRounds)),
  };
}

/** Excluded rows are in no group (§8.2.6). */
export function aggregate(rows: readonly PrRow[]): Aggregates {
  const kept = rows.filter((r) => r.excludedReason === null);
  const out = {} as Record<GroupKey, GroupAggregate>;
  for (const key of GROUP_KEYS) {
    const [kind, bucket] = key.split(":");
    out[key] = aggregateGroup(
      kept.filter(
        (r) =>
          (kind === "all" || r.authorKind === kind) &&
          (bucket === undefined || r.sizeBucket === bucket),
      ),
    );
  }
  return out;
}

/** A cell with fewer than 5 observations is shown as `n<5` in markdown (JSON keeps the value). */
export const cell = (n: number, value: number | null): string =>
  n < 5 ? "n<5" : value === null ? "-" : String(value);

export function renderAggregates(a: Aggregates): string {
  const lines = [
    "group      PRs  merged  no-review  open  1st approval p50/p90 (min)  merge p50/p90 (min)  rounds p50",
  ];
  for (const key of GROUP_KEYS) {
    const g = a[key];
    lines.push(
      [
        key.padEnd(9),
        String(g.prs).padStart(4),
        String(g.merged).padStart(7),
        String(g.mergedWithoutReview).padStart(10),
        String(g.open).padStart(5),
        `${cell(g.firstApproval.n, g.firstApproval.p50)}/${cell(g.firstApproval.n, g.firstApproval.p90)}`.padStart(
          27,
        ),
        `${cell(g.merge.n, g.merge.p50)}/${cell(g.merge.n, g.merge.p90)}`.padStart(21),
        cell(g.rounds.n, g.rounds.p50).padStart(11),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

export class BaselineUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineUsageError";
  }
}

export interface BaselineOptions {
  repo: string;
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, exclusive. */
  to: string;
  period: Period;
  /** Default: the repository's default branch. */
  base?: string | undefined;
  maxRequests: number;
  maxWaitMs: number;
  dryRun: boolean;
}

export interface BaselineDeps {
  db: Db;
  github: GitHubClientFactory;
  config: Pick<Config, "agentLogins" | "agentCoauthorEmails" | "metricsExcludedAuthors">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log?: { info(o: object, msg: string): void };
  onWait?: (ms: number) => void;
}

export interface BaselineResult {
  runId: string | null;
  repositoryId: number;
  prCount: number;
  excludedCount: number;
  requests: number;
  aggregates: Aggregates;
  rows: PrRow[];
}

const parseDay = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** Normalizes one API timeline event; unknown kinds return null. */
export function normalizeEvent(e: Record<string, unknown>): TimelineEvent | null {
  const kind = e.event;
  const at = (typeof e.submitted_at === "string" ? e.submitted_at : e.created_at) as unknown;
  if (typeof at !== "string") return null;
  const actor = (v: unknown): { login: string; type: string } | null => {
    if (v === null || typeof v !== "object") return null;
    const o = v as { login?: unknown; type?: unknown };
    return typeof o.login === "string"
      ? { login: o.login, type: typeof o.type === "string" ? o.type : "User" }
      : null;
  };
  switch (kind) {
    case "review_requested":
      return {
        kind,
        at,
        reviewer: actor(e.requested_reviewer),
        team: e.requested_team !== undefined && e.requested_team !== null,
      };
    case "ready_for_review":
    case "convert_to_draft":
    case "closed":
    case "reopened":
    case "merged":
      return { kind, at };
    case "reviewed":
      return {
        kind,
        at,
        user: actor(e.user),
        state: typeof e.state === "string" ? e.state : "commented",
        commitId: typeof e.commit_id === "string" ? e.commit_id : null,
      };
    default:
      return null;
  }
}

async function fetchTimeline(
  octokit: GitHubClient,
  o: { owner: string; repo: string; prNumber: number },
): Promise<{ events: TimelineEvent[]; truncated: boolean }> {
  const events: TimelineEvent[] = [];
  let pages = 0;
  let truncated = false;
  const it = octokit.paginate.iterator(octokit.rest.issues.listEventsForTimeline, {
    owner: o.owner,
    repo: o.repo,
    issue_number: o.prNumber,
    per_page: 100,
  });
  for await (const page of it) {
    for (const raw of page.data) {
      const ev = normalizeEvent(raw as unknown as Record<string, unknown>);
      if (ev) events.push(ev);
    }
    pages++;
    if (pages >= MAX_TIMELINE_PAGES) {
      truncated = /rel="next"/.test(String((page.headers as { link?: string }).link ?? ""));
      break;
    }
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { events, truncated };
}

export async function runBaseline(
  deps: BaselineDeps,
  opts: BaselineOptions,
): Promise<BaselineResult> {
  const from = parseDay(opts.from);
  const to = parseDay(opts.to);
  if (!(to.getTime() > from.getTime())) throw new BaselineUsageError("--to must be after --from");

  const repoRow = await deps.db
    .selectFrom("repositories")
    .select(["id", "installation_id", "full_name", "default_branch"])
    .where(sql<string>`lower(full_name)`, "=", opts.repo.toLowerCase())
    .where("removed_at", "is", null)
    .executeTakeFirst();
  if (!repoRow) throw new BaselineUsageError("repository not found (is the App installed on it?)");
  const [owner = "", repo = ""] = repoRow.full_name.split("/");

  const octokit = await deps.github.forInstallation(repoRow.installation_id);
  const limit = installRateLimit(octokit, {
    sleep: deps.sleep,
    now: deps.now,
    minRemaining: 100,
    maxWaitMs: opts.maxWaitMs,
    maxRequests: opts.maxRequests,
    ...(deps.onWait ? { onWait: deps.onWait } : {}),
  });

  let baseRef = opts.base ?? repoRow.default_branch ?? null;
  if (baseRef === null) {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    baseRef = data.default_branch;
  }

  const excludedAuthors = new Set(deps.config.metricsExcludedAuthors.map((l) => l.toLowerCase()));
  const agentLogins = deps.config.agentLogins.map((l) => l.toLowerCase());
  const rows: PrRow[] = [];

  const listing = octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "all",
    sort: "created",
    direction: "desc",
    per_page: 100,
  });
  const candidates: number[] = [];
  list: for await (const page of listing) {
    for (const p of page.data) {
      const created = Date.parse(p.created_at);
      if (created < from.getTime()) break list; // sorted by creation, newest first
      if (created >= to.getTime()) continue;
      if (p.base.ref !== baseRef) continue;
      candidates.push(p.number);
    }
  }

  const now = new Date(deps.now());
  for (const number of candidates) {
    const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
    const login = pull.user?.login ?? "ghost";
    const state: PrRow["state"] = pull.merged_at
      ? "merged"
      : pull.state === "open"
        ? "open"
        : "closed";
    const bucket = sizeBucket((pull.additions ?? 0) + (pull.deletions ?? 0));
    const base = { prNumber: number, state, sizeBucket: bucket };
    if (excludedAuthors.has(login.toLowerCase())) {
      rows.push({
        ...base,
        authorKind: "human",
        authorKindReason: "none",
        startBasis: "opened",
        minutesToFirstApproval: null,
        minutesToMerge: null,
        reviewRounds: 0,
        mergedWithoutReview: false,
        pausedMinutes: 0,
        excludedReason: "excluded_author",
      });
      continue;
    }
    const { commits, truncated: commitsTruncated } = await fetchPrCommits(octokit, {
      owner,
      repo,
      prNumber: number,
      headSha: pull.head.sha,
      commitsTotal: pull.commits ?? 0,
    });
    const prov = computeProvenance({
      commits,
      commitsTotal: pull.commits ?? commits.length,
      truncated: commitsTruncated,
      prBody: pull.body ?? null,
      prAuthor: pull.user ?? { login: "ghost", type: "User" },
      agentLogins: deps.config.agentLogins,
      agentCoauthorEmails: deps.config.agentCoauthorEmails,
    });
    const tl = await fetchTimeline(octokit, { owner, repo, prNumber: number });
    if (tl.truncated) {
      rows.push({
        ...base,
        authorKind: prov.authorKind,
        authorKindReason: prov.authorKindReason,
        startBasis: "opened",
        minutesToFirstApproval: null,
        minutesToMerge: null,
        reviewRounds: 0,
        mergedWithoutReview: false,
        pausedMinutes: 0,
        excludedReason: "timeline_truncated",
      });
      continue;
    }
    const t = reviewTimes({
      createdAt: pull.created_at,
      mergedAt: pull.merged_at ?? null,
      closedAt: pull.closed_at ?? null,
      draftNow: pull.draft === true,
      authorLogin: login,
      now,
      events: tl.events,
      excludedReviewerLogins: agentLogins,
    });
    rows.push({
      ...base,
      authorKind: prov.authorKind,
      authorKindReason: prov.authorKindReason,
      startBasis: t.startBasis,
      minutesToFirstApproval: t.minutesToFirstApproval,
      minutesToMerge: t.minutesToMerge,
      reviewRounds: t.reviewRounds,
      mergedWithoutReview: t.mergedWithoutReview,
      pausedMinutes: t.pausedMinutes,
      excludedReason: null,
    });
  }

  rows.sort((a, b) => a.prNumber - b.prNumber);
  const aggregates = aggregate(rows);
  const excludedCount = rows.filter((r) => r.excludedReason !== null).length;
  const requests = limit.requests();
  const result: BaselineResult = {
    runId: null,
    repositoryId: repoRow.id,
    prCount: rows.length,
    excludedCount,
    requests,
    aggregates,
    rows,
  };
  deps.log?.info({ prs: rows.length, excluded: excludedCount, requests }, "baseline extracted");
  if (opts.dryRun) return result;

  // Written only now, after every request succeeded: an abort leaves no partial run behind.
  const runId = await deps.db.transaction().execute(async (tx) => {
    const run = await tx
      .insertInto("review_time_runs")
      .values({
        repository_id: repoRow.id,
        period: opts.period,
        from_date: opts.from,
        to_date: opts.to,
        base_ref: baseRef as string,
        extractor_version: EXTRACTOR_VERSION,
        pr_count: rows.length,
        excluded_count: excludedCount,
        aggregates: JSON.stringify(aggregatesSchema.parse(aggregates) satisfies Aggregates),
        requests,
        extracted_at: now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      if (chunk.length === 0) continue;
      await tx
        .insertInto("review_time_prs")
        .values(
          chunk.map((r) => ({
            run_id: run.id,
            pr_number: r.prNumber,
            state: r.state,
            author_kind: r.authorKind,
            author_kind_reason: r.authorKindReason,
            size_bucket: r.sizeBucket,
            start_basis: r.startBasis,
            minutes_to_first_approval: r.minutesToFirstApproval,
            minutes_to_merge: r.minutesToMerge,
            review_rounds: r.reviewRounds,
            merged_without_review: r.mergedWithoutReview,
            paused_minutes: r.pausedMinutes,
            excluded_reason: r.excludedReason,
          })),
        )
        .execute();
    }
    return run.id;
  });
  return { ...result, runId };
}

export { RateLimitAbort };
export const DAY = DAY_MS;
