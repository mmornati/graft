/**
 * Phase 1 step 2: approvals Graft can enforce (spec §13, I-ENF). The policy job against the fake
 * GitHub API, with the real mutation gate: report mode publishes `neutral` and stores what enforce
 * would conclude; enforce mode publishes that conclusion through the `policy` feature client.
 */
import { Writable } from "node:stream";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/core/logger.js";
import { migrateDownOne, migrateToLatest } from "../../src/db/migrator.js";
import { parseManagedComment } from "../../src/github/managed-comment.js";
import type { MutationRefusedError } from "../../src/github/mutation-guard.js";
import { getChangeByNumber } from "../../src/modules/changes/index.js";
import { mutationGate } from "../../src/modules/modes/index.js";
import { reviewPolicy } from "../../src/modules/policy/handlers.js";
import {
  type EvaluateData,
  evaluatePolicyJobRun,
  policyFactsHash,
} from "../../src/modules/policy/job.js";
import type { PolicyView } from "../../src/modules/policy/render.js";
import { fanoutTeamChange, scheduleTeamFanout } from "../../src/modules/policy/team-fanout.js";
import { clearPolicyCache } from "../../src/policy/load.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture } from "../helpers/fixtures.js";
import {
  fakeSha,
  HEAD_SHA,
  INSTALLATION_ID,
  makePull,
  makeReview,
  OWNER,
  PR_NUMBER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";
import { addCard, addDisplay } from "../helpers/pilot-seed.js";
import {
  EVAL_DATA,
  jobsNamed,
  loadPolicyScenario,
  putContent,
  srcFile,
} from "../helpers/policy-scenario.js";
import { seedWorld } from "../helpers/seed.js";

// I-ENF-9 freezes what is rendered, so that only the facts hash can tell two runs apart.
const frozen = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/modules/policy/render.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/modules/policy/render.js")>();
  return {
    ...real,
    policyTitle: (v: PolicyView) => (frozen.on ? "frozen title" : real.policyTitle(v)),
    renderPolicySection: (v: PolicyView) =>
      frozen.on ? "### Policy\n\nfrozen section" : real.renderPolicySection(v),
    renderPolicyDetails: (v: PolicyView) =>
      frozen.on ? "frozen details" : real.renderPolicyDetails(v),
  };
});

const TEAM_POLICY = "version: 1\ndefault:\n  require: { humans: 1, team: security }\n";
const TEAM = `@${OWNER}/security`;
const HEAD_2 = fakeSha(0xbeef);
const ALICE = { login: "alice", userId: 501 };
const BOB = { login: "bob", userId: 502 };
const TINA = { login: "tina", userId: 503 };

let t: TestApp;
let api: FakeGitHubApi;
let logged = "";
const refused: MutationRefusedError[] = [];

beforeAll(async () => {
  const stream = new Writable({
    write(chunk, _e, cb) {
      logged += String(chunk);
      cb();
    },
  });
  t = await createTestApp({ log: createLogger({ logLevel: "info" }, stream) });
});
afterAll(() => t.close());

const PERMISSIONS = {
  metadata: "read",
  contents: "read",
  issues: "read",
  pull_requests: "write",
  checks: "write",
  members: "read",
};

async function setPermissions(p: Record<string, string> | null): Promise<void> {
  await t.db
    .updateTable("installations")
    .set({
      permissions: JSON.stringify(p ?? {}),
      permissions_read_at: p === null ? null : FIXED_NOW,
    })
    .execute();
}
async function setMode(policy: "report" | "enforce"): Promise<void> {
  await t.db.updateTable("repositories").set({ policy_mode: policy }).execute();
}

beforeEach(async () => {
  logged = "";
  refused.length = 0;
  frozen.on = false;
  await truncateAll(t.db);
  await seedWorld(t.db);
  await setPermissions(PERMISSIONS);
  clearPolicyCache();
  api = createFakeGitHubApi();
  t.deps.github = fakeGitHubFactory(api, mutationGate(t.db, { modeCeiling: "enforce" }), (e) =>
    refused.push(e),
  );
  loadPolicyScenario(api, { policy: TEAM_POLICY });
  api.state.teams.set("security", {
    members: new Map([
      ["alice", "active"],
      ["tina", "active"],
      ["pat", "pending"],
    ]),
  });
  for (const u of [ALICE, BOB]) {
    api.state.permissions.set(u.login, { id: u.userId, role: "write" });
  }
  api.state.permissions.set(TINA.login, { id: TINA.userId, role: "triage" });
});

const config = (over: Record<string, string> = {}) =>
  testConfig({ GRAFT_MODE_CEILING: "enforce", GRAFT_POLICY_CARD_WAIT_SECONDS: "0", ...over });
const run = (
  o: { data?: Partial<EvaluateData>; config?: Record<string, string>; nowMs?: number } = {},
) =>
  evaluatePolicyJobRun(
    { ...EVAL_DATA, ...o.data },
    {
      ...jobContext(t),
      config: config(o.config),
      clock: { now: () => new Date(o.nowMs ?? FIXED_NOW.getTime()) },
    },
  );
const approve = (...who: { login: string; userId: number }[]) =>
  api.state.reviews.set(
    PR_NUMBER,
    who.map((u, i) => makeReview({ id: 10 + i, login: u.login, userId: u.userId })),
  );
const policyChecks = () => api.state.checkRuns.filter((c) => c.name === "graft/policy");
const lastCheck = () => policyChecks().at(-1);
const verdictRows = () =>
  t.db.selectFrom("policy_verdicts").selectAll().orderBy("facts_read_at").execute();
const lastVerdict = async () => (await verdictRows()).at(-1);
const policySection = (): string =>
  parseManagedComment(api.state.comments[0]?.body ?? "")?.get("policy") ?? "";
const teamRequests = () => api.requests.filter((r) => r.path.startsWith("/orgs/"));
const permissionRequests = () =>
  api.requests.filter((r) => /\/collaborators\/[^/]+\/permission$/.test(r.path));
const event = (fixture: string, deliveryId: string) =>
  ({
    name: fixture.split(".")[0],
    deliveryId,
    id: deliveryId,
    payload: structuredClone(loadFixture(fixture).payload),
  }) as never;

describe("approvals Graft can enforce (integration)", () => {
  it("I-ENF-1 migration 0009 down then up; down needs no pending row", async () => {
    await truncateAll(t.db);
    // Steps 3 to 5's migrations (and step 3 review 1's) sit on top of 0009.
    expect(await migrateDownOne(t.db)).toEqual(["0016_phase1_gate"]);
    expect(await migrateDownOne(t.db)).toEqual(["0015_mcp_open_claims"]);
    expect(await migrateDownOne(t.db)).toEqual(["0014_mcp"]);
    expect(await migrateDownOne(t.db)).toEqual(["0013_guard_revert"]);
    expect(await migrateDownOne(t.db)).toEqual(["0012_audit_label_event"]);
    expect(await migrateDownOne(t.db)).toEqual(["0011_guard"]);
    expect(await migrateDownOne(t.db)).toEqual(["0010_audit_log"]);
    expect(await migrateDownOne(t.db)).toEqual(["0009_enforce"]);
    try {
      const cols = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_name = 'policy_verdicts' and column_name like 'enforced_%'`.execute(t.db);
      expect(cols.rows).toEqual([]);
      const check = await sql<{ def: string }>`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'policy_verdicts_check_conclusion_check'`.execute(t.db);
      expect(check.rows[0]?.def).not.toContain("pending");
    } finally {
      expect(await migrateToLatest(t.db)).toEqual([
        "0009_enforce",
        "0010_audit_log",
        "0011_guard",
        "0012_audit_label_event",
        "0013_guard_revert",
        "0014_mcp",
        "0015_mcp_open_claims",
        "0016_phase1_gate",
      ]);
    }
    const cols = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'policy_verdicts' and column_name like 'enforced_%'
      order by column_name`.execute(t.db);
    expect(cols.rows.map((r) => r.column_name)).toEqual(["enforced_conclusion", "enforced_reason"]);
    // The pair is all or nothing, and pending is now a valid published conclusion.
    await seedWorld(t.db);
    await setMode("report");
    await run();
    await expect(
      sql`update policy_verdicts set enforced_reason = null`.execute(t.db),
    ).rejects.toThrow(/check constraint/);
    await expect(
      sql`update policy_verdicts set enforced_conclusion = 'maybe'`.execute(t.db),
    ).rejects.toThrow(/check constraint/);
    await sql`update policy_verdicts set check_conclusion = 'pending'`.execute(t.db);
  });

  it("I-ENF-2 report mode: one member approval → neutral check, enforced success stored, the would-be line in the comment", async () => {
    approve(ALICE);
    expect(await run()).toBe("published");
    expect(lastCheck()).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(lastCheck()?.output.title).toBe(`Would require 1 human from ${TEAM} · risk provisional`);
    const row = await lastVerdict();
    expect(row).toMatchObject({
      enforced_conclusion: "success",
      enforced_reason: "requirements_met",
      check_conclusion: "neutral",
      policy_mode: "report",
    });
    expect(policySection()).toContain(
      "**In enforce mode this check would be:** `success` (required approvals present).",
    );
    expect(policySection()).toContain("· report only");
    // Counts only: no team slug, no login beyond `users`.
    const stored = JSON.stringify(row?.approvals);
    expect(row?.approvals).toMatchObject({
      current: 1,
      users: ["alice"],
      counted: 1,
      notCounted: 0,
      changesRequested: 0,
      constraints: [{ humans: 1, teamCount: 1, met: true, approved: 1, unverified: [] }],
    });
    expect(stored).not.toContain("security");
    expect(stored).not.toContain("currentApprovers");
    expect(refused).toEqual([]);
  });

  it("I-ENF-3 enforce: the same PR concludes success; after a push the approval is stale and it fails", async () => {
    await setMode("enforce");
    approve(ALICE);
    expect(await run()).toBe("published");
    expect(lastCheck()).toMatchObject({ status: "completed", conclusion: "success" });
    expect(lastCheck()?.output.title).toBe("Policy satisfied: required approvals present");
    expect(policySection()).not.toContain("report only");
    expect(await lastVerdict()).toMatchObject({
      check_conclusion: "success",
      enforced_conclusion: "success",
      policy_mode: "enforce",
    });
    // Push: a new head; alice's approval stays on the old one.
    const pull = api.state.pulls.get(PR_NUMBER);
    if (!pull) throw new Error("no pull");
    pull.head.sha = HEAD_2;
    pull.updated_at = "2026-10-14T11:30:00Z";
    expect(await run()).toBe("published");
    const run2 = policyChecks().find((c) => c.head_sha === HEAD_2);
    expect(run2).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(run2?.output.title).toBe(`Needs 1 more approval from ${TEAM}`);
    expect(await lastVerdict()).toMatchObject({
      head_sha: HEAD_2,
      enforced_reason: "approvals_missing",
      check_conclusion: "failure",
    });
    expect(policySection()).toContain(
      "0 on this head, 1 on an older commit; 0 count (write access).",
    );
    expect(refused).toEqual([]);
  });

  it("I-ENF-4 enforce: an approver with triage (a team member) does not count", async () => {
    await setMode("enforce");
    approve(TINA);
    await run();
    expect(lastCheck()?.conclusion).toBe("failure");
    expect(lastCheck()?.output.text).toContain("- not counted: `tina` (no write access)");
    expect(lastCheck()?.output.text).toContain(`- 0 of 1 from \`${TEAM}\``);
    // The membership of a user who does not count is never asked.
    expect(teamRequests().map((r) => r.path)).toEqual([`/orgs/${OWNER}/teams/security`]);
  });

  it("I-ENF-5 enforce: without members:read no team request is made, the check fails and says why", async () => {
    await setMode("enforce");
    const { members: _members, ...noMembers } = PERMISSIONS;
    await setPermissions(noMembers);
    approve(ALICE);
    await run();
    expect(teamRequests()).toEqual([]);
    expect(lastCheck()?.conclusion).toBe("failure");
    expect(lastCheck()?.output.text).toContain(
      `- 0 of 1 from \`${TEAM}\`: cannot verify \`${TEAM}\` (the App has no members: read permission)`,
    );
    expect((await lastVerdict())?.approvals).toMatchObject({
      constraints: [{ met: false, unverified: ["no_permission"] }],
    });
    // Permissions never read: the same.
    await setPermissions(null);
    api.state.reviews.set(PR_NUMBER, [makeReview({ id: 20, ...ALICE })]);
    await run({ nowMs: FIXED_NOW.getTime() + 1000 });
    expect(teamRequests()).toEqual([]);
    expect((await lastVerdict())?.enforced_reason).toBe("approvals_missing");
  });

  it("I-ENF-6 enforce: a missing team and a team the App cannot read are unverified and fail", async () => {
    await setMode("enforce");
    approve(ALICE);
    api.state.teams.delete("security");
    await run();
    expect(lastCheck()?.conclusion).toBe("failure");
    expect((await lastVerdict())?.approvals).toMatchObject({
      constraints: [{ met: false, unverified: ["team_not_found"] }],
    });
    expect(lastCheck()?.output.text).toContain("(no such team, or the App cannot see it)");

    api.state.teams.set("security", { status: 403, members: new Map([["alice", "active"]]) });
    api.state.reviews.set(PR_NUMBER, [makeReview({ id: 21, ...ALICE })]);
    await run({ nowMs: FIXED_NOW.getTime() + 1000 });
    expect(lastCheck()?.conclusion).toBe("failure");
    expect((await lastVerdict())?.approvals).toMatchObject({
      constraints: [{ met: false, unverified: ["team_unreadable"] }],
    });
    // No membership was asked of a team that could not be read.
    expect(teamRequests().filter((r) => r.path.includes("/memberships/"))).toEqual([]);
  });

  it("I-ENF-6b enforce: a pending team membership does not count", async () => {
    await setMode("enforce");
    const PAT = { login: "pat", userId: 504 };
    api.state.permissions.set(PAT.login, { id: PAT.userId, role: "write" });
    approve(PAT);
    await run();
    expect(lastCheck()?.conclusion).toBe("failure");
    expect(await lastVerdict()).toMatchObject({ enforced_reason: "approvals_missing" });
    expect((await lastVerdict())?.approvals).toMatchObject({
      counted: 1,
      constraints: [{ met: false, approved: 0, unverified: [] }],
    });
    // The membership was asked, and answered pending.
    expect(teamRequests().map((r) => r.path)).toContain(
      `/orgs/${OWNER}/teams/security/memberships/pat`,
    );
  });

  it("I-ENF-7 enforce: a writer's change request fails the check; once dismissed it is re-evaluated and succeeds", async () => {
    await setMode("enforce");
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 10, ...ALICE }),
      makeReview({ id: 11, ...BOB, state: "CHANGES_REQUESTED" }),
    ]);
    await run();
    expect(lastCheck()?.conclusion).toBe("failure");
    expect(lastCheck()?.output.title).toBe("Changes requested by bob");
    expect(policySection()).toContain("Changes requested by `bob`.");
    expect((await lastVerdict())?.enforced_reason).toBe("changes_requested");

    // GitHub marks the review DISMISSED and sends pull_request_review.dismissed.
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 10, ...ALICE }),
      makeReview({ id: 11, ...BOB, state: "DISMISSED" }),
    ]);
    await reviewPolicy.handle(event("pull_request_review.dismissed", "d-dismiss"), jobContext(t));
    const queued = await jobsNamed(t.db, "policy.evaluate");
    expect(queued.at(-1)?.data).toMatchObject({ trigger: "review" });
    expect(await run({ data: { trigger: "review" }, nowMs: FIXED_NOW.getTime() + 1000 })).toBe(
      "published",
    );
    expect(lastCheck()?.conclusion).toBe("success");
  });

  it("I-ENF-7b enforce: a change requester whose role check answers 403, or past the bound, blocks", async () => {
    await setMode("enforce");
    // 403: Graft cannot tell whether bob can write, so his request blocks.
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 10, ...ALICE }),
      makeReview({ id: 11, ...BOB, state: "CHANGES_REQUESTED" }),
    ]);
    api.failNext("GET", /\/collaborators\/bob\/permission$/, 403);
    await run();
    expect(lastCheck()?.conclusion).toBe("failure");
    expect(await lastVerdict()).toMatchObject({ enforced_reason: "changes_requested" });
    expect(lastCheck()?.output.title).toBe("Changes requested by bob");

    // Past the bound: 20 readers (checked, not blocking), then a 21st requester never checked.
    const readers = Array.from({ length: 21 }, (_, i) => ({
      login: `rd${String(i).padStart(2, "0")}`,
      userId: 800 + i,
    }));
    for (const u of readers) api.state.permissions.set(u.login, { id: u.userId, role: "read" });
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 10, ...ALICE }),
      ...readers.map((u, i) => makeReview({ id: 30 + i, ...u, state: "CHANGES_REQUESTED" })),
    ]);
    api.requests.length = 0;
    await run({ nowMs: FIXED_NOW.getTime() + 1000 });
    expect(
      permissionRequests().filter((r) => /\/collaborators\/rd\d+\//.test(r.path)),
    ).toHaveLength(20);
    expect(lastCheck()?.conclusion).toBe("failure");
    expect(await lastVerdict()).toMatchObject({ enforced_reason: "changes_requested" });
    expect(lastCheck()?.output.title).toBe("Changes requested by rd20");
  });

  it("I-ENF-8 enforce: a pending card publishes in_progress and schedules card_wait; the card or the deadline completes it", async () => {
    await setMode("enforce");
    const wait = { GRAFT_POLICY_CARD_WAIT_SECONDS: "600" };
    const T0 = FIXED_NOW.getTime();
    approve(ALICE);
    expect(await run({ config: wait, nowMs: T0 })).toBe("published");
    expect(lastCheck()).toMatchObject({ status: "in_progress", conclusion: null });
    expect(lastCheck()?.output.title).toBe("Waiting for the intent card");
    expect(api.find("POST", /\/check-runs$/)[0]?.body).not.toHaveProperty("conclusion");
    expect(api.find("POST", /\/check-runs$/)[0]?.body).not.toHaveProperty("completed_at");
    expect(await lastVerdict()).toMatchObject({
      check_conclusion: "pending",
      enforced_conclusion: "pending",
      enforced_reason: "card_pending",
    });
    const change = await getChangeByNumber(t.db, REPO_ID, PR_NUMBER);
    const waits = (await jobsNamed(t.db, "policy.evaluate")).filter(
      (j) => j.singleton_key === `policy:cardwait:${change?.id}:${HEAD_SHA}`,
    );
    expect(waits).toHaveLength(1);
    expect(waits[0]?.data).toMatchObject({ trigger: "card_wait", prNumber: PR_NUMBER });
    const delay = (waits[0]?.start_after.getTime() ?? 0) - (waits[0]?.created_on.getTime() ?? 0);
    expect(delay).toBeGreaterThan(590_000);
    expect(delay).toBeLessThan(610_000);

    // A later evaluation inside the window still waits, and does not schedule a second job.
    expect(await run({ config: wait, nowMs: T0 + 60_000 })).toBe("unchanged");
    expect(
      (await jobsNamed(t.db, "policy.evaluate")).filter((j) =>
        j.singleton_key?.startsWith("policy:cardwait:"),
      ),
    ).toHaveLength(1);

    // The card arrives before the deadline: completed.
    const cardId = await addCard(t.db, {
      changeId: change?.id as string,
      headSha: HEAD_SHA,
      risk: "logic",
      createdAt: new Date(T0 + 90_000),
    });
    await addDisplay(t.db, {
      changeId: change?.id as string,
      cardId,
      status: "ok",
      shownAt: new Date(T0 + 90_000),
    });
    expect(await run({ config: wait, nowMs: T0 + 120_000 })).toBe("published");
    expect(lastCheck()).toMatchObject({ status: "completed", conclusion: "success" });
    expect(policyChecks()).toHaveLength(1);
  });

  it("I-ENF-8b enforce: with no card, the deadline job concludes on the strict facts", async () => {
    await setMode("enforce");
    const wait = { GRAFT_POLICY_CARD_WAIT_SECONDS: "600" };
    const T0 = FIXED_NOW.getTime();
    await run({ config: wait, nowMs: T0 });
    expect(lastCheck()?.status).toBe("in_progress");
    expect(await run({ data: { trigger: "card_wait" }, config: wait, nowMs: T0 + 600_000 })).toBe(
      "published",
    );
    expect(lastCheck()).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(await lastVerdict()).toMatchObject({
      enforced_reason: "approvals_missing",
      risk_source: "card_pending",
      check_conclusion: "failure",
    });
    // card_unavailable never waits.
    const change = await getChangeByNumber(t.db, REPO_ID, PR_NUMBER);
    const cardId = await addCard(t.db, {
      changeId: change?.id as string,
      headSha: HEAD_2,
      status: "unavailable",
      createdAt: new Date(T0),
    });
    const pull = api.state.pulls.get(PR_NUMBER);
    if (!pull) throw new Error("no pull");
    pull.head.sha = HEAD_2;
    pull.updated_at = "2026-10-14T11:30:00Z";
    await addDisplay(t.db, {
      changeId: change?.id as string,
      cardId,
      status: "unavailable",
      shownAt: new Date(T0),
    });
    await run({ config: wait, nowMs: T0 + 700_000 });
    expect(policyChecks().find((c) => c.head_sha === HEAD_2)?.status).toBe("completed");
  });

  it("I-ENF-9 with the rendering frozen, a mode flip enforce → report republishes neutral (the published term of the hash)", async () => {
    frozen.on = true;
    await setMode("enforce");
    approve(ALICE);
    expect(await run()).toBe("published");
    expect(lastCheck()?.conclusion).toBe("success");
    expect(await run()).toBe("unchanged");
    await setMode("report");
    expect(await run()).toBe("published");
    expect(lastCheck()).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(lastCheck()?.output.title).toBe("frozen title");
    // The hash term on its own: everything equal but what was sent gives another hash.
    const base = {
      verdict: null,
      approvals: null,
      policyStatus: "ok",
      policyFileSha: null,
      policyHash: null,
      errors: [],
      headSha: HEAD_SHA,
      baseRef: "main",
      commitSha: HEAD_SHA,
      policyMode: "enforce",
      enforced: {
        conclusion: "success" as const,
        reason: "requirements_met" as const,
        constraints: [],
      },
      breakGlass: { state: "none" as const, actorId: null, headSha: HEAD_SHA },
      rendered: { title: "t", summary: "s", details: "d" },
    };
    expect(
      policyFactsHash({
        ...base,
        published: { status: "completed", conclusion: "success", stored: "success" },
      }),
    ).not.toBe(
      policyFactsHash({
        ...base,
        published: { status: "completed", conclusion: "neutral", stored: "neutral" },
      }),
    );
  });

  it("I-ENF-10 a rollback between the mode read and the publish: stale, no error log, the fan-out republishes neutral", async () => {
    await setMode("enforce");
    approve(ALICE);
    // Hold the file listing, which the job reads after the mode and before the lock.
    const hold = api.block("GET", /\/pulls\/\d+\/files$/);
    const pending = run();
    await hold.reached;
    await setMode("report");
    hold.release();
    expect(await pending).toBe("stale");
    expect(policyChecks()).toEqual([]);
    expect(refused.map((e) => e.refusal)).toEqual(["mode_report"]);
    expect(logged).toContain("mode changed during evaluation");
    const lines = logged
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { level: number; msg: string });
    expect(lines.filter((l) => l.level >= 50 && l.msg !== "GitHub write refused")).toEqual([]);
    expect(await verdictRows()).toEqual([]);
    // The rollback's fan-out re-evaluates the PR: neutral.
    expect(await run({ data: { trigger: "mode" }, nowMs: FIXED_NOW.getTime() + 1000 })).toBe(
      "published",
    );
    expect(lastCheck()).toMatchObject({ status: "completed", conclusion: "neutral" });
  });

  it("I-ENF-11 membership.added → one team fan-out per installation per 5 minutes, after the window closes; only team-constrained open PRs are re-evaluated", async () => {
    // PR 2: team constraint. PR 3: no team constraint. PR 4: team constraint, closed.
    await run();
    putContent(api, "b".repeat(40), "version: 1\n");
    const others = [
      { number: 3, policy: "version: 1\n", state: "open" as const },
      { number: 4, policy: TEAM_POLICY, state: "open" as const },
    ];
    for (const o of others) {
      clearPolicyCache();
      putContent(api, "c".repeat(40), o.policy);
      api.state.branches.set("main", "c".repeat(40));
      api.state.pulls.set(
        o.number,
        makePull({ number: o.number, head: { ...makePull().head, sha: fakeSha(o.number) } }),
      );
      api.state.files.set(o.number, [srcFile()]);
      await run({ data: { prNumber: o.number } });
    }
    await t.db.updateTable("changes").set({ state: "closed" }).where("pr_number", "=", 4).execute();

    const ctx = jobContext(t);
    await scheduleTeamFanout.handle(event("membership.added", "d-m1"), ctx);
    await scheduleTeamFanout.handle(event("membership.added", "d-m2"), ctx);
    await scheduleTeamFanout.handle(event("team.deleted", "d-t1"), ctx);
    const fanouts = await jobsNamed(t.db, "policy.team_fanout");
    expect(fanouts).toHaveLength(1);
    const window = Math.floor(FIXED_NOW.getTime() / 300_000);
    expect(fanouts[0]?.data).toEqual({ installationId: INSTALLATION_ID, window });
    expect(fanouts[0]?.singleton_key).toBe(`policy:team:${INSTALLATION_ID}:${window}`);
    // Trailing edge: it starts after the window closes, plus a margin.
    const delay =
      (fanouts[0]?.start_after.getTime() ?? 0) - (fanouts[0]?.created_on.getTime() ?? 0);
    const windowEnd = (window + 1) * 300_000;
    expect(delay).toBeGreaterThanOrEqual(windowEnd - FIXED_NOW.getTime() + 55_000);
    expect(delay).toBeLessThan(windowEnd - FIXED_NOW.getTime() + 65_000);

    const before = (await jobsNamed(t.db, "policy.evaluate")).length;
    expect(await fanoutTeamChange({ installationId: INSTALLATION_ID, window }, ctx)).toBe(1);
    const sent = (await jobsNamed(t.db, "policy.evaluate")).slice(before);
    expect(sent.map((j) => j.data)).toEqual([
      {
        installationId: INSTALLATION_ID,
        repositoryId: REPO_ID,
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        trigger: "team",
      },
    ]);
    expect(sent[0]?.singleton_key).toBe(`policy:team:${REPO_ID}:${PR_NUMBER}:${window}`);
    // An inactive installation fans out nothing.
    await t.db.updateTable("installations").set({ suspended_at: FIXED_NOW }).execute();
    expect(await fanoutTeamChange({ installationId: INSTALLATION_ID, window }, ctx)).toBe(0);
    await scheduleTeamFanout.handle(event("membership.added", "d-m3"), ctx);
    expect(await jobsNamed(t.db, "policy.team_fanout")).toHaveLength(1);
  });

  it("I-ENF-11b membership.removed after a fan-out already ran: a later fan-out re-evaluates the PR (trailing-edge debounce)", async () => {
    await setMode("enforce");
    approve(ALICE);
    await run();
    expect(lastCheck()?.conclusion).toBe("success");
    const T0 = FIXED_NOW.getTime();
    const at = (ms: number) => ({ ...jobContext(t), clock: { now: () => new Date(ms) } });

    // 1. membership.added: one fan-out, which runs at its start time.
    await scheduleTeamFanout.handle(event("membership.added", "d-r1"), at(T0));
    const [first] = await jobsNamed(t.db, "policy.team_fanout");
    if (!first) throw new Error("no fan-out");
    const ranAt = T0 + (first.start_after.getTime() - first.created_on.getTime());
    const before = (await jobsNamed(t.db, "policy.evaluate")).length;
    expect(await fanoutTeamChange(first.data as never, at(ranAt))).toBe(1);
    await sql`update pgboss.job set state = 'completed', completed_on = now()
              where id = ${first.id}::uuid`.execute(t.db);

    // 2. alice leaves the team, one second after the fan-out ran.
    api.state.teams.get("security")?.members.delete("alice");
    const removedAt = ranAt + 1000;
    const removed = event("membership.added", "d-r2") as { payload: { action: string } };
    removed.payload.action = "removed";
    await scheduleTeamFanout.handle(removed as never, at(removedAt));
    const later = (await jobsNamed(t.db, "policy.team_fanout")).filter((j) => j.id !== first.id);
    // A new fan-out exists, and it starts after the removal.
    expect(later).toHaveLength(1);
    const second = later[0];
    if (!second) throw new Error("no second fan-out");
    const secondRunsAt = removedAt + (second.start_after.getTime() - second.created_on.getTime());
    expect(secondRunsAt).toBeGreaterThan(removedAt);
    // Its per-PR re-evaluation is not swallowed by the first fan-out's.
    expect(await fanoutTeamChange(second.data as never, at(secondRunsAt))).toBe(1);
    const sent = (await jobsNamed(t.db, "policy.evaluate")).slice(before);
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((j) => j.singleton_key)).size).toBe(2);
    // The re-evaluation reads the new membership: the approval no longer qualifies.
    expect(await run({ data: { trigger: "team" }, nowMs: secondRunsAt })).toBe("published");
    expect(lastCheck()?.conclusion).toBe("failure");
  });

  it("I-ENF-12 bounds: 25 approvers → 20 permission checks and 5 check_limit; at most 100 membership requests", async () => {
    await setMode("enforce");
    const teams = Array.from({ length: 8 }, (_, i) => `t${i}`);
    loadPolicyScenario(api, {
      policy: `version: 1\ndefault:\n  require: { humans: 10, team: [${teams.join(", ")}] }\n`,
    });
    for (const team of teams) api.state.teams.set(team, { members: new Map() });
    const approvers = Array.from({ length: 25 }, (_, i) => ({
      login: `rev${String(i).padStart(2, "0")}`,
      userId: 700 + i,
    }));
    for (const u of approvers) api.state.permissions.set(u.login, { id: u.userId, role: "write" });
    approve(...approvers);
    await run();
    expect(permissionRequests()).toHaveLength(20);
    const memberships = teamRequests().filter((r) => r.path.includes("/memberships/"));
    const lookups = teamRequests().filter((r) => !r.path.includes("/memberships/"));
    expect(lookups).toHaveLength(8);
    expect(memberships).toHaveLength(100);
    const text = lastCheck()?.output.text ?? "";
    expect(text).toContain(
      "- not counted: `rev20`, `rev21`, `rev22`, `rev23`, `rev24` (too many approvers to check)",
    );
    expect(text).toContain("(too many checks in one evaluation)");
    expect(lastCheck()?.conclusion).toBe("failure");
    expect((await lastVerdict())?.approvals).toMatchObject({ counted: 20, notCounted: 5 });
  });

  it("I-ENF-12b public repository: 20 outsiders whose logins sort first do not use up the role checks of a member", async () => {
    await setMode("enforce");
    const outsiders = Array.from({ length: 20 }, (_, i) => ({
      login: `aaa${String(i).padStart(2, "0")}`,
      userId: 900 + i,
    }));
    const ZED = { login: "zed", userId: 950 };
    api.state.permissions.set(ZED.login, { id: ZED.userId, role: "maintain" });
    api.state.teams.get("security")?.members.set("zed", "active");
    api.state.reviews.set(PR_NUMBER, [
      ...outsiders.map((u, i) => makeReview({ id: 40 + i, ...u, association: "NONE" })),
      makeReview({ id: 99, ...ZED, association: "MEMBER" }),
    ]);
    await run();
    // The member is checked first; the outsiders after, and only up to the bound.
    expect(permissionRequests()[0]?.path).toMatch(/\/collaborators\/zed\/permission$/);
    expect(permissionRequests()).toHaveLength(20);
    expect(lastCheck()?.conclusion).toBe("success");
    expect((await lastVerdict())?.approvals).toMatchObject({ counted: 1, notCounted: 20 });
    // The last outsider is past the bound and does not count (fail closed).
    expect(lastCheck()?.output.text).toContain("(too many approvers to check)");
  });

  it("I-ENF-15 transfer race: a job for the new installation on a row still owned by the old one never acts on the old modes", async () => {
    await setMode("enforce");
    approve(ALICE);
    const NEW_INSTALLATION = INSTALLATION_ID + 1;
    await t.db
      .insertInto("installations")
      .values({
        id: NEW_INSTALLATION,
        account_id: 9000002,
        account_login: "new-owner",
        account_type: "Organization",
        repository_selection: "selected",
        permissions: JSON.stringify(PERMISSIONS),
        permissions_read_at: FIXED_NOW,
      })
      .execute();
    expect(await run({ data: { installationId: NEW_INSTALLATION } })).toBe("published");
    // Nothing refused, nothing failed: the check is neutral and the row is untouched.
    expect(refused).toEqual([]);
    expect(lastCheck()).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(await lastVerdict()).toMatchObject({
      policy_mode: "report",
      check_conclusion: "neutral",
    });
    const row = await t.db
      .selectFrom("repositories")
      .select(["installation_id", "policy_mode"])
      .where("id", "=", REPO_ID)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ installation_id: INSTALLATION_ID, policy_mode: "enforce" });
  });

  it("I-ENF-13 enforce: no policy and an invalid policy fail with the fix text; report mode stays neutral", async () => {
    for (const [policy, reason, fix] of [
      [null, "no_policy", "Add one to report what Graft would require"],
      ["version: 1\nrules: [\n", "policy_invalid", "Fix the file on `main`"],
    ] as const) {
      clearPolicyCache();
      await truncateAll(t.db);
      await seedWorld(t.db);
      await setPermissions(PERMISSIONS);
      api.state.checkRuns.length = 0;
      api.state.comments.length = 0;
      loadPolicyScenario(api, { policy });
      await run();
      expect(lastCheck()?.conclusion, `${reason} report`).toBe("neutral");
      expect((await lastVerdict())?.enforced_reason).toBe(reason);
      expect(policySection()).toContain(
        "**In enforce mode this check would be:** `failure`, no valid graft.yaml on `main`.",
      );
      await setMode("enforce");
      await run({ data: { trigger: "mode" }, nowMs: FIXED_NOW.getTime() + 1000 });
      expect(lastCheck()?.conclusion, `${reason} enforce`).toBe("failure");
      expect(lastCheck()?.output.title).toBe("No valid graft.yaml on main");
      expect(lastCheck()?.output.summary).toContain(fix);
      expect(await lastVerdict()).toMatchObject({
        enforced_reason: reason,
        check_conclusion: "failure",
      });
    }
  });

  it("I-ENF-14 enforce: 301 reviews → failure reviews_truncated", async () => {
    await setMode("enforce");
    api.state.reviews.set(
      PR_NUMBER,
      Array.from({ length: 301 }, (_, i) =>
        makeReview({
          id: 1000 + i,
          login: i === 0 ? "alice" : `c${i}`,
          userId: i === 0 ? 501 : 9000 + i,
          state: i === 0 ? "APPROVED" : "COMMENTED",
        }),
      ),
    );
    await run();
    expect(lastCheck()?.conclusion).toBe("failure");
    expect(lastCheck()?.output.title).toBe("Too many reviews to count (over 300)");
    expect((await lastVerdict())?.enforced_reason).toBe("reviews_truncated");
  });
});
