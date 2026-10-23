import { readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyCronSchedules } from "../../src/app/crons.js";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import { loadConfig } from "../../src/config/index.js";
import { migrateDownOne, migrateToLatest } from "../../src/db/migrator.js";
import { TABLE_NAMES } from "../../src/db/schema.js";
import { feedbackSweepJob } from "../../src/modules/intent/index.js";
import { scheduleIncidentDetection } from "../../src/modules/pilot/incidents.js";
import { detectIncident, metricsRollupJob, syncReviewers } from "../../src/modules/pilot/index.js";
import { onChangeSignal, scheduleReviewerSync } from "../../src/modules/pilot/reviewers.js";
import { OWNED_ROWS, purgeInstallation } from "../../src/pilot/purge.js";
import { createPgBossQueue } from "../../src/queue/queue.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture } from "../helpers/fixtures.js";
import {
  commitMessage,
  makeCommit,
  makePull,
  makeReview,
  OWNER,
  PR_NUMBER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";
import {
  addCard,
  addChange,
  addDelivery,
  addDisplay,
  addIncidentRow,
  addInstallation,
  addProvenance,
  addReviewer,
  addSpend,
  addVerdict,
  addVote,
  PILOT_A,
  PILOT_B,
  SHA,
} from "../helpers/pilot-seed.js";

let t: TestApp;
let api: FakeGitHubApi;
let nowMs: number;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  await sql`delete from pgboss.schedule where name in ('intent.feedback.sweep', 'pilot.metrics.rollup')`.execute(
    t.db,
  );
  api = createFakeGitHubApi({ now: () => nowMs });
  nowMs = FIXED_NOW.getTime();
  t.deps.github = fakeGitHubFactory(api);
});

const deps = (): OpsDeps => ({
  loadConfig: () => testConfig(),
  openDb: () => testDb(),
  github: () => fakeGitHubFactory(api),
  now: () => new Date(nowMs),
  sleep: async (ms) => {
    nowMs += ms;
  },
});
const run = async (...argv: string[]) => {
  let out = "";
  let err = "";
  const code = await opsMain(argv, { out: (s) => (out += s), err: (s) => (err += s) }, deps());
  return { code, out, err };
};
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(FIXED_NOW.getTime() - ms);

// ---------------------------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------------------------

describe("pilot doctor", () => {
  async function healthy() {
    await addInstallation(t.db, {
      id: PILOT_A.id,
      login: PILOT_A.login,
      repos: [{ id: PILOT_A.repo, name: "api" }],
    });
    // Permissions were read an hour ago (Phase 1 step 1), so the permissions check is OK; with
    // statuses:read the guard check is OK too (Phase 1 step 4).
    await t.db
      .updateTable("installations")
      .set({
        permissions: JSON.stringify({ checks: "write", statuses: "read" }),
        permissions_read_at: ago(HOUR),
      })
      .where("id", "=", PILOT_A.id)
      .execute();
    const head = SHA(1);
    const change = await addChange(t.db, {
      repositoryId: PILOT_A.repo,
      prNumber: 1,
      openedAt: ago(DAY),
      headSha: head,
    });
    await addProvenance(t.db, { changeId: change, headSha: head, kind: "human" });
    const card = await addCard(t.db, { changeId: change, headSha: head, createdAt: ago(DAY) });
    await addDisplay(t.db, { changeId: change, cardId: card, status: "ok", shownAt: ago(DAY) });
    await addVote(t.db, {
      changeId: change,
      cardId: card,
      userId: 5,
      login: "rev",
      verdict: "up",
      at: ago(HOUR),
    });
    await addReviewer(t.db, { changeId: change, userId: 5 });
    await addVerdict(t.db, {
      changeId: change,
      headSha: head,
      outcome: "would_require",
      factsReadAt: ago(HOUR),
    });
    await addDelivery(t.db, {
      id: "dl-1",
      installationId: PILOT_A.id,
      repositoryId: PILOT_A.repo,
      at: ago(HOUR),
    });
    await sql`insert into metrics_daily (repository_id, day, rollup_version, counts, computed_at)
      values (${PILOT_A.repo}, '2026-10-13', 1, '{}'::jsonb, now())`.execute(t.db);
    return change;
  }

  async function withCrons<T>(fn: () => Promise<T>): Promise<T> {
    const queue = createPgBossQueue({
      connectionString: t.deps.config.databaseUrl,
      schema: t.deps.config.pgbossSchema,
      registry: { jobs: [feedbackSweepJob, metricsRollupJob] },
      log: t.deps.log,
      supervise: true,
    });
    await queue.start();
    try {
      // The modes and guard crons are covered elsewhere; this queue registers only two jobs.
      await applyCronSchedules(
        queue,
        testConfig({
          GRAFT_MODE_APPLY_CRON: "off",
          GRAFT_PERMISSIONS_REFRESH_CRON: "off",
          GRAFT_GUARD_PRUNE_CRON: "off",
        }),
      );
      return await fn();
    } finally {
      await queue.stop();
      await sql`delete from pgboss.schedule where name in ('intent.feedback.sweep', 'pilot.metrics.rollup')`.execute(
        t.db,
      );
    }
  }

  it("I-DOC-1 a healthy installation: every check OK, exit 0", async () => {
    await healthy();
    const res = await withCrons(() => run("pilot", "doctor", "--installation", String(PILOT_A.id)));
    expect(res.code, res.out).toBe(0);
    const lines = res.out.trimEnd().split("\n");
    expect(lines.map((l) => l.split(":")[0]?.trim().split(/\s+/))).toEqual([
      ["OK", "installation"],
      ["OK", "repositories"],
      ["OK", "deliveries"],
      ["OK", "jobs_failed"],
      ["OK", "cards"],
      ["OK", "feedback"],
      ["OK", "policy"],
      ["OK", "budget"],
      ["OK", "rollup"],
      ["OK", "crons"],
      ["OK", "permissions"],
      ["OK", "modes"],
      ["OK", "teams"],
      ["OK", "break_glass"],
      ["OK", "guard_statuses"],
      ["OK", "guard_confirming"],
      ["OK", "guard_reverts_open"],
      ["OK", "guard_revert_claims"],
      ["OK", "guard_revert_errors"],
      ["OK", "mcp_tokens_expiring"],
      ["OK", "mcp_tokens_unused"],
    ]);
    expect(res.out).toContain("graft-sandbox/api");
    const json = JSON.parse(
      (
        await withCrons(() =>
          run("pilot", "doctor", "--installation", String(PILOT_A.id), "--json"),
        )
      ).out,
    );
    expect(json.checks).toHaveLength(21);
    expect(json.checks.every((c: { status: string }) => c.status === "OK")).toBe(true);
  });

  it("I-BG-14 doctor: a break-glass applied in the last 7 days is a WARN per repository, and the exit code stays 0", async () => {
    const change = await healthy();
    const audit = (kind: string, at: Date) =>
      sql`insert into audit_log (repository_id, change_id, pr_number, head_sha, kind, reason,
        actor_id, actor_login, actor_role, policy_mode, created_at)
        values (${PILOT_A.repo}, ${change}, 1, ${SHA(1)}, ${kind},
          ${kind === "ignored" ? "role_too_low" : null}, 7, 'maya', 'maintain', 'enforce', ${at})`.execute(
        t.db,
      );
    // Older than 7 days, and an ignored label: neither is a bypass to report.
    await audit("applied", ago(8 * DAY));
    await audit("ignored", ago(HOUR));
    let res = await withCrons(() =>
      run("pilot", "doctor", "--installation", String(PILOT_A.id), "--json"),
    );
    let checks = JSON.parse(res.out).checks as { id: string; status: string; detail: string }[];
    expect(checks.find((c) => c.id === "break_glass")).toMatchObject({ status: "OK" });

    await audit("applied", ago(DAY));
    await audit("removed", ago(HOUR));
    res = await withCrons(() => run("pilot", "doctor", "--installation", String(PILOT_A.id)));
    expect(res.code, res.out).toBe(0);
    expect(res.out).toMatch(
      /^WARN\s+break_glass: break-glass applied in the last 7 days: 1 \(graft-sandbox\/api 1\)$/m,
    );
    res = await withCrons(() =>
      run("pilot", "doctor", "--installation", String(PILOT_A.id), "--json"),
    );
    checks = JSON.parse(res.out).checks;
    expect(checks.filter((c) => c.status !== "OK").map((c) => c.id)).toEqual(["break_glass"]);
  });

  it("I-DOC-2 failed jobs, no delivery in 8 days and an over-budget repository are FAILs; --json has the shape", async () => {
    await healthy();
    await t.db.deleteFrom("webhook_deliveries").execute();
    await addDelivery(t.db, {
      id: "old",
      installationId: PILOT_A.id,
      repositoryId: PILOT_A.repo,
      at: ago(8 * DAY),
    });
    for (let i = 0; i < 11; i++) {
      await sql`insert into pgboss.job (name, data, state, completed_on)
        values ('intent.generate', ${JSON.stringify({ installationId: PILOT_A.id, n: i })}::jsonb, 'failed', ${ago(HOUR)})`.execute(
        t.db,
      );
    }
    // A failed job of another installation and an old failure are not counted.
    await sql`insert into pgboss.job (name, data, state, completed_on)
      values ('intent.generate', ${JSON.stringify({ installationId: 424242 })}::jsonb, 'failed', ${ago(HOUR)})`.execute(
      t.db,
    );
    await sql`insert into pgboss.job (name, data, state, completed_on)
      values ('intent.generate', ${JSON.stringify({ installationId: PILOT_A.id })}::jsonb, 'failed', ${ago(3 * DAY)})`.execute(
      t.db,
    );
    await addSpend(t.db, { repositoryId: PILOT_A.repo, tokens: 2_000_000, cost: 1, at: ago(HOUR) });
    const res = await run("pilot", "doctor", "--installation", String(PILOT_A.id), "--json");
    expect(res.code).toBe(1);
    const checks = JSON.parse(res.out).checks as { id: string; status: string; detail: string }[];
    const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      installation: "OK",
      deliveries: "FAIL",
      jobs_failed: "FAIL",
      budget: "FAIL",
    });
    expect(checks.find((c) => c.id === "jobs_failed")?.detail).toContain(
      "11 failed jobs in 24 h: intent.generate 11",
    );
    expect(checks.find((c) => c.id === "budget")?.detail).toContain("graft-sandbox/api");
    for (const c of checks) expect(Object.keys(c).sort()).toEqual(["detail", "id", "status"]);
    // The text form lists FAIL lines too.
    expect((await run("pilot", "doctor", "--installation", String(PILOT_A.id))).out).toMatch(
      /^FAIL\s+deliveries:/m,
    );
  });

  it("I-DOC-3 a deleted installation: installation FAIL and every other check still answers", async () => {
    await healthy();
    await t.db
      .updateTable("installations")
      .set({ deleted_at: ago(DAY) })
      .execute();
    const res = await run("pilot", "doctor", "--installation", String(PILOT_A.id), "--json");
    expect(res.code).toBe(1);
    expect(res.err).toBe("");
    const checks = JSON.parse(res.out).checks as { id: string; status: string }[];
    expect(checks).toHaveLength(21);
    expect(checks.find((c) => c.id === "installation")?.status).toBe("FAIL");
    // An installation that does not exist at all answers the same way.
    const missing = await run("pilot", "doctor", "--installation", "999999", "--json");
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out).checks).toHaveLength(21);
    expect(missing.err).toBe("");
  });

  it("I-DOC-4 an unverified-only change counts as not synced; 403 permission denials warn, 404s are counted", async () => {
    await healthy();
    const feedback = async () =>
      (
        JSON.parse(
          (await run("pilot", "doctor", "--installation", String(PILOT_A.id), "--json")).out,
        ).checks as { id: string; status: string; detail: string }[]
      ).find((c) => c.id === "feedback");
    expect((await feedback())?.status).toBe("OK");

    // Legacy rows: stored, but not verified.
    await t.db.updateTable("pr_reviewers").set({ verified: false }).execute();
    const legacy = await feedback();
    expect(legacy?.status).toBe("WARN");
    expect(legacy?.detail).toContain("no verified reviewer row");
    await t.db.updateTable("pr_reviewers").set({ verified: true }).execute();

    const change = await t.db.selectFrom("changes").select("id").executeTakeFirstOrThrow();
    await t.db
      .insertInto("reviewer_check_denials")
      .values({ change_id: change.id, user_id: 11, status: 404, checked_at: ago(HOUR) })
      .execute();
    const notFound = await feedback();
    expect(notFound?.status).toBe("OK");
    expect(notFound?.detail).toContain("1 reviewer permission checks answered 404");

    await t.db
      .insertInto("reviewer_check_denials")
      .values({ change_id: change.id, user_id: 12, status: 403, checked_at: ago(HOUR) })
      .execute();
    const forbidden = await feedback();
    expect(forbidden?.status).toBe("WARN");
    expect(forbidden?.detail).toContain("1 reviewer permission checks were forbidden (403)");
    // An old denial does not count.
    await t.db
      .updateTable("reviewer_check_denials")
      .set({ checked_at: ago(10 * DAY) })
      .execute();
    expect((await feedback())?.status).toBe("OK");
  });

  it("warns for repository_selection = all and for votes without a reviewer sync", async () => {
    const change = await healthy();
    await t.db.updateTable("installations").set({ repository_selection: "all" }).execute();
    await t.db.deleteFrom("pr_reviewers").execute();
    const checks = JSON.parse(
      (await run("pilot", "doctor", "--installation", String(PILOT_A.id), "--json")).out,
    ).checks as { id: string; status: string }[];
    expect(checks.find((c) => c.id === "installation")?.status).toBe("WARN");
    expect(checks.find((c) => c.id === "feedback")?.status).toBe("WARN");
    expect(checks.find((c) => c.id === "crons")?.status).toBe("WARN"); // no schedule rows in this test
    void change;
  });
});

// ---------------------------------------------------------------------------------------------
// purge
// ---------------------------------------------------------------------------------------------

/** One installation with a row in every table, and pg-boss jobs naming it. */
async function seedEverything(o: { id: number; repo: number; login: string; seq: number }) {
  await addInstallation(t.db, {
    id: o.id,
    login: o.login,
    repos: [{ id: o.repo, name: "svc" }],
    deleted: true,
  });
  const head = SHA(o.seq * 10 + 1);
  const change = await addChange(t.db, {
    repositoryId: o.repo,
    prNumber: 1,
    state: "merged",
    openedAt: ago(2 * DAY),
    mergedAt: ago(DAY),
    headSha: head,
  });
  await sql`insert into tasks (repository_id, external_id) values (${o.repo}, ${`T-${o.seq}`})`.execute(
    t.db,
  );
  await sql`insert into provenance (change_id, source) values (${change}, 'trailer')`.execute(t.db);
  await addProvenance(t.db, { changeId: change, headSha: head, kind: "agent" });
  const card = await addCard(t.db, { changeId: change, headSha: head, createdAt: ago(2 * DAY) });
  await addDisplay(t.db, { changeId: change, cardId: card, status: "ok", shownAt: ago(2 * DAY) });
  await addVote(t.db, {
    changeId: change,
    cardId: card,
    userId: 70 + o.seq,
    login: "rev",
    verdict: "up",
    at: ago(DAY),
  });
  await addSpend(t.db, {
    repositoryId: o.repo,
    changeId: change,
    tokens: 100,
    cost: 0.1,
    at: ago(2 * DAY),
  });
  await addVerdict(t.db, {
    changeId: change,
    headSha: head,
    outcome: "would_approve",
    factsReadAt: ago(DAY),
  });
  await sql`insert into guard_events (repository_id, branch, failing_sha, status) values (${o.repo}, 'main', ${head}, 'detected')`.execute(
    t.db,
  );
  // Phase 1 step 4: the guard's history and CI results.
  await sql`insert into main_commits (repository_id, sha, parent_sha, seq, pr_source, tracked_at)
    values (${o.repo}, ${head}, null, 1, 'direct', now())`.execute(t.db);
  await sql`insert into ci_results (repository_id, sha, key, name, source, class, observed_at)
    values (${o.repo}, ${head}, 'run:1:test', 'test', 'check_run', 'red', now())`.execute(t.db);
  // Phase 1 step 6: an MCP token (its hash) and a PR it opened.
  const token = await sql<{ id: string }>`insert into mcp_tokens
      (repository_id, name, token_hash, token_prefix, created_by, expires_at)
    values (${o.repo}, 'ci', ${String(o.seq).repeat(64).slice(0, 64)}, 'abcdEFGH', 'tester', now() + interval '30 days')
    returning id`.execute(t.db);
  await sql`insert into mcp_changes (repository_id, token_id, pr_number, head_sha)
    values (${o.repo}, ${token.rows[0]?.id}, 7, ${head})`.execute(t.db);
  await addDelivery(t.db, {
    id: `dl-inst-${o.seq}`,
    installationId: o.id,
    repositoryId: null,
    at: ago(DAY),
  });
  await addDelivery(t.db, {
    id: `dl-repo-${o.seq}`,
    installationId: null,
    repositoryId: o.repo,
    at: ago(DAY),
  });
  await sql`insert into mode_changes (repository_id, key, from_value, to_value, actor, reason)
    values (${o.repo}, 'policy_mode', 'report', 'enforce', 'op', 'seed')`.execute(t.db);
  // Phase 1 step 3: a break-glass row (it holds a login).
  await sql`insert into audit_log (repository_id, change_id, pr_number, head_sha, kind, actor_id,
    actor_login, actor_role, policy_mode, created_at)
    values (${o.repo}, ${change}, 1, ${head}, 'applied', ${80 + o.seq}, 'maint', 'maintain', 'enforce', now())`.execute(
    t.db,
  );
  await addReviewer(t.db, { changeId: change, userId: 70 + o.seq });
  await t.db
    .insertInto("reviewer_check_denials")
    .values({ change_id: change, user_id: 90 + o.seq, status: 403, checked_at: FIXED_NOW })
    .execute();
  const run = await sql<{ id: string }>`
    insert into review_time_runs (repository_id, period, from_date, to_date, base_ref, extractor_version,
      pr_count, excluded_count, aggregates, requests, extracted_at)
    values (${o.repo}, 'baseline', '2026-08-01', '2026-10-01', 'main', 1, 1, 0, '{}'::jsonb, 1, now()) returning id`.execute(
    t.db,
  );
  await sql`insert into review_time_prs (run_id, pr_number, state, author_kind, author_kind_reason, size_bucket,
    start_basis, review_rounds, merged_without_review, paused_minutes)
    values (${run.rows[0]?.id as string}, 1, 'merged', 'agent', 'trailer', 'S', 'opened', 1, false, 0)`.execute(
    t.db,
  );
  await addIncidentRow(t.db, { repositoryId: o.repo, culprit: 1, at: ago(DAY) });
  await sql`insert into metrics_daily (repository_id, day, rollup_version, counts, computed_at)
    values (${o.repo}, '2026-10-13', 1, '{}'::jsonb, now())`.execute(t.db);
  // pg-boss jobs: a top-level installation id, the id inside a webhook payload, and a stranger.
  await sql`insert into pgboss.job (name, data) values
    ('intent.generate', ${JSON.stringify({ installationId: o.id })}::jsonb),
    ('github.webhook', ${JSON.stringify({ deliveryId: `d-${o.seq}`, payload: { installation: { id: o.id } } })}::jsonb),
    ('github.webhook', ${JSON.stringify({ deliveryId: `d2-${o.seq}`, installationId: o.id, payload: {} })}::jsonb)`.execute(
    t.db,
  );
}

/** Independent of the purge's own map: rows of one installation, found through explicit columns. */
async function countsFor(id: number, repo: number): Promise<Record<string, number>> {
  const n = async (q: ReturnType<typeof sql>) =>
    Number(
      ((await (q as ReturnType<typeof sql<{ n: string }>>).execute(t.db)).rows[0] as { n: string })
        .n,
    );
  const changes = sql`(select id from changes where repository_id = ${repo})`;
  const runs = sql`(select id from review_time_runs where repository_id = ${repo})`;
  return {
    installations: await n(sql`select count(*) as n from installations where id = ${id}`),
    repositories: await n(
      sql`select count(*) as n from repositories where installation_id = ${id}`,
    ),
    tasks: await n(sql`select count(*) as n from tasks where repository_id = ${repo}`),
    changes: await n(sql`select count(*) as n from changes where repository_id = ${repo}`),
    provenance: await n(sql`select count(*) as n from provenance where change_id in ${changes}`),
    change_provenance: await n(
      sql`select count(*) as n from change_provenance where change_id in ${changes}`,
    ),
    intent_cards: await n(
      sql`select count(*) as n from intent_cards where change_id in ${changes}`,
    ),
    intent_feedback: await n(
      sql`select count(*) as n from intent_feedback where change_id in ${changes}`,
    ),
    intent_spend: await n(
      sql`select count(*) as n from intent_spend where repository_id = ${repo}`,
    ),
    intent_displays: await n(
      sql`select count(*) as n from intent_displays where change_id in ${changes}`,
    ),
    policy_verdicts: await n(
      sql`select count(*) as n from policy_verdicts where change_id in ${changes}`,
    ),
    guard_events: await n(
      sql`select count(*) as n from guard_events where repository_id = ${repo}`,
    ),
    webhook_deliveries: await n(
      sql`select count(*) as n from webhook_deliveries where installation_id = ${id} or repository_id = ${repo}`,
    ),
    pr_reviewers: await n(
      sql`select count(*) as n from pr_reviewers where change_id in ${changes}`,
    ),
    review_time_runs: await n(
      sql`select count(*) as n from review_time_runs where repository_id = ${repo}`,
    ),
    review_time_prs: await n(
      sql`select count(*) as n from review_time_prs where run_id in ${runs}`,
    ),
    reviewer_check_denials: await n(
      sql`select count(*) as n from reviewer_check_denials where change_id in ${changes}`,
    ),
    incidents: await n(sql`select count(*) as n from incidents where repository_id = ${repo}`),
    metrics_daily: await n(
      sql`select count(*) as n from metrics_daily where repository_id = ${repo}`,
    ),
    mode_changes: await n(
      sql`select count(*) as n from mode_changes where repository_id = ${repo}`,
    ),
    audit_log: await n(sql`select count(*) as n from audit_log where repository_id = ${repo}`),
    main_commits: await n(
      sql`select count(*) as n from main_commits where repository_id = ${repo}`,
    ),
    ci_results: await n(sql`select count(*) as n from ci_results where repository_id = ${repo}`),
    mcp_tokens: await n(sql`select count(*) as n from mcp_tokens where repository_id = ${repo}`),
    mcp_changes: await n(sql`select count(*) as n from mcp_changes where repository_id = ${repo}`),
    pgboss_jobs: await n(
      sql`select count(*) as n from pgboss.job where data->>'installationId' = ${String(id)} or data->'payload'->'installation'->>'id' = ${String(id)}`,
    ),
  };
}

const A = { ...PILOT_A, seq: 1 };
const B = { ...PILOT_B, seq: 2 };

describe("pilot purge", () => {
  it("I-PURGE-1 purging A leaves zero rows for A in every table, B unchanged, and one pilot_purges row", async () => {
    await seedEverything(A);
    await seedEverything(B);
    // A job of nobody in particular survives too.
    await sql`insert into pgboss.job (name, data) values ('intent.feedback.sweep', '{}'::jsonb)`.execute(
      t.db,
    );
    const beforeA = await countsFor(A.id, A.repo);
    const beforeB = await countsFor(B.id, B.repo);
    for (const [table, n] of Object.entries(beforeA)) {
      expect(n, table).toBeGreaterThan(0);
    }
    expect(beforeA.pgboss_jobs).toBe(3);
    expect(beforeA.webhook_deliveries).toBe(2);

    const res = await purgeInstallation(t.db, {
      installationId: A.id,
      schema: "pgboss",
      now: FIXED_NOW,
      dryRun: false,
      confirm: A.login,
    });
    expect(res.dryRun).toBe(false);
    expect(res.counts).toEqual(beforeA);

    const afterA = await countsFor(A.id, A.repo);
    for (const [table, n] of Object.entries(afterA)) expect(n, table).toBe(0);
    expect(await countsFor(B.id, B.repo)).toEqual(beforeB);
    // The stranger job stays.
    const strangers = await sql<{
      n: string;
    }>`select count(*)::text as n from pgboss.job where name = 'intent.feedback.sweep'`.execute(
      t.db,
    );
    expect(strangers.rows[0]?.n).toBe("1");

    const purges = await t.db.selectFrom("pilot_purges").selectAll().execute();
    expect(purges).toHaveLength(1);
    expect(purges[0]).toMatchObject({ installation_id: A.id, purged_at: FIXED_NOW });
    expect(purges[0]?.rows_deleted).toEqual(beforeA);
    expect(purges[0]?.id).toBe(res.purgeId);
    // The row holds no login.
    expect(JSON.stringify(purges[0])).not.toContain(A.login);
  });

  it("I-PURGE-2 every table of TABLE_NAMES except pilot_purges and service_state has a purge entry; a table without one is caught", async () => {
    const covered = Object.keys(OWNED_ROWS);
    const exempt = ["pilot_purges", "service_state"];
    const missing = (names: readonly string[]) =>
      names.filter((n) => !exempt.includes(n) && !covered.includes(n));
    expect(missing(TABLE_NAMES)).toEqual([]);
    expect(missing([...TABLE_NAMES, "fake_table"])).toEqual(["fake_table"]);
    expect(covered.sort()).toEqual([...TABLE_NAMES].filter((n) => !exempt.includes(n)).sort());
    // And every table in the database is in the list (a migration cannot add one quietly).
    const all = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
        and table_name not like 'kysely_%'`.execute(t.db);
    expect(all.rows.map((r) => r.table_name).sort()).toEqual([...TABLE_NAMES].sort());
  });

  describe("CLI", () => {
    const purge = (id: number, ...rest: string[]) =>
      run("pilot", "purge", "--installation", String(id), ...rest);

    it("I-PURGE-3 an active installation needs --even-if-active; a wrong --confirm aborts; both exit 3 and delete nothing", async () => {
      await seedEverything(A);
      await t.db.updateTable("installations").set({ deleted_at: null }).execute();
      const before = await countsFor(A.id, A.repo);

      const active = await purge(A.id, "--confirm", A.login);
      expect(active.code).toBe(3);
      expect(active.err).toContain("--even-if-active");
      const wrong = await purge(A.id, "--confirm", "not-the-login", "--even-if-active");
      expect(wrong.code).toBe(3);
      expect(wrong.err).not.toContain("not-the-login");
      expect(await countsFor(A.id, A.repo)).toEqual(before);
      expect(await t.db.selectFrom("pilot_purges").selectAll().execute()).toEqual([]);

      // --confirm is required, and compared case-insensitively.
      expect((await purge(A.id)).code).toBe(2);
      const ok = await purge(A.id, "--confirm", A.login.toUpperCase(), "--even-if-active");
      expect(ok.code).toBe(0);
      expect(ok.out).toContain("deleted for installation");
      expect(await t.db.selectFrom("installations").selectAll().execute()).toEqual([]);
      // An unknown installation is a usage error.
      expect((await purge(31337, "--confirm", "x")).code).toBe(2);
    });

    it("I-PURGE-4 --dry-run prints the counts and deletes nothing", async () => {
      await seedEverything(A);
      const before = await countsFor(A.id, A.repo);
      const res = await purge(A.id, "--confirm", A.login, "--dry-run");
      expect(res.code).toBe(0);
      expect(res.out).toContain("would delete for installation");
      for (const [table, n] of Object.entries(before)) expect(res.out).toContain(`${table}: ${n}`);
      expect(await countsFor(A.id, A.repo)).toEqual(before);
      expect(await t.db.selectFrom("pilot_purges").selectAll().execute()).toEqual([]);
      // A wrong confirmation is refused even for a dry run.
      expect((await purge(A.id, "--confirm", "other", "--dry-run")).code).toBe(3);
      // A dry run may look at an installation that is still active (it deletes nothing).
      await t.db.updateTable("installations").set({ deleted_at: null }).execute();
      const active = await purge(A.id, "--confirm", A.login, "--dry-run");
      expect(active.code).toBe(0);
      expect(active.out).toContain("would delete for installation");
      expect(await countsFor(A.id, A.repo)).toEqual(before);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// the other commands
// ---------------------------------------------------------------------------------------------

async function world() {
  await addInstallation(t.db, {
    id: PILOT_A.id,
    login: PILOT_A.login,
    repos: [{ id: REPO_ID, name: "sample-ts" }],
  });
  // The repository row must carry the fake API's repository name.
  await t.db
    .updateTable("repositories")
    .set({ full_name: `${OWNER}/${REPO}` })
    .execute();
}

describe("operations CLI", () => {
  it("I-INC-4 incident add, list and remove; an unknown culprit warns on stderr", async () => {
    await world();
    const known = await addChange(t.db, { repositoryId: REPO_ID, prNumber: 7, openedAt: ago(DAY) });
    const added = await run(
      "incident",
      "add",
      "--repo",
      `${OWNER}/${REPO}`,
      "--pr",
      "7",
      "--fix-pr",
      "9",
      "--severity",
      "2",
      "--occurred-at",
      "2026-10-10T09:00:00Z",
    );
    expect(added.code).toBe(0);
    expect(added.err).toBe("");
    expect(added.out).toMatch(/^incident inserted [0-9a-f-]{36}\n$/);
    const unknown = await run("incident", "add", "--repo", `${OWNER}/${REPO}`, "--pr", "812");
    expect(unknown.code).toBe(0);
    expect(unknown.err).toContain("warning: PR #812 is in neither");
    // The same incident twice is not a second row.
    expect((await run("incident", "add", "--repo", `${OWNER}/${REPO}`, "--pr", "812")).out).toMatch(
      /^incident exists/,
    );

    const list = await run("incident", "list", "--installation", String(PILOT_A.id), "--json");
    const rows = JSON.parse(list.out) as {
      id: string;
      culpritPr: number;
      fixPr: number | null;
      source: string;
      severity: number | null;
      occurredAt: string;
    }[];
    expect(rows.map((r) => [r.culpritPr, r.fixPr, r.source, r.severity])).toEqual([
      [7, 9, "cli", 2],
      [812, null, "cli", null],
    ]);
    expect(rows[0]?.occurredAt).toBe("2026-10-10T09:00:00.000Z");
    expect((await run("incident", "list", "--installation", String(PILOT_A.id))).out).toContain(
      "culprit #7",
    );

    const id = rows[0]?.id as string;
    expect((await run("incident", "remove", "--id", id)).out).toBe("removed\n");
    expect((await run("incident", "remove", "--id", id)).code).toBe(1);
    expect(
      JSON.parse(
        (await run("incident", "list", "--installation", String(PILOT_A.id), "--json")).out,
      ),
    ).toHaveLength(1);

    // Usage errors.
    expect((await run("incident", "add", "--repo", `${OWNER}/${REPO}`)).code).toBe(2);
    expect(
      (await run("incident", "add", "--repo", `${OWNER}/${REPO}`, "--pr", "3", "--severity", "9"))
        .code,
    ).toBe(2);
    expect((await run("incident", "add", "--repo", "nobody/none", "--pr", "3")).code).toBe(2);
    expect((await run("incident", "remove", "--id", "nope")).code).toBe(2);
    void known;
  });

  it("baseline: a rate-limit wait above --max-wait exits 3 and leaves no run; a good run exits 0 and prints numbers only", async () => {
    await world();
    api.state.pulls.set(
      1,
      makePull({
        number: 1,
        created_at: "2026-08-11T10:00:00Z",
        title: "SENTINEL_TITLE_cli",
        body: "SENTINEL_BODY_cli",
        user: { login: "sentinel-cli-author", type: "User" },
      }),
    );
    api.state.commits.set(1, [makeCommit(SHA(1), commitMessage("c"))]);
    api.state.timelines.set(1, []);
    const base = [
      "baseline",
      "--repo",
      `${OWNER}/${REPO}`,
      "--from",
      "2026-08-10",
      "--to",
      "2026-08-25",
    ];
    api.state.rateLimit = { limit: 5000, remaining: 101, reset: Math.floor(nowMs / 1000) + 3600 };
    const aborted = await run(...base, "--max-wait", "1m");
    expect(aborted.code).toBe(3);
    expect(aborted.err).toContain("rate-limit wait");
    expect(await t.db.selectFrom("review_time_runs").selectAll().execute()).toEqual([]);

    api.state.rateLimit = null;
    const ok = await run(...base);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^1 PRs \(0 excluded\), \d+ requests, run [0-9a-f-]{36}\n/);
    expect(ok.out).not.toMatch(/sentinel/i);
    expect(await t.db.selectFrom("review_time_runs").selectAll().execute()).toHaveLength(1);
    const dry = await run(...base, "--dry-run", "--period", "shadow");
    expect(dry.out).toMatch(/^dry run: nothing written\. 1 PRs/);
    expect((await run(...base, "--period", "weekly")).code).toBe(2);
    expect(
      (await run("baseline", "--repo", "nobody/none", "--from", "2026-08-10", "--to", "2026-08-25"))
        .code,
    ).toBe(2);
  });

  it("I-ALLOW-1 pilot allow-list resolve rewrites login-only lines as login:id through the fake GitHub; an unknown login writes nothing", async () => {
    await world();
    api.state.users.set("alice", 1001);
    api.state.users.set("bob-dev", 1002);
    const dir = await mkdtemp(path.join(tmpdir(), "graft-allow-"));
    const file = path.join(dir, "allow.txt");
    await writeFile(file, "# pilots\nAlice  # tech lead\n4242\ncarol:77\nbob-dev\n");
    const argv = ["pilot", "allow-list", "resolve", file, "--installation", String(PILOT_A.id)];
    const inodeBefore = statSync(file).ino;
    const res = await run(...argv);
    expect(res.code).toBe(0);
    expect(res.out).toContain("resolved 2 logins");
    // Written through a temp file renamed over the original (a new inode), with nothing left behind.
    expect(statSync(file).ino).not.toBe(inodeBefore);
    expect(readdirSync(dir)).toEqual(["allow.txt"]);
    expect(await readFile(file, "utf8")).toBe(
      "# pilots\nAlice:1001 # tech lead\n4242\ncarol:77\nbob-dev:1002\n",
    );
    // Only requests for users, never for a line that already has an ID.
    expect(api.requests.map((r) => r.path).filter((p) => p.startsWith("/users/"))).toEqual([
      "/users/Alice",
      "/users/bob-dev",
    ]);
    // Nothing left to resolve: the file is unchanged.
    expect((await run(...argv)).out).toContain("resolved 0 logins");

    // One unknown login: exit 3, line number only, the file is not touched.
    const before = "ghost\n1\n";
    await writeFile(file, before);
    const bad = await run(...argv);
    expect(bad.code).toBe(3);
    expect(bad.err).toContain("line 1");
    expect(bad.err).not.toContain("ghost");
    expect(await readFile(file, "utf8")).toBe(before);

    // A malformed line is a usage error naming the line only.
    await writeFile(file, "fine:1\nnot a login!\n");
    const mal = await run(...argv);
    expect(mal.code).toBe(2);
    expect(mal.err).toContain("line 2");
    expect(mal.err).not.toContain("not a login");
    // The installation is required.
    expect((await run("pilot", "allow-list", "resolve", file)).code).toBe(2);

    // A numeric login is written `@1234` and comes out as `1234:id`.
    api.state.users.set("1234", 555);
    await writeFile(file, "@1234\n1234\n");
    expect((await run(...argv)).code).toBe(0);
    expect(await readFile(file, "utf8")).toBe("1234:555\n1234\n");

    // A write that fails leaves the original allow-list as it was (the CLI exits 1).
    await writeFile(file, "alice\n");
    const failing = await opsMain(
      argv,
      { out: () => undefined, err: () => undefined },
      {
        ...deps(),
        writeFileAtomic: async () => {
          throw new Error("disk full");
        },
      },
    );
    expect(failing).toBe(1);
    expect(await readFile(file, "utf8")).toBe("alice\n");
  });

  it("pilot sync-reviewers backfills eligibility; metrics rollup writes rows for the fixture installation", async () => {
    await world();
    api.state.pulls.set(PR_NUMBER, makePull());
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: [{ id: 5001, login: "rev-a", type: "User" }],
      teams: [],
    });
    api.state.permissions.set("rev-a", { id: 5001, role: "write" });
    api.state.permissions.set("rev-b", { id: 5002, role: "write" });
    api.state.reviews.set(PR_NUMBER, [makeReview({ id: 1, login: "rev-b", userId: 5002 })]);
    await addChange(t.db, {
      repositoryId: REPO_ID,
      prNumber: PR_NUMBER,
      openedAt: new Date("2026-10-14T10:00:00Z"),
    });
    await addChange(t.db, {
      repositoryId: REPO_ID,
      prNumber: 77,
      openedAt: new Date("2026-09-01T10:00:00Z"),
    });
    const res = await run(
      "pilot",
      "sync-reviewers",
      "--installation",
      String(PILOT_A.id),
      "--since",
      "2026-10-01",
    );
    expect(res.code).toBe(0);
    expect(res.out).toBe("reviewers synced for 1 PRs, 0 skipped\n");
    expect(
      await t.db
        .selectFrom("pr_reviewers")
        .select(["user_id", "reason"])
        .orderBy("user_id")
        .execute(),
    ).toEqual([
      { user_id: 5001, reason: "requested" },
      { user_id: 5002, reason: "reviewed" },
    ]);
    // A PR that no longer exists is skipped, not fatal.
    api.state.pulls.delete(PR_NUMBER);
    const gone = await run(
      "pilot",
      "sync-reviewers",
      "--installation",
      String(PILOT_A.id),
      "--since",
      "2026-10-01",
    );
    expect(gone.code).toBe(0);
    expect(gone.out).toBe("reviewers synced for 0 PRs, 1 skipped\n");

    const roll = await run(
      "metrics",
      "rollup",
      "--installation",
      String(PILOT_A.id),
      "--from",
      "2026-10-10",
      "--to",
      "2026-10-13",
    );
    expect(roll.code).toBe(0);
    expect(roll.out).toBe("rolled up 3 days for 1 repositories\n");
    expect(
      (await t.db.selectFrom("metrics_daily").select("day").orderBy("day").execute()).map(
        (r) => r.day,
      ),
    ).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(
      (
        await run(
          "metrics",
          "rollup",
          "--installation",
          String(PILOT_A.id),
          "--from",
          "2026-10-13",
          "--to",
          "2026-10-10",
        )
      ).code,
    ).toBe(2);
    expect((await run("pilot", "nope")).code).toBe(2);
  });

  it("a bad configuration and an unmigrated database exit 2 with a message and no stack", async () => {
    let out = "";
    let err = "";
    const io = { out: (s: string) => (out += s), err: (s: string) => (err += s) };
    const badConfig = await opsMain(["pilot", "doctor", "--installation", "1"], io, {
      ...deps(),
      loadConfig: () =>
        loadConfig({ DATABASE_URL: "postgres://x/y", GITHUB_WEBHOOK_SECRET: "SECRETVALUE" }),
    });
    expect(badConfig).toBe(2);
    expect(err).toContain("Invalid configuration");
    expect(err).not.toContain("SECRETVALUE");
    expect(err).not.toMatch(/\n\s+at /);
    expect(out).toBe("");

    // One migration behind: every command stops with the same instruction.
    const down = await migrateDownOne(t.db);
    expect(down).toEqual(["0014_mcp"]);
    try {
      err = "";
      expect(await opsMain(["pilot", "doctor", "--installation", "1"], io, deps())).toBe(2);
      expect(err).toBe("run pnpm db:migrate\n");
    } finally {
      expect(await migrateToLatest(t.db)).toEqual(["0014_mcp"]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// privacy
// ---------------------------------------------------------------------------------------------

describe("privacy of the step 6 tables", () => {
  it("I-PRIV-1 a sentinel title or body in PRs, commits, reviews and payloads never reaches the new tables or the new jobs", async () => {
    const S = [
      "SENTINEL_TITLE_priv",
      "SENTINEL_BODY_priv",
      "SENTINEL_COMMIT_priv",
      "sentinel-author-priv",
      "sentinel-reviewer-priv",
    ];
    await world();
    const body = `Reverts ${OWNER}/${REPO}#7\n\n${S[1]}\nGraft-Agent: sentinel-agent-priv`;
    api.state.pulls.set(
      PR_NUMBER,
      makePull({
        title: S[0] as string,
        body,
        labels: [{ name: "incident" }],
        user: { login: S[3] as string, type: "User" },
        created_at: "2026-08-12T10:00:00Z",
      }),
    );
    api.state.commits.set(PR_NUMBER, [
      makeCommit(
        SHA(5),
        commitMessage(S[2] as string, undefined, [["Graft-Agent", "sentinel-agent-priv"]]),
      ),
    ]);
    api.state.timelines.set(PR_NUMBER, [
      {
        event: "review_requested",
        created_at: "2026-08-12T10:05:00Z",
        requested_reviewer: { login: S[4], type: "User" },
      },
      {
        event: "reviewed",
        submitted_at: "2026-08-12T11:00:00Z",
        user: { login: S[4], type: "User" },
        state: "approved",
        commit_id: SHA(5),
      },
    ]);
    api.state.requestedReviewers.set(PR_NUMBER, {
      users: [
        { id: 6001, login: S[4] as string, type: "User" },
        // Not a collaborator (404): fails closed, recorded by id only.
        { id: 6003, login: `${S[4]}-stranger`, type: "User" },
      ],
      teams: [],
    });
    api.state.permissions.set((S[4] as string).toLowerCase(), { id: 6001, role: "triage" });
    api.state.reviews.set(PR_NUMBER, [makeReview({ id: 1, login: S[4], userId: 6001 })]);
    await addChange(t.db, {
      repositoryId: REPO_ID,
      prNumber: PR_NUMBER,
      author: S[3],
      openedAt: new Date("2026-08-12T10:00:00Z"),
    });

    const ctx = jobContext(t);
    const data = {
      installationId: PILOT_A.id,
      repositoryId: REPO_ID,
      owner: OWNER,
      repo: REPO,
      prNumber: PR_NUMBER,
    };
    await syncReviewers(ctx, data);
    await detectIncident(data, ctx);
    expect(
      (
        await run(
          "baseline",
          "--repo",
          `${OWNER}/${REPO}`,
          "--from",
          "2026-08-10",
          "--to",
          "2026-08-25",
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await run(
          "metrics",
          "rollup",
          "--installation",
          String(PILOT_A.id),
          "--from",
          "2026-08-10",
          "--to",
          "2026-08-20",
        )
      ).code,
    ).toBe(0);
    await addIncidentRow(t.db, { repositoryId: REPO_ID, culprit: 3, at: ago(DAY) });
    // A purge writes a pilot_purges row: use a second, uninstalled installation for it.
    await addInstallation(t.db, {
      id: PILOT_B.id,
      login: PILOT_B.login,
      repos: [{ id: PILOT_B.repo, name: "x" }],
      deleted: true,
    });
    await purgeInstallation(t.db, {
      installationId: PILOT_B.id,
      schema: "pgboss",
      now: FIXED_NOW,
      dryRun: false,
      confirm: PILOT_B.login,
    });

    const tables = [
      "pr_reviewers",
      "reviewer_check_denials",
      "review_time_runs",
      "review_time_prs",
      "incidents",
      "metrics_daily",
      "pilot_purges",
    ];
    let dump = "";
    for (const table of tables) {
      const rows = await sql<{
        t: string;
      }>`select to_json(x)::text as t from ${sql.table(table)} x`.execute(t.db);
      expect(rows.rows.length, table).toBeGreaterThan(0);
      dump += rows.rows.map((r) => r.t).join("\n");
    }
    // Enqueue the pilot jobs the way production does, from payloads full of sentinels: through the
    // webhook handlers and through the feedback_recorded listener.
    const payload = (action: string, edit: (pr: Record<string, unknown>) => void) => {
      const p = structuredClone(loadFixture("pull_request.labeled").payload) as Record<
        string,
        unknown
      >;
      p.action = action;
      const pr = p.pull_request as Record<string, unknown>;
      pr.title = S[0];
      pr.body = body;
      (pr.user as Record<string, unknown>).login = S[3];
      edit(pr);
      return p;
    };
    const ev = (name: string, id: string, p: Record<string, unknown>) =>
      ({ name, deliveryId: id, id, payload: p }) as never;
    await scheduleReviewerSync.handle(
      ev(
        "pull_request",
        "priv-1",
        payload("review_requested", () => {}),
      ),
      ctx,
    );
    await scheduleIncidentDetection.handle(
      ev("pull_request", "priv-2", {
        ...payload("labeled", () => {}),
        label: { name: "incident" },
      }),
      ctx,
    );
    await onChangeSignal(
      {
        kind: "feedback_recorded",
        ...data,
        changeId: "00000000-0000-4000-8000-000000000001",
        headSha: SHA(5),
        atMs: nowMs,
      },
      ctx,
    );
    // The new job names carry ids and numbers only.
    const jobs = await sql<{
      t: string;
    }>`select to_json(j.data)::text as t from pgboss.job j where j.name like 'pilot.%'`.execute(
      t.db,
    );
    // The set must not be empty, or the search below proves nothing.
    expect(jobs.rows.length).toBeGreaterThanOrEqual(2);
    dump += jobs.rows.map((r) => r.t).join("\n");
    for (const secret of [...S, "sentinel-agent-priv", "SENTINEL", "sentinel"]) {
      expect(dump, secret).not.toContain(secret);
    }
  });
});
