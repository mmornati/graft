import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { forToken } from "../../src/github/client-factory.js";
import { createFakeGitHubWorld, makePatch } from "../helpers/fake-github-world.js";

const require = createRequire(import.meta.url);
const schema = require("@octokit/webhooks-schemas") as Record<string, unknown>;

/** The schema with `required` and `additionalProperties` removed: every field that is present must have the right type. */
function relax(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(relax);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "required" || k === "additionalProperties") continue;
      // Without `required` several branches of a oneOf match: any one is enough.
      out[k === "oneOf" ? "anyOf" : k] = relax(v);
    }
    return out;
  }
  return node;
}

const ACTOR = { login: "mmornati", id: 111, token: "ghp_actor0123456789abcdefghijklmnop" };
const OUTSIDER = { login: "outsider-e2e", id: 222, token: "ghp_outsider0123456789abcdefghijklm" };

describe("fake GitHub world", () => {
  it("U-LIVE-WORLD-1 emitted payloads validate against @octokit/webhooks-schemas; PR files and patches match the trees", async () => {
    const delivered: { event: string; body: Record<string, unknown>; guid: string }[] = [];
    const world = createFakeGitHubWorld({
      owner: "mmornati",
      repo: "graft-sandbox",
      appId: 12345,
      botLogin: "graft-dev[bot]",
      installationId: 777,
      private: true,
      users: { actor: ACTOR, outsider: OUTSIDER },
      seedFiles: new Map([
        ["graft.yaml", "version: 1\n"],
        ["docs/guide.md", "one\ntwo\nthree\nfour\n"],
        ["src/old.py", "print('old')\n"],
      ]),
      deliver: async (event, body, guid) => {
        delivered.push({ event, body: body as Record<string, unknown>, guid });
        return 202;
      },
    });
    world.acceptInvitation(OUTSIDER.login);
    const octokit = forToken(ACTOR.token, { fetch: world.fetch });
    const outsider = forToken(OUTSIDER.token, { fetch: world.fetch });
    const [owner, repo] = ["mmornati", "graft-sandbox"];

    const main = (await octokit.rest.git.getRef({ owner, repo, ref: "heads/main" })).data.object
      .sha;
    const baseCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: main });
    const guide = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: "one\nTWO\nthree\nfour\nfive\n",
      encoding: "utf-8",
    });
    const added = await octokit.rest.git.createBlob({
      owner,
      repo,
      content: "a\nb\n",
      encoding: "utf-8",
    });
    const tree = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.data.tree.sha,
      tree: [
        { path: "docs/guide.md", mode: "100644", type: "blob", sha: guide.data.sha },
        { path: "src/new.py", mode: "100644", type: "blob", sha: added.data.sha },
        { path: "src/old.py", mode: "100644", type: "blob", sha: null as unknown as string },
      ],
    });
    const commit = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: "Edit things",
      tree: tree.data.sha,
      parents: [main],
    });
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: "refs/heads/graft-e2e/x/s01",
      sha: commit.data.sha,
    });
    const pr = (
      await octokit.rest.pulls.create({
        owner,
        repo,
        head: "graft-e2e/x/s01",
        base: "main",
        title: "Edit",
        body: "body",
        draft: true,
      })
    ).data;
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pr.number,
      labels: ["graft-e2e"],
    });
    await octokit.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number: pr.number,
      reviewers: [OUTSIDER.login],
    });
    await outsider.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pr.number,
      event: "APPROVE",
    });
    await octokit.graphql(
      "mutation($pullRequestId: ID) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { id } } }",
      { pullRequestId: pr.node_id },
    );
    const second = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: "More",
      tree: tree.data.sha,
      parents: [commit.data.sha],
    });
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: "heads/graft-e2e/x/s01",
      sha: second.data.sha,
      force: false,
    });
    await octokit.rest.pulls.update({ owner, repo, pull_number: pr.number, state: "closed" });
    world.state.checkRuns.push({
      id: 4242,
      name: "graft/intent",
      head_sha: second.data.sha,
      status: "completed",
      conclusion: "neutral",
      external_id: "card-1",
      output: { title: "t", summary: "s" },
      app: { id: 12345 },
    });
    await world.clickButton(OUTSIDER, 4242, "card_up");

    // The events GitHub would have sent, in order.
    expect(delivered.map((d) => `${d.event}.${String(d.body.action ?? "")}`)).toEqual([
      "push.",
      "pull_request.opened",
      "pull_request.labeled",
      "pull_request.review_requested",
      "pull_request_review.submitted",
      "pull_request.ready_for_review",
      "push.",
      "pull_request.synchronize",
      "pull_request.closed",
      "check_run.requested_action",
    ]);
    expect(new Set(delivered.map((d) => d.guid)).size).toBe(delivered.length);

    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    ajv.addSchema(relax(schema) as object, "root");
    const definitionFor = (event: string, action: string) =>
      event === "push" ? "push$event" : `${event}$${action}`;
    for (const d of delivered) {
      const validate = ajv.getSchema(
        `root#/definitions/${definitionFor(d.event, String(d.body.action ?? ""))}`,
      );
      expect(validate, `${d.event}.${String(d.body.action ?? "")} has a schema`).toBeDefined();
      const ok = validate?.(d.body);
      expect(
        ok,
        `${d.event}.${String(d.body.action ?? "")}: ${JSON.stringify(validate?.errors?.slice(0, 3))}`,
      ).toBe(true);
    }

    // The fields Graft reads are present: head sha, base ref, updated_at, installation, repository.
    for (const d of delivered.filter((x) => x.event === "pull_request")) {
      const p = d.body.pull_request as {
        head: { sha: string };
        base: { ref: string };
        updated_at: string;
      };
      expect(p.head.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(p.base.ref).toBe("main");
      expect(typeof p.updated_at).toBe("string");
      expect((d.body.installation as { id: number }).id).toBe(777);
      expect((d.body.repository as { full_name: string }).full_name).toBe("mmornati/graft-sandbox");
    }
    // The push to main-less branch lists the changed paths of its commits.
    const push = delivered[6]?.body as {
      commits: { added: string[]; modified: string[]; removed: string[] }[];
      after: string;
      before: string;
    };
    expect(push.before).toBe(commit.data.sha);
    expect(push.after).toBe(second.data.sha);
    const firstPush = delivered[0]?.body as {
      commits: { added: string[]; modified: string[]; removed: string[] }[];
    };
    expect(firstPush.commits[0]).toMatchObject({
      added: ["src/new.py"],
      modified: ["docs/guide.md"],
      removed: ["src/old.py"],
    });

    // Files and patches match the trees.
    const files = (await octokit.rest.pulls.listFiles({ owner, repo, pull_number: pr.number }))
      .data;
    const by = Object.fromEntries(files.map((f) => [f.filename, f]));
    expect(Object.keys(by).sort()).toEqual(["docs/guide.md", "src/new.py", "src/old.py"]);
    expect(by["docs/guide.md"]).toMatchObject({ status: "modified", additions: 4, deletions: 3 });
    expect(by["docs/guide.md"]?.patch).toBe(
      "@@ -2,3 +2,4 @@\n-two\n-three\n-four\n+TWO\n+three\n+four\n+five",
    );
    expect(by["src/new.py"]).toMatchObject({
      status: "added",
      additions: 2,
      deletions: 0,
      patch: "@@ -0,0 +1,2 @@\n+a\n+b",
    });
    expect(by["src/old.py"]).toMatchObject({
      status: "removed",
      additions: 0,
      deletions: 1,
      patch: "@@ -1,1 +0,0 @@\n-print('old')",
    });
    const live = (await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number })).data;
    expect(live).toMatchObject({ changed_files: 3, commits: 2, state: "closed" });
    expect(live.additions).toBe(files.reduce((n, f) => n + f.additions, 0));
    expect(live.deletions).toBe(files.reduce((n, f) => n + f.deletions, 0));
  });

  it("the patch maker trims the common prefix and suffix and is consistent with its counts", () => {
    expect(makePatch("a\nb\nc\n", "a\nB\nc\n")).toEqual({
      patch: "@@ -2,1 +2,1 @@\n-b\n+B",
      additions: 1,
      deletions: 1,
    });
    expect(makePatch("", "x\n")).toEqual({
      patch: "@@ -0,0 +1,1 @@\n+x",
      additions: 1,
      deletions: 0,
    });
    expect(makePatch("x\n", "")).toEqual({
      patch: "@@ -1,1 +0,0 @@\n-x",
      additions: 0,
      deletions: 1,
    });
  });
});
