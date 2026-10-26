import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../../src/db/client.js";
import { TABLE_NAMES } from "../../../src/db/schema.js";
import {
  addCard,
  addChange,
  addInstallation,
  addProvenance,
  addSpend,
  addVerdict,
  addVote,
  SHA,
} from "../../../test/helpers/pilot-seed.js";
import { loadConfig } from "../../server/src/config.js";
import { createReadOnlyDb, ReadOnlyError, verifyReadOnly } from "../../server/src/db.js";
import type {
  ChangeEntry,
  ChangeRecord,
  DayResponse,
  DaysResponse,
  OverviewResponse,
  RegisterResponse,
  SystemResponse,
} from "../../shared/api.js";
import { CONSOLE_TEST_DATABASE_URL } from "../db-url.js";
import { testApp } from "../helpers.js";

// 25 October 2026 is the day Paris leaves summer time: the local day runs 22:00Z to 23:00Z (25 hours).
const NOW = new Date("2026-10-25T15:00:00Z");
const at = (iso: string) => new Date(iso);
const TZ = "Europe/Paris";

const writer = createDb(CONSOLE_TEST_DATABASE_URL, { max: 2 });
const reader = createReadOnlyDb(CONSOLE_TEST_DATABASE_URL, { statementTimeoutMs: 5000 });
const config = loadConfig({
  CONSOLE_DATABASE_URL: CONSOLE_TEST_DATABASE_URL,
  CONSOLE_AUTH: "none",
});
let app: Awaited<ReturnType<typeof testApp>>;
let A = "";
let B = "";
let C = "";

beforeAll(async () => {
  await sql
    .raw(`TRUNCATE ${TABLE_NAMES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`)
    .execute(writer);
  await addInstallation(writer, {
    id: 1,
    login: "acme",
    repos: [
      { id: 11, name: "api" },
      { id: 12, name: "web" },
    ],
  });
  await sql`update installations set created_at = ${at("2026-10-20T08:00:00Z")}, permissions_read_at = now()`.execute(
    writer,
  );

  A = await addChange(writer, {
    repositoryId: 11,
    prNumber: 101,
    state: "merged",
    openedAt: at("2026-10-25T08:00:00Z"),
    mergedAt: at("2026-10-25T10:00:00Z"),
    author: "dev",
  });
  await sql`update changes set author_id = 400 where id = ${A}`.execute(writer);
  await addProvenance(writer, { changeId: A, headSha: SHA(101), kind: "agent" });
  await addCard(writer, {
    changeId: A,
    headSha: SHA(101),
    risk: "logic",
    verifier: "disagree",
    createdAt: at("2026-10-25T08:05:00Z"),
  });
  const a2 = await addCard(writer, {
    changeId: A,
    headSha: SHA(101),
    risk: "sensitive",
    verifier: "agree",
    createdAt: at("2026-10-25T09:00:00Z"),
  });
  await sql`update intent_cards set goal = 'Add a login rate limiter.' where id = ${a2}`.execute(
    writer,
  );
  await addVerdict(writer, {
    changeId: A,
    headSha: SHA(101),
    outcome: "would_require",
    factsReadAt: at("2026-10-25T09:10:00Z"),
  });
  await addVote(writer, {
    changeId: A,
    cardId: a2,
    userId: 400,
    login: "dev",
    verdict: "up",
    at: NOW,
    author: true,
  });
  await addVote(writer, {
    changeId: A,
    cardId: a2,
    userId: 500,
    login: "rev",
    verdict: "up",
    at: NOW,
  });
  await addVote(writer, {
    changeId: A,
    cardId: a2,
    userId: 501,
    login: "rev2",
    verdict: "down",
    at: NOW,
  });

  B = await addChange(writer, {
    repositoryId: 12,
    prNumber: 7,
    openedAt: at("2026-10-25T09:30:00Z"),
  });
  await addCard(writer, {
    changeId: B,
    headSha: SHA(7),
    status: "unavailable",
    failure: "budget_exceeded",
    createdAt: at("2026-10-25T09:31:00Z"),
  });
  await addVerdict(writer, {
    changeId: B,
    headSha: SHA(7),
    outcome: "policy_invalid",
    factsReadAt: at("2026-10-25T09:32:00Z"),
  });

  // Merged at 00:30 in Paris on the 25th, which is still the 24th in UTC.
  C = await addChange(writer, {
    repositoryId: 11,
    prNumber: 99,
    state: "merged",
    openedAt: at("2026-10-24T10:00:00Z"),
    mergedAt: at("2026-10-24T22:30:00Z"),
  });

  await sql`
    insert into guard_events (repository_id, branch, failing_sha, status, culprit_change_id, created_at,
      updated_at, failing_checks, candidates, revert_outcome, revert_reason, guard_mode, ci_run_url)
    values (11, 'main', ${SHA(0xdead)}, 'needs_human', ${A}, ${at("2026-10-25T11:00:00Z")},
      ${at("2026-10-25T11:00:00Z")}, '[{"key":"run:1:Tests","name":"Tests","source":"check_run"}]'::jsonb,
      '[]'::jsonb, 'needs_human', 'touched_later', 'report', 'https://github.com/acme/api/actions/runs/1')`.execute(
    writer,
  );
  await sql`
    insert into audit_log (repository_id, change_id, pr_number, head_sha, kind, actor_id, actor_login,
      actor_role, policy_mode, created_at)
    values (11, ${A}, 101, ${SHA(101)}, 'applied', 700, 'lead', 'admin', 'report', ${at("2026-10-25T13:00:00Z")})`.execute(
    writer,
  );
  await sql`
    insert into mode_changes (repository_id, key, from_value, to_value, actor, reason, created_at)
    values (11, 'policy_mode', 'report', 'enforce', 'ops', 'pilot', ${at("2026-10-25T12:00:00Z")})`.execute(
    writer,
  );

  await addSpend(writer, {
    repositoryId: 11,
    changeId: A,
    tokens: 1_500_000,
    cost: 3.2,
    at: at("2026-10-25T09:00:00Z"),
  });
  await addSpend(writer, {
    repositoryId: 12,
    changeId: B,
    tokens: 10_000,
    cost: 0.02,
    at: at("2026-10-25T09:31:00Z"),
  });
  for (const [id, status, event] of [
    ["d1", "enqueued", "pull_request"],
    ["d2", "enqueued", "pull_request"],
    ["d3", "ignored", "check_run"],
  ] as const) {
    await sql`insert into webhook_deliveries (delivery_id, event, status, received_at)
      values (${id}, ${event}, ${status}, ${at("2026-10-25T09:00:00Z")})`.execute(writer);
  }
  await sql`insert into service_state (key, value, updated_at) values ('mode_ceiling', 'report', now())`.execute(
    writer,
  );

  app = await testApp({ config, db: reader, now: () => NOW.getTime() });
});

afterAll(async () => {
  await app?.close();
  await reader.destroy();
  await writer.destroy();
});

const get = async <T>(url: string) => {
  const r = await app.inject(url);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as T;
};

describe("days", () => {
  it("counts each local day in the requested time zone", async () => {
    const paris = await get<DaysResponse>(`/api/days?tz=${TZ}&days=3`);
    expect(paris.today).toBe("2026-10-25");
    expect(paris.installedAt).toBe("2026-10-20T08:00:00.000Z");
    expect(paris.days.map((d) => d.date)).toEqual(["2026-10-25", "2026-10-24", "2026-10-23"]);
    expect(paris.days[0]).toMatchObject({
      prsOpened: 2,
      prsMerged: 2,
      cards: 3,
      cardsUnavailable: 1,
      cardsBudget: 1,
      verifierAgree: 1,
      verifierDisagree: 1,
      deliveries: 3,
      deliveriesIgnored: 1,
      tokens: 1_510_000,
      costUsd: 3.22,
      guardEvents: 1,
      guardNeedsHuman: 1,
      repositories: 2,
    });
    const utc = await get<DaysResponse>("/api/days?tz=UTC&days=2");
    expect(utc.days[0]?.prsMerged).toBe(1);
    expect(utc.days[1]?.prsMerged).toBe(1);
  });

  it("rejects a bad time zone and a future day", async () => {
    expect((await app.inject("/api/days?tz=Mars/Base")).statusCode).toBe(400);
    expect((await app.inject("/api/days/2026-10-26?tz=Europe/Paris")).statusCode).toBe(404);
    expect((await app.inject("/api/days/2026-13-01")).statusCode).toBe(400);
  });

  it("lists one day's entries newest first", async () => {
    const d = await get<DayResponse>(`/api/days/2026-10-25?tz=${TZ}`);
    expect(d.entries.map((e) => `${e.kind}@${e.at.slice(11, 16)}`)).toEqual([
      "break_glass@13:00",
      "mode@12:00",
      "guard@11:00",
      "change@09:31",
      "change@08:05",
      "change@22:30",
    ]);
    const a = d.entries.find((e): e is ChangeEntry => e.kind === "change" && e.prNumber === 101);
    expect(a).toMatchObject({
      repo: "acme/api",
      goal: "Add a login rate limiter.",
      policyOutcome: "would_require",
      guardStatus: "needs_human",
      authorKind: "agent",
      card: { riskClass: "sensitive", riskFloor: "trivial", verifierStatus: "agree" },
    });
    expect(a?.versions.map((v) => v.riskClass)).toEqual(["logic", "sensitive"]);
    const b = d.entries.find((e): e is ChangeEntry => e.kind === "change" && e.prNumber === 7);
    expect(b?.card).toMatchObject({ status: "unavailable", failureReason: "budget_exceeded" });
    const c = d.entries.find((e): e is ChangeEntry => e.kind === "change" && e.prNumber === 99);
    expect(c).toMatchObject({ card: null, versions: [], state: "merged" });
    const g = d.entries.find((e) => e.kind === "guard");
    expect(g).toMatchObject({ status: "needs_human", culpritPr: 101, failingChecks: ["Tests"] });
  });
});

describe("overview", () => {
  it("pins what needs a human, act before watch", async () => {
    const o = await get<OverviewResponse>("/api/overview");
    const kinds = o.attention.map((a) => `${a.severity}:${a.kind}`);
    expect(kinds).toEqual(
      expect.arrayContaining(["act:guard", "act:policy", "act:budget", "act:mode"]),
    );
    expect(kinds.indexOf("act:mode")).toBeLessThan(kinds.length);
    const guard = o.attention.find((a) => a.kind === "guard");
    expect(guard?.title).toBe("The guard stopped on main and wants a human");
    expect(guard?.detail).toContain("Tests went red");
    expect(guard?.detail).toContain("after #101");
    expect(o.attention.find((a) => a.kind === "policy")?.repo).toBe("acme/web");
    expect(o.ceiling?.value).toBe("report");
    expect(o.repositories.map((r) => r.fullName)).toEqual(["acme/api", "acme/web"]);
  });

  it("splits votes the way the gate does and reads the budget", async () => {
    const o = await get<OverviewResponse>("/api/overview");
    expect(o.gate).toMatchObject({
      votes: 3,
      authorVotes: 1,
      eligibleUp: 1,
      eligibleDown: 1,
      target: 0.9,
    });
    expect(o.gate.interval?.low).toBeGreaterThan(0);
    expect(o.totals).toMatchObject({
      cards: 3,
      cardsUnavailable: 1,
      cardsBudget: 1,
      verifierAgree: 1,
      verifierJudged: 2,
    });
    expect(o.budget[0]).toMatchObject({
      repo: "acme/api",
      todayTokens: 1_500_000,
      budget: 2_000_000,
    });
    expect(o.budget[0]?.days).toHaveLength(7);
    expect(o.budget.find((b) => b.repo === "acme/web")?.days.at(-1)).toMatchObject({ skipped: 1 });
  });
});

describe("changes", () => {
  it("lists PRs newest first, filters and pages", async () => {
    const all = await get<RegisterResponse>("/api/changes");
    expect(all.rows.map((r) => r.prNumber)).toEqual([7, 101, 99]);
    expect(all.nextCursor).toBeNull();
    expect(all.rows[1]).toMatchObject({
      cards: 2,
      riskClass: "sensitive",
      guardStatus: "needs_human",
    });

    const sensitive = await get<RegisterResponse>("/api/changes?risk=sensitive");
    expect(sensitive.rows.map((r) => r.prNumber)).toEqual([101]);
    const web = await get<RegisterResponse>("/api/changes?repo=ACME/web");
    expect(web.rows.map((r) => r.prNumber)).toEqual([7]);

    const p1 = await get<RegisterResponse>("/api/changes?limit=2");
    expect(p1.rows.map((r) => r.prNumber)).toEqual([7, 101]);
    const p2 = await get<RegisterResponse>(`/api/changes?limit=2&cursor=${p1.nextCursor}`);
    expect(p2.rows.map((r) => r.prNumber)).toEqual([99]);
    expect(p2.nextCursor).toBeNull();
    expect((await app.inject("/api/changes?state=deleted")).statusCode).toBe(400);
  });

  it("returns a PR's whole record", async () => {
    const r = await get<ChangeRecord>(`/api/changes/${A}`);
    expect(r).toMatchObject({
      repo: "acme/api",
      prNumber: 101,
      provenance: { authorKind: "agent", reason: "trailer" },
      verdict: { outcome: "would_require", evaluations: 1 },
      feedback: { up: 2, down: 1, byAuthor: 1 },
    });
    expect(r.cards.map((c) => c.riskClass)).toEqual(["sensitive", "logic"]);
    expect(r.guardEvents).toHaveLength(1);
    expect(r.breakGlass).toEqual([expect.objectContaining({ kind: "applied", actor: "lead" })]);
    expect((await app.inject(`/api/changes/${randomUUID()}`)).statusCode).toBe(404);
    expect((await app.inject("/api/changes/1;drop")).statusCode).toBe(400);
    void B;
    void C;
  });
});

describe("system", () => {
  it("reads what it can and says what it cannot", async () => {
    const s = await get<SystemResponse>("/api/system?hours=24");
    expect(s.jobs).toBeNull();
    expect(s.jobsUnavailable).toContain("pgboss");
    expect(s.schemaVersion).toMatch(/^\d{4}_/);
    expect(s.webhooks).toEqual(
      expect.arrayContaining([{ event: "pull_request", status: "enqueued", count: 2 }]),
    );
    expect(s.modeChanges).toEqual([
      expect.objectContaining({ key: "policy_mode", appliedAt: null }),
    ]);
    expect(s.audit).toHaveLength(1);
    expect(s.mcpTokens).toEqual([]);
  });

  it("answers health checks without a session and 404s unknown API routes", async () => {
    expect((await app.inject("/healthz")).json()).toEqual({ status: "ok", version: "test" });
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    expect((await app.inject("/api/nope")).statusCode).toBe(404);
  });
});

describe("read-only", () => {
  it("cannot write through the console's connection", async () => {
    await expect(
      sql`insert into service_state (key, value, updated_at) values ('x', 'y', now())`.execute(
        reader,
      ),
    ).rejects.toThrow(/read-only transaction/);
  });

  it("refuses to start as a role that can write, unless told it is local", async () => {
    await expect(verifyReadOnly(reader, true)).rejects.toThrow(ReadOnlyError);
    const r = await verifyReadOnly(reader, false);
    expect(r).toMatchObject({ transactionReadOnly: true, roleReadOnly: false, canRead: true });
  });

  it("accepts a SELECT-only role and that role cannot write even in a read-write transaction", async () => {
    const role = `graft_console_t${process.pid}`;
    await sql.raw(`DROP ROLE IF EXISTS ${role}`).execute(writer);
    // The grants of console/sql/readonly-role.sql.
    await sql
      .raw(`CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOBYPASSRLS`)
      .execute(writer);
    await sql.raw(`ALTER ROLE ${role} SET default_transaction_read_only = on`).execute(writer);
    await sql.raw(`GRANT USAGE ON SCHEMA public TO ${role}`).execute(writer);
    await sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`).execute(writer);
    const url = new URL(CONSOLE_TEST_DATABASE_URL);
    url.username = role;
    url.password = "pw";
    const ro = createReadOnlyDb(url.toString(), { statementTimeoutMs: 5000 });
    try {
      const r = await verifyReadOnly(ro, true);
      expect(r).toMatchObject({ role, roleReadOnly: true, canRead: true, pgboss: false });
      await expect(
        ro.transaction().execute(async (tx) => {
          await sql`set transaction read write`.execute(tx);
          await sql`insert into service_state (key, value, updated_at) values ('x', 'y', now())`.execute(
            tx,
          );
        }),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await ro.destroy();
      await sql.raw(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`).execute(writer);
      await sql.raw(`REVOKE ALL ON SCHEMA public FROM ${role}`).execute(writer);
      await sql.raw(`DROP ROLE ${role}`).execute(writer);
    }
  });
});
