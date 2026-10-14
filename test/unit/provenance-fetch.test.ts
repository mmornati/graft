import { describe, expect, it } from "vitest";
import { fetchPrCommits } from "../../src/modules/provenance/fetch.js";
import { fakeGitHubFactory } from "../helpers/app.js";
import { createFakeGitHubApi } from "../helpers/fake-github-api.js";
import { fakeSha, makeCommit, OWNER, PR_NUMBER, REPO } from "../helpers/github-builders.js";

async function setup(n: number, total = n) {
  const api = createFakeGitHubApi();
  api.state.commits.set(
    PR_NUMBER,
    Array.from({ length: n }, (_, i) => makeCommit(fakeSha(i + 1), `message ${i + 1}`)),
  );
  const client = await fakeGitHubFactory(api).forInstallation(1);
  return { api, client, total };
}
const args = (headSha: string, commitsTotal: number) => ({
  owner: OWNER,
  repo: REPO,
  prNumber: PR_NUMBER,
  headSha,
  commitsTotal,
});

describe("fetchPrCommits", () => {
  it("U-FETCH-1 130 commits take two pages, keep order, are not truncated and need no git/commits call", async () => {
    const { api, client } = await setup(130);
    const r = await fetchPrCommits(client, args(fakeSha(130), 130));
    expect(r.truncated).toBe(false);
    expect(r.commits).toHaveLength(130);
    expect(r.commits.map((c) => c.sha)).toEqual(
      Array.from({ length: 130 }, (_, i) => fakeSha(i + 1)),
    );
    expect(r.commits[0]).toEqual({ sha: fakeSha(1), message: "message 1" });
    expect(api.find("GET", /\/pulls\/2\/commits$/)).toHaveLength(2);
    expect(api.find("GET", /git\/commits/)).toHaveLength(0);
  });

  it("U-FETCH-2 312 commits: the API serves 250 in 3 pages; the head is fetched on its own and appended", async () => {
    const { api, client } = await setup(250);
    const head = fakeSha(312);
    api.state.gitCommits.set(head, "head message");
    const r = await fetchPrCommits(client, args(head, 312));
    expect(r.truncated).toBe(true);
    expect(r.commits).toHaveLength(251);
    expect(r.commits.at(-1)).toEqual({ sha: head, message: "head message" });
    expect(api.find("GET", /\/pulls\/2\/commits$/)).toHaveLength(3);
    expect(api.find("GET", new RegExp(`/git/commits/${head}$`))).toHaveLength(1);
  });

  it("U-FETCH-3 truncated but the head is already in the list: no extra request", async () => {
    const { api, client } = await setup(250);
    const r = await fetchPrCommits(client, args(fakeSha(250), 312));
    expect(r.truncated).toBe(true);
    expect(r.commits).toHaveLength(250);
    expect(api.find("GET", /git\/commits/)).toHaveLength(0);
  });
});
