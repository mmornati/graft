/**
 * Phase 1 step 3: break-glass and the audit log (spec §10, I-BG). The policy job against the fake
 * GitHub API, with the real mutation gate: who applied the label comes from the issue events API,
 * their role from the collaborator API, and the bypass binds to one head SHA.
 */
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import { migrateDownOne, migrateToLatest } from "../../src/db/migrator.js";
import { parseManagedComment } from "../../src/github/managed-comment.js";
import { mergedUnderBreakGlass } from "../../src/modules/audit/index.js";
import { getChangeByNumber } from "../../src/modules/changes/index.js";
import { mutationGate } from "../../src/modules/modes/index.js";
import { schedulePolicy } from "../../src/modules/policy/handlers.js";
import {
  type EvaluateData,
  evaluatePolicyJobRun,
  policyFactsHash,
} from "../../src/modules/policy/job.js";
import { purgeInstallation } from "../../src/pilot/purge.js";
import { clearPolicyCache } from "../../src/policy/load.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture } from "../helpers/fixtures.js";
import {
  fakeSha,
  HEAD_SHA,
  INSTALLATION_ID,
  OWNER,
  PR_AUTHOR_ID,
  PR_NUMBER,
  REPO,
} from "../helpers/github-builders.js";
import { EVAL_DATA, jobsNamed, loadPolicyScenario } from "../helpers/policy-scenario.js";
import { seedWorld } from "../helpers/seed.js";

const LABEL = "graft:break-glass";
const FULL_NAME = `${OWNER}/${REPO}`;
/** Every PR touching src/** is blocked: the normal enforce conclusion is `failure blocked`. */
const BLOCK_POLICY = "version: 1\nrules:\n  - match: { paths: ['src/**'] }\n    block: true\n";
const HEAD_2 = fakeSha(0xbeef);

interface Who {
  login: string;
  id: number;
  type?: string;
}
const MAYA: Who = { login: "maya", id: 701 }; // maintain
const TOM: Who = { login: "tom", id: 702 }; // triage
const ADA: Who = { login: "ada", id: 703 }; // admin
const WALT: Who = { login: "walt", id: 704 }; // write
const BOT: Who = { login: "deploy-bot[bot]", id: 705, type: "Bot" };
const AUTHOR: Who = { login: "graft-dev", id: PR_AUTHOR_ID };

let t: TestApp;
let api: FakeGitHubApi;
let tick = 0;
let eventId = 1;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

async function setMode(policy: "report" | "enforce"): Promise<void> {
  await t.db.updateTable("repositories").set({ policy_mode: policy }).execute();
}

beforeEach(async () => {
  tick = 0;
  eventId = 1;
  await truncateAll(t.db);
  await seedWorld(t.db);
  await t.db
    .updateTable("installations")
    .set({
      permissions: JSON.stringify({ checks: "write", pull_requests: "write", issues: "read" }),
      permissions_read_at: FIXED_NOW,
    })
    .execute();
  clearPolicyCache();
  api = createFakeGitHubApi();
  t.deps.github = fakeGitHubFactory(api, mutationGate(t.db, { modeCeiling: "enforce" }));
  loadPolicyScenario(api, { policy: BLOCK_POLICY });
  api.state.permissions.set(MAYA.login, { id: MAYA.id, role: "maintain" });
  api.state.permissions.set(TOM.login, { id: TOM.id, role: "triage" });
  api.state.permissions.set(ADA.login, { id: ADA.id, role: "admin" });
  api.state.permissions.set(WALT.login, { id: WALT.id, role: "write" });
  api.state.permissions.set(BOT.login, { id: BOT.id, role: "admin" });
  await setMode("enforce");
});

const config = (over: Record<string, string> = {}) =>
  testConfig({ GRAFT_MODE_CEILING: "enforce", GRAFT_POLICY_CARD_WAIT_SECONDS: "0", ...over });
/** Each run one second after the previous one, so that the order of evaluations is clear. */
const run = (o: { data?: Partial<EvaluateData>; config?: Record<string, string> } = {}) => {
  const at = FIXED_NOW.getTime() + 1000 * tick++;
  return evaluatePolicyJobRun(
    { ...EVAL_DATA, ...o.data },
    { ...jobContext(t), config: config(o.config), clock: { now: () => new Date(at) } },
  );
};
/** The run the `labeled` handler queues for the break-glass label (D4). */
const runLabeled = (o: { head?: string; config?: Record<string, string> } = {}) =>
  run({
    data: { breakGlassHeadSha: o.head ?? HEAD_SHA },
    ...(o.config ? { config: o.config } : {}),
  });

const pull = () => {
  const p = api.state.pulls.get(PR_NUMBER);
  if (!p) throw new Error("no pull");
  return p;
};
function labelEvent(kind: "labeled" | "unlabeled", who: Who, name = LABEL): void {
  const log = api.state.issueEvents.get(PR_NUMBER) ?? [];
  log.push({
    id: eventId++,
    event: kind,
    actor: { id: who.id, login: who.login, type: who.type ?? "User" },
    label: { name, color: "b60205" },
    created_at: `2026-10-14T11:${String(eventId % 60).padStart(2, "0")}:00Z`,
  });
  api.state.issueEvents.set(PR_NUMBER, log);
}
/** `who` adds the label on GitHub: an issue event, and the label on the pull. */
function label(who: Who, name = LABEL): void {
  labelEvent("labeled", who, name);
  pull().labels = [...(pull().labels ?? []).filter((l) => l.name !== name), { name }];
}
function unlabel(who: Who): void {
  labelEvent("unlabeled", who);
  pull().labels = (pull().labels ?? []).filter((l) => l.name !== LABEL);
}
function push(sha: string): void {
  pull().head.sha = sha;
  pull().updated_at = "2026-10-14T11:30:00Z";
}

const policyChecks = (head = HEAD_SHA) =>
  api.state.checkRuns.filter((c) => c.name === "graft/policy" && c.head_sha === head);
const lastCheck = (head = HEAD_SHA) => policyChecks(head).at(-1);
const lastVerdict = async () =>
  (await t.db.selectFrom("policy_verdicts").selectAll().orderBy("facts_read_at").execute()).at(-1);
const auditRows = () =>
  t.db.selectFrom("audit_log").selectAll().orderBy("created_at").orderBy("kind").execute();
const policySection = (): string =>
  parseManagedComment(api.state.comments[0]?.body ?? "")?.get("policy") ?? "";
const eventReads = () => api.requests.filter((r) => /\/issues\/\d+\/events$/.test(r.path));
const roleReads = () =>
  api.requests.filter((r) => /\/collaborators\/[^/]+\/permission$/.test(r.path));
const changeId = async () => (await getChangeByNumber(t.db, 2000001, PR_NUMBER))?.id as string;

describe("break-glass and audit log (integration)", () => {
  it("I-BG-1 migration 0010 down then up; down refuses while a break_glass verdict exists", async () => {
    await truncateAll(t.db);
    // Step 4's migration sits on top of 0010.
    expect(await migrateDownOne(t.db)).toEqual(["0011_guard"]);
    expect(await migrateDownOne(t.db)).toEqual(["0010_audit_log"]);
    const reasonCheck = async () =>
      (
        await sql<{ def: string }>`
          select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'policy_verdicts_enforced_reason_check'`.execute(t.db)
      ).rows[0]?.def ?? "";
    try {
      const table = await sql<{ r: string | null }>`
        select to_regclass('audit_log')::text as r`.execute(t.db);
      expect(table.rows[0]?.r).toBeNull();
      expect(await reasonCheck()).not.toContain("break_glass");
      expect(await reasonCheck()).toContain("card_pending");
    } finally {
      expect(await migrateToLatest(t.db)).toEqual(["0010_audit_log", "0011_guard"]);
    }
    expect(await reasonCheck()).toContain("break_glass");
    const indexes = await sql<{ indexname: string }>`
      select indexname from pg_indexes where tablename = 'audit_log' order by indexname`.execute(
      t.db,
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual([
      "audit_log_change_idx",
      "audit_log_ignored_once",
      "audit_log_pkey",
      "audit_log_repo_idx",
      "audit_log_stale_once",
    ]);

    // A break_glass verdict cannot be stored under the 0009 schema: down fails and changes nothing.
    await seedWorld(t.db);
    await setMode("enforce");
    label(MAYA);
    expect(await runLabeled()).toBe("published");
    expect((await lastVerdict())?.enforced_reason).toBe("break_glass");
    expect(await migrateDownOne(t.db)).toEqual(["0011_guard"]);
    try {
      await expect(migrateDownOne(t.db)).rejects.toThrow();
      expect(await auditRows()).toHaveLength(1);
      expect(await reasonCheck()).toContain("break_glass");
    } finally {
      expect(await migrateToLatest(t.db)).toEqual(["0011_guard"]);
    }

    // The CHECKs: a reason iff ignored or stale; a 40-hex head; known kinds and roles.
    const base = (await auditRows())[0];
    if (!base) throw new Error("no row");
    const insert = (over: Record<string, unknown>) =>
      sql`insert into audit_log (repository_id, change_id, pr_number, head_sha, kind, reason,
        actor_role, policy_mode, created_at)
        values (${base.repository_id}, ${base.change_id}, 2, ${over.head ?? HEAD_2},
          ${over.kind ?? "stale"}, ${over.reason ?? null}, ${over.role ?? null},
          ${over.mode ?? "report"}, now())`.execute(t.db);
    await expect(insert({ kind: "stale" })).rejects.toThrow(/check constraint/);
    await expect(insert({ kind: "applied", reason: "bot" })).rejects.toThrow(/check constraint/);
    await expect(insert({ kind: "stale", reason: "head_moved", head: "ABC" })).rejects.toThrow(
      /check constraint/,
    );
    await expect(insert({ kind: "approved" })).rejects.toThrow(/check constraint/);
    await expect(insert({ kind: "applied", role: "owner" })).rejects.toThrow(/check constraint/);
    await expect(insert({ kind: "applied", mode: "off" })).rejects.toThrow(/check constraint/);
    await insert({ kind: "stale", reason: "head_moved" });
    // At most one stale row per (change, head).
    await expect(insert({ kind: "stale", reason: "head_moved" })).rejects.toThrow(/unique/);
  });

  it("I-BG-2 enforce: a maintainer labels a would_block PR → success, one applied row with the live head and policy_mode enforce", async () => {
    expect(await run()).toBe("published");
    expect(lastCheck()).toMatchObject({ status: "completed", conclusion: "failure" });
    expect((await lastVerdict())?.enforced_reason).toBe("blocked");

    label(MAYA);
    expect(await runLabeled()).toBe("published");
    expect(lastCheck()).toMatchObject({ status: "completed", conclusion: "success" });
    expect(lastCheck()?.output.title).toBe("Bypassed by break-glass (maya)");
    expect(await lastVerdict()).toMatchObject({
      enforced_conclusion: "success",
      enforced_reason: "break_glass",
      check_conclusion: "success",
      outcome: "would_block",
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "applied",
      reason: null,
      head_sha: HEAD_SHA,
      pr_number: PR_NUMBER,
      actor_login: "maya",
      actor_role: "maintain",
      self: false,
      policy_mode: "enforce",
    });
    expect(Number(rows[0]?.actor_id)).toBe(MAYA.id);
    expect(rows[0]?.label_event_at).toBeInstanceOf(Date);
    expect(policySection()).toContain(
      "**Break-glass** by `maya` (maintain) on `ec26c3e`: this check passes for this commit only.",
    );
    // The details show what was bypassed: the block rule, below the break-glass block.
    const details = lastCheck()?.output.text ?? "";
    expect(details).toContain("**Break-glass**");
    expect(details).toContain("→ block");
    // One events read and one role check, and nothing on the same head after that (I-BG-11).
    expect(eventReads()).toHaveLength(1);
    expect(roleReads()).toHaveLength(1);

    // D10: the break-glass term alone changes the facts hash, so a label trigger republishes even
    // when nothing else differs.
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
      enforced: { conclusion: "failure" as const, reason: "blocked" as const, constraints: [] },
      published: {
        status: "completed" as const,
        conclusion: "failure" as const,
        stored: "failure" as const,
      },
      rendered: { title: "t", summary: "s", details: "d" },
    };
    expect(
      policyFactsHash({
        ...base,
        breakGlass: { state: "ignored", actorId: TOM.id, headSha: HEAD_SHA },
      }),
    ).not.toBe(
      policyFactsHash({ ...base, breakGlass: { state: "none", actorId: null, headSha: HEAD_SHA } }),
    );
  });

  it("I-BG-3 enforce: a triage user (or a writer) labels → normal failure, one ignored role_too_low row each; labelling again writes no second row", async () => {
    label(TOM);
    expect(await runLabeled()).toBe("published");
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });
    expect((await lastVerdict())?.enforced_reason).toBe("blocked");
    let rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "ignored",
      reason: "role_too_low",
      actor_login: "tom",
      actor_role: "triage",
      head_sha: HEAD_SHA,
    });
    expect(policySection()).toContain(
      "**Break-glass label ignored:** applied by `tom` (triage). Only maintain or admin can bypass the policy.",
    );

    // Tom removes and re-applies it: no second row for (change, head, tom).
    labelEvent("unlabeled", TOM);
    label(TOM);
    expect(await runLabeled()).toMatch(/published|unchanged/);
    expect(await auditRows()).toHaveLength(1);
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });

    // Write access is not enough either.
    label(WALT);
    expect(await runLabeled()).toBe("published");
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });
    rows = await auditRows();
    expect(rows.map((r) => [r.kind, r.reason, r.actor_login, r.actor_role])).toEqual([
      ["ignored", "role_too_low", "tom", "triage"],
      ["ignored", "role_too_low", "walt", "write"],
    ]);
    // Walt again: still two rows.
    label(WALT);
    await runLabeled();
    expect(await auditRows()).toHaveLength(2);
  });

  it("I-BG-4 the actor comes from the issue events API, not the payload: the delivery names a maintainer, the events a triage user → ignored", async () => {
    const fixture = loadFixture("pull_request.labeled.break-glass").payload;
    // The signed delivery says maya (maintain) labelled; GitHub's record says tom did.
    (fixture as { sender: unknown }).sender = {
      login: MAYA.login,
      id: MAYA.id,
      type: "User",
    };
    label(TOM);
    const ctx = { ...jobContext(t), config: config() };
    await schedulePolicy.handle(
      {
        name: "pull_request",
        id: "d-bg-4",
        deliveryId: "d-bg-4",
        payload: structuredClone(fixture),
      } as never,
      ctx,
    );
    const queued = await jobsNamed(t.db, "policy.evaluate");
    expect(queued).toHaveLength(1);
    const data = queued[0]?.data as EvaluateData;
    expect(data.breakGlassHeadSha).toBe(HEAD_SHA);
    // Ids and the head SHA only: no login from the payload reaches the job.
    expect(JSON.stringify(data)).not.toContain(MAYA.login);
    expect(await run({ data })).toBe("published");
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });
    const rows = await auditRows();
    expect(rows.map((r) => [r.kind, r.reason, r.actor_login])).toEqual([
      ["ignored", "role_too_low", "tom"],
    ]);
    expect(roleReads().map((r) => r.path)).toEqual([
      `/repos/${FULL_NAME}/collaborators/tom/permission`,
    ]);
  });

  it("I-BG-5 D4: the delivery's head differs from the live head → stale row, not applied, the comment asks to re-apply", async () => {
    label(MAYA);
    // Labelled at HEAD_2's parent... the live head is HEAD_SHA, the delivery carried HEAD_2.
    expect(await runLabeled({ head: HEAD_2 })).toBe("published");
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });
    expect((await lastVerdict())?.enforced_reason).toBe("blocked");
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "stale",
      reason: "head_moved",
      head_sha: HEAD_SHA,
      actor_id: null,
      actor_login: null,
    });
    expect(policySection()).toContain(
      "**Break-glass not applied:** the pull request changed after the label was added. Remove and re-apply the label.",
    );
    // Refused before any read: the payload can only refuse.
    expect(eventReads()).toEqual([]);
    expect(roleReads()).toEqual([]);
    // A second stale delivery for the same head writes nothing more.
    await runLabeled({ head: HEAD_2 });
    expect(await auditRows()).toHaveLength(1);
    // A later trigger on the same head keeps saying so, from the log.
    await run({ data: { trigger: "review" } });
    expect(policySection()).toContain("**Break-glass not applied:**");
    expect(eventReads()).toEqual([]);
  });

  it("I-BG-6 after an applied break-glass, a push: the new head gets the normal conclusion; the label stays and no row is written", async () => {
    label(MAYA);
    await runLabeled();
    expect(lastCheck()).toMatchObject({ conclusion: "success" });
    const reads = eventReads().length;

    push(HEAD_2);
    expect(await run()).toBe("published");
    expect(lastCheck(HEAD_2)).toMatchObject({ status: "completed", conclusion: "failure" });
    expect((await lastVerdict())?.enforced_reason).toBe("blocked");
    expect(pull().labels?.map((l) => l.name)).toContain(LABEL);
    expect(await auditRows()).toHaveLength(1);
    expect(policySection()).not.toContain("Break-glass");
    expect(eventReads()).toHaveLength(reads);
    // The old head keeps its success; only the new head is evaluated.
    expect(lastCheck(HEAD_SHA)).toMatchObject({ conclusion: "success" });
  });

  it("I-BG-7 unlabel while applied → removed row, normal conclusion", async () => {
    label(MAYA);
    await runLabeled();
    expect(lastCheck()).toMatchObject({ conclusion: "success" });
    unlabel(ADA);
    // `pull_request.unlabeled` queues a normal `pr` run (D9): no head filter.
    expect(await run()).toBe("published");
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });
    expect((await lastVerdict())?.enforced_reason).toBe("blocked");
    const rows = await auditRows();
    expect(rows.map((r) => [r.kind, r.actor_login, r.reason])).toEqual([
      ["applied", "maya", null],
      ["removed", "ada", null],
    ]);
    expect(rows[1]).toMatchObject({ head_sha: HEAD_SHA, policy_mode: "enforce", self: false });
    expect(policySection()).not.toContain("Break-glass");
    // Another trigger: nothing more to write, nothing more to read.
    const reads = eventReads().length;
    await run({ data: { trigger: "review" } });
    expect(await auditRows()).toHaveLength(2);
    expect(eventReads()).toHaveLength(reads);
  });

  it("I-BG-8 report mode: the same as I-BG-2 → check neutral, would-bypass line, enforced_conclusion success, enforced_reason break_glass", async () => {
    await setMode("report");
    label(MAYA);
    expect(await runLabeled()).toBe("published");
    expect(lastCheck()).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(policyChecks().every((c) => c.conclusion === "neutral")).toBe(true);
    expect(lastCheck()?.output.title).toBe("Would block: rule 1");
    expect(await lastVerdict()).toMatchObject({
      check_conclusion: "neutral",
      enforced_conclusion: "success",
      enforced_reason: "break_glass",
      policy_mode: "report",
    });
    expect(policySection()).toContain(
      "**Break-glass** by `maya` (maintain) on `ec26c3e`: Graft would bypass the policy for this commit (report mode).",
    );
    expect(policySection()).toContain(
      "**In enforce mode this check would be:** `success` (break-glass by `maya`).",
    );
    expect(await auditRows()).toMatchObject([{ kind: "applied", policy_mode: "report" }]);
    // No check write in report mode carried anything but completed + neutral.
    for (const r of api.requests.filter((x) => x.method !== "GET" && /check-runs/.test(x.path))) {
      expect(r.body?.conclusion).toBe("neutral");
    }
  });

  it("I-BG-9 role check 403 → role_unverified; a bot → bot; the event not found within the cap → actor_unknown", async () => {
    label(MAYA);
    api.failNext("GET", /\/collaborators\/maya\/permission$/, 403);
    await runLabeled();
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });
    expect(policySection()).toContain("applied by `maya` (role could not be verified)");

    // A 404 is no better.
    api.state.permissions.delete(MAYA.login);
    labelEvent("unlabeled", MAYA);
    label(MAYA);
    await runLabeled();
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });

    // A bot, even one with admin: never counts, and no role is read for it.
    const roles = roleReads().length;
    label(BOT);
    await runLabeled();
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });
    expect(roleReads()).toHaveLength(roles);
    expect(policySection()).toContain("applied by `deploy-bot[bot]` (a bot)");

    // More than 10 pages of events: the latest one could be on a page Graft did not read.
    label(ADA);
    const log = api.state.issueEvents.get(PR_NUMBER) ?? [];
    for (let i = log.length; i < 1000; i++) {
      log.push({ id: eventId++, event: "subscribed", actor: { id: 1, login: "x", type: "User" } });
    }
    expect(log.length).toBe(1000);
    const before = eventReads().length;
    await runLabeled();
    expect(eventReads().length - before).toBe(10);
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });
    expect(policySection()).toContain(
      "applied by someone (who applied it could not be determined)",
    );
    // No labeled event at all is the same.
    api.state.issueEvents.set(PR_NUMBER, []);
    await runLabeled();
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });

    const rows = await auditRows();
    expect(rows.map((r) => [r.kind, r.reason, r.actor_login])).toEqual([
      ["ignored", "role_unverified", "maya"],
      ["ignored", "bot", "deploy-bot[bot]"],
      ["ignored", "actor_unknown", null],
    ]);
  });

  it("I-BG-10 self-use: the PR author is a maintainer → applied, self = true, the comment says so", async () => {
    api.state.permissions.set(AUTHOR.login, { id: AUTHOR.id, role: "maintain" });
    label(AUTHOR);
    await runLabeled();
    expect(lastCheck()).toMatchObject({ conclusion: "success" });
    expect(await auditRows()).toMatchObject([
      { kind: "applied", actor_login: "graft-dev", self: true },
    ]);
    expect(policySection()).toContain(
      "**Break-glass** by `graft-dev` (maintain) on `ec26c3e` (on their own pull request): this check passes for this commit only.",
    );
  });

  it("I-BG-11 a later trigger on the same head keeps the break-glass without a new events or role read", async () => {
    label(ADA);
    await runLabeled();
    expect(lastCheck()).toMatchObject({ conclusion: "success" });
    const reads = { events: eventReads().length, roles: roleReads().length };
    expect(reads).toEqual({ events: 1, roles: 1 });
    for (const trigger of ["review", "intent", "provenance", "rerequested"] as const) {
      expect(await run({ data: { trigger } }), trigger).toMatch(/published|unchanged/);
      expect(lastCheck()).toMatchObject({ conclusion: "success" });
      expect((await lastVerdict())?.enforced_reason).toBe("break_glass");
    }
    // Even the label's own trigger again: the applied row is enough.
    await runLabeled();
    expect({ events: eventReads().length, roles: roleReads().length }).toEqual(reads);
    expect(await auditRows()).toHaveLength(1);
  });

  it("I-BG-12 PRs without the label make no issue-events or role request", async () => {
    for (const trigger of ["pr", "review", "intent"] as const) await run({ data: { trigger } });
    // Another label is an ordinary label: the handler adds no head filter.
    label(MAYA, "hotfix");
    const ctx = { ...jobContext(t), config: config() };
    await schedulePolicy.handle(
      {
        name: "pull_request",
        id: "d-bg-12",
        deliveryId: "d-bg-12",
        payload: structuredClone(loadFixture("pull_request.labeled").payload),
      } as never,
      ctx,
    );
    const queued = await jobsNamed(t.db, "policy.evaluate");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data).not.toHaveProperty("breakGlassHeadSha");
    await run({ data: queued[0]?.data as EvaluateData });
    expect(eventReads()).toEqual([]);
    expect(roleReads()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("I-BG-13 mergedUnderBreakGlass: true for the head with an applied row, false for another head, false after removed", async () => {
    label(MAYA);
    await runLabeled();
    const id = await changeId();
    expect(await mergedUnderBreakGlass(t.db, id, HEAD_SHA)).toBe(true);
    expect(await mergedUnderBreakGlass(t.db, id, HEAD_2)).toBe(false);
    unlabel(MAYA);
    await run();
    expect(await mergedUnderBreakGlass(t.db, id, HEAD_SHA)).toBe(false);
    // Re-applied after the removal: true again.
    label(ADA);
    await runLabeled();
    expect(await mergedUnderBreakGlass(t.db, id, HEAD_SHA)).toBe(true);
    expect((await auditRows()).map((r) => r.kind)).toEqual(["applied", "removed", "applied"]);
  });

  it("I-BG-14 graft audit list: text and --json, filters, usage errors; pilot purge removes the rows", async () => {
    label(TOM);
    await runLabeled();
    label(MAYA);
    await runLabeled();
    push(HEAD_2);
    label(MAYA);
    await runLabeled({ head: HEAD_SHA });

    const ops = async (...argv: string[]) => {
      let out = "";
      let err = "";
      const deps: OpsDeps = {
        loadConfig: () => config(),
        openDb: () => testDb(),
        github: () => fakeGitHubFactory(api),
        now: () => FIXED_NOW,
        sleep: async () => {},
      };
      const code = await opsMain(argv, { out: (s) => (out += s), err: (s) => (err += s) }, deps);
      return { code, out, err };
    };
    const text = await ops("audit", "list", "--repo", FULL_NAME);
    expect(text.code, text.err).toBe(0);
    expect(text.out.trimEnd().split("\n")).toEqual([
      `2026-10-14T12:00:02.000Z  stale  #2  ${HEAD_2.slice(0, 7)}  unknown  enforce  head_moved`,
      "2026-10-14T12:00:01.000Z  applied  #2  ec26c3e  maya (maintain)  enforce",
      "2026-10-14T12:00:00.000Z  ignored  #2  ec26c3e  tom (triage)  enforce  role_too_low",
    ]);
    const json = await ops("audit", "list", "--repo", FULL_NAME.toUpperCase(), "--json");
    expect(json.code).toBe(0);
    const entries = JSON.parse(json.out).entries;
    expect(entries).toHaveLength(3);
    expect(entries[1]).toEqual({
      createdAt: "2026-10-14T12:00:01.000Z",
      kind: "applied",
      prNumber: PR_NUMBER,
      headSha: HEAD_SHA,
      actorLogin: "maya",
      actorRole: "maintain",
      self: false,
      policyMode: "enforce",
      reason: null,
      labelEventAt: expect.stringMatching(/^2026-10-14T11:/),
    });
    const applied = await ops("audit", "list", "--repo", FULL_NAME, "--kind", "applied", "--json");
    expect(JSON.parse(applied.out).entries.map((e: { kind: string }) => e.kind)).toEqual([
      "applied",
    ]);
    const since = await ops(
      "audit",
      "list",
      "--repo",
      FULL_NAME,
      "--since",
      "2026-10-14T12:00:01Z",
      "--limit",
      "1",
    );
    expect(since.out.trimEnd().split("\n")).toHaveLength(1);
    expect(since.out).toContain("stale");
    expect((await ops("audit", "list", "--repo", FULL_NAME, "--since", "2026-10-15")).out).toBe("");

    for (const bad of [
      ["--kind", "approved"],
      ["--limit", "501"],
      ["--limit", "0"],
      ["--since", "yesterday"],
      ["--since", "2026-02-30"],
    ]) {
      const r = await ops("audit", "list", "--repo", FULL_NAME, ...bad);
      expect(r.code, bad.join(" ")).toBe(2);
    }
    expect((await ops("audit", "list")).code).toBe(2);
    expect((await ops("audit", "show", "--repo", FULL_NAME)).code).toBe(2);
    const unknown = await ops("audit", "list", "--repo", "graft-sandbox/nope");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toBe("unknown repository\n");

    // Pilot purge removes every audit row of the installation.
    const purged = await purgeInstallation(t.db, {
      installationId: INSTALLATION_ID,
      schema: "pgboss",
      now: FIXED_NOW,
      dryRun: false,
      evenIfActive: true,
    });
    expect(purged.counts.audit_log).toBe(3);
    expect(await auditRows()).toEqual([]);
  });

  it("I-BG-15 GRAFT_BREAK_GLASS_LABEL=off: the label is ignored and no audit row is written", async () => {
    const off = { GRAFT_BREAK_GLASS_LABEL: "off" };
    label(MAYA);
    // The handler adds no head filter when the feature is off.
    const ctx = { ...jobContext(t), config: config(off) };
    await schedulePolicy.handle(
      {
        name: "pull_request",
        id: "d-bg-15",
        deliveryId: "d-bg-15",
        payload: structuredClone(loadFixture("pull_request.labeled.break-glass").payload),
      } as never,
      ctx,
    );
    const queued = await jobsNamed(t.db, "policy.evaluate");
    expect(queued[0]?.data).not.toHaveProperty("breakGlassHeadSha");
    // Even a run that carries one (queued before the switch) does nothing.
    expect(await runLabeled({ config: off })).toBe("published");
    expect(lastCheck()).toMatchObject({ conclusion: "failure" });
    expect((await lastVerdict())?.enforced_reason).toBe("blocked");
    expect(await auditRows()).toEqual([]);
    expect(eventReads()).toEqual([]);
    expect(policySection()).not.toContain("Break-glass");
  });
});
