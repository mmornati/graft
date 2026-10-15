import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChangeSignal } from "../../src/core/signals.js";
import type { GitHubClientFactory } from "../../src/github/client-factory.js";
import { upsertChangeFromPull } from "../../src/modules/changes/index.js";
import { pollReactions, recordFeedback } from "../../src/modules/intent/feedback.js";
import { generateIntent } from "../../src/modules/intent/job.js";
import { detectIncident, scheduleIncidentDetection } from "../../src/modules/pilot/incidents.js";
import { scheduleReviewerSync, syncReviewers } from "../../src/modules/pilot/reviewers.js";
import { addIncident } from "../../src/pilot/incident-cli.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW } from "../helpers/config.js";
import { truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture } from "../helpers/fixtures.js";
import {
  fakeSha,
  INSTALLATION_ID,
  makePull,
  makeReaction,
  makeReview,
  OWNER,
  PR_AUTHOR_ID,
  PR_NUMBER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";
import { GENERATE_DATA, loadIntentScenario, scenarioLlm } from "../helpers/intent-scenario.js";
import { addReviewer } from "../helpers/pilot-seed.js";
import { jobsNamed } from "../helpers/policy-scenario.js";
import { seedWorld } from "../helpers/seed.js";

let t: TestApp;
let api: FakeGitHubApi;
let factory: GitHubClientFactory;
const github: GitHubClientFactory = {
  forInstallation: (id) => factory.forInstallation(id),
  asApp: () => factory.asApp(),
};

beforeAll(async () => {
  t = await createTestApp({ github, llm: scenarioLlm() });
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  await seedWorld(t.db);
  api = createFakeGitHubApi();
  factory = fakeGitHubFactory(api);
});

const SYNC = "pilot.reviewers.sync";
const SYNC_DATA = {
  installationId: INSTALLATION_ID,
  repositoryId: REPO_ID,
  owner: OWNER,
  repo: REPO,
  prNumber: PR_NUMBER,
};
const HOUR = 3_600_000;

async function withChange(over: Parameters<typeof makePull>[0] = {}) {
  api.state.pulls.set(PR_NUMBER, makePull(over));
  return (await upsertChangeFromPull(t.db, REPO_ID, makePull(over) as never, FIXED_NOW)).change;
}
const reviewers = () =>
  t.db
    .selectFrom("pr_reviewers")
    .select(["user_id", "reason"])
    .orderBy("reason")
    .orderBy("user_id")
    .execute();
const prEvent = (
  fixture: string,
  deliveryId: string,
  edit?: (p: Record<string, unknown>) => void,
) => {
  const p = structuredClone(loadFixture(fixture).payload) as Record<string, unknown>;
  edit?.(p);
  return { name: fixture.split(".")[0], deliveryId, id: deliveryId, payload: p } as never;
};

describe("reviewer eligibility sync", () => {
  it("I-REV-1 pull_request.review_requested enqueues one sync job; it stores the requested user", async () => {
    await withChange();
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: [{ id: 5001, login: "rev-a", type: "User" }],
      teams: [{ slug: "platform" }],
    });
    api.state.permissions.set("rev-a", { id: 5001, role: "write" });
    const e = prEvent("pull_request.labeled", "rr-1", (p) => {
      p.action = "review_requested";
    });
    await scheduleReviewerSync.handle(e, jobContext(t));
    // A redelivery under the same delivery id enqueues nothing more.
    await scheduleReviewerSync.handle(e, jobContext(t));
    const jobs = await jobsNamed(t.db, SYNC);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual(SYNC_DATA);
    expect(jobs[0]?.singleton_key).toBe(`rev-sync:${REPO_ID}:${PR_NUMBER}:rr-1`);
    // The payload is a trigger: nothing was written and GitHub was not called.
    expect(await reviewers()).toEqual([]);
    expect(api.requests).toEqual([]);

    expect(await syncReviewers(jobContext(t), SYNC_DATA)).toBe("synced");
    expect(await reviewers()).toEqual([{ user_id: 5001, reason: "requested" }]);
  });

  it("I-REV-2 a review is stored as reviewed; a second sync adds nothing and deletes nothing", async () => {
    await withChange();
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: [{ id: 5001, login: "rev-a", type: "User" }],
      teams: [],
    });
    api.state.permissions.set("rev-a", { id: 5001, role: "write" });
    api.state.permissions.set("rev-b", { id: 5002, role: "write" });
    api.state.permissions.set("rev-c", { id: 5005, role: "write" });
    api.state.permissions.set("drive-by", { id: 5004, role: "write" });
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 1, login: "rev-b", userId: 5002, state: "CHANGES_REQUESTED" }),
      // A comment alone does not make a voter eligible (anyone can comment on a public repo).
      makeReview({ id: 4, login: "drive-by", userId: 5004, state: "COMMENTED" }),
      // An approval dismissed by a push is still an approval that was given.
      makeReview({ id: 5, login: "rev-c", userId: 5005, state: "DISMISSED" }),
      makeReview({ id: 2, login: "a-bot", userId: 5003, type: "Bot" }),
    ]);
    await syncReviewers(jobContext(t), SYNC_DATA);
    expect(await reviewers()).toEqual([
      { user_id: 5001, reason: "requested" },
      { user_id: 5002, reason: "reviewed" },
      { user_id: 5005, reason: "reviewed" },
    ]);
    const first = await t.db.selectFrom("pr_reviewers").select("first_seen_at").execute();

    // The request is withdrawn and the review is gone: the union over time stays.
    api.state.requestedReviewers.set(PR_NUMBER, { users: [], teams: [] });
    api.state.reviews.set(PR_NUMBER, []);
    await syncReviewers(
      { ...jobContext(t), clock: { now: () => new Date(FIXED_NOW.getTime() + HOUR) } },
      SYNC_DATA,
    );
    expect(await reviewers()).toEqual([
      { user_id: 5001, reason: "requested" },
      { user_id: 5002, reason: "reviewed" },
      { user_id: 5005, reason: "reviewed" },
    ]);
    // first_seen_at keeps the first sighting.
    expect(await t.db.selectFrom("pr_reviewers").select("first_seen_at").execute()).toEqual(first);

    // A user who is both requested and reviewed has both rows.
    api.state.reviews.set(PR_NUMBER, [makeReview({ id: 3, login: "rev-a", userId: 5001 })]);
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: [{ id: 5001, login: "rev-a", type: "User" }],
      teams: [],
    });
    await syncReviewers(jobContext(t), SYNC_DATA);
    expect((await reviewers()).filter((r) => r.user_id === 5001).map((r) => r.reason)).toEqual([
      "requested",
      "reviewed",
    ]);
  });

  /** A published card with its check run: the button vote needs both. */
  async function publishedCardAndRun() {
    loadIntentScenario(api);
    await generateIntent(GENERATE_DATA, jobContext(t));
    const run = api.state.checkRuns.find((r) => r.name === "graft/intent");
    if (!run) throw new Error("no check run");
    return run;
  }
  const vote = (checkRunId: number, userId: number, deliveryId: string) => ({
    installationId: INSTALLATION_ID,
    repositoryId: REPO_ID,
    owner: OWNER,
    repo: REPO,
    checkRunId,
    verdict: "up" as const,
    userId,
    userLogin: `reviewer-${userId}`,
    deliveryId,
  });

  it("I-REV-3 a button vote emits feedback_recorded: one sync job per change per hour, and no policy.evaluate", async () => {
    const run = await publishedCardAndRun();
    const policyJobs = (await jobsNamed(t.db, "policy.evaluate")).length;
    expect(await jobsNamed(t.db, SYNC)).toHaveLength(0);

    expect(await recordFeedback(vote(run.id, 5001, "v1"), jobContext(t))).toBe("recorded");
    expect(await recordFeedback(vote(run.id, 5002, "v2"), jobContext(t))).toBe("recorded");
    const jobs = await jobsNamed(t.db, SYNC);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual(SYNC_DATA);
    expect(jobs[0]?.singleton_key).toBe(
      `rev-sync:${REPO_ID}:${PR_NUMBER}:${Math.floor(FIXED_NOW.getTime() / HOUR)}`,
    );
    // The policy module does not react to a vote.
    expect(await jobsNamed(t.db, "policy.evaluate")).toHaveLength(policyJobs);

    // The next hour is a new window.
    const later = { ...jobContext(t), clock: { now: () => new Date(FIXED_NOW.getTime() + HOUR) } };
    expect(await recordFeedback(vote(run.id, 5003, "v3"), later)).toBe("recorded");
    expect(await jobsNamed(t.db, SYNC)).toHaveLength(2);
    expect(await jobsNamed(t.db, "policy.evaluate")).toHaveLength(policyJobs);
  });

  it("I-REV-4 a reaction poll that writes rows emits the signal; a poll that writes nothing does not", async () => {
    await publishedCardAndRun();
    const commentId = api.state.comments[0]?.id as number;
    const seen: ChangeSignal[] = [];
    const ctx = {
      ...jobContext(t),
      signals: {
        emit: async (s: ChangeSignal) => {
          seen.push(s);
        },
      },
    };
    const change = await t.db.selectFrom("changes").selectAll().executeTakeFirstOrThrow();
    const data = { ...SYNC_DATA, changeId: change.id } as const;
    const { prNumber: _pr, ...poll } = data;

    api.state.reactions.set(commentId, []);
    expect(await pollReactions(poll, ctx)).toBe(0);
    expect(seen).toEqual([]);

    api.state.reactions.set(commentId, [
      makeReaction(1, "reviewer-1", "+1", new Date(FIXED_NOW.getTime() + 60_000).toISOString()),
    ]);
    expect(await pollReactions(poll, ctx)).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "feedback_recorded",
      installationId: INSTALLATION_ID,
      repositoryId: REPO_ID,
      owner: OWNER,
      repo: REPO,
      prNumber: PR_NUMBER,
      changeId: change.id,
    });
    // A poll that finds nothing again writes nothing (the reaction was withdrawn): no signal.
    api.state.reactions.set(commentId, []);
    expect(await pollReactions(poll, ctx)).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("I-REV-5 a suspended installation makes no GitHub call; a 404 on the PR is permanent and stores nothing", async () => {
    await withChange();
    await t.db.updateTable("installations").set({ suspended_at: new Date() }).execute();
    expect(await syncReviewers(jobContext(t), SYNC_DATA)).toBe("skipped");
    expect(api.requests).toEqual([]);
    expect(await reviewers()).toEqual([]);

    await t.db.updateTable("installations").set({ suspended_at: null }).execute();
    api.state.pulls.delete(PR_NUMBER);
    await expect(syncReviewers(jobContext(t), SYNC_DATA)).rejects.toBeInstanceOf(PermanentJobError);
    expect(await reviewers()).toEqual([]);
    // No change row yet: nothing to attach reviewers to, and no call either.
    api.requests.length = 0;
    await t.db.deleteFrom("changes").execute();
    expect(await syncReviewers(jobContext(t), SYNC_DATA)).toBe("skipped");
    expect(api.requests).toEqual([]);
  });

  /** Every `pr_reviewers` row with its verified flag. */
  const rows = () =>
    t.db
      .selectFrom("pr_reviewers")
      .select(["user_id", "reason", "verified"])
      .orderBy("reason")
      .orderBy("user_id")
      .execute();
  const permissionCalls = () =>
    api.requests.filter((r) => /\/collaborators\/[^/]+\/permission$/.test(r.path));

  it("I-REV-6 an outsider's APPROVED or CHANGES_REQUESTED review on a public repo is not eligible; a member's, owner's and collaborator's are", async () => {
    await withChange();
    for (const [login, id] of [
      ["outsider", 6001],
      ["contributor", 6002],
      ["first-timer", 6003],
      ["collab", 6004],
      ["member", 6005],
      ["owner", 6006],
      ["member-2", 6007],
    ] as const) {
      // Everyone has write access here: only the association tells them apart.
      api.state.permissions.set(login, { id, role: "write" });
    }
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 1, login: "outsider", userId: 6001, association: "NONE" }),
      makeReview({
        id: 2,
        login: "contributor",
        userId: 6002,
        association: "CONTRIBUTOR",
        state: "CHANGES_REQUESTED",
      }),
      makeReview({
        id: 3,
        login: "first-timer",
        userId: 6003,
        association: "FIRST_TIME_CONTRIBUTOR",
      }),
      makeReview({ id: 4, login: "collab", userId: 6004, association: "COLLABORATOR" }),
      makeReview({
        id: 5,
        login: "member",
        userId: 6005,
        association: "MEMBER",
        state: "DISMISSED",
      }),
      makeReview({ id: 6, login: "owner", userId: 6006, association: "OWNER" }),
      // A member's comment is still only a comment.
      makeReview({
        id: 7,
        login: "member-2",
        userId: 6007,
        association: "MEMBER",
        state: "COMMENTED",
      }),
    ]);
    await syncReviewers(jobContext(t), SYNC_DATA);
    expect(await rows()).toEqual([
      { user_id: 6004, reason: "reviewed", verified: true },
      { user_id: 6005, reason: "reviewed", verified: true },
      { user_id: 6006, reason: "reviewed", verified: true },
    ]);
  });

  it("I-REV-7 a requested user needs triage or higher: write, maintain, admin and triage pass; read, a 404 and a 403 do not", async () => {
    await withChange();
    const users = [
      ["u-admin", 7001, "admin"],
      ["u-maintain", 7002, "maintain"],
      ["u-write", 7003, "write"],
      ["u-triage", 7004, "triage"],
      ["u-read", 7005, "read"],
      ["u-none", 7006, "none"],
      ["u-missing", 7007, null],
      ["u-forbidden", 7008, "write"],
      ["u-sock", 7009, "write"],
    ] as const;
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: users.map(([login, id]) => ({ id, login, type: "User" })),
      teams: [],
    });
    for (const [login, id, role] of users) {
      if (role !== null) api.state.permissions.set(login, { id, role });
    }
    // The login now belongs to someone else: the permission answer is for another account.
    api.state.permissions.set("u-sock", { id: 99999, role: "write" });
    api.failNext("GET", /\/collaborators\/u-forbidden\/permission$/, 403);
    await syncReviewers(jobContext(t), SYNC_DATA);
    expect((await rows()).map((r) => r.user_id)).toEqual([7001, 7002, 7003, 7004]);
    expect((await rows()).every((r) => r.reason === "requested" && r.verified)).toBe(true);
    // One permission request per distinct user.
    expect(permissionCalls()).toHaveLength(users.length);
  });

  it("I-REV-8 a rate limit or a 5xx on the permission check retries the job and stores nothing; the retry succeeds", async () => {
    await withChange();
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: [
        { id: 8001, login: "ok-user", type: "User" },
        { id: 8002, login: "flaky", type: "User" },
      ],
      teams: [],
    });
    api.state.permissions.set("ok-user", { id: 8001, role: "write" });
    api.state.permissions.set("flaky", { id: 8002, role: "write" });
    api.failNext("GET", /\/collaborators\/flaky\/permission$/, 502);
    const transient = await syncReviewers(jobContext(t), SYNC_DATA).catch((e: unknown) => e);
    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toBeInstanceOf(PermanentJobError);
    api.failNext("GET", /\/collaborators\/flaky\/permission$/, 403, {
      "x-ratelimit-remaining": "0",
      "retry-after": "60",
    });
    const limited = await syncReviewers(jobContext(t), SYNC_DATA).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(Error);
    expect(limited).not.toBeInstanceOf(PermanentJobError);
    // Nothing was stored by the failed attempts: no half-verified state.
    expect(await rows()).toEqual([]);
    expect(await syncReviewers(jobContext(t), SYNC_DATA)).toBe("synced");
    expect((await rows()).map((r) => r.user_id)).toEqual([8001, 8002]);
  });

  it("I-REV-9 legacy rows are unverified: a sync promotes the ones that pass the checks and leaves the others unverified", async () => {
    const change = await withChange();
    for (const [userId, reason] of [
      [9001, "requested"],
      [9002, "reviewed"],
      [9003, "reviewed"],
    ] as const) {
      await addReviewer(t.db, { changeId: change.id, userId, reason, verified: false });
    }
    expect((await rows()).every((r) => !r.verified)).toBe(true);
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: [{ id: 9001, login: "legacy-ok", type: "User" }],
      teams: [],
    });
    api.state.permissions.set("legacy-ok", { id: 9001, role: "triage" });
    api.state.permissions.set("legacy-member", { id: 9002, role: "write" });
    api.state.permissions.set("legacy-outsider", { id: 9003, role: "write" });
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 1, login: "legacy-member", userId: 9002, association: "MEMBER" }),
      makeReview({ id: 2, login: "legacy-outsider", userId: 9003, association: "NONE" }),
    ]);
    await syncReviewers(jobContext(t), SYNC_DATA);
    expect(await rows()).toEqual([
      { user_id: 9001, reason: "requested", verified: true },
      { user_id: 9002, reason: "reviewed", verified: true },
      { user_id: 9003, reason: "reviewed", verified: false },
    ]);
  });

  it("I-REV-10 custom roles: judged by their base permission. A role built on write passes; one built on triage or read fails; a role named Triage is not the built-in", async () => {
    await withChange();
    const cases = [
      ["custom-write", 7101, "release-manager", "write", true],
      ["custom-maintain", 7102, "release-lead", "write", true],
      ["custom-triage", 7103, "triager-plus", "read", false],
      ["custom-read", 7104, "auditor", "read", false],
      ["case-trick", 7105, "Triage", "read", false],
      ["builtin-triage", 7106, "triage", "read", true],
    ] as const;
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: cases.map(([login, id]) => ({ id, login, type: "User" })),
      teams: [],
    });
    for (const [login, id, role, permission] of cases) {
      api.state.permissions.set(login, { id, role, permission });
    }
    await syncReviewers(jobContext(t), SYNC_DATA);
    expect((await rows()).map((r) => r.user_id)).toEqual(
      cases.filter((c) => c[4]).map((c) => c[1]),
    );
  });

  it("I-REV-11 review authors need triage-or-higher too: a MEMBER or COLLABORATOR with read only is not eligible, one with write is; one check per user", async () => {
    await withChange();
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 1, login: "org-member-read", userId: 7201, association: "MEMBER" }),
      makeReview({ id: 2, login: "org-member-write", userId: 7202, association: "MEMBER" }),
      makeReview({ id: 3, login: "collab-read", userId: 7203, association: "COLLABORATOR" }),
      makeReview({ id: 4, login: "collab-triage", userId: 7204, association: "COLLABORATOR" }),
      // Two reviews by the same user, who is also requested: one permission check.
      makeReview({ id: 5, login: "org-member-write", userId: 7202, association: "MEMBER" }),
    ]);
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: [{ id: 7202, login: "org-member-write", type: "User" }],
      teams: [],
    });
    api.state.permissions.set("org-member-read", { id: 7201, role: "read" });
    api.state.permissions.set("org-member-write", { id: 7202, role: "write" });
    api.state.permissions.set("collab-read", { id: 7203, role: "read" });
    api.state.permissions.set("collab-triage", { id: 7204, role: "triage" });
    await syncReviewers(jobContext(t), SYNC_DATA);
    expect(await rows()).toEqual([
      { user_id: 7202, reason: "requested", verified: true },
      { user_id: 7202, reason: "reviewed", verified: true },
      { user_id: 7204, reason: "reviewed", verified: true },
    ]);
    expect(permissionCalls()).toHaveLength(4);
  });

  it("I-REV-12 a 403 or 404 on the permission check is logged (status and route only) and recorded by id; a later pass clears it", async () => {
    await withChange();
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: [
        { id: 7301, login: "login-secret-a", type: "User" },
        { id: 7302, login: "login-secret-b", type: "User" },
      ],
      teams: [],
    });
    api.state.permissions.set("login-secret-a", { id: 7301, role: "write" });
    api.state.permissions.set("login-secret-b", { id: 7302, role: "write" });
    api.failNext("GET", /\/collaborators\/login-secret-a\/permission$/, 403);
    api.failNext("GET", /\/collaborators\/login-secret-b\/permission$/, 404);
    const logged: { level: string; obj: unknown; msg: string }[] = [];
    const rec =
      (level: string) =>
      (obj: unknown, msg?: string): void => {
        logged.push({ level, obj, msg: msg ?? "" });
      };
    const log = { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") };
    const ctx = { ...jobContext(t), log: log as never };
    await syncReviewers(ctx, SYNC_DATA);
    expect(await rows()).toEqual([]);
    const denials = () =>
      t.db
        .selectFrom("reviewer_check_denials")
        .select(["user_id", "status"])
        .orderBy("user_id")
        .execute();
    expect(await denials()).toEqual([
      { user_id: 7301, status: 403 },
      { user_id: 7302, status: 404 },
    ]);
    const warns = logged.filter((l) => l.level === "warn");
    expect(warns.map((w) => (w.obj as { status: number }).status).sort()).toEqual([403, 404]);
    expect(JSON.stringify(logged)).not.toContain("login-secret");
    expect(JSON.stringify(warns)).toContain("collaborators/{username}/permission");
    const info = logged.find((l) => l.level === "info")?.obj as Record<string, number>;
    expect(info).toMatchObject({ permissionForbidden: 1, permissionNotFound: 1 });

    // The next sync passes (the permission was fixed): nothing is denied any more.
    await syncReviewers(jobContext(t), SYNC_DATA);
    expect(await denials()).toEqual([]);
    expect((await rows()).map((r) => r.user_id)).toEqual([7301, 7302]);
  });

  it("I-REV-13 the change row stores the PR author's user id (the author is excluded by id, not login)", async () => {
    const change = await withChange();
    expect(change.author_id).toBe(PR_AUTHOR_ID);
    // A later snapshot with a renamed author keeps the id.
    const renamed = makePull({ user: { id: PR_AUTHOR_ID, login: "renamed", type: "User" } });
    const res = await upsertChangeFromPull(t.db, REPO_ID, renamed as never, FIXED_NOW);
    expect(res.change).toMatchObject({ author_id: PR_AUTHOR_ID, author_login: "renamed" });
  });
});

const INCIDENT_DATA = SYNC_DATA;
/** Culprit PRs that Graft knows were merged before the fix PR (created 2026-10-12T08:00). */
async function mergedCulprits(...numbers: number[]) {
  for (const n of numbers) {
    await t.db
      .insertInto("changes")
      .values({
        repository_id: REPO_ID,
        pr_number: n,
        pr_node_id: `n${n}`,
        task_id: null,
        head_sha: fakeSha(n),
        base_ref: "main",
        author_login: "x",
        state: "merged",
        merge_commit_sha: fakeSha(n + 1000),
        opened_at: new Date("2026-10-01T00:00:00Z"),
        closed_at: new Date("2026-10-02T00:00:00Z"),
        merged_at: new Date("2026-10-02T00:00:00Z"),
      })
      .execute();
  }
}
const incidents = () =>
  t.db
    .selectFrom("incidents")
    .select(["id", "culprit_pr_number", "fix_pr_number", "source", "occurred_at"])
    .orderBy("culprit_pr_number")
    .execute();

describe("incident detection", () => {
  const live = (body: string | null, labels = ["incident"]) =>
    makePull({
      body,
      labels: labels.map((name) => ({ name })),
      created_at: "2026-10-12T08:00:00Z",
    });

  it("I-INC-1 a labeled revert PR names its culprit; a replay is still one incident", async () => {
    await mergedCulprits(7);
    api.state.pulls.set(PR_NUMBER, live(`Reverts ${OWNER}/${REPO}#7\n\nBecause.`));
    const e = prEvent("pull_request.labeled", "inc-1", (p) => {
      p.label = { name: "Incident" };
      (p.pull_request as Record<string, unknown>).updated_at = "2026-10-12T09:00:00Z";
    });
    await scheduleIncidentDetection.handle(e, jobContext(t));
    // The same body under a new delivery id has the same job key.
    await scheduleIncidentDetection.handle(
      { ...(e as object), deliveryId: "inc-2" } as never,
      jobContext(t),
    );
    const jobs = await jobsNamed(t.db, "pilot.incident.detect");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.singleton_key).toBe(`inc:${REPO_ID}:${PR_NUMBER}:2026-10-12T09:00:00Z`);

    expect(await detectIncident(INCIDENT_DATA, jobContext(t))).toBe("recorded");
    const rows = await incidents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      culprit_pr_number: 7,
      fix_pr_number: PR_NUMBER,
      source: "label",
    });
    expect(rows[0]?.occurred_at).toEqual(new Date("2026-10-12T08:00:00Z"));
    expect(await detectIncident(INCIDENT_DATA, jobContext(t))).toBe("recorded");
    expect(await incidents()).toHaveLength(1);

    // The live PR must carry the label; without it nothing is recorded.
    await t.db.deleteFrom("incidents").execute();
    api.state.pulls.set(PR_NUMBER, live(`Reverts ${OWNER}/${REPO}#7`, ["bug"]));
    expect(await detectIncident(INCIDENT_DATA, jobContext(t))).toBe("skipped");
    expect(await incidents()).toEqual([]);
  });

  it("I-INC-2 a label without a link is one row with no culprit; incident add --fix-pr fills it in place", async () => {
    api.state.pulls.set(PR_NUMBER, live("No link here."));
    await detectIncident(INCIDENT_DATA, jobContext(t));
    const [row] = await incidents();
    expect(row).toMatchObject({ culprit_pr_number: null, fix_pr_number: PR_NUMBER });
    await detectIncident(INCIDENT_DATA, jobContext(t));
    expect(await incidents()).toHaveLength(1);

    const res = await addIncident(t.db, FIXED_NOW, {
      repo: `${OWNER}/${REPO}`,
      pr: 7,
      fixPr: PR_NUMBER,
      severity: 2,
    });
    expect(res.outcome).toBe("updated");
    expect(res.id).toBe(row?.id);
    const after = await incidents();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: row?.id, culprit_pr_number: 7, fix_pr_number: PR_NUMBER });
    expect((await t.db.selectFrom("incidents").select("severity").execute())[0]?.severity).toBe(2);

    // A link added to the body later replaces an unlinked label row, too.
    await t.db.deleteFrom("incidents").execute();
    api.state.pulls.set(PR_NUMBER, live("No link here."));
    await detectIncident(INCIDENT_DATA, jobContext(t));
    await mergedCulprits(9);
    api.state.pulls.set(PR_NUMBER, live(`Graft-Culprit: #9`));
    await detectIncident(INCIDENT_DATA, jobContext(t));
    expect((await incidents()).map((r) => r.culprit_pr_number)).toEqual([9]);
  });

  it("I-INC-3 the payload's body is ignored: the live body decides the culprit", async () => {
    await mergedCulprits(9);
    api.state.pulls.set(PR_NUMBER, live(`Reverts ${OWNER}/${REPO}#9`));
    const e = prEvent("pull_request.labeled", "inc-3", (p) => {
      p.label = { name: "incident" };
      (p.pull_request as Record<string, unknown>).body = `Reverts ${OWNER}/${REPO}#7`;
    });
    await scheduleIncidentDetection.handle(e, jobContext(t));
    const [job] = await jobsNamed(t.db, "pilot.incident.detect");
    // The job data holds ids only, not the body.
    expect(JSON.stringify(job?.data)).not.toContain("Reverts");
    await detectIncident(job?.data as typeof INCIDENT_DATA, jobContext(t));
    expect((await incidents()).map((r) => r.culprit_pr_number)).toEqual([9]);
  });

  it("a framed culprit is dropped: it must be a PR merged into this repository before the fix PR", async () => {
    // 7 is unknown, 8 is merged after the fix PR was opened, 9 is open, 10 is fine.
    await mergedCulprits(10);
    await t.db
      .insertInto("changes")
      .values(
        [
          { pr_number: 8, state: "merged" as const, merged_at: new Date("2026-10-13T00:00:00Z") },
          { pr_number: 9, state: "open" as const, merged_at: null },
        ].map((c) => ({
          repository_id: REPO_ID,
          pr_number: c.pr_number,
          pr_node_id: `n${c.pr_number}`,
          task_id: null,
          head_sha: fakeSha(c.pr_number),
          base_ref: "main",
          author_login: "x",
          state: c.state,
          merge_commit_sha: null,
          opened_at: new Date("2026-10-01T00:00:00Z"),
          closed_at: null,
          merged_at: c.merged_at,
        })),
      )
      .execute();
    api.state.pulls.set(
      PR_NUMBER,
      live("Graft-Culprit: #7\nGraft-Culprit: #8\nGraft-Culprit: #9\nGraft-Culprit: #10"),
    );
    await detectIncident(INCIDENT_DATA, jobContext(t));
    expect((await incidents()).map((r) => r.culprit_pr_number)).toEqual([10]);
    // When none survives, the label is still recorded, without a culprit.
    await t.db.deleteFrom("incidents").execute();
    api.state.pulls.set(PR_NUMBER, live("Graft-Culprit: #7\nGraft-Culprit: #9"));
    await detectIncident(INCIDENT_DATA, jobContext(t));
    expect((await incidents()).map((r) => r.culprit_pr_number)).toEqual([null]);
  });

  it("a merged PR that carries the label also triggers detection; an unmerged close does not", async () => {
    const merged = prEvent("pull_request.closed", "inc-m", (p) => {
      const pr = p.pull_request as Record<string, unknown>;
      pr.merged = true;
      pr.labels = [{ name: "incident" }];
    });
    await scheduleIncidentDetection.handle(merged, jobContext(t));
    expect(await jobsNamed(t.db, "pilot.incident.detect")).toHaveLength(1);
    const unmerged = prEvent("pull_request.closed", "inc-u", (p) => {
      const pr = p.pull_request as Record<string, unknown>;
      pr.merged = false;
      pr.labels = [{ name: "incident" }];
      pr.updated_at = "2026-10-13T09:00:00Z";
    });
    await scheduleIncidentDetection.handle(unmerged, jobContext(t));
    expect(await jobsNamed(t.db, "pilot.incident.detect")).toHaveLength(1);
    void sql;
  });
});
