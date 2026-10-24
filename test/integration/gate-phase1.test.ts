/**
 * Phase 1 step 7: the Phase 1 gate against the test database (I-P1G-1 to I-P1G-10, U-P1G-11,
 * I-DB-16). The report is read from the database only: no GitHub client is ever made.
 */
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import { migrateDownOne, migrateToLatest } from "../../src/db/migrator.js";
import { gatherPhase1Gate } from "../../src/pilot/gate-phase1.js";
import type { Phase1GateReport } from "../../src/pilot/gate-phase1-render.js";
import { createTestApp, fakeGitHubFactory, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi } from "../helpers/fake-github-api.js";
import { commitMessage, makeCommit, makePull, OWNER, REPO } from "../helpers/github-builders.js";
import { createTestToken } from "../helpers/mcp-client.js";
import {
  addGuardEvent,
  addMerged,
  addP1Verdict,
  addRun,
  P1_PILOTS,
  P1_SENTINELS,
  P1_SINCE,
  P1_UNTIL,
  seedPhase1World,
} from "../helpers/phase1-seed.js";
import {
  addChange,
  addDelivery,
  addIncidentRow,
  addInstallation,
  SHA,
} from "../helpers/pilot-seed.js";
import { seedWorld } from "../helpers/seed.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
});

const config = testConfig();
const ids = P1_PILOTS.map((p) => p.id);
const gather = (o: { ids?: number[]; since?: Date; until?: Date } = {}) =>
  gatherPhase1Gate(t.db, config, {
    installationIds: o.ids ?? ids,
    since: o.since ?? P1_SINCE,
    until: o.until ?? P1_UNTIL,
  });

const deps = (api = createFakeGitHubApi()): OpsDeps => ({
  loadConfig: () => testConfig(),
  openDb: () => testDb(),
  github: () => fakeGitHubFactory(api),
  now: () => FIXED_NOW,
  sleep: async () => {},
});
const ops = async (argv: string[], d: OpsDeps = deps()) => {
  let out = "";
  let err = "";
  const code = await opsMain(argv, { out: (s) => (out += s), err: (s) => (err += s) }, d);
  return { code, out, err };
};
const instArgs = ids.flatMap((id) => ["--installation", String(id)]);
const window = ["--since", "2026-09-01", "--until", "2026-10-15"];

describe("the Phase 1 gate (Phase 1 step 7)", () => {
  it("I-P1G-1 five seeded installations: every metric equals its hand-computed value; gate PASS, preview PASS", async () => {
    await seedPhase1World(t.db);
    const r = await gather();
    const { m1, m2, m3, m4 } = r.metrics;
    expect(m1.measured).toMatchObject({ n: 250, x: 100, share: 0.4, spanDays: 27 });
    expect(m1.measured.installations.map((i) => i.n)).toEqual([50, 50, 50, 50, 50]);
    expect(m1.projected).toMatchObject({ n: 300, x: 125 });
    expect(m1.classes.enforce).toMatchObject({ auto: 100, human: 150 });
    expect(m1.classes.report).toMatchObject({ auto: 25, would_fail: 25 });
    expect(m1.verdict).toBe("PASS");
    expect(m2.measured).toMatchObject({ repositories: 2, delta: -0.6 });
    expect(m2.measured.baseline).toMatchObject({ n: 40, p50: 100 });
    expect(m2.measured.phase1).toMatchObject({ n: 40, p50: 40 });
    expect(m2.projected.phase1).toMatchObject({ n: 50, p50: 40 });
    expect(m2.projectedZeros).toBe(10);
    expect(m2.pairedRepositories).toBe(2);
    expect(m2.verdict).toBe("PASS");
    expect(m3.measured).toMatchObject({
      caught: 9,
      wouldCatch: 0,
      missed: 1,
      denominator: 10,
      share: 0.9,
      repositories: 2,
    });
    expect(m3.projected).toMatchObject({ caught: 9, wouldCatch: 2, missed: 1, denominator: 12 });
    expect(m3.classes.report).toMatchObject({ flaky_unconfirmed: 1, open: 1, would_catch: 2 });
    expect(m3.caughtBy).toEqual({
      reverted: 7,
      revertClosed: 1,
      revertOpened: 1,
      autoMergeEnabled: 1,
    });
    expect(m3.missedBy).toEqual([{ status: "needs_human", outcome: null, reason: null, n: 1 }]);
    expect(m3.verdict).toBe("PASS");
    expect(m4.all).toMatchObject({ incidents: 2, merged: 300, verdict: "PASS" });
    expect(m4.auto).toMatchObject({ incidents: 0, merged: 100, verdict: "PASS" });
    expect(m4.autoPreview).toMatchObject({ incidents: 0, merged: 125 });
    expect(m4.baseline).toMatchObject({ incidents: 3, merged: 150 });
    expect(m4.unlinked).toBe(1);
    expect(m4.mergedBefore).toBe("2026-10-01");
    expect(r.retention).toEqual({ retained: 4, of: 5, target: 3 });
    expect(r.verdict).toBe("PASS");
    expect(r.preview.verdict).toBe("PASS");
    expect(r.repositories).toHaveLength(5);
    expect(r.repositories[0]).toMatchObject({
      fullName: "pilot1/api",
      merged: { total: 60, byMode: { enforce: 50, report: 10 } },
      wouldFailAtMerge: { total: 5, byReason: { approvals_missing: 5 } },
      guard: { caught: 5 },
    });
  });

  it("I-P1G-2 the same seed with every verdict in report mode: gate INSUFFICIENT DATA, preview PASS; --check exits 4", async () => {
    await seedPhase1World(t.db);
    await sql`update policy_verdicts set policy_mode = 'report', mode = 'report'`.execute(t.db);
    await sql`update guard_events set guard_mode = 'report' where guard_mode = 'enforce'`.execute(
      t.db,
    );
    const r = await gather();
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.metrics.m1.measured.n).toBe(0);
    expect(r.preview.verdict).toBe("PASS");
    const res = await ops(["gate", "report", "--phase", "1", ...instArgs, ...window, "--check"]);
    expect(res.code).toBe(4);
    expect(res.out).toContain("**Verdict: INSUFFICIENT DATA**");
    expect(res.out).toContain("**Preview (projected from report mode): PASS**");
  });

  it("I-P1G-3 the merge-head verdict: the newest for the head decides; a verdict for an older head is ignored", async () => {
    const p = P1_PILOTS[0] as (typeof P1_PILOTS)[number];
    await addInstallation(t.db, { id: p.id, login: p.login, repos: [{ id: p.repo, name: "api" }] });
    const at = new Date("2026-09-10T12:00:00Z");
    const changeId = await addMerged(t.db, {
      repo: p.repo,
      pr: 1,
      at,
      mode: "enforce",
      reason: "approved_by_policy",
    });
    const head = SHA(0x100000 + p.repo * 1000 + 1);
    await addP1Verdict(t.db, {
      changeId,
      headSha: head,
      mode: "enforce",
      reason: "approvals_missing",
      factsReadAt: new Date(at.getTime() - 1_000),
    });
    // A newer verdict for an older head: ignored.
    await addP1Verdict(t.db, {
      changeId,
      headSha: SHA(0xdead),
      mode: "enforce",
      reason: "approved_by_policy",
      factsReadAt: new Date(at.getTime() + 60_000),
    });
    const r = await gather({ ids: [p.id] });
    expect(r.metrics.m1.classes.enforce).toMatchObject({ would_fail: 1, auto: 0 });
    expect(r.metrics.m1.mergedWhileFailing).toBe(1);
  });

  it("I-P1G-4 exclusions: an excluded author, a Graft revert PR, a removed repository and a third installation are in no count", async () => {
    const [a, b, c] = P1_PILOTS as [
      (typeof P1_PILOTS)[number],
      (typeof P1_PILOTS)[number],
      (typeof P1_PILOTS)[number],
    ];
    for (const p of [a, b, c]) {
      await addInstallation(t.db, {
        id: p.id,
        login: p.login,
        repos: [{ id: p.repo, name: "api" }],
      });
    }
    await addInstallation(t.db, {
      id: 9010,
      login: "gone",
      repos: [{ id: 9110, name: "old" }],
    });
    const at = new Date("2026-09-10T12:00:00Z");
    const auto = { at, mode: "enforce" as const, reason: "approved_by_policy" as const };
    await addMerged(t.db, { repo: a.repo, pr: 1, ...auto });
    await addMerged(t.db, { repo: a.repo, pr: 2, ...auto, author: "dependabot[bot]" });
    await addMerged(t.db, { repo: a.repo, pr: 3, ...auto });
    await addGuardEvent(t.db, {
      repo: a.repo,
      status: "reverted",
      mode: "enforce",
      at,
      revertPr: 3,
      outcome: "opened",
    });
    await addMerged(t.db, { repo: 9110, pr: 1, ...auto });
    await t.db.updateTable("repositories").set({ removed_at: at }).where("id", "=", 9110).execute();
    await addMerged(t.db, { repo: c.repo, pr: 1, ...auto });
    const r = await gather({ ids: [a.id, b.id, 9010] });
    expect(r.metrics.m1.measured.n).toBe(1);
    expect(r.metrics.m1.projected.n).toBe(1);
    expect(r.repositories.map((x) => x.fullName)).toEqual([`${a.login}/api`, `${b.login}/api`]);
  });

  it("I-P1G-5 M2 pairing: a repository with only a phase1 run is left out; the newest run per period is used; projected zeros", async () => {
    const [a, b] = P1_PILOTS as [(typeof P1_PILOTS)[number], (typeof P1_PILOTS)[number]];
    for (const p of [a, b]) {
      await addInstallation(t.db, {
        id: p.id,
        login: p.login,
        repos: [{ id: p.repo, name: "api" }],
      });
    }
    const at = new Date("2026-09-10T12:00:00Z");
    await addMerged(t.db, {
      repo: a.repo,
      pr: 1,
      at,
      mode: "report",
      reason: "approved_by_policy",
    });
    await addMerged(t.db, { repo: a.repo, pr: 2, at, mode: "enforce", reason: "requirements_met" });
    const agent = (pr: number, first: number) => ({
      pr,
      kind: "agent" as const,
      first,
      merge: 500,
    });
    await addRun(t.db, {
      repo: a.repo,
      period: "baseline",
      extractedAt: new Date("2026-08-01T00:00:00Z"),
      rows: [agent(900, 9999)],
    });
    await addRun(t.db, {
      repo: a.repo,
      period: "baseline",
      extractedAt: new Date("2026-08-31T00:00:00Z"),
      rows: [agent(901, 100)],
    });
    await addRun(t.db, {
      repo: a.repo,
      period: "phase1",
      extractedAt: new Date("2026-10-01T00:00:00Z"),
      rows: [agent(1, 9999)],
    });
    await addRun(t.db, {
      repo: a.repo,
      period: "phase1",
      extractedAt: new Date("2026-10-14T00:00:00Z"),
      rows: [agent(1, 70), agent(2, 30)],
    });
    // Only a phase1 run: not paired.
    await addRun(t.db, {
      repo: b.repo,
      period: "phase1",
      extractedAt: new Date("2026-10-14T00:00:00Z"),
      rows: [agent(1, 5)],
    });
    const r = await gather({ ids: [a.id, b.id] });
    const m2 = r.metrics.m2;
    expect(m2.pairedRepositories).toBe(1);
    expect(m2.measured.baseline).toMatchObject({ n: 1, p50: 100 });
    expect(m2.measured.phase1).toMatchObject({ n: 1, p50: 30 });
    // Projected: PR 1 is report `auto`, so 0; PR 2 keeps 30.
    expect(m2.projected.phase1).toMatchObject({ n: 2, p50: 15 });
    expect(m2.projectedZeros).toBe(1);
    expect(r.runs.map((x) => [x.repository, x.period, x.extractedAt.slice(0, 10)])).toEqual([
      [`${a.login}/api`, "baseline", "2026-08-31"],
      [`${a.login}/api`, "phase1", "2026-10-14"],
      [`${b.login}/api`, "phase1", "2026-10-14"],
    ]);
  });

  it("I-P1G-6 M4: an incident on a PR merged 10 days before until is not counted (lag); a null-culprit incident is unlinked", async () => {
    const p = P1_PILOTS[0] as (typeof P1_PILOTS)[number];
    await addInstallation(t.db, { id: p.id, login: p.login, repos: [{ id: p.repo, name: "api" }] });
    const early = new Date("2026-09-10T12:00:00Z");
    const late = new Date(P1_UNTIL.getTime() - 10 * 86_400_000);
    await addMerged(t.db, {
      repo: p.repo,
      pr: 1,
      at: early,
      mode: "enforce",
      reason: "requirements_met",
    });
    await addMerged(t.db, {
      repo: p.repo,
      pr: 2,
      at: late,
      mode: "enforce",
      reason: "requirements_met",
    });
    await addIncidentRow(t.db, { repositoryId: p.repo, culprit: 1, at: late });
    await addIncidentRow(t.db, { repositoryId: p.repo, culprit: 2, at: late });
    await addIncidentRow(t.db, { repositoryId: p.repo, culprit: null, at: late });
    const r = await gather({ ids: [p.id] });
    expect(r.metrics.m4.all).toMatchObject({ incidents: 1, merged: 1 });
    expect(r.metrics.m4.unlinked).toBe(1);
    // A window shorter than the lag: M4 is INSUFFICIENT DATA (m4_defect_lag).
    const short = await gather({
      ids: [p.id],
      since: new Date(P1_UNTIL.getTime() - 10 * 86_400_000),
    });
    expect(short.metrics.m4.reasons.map((x) => x.code)).toEqual(["m4_defect_lag"]);
  });

  it("I-P1G-7 MCP: a claim and the PR's row count one PR opened; the open time is the change's, never the row's", async () => {
    const p = P1_PILOTS[0] as (typeof P1_PILOTS)[number];
    await addInstallation(t.db, { id: p.id, login: p.login, repos: [{ id: p.repo, name: "api" }] });
    const { id: tokenId } = await createTestToken(t.db, {
      repositoryId: p.repo,
      name: P1_SENTINELS.token,
    });
    const inWindow = new Date("2026-09-10T12:00:00Z");
    const before = new Date("2026-08-10T12:00:00Z");
    await addChange(t.db, { repositoryId: p.repo, prNumber: 7, openedAt: inWindow });
    await addChange(t.db, { repositoryId: p.repo, prNumber: 8, openedAt: before });
    const row = (pr: number | null, at: Date) =>
      t.db
        .insertInto("mcp_changes")
        .values({
          repository_id: p.repo,
          token_id: tokenId,
          pr_number: pr,
          head_sha: pr === null ? null : SHA(pr),
          created_at: at,
        })
        .execute();
    // The token was created in the window and expires after `until`: active at `until`.
    await t.db
      .updateTable("mcp_tokens")
      .set({ created_at: inWindow, expires_at: new Date(P1_UNTIL.getTime() + 86_400_000) })
      .execute();
    await row(7, inWindow);
    await row(null, inWindow);
    // Row created in the window, PR opened before it: not counted.
    await row(8, inWindow);
    const r = await gather({ ids: [p.id] });
    expect(r.mcp.prsOpened).toBe(1);
    expect(r.repositories[0]?.mcpPrsOpened).toBe(1);
    expect(r.mcp.activeTokens).toBe(1);
  });

  it("I-P1G-8 repositories[]: enforceSince after enforce → report → enforce is the last enforce; wouldFailAtMerge by reason; last7", async () => {
    const p = P1_PILOTS[0] as (typeof P1_PILOTS)[number];
    await addInstallation(t.db, { id: p.id, login: p.login, repos: [{ id: p.repo, name: "api" }] });
    const change = (to: string, from: string, at: string) =>
      t.db
        .insertInto("mode_changes")
        .values({
          repository_id: p.repo,
          key: "policy_mode",
          from_value: from,
          to_value: to,
          actor: P1_SENTINELS.actor,
          reason: "r",
          created_at: new Date(at),
          applied_at: new Date(at),
        })
        .execute();
    await change("enforce", "report", "2026-09-02T10:00:00Z");
    await change("report", "enforce", "2026-09-05T10:00:00Z");
    await change("enforce", "report", "2026-09-09T10:00:00Z");
    await t.db.updateTable("repositories").set({ policy_mode: "enforce" }).execute();
    const old = new Date("2026-09-10T12:00:00Z");
    const recent = new Date(P1_UNTIL.getTime() - 2 * 86_400_000);
    await addMerged(t.db, {
      repo: p.repo,
      pr: 1,
      at: old,
      mode: "report",
      reason: "approvals_missing",
    });
    await addMerged(t.db, { repo: p.repo, pr: 2, at: old, mode: "report", reason: "blocked" });
    await addMerged(t.db, { repo: p.repo, pr: 3, at: recent, mode: "report", reason: "no_policy" });
    await addMerged(t.db, {
      repo: p.repo,
      pr: 4,
      at: recent,
      mode: "enforce",
      reason: "approved_by_policy",
    });
    const r = await gather({ ids: [p.id] });
    const repo = r.repositories[0] as Phase1GateReport["repositories"][number];
    expect(repo.enforceSince).toEqual({ policy: "2026-09-09", guard: null });
    expect(repo.wouldFailAtMerge).toEqual({
      total: 3,
      byReason: { approvals_missing: 1, blocked: 1, no_policy: 1 },
    });
    expect(repo.invalidOrMissingPolicy).toBe(1);
    expect(repo.last7).toMatchObject({ total: 2, wouldFailAtMerge: 1, invalidOrMissingPolicy: 1 });
    expect(repo.last7.byClass).toMatchObject({ auto: 1, would_fail: 1 });
    // Step 7 review 1 (X30): enforce, then report (applied) → no enforceSince, although the newest
    // change to enforce is still in mode_changes.
    await change("report", "enforce", "2026-10-01T10:00:00Z");
    await t.db.updateTable("repositories").set({ policy_mode: "report" }).execute();
    const after = (await gather({ ids: [p.id] })).repositories[0];
    expect(after?.enforceSince).toEqual({ policy: null, guard: null });
  });

  it("I-P1G-11 step 7 review 1 rules: the M2 measured baseline takes only repositories with measured rows; M3's window is on the detection time; retention needs a delivery in the last 7 days", async () => {
    const [a, b, c, d] = P1_PILOTS as [
      (typeof P1_PILOTS)[number],
      (typeof P1_PILOTS)[number],
      (typeof P1_PILOTS)[number],
      (typeof P1_PILOTS)[number],
    ];
    const created = new Date(P1_UNTIL.getTime() - 60 * 86_400_000);
    for (const p of [a, b, c, d]) {
      await addInstallation(t.db, {
        id: p.id,
        login: p.login,
        repos: [{ id: p.repo, name: "api" }],
      });
      await t.db
        .updateTable("installations")
        .set({ created_at: created })
        .where("id", "=", p.id)
        .execute();
    }
    const at = new Date("2026-09-10T12:00:00Z");
    const agent = (pr: number, first: number) => ({
      pr,
      kind: "agent" as const,
      first,
      merge: 500,
    });

    // X40: a and b are both paired; only a has measured (enforce) phase1 rows.
    await addMerged(t.db, { repo: a.repo, pr: 1, at, mode: "enforce", reason: "requirements_met" });
    await addMerged(t.db, { repo: b.repo, pr: 1, at, mode: "report", reason: "requirements_met" });
    for (const [p, base] of [
      [a, 100],
      [b, 7],
    ] as const) {
      await addRun(t.db, {
        repo: p.repo,
        period: "baseline",
        extractedAt: new Date("2026-08-31T00:00:00Z"),
        rows: [agent(900, base)],
      });
      await addRun(t.db, {
        repo: p.repo,
        period: "phase1",
        extractedAt: new Date("2026-10-14T00:00:00Z"),
        rows: [agent(1, 30)],
      });
    }
    const m2 = (await gather({ ids: [a.id, b.id] })).metrics.m2;
    expect(m2.pairedRepositories).toBe(2);
    expect(m2.measured.baseline).toMatchObject({ n: 1, p50: 100 });
    expect(m2.projected.baseline).toMatchObject({ n: 2 });

    // X39: a caught event detected in the window but created before it → counted; a missed one
    // detected before the window but created in it → not counted.
    const event = async (detected: Date, createdAt: Date, caught: boolean) => {
      await addGuardEvent(t.db, {
        repo: c.repo,
        status: caught ? "reverted" : "needs_human",
        mode: "enforce",
        at: detected,
        ...(caught ? { revertPr: 8100, outcome: "opened" } : {}),
      });
      await sql`update guard_events set created_at = ${createdAt}
        where detected_at = ${detected}`.execute(t.db);
    };
    await event(new Date("2026-09-03T00:00:00Z"), new Date("2026-08-25T00:00:00Z"), true);
    await event(new Date("2026-08-25T00:00:00Z"), new Date("2026-09-03T00:00:00Z"), false);
    const m3 = (await gather({ ids: [c.id] })).metrics.m3;
    expect(m3.measured).toMatchObject({ caught: 1, missed: 0, denominator: 1 });

    // X41: retention needs a delivery in the 7 days before until: c's last one is 8 days old,
    // d's 6 days.
    await addDelivery(t.db, {
      id: "r-c",
      installationId: c.id,
      repositoryId: null,
      at: new Date(P1_UNTIL.getTime() - 8 * 86_400_000),
    });
    await addDelivery(t.db, {
      id: "r-d",
      installationId: d.id,
      repositoryId: null,
      at: new Date(P1_UNTIL.getTime() - 6 * 86_400_000),
    });
    expect((await gather({ ids: [c.id, d.id] })).retention).toMatchObject({ retained: 1, of: 2 });
  });

  it("I-P1G-9 neither file nor stdout holds a seeded login, title, body or path; --out writes mode 0600", async () => {
    await seedPhase1World(t.db);
    const p = P1_PILOTS[0] as (typeof P1_PILOTS)[number];
    await createTestToken(t.db, { repositoryId: p.repo, name: P1_SENTINELS.token });
    const ch = await t.db
      .selectFrom("changes")
      .select(["id", "head_sha", "pr_number"])
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto("audit_log")
      .values({
        repository_id: p.repo,
        change_id: ch.id,
        pr_number: ch.pr_number,
        head_sha: ch.head_sha,
        kind: "applied",
        actor_id: 5,
        actor_login: P1_SENTINELS.actor,
        actor_role: "admin",
        policy_mode: "enforce",
        created_at: new Date("2026-09-10T12:00:00Z"),
      })
      .execute();
    await t.db
      .insertInto("provenance")
      .values({
        change_id: ch.id,
        source: "mcp",
        commit_sha: ch.head_sha,
        agent: P1_SENTINELS.agent,
        created_at: new Date("2026-09-10T12:00:00Z"),
      })
      .execute();
    const dir = await mkdtemp(path.join(tmpdir(), "graft-p1g-"));
    const res = await ops(["gate", "report", "--phase", "1", ...instArgs, ...window, "--out", dir]);
    expect(res.code).toBe(0);
    const md = await readFile(path.join(dir, "gate-phase1-2026-10-15.md"), "utf8");
    const json = await readFile(path.join(dir, "gate-phase1-2026-10-15.json"), "utf8");
    for (const f of ["gate-phase1-2026-10-15.md", "gate-phase1-2026-10-15.json"]) {
      expect((await stat(path.join(dir, f))).mode & 0o777).toBe(0o600);
    }
    const stdout = (await ops(["gate", "report", "--phase", "1", ...instArgs, ...window])).out;
    for (const text of [md, json, stdout, res.out]) {
      for (const s of Object.values(P1_SENTINELS)) expect(text).not.toContain(s);
      expect(text).not.toContain("graft-e2e/");
    }
    expect(JSON.parse(json).overrides).toEqual([{ kind: "applied", policyMode: "enforce", n: 1 }]);
    expect(JSON.parse(json).mcp.provenanceReports).toBe(1);
  });

  it("I-P1G-10 --phase 1 with --allow-file, and --phase 2, are usage errors (exit 2)", async () => {
    await seedPhase1World(t.db);
    expect(
      (await ops(["gate", "report", "--phase", "1", ...instArgs, ...window, "--allow-file", "x"]))
        .code,
    ).toBe(2);
    expect((await ops(["gate", "report", "--phase", "2", ...instArgs, ...window])).code).toBe(2);
    expect(
      (await ops(["gate", "report", "--phase", "1", "--installation", "999", ...window])).code,
    ).toBe(2);
  });

  it("U-P1G-11 the Phase 0 report is unchanged: --phase absent and --phase 0 print the same bytes", async () => {
    await seedPhase1World(t.db);
    const absent = await ops(["gate", "report", ...instArgs, ...window]);
    const zero = await ops(["gate", "report", "--phase", "0", ...instArgs, ...window]);
    expect(absent.code).toBe(0);
    expect(zero.out).toBe(absent.out);
    expect(absent.out.startsWith("# Graft Phase 0 gate")).toBe(true);
    const json0 = await ops(["gate", "report", ...instArgs, ...window, "--json"]);
    expect(JSON.parse(json0.out).phase).toBeUndefined();
  });

  it("I-DB-16 migration 0016 up, down, up; baseline --period phase1 stores a phase1 run; down refuses while one exists", async () => {
    const check = async () =>
      (
        await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'review_time_runs_period_check'`.execute(t.db)
      ).rows[0]?.def;
    expect(await check()).toContain("phase1");
    expect(await migrateDownOne(t.db)).toEqual(["0016_phase1_gate"]);
    try {
      expect(await check()).not.toContain("phase1");
    } finally {
      expect(await migrateToLatest(t.db)).toEqual(["0016_phase1_gate"]);
    }
    // The baseline extractor stores a phase1 run.
    await seedWorld(t.db);
    const api = createFakeGitHubApi();
    api.state.pulls.set(1, makePull({ number: 1, created_at: "2026-08-11T10:00:00Z" }));
    api.state.commits.set(1, [makeCommit(SHA(1), commitMessage("c"))]);
    api.state.timelines.set(1, []);
    const res = await ops(
      [
        "baseline",
        "--repo",
        `${OWNER}/${REPO}`,
        "--from",
        "2026-08-10",
        "--to",
        "2026-08-25",
        "--period",
        "phase1",
      ],
      deps(api),
    );
    expect(res.code, res.err).toBe(0);
    expect(
      (await t.db.selectFrom("review_time_runs").select("period").execute()).map((x) => x.period),
    ).toEqual(["phase1"]);
    await expect(migrateDownOne(t.db)).rejects.toThrow(/phase1 review time runs exist/);
    expect(await check()).toContain("phase1");
    // Step 7 review 1 (X37): the refusal keeps the measured data.
    expect(await t.db.selectFrom("review_time_runs").select("period").execute()).toEqual([
      { period: "phase1" },
    ]);
  });
});
