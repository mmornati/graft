/**
 * The post-merge guard (Phase 1 step 4) against the in-memory GitHub API: history, results,
 * detection, confirmation, the comment, the CLI, retention and purge.
 */
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import type { JobContext } from "../../src/core/context.js";
import { migrateDownOne, migrateToLatest } from "../../src/db/migrator.js";
import { upsertChangeFromPull } from "../../src/modules/changes/index.js";
import { ENFORCE_LINE, REPORT_LINE } from "../../src/modules/guard/comment.js";
import {
  guardCheckRun,
  guardCheckSuite,
  guardPush,
  guardStatus,
} from "../../src/modules/guard/handlers.js";
import {
  confirmEvent,
  guardPruneJob,
  observeCommit,
  publishGuardComment,
  trackDefaultBranch,
} from "../../src/modules/guard/index.js";
import { runDoctor } from "../../src/pilot/doctor.js";
import { purgeInstallation } from "../../src/pilot/purge.js";
import { clearPolicyCache } from "../../src/policy/load.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { FakeJobQueue } from "../helpers/fake-queue.js";
import { loadFixture } from "../helpers/fixtures.js";
import {
  fakeSha,
  INSTALLATION_ID,
  makePull,
  OWNER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";
import { putContent } from "../helpers/policy-scenario.js";
import { seedWorld } from "../helpers/seed.js";

const FULL_NAME = `${OWNER}/${REPO}`;
const ACTIONS = 15368;
const IDS = { installationId: INSTALLATION_ID, repositoryId: REPO_ID, owner: OWNER, repo: REPO };
const C = (n: number) => fakeSha(0xc000 + n);
const TEST_KEY = `run:${ACTIONS}:test`;

let t: TestApp;
let api: FakeGitHubApi;
let now = new Date(FIXED_NOW);

const ctx = (over: Record<string, string> = {}): JobContext => ({
  ...jobContext(t),
  config: testConfig(over),
  clock: { now: () => new Date(now) },
});

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await truncateAll(t.db);
  await seedWorld(t.db);
  clearPolicyCache();
  now = new Date(FIXED_NOW);
  api = createFakeGitHubApi();
  t.deps.github = fakeGitHubFactory(api);
});

/** C1 (root) <- C2 <- ... <- Cn. */
function history(n: number, from = 1): void {
  for (let k = from; k <= n; k++) {
    api.state.history.set(C(k), { parents: k === 1 ? [] : [C(k - 1)] });
  }
}

function run(
  sha: string,
  name: string,
  conclusion: string | null,
  o: { app?: number; at?: Date; suite?: number } = {},
): void {
  const id = api.state.nextId++;
  api.state.checkRuns.push({
    ...(o.suite === undefined ? {} : { check_suite: { id: o.suite } }),
    id,
    name,
    head_sha: sha,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    external_id: "",
    output: { title: "", summary: "" },
    app: { id: o.app ?? ACTIONS },
    completed_at: conclusion === null ? null : (o.at ?? now).toISOString(),
    html_url: `https://github.com/${FULL_NAME}/runs/${id}`,
  });
}

function mergedPull(n: number, ...shas: string[]): void {
  api.state.pulls.set(
    n,
    makePull({
      number: n,
      node_id: `PR_fake${n}`,
      state: "closed",
      merged: true,
      merge_commit_sha: shas.at(-1) ?? null,
      merged_at: "2026-10-14T11:00:00Z",
      closed_at: "2026-10-14T11:00:00Z",
      head: { sha: fakeSha(0xd000 + n) },
    }),
  );
  for (const sha of shas) api.state.commitPulls.set(sha, [n]);
}

const track = (
  after: string,
  before: string | null,
  o: { forced?: boolean; branch?: string; config?: Record<string, string> } = {},
) =>
  trackDefaultBranch(
    { ...IDS, branch: o.branch ?? "main", after, before, forced: o.forced ?? false },
    ctx(o.config),
  );
const observe = (sha: string, config?: Record<string, string>) =>
  observeCommit({ ...IDS, sha }, ctx(config));
const events = () => t.db.selectFrom("guard_events").selectAll().orderBy("created_at").execute();
const comments = () => api.find("POST", /\/issues\/\d+\/comments$/);
const writes = () => api.requests.filter((r) => r.method !== "GET");
const advance = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
};

/** C1 green, C2 = PR 7 red, C3 = PR 8 tracked. Leaves one `confirming` event at C2. */
async function confirming(over: Record<string, string> = {}): Promise<string> {
  history(3);
  mergedPull(7, C(2));
  mergedPull(8, C(3));
  await track(C(3), null);
  run(C(1), "test", "success");
  await observe(C(1), over);
  advance(60);
  run(C(2), "test", "failure");
  await observe(C(2), over);
  const [e] = await events();
  if (!e) throw new Error("no event");
  return e.id;
}

const jobs = async (name: string) =>
  (
    await sql<{ data: unknown; singleton_key: string | null; start_after: Date }>`
      select data, singleton_key, start_after from pgboss.job where name = ${name}`.execute(t.db)
  ).rows;

const ops = async (argv: string[], over: Record<string, string> = {}) => {
  let out = "";
  let err = "";
  const deps: OpsDeps = {
    loadConfig: () => testConfig(over),
    openDb: () => testDb(),
    github: () => fakeGitHubFactory(api),
    now: () => now,
    sleep: async () => {},
  };
  const code = await opsMain(argv, { out: (s) => (out += s), err: (s) => (err += s) }, deps);
  return { code, out, err };
};

const event = (name: string, payload: unknown) =>
  ({ id: `d-${name}`, name, payload, deliveryId: `d-${name}` }) as never;

describe("guard: schema", () => {
  it("I-GRD-1 migration 0011 up, down, up; down restores the old status check and fails on a new status", async () => {
    // Step 3 review 1's migration sits on top of 0011.
    expect(await migrateDownOne(t.db)).toEqual(["0012_audit_label_event"]);
    expect(await migrateDownOne(t.db)).toEqual(["0011_guard"]);
    try {
      const tables = await sql<{ n: string }>`
        select count(*)::text as n from information_schema.tables
        where table_name in ('main_commits', 'ci_results')`.execute(t.db);
      expect(tables.rows[0]?.n).toBe("0");
      const cols = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_name = 'guard_events' and column_name in
          ('last_green_sha','failing_checks','candidates','detected_at','confirmed_at',
           'confirm_reason','comment_id','guard_mode')`.execute(t.db);
      expect(cols.rows).toEqual([]);
      await expect(
        sql`insert into guard_events (repository_id, branch, failing_sha, status)
          values (${REPO_ID}, 'main', ${C(1)}, 'confirming')`.execute(t.db),
      ).rejects.toThrow(/check constraint/);
    } finally {
      expect(await migrateToLatest(t.db)).toEqual(["0011_guard", "0012_audit_label_event"]);
    }
    // A row with a new status blocks the rollback.
    await sql`insert into guard_events (repository_id, branch, failing_sha, status)
      values (${REPO_ID}, 'main', ${C(1)}, 'flaky')`.execute(t.db);
    expect(await migrateDownOne(t.db)).toEqual(["0012_audit_label_event"]);
    try {
      await expect(migrateDownOne(t.db)).rejects.toThrow();
    } finally {
      expect(await migrateToLatest(t.db)).toEqual(["0012_audit_label_event"]);
    }
    await t.db.deleteFrom("guard_events").execute();
    expect(await migrateDownOne(t.db)).toEqual(["0012_audit_label_event"]);
    expect(await migrateDownOne(t.db)).toEqual(["0011_guard"]);
    expect(await migrateToLatest(t.db)).toEqual(["0011_guard", "0012_audit_label_event"]);
    const def = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'guard_events_status_check'`.execute(t.db);
    expect(def.rows[0]?.def).toContain("confirming");
  });
});

describe("guard: history", () => {
  it("I-GRD-2 a push to the default branch stores first parents and seq; another branch stores nothing; a forced push is a chain break", async () => {
    history(3);
    expect(await track(C(3), C(1))).toBe("tracked");
    const rows = () => t.db.selectFrom("main_commits").selectAll().orderBy("seq").execute();
    expect((await rows()).map((r) => [r.sha, r.parent_sha, r.seq, r.chain_break])).toEqual([
      // `before` (C1) is unknown to Graft: the oldest new commit is a break.
      [C(2), C(1), 1, true],
      [C(3), C(2), 2, false],
    ]);
    history(4, 4);
    expect(await track(C(4), C(3))).toBe("tracked");
    expect((await rows()).at(-1)).toMatchObject({
      sha: C(4),
      parent_sha: C(3),
      seq: 3,
      chain_break: false,
    });

    // Another branch: the job stops, and the handler enqueues nothing.
    expect(await track(C(4), C(3), { branch: "feature" })).toBe("not_default_branch");
    const queue = new FakeJobQueue();
    const push = loadFixture("push.default").payload as Record<string, unknown>;
    push.ref = "refs/heads/feature";
    await guardPush.handle(event("push", push), { ...ctx(), queue });
    expect(queue.sent).toEqual([]);
    push.ref = "refs/heads/main";
    await guardPush.handle(event("push", push), { ...ctx(), queue });
    expect(queue.sent.map((s) => s.name)).toEqual(["guard.track"]);

    // A forced push onto C3: the new commit is a break even though its parent is known.
    api.state.history.set(C(6), { parents: [C(3)] });
    expect(await track(C(6), C(4), { forced: true })).toBe("tracked");
    expect((await rows()).at(-1)).toMatchObject({
      sha: C(6),
      parent_sha: C(3),
      seq: 4,
      chain_break: true,
    });
    // Moving back to a stored commit stores nothing (rewound).
    expect(await track(C(4), C(6), { forced: true })).toBe("rewound");
    expect(await rows()).toHaveLength(4);
    // No commit message is stored anywhere.
    const dump = JSON.stringify(await rows());
    expect(dump).not.toContain("GRAFT_CANARY");
  });

  it("I-GRD-3 commit to PR: from changes, from the API for a rebase merge, direct push, two PRs, and the 20-lookup bound", async () => {
    history(6);
    const five = makePull({
      number: 5,
      node_id: "PR_fake5",
      state: "closed",
      merged: true,
      merge_commit_sha: C(2),
      merged_at: "2026-10-14T10:00:00Z",
      closed_at: "2026-10-14T10:00:00Z",
    });
    await upsertChangeFromPull(t.db, REPO_ID, five, FIXED_NOW);
    mergedPull(9, C(3), C(4));
    mergedPull(10, C(6));
    mergedPull(11);
    api.state.commitPulls.set(C(6), [10, 11]);
    // D6: a PR merged into another branch (C5 was also merged into `release`) is not a culprit.
    const release = makePull({ number: 12, node_id: "PR_fake12" });
    api.state.pulls.set(12, {
      ...release,
      state: "closed",
      merged: true,
      merged_at: "2026-10-14T11:00:00Z",
      closed_at: "2026-10-14T11:00:00Z",
      base: { ...release.base, ref: "release" },
    });
    api.state.commitPulls.set(C(5), [12]);
    await track(C(6), null);
    const rows = await t.db.selectFrom("main_commits").selectAll().orderBy("seq").execute();
    expect(rows.map((r) => [r.sha, r.pr_source, r.pr_number])).toEqual([
      [C(1), "direct", null],
      [C(2), "change", 5],
      [C(3), "api", 9],
      [C(4), "api", 9],
      [C(5), "direct", null],
      [C(6), "multiple", null],
    ]);
    // The API-mapped PR has a changes row now.
    const nine = await t.db
      .selectFrom("changes")
      .select(["id", "state"])
      .where("pr_number", "=", 9)
      .executeTakeFirstOrThrow();
    expect(nine.state).toBe("merged");
    expect(rows[2]?.change_id).toBe(nine.id);
    // C2 came from `changes`: no lookup for it.
    expect(api.find("GET", new RegExp(`/commits/${C(2)}/pulls$`))).toEqual([]);

    // 21 unknown commits: 20 lookups, the oldest is unresolved.
    const D = (n: number) => fakeSha(0xe000 + n);
    for (let k = 1; k <= 21; k++) {
      api.state.history.set(D(k), { parents: [k === 1 ? C(6) : D(k - 1)] });
    }
    const before = api.find("GET", /\/commits\/[0-9a-f]{40}\/pulls$/).length;
    await track(D(21), C(6));
    expect(api.find("GET", /\/commits\/[0-9a-f]{40}\/pulls$/).length - before).toBe(20);
    const d = await t.db
      .selectFrom("main_commits")
      .select(["sha", "pr_source"])
      .where(
        "sha",
        "in",
        Array.from({ length: 21 }, (_, i) => D(i + 1)),
      )
      .execute();
    expect(d.filter((r) => r.pr_source === "unresolved").map((r) => r.sha)).toEqual([D(1)]);
    expect(d.filter((r) => r.pr_source === "direct")).toHaveLength(20);
  });
});

describe("guard: triggers", () => {
  it("I-GRD-4 a PR-branch check_run enqueues nothing; a default-branch one enqueues one observe after the delay; 20 within 30 s are one job", async () => {
    const payload = loadFixture("check_run.completed").payload as {
      check_run: { app: { id: number }; check_suite: { head_branch: string } };
    };
    payload.check_run.check_suite.head_branch = "feature";
    await guardCheckRun.handle(event("check_run", payload), ctx());
    expect(await jobs("guard.observe")).toEqual([]);
    // Graft's own check runs never trigger.
    payload.check_run.check_suite.head_branch = "main";
    payload.check_run.app.id = 12345;
    await guardCheckRun.handle(event("check_run", payload), ctx());
    expect(await jobs("guard.observe")).toEqual([]);

    payload.check_run.app.id = ACTIONS;
    for (let i = 0; i < 20; i++) {
      await guardCheckRun.handle(event("check_run", payload), ctx());
      advance(1);
    }
    const queued = await jobs("guard.observe");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data).toEqual({ ...IDS, sha: "1".repeat(40) });
    const late = await sql<{ n: string }>`
      select count(*)::text as n from pgboss.job
      where name = 'guard.observe' and start_after > now() + interval '20 seconds'`.execute(t.db);
    expect(late.rows[0]?.n).toBe("1");

    // The next window has its own job; check_suite and status trigger too.
    advance(30);
    await guardCheckSuite.handle(
      event("check_suite", loadFixture("check_suite.completed").payload),
      ctx(),
    );
    expect(await jobs("guard.observe")).toHaveLength(2);
    advance(30);
    const status = loadFixture("status").payload as { branches: { name: string }[] };
    await guardStatus.handle(event("status", status), ctx());
    expect(await jobs("guard.observe")).toHaveLength(3);
    advance(30);
    status.branches = [{ name: "feature" }];
    await guardStatus.handle(event("status", status), ctx());
    expect(await jobs("guard.observe")).toHaveLength(3);
    // `branches` lists at most 10 branches that contain the SHA: a full list without the default
    // branch may have cut it, so the job decides (finding 3).
    advance(30);
    status.branches = Array.from({ length: 10 }, (_, i) => ({ name: `feature-${i}` }));
    await guardStatus.handle(event("status", status), ctx());
    expect(await jobs("guard.observe")).toHaveLength(4);
    advance(30);
    status.branches = status.branches.slice(0, 9);
    await guardStatus.handle(event("status", status), ctx());
    expect(await jobs("guard.observe")).toHaveLength(4);

    // The job keeps only SHAs on the default branch: a SHA the inline track does not reach
    // stops there, and nothing is stored for it (X9).
    history(2);
    api.state.branches.set("main", C(2));
    api.state.history.set(C(9), { parents: [C(1)] });
    run(C(9), "test", "failure");
    expect(await observe(C(9))).toBe("not_on_default_branch");
    expect(await t.db.selectFrom("ci_results").selectAll().execute()).toEqual([]);
    expect(api.find("GET", new RegExp(`/commits/${C(9)}/check-runs$`))).toEqual([]);
  });

  it("I-GRD-5 results come from the API, not the payload: the payload says failure, the API success", async () => {
    const M = "1".repeat(40);
    const P = "2".repeat(40);
    api.state.history.set(P, { parents: [] });
    api.state.history.set(M, { parents: [P] });
    await track(M, null);
    run(P, "test", "success");
    run(M, "test", "success");
    const payload = loadFixture("check_run.completed").payload as {
      check_run: { conclusion: string };
    };
    expect(payload.check_run.conclusion).toBe("failure");
    await sql`delete from pgboss.job`.execute(t.db);
    await guardCheckRun.handle(event("check_run", payload), ctx());
    const [job] = await jobs("guard.observe");
    expect(Object.keys(job?.data as object).sort()).toEqual(
      ["installationId", "owner", "repo", "repositoryId", "sha"].sort(),
    );
    await observeCommit(job?.data as never, ctx());
    const stored = await t.db.selectFrom("ci_results").selectAll().where("sha", "=", M).execute();
    expect(stored.map((r) => [r.key, r.class])).toEqual([[TEST_KEY, "green"]]);
    expect(await events()).toEqual([]);

    // §6.3, out of order: a later read answers an OLDER result (a lagging replica, a late page).
    // It never overwrites the newer one (X4).
    const latest = api.state.checkRuns.filter((r) => r.head_sha === M);
    for (const r of latest) {
      r.conclusion = "failure";
      r.completed_at = new Date(now.getTime() - 60_000).toISOString();
    }
    advance(60);
    await observeCommit(job?.data as never, ctx());
    const after = await t.db.selectFrom("ci_results").selectAll().where("sha", "=", M).execute();
    expect(after.map((r) => [r.key, r.class])).toEqual([[TEST_KEY, "green"]]);
    expect(await events()).toEqual([]);
  });
});

describe("guard: detection and confirmation", () => {
  it("I-GRD-6 single culprit: confirming, then the next commit red: culprit_found and one comment with the marker; replays write nothing", async () => {
    const id = await confirming();
    let [e] = await events();
    expect(e).toMatchObject({
      status: "confirming",
      failing_sha: C(2),
      last_green_sha: C(1),
      branch: "main",
      comment_id: null,
      failing_checks: [{ key: TEST_KEY, name: "test", source: "check_run" }],
      candidates: [{ sha: C(2), prNumber: 7, kind: "pr" }],
    });
    const seven = await t.db
      .selectFrom("changes")
      .select("id")
      .where("pr_number", "=", 7)
      .executeTakeFirstOrThrow();
    expect(e?.culprit_change_id).toBe(seven.id);
    expect(e?.ci_run_url).toMatch(/^https:\/\/github\.com\/graft-sandbox\/sample-ts\/runs\/\d+$/);
    const confirm = await jobs("guard.confirm");
    expect(confirm.map((j) => [j.data, j.singleton_key])).toEqual([
      [{ eventId: id }, `guard:confirm:${id}`],
    ]);
    expect(comments()).toEqual([]);

    // D8: a second key red on the same commit joins the open event (X5).
    run(C(1), "lint", "success");
    await observe(C(1));
    run(C(2), "lint", "failure");
    await observe(C(2));
    expect((await events()).map((r) => [r.id, r.failing_checks.map((c) => c.name)])).toEqual([
      [id, ["test", "lint"]],
    ]);

    advance(60);
    run(C(3), "test", "failure");
    await observe(C(3));
    [e] = await events();
    expect(e).toMatchObject({
      status: "culprit_found",
      confirm_reason: "next_commit",
      guard_mode: "report",
    });
    expect(e?.confirmed_at).toEqual(now);
    const posted = comments();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.path).toBe(`/repos/${FULL_NAME}/issues/7/comments`);
    const body = String(posted[0]?.body?.body);
    expect(body.split("\n")[0]).toBe(`<!-- graft:guard-event ${id} -->`);
    expect(body).toContain(`went red on \`main\` at \`${C(2).slice(0, 7)}\``);
    expect(body).toContain(`the next commit \`${C(3).slice(0, 7)}\` is also red`);
    expect(body).toContain("- Failing: `test`, `lint`");
    expect(body.split("\n").at(-1)).toBe(REPORT_LINE);
    expect(e?.comment_id).toBe(api.state.comments[0]?.id);

    // Replays: observe again, publish again, and a retry whose stored comment id was lost.
    await observe(C(3));
    await observe(C(2));
    expect(await publishGuardComment(id, ctx())).toBe("skipped");
    await t.db.updateTable("guard_events").set({ comment_id: null }).execute();
    expect(await publishGuardComment(id, ctx())).toBe("adopted");
    expect(comments()).toHaveLength(1);
    [e] = await events();
    expect(e?.comment_id).toBe(api.state.comments[0]?.id);
  });

  it("I-GRD-7 flaky: a re-run on N turns green: flaky, no comment", async () => {
    await confirming();
    advance(120);
    run(C(2), "test", "success");
    await observe(C(2));
    const [e] = await events();
    expect(e).toMatchObject({ status: "flaky", confirm_reason: "flaky_rerun" });
    expect(comments()).toEqual([]);
    // Nothing more happens later.
    advance(7200);
    await confirmEvent({ eventId: e?.id as string }, ctx());
    expect((await events())[0]?.status).toBe("flaky");
    expect(comments()).toEqual([]);
  });

  it("I-GRD-7 flaky: the next commit green: flaky, no comment", async () => {
    await confirming();
    advance(60);
    run(C(3), "test", "success");
    await observe(C(3));
    const [e] = await events();
    expect(e).toMatchObject({ status: "flaky", confirm_reason: "flaky_next" });
    expect(comments()).toEqual([]);
  });

  it("I-GRD-8 quiet repository: no next commit; guard.confirm at the deadline with N still red: culprit_found and the comment", async () => {
    const id = await confirming();
    const [job] = await jobs("guard.confirm");
    const delay = (job?.start_after.getTime() ?? 0) - Date.now();
    // The window plus a 60-second margin (finding 4).
    expect(delay).toBeGreaterThan(7250 * 1000);
    expect(delay).toBeLessThanOrEqual(7260 * 1000);
    // Before the deadline it waits.
    advance(3600);
    await confirmEvent({ eventId: id }, ctx());
    expect((await events())[0]?.status).toBe("confirming");
    advance(3600);
    await confirmEvent({ eventId: id }, ctx());
    const [e] = await events();
    expect(e).toMatchObject({ status: "culprit_found", confirm_reason: "window" });
    expect(comments()).toHaveLength(1);
    expect(String(comments()[0]?.body?.body)).toContain("- Confirmed by: still red after 2 hours");
  });

  it("I-GRD-8b a confirm that runs before the deadline is sent again with its own key, and the next attempt settles", async () => {
    const id = await confirming();
    // The worker's clock is a second behind the deadline.
    advance(7199);
    await confirmEvent({ eventId: id }, ctx());
    expect((await events())[0]?.status).toBe("confirming");
    const queued = await jobs("guard.confirm");
    expect(queued.map((j) => [j.data, j.singleton_key]).sort()).toEqual(
      [
        [{ eventId: id }, `guard:confirm:${id}`],
        [{ eventId: id, attempt: 1 }, `guard:confirm:${id}:1`],
      ].sort(),
    );
    advance(7200);
    await confirmEvent({ eventId: id, attempt: 1 }, ctx());
    const [e] = await events();
    expect(e).toMatchObject({ status: "culprit_found", confirm_reason: "window" });
    expect(comments()).toHaveLength(1);
    // Settled: no further attempt.
    expect(await jobs("guard.confirm")).toHaveLength(2);
  });

  it("I-GRD-8c an event whose failing result is no longer red is examined again twice, then settles flaky", async () => {
    const id = await confirming();
    // A re-run that ends cancelled replaces the red result: neither red nor green.
    advance(60);
    run(C(2), "test", "cancelled");
    await observe(C(2));
    for (const attempt of [0, 1]) {
      advance(7260);
      await confirmEvent(attempt === 0 ? { eventId: id } : { eventId: id, attempt }, ctx());
      expect((await events())[0]?.status).toBe("confirming");
    }
    expect((await jobs("guard.confirm")).map((j) => j.singleton_key).sort()).toEqual(
      [`guard:confirm:${id}`, `guard:confirm:${id}:1`, `guard:confirm:${id}:2`].sort(),
    );
    advance(7200);
    await confirmEvent({ eventId: id, attempt: 2 }, ctx());
    const [e] = await events();
    expect(e).toMatchObject({ status: "flaky", confirm_reason: null });
    expect(e?.confirmed_at).toEqual(now);
    expect(comments()).toEqual([]);
    expect(await jobs("guard.confirm")).toHaveLength(3);
  });

  it("I-GRD-9 ambiguous (two merges) and no_culprit (direct push): rows, no comment, guard list shows them", async () => {
    history(5);
    mergedPull(5, C(2));
    mergedPull(6, C(3));
    await track(C(5), null);
    const off = { GRAFT_GUARD_CONFIRM: "off" };
    run(C(1), "test", "success");
    run(C(3), "test", "failure");
    run(C(4), "test", "success");
    run(C(5), "test", "failure");
    for (const k of [1, 3, 4, 5]) await observe(C(k), off);
    const rows = await events();
    expect(
      rows.map((r) => [r.failing_sha, r.status, r.confirm_reason, r.culprit_change_id]),
    ).toEqual([
      [C(3), "ambiguous", "off", null],
      [C(5), "no_culprit", "off", null],
    ]);
    expect(rows[0]?.candidates).toEqual([
      { sha: C(2), prNumber: 5, kind: "pr" },
      { sha: C(3), prNumber: 6, kind: "pr" },
    ]);
    expect(comments()).toEqual([]);
    expect(writes().filter((w) => !w.path.endsWith("/access_tokens"))).toEqual([]);

    const list = await ops(["guard", "list", "--repo", FULL_NAME]);
    expect(list.code, list.err).toBe(0);
    const lines = list.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(
      lines.some((l) => l.includes(`ambiguous  ${C(3).slice(0, 7)}  test  candidates #5 #6`)),
    ).toBe(true);
    expect(lines.some((l) => l.includes(`no_culprit  ${C(5).slice(0, 7)}  test  no PR`))).toBe(
      true,
    );
    const only = await ops(["guard", "list", "--repo", FULL_NAME, "--status", "ambiguous"]);
    expect(only.out.trimEnd().split("\n")).toHaveLength(1);
  });

  it("I-GRD-10 two observes for neighbouring commits racing: exactly one event", async () => {
    history(3);
    mergedPull(7, C(2));
    mergedPull(8, C(3));
    await track(C(3), null);
    run(C(1), "test", "success");
    await observe(C(1));
    run(C(2), "test", "failure");
    run(C(3), "test", "failure");
    const b2 = api.block("GET", new RegExp(`/commits/${C(2)}/check-runs$`));
    const b3 = api.block("GET", new RegExp(`/commits/${C(3)}/check-runs$`));
    const both = Promise.all([observe(C(2)), observe(C(3))]);
    await Promise.all([b2.reached, b3.reached]);
    b2.release();
    b3.release();
    await both;
    const rows = await events();
    expect(rows.map((r) => r.failing_sha)).toEqual([C(2)]);
  });

  it("I-GRD-10b the later commit observed first: the event moves to the earlier failing commit", async () => {
    history(3);
    mergedPull(7, C(2));
    mergedPull(8, C(3));
    await track(C(3), null);
    run(C(1), "test", "success");
    await observe(C(1));
    run(C(3), "test", "failure");
    await observe(C(3));
    expect((await events()).map((r) => [r.failing_sha, r.candidates.length])).toEqual([[C(3), 2]]);
    run(C(2), "test", "failure");
    await observe(C(2));
    const rows = await events();
    expect(rows.map((r) => [r.failing_sha, r.status])).toEqual([[C(2), "culprit_found"]]);
    expect(rows[0]?.candidates).toEqual([{ sha: C(2), prNumber: 7, kind: "pr" }]);
    expect(comments()).toHaveLength(1);
    expect(comments()[0]?.path).toBe(`/repos/${FULL_NAME}/issues/7/comments`);
  });

  it("I-GRD-10c a late green on the parent narrows the open event to the later commits", async () => {
    history(4);
    mergedPull(7, C(2));
    mergedPull(8, C(3));
    mergedPull(9, C(4));
    await track(C(4), null);
    run(C(1), "test", "success");
    await observe(C(1));
    // C2's CI is still running when C3 is observed red.
    run(C(2), "test", null);
    await observe(C(2));
    run(C(3), "test", "failure");
    await observe(C(3));
    expect((await events()).map((r) => [r.failing_sha, r.last_green_sha, r.candidates])).toEqual([
      [
        C(3),
        C(1),
        [
          { sha: C(2), prNumber: 7, kind: "pr" },
          { sha: C(3), prNumber: 8, kind: "pr" },
        ],
      ],
    ]);
    expect((await events())[0]?.culprit_change_id).toBeNull();
    // C2 turns green: the event narrows to C3 alone (PR 8).
    advance(60);
    run(C(2), "test", "success");
    await observe(C(2));
    let [e] = await events();
    expect(e).toMatchObject({
      status: "confirming",
      failing_sha: C(3),
      last_green_sha: C(2),
      candidates: [{ sha: C(3), prNumber: 8, kind: "pr" }],
    });
    const eight = await t.db
      .selectFrom("changes")
      .select("id")
      .where("pr_number", "=", 8)
      .executeTakeFirstOrThrow();
    expect(e?.culprit_change_id).toBe(eight.id);
    // C4 red too: confirmed, culprit PR 8, one comment there.
    advance(60);
    run(C(4), "test", "failure");
    await observe(C(4));
    [e] = await events();
    expect(e).toMatchObject({ status: "culprit_found", confirm_reason: "next_commit" });
    expect(comments().map((c) => c.path)).toEqual([`/repos/${FULL_NAME}/issues/8/comments`]);
  });

  it("I-GRD-11 without statuses:read no status request is made and check runs still drive detection; with it, a status opens an event", async () => {
    history(4);
    mergedPull(7, C(2));
    mergedPull(8, C(4));
    await track(C(4), null);
    api.state.statuses.set(C(3), [
      { context: "ci/jenkins", state: "success", updated_at: now.toISOString() },
    ]);
    api.state.statuses.set(C(4), [
      {
        context: "ci/jenkins",
        state: "failure",
        updated_at: now.toISOString(),
        target_url: `https://github.com/someone-else/phish/${FULL_NAME}/x`,
      },
    ]);
    run(C(1), "test", "success");
    run(C(2), "test", "failure");
    // Graft's own check runs never count (D1, X3): a graft/policy failure on C3 after a success
    // on C1 opens nothing and is not stored.
    run(C(1), "graft/policy", "success", { app: 12345 });
    run(C(3), "graft/policy", "failure", { app: 12345 });
    for (const k of [1, 2, 3, 4]) await observe(C(k));
    expect(api.find("GET", /\/status$/)).toEqual([]);
    expect((await events()).map((r) => r.failing_sha)).toEqual([C(2)]);
    expect(
      await t.db.selectFrom("ci_results").selectAll().where("key", "like", "run:12345:%").execute(),
    ).toEqual([]);

    await t.db
      .updateTable("installations")
      .set({
        permissions: JSON.stringify({ checks: "write", statuses: "read" }),
        permissions_read_at: now,
      })
      .execute();
    for (const k of [3, 4]) await observe(C(k));
    expect(api.find("GET", /\/status$/).length).toBeGreaterThan(0);
    const rows = await events();
    expect(rows.map((r) => [r.failing_sha, r.failing_checks[0]?.key])).toEqual([
      [C(2), TEST_KEY],
      [C(4), "status:ci/jenkins"],
    ]);
    // A status link outside this repository is dropped (nit 9).
    expect(rows[1]?.ci_run_url).toBeNull();
    api.state.statuses.set(C(5), [
      {
        context: "ci/jenkins",
        state: "failure",
        updated_at: now.toISOString(),
        target_url: `https://github.com/${FULL_NAME}/actions/runs/5`,
      },
    ]);
    history(5, 5);
    await track(C(5), C(4));
    await observe(C(5));
    const kept = await t.db
      .selectFrom("ci_results")
      .select("html_url")
      .where("sha", "=", C(5))
      .executeTakeFirstOrThrow();
    expect(kept.html_url).toBe(`https://github.com/${FULL_NAME}/actions/runs/5`);
  });

  it("I-GRD-12 guard.checks: [test] at the baseline: a red lint opens nothing; a red test does", async () => {
    history(2);
    mergedPull(7, C(2));
    await track(C(2), null);
    putContent(api, C(1), "version: 1\nguard:\n  checks: [test]\n");
    run(C(1), "test", "success");
    run(C(1), "lint", "success");
    run(C(2), "lint", "failure");
    await observe(C(1));
    await observe(C(2));
    expect(await events()).toEqual([]);
    advance(60);
    run(C(2), "test", "failure");
    await observe(C(2));
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.failing_checks.map((c) => c.name)).toEqual(["test"]);
  });

  it("I-GRD-12b a candidate whose merge drops `test` from guard.checks while turning it red still opens an event", async () => {
    history(2);
    mergedPull(7, C(2));
    await track(C(2), null);
    putContent(api, C(1), "version: 1\nguard:\n  checks: [test, lint]\n");
    // The culprit's own graft.yaml would hide its failure.
    putContent(api, C(2), "version: 1\nguard:\n  checks: [lint]\n");
    run(C(1), "test", "success");
    run(C(2), "test", "failure");
    await observe(C(1));
    await observe(C(2));
    const rows = await events();
    expect(rows.map((r) => [r.failing_sha, r.failing_checks.map((c) => c.name)])).toEqual([
      [C(2), ["test"]],
    ]);
  });

  it("I-GRD-12c a transient error while a baseline is read between lock passes loses nothing: the retry opens the event", async () => {
    history(3);
    mergedPull(7, C(2));
    mergedPull(8, C(3));
    await track(C(3), null);
    run(C(1), "test", "success");
    await observe(C(1));
    run(C(3), "test", "failure");
    // C3's dry run finds C1 as the baseline and reads its graft.yaml: held here.
    const dry = api.block("GET", /\/contents\/graft\.yaml$/);
    const first = observe(C(3));
    await dry.reached;
    // Meanwhile C2 is observed green: C3's baseline is now C2, which was not loaded.
    run(C(2), "test", "success");
    await observe(C(2));
    // The read of C2's file between the passes fails with a 502.
    const between = api.block("GET", /\/contents\/graft\.yaml$/);
    dry.release();
    await between.reached;
    api.failNext("GET", /\/contents\/graft\.yaml$/, 502);
    between.release();
    await expect(first).rejects.toThrow();
    expect(await events()).toEqual([]);
    // The job's retry sees the transition again.
    await observe(C(3));
    const rows = await events();
    expect(rows.map((r) => [r.failing_sha, r.last_green_sha, r.candidates])).toEqual([
      [C(3), C(2), [{ sha: C(3), prNumber: 8, kind: "pr" }]],
    ]);
  });

  it("I-GRD-17 a decoy: a later green run of the same key in another check suite does not hide the red one", async () => {
    history(2);
    mergedPull(7, C(2));
    await track(C(2), null);
    run(C(1), "test", "success", { suite: 1 });
    await observe(C(1));
    run(C(2), "test", "failure", { suite: 2 });
    run(C(2), "test", "success", { suite: 3, at: new Date(now.getTime() + 4000) });
    await observe(C(2));
    expect((await events()).map((r) => [r.failing_sha, r.failing_checks[0]?.key])).toEqual([
      [C(2), TEST_KEY],
    ]);
    // A re-run inside the same check suite is still D4's "latest wins": flaky.
    advance(120);
    run(C(2), "test", "success", { suite: 2 });
    await observe(C(2));
    expect((await events())[0]).toMatchObject({ status: "flaky", confirm_reason: "flaky_rerun" });
  });

  it("I-GRD-13 guard_mode enforce with the ceiling and contents:write: same event, one comment with the enforce line, no other write", async () => {
    const enforce = { GRAFT_MODE_CEILING: "enforce" };
    await t.db.updateTable("repositories").set({ guard_mode: "enforce" }).execute();
    await t.db
      .updateTable("installations")
      .set({
        permissions: JSON.stringify({ checks: "write", contents: "write", pull_requests: "write" }),
        permissions_read_at: now,
      })
      .execute();
    await confirming(enforce);
    advance(60);
    run(C(3), "test", "failure");
    await observe(C(3), enforce);
    const [e] = await events();
    expect(e).toMatchObject({ status: "culprit_found", guard_mode: "enforce" });
    expect(comments()).toHaveLength(1);
    expect(String(comments()[0]?.body?.body).split("\n").at(-1)).toBe(ENFORCE_LINE);
    expect(
      writes()
        .filter((w) => !w.path.endsWith("/access_tokens"))
        .map((w) => `${w.method} ${w.path}`),
    ).toEqual([`POST /repos/${FULL_NAME}/issues/7/comments`]);
  });

  it("I-GRD-14 GRAFT_GUARD_DETECTION=off: handlers enqueue nothing, jobs and crons idle", async () => {
    const off = { GRAFT_GUARD_DETECTION: "off" };
    const queue = new FakeJobQueue();
    const offCtx = { ...ctx(off), queue };
    await guardPush.handle(event("push", loadFixture("push.default").payload), offCtx);
    await guardCheckRun.handle(
      event("check_run", loadFixture("check_run.completed").payload),
      offCtx,
    );
    await guardCheckSuite.handle(
      event("check_suite", loadFixture("check_suite.completed").payload),
      offCtx,
    );
    await guardStatus.handle(event("status", loadFixture("status").payload), offCtx);
    expect(queue.sent).toEqual([]);
    // The same payloads with detection on enqueue.
    const onCtx = { ...ctx(), queue };
    await guardPush.handle(event("push", loadFixture("push.default").payload), onCtx);
    await guardCheckRun.handle(
      event("check_run", loadFixture("check_run.completed").payload),
      onCtx,
    );
    expect(queue.sent.map((s) => s.name)).toEqual(["guard.track", "guard.observe"]);

    history(2);
    expect(await track(C(2), null, { config: off })).toBe("disabled");
    expect(await observe(C(2), off)).toBe("disabled");
    expect(api.requests).toEqual([]);
    await t.db
      .insertInto("main_commits")
      .values({
        repository_id: REPO_ID,
        sha: C(9),
        parent_sha: null,
        seq: 1,
        pr_source: "direct",
        change_id: null,
        pr_number: null,
        committed_at: null,
        tracked_at: new Date("2020-01-01T00:00:00Z"),
      })
      .execute();
    await guardPruneJob.handle({}, ctx(off));
    expect(await t.db.selectFrom("main_commits").selectAll().execute()).toHaveLength(1);
  });
});

describe("guard: retention, purge and the CLI", () => {
  const old = new Date("2026-09-01T00:00:00Z");
  async function oldRows(shas: string[]) {
    let seq = 1;
    for (const sha of shas) {
      await t.db
        .insertInto("main_commits")
        .values({
          repository_id: REPO_ID,
          sha,
          parent_sha: null,
          seq: seq++,
          pr_source: "direct",
          change_id: null,
          pr_number: null,
          committed_at: null,
          tracked_at: old,
        })
        .execute();
      await t.db
        .insertInto("ci_results")
        .values({
          repository_id: REPO_ID,
          sha,
          key: TEST_KEY,
          name: "test",
          source: "check_run",
          class: "red",
          html_url: null,
          completed_at: old,
          observed_at: old,
        })
        .execute();
    }
  }

  it("I-GRD-15 guard.prune deletes old rows and keeps the commits of confirming events; pilot purge removes the new tables", async () => {
    // C5 is the repository's newest commit: kept whatever its age (finding 6).
    await oldRows([C(1), C(2), C(3), C(4), C(5)]);
    await t.db
      .insertInto("guard_events")
      .values({
        repository_id: REPO_ID,
        branch: "main",
        failing_sha: C(2),
        last_green_sha: C(1),
        candidates: JSON.stringify([{ sha: C(3), prNumber: null, kind: "direct" }]),
        status: "confirming",
        detected_at: old,
      })
      .execute();
    await guardPruneJob.handle({}, ctx());
    const kept = await t.db.selectFrom("main_commits").select("sha").orderBy("seq").execute();
    expect(kept.map((r) => r.sha)).toEqual([C(1), C(2), C(3), C(5)]);
    const results = await t.db.selectFrom("ci_results").select("sha").execute();
    expect(results.map((r) => r.sha).sort()).toEqual([C(1), C(2), C(3), C(5)].sort());

    const res = await purgeInstallation(t.db, {
      installationId: INSTALLATION_ID,
      schema: "pgboss",
      now: FIXED_NOW,
      dryRun: false,
      evenIfActive: true,
    });
    expect(res.counts).toMatchObject({ main_commits: 4, ci_results: 4, guard_events: 1 });
    expect(await t.db.selectFrom("main_commits").selectAll().execute()).toEqual([]);
    expect(await t.db.selectFrom("ci_results").selectAll().execute()).toEqual([]);
  });

  it("I-GRD-15b a quiet month: the prune keeps the green tip, and the next red merge on top of it opens an event", async () => {
    history(2);
    mergedPull(7, C(2));
    await track(C(2), null);
    run(C(1), "test", "success");
    run(C(2), "test", "success");
    await observe(C(1));
    await observe(C(2));
    advance(31 * 86_400);
    await guardPruneJob.handle({}, ctx());
    const kept = await t.db.selectFrom("main_commits").select("sha").execute();
    expect(kept.map((r) => r.sha)).toEqual([C(2)]);
    history(3, 3);
    mergedPull(8, C(3));
    await track(C(3), C(2));
    expect(
      await t.db
        .selectFrom("main_commits")
        .select("chain_break")
        .where("sha", "=", C(3))
        .executeTakeFirstOrThrow(),
    ).toEqual({ chain_break: false });
    run(C(3), "test", "failure");
    await observe(C(3));
    const rows = await events();
    expect(rows.map((r) => [r.failing_sha, r.last_green_sha, r.candidates])).toEqual([
      [C(3), C(2), [{ sha: C(3), prNumber: 8, kind: "pr" }]],
    ]);
  });

  it("I-GRD-16 guard list text and --json; mode show notes; doctor warnings, never failures", async () => {
    await confirming({ GRAFT_GUARD_CONFIRM: "off" });
    const text = await ops(["guard", "list", "--repo", FULL_NAME]);
    expect(text.code).toBe(0);
    expect(text.out).toBe(
      `2026-10-14T12:01:00Z  culprit_found  ${C(2).slice(0, 7)}  test  culprit #7\n`,
    );
    const json = await ops(["guard", "list", "--repo", FULL_NAME, "--json", "--limit", "5"]);
    const parsed = JSON.parse(json.out) as { events: Record<string, unknown>[] };
    expect(parsed.events).toHaveLength(1);
    expect(Object.keys(parsed.events[0] as object).sort()).toEqual(
      [
        "candidatePrs",
        "commentId",
        "confirmedAt",
        "culpritPr",
        "detectedAt",
        "failingChecks",
        "failingSha",
        "guardMode",
        "id",
        "lastGreenSha",
        "status",
        "unresolvedCommits",
      ].sort(),
    );
    expect(parsed.events[0]).toMatchObject({
      status: "culprit_found",
      failingSha: C(2),
      lastGreenSha: C(1),
      culpritPr: 7,
      candidatePrs: [7],
      unresolvedCommits: 0,
      guardMode: "report",
    });
    expect((await ops(["guard", "list", "--repo", "other/repo"])).code).toBe(1);
    expect((await ops(["guard", "list", "--repo", FULL_NAME, "--status", "nope"])).code).toBe(2);
    expect((await ops(["guard", "list", "--repo", FULL_NAME, "--limit", "201"])).code).toBe(2);

    const show = await ops(["mode", "show", "--repo", FULL_NAME]);
    expect(show.out).toContain("  note: guard reads check runs only (no statuses:read)");
    expect(show.out).not.toContain("guard detection is off");
    const showOff = await ops(["mode", "show", "--repo", FULL_NAME], {
      GRAFT_GUARD_DETECTION: "off",
    });
    expect(showOff.out).toContain("  note: guard detection is off on this shell's config");

    // A confirming event older than twice the window, and no statuses:read: two WARNs.
    await t.db
      .insertInto("guard_events")
      .values({
        repository_id: REPO_ID,
        branch: "main",
        failing_sha: C(9),
        status: "confirming",
        detected_at: new Date(now.getTime() - 5 * 3600_000),
      })
      .execute();
    const checks = await runDoctor(t.db, testConfig(), { installationId: INSTALLATION_ID, now });
    const guardChecks = checks.filter((c) => c.id.startsWith("guard_"));
    expect(guardChecks.map((c) => [c.id, c.status])).toEqual([
      ["guard_statuses", "WARN"],
      ["guard_confirming", "WARN"],
    ]);
    expect(guardChecks.find((c) => c.id === "guard_confirming")?.detail).toBe(
      "1 guard events stuck in confirming past twice the window",
    );
    await t.db
      .updateTable("installations")
      .set({ permissions: JSON.stringify({ statuses: "read" }), permissions_read_at: now })
      .execute();
    await t.db.deleteFrom("guard_events").where("failing_sha", "=", C(9)).execute();
    const healthy = await runDoctor(t.db, testConfig(), { installationId: INSTALLATION_ID, now });
    expect(healthy.filter((c) => c.id.startsWith("guard_")).map((c) => c.status)).toEqual([
      "OK",
      "OK",
    ]);
  });
});
