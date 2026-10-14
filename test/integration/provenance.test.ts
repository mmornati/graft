import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  refreshKey,
  rerequestProvenance,
  scheduleProvenance,
} from "../../src/modules/provenance/handlers.js";
import { provenanceRefreshJob, type RefreshData } from "../../src/modules/provenance/job.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import { singletonJobId } from "../../src/queue/queue.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW } from "../helpers/config.js";
import { countJobs, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture, setPath } from "../helpers/fixtures.js";
import {
  commitMessage,
  fakeSha,
  HEAD_SHA,
  INSTALLATION_ID,
  makeCommit,
  makePull,
  OWNER,
  PR_NUMBER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";
import {
  EXPECTED_COMMENT,
  EXPECTED_SECTION,
  SCENARIO_BODY,
  scenarioCommits,
} from "../helpers/provenance-scenario.js";
import { seedWorld } from "../helpers/seed.js";
import { sleep } from "../helpers/wait.js";

let t: TestApp;
let api: FakeGitHubApi;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  await seedWorld(t.db);
  api = createFakeGitHubApi();
  t.deps.github = fakeGitHubFactory(api);
});

const DATA: RefreshData = {
  installationId: INSTALLATION_ID,
  repositoryId: REPO_ID,
  owner: OWNER,
  repo: REPO,
  prNumber: PR_NUMBER,
  headSha: HEAD_SHA,
  trigger: "opened",
  deliveryId: "d-test",
};
const runJob = (over: Partial<RefreshData> = {}) =>
  provenanceRefreshJob.handle({ ...DATA, ...over }, jobContext(t));

function loadScenario() {
  api.state.pulls.set(PR_NUMBER, makePull({ body: SCENARIO_BODY, commits: 3 }));
  api.state.commits.set(PR_NUMBER, scenarioCommits());
}
const commentWrites = () =>
  api.requests.filter((r) => r.method !== "GET" && /\/issues\//.test(r.path));
const checkWrites = () =>
  api.requests.filter((r) => r.method !== "GET" && /check-runs/.test(r.path));
const rowsOf = async () => ({
  provenance: await t.db.selectFrom("provenance").selectAll().orderBy("commit_sha").execute(),
  cp: await t.db.selectFrom("change_provenance").selectAll().execute(),
  change: await t.db.selectFrom("changes").selectAll().execute(),
});

describe("provenance.refresh job", () => {
  it("I-PROV-1 end to end: rows, task, one check run and one comment equal to the spec output", async () => {
    loadScenario();
    await runJob();

    const { provenance, cp, change } = await rowsOf();
    expect(provenance.filter((p) => p.source === "trailer")).toHaveLength(2);
    const body = provenance.filter((p) => p.source === "pr_body");
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      commit_sha: null,
      session_url: "https://claude.ai/code/session/abc",
    });

    expect(cp).toHaveLength(1);
    expect(cp[0]).toMatchObject({
      head_sha: HEAD_SHA,
      author_kind: "agent",
      author_kind_reason: "trailer",
      agent: "claude-code",
      model: "claude-sonnet-5-5",
      task_external_id: "#42",
      session_url: "https://claude.ai/code/session/abc",
      commits_total: 3,
      commits_scanned: 3,
      commits_with_trailers: 2,
      agent_coauthor_commits: 0,
      commits_truncated: false,
    });
    expect(cp[0]?.field_sources).toMatchObject({
      agent: { source: "commit", commitSha: HEAD_SHA },
      session: { source: "pr_body" },
    });
    expect(cp[0]?.conflicts).toEqual({ model: ["claude-sonnet-5-5", "claude-haiku-5-5"] });
    expect(cp[0]?.warnings).toEqual([
      expect.objectContaining({ code: "invalid_session_url", field: "session", source: "commit" }),
    ]);

    const task = await t.db.selectFrom("tasks").selectAll().executeTakeFirstOrThrow();
    expect(task).toMatchObject({
      repository_id: REPO_ID,
      external_id: "#42",
      issue_number: 42,
      issue_url: `https://github.com/${OWNER}/${REPO}/issues/42`,
    });
    expect(change[0]?.task_id).toBe(task.id);

    const checks = checkWrites();
    expect(checks).toHaveLength(1);
    expect(checks[0]?.method).toBe("POST");
    expect(checks[0]?.body).toMatchObject({
      name: "graft/provenance",
      head_sha: HEAD_SHA,
      status: "completed",
      conclusion: "neutral",
      external_id: change[0]?.id,
      output: {
        title: "Agent: claude-code · Model: claude-sonnet-5-5",
        summary: EXPECTED_SECTION,
      },
    });
    const comments = commentWrites();
    expect(comments).toHaveLength(1);
    expect(comments[0]?.method).toBe("POST");
    expect(comments[0]?.body?.body).toBe(EXPECTED_COMMENT);

    expect(change[0]?.graft_comment_id).toBe(api.state.comments[0]?.id);
    expect(cp[0]?.check_run_id).toBe(api.state.checkRuns[0]?.id);
  });

  it("I-PROV-2 running again unchanged PATCHes the check run and leaves the comment alone", async () => {
    loadScenario();
    await runJob();
    const strip = <T extends { id?: unknown; updated_at?: unknown }>(rows: T[]) =>
      rows.map(({ id: _id, updated_at: _u, ...rest }) => rest);
    const before = await rowsOf();
    const reqCount = api.requests.length;

    await runJob();
    const after = await rowsOf();
    expect(strip(after.provenance)).toEqual(strip(before.provenance));
    expect(strip(after.cp)).toEqual(strip(before.cp));
    expect(strip(after.change)).toEqual(strip(before.change));

    const second = api.requests.slice(reqCount);
    const writes = second.filter((r) => r.method !== "GET");
    expect(writes.map((w) => `${w.method} ${w.path.split("/").slice(-2).join("/")}`)).toEqual([
      expect.stringMatching(/^PATCH check-runs\/\d+$/),
    ]);
    expect(api.state.comments).toHaveLength(1);
    expect(api.state.checkRuns).toHaveLength(1);
  });

  it("I-PROV-3 a stale pulls.get (older than what is stored) writes and publishes nothing", async () => {
    loadScenario();
    await runJob();
    const before = await rowsOf();
    const reqCount = api.requests.length;

    api.state.pulls.set(
      PR_NUMBER,
      makePull({
        body: null,
        commits: 1,
        updated_at: "2026-10-14T10:30:00Z",
        head: { sha: fakeSha(77) },
      }),
    );
    await runJob({ headSha: fakeSha(77) });
    expect(await rowsOf()).toEqual(before);
    const made = api.requests.slice(reqCount).map((r) => `${r.method} ${r.path}`);
    expect(made.filter((m) => !m.includes("access_tokens"))).toEqual([
      `GET /repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`,
    ]);
  });

  it("I-PROV-4 a force-push without trailers flips the output to Human and clears the task", async () => {
    loadScenario();
    await runJob();
    const newHead = fakeSha(4);
    api.state.pulls.set(
      PR_NUMBER,
      makePull({
        body: null,
        commits: 1,
        updated_at: "2026-10-14T13:00:00Z",
        head: { sha: newHead },
      }),
    );
    api.state.commits.set(PR_NUMBER, [makeCommit(newHead, commitMessage("Rewritten"))]);
    await runJob({ headSha: newHead });

    const { provenance, cp, change } = await rowsOf();
    expect(provenance).toEqual([]);
    expect(change[0]?.task_id).toBeNull();
    expect(change[0]?.head_sha).toBe(newHead);
    expect(cp[0]).toMatchObject({
      head_sha: newHead,
      author_kind: "human",
      author_kind_reason: "none",
      agent: null,
    });
    expect(api.state.comments).toHaveLength(1);
    expect(api.state.comments[0]?.body).toContain("| **Authored by** | Human |");
    expect(api.state.comments[0]?.body).not.toContain("claude-code");
    // The check run for the new head is a new one; the old head's stays.
    expect(api.state.checkRuns.map((r) => r.head_sha)).toEqual([HEAD_SHA, newHead]);
    expect(api.state.checkRuns[1]?.output.title).toBe("Human-authored (no agent provenance)");
    expect(cp[0]?.check_run_id).toBe(api.state.checkRuns[1]?.id);
  });

  it("I-PROV-5 more than 250 commits: truncated, the head commit is fetched, the footer says so", async () => {
    const commits = Array.from({ length: 250 }, (_, i) => makeCommit(fakeSha(i + 100), `c${i}`));
    api.state.pulls.set(PR_NUMBER, makePull({ commits: 312 }));
    api.state.commits.set(PR_NUMBER, commits);
    api.state.gitCommits.set(
      HEAD_SHA,
      commitMessage("Head", undefined, [["Graft-Agent", "claude-code"]]),
    );
    await runJob();

    const { cp } = await rowsOf();
    expect(cp[0]).toMatchObject({
      commits_truncated: true,
      commits_total: 312,
      commits_scanned: 251,
      commits_with_trailers: 1,
      agent: "claude-code",
    });
    expect(api.find("GET", /git\/commits\//)).toHaveLength(1);
    expect(api.state.comments[0]?.body).toContain(
      "Only the first 250 commits and the head commit were scanned.",
    );
  });

  it("I-PROV-6 a rate-limited pulls.get makes the job throw a retryable error and writes nothing", async () => {
    loadScenario();
    api.failNext("GET", /\/pulls\/2$/, 403, { "x-ratelimit-remaining": "0" });
    const err = await runJob().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    const { provenance, cp, change } = await rowsOf();
    expect([provenance, cp, change]).toEqual([[], [], []]);
    expect(checkWrites()).toHaveLength(0);
    expect(commentWrites()).toHaveLength(0);
  });

  it("I-PROV-7 a 404 pulls.get throws PermanentJobError and writes nothing", async () => {
    // No PR in the fake: 404.
    const err = await runJob().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentJobError);
    expect((err as PermanentJobError).reason).toBe("not_found");
    const { provenance, cp, change } = await rowsOf();
    expect([provenance, cp, change]).toEqual([[], [], []]);
  });

  it("I-PROV-7 a pull for another repository or number is a permanent repo_mismatch", async () => {
    api.state.pulls.set(
      PR_NUMBER,
      makePull({ base: { ref: "main", repo: { ...makePull().base.repo, id: 5 } } }),
    );
    const err = await runJob().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentJobError);
    expect((err as PermanentJobError).reason).toBe("repo_mismatch");
    expect((await rowsOf()).change).toEqual([]);
  });

  it("I-PROV-8 a failure after the comment was created rolls back; the rerun adopts that comment", async () => {
    loadScenario();
    api.failNext("POST", /\/check-runs$/, 500);
    await expect(runJob()).rejects.toThrow();
    expect((await rowsOf()).cp).toEqual([]);
    expect((await rowsOf()).change[0]?.graft_comment_id).toBeNull();
    expect(api.state.comments).toHaveLength(1);

    await runJob();
    expect(api.state.comments).toHaveLength(1);
    expect(api.find("POST", /\/issues\/2\/comments$/)).toHaveLength(1);
    expect((await rowsOf()).change[0]?.graft_comment_id).toBe(api.state.comments[0]?.id);
    expect(api.state.comments[0]?.body).toBe(EXPECTED_COMMENT);
    expect((await rowsOf()).cp).toHaveLength(1);
  });

  it("I-PROV-9 a human comment that contains the marker is ignored; Graft creates its own", async () => {
    loadScenario();
    api.state.comments.push({
      id: 1,
      body: EXPECTED_COMMENT.replace("claude-code", "planted"),
      user: { login: "mallory", type: "User" },
      performed_via_github_app: null,
    });
    await runJob();
    expect(api.state.comments).toHaveLength(2);
    expect(api.state.comments[0]?.body).toContain("planted");
    expect(api.state.comments[1]?.body).toBe(EXPECTED_COMMENT);
    expect((await rowsOf()).change[0]?.graft_comment_id).toBe(api.state.comments[1]?.id);
  });

  it("I-PROV-9 D13 fallback: without performed_via_github_app, the App's bot login plus the marker is adopted", async () => {
    const app2 = await createTestApp({ config: { GITHUB_APP_SLUG: "graft-dev" } });
    try {
      api.state.omitPerformedViaApp = true;
      app2.deps.github = fakeGitHubFactory(api);
      loadScenario();
      const run2 = () => provenanceRefreshJob.handle(DATA, jobContext(app2));
      await run2();
      await run2();
      expect(api.state.comments).toHaveLength(1);
      expect(api.state.comments[0]?.performed_via_github_app).toBeUndefined();
      expect(commentWrites()).toHaveLength(1); // the second run found it and saw no change

      // The stored comment id is lost: it is found again by listing, through the bot login.
      await t.db.updateTable("changes").set({ graft_comment_id: null }).execute();
      await run2();
      expect(api.state.comments).toHaveLength(1);
      expect((await rowsOf()).change[0]?.graft_comment_id).toBe(api.state.comments[0]?.id);
    } finally {
      await app2.close();
    }
  });

  it("I-PROV-9 without a configured slug and without the field, our comment is not recognised (D13 fallback is opt-in)", async () => {
    api.state.omitPerformedViaApp = true;
    loadScenario();
    await runJob();
    await t.db.updateTable("changes").set({ graft_comment_id: null }).execute();
    await runJob();
    expect(api.state.comments).toHaveLength(2);
  });

  it("I-PROV-10 concurrent jobs: the older job finishes publishing before the newer one; final state is the newer", async () => {
    // Step 0: an initial run creates the comment and the check run.
    api.state.pulls.set(PR_NUMBER, makePull());
    api.state.commits.set(PR_NUMBER, [makeCommit(HEAD_SHA, commitMessage("Init"))]);
    await runJob();

    // Job A: head A, paused inside the comment PATCH while holding the lock.
    const headA = fakeSha(0xa);
    api.state.pulls.set(
      PR_NUMBER,
      makePull({ updated_at: "2026-10-14T12:00:00Z", head: { sha: headA } }),
    );
    api.state.commits.set(PR_NUMBER, [
      makeCommit(headA, commitMessage("A", undefined, [["Graft-Agent", "agent-a"]])),
    ]);
    const block = api.block("PATCH", /\/issues\/comments\/\d+$/);
    const jobA = runJob({ headSha: headA });
    await block.reached;

    // The PR moves to head B; job B starts and has to wait for A.
    const headB = fakeSha(0xb);
    api.state.pulls.set(
      PR_NUMBER,
      makePull({ updated_at: "2026-10-14T12:05:00Z", head: { sha: headB } }),
    );
    api.state.commits.set(PR_NUMBER, [
      makeCommit(headB, commitMessage("B", undefined, [["Graft-Agent", "agent-b"]])),
    ]);
    const jobB = runJob({ headSha: headB });
    await sleep(400);
    expect(api.find("PATCH", /\/issues\/comments\/\d+$/)).toHaveLength(1); // only A's, still held

    block.release();
    await Promise.all([jobA, jobB]);

    const patches = api.find("PATCH", /\/issues\/comments\/\d+$/);
    expect(patches).toHaveLength(2);
    expect(String(patches[0]?.body?.body)).toContain("agent-a");
    expect(String(patches[1]?.body?.body)).toContain("agent-b");
    expect(api.state.comments[0]?.body).toContain("agent-b");
    expect(api.state.comments[0]?.body).not.toContain("agent-a");
    const { cp } = await rowsOf();
    expect(cp[0]?.head_sha).toBe(headB);
    expect(cp[0]?.agent).toBe("agent-b");
  });

  it("I-PROV-10b same head, different body: the job holding an older snapshot publishes nothing over the newer one", async () => {
    api.state.pulls.set(PR_NUMBER, makePull());
    api.state.commits.set(PR_NUMBER, [makeCommit(HEAD_SHA, commitMessage("Init"))]);
    await runJob();

    // Job A reads body X (older), its upsert applies, then it stalls before taking the lock.
    api.state.pulls.set(
      PR_NUMBER,
      makePull({ updated_at: "2026-10-14T12:00:00Z", body: "Graft-Agent: agent-x" }),
    );
    api.state.commits.set(PR_NUMBER, [makeCommit(HEAD_SHA, commitMessage("c"))]);
    const gate = api.block("GET", /\/pulls\/\d+\/commits/);
    const jobA = runJob();
    await gate.reached;

    // Body Y is newer on the same head; job B runs to completion.
    api.state.pulls.set(
      PR_NUMBER,
      makePull({ updated_at: "2026-10-14T12:05:00Z", body: "Graft-Agent: agent-y" }),
    );
    await runJob();
    expect(api.state.comments[0]?.body).toContain("agent-y");

    const patchesBefore = api.find("PATCH", /\/issues\/comments\/\d+$/).length;
    gate.release();
    await jobA;
    // A re-checks inside the lock, sees the newer stored snapshot and publishes nothing.
    expect(api.find("PATCH", /\/issues\/comments\/\d+$/)).toHaveLength(patchesBefore);
    expect(api.state.comments[0]?.body).toContain("agent-y");
    expect(api.state.comments[0]?.body).not.toContain("agent-x");
    const { cp, change } = await rowsOf();
    expect(cp[0]?.agent).toBe("agent-y");
    expect(change[0]?.pr_updated_at).toEqual(new Date("2026-10-14T12:05:00Z"));
  });

  it("I-PROV-10c the head moves while a job waits for the lock: the in-lock head check publishes nothing", async () => {
    api.state.pulls.set(PR_NUMBER, makePull());
    api.state.commits.set(PR_NUMBER, [makeCommit(HEAD_SHA, commitMessage("Init"))]);
    await runJob();

    const headA = fakeSha(0xa);
    api.state.pulls.set(
      PR_NUMBER,
      makePull({ updated_at: "2026-10-14T12:00:00Z", head: { sha: headA } }),
    );
    api.state.commits.set(PR_NUMBER, [
      makeCommit(headA, commitMessage("A", undefined, [["Graft-Agent", "agent-a"]])),
    ]);
    const gate = api.block("GET", /\/pulls\/\d+\/commits/);
    const jobA = runJob({ headSha: headA });
    await gate.reached;

    const headB = fakeSha(0xb);
    api.state.pulls.set(
      PR_NUMBER,
      makePull({ updated_at: "2026-10-14T12:05:00Z", head: { sha: headB } }),
    );
    api.state.commits.set(PR_NUMBER, [
      makeCommit(headB, commitMessage("B", undefined, [["Graft-Agent", "agent-b"]])),
    ]);
    await runJob({ headSha: headB });

    // Isolate the in-lock head check: with the stored snapshot time cleared, only the head
    // comparison can stop job A from publishing (T18.4).
    await t.db.updateTable("changes").set({ pr_updated_at: null }).execute();

    gate.release();
    await jobA;
    expect(api.state.comments[0]?.body).toContain("agent-b");
    expect(api.state.comments[0]?.body).not.toContain("agent-a");
    expect((await rowsOf()).cp[0]?.head_sha).toBe(headB);
    const patches = api.find("PATCH", /\/issues\/comments\/\d+$/);
    expect(patches.some((r) => String(r.body?.body).includes("agent-a"))).toBe(false);
  });

  it("I-PROV-12 a closed trigger records the live state and publishes nothing", async () => {
    api.state.pulls.set(
      PR_NUMBER,
      makePull({
        state: "closed",
        merged: true,
        merge_commit_sha: fakeSha(5),
        merged_at: "2026-10-14T11:30:00Z",
        closed_at: "2026-10-14T11:30:00Z",
        updated_at: "2026-10-14T11:30:00Z",
      }),
    );
    await runJob({ trigger: "closed" });
    const { change, cp } = await rowsOf();
    expect(change[0]).toMatchObject({ state: "merged", merge_commit_sha: fakeSha(5) });
    expect(cp).toEqual([]);
    expect(api.requests.some((r) => /commits|check-runs|comments/.test(r.path))).toBe(false);
  });

  it("an inactive installation or a removed repository is skipped without any GitHub call", async () => {
    await t.db.updateTable("installations").set({ suspended_at: new Date() }).execute();
    await runJob();
    expect(api.requests).toHaveLength(0);

    await t.db.updateTable("installations").set({ suspended_at: null }).execute();
    await t.db.updateTable("repositories").set({ removed_at: new Date() }).execute();
    loadScenario();
    await runJob();
    expect((await rowsOf()).change).toEqual([]);
    expect(commentWrites()).toHaveLength(0);
  });

  it("a missing repository row is created by the job (repo added after an 'all' install)", async () => {
    await t.db.deleteFrom("repositories").execute();
    loadScenario();
    await runJob();
    const repo = await t.db.selectFrom("repositories").selectAll().executeTakeFirstOrThrow();
    expect(repo).toMatchObject({ id: REPO_ID, full_name: `${OWNER}/${REPO}`, removed_at: null });
    expect((await rowsOf()).cp).toHaveLength(1);
  });
});

describe("provenance webhook handlers", () => {
  const event = (
    fixture: string,
    deliveryId: string,
    edit?: (p: Record<string, unknown>) => void,
  ) => {
    const { payload } = loadFixture(fixture);
    const p = structuredClone(payload) as Record<string, unknown>;
    edit?.(p);
    return { name: fixture.split(".")[0], deliveryId, id: deliveryId, payload: p } as never;
  };
  const refreshJobs = () =>
    sql<{ id: string; data: RefreshData }>`
      select id, data from pgboss.job where name = 'provenance.refresh' order by created_on`.execute(
      t.db,
    );
  const schedule = (e: never) => scheduleProvenance.handle(e, jobContext(t));
  const rerequest = (e: never) => rerequestProvenance.handle(e, jobContext(t));
  const rerequestAt = (e: never, offsetMs: number) =>
    rerequestProvenance.handle(e, {
      ...jobContext(t),
      clock: { now: () => new Date(FIXED_NOW.getTime() + offsetMs) },
    });

  it("I-CHG-5 pull_request.opened enqueues exactly one refresh job with the D6 key and writes no state", async () => {
    await schedule(event("pull_request.opened", "h-1"));
    const jobs = await refreshJobs();
    expect(jobs.rows).toHaveLength(1);
    const { payload } = loadFixture("pull_request.opened");
    const pr = payload.pull_request as {
      head: { sha: string };
      base: { ref: string };
      body: string;
      updated_at: string;
    };
    const key = refreshKey({
      repositoryId: REPO_ID,
      prNumber: 2,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      body: pr.body,
      updatedAt: pr.updated_at,
      action: "opened",
    });
    expect(key).toMatch(
      /^prov:2000001:2:[0-9a-f]{40}:master:[0-9a-f]{16}:2019-05-15T15:20:33Z:opened$/,
    );
    expect(jobs.rows[0]?.id).toBe(singletonJobId("provenance.refresh", key));
    expect(jobs.rows[0]?.data).toEqual({
      installationId: INSTALLATION_ID,
      repositoryId: REPO_ID,
      owner: OWNER,
      repo: REPO,
      prNumber: 2,
      headSha: pr.head.sha,
      trigger: "opened",
      deliveryId: "h-1",
    });
    for (const table of ["changes", "provenance", "change_provenance", "tasks"] as const) {
      expect(await t.db.selectFrom(table).selectAll().execute(), table).toEqual([]);
    }
    expect(t.deps.github).toMatchObject({});
    expect(api.requests).toHaveLength(0);
  });

  it("I-CHG-6 an edited body enqueues a second job; a replay (same body, same updated_at) is deduplicated", async () => {
    await schedule(event("pull_request.opened", "h-1"));
    await schedule(event("pull_request.opened", "h-2")); // replay under a new delivery ID: no new job
    expect(await countJobs(t.db, "provenance.refresh")).toBe(1);
    await schedule(
      event("pull_request.edited", "h-3", (p) =>
        setPath(p, "pull_request.body", "New description with Graft-Agent trailer"),
      ),
    );
    expect(await countJobs(t.db, "provenance.refresh")).toBe(2);
    // The same new body again (a replay under a fresh delivery ID) is a no-op.
    await schedule(
      event("pull_request.edited", "h-4", (p) =>
        setPath(p, "pull_request.body", "New description with Graft-Agent trailer"),
      ),
    );
    expect(await countJobs(t.db, "provenance.refresh")).toBe(2);
  });

  it("I-CHG-6b a body edited X to Y to X (new updated_at each time) enqueues a job every time; replays do not", async () => {
    const at = (n: number) => `2030-01-01T00:00:0${n}Z`;
    const ev = (id: string, body: string, n: number) =>
      event("pull_request.edited", id, (p) => {
        setPath(p, "pull_request.body", body);
        setPath(p, "pull_request.updated_at", at(n));
      });
    await schedule(ev("e-1", "body X", 1));
    await schedule(ev("e-2", "body Y", 2));
    await schedule(ev("e-3", "body X", 3)); // back to X: must not be swallowed by e-1's job
    expect(await countJobs(t.db, "provenance.refresh")).toBe(3);
    await schedule(ev("e-4", "body X", 3)); // replay of e-3 under a fresh delivery ID
    expect(await countJobs(t.db, "provenance.refresh")).toBe(3);
  });

  it("I-CHG-6c a force-push H1 to H2 to H1 enqueues a job every time; replays do not", async () => {
    const [h1, h2] = [fakeSha(0x11), fakeSha(0x22)];
    const at = (n: number) => `2030-01-01T00:00:0${n}Z`;
    const ev = (id: string, sha: string, n: number) =>
      event("pull_request.synchronize", id, (p) => {
        setPath(p, "pull_request.head.sha", sha);
        setPath(p, "pull_request.updated_at", at(n));
      });
    await schedule(ev("s-1", h1, 1));
    await schedule(ev("s-2", h2, 2));
    await schedule(ev("s-3", h1, 3)); // reverted: must not be swallowed by s-1's job
    expect(await countJobs(t.db, "provenance.refresh")).toBe(3);
    await schedule(ev("s-4", h1, 3));
    expect(await countJobs(t.db, "provenance.refresh")).toBe(3);
  });

  it("a payload without pull_request.updated_at enqueues nothing", async () => {
    await schedule(
      event("pull_request.opened", "h-1", (p) => {
        delete (p.pull_request as Record<string, unknown>).updated_at;
      }),
    );
    expect(await countJobs(t.db, "provenance.refresh")).toBe(0);
  });

  it("closed and reopened are not swallowed by an earlier job with the same head and body", async () => {
    // Real events carry a fresh pull_request.updated_at; the fixtures share one, so set it.
    const at = (n: number) => (p: Record<string, unknown>) =>
      setPath(p, "pull_request.updated_at", `2030-01-01T00:00:0${n}Z`);
    await schedule(event("pull_request.opened", "h-1", at(1)));
    await schedule(event("pull_request.closed", "h-2", at(2)));
    await schedule(event("pull_request.reopened", "h-3", at(3)));
    expect(await countJobs(t.db, "provenance.refresh")).toBe(3);
    await schedule(event("pull_request.closed", "h-4", at(2))); // replay: same body, same updated_at
    expect(await countJobs(t.db, "provenance.refresh")).toBe(3);
    await schedule(event("pull_request.closed", "h-5", at(4)));
    expect(await countJobs(t.db, "provenance.refresh")).toBe(4);
    // Same second, same head and body, different action: the action in the key keeps both.
    await schedule(event("pull_request.closed", "h-6", at(5)));
    await schedule(event("pull_request.reopened", "h-7", at(5)));
    expect(await countJobs(t.db, "provenance.refresh")).toBe(6);
  });

  it("I-CHG-7 a suspended, deleted or unknown installation gets no job", async () => {
    await t.db.updateTable("installations").set({ suspended_at: new Date() }).execute();
    await schedule(event("pull_request.opened", "h-1"));
    await t.db
      .updateTable("installations")
      .set({ suspended_at: null, deleted_at: new Date() })
      .execute();
    await schedule(event("pull_request.opened", "h-2"));
    await t.db.deleteFrom("repositories").execute();
    await t.db.deleteFrom("installations").execute();
    await schedule(event("pull_request.opened", "h-3"));
    expect(await countJobs(t.db, "provenance.refresh")).toBe(0);
  });

  it("I-PROV-11 check_run.rerequested: one job per PR per minute; other checks and apps ignored; PR found by head", async () => {
    const minute = Math.floor(FIXED_NOW.getTime() / 60_000);
    await rerequest(event("check_run.rerequested", "r-1"));
    let jobs = await refreshJobs();
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.id).toBe(
      singletonJobId("provenance.refresh", `prov-rerun:${REPO_ID}:2:${minute}`),
    );
    expect(jobs.rows[0]?.data).toMatchObject({
      prNumber: 2,
      trigger: "rerequested",
      deliveryId: "r-1",
    });

    await rerequest(event("check_run.rerequested", "r-1")); // same delivery again
    await rerequest(event("check_run.rerequested", "r-2")); // same minute, new delivery
    expect(await countJobs(t.db, "provenance.refresh")).toBe(1);
    // 60 s later the same PR may be re-run again.
    await rerequestAt(event("check_run.rerequested", "r-2b"), 60_000);
    expect(await countJobs(t.db, "provenance.refresh")).toBe(2);

    await rerequest(
      event("check_run.rerequested", "r-3", (p) => setPath(p, "check_run.name", "other")),
    );
    await rerequest(
      event("check_run.rerequested", "r-4", (p) => setPath(p, "check_run.app.id", 999)),
    );
    expect(await countJobs(t.db, "provenance.refresh")).toBe(2);

    // No pull_requests on the check run: resolved through the stored change; none stored: dropped.
    const noPrs = (p: Record<string, unknown>) => setPath(p, "check_run.pull_requests", []);
    await rerequest(event("check_run.rerequested", "r-5", noPrs));
    expect(await countJobs(t.db, "provenance.refresh")).toBe(2);
    const headSha = (loadFixture("check_run.rerequested").payload.check_run as { head_sha: string })
      .head_sha;
    await t.db
      .insertInto("changes")
      .values({
        repository_id: REPO_ID,
        pr_number: 7,
        pr_node_id: "n",
        head_sha: headSha,
        base_ref: "main",
        author_login: "x",
        state: "open",
        opened_at: new Date(),
        task_id: null,
        merge_commit_sha: null,
        closed_at: null,
        merged_at: null,
      })
      .execute();
    await rerequest(event("check_run.rerequested", "r-6", noPrs));
    jobs = await refreshJobs();
    expect(jobs.rows).toHaveLength(3);
    expect(jobs.rows.map((r) => (r.data as { prNumber: number }).prNumber)).toContain(7);
  });
});
