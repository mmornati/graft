/**
 * Export of merged agent PRs into an encrypted pilot set (E9 to E16, T9). Two stages: stage 1
 * keeps paths and counts only; stage 2 fetches the diffs of the sampled PRs, redacts, seals.
 * Titles, bodies, paths and diffs are never printed.
 */
import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { createGitHubClientFactory, type GitHubClient } from "../github/client-factory.js";
import { classifyGitHubError } from "../github/errors.js";
import type { LivePull } from "../modules/changes/index.js";
import { type ChangedFile, fetchIntentInputs } from "../modules/intent/index.js";
import {
  computeProvenance,
  fetchPrCommits,
  type ProvenanceResult,
} from "../modules/provenance/index.js";
import type { EvalCase } from "./case-schema.js";
import { EvalAbort, installRateLimit, type RateLimitStats } from "./rate-limit.js";
import { type RedactOptions, redactInputs } from "./redact.js";
import { type PathStratum, pathStratum, type SizeStratum, sample, sizeStratum } from "./sample.js";
import { type CaseSet, EvalStoreError, listCaseIds, writeCase } from "./store.js";

export type AuthorFilter = "agent" | "bot" | "any";

export interface ExportOptions {
  set: CaseSet;
  repo: string;
  /** Inclusive, UTC. */
  from: Date;
  /** Exclusive upper bound (the day after `--to`). */
  toExclusive: Date;
  author: AuthorFilter;
  agentLogins: readonly string[];
  agentCoauthorEmails: readonly string[];
  sample: number;
  minPerStratum: number;
  maxCandidates: number;
  seed: number;
  redact: RedactOptions;
  dryRun: boolean;
  octokit: GitHubClient;
  now: () => Date;
  /** Ids, strata and counts only. */
  out: (line: string) => void;
  /** Called with the stage-1 candidates (tests assert they hold no diff text). */
  onStage1?: (candidates: readonly Stage1Candidate[]) => void;
}

export interface Stage1Candidate {
  repository: string;
  prNumber: number;
  size: SizeStratum;
  path: PathStratum;
  changedLines: number;
  pull: LivePull;
  /** Paths and counts only: the patches were discarded at once. */
  files: {
    path: string;
    previousPath: string | null;
    status: string;
    additions: number;
    deletions: number;
  }[];
  provenance: ProvenanceResult;
}

export interface ExportSummary {
  listed: number;
  candidates: number;
  existing: number;
  classified: number;
  agentPrs: number;
  sampled: number;
  exported: number;
  skippedNotFound: number;
  strata: Record<string, { size: number; picked: number }>;
  dryRun: boolean;
}

/** Another GitHub error: the run stops after writing what was done. */
export class ExportError extends Error {
  constructor(
    message: string,
    readonly summary: ExportSummary,
  ) {
    super(message);
    this.name = "ExportError";
  }
}

const MAX_FILE_PAGES = 30;

export function caseIdFor(setId: string, repoName: string, prNumber: number): string {
  const name = repoName
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 40);
  return `${setId}--${name}-${prNumber}`;
}

function parseTaskIssue(value: string | undefined): number | null {
  const m = value === undefined ? null : /^#(\d{1,9})$/.exec(value.trim());
  return m ? Number(m[1]) : null;
}

export async function exportPrs(o: ExportOptions): Promise<ExportSummary> {
  const { set } = o;
  if (set.meta.kind !== "pilot" || !set.meta.consentRef || set.meta.consentRef.trim() === "") {
    throw new EvalStoreError(
      "this set has no consent reference: create it with --consent-ref (HUMAN-TODO: pilot consent)",
    );
  }
  const [owner = "", repoName = ""] = o.repo.split("/");
  if (!owner || !repoName) throw new EvalStoreError("--repo must be owner/name");

  const summary: ExportSummary = {
    listed: 0,
    candidates: 0,
    existing: 0,
    classified: 0,
    agentPrs: 0,
    sampled: 0,
    exported: 0,
    skippedNotFound: 0,
    strata: {},
    dryRun: o.dryRun,
  };
  const fail = (err: unknown, what: string): never => {
    throw new ExportError(`GitHub request failed (${what}): ${classifyGitHubError(err)}`, summary);
  };

  // List: closed PRs, most recently updated first, until updated_at < from.
  const existingIds = new Set(await listCaseIds(set));
  const wanted: LivePull[] = [];
  try {
    const it = o.octokit.paginate.iterator(o.octokit.rest.pulls.list, {
      owner,
      repo: repoName,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });
    outer: for await (const page of it) {
      for (const pr of page.data) {
        summary.listed += 1;
        if (new Date(pr.updated_at) < o.from) break outer;
        const mergedAt = pr.merged_at ? new Date(pr.merged_at) : null;
        if (!mergedAt || mergedAt < o.from || mergedAt >= o.toExclusive) continue;
        if (wanted.length >= o.maxCandidates) break outer;
        wanted.push(pr as unknown as LivePull);
      }
    }
  } catch (err) {
    if (err instanceof EvalAbort) throw err;
    return fail(err, "list pull requests");
  }
  summary.candidates = wanted.length;

  // Skip what already exists (resume), and count it toward the sample size.
  const fresh = wanted.filter((p) => {
    const have = existingIds.has(caseIdFor(set.meta.setId, repoName, p.number));
    if (have) summary.existing += 1;
    return !have;
  });
  const target = Math.max(0, o.sample - summary.existing);

  // Stage 1: classification and strata, paths and counts only.
  const stage1: Stage1Candidate[] = [];
  const isBotListed = (p: LivePull): boolean =>
    p.user?.type === "Bot" ||
    o.agentLogins.some((l) => l.toLowerCase() === (p.user?.login ?? "").toLowerCase());
  for (const listed of fresh) {
    if (o.author === "bot" && !isBotListed(listed)) continue;
    let pull: LivePull;
    try {
      pull = (await o.octokit.rest.pulls.get({ owner, repo: repoName, pull_number: listed.number }))
        .data as unknown as LivePull;
    } catch (err) {
      if (err instanceof EvalAbort) throw err;
      if (classifyGitHubError(err) === "not_found") {
        summary.skippedNotFound += 1;
        continue;
      }
      return fail(err, "get pull request");
    }
    summary.classified += 1;

    let commits: { sha: string; message: string }[] = [];
    let truncated = false;
    try {
      if (o.author !== "bot") {
        const r = await fetchPrCommits(o.octokit, {
          owner,
          repo: repoName,
          prNumber: pull.number,
          headSha: pull.head.sha,
          commitsTotal: pull.commits,
        });
        commits = r.commits;
        truncated = r.truncated;
      }
    } catch (err) {
      if (err instanceof EvalAbort) throw err;
      if (classifyGitHubError(err) === "not_found") {
        summary.skippedNotFound += 1;
        continue;
      }
      return fail(err, "list commits");
    }
    const provenance = computeProvenance({
      commits,
      commitsTotal: pull.commits,
      truncated,
      prBody: pull.body,
      prAuthor: { login: pull.user?.login ?? "ghost", type: pull.user?.type ?? "User" },
      agentLogins: o.agentLogins,
      agentCoauthorEmails: o.agentCoauthorEmails,
    });
    if (o.author === "agent" && provenance.authorKind !== "agent") continue;

    const changedLines = pull.additions + pull.deletions;
    const files: Stage1Candidate["files"] = [];
    if (changedLines <= 20_000 && pull.changed_files <= 1_000) {
      try {
        const it = o.octokit.paginate.iterator(o.octokit.rest.pulls.listFiles, {
          owner,
          repo: repoName,
          pull_number: pull.number,
          per_page: 100,
        });
        let pages = 0;
        for await (const page of it) {
          // The patch is dropped here: stage 1 keeps paths and counts only.
          for (const f of page.data) {
            files.push({
              path: f.filename,
              previousPath: f.previous_filename ?? null,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            });
          }
          if (++pages >= MAX_FILE_PAGES) break;
        }
      } catch (err) {
        if (err instanceof EvalAbort) throw err;
        if (classifyGitHubError(err) === "not_found") {
          summary.skippedNotFound += 1;
          continue;
        }
        return fail(err, "list files");
      }
    }
    stage1.push({
      repository: pull.base.repo.full_name,
      prNumber: pull.number,
      size: sizeStratum(changedLines),
      path: pathStratum(
        files.map((f) => ({ ...f, status: f.status as ChangedFile["status"] })),
        set.meta.defaultFloorConfig,
      ),
      changedLines,
      pull,
      files,
      provenance,
    });
  }
  summary.agentPrs = stage1.length;
  o.onStage1?.(stage1);

  const { picked, strata } = sample(stage1, {
    n: target,
    minPerStratum: o.minPerStratum,
    seed: o.seed,
  });
  summary.sampled = picked.length;
  summary.strata = strata;

  if (o.dryRun) {
    o.out(
      `dry run: ${summary.listed} listed, ${summary.candidates} merged in range, ${summary.existing} already exported`,
    );
    for (const [k, v] of Object.entries(strata)) {
      o.out(`stratum ${k}: ${v.size} candidates, ${v.picked} sampled`);
    }
    o.out(`would export PRs: ${picked.map((p) => `#${p.prNumber}`).join(", ") || "(none)"}`);
    return summary;
  }

  // Stage 2: diffs of the sampled PRs only.
  for (const c of picked) {
    const pull = c.pull;
    const taskIssueNumber = parseTaskIssue(c.provenance.fields.task?.value);
    let raw: Awaited<ReturnType<typeof fetchIntentInputs>>;
    try {
      raw = await fetchIntentInputs(o.octokit, { owner, repo: repoName, pull, taskIssueNumber });
    } catch (err) {
      if (err instanceof EvalAbort) throw err;
      if (classifyGitHubError(err) === "not_found") {
        summary.skippedNotFound += 1;
        continue;
      }
      return fail(err, "fetch inputs");
    }
    const { inputs, redactions } = redactInputs(raw, o.redact);
    const id = caseIdFor(set.meta.setId, repoName, pull.number);
    const prov = c.provenance;
    const evalCase: EvalCase = {
      schemaVersion: 1,
      id,
      source: {
        kind: "pilot",
        setId: set.meta.setId,
        repository: pull.base.repo.full_name,
        prNumber: pull.number,
        headSha: pull.head.sha,
        baseSha: pull.base.sha ?? "0".repeat(40),
        mergedAt: pull.merged_at as string,
        exportedAt: o.now().toISOString(),
        exportTool: "graft-eval-export/1",
        authorKind: prov.authorKind,
        authorKindReason: prov.authorKindReason,
        agent: prov.fields.agent?.value ?? null,
        model: prov.fields.model?.value ?? null,
        redactions,
      },
      tags: [`size-${c.size.toLowerCase()}`, `path-${c.path}`],
      floorConfig: { extraSensitiveGlobs: [...set.meta.defaultFloorConfig.extraSensitiveGlobs] },
      inputs,
      labels: [],
      adjudicated: null,
      fakeLlm: null,
    };
    await writeCase(set, evalCase);
    summary.exported += 1;
    o.out(
      `exported ${id} (${c.size}/${c.path}, redactions: ${redactions.reduce((n, r) => n + r.count, 0)})`,
    );
  }
  return summary;
}

export interface ExportClientOptions {
  auth: "app" | "token";
  installationId?: number;
  env: {
    GITHUB_APP_ID?: number | undefined;
    GITHUB_APP_PRIVATE_KEY_PATH?: string | undefined;
    GITHUB_API_URL: string;
    GRAFT_EVAL_GITHUB_TOKEN?: string | undefined;
  };
  fetch?: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  minRemaining: number;
  maxWaitMs: number;
  maxRequests: number;
  onWait?: (ms: number) => void;
}

/** E16: the App's installation token by default, a read-only token otherwise. */
export async function buildExportClient(
  o: ExportClientOptions,
): Promise<{ octokit: GitHubClient; stats: RateLimitStats }> {
  let octokit: GitHubClient;
  if (o.auth === "token") {
    if (!o.env.GRAFT_EVAL_GITHUB_TOKEN) {
      throw new EvalStoreError("GRAFT_EVAL_GITHUB_TOKEN is required with --auth token");
    }
    octokit = new Octokit({
      auth: o.env.GRAFT_EVAL_GITHUB_TOKEN,
      baseUrl: o.env.GITHUB_API_URL,
      ...(o.fetch ? { request: { fetch: o.fetch } } : {}),
    });
  } else {
    if (!o.env.GITHUB_APP_ID || !o.env.GITHUB_APP_PRIVATE_KEY_PATH || !o.installationId) {
      throw new EvalStoreError(
        "--auth app needs --installation-id, GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH",
      );
    }
    const factory = createGitHubClientFactory({
      appId: o.env.GITHUB_APP_ID,
      privateKey: readFileSync(o.env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8"),
      baseUrl: o.env.GITHUB_API_URL,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    octokit = await factory.forInstallation(o.installationId);
  }
  const stats = installRateLimit(octokit, {
    sleep: o.sleep,
    now: o.nowMs,
    minRemaining: o.minRemaining,
    maxWaitMs: o.maxWaitMs,
    maxRequests: o.maxRequests,
    ...(o.onWait ? { onWait: o.onWait } : {}),
  });
  return { octokit, stats };
}
