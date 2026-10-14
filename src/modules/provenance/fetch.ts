import type { GitHubClient } from "../../github/client-factory.js";
import type { CommitInput } from "./compute.js";

const MAX_PAGES = 3;

/**
 * Commit messages of a PR, oldest first (API order). The API returns at most 250; when the PR has
 * more, the head commit (which matters most for precedence) is fetched on its own.
 * Messages stay in memory; nothing else is read from the response. Errors propagate unchanged.
 */
export async function fetchPrCommits(
  octokit: GitHubClient,
  o: { owner: string; repo: string; prNumber: number; headSha: string; commitsTotal: number },
): Promise<{ commits: CommitInput[]; truncated: boolean }> {
  const commits: CommitInput[] = [];
  let pages = 0;
  const it = octokit.paginate.iterator(octokit.rest.pulls.listCommits, {
    owner: o.owner,
    repo: o.repo,
    pull_number: o.prNumber,
    per_page: 100,
  });
  for await (const page of it) {
    for (const c of page.data) commits.push({ sha: c.sha, message: c.commit.message });
    if (++pages >= MAX_PAGES) break;
  }
  const truncated = o.commitsTotal > commits.length;
  if (truncated && !commits.some((c) => c.sha === o.headSha)) {
    const { data } = await octokit.rest.git.getCommit({
      owner: o.owner,
      repo: o.repo,
      commit_sha: o.headSha,
    });
    commits.push({ sha: data.sha, message: data.message });
  }
  return { commits, truncated };
}
