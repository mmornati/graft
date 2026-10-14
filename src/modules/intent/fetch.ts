import type { GitHubClient } from "../../github/client-factory.js";
import { classifyGitHubError } from "../../github/errors.js";
import type { LivePull } from "../changes/index.js";
import { type CardInputs, type ChangedFile, findLinkedIssue } from "./inputs.js";

const MAX_FILE_PAGES = 30;
const MAX_ADDITIONS_PLUS_DELETIONS = 20_000;
const MAX_CHANGED_FILES = 1_000;

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
      });
    }
    if (++pages >= MAX_FILE_PAGES) break;
  }
  return {
    ...base,
    files,
    listingTruncated: files.length < pull.changed_files,
    tooLarge: false,
  };
}
