import type { GitHubClient } from "../../github/client-factory.js";
import { classifyGitHubError } from "../../github/errors.js";
import type { LivePull } from "../changes/index.js";
import { type CardInputs, type ChangedFile, findLinkedIssue } from "./inputs.js";
import { classifyFile } from "./risk-floor.js";

const MAX_FILE_PAGES = 30;
const MAX_ADDITIONS_PLUS_DELETIONS = 20_000;
const MAX_CHANGED_FILES = 1_000;
/** Head versions read for the verifier's context (intent-v2). */
const MAX_CONTEXT_FILES = 20;
const MAX_CONTEXT_FILE_BYTES = 200_000;
const CONTEXT_CONCURRENCY = 5;
const CONTEXT_STATUSES: ReadonlySet<ChangedFile["status"]> = new Set([
  "modified",
  "renamed",
  "copied",
  "changed",
]);

/**
 * Reads everything the writer needs from GitHub. Diff text stays in memory: nothing here logs
 * or stores a title, body, path or patch.
 */
export async function fetchIntentInputs(
  octokit: GitHubClient,
  o: { owner: string; repo: string; pull: LivePull; taskIssueNumber: number | null },
): Promise<CardInputs> {
  const { owner, repo, pull } = o;
  const body = pull.body ?? "";
  const linked = findLinkedIssue(body, {
    owner,
    repo,
    prNumber: pull.number,
    taskIssueNumber: o.taskIssueNumber,
  });

  let issue: CardInputs["issue"] = null;
  if (linked) {
    try {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: linked.number });
      if (!("pull_request" in data && data.pull_request)) {
        issue = { number: linked.number, title: data.title, body: data.body ?? "" };
      }
    } catch (err) {
      const cls = classifyGitHubError(err);
      if (cls !== "not_found" && cls !== "forbidden") throw err;
    }
  }

  const base = {
    repositoryFullName: pull.base.repo.full_name,
    pr: {
      number: pull.number,
      title: pull.title,
      body,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changed_files,
    },
    issue,
  };

  if (
    pull.additions + pull.deletions > MAX_ADDITIONS_PLUS_DELETIONS ||
    pull.changed_files > MAX_CHANGED_FILES
  ) {
    return { ...base, files: [], listingTruncated: true, tooLarge: true };
  }

  const files: ChangedFile[] = [];
  let pages = 0;
  const it = octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pull.number,
    per_page: 100,
  });
  for await (const page of it) {
    for (const f of page.data) {
      files.push({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
        headText: null,
      });
    }
    if (++pages >= MAX_FILE_PAGES) break;
  }
  await attachHeadText(octokit, { owner, repo, ref: pull.head.sha }, files);
  return {
    ...base,
    files,
    listingTruncated: files.length < pull.changed_files,
    tooLarge: false,
  };
}

/**
 * Reads the head version of up to 20 changed files so the verifier can see code the patch's
 * three lines of context leave out (where a flag is set, what a called function does). Added
 * files are skipped: their patch is the whole file. A file that is missing, not a regular file,
 * too large or not text keeps `headText: null`; any other error is thrown like the listing's.
 */
async function attachHeadText(
  octokit: GitHubClient,
  o: { owner: string; repo: string; ref: string },
  files: ChangedFile[],
): Promise<void> {
  const wanted = files
    .filter((f) => CONTEXT_STATUSES.has(f.status) && classifyFile(f) === "candidate")
    .slice(0, MAX_CONTEXT_FILES);
  for (let i = 0; i < wanted.length; i += CONTEXT_CONCURRENCY) {
    await Promise.all(
      wanted.slice(i, i + CONTEXT_CONCURRENCY).map(async (f) => {
        f.headText = await readHeadText(octokit, { ...o, path: f.path });
      }),
    );
  }
}

async function readHeadText(
  octokit: GitHubClient,
  o: { owner: string; repo: string; ref: string; path: string },
): Promise<string | null> {
  let data: unknown;
  try {
    ({ data } = await octokit.rest.repos.getContent(o));
  } catch (err) {
    const cls = classifyGitHubError(err);
    if (cls === "not_found" || cls === "forbidden") return null;
    throw err;
  }
  if (Array.isArray(data)) return null;
  const f = (data ?? {}) as Record<string, unknown>;
  if (f.type !== "file" || f.path !== o.path) return null;
  if (typeof f.size !== "number" || f.size > MAX_CONTEXT_FILE_BYTES) return null;
  if (f.encoding !== "base64" || typeof f.content !== "string") return null;
  const bytes = Buffer.from(f.content, "base64");
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}
