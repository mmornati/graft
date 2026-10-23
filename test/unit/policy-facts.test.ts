import { describe, expect, it } from "vitest";
import {
  buildFacts,
  listChangedPaths,
  listCommitLogins,
  listReviews,
} from "../../src/modules/policy/facts.js";
import { fakeGitHubFactory } from "../helpers/app.js";
import { createFakeGitHubApi } from "../helpers/fake-github-api.js";
import {
  fakeSha,
  HEAD_SHA,
  INSTALLATION_ID,
  makeCommit,
  makeFile,
  makePull,
  makeReview,
  OWNER,
  PR_NUMBER,
  REPO,
} from "../helpers/github-builders.js";

const target = { owner: OWNER, repo: REPO, prNumber: PR_NUMBER };
const OTHER = fakeSha(0x0b);

const base = (
  over: Partial<Parameters<typeof buildFacts>[0]> = {},
): Parameters<typeof buildFacts>[0] => ({
  pull: makePull({ additions: 10, deletions: 2, changed_files: 1 }) as never,
  files: [
    { path: "src/a.ts", previousPath: null, status: "modified", additions: 10, deletions: 2 },
  ],
  complete: true,
  card: undefined,
  provenance: undefined,
  configSensitivePaths: [],
  policySensitivePaths: [],
  ...over,
});

describe("policy facts", () => {
  it("U-FACT-1 listChangedPaths drops the patch; over 1,000 files it makes no call", async () => {
    const api = createFakeGitHubApi();
    api.state.files.set(PR_NUMBER, [
      makeFile({ path: "src/a.ts", patch: "@@ -1 +1 @@\n-secret old\n+secret new" }),
      makeFile({ path: "src/b.ts", status: "renamed", previousPath: "src/old.ts" }),
    ]);
    const octokit = await fakeGitHubFactory(api).forInstallation(INSTALLATION_ID);
    const res = await listChangedPaths(octokit, { ...target, changedFiles: 2 });
    expect(res.complete).toBe(true);
    expect(res.files).toEqual([
      { path: "src/a.ts", previousPath: null, status: "modified", additions: 3, deletions: 1 },
      {
        path: "src/b.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 3,
        deletions: 1,
      },
    ]);
    for (const f of res.files) expect(Object.keys(f)).not.toContain("patch");
    expect(JSON.stringify(res)).not.toContain("secret");

    // The reported count decides completeness.
    const short = await listChangedPaths(octokit, { ...target, changedFiles: 5 });
    expect(short.complete).toBe(false);

    // Pagination: 250 files are three pages of 100.
    api.state.files.set(
      PR_NUMBER,
      Array.from({ length: 250 }, (_, i) => makeFile({ path: `f${i}.ts` })),
    );
    api.requests.length = 0;
    const many = await listChangedPaths(octokit, { ...target, changedFiles: 250 });
    expect(many).toMatchObject({ complete: true });
    expect(many.files).toHaveLength(250);
    expect(api.find("GET", /\/files$/)).toHaveLength(3);

    api.requests.length = 0;
    const huge = await listChangedPaths(octokit, { ...target, changedFiles: 1_001 });
    expect(huge).toEqual({ files: [], complete: false });
    expect(api.requests).toEqual([]);
  });

  it("U-FACT-1 listReviews reads up to three pages and flags truncation", async () => {
    const api = createFakeGitHubApi();
    const reviews = Array.from({ length: 350 }, (_, i) =>
      makeReview({ id: i + 1, login: `u${i}` }),
    );
    api.state.reviews.set(PR_NUMBER, reviews);
    const octokit = await fakeGitHubFactory(api).forInstallation(INSTALLATION_ID);
    const res = await listReviews(octokit, target);
    expect(res.reviews).toHaveLength(300);
    expect(res.truncated).toBe(true);
    expect(res.reviews[0]).toEqual({
      user: { id: 5_000_001, login: "u0", type: "User" },
      state: "APPROVED",
      commit_id: HEAD_SHA,
      submitted_at: "2026-10-14T11:01:00Z",
      // Kept to order the role checks (step 2 review 1, finding 4).
      author_association: "COLLABORATOR",
    });
    api.state.reviews.set(PR_NUMBER, reviews.slice(0, 120));
    const fewer = await listReviews(octokit, target);
    expect(fewer).toMatchObject({ truncated: false });
    expect(fewer.reviews).toHaveLength(120);
    api.state.reviews.set(PR_NUMBER, []);
    expect(await listReviews(octokit, target)).toEqual({ reviews: [], truncated: false });
  });

  it("U-FACT-2 risk comes from the card for the head, from an unavailable card, or from the floor", () => {
    const ok = buildFacts(
      base({ card: { head_sha: HEAD_SHA, status: "ok", risk_class: "sensitive" } }),
    );
    expect(ok.risk).toEqual({ value: "sensitive", final: true, source: "card" });
    const unavailable = buildFacts(
      base({ card: { head_sha: HEAD_SHA, status: "unavailable", risk_class: "logic" } }),
    );
    expect(unavailable.risk).toEqual({ value: "logic", final: false, source: "card_unavailable" });
    // A card for another head says nothing about this one: the floor, never below logic.
    const stale = buildFacts(
      base({ card: { head_sha: OTHER, status: "ok", risk_class: "trivial" } }),
    );
    expect(stale.risk).toEqual({ value: "logic", final: false, source: "card_pending" });
    const sensitive = buildFacts(
      base({
        card: undefined,
        files: [
          {
            path: "package.json",
            previousPath: null,
            status: "modified",
            additions: 1,
            deletions: 0,
          },
        ],
      }),
    );
    expect(sensitive.risk).toEqual({ value: "sensitive", final: false, source: "card_pending" });
    // An incomplete listing is itself sensitive for the floor.
    expect(buildFacts(base({ complete: false })).risk.value).toBe("sensitive");
    const f = buildFacts(
      base({
        pull: makePull({
          labels: [{ name: "a" }, { name: "B" }],
          additions: 5,
          deletions: 6,
          changed_files: 3,
        }) as never,
      }),
    );
    expect(f.labels).toEqual(["a", "B"]);
    expect(f.size).toEqual({ lines: 11, files: 3 });
    expect(f.listingComplete).toBe(true);
    expect(f.files).toEqual([{ path: "src/a.ts", previousPath: null }]);
  });

  it("U-FACT-3 provenance for another head leaves the author unknown", () => {
    expect(
      buildFacts(
        base({ provenance: { head_sha: HEAD_SHA, author_kind: "agent", agent: "claude-code" } }),
      ).author,
    ).toEqual({ kind: "agent", agent: "claude-code" });
    expect(
      buildFacts(base({ provenance: { head_sha: HEAD_SHA, author_kind: "human", agent: null } }))
        .author,
    ).toEqual({ kind: "human", agent: null });
    expect(
      buildFacts(
        base({ provenance: { head_sha: OTHER, author_kind: "agent", agent: "claude-code" } }),
      ).author,
    ).toEqual({ kind: "unknown", agent: null });
    expect(buildFacts(base()).author).toEqual({ kind: "unknown", agent: null });
  });

  it("U-FACT-4 the pending floor uses the sensitive_paths of the policy and of the config", () => {
    const files = [
      {
        path: "services/billing/pay.ts",
        previousPath: null,
        status: "modified" as const,
        additions: 1,
        deletions: 0,
      },
    ];
    expect(buildFacts(base({ files })).risk.value).toBe("logic");
    expect(
      buildFacts(base({ files, policySensitivePaths: ["services/billing/**"] })).risk.value,
    ).toBe("sensitive");
    expect(
      buildFacts(base({ files, configSensitivePaths: ["services/billing/**"] })).risk.value,
    ).toBe("sensitive");
  });
});

describe("listCommitLogins (Phase 1 step 7, D8)", () => {
  type C = {
    author?: string | null;
    committer?: string | null;
    verification?: { verified: boolean } | "absent";
  };
  const commit = (i: number, o: C = {}) => {
    const base = makeCommit(fakeSha(0x100 + i), "x");
    return {
      ...base,
      commit:
        o.verification === "absent"
          ? { ...base.commit, verification: undefined }
          : o.verification === undefined
            ? base.commit
            : { ...base.commit, verification: o.verification },
      author: o.author === null ? null : { login: o.author ?? "alice" },
      committer: o.committer === null ? null : { login: o.committer ?? "web-flow" },
    };
  };
  async function logins(commits: unknown[], count = commits.length) {
    const api = createFakeGitHubApi();
    api.state.commits.set(PR_NUMBER, commits as never);
    const octokit = await fakeGitHubFactory(api).forInstallation(INSTALLATION_ID);
    return listCommitLogins(octokit, { ...target, commits: count });
  }

  it("U-FCT-1 all verified → logins (authors and committers, web-flow left out); unverified, absent verification and a null committer → unverified; 251 → too_many; a null author → no_author", async () => {
    expect(
      await logins([
        commit(1, { author: "Alice", committer: "web-flow" }),
        commit(2, { author: "bob", committer: "Carol" }),
      ]),
    ).toEqual({ logins: ["alice", "bob", "carol"] });
    expect(await logins([commit(1), commit(2, { verification: { verified: false } })])).toEqual({
      unknown: "unverified",
    });
    expect(await logins([commit(1, { verification: "absent" })])).toEqual({
      unknown: "unverified",
    });
    expect(await logins([commit(1, { committer: null })])).toEqual({ unknown: "unverified" });
    expect(
      await logins(
        Array.from({ length: 251 }, (_, i) => commit(i)),
        251,
      ),
    ).toEqual({ unknown: "too_many" });
    expect(await logins([commit(1, { author: null })])).toEqual({ unknown: "no_author" });
  });
});
