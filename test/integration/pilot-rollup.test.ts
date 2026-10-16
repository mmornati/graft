import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyCronSchedules } from "../../src/app/crons.js";
import { feedbackSweepJob } from "../../src/modules/intent/index.js";
import {
  emptyCounts,
  type MetricsCounts,
  metricsCountsSchema,
  metricsRollupJob,
  rollupRange,
  runRollup,
} from "../../src/modules/pilot/index.js";
import { createPgBossQueue } from "../../src/queue/queue.js";
import { createTestApp, jobContext, type TestApp } from "../helpers/app.js";
import { testConfig } from "../helpers/config.js";
import { truncateAll } from "../helpers/db.js";
import { INSTALLATION_ID, REPO_ID } from "../helpers/github-builders.js";
import {
  addCard,
  addChange,
  addDelivery,
  addDisplay,
  addIncidentRow,
  addProvenance,
  addSpend,
  addVerdict,
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
  await seedWorld(t.db);
});

const D = (day: string, time = "12:00:00"): Date => new Date(`${day}T${time}Z`);
const DAY = "2026-10-10";
const range = { from: D(DAY, "00:00:00"), to: D("2026-10-11", "00:00:00") };
const stored = async (day: string) => {
  const row = await t.db
    .selectFrom("metrics_daily")
    .selectAll()
    .where("repository_id", "=", REPO_ID)
    .where("day", "=", day)
    .executeTakeFirst();
  return row ? metricsCountsSchema.parse(row.counts) : undefined;
};

/** One seeded day with a known answer for every counter. */
async function seedDay(): Promise<void> {
  const opened = D(DAY, "10:00:00");
  const prev = D("2026-10-09", "10:00:00");
  const old = D("2026-10-08", "10:00:00");

  // c1: agent, opened and merged on DAY, trivial ok card, verdict history would_require -> would_approve.
  const c1 = await addChange(t.db, {
    repositoryId: REPO_ID,
    prNumber: 1,
    author: "alice",
    state: "merged",
    openedAt: opened,
    mergedAt: D(DAY, "15:00:00"),
  });
  await addProvenance(t.db, { changeId: c1, headSha: SHA(1), kind: "agent" });
  const card1 = await addCard(t.db, {
    changeId: c1,
    headSha: SHA(1),
    risk: "trivial",
    verifier: "agree",
    createdAt: opened,
  });
  await addVerdict(t.db, {
    changeId: c1,
    headSha: SHA(1),
    outcome: "would_require",
    factsReadAt: D(DAY, "11:00:00"),
  });
  await addVerdict(t.db, {
    changeId: c1,
    headSha: SHA(1),
    outcome: "would_approve",
    factsReadAt: D(DAY, "14:00:00"),
  });
  await addDisplay(t.db, { changeId: c1, cardId: card1, status: "ok", shownAt: opened });

  // c2: human, merged on DAY; verdict history would_approve (old) -> would_require (latest);
  // its only card is unavailable (so it is not a trivial final card).
  const c2 = await addChange(t.db, {
    repositoryId: REPO_ID,
    prNumber: 2,
    author: "bob",
    state: "merged",
    openedAt: opened,
    mergedAt: D(DAY, "16:00:00"),
  });
  await addProvenance(t.db, { changeId: c2, headSha: SHA(2), kind: "human" });
  const card2 = await addCard(t.db, {
    changeId: c2,
    headSha: SHA(2),
    status: "unavailable",
    risk: "trivial",
    verifier: "skipped",
    createdAt: opened,
  });
  await addVerdict(t.db, {
    changeId: c2,
    headSha: SHA(2),
    outcome: "would_approve",
    factsReadAt: D(DAY, "11:00:00"),
  });
  await addVerdict(t.db, {
    changeId: c2,
    headSha: SHA(2),
    outcome: "would_require",
    factsReadAt: D(DAY, "15:00:00"),
  });
  await addDisplay(t.db, { changeId: c2, cardId: card2, status: "unavailable", shownAt: opened });

  // c3: agent, opened the day before, merged on DAY, no verdict; a logic card with a disagreeing verifier.
  const c3 = await addChange(t.db, {
    repositoryId: REPO_ID,
    prNumber: 3,
    author: "carol",
    state: "merged",
    openedAt: prev,
    mergedAt: D(DAY, "17:00:00"),
  });
  await addProvenance(t.db, { changeId: c3, headSha: SHA(3), kind: "agent" });
  const card3 = await addCard(t.db, {
    changeId: c3,
    headSha: SHA(3),
    verifier: "disagree",
    createdAt: opened,
  });
  await addDisplay(t.db, { changeId: c3, cardId: card3, status: "pending", shownAt: opened });

  // c4: an excluded author (merged on DAY): left out of every PR counter, but its card counts.
  const c4 = await addChange(t.db, {
    repositoryId: REPO_ID,
    prNumber: 4,
    author: "Dependabot[bot]",
    state: "merged",
    openedAt: opened,
    mergedAt: D(DAY, "12:00:00"),
  });
  await addProvenance(t.db, { changeId: c4, headSha: SHA(4), kind: "agent" });
  await addCard(t.db, { changeId: c4, headSha: SHA(4), verifier: "agree", createdAt: opened });
  await addVerdict(t.db, {
    changeId: c4,
    headSha: SHA(4),
    outcome: "would_approve",
    factsReadAt: D(DAY, "12:30:00"),
  });

  // c5: opened and closed without merge on DAY; an ok card whose verifier errored.
  const c5 = await addChange(t.db, {
    repositoryId: REPO_ID,
    prNumber: 5,
    author: "dave",
    state: "closed",
    openedAt: opened,
    closedAt: D(DAY, "13:00:00"),
  });
  await addCard(t.db, { changeId: c5, headSha: SHA(5), verifier: "error", createdAt: opened });

  // c6: opened on the next day; c7, c8, c9: merged on DAY with a block / no policy / invalid policy.
  await addChange(t.db, {
    repositoryId: REPO_ID,
    prNumber: 6,
    author: "erin",
    openedAt: D("2026-10-11", "01:00:00"),
  });
  for (const [pr, outcome] of [
    [7, "would_block"],
    [8, "no_policy"],
    [9, "policy_invalid"],
  ] as const) {
    const id = await addChange(t.db, {
      repositoryId: REPO_ID,
      prNumber: pr,
      author: "frank",
      state: "merged",
      openedAt: old,
      mergedAt: D(DAY, "18:00:00"),
    });
    await addVerdict(t.db, {
      changeId: id,
      headSha: SHA(pr),
      outcome,
      factsReadAt: D(DAY, "17:30:00"),
    });
  }

  // Spend: priced, priced, unpriced on DAY; one on another day.
  await addSpend(t.db, {
    repositoryId: REPO_ID,
    changeId: c1,
    tokens: 1000,
    cost: 0.5,
    at: D(DAY, "10:30:00"),
  });
  await addSpend(t.db, {
    repositoryId: REPO_ID,
    changeId: c2,
    tokens: 2000,
    cost: 0.25,
    at: D(DAY, "10:45:00"),
  });
  await addSpend(t.db, {
    repositoryId: REPO_ID,
    changeId: c3,
    tokens: 500,
    cost: null,
    at: D(DAY, "11:30:00"),
  });
  await addSpend(t.db, {
    repositoryId: REPO_ID,
    changeId: c3,
    tokens: 9999,
    cost: 9,
    at: D("2026-10-11", "00:00:01"),
  });

  // Incidents and deliveries.
  await addIncidentRow(t.db, { repositoryId: REPO_ID, culprit: 5, at: D(DAY, "09:00:00") });
  await addIncidentRow(t.db, { repositoryId: REPO_ID, culprit: 6, at: D(DAY, "23:59:59") });
  await addIncidentRow(t.db, {
    repositoryId: REPO_ID,
    culprit: 7,
    at: D("2026-10-11", "00:00:00"),
  });
  for (const [i, at] of [
    D(DAY, "00:00:00"),
    D(DAY, "08:00:00"),
    D(DAY, "23:00:00"),
    D(DAY, "12:00:00"),
  ].entries()) {
    await addDelivery(t.db, {
      id: `dl-${i}`,
      installationId: INSTALLATION_ID,
      repositoryId: REPO_ID,
      at,
    });
  }
  await addDelivery(t.db, {
    id: "dl-next",
    installationId: INSTALLATION_ID,
    repositoryId: REPO_ID,
    at: D("2026-10-11", "00:00:00"),
  });
  await addDelivery(t.db, {
    id: "dl-other",
    installationId: null,
    repositoryId: 999,
    at: D(DAY, "09:00:00"),
  });
}

const EXPECTED: MetricsCounts = {
  ...emptyCounts(),
  prs_opened: 3, // c1, c2, c5 (c4 is excluded; c3 opened the day before)
  prs_opened_agent: 1, // c1
  prs_merged: 6, // c1, c2, c3, c7, c8, c9
  prs_closed_unmerged: 1, // c5
  cards_ok: 4, // c1, c3, c4, c5
  cards_unavailable: 1, // c2
  verifier_agree: 2, // c1, c4
  verifier_disagree: 1,
  verifier_error: 1,
  verifier_skipped: 1,
  displays_ok: 1,
  displays_unavailable: 1,
  displays_pending: 1,
  spend_runs: 3,
  spend_tokens: 3500,
  cost_usd: "0.75",
  unpriced_runs: 1,
  unpriced_tokens: 500,
  merged_would_approve: 1, // c1 (the latest verdict); c2's older would_approve is not counted
  merged_would_require: 1, // c2 (the latest verdict)
  merged_would_block: 1,
  merged_no_policy: 1,
  merged_policy_invalid: 1,
  merged_no_verdict: 1, // c3
  merged_would_approve_agent: 1,
  merged_agent: 2, // c1, c3
  merged_trivial: 1, // c1
  incidents: 2,
  deliveries: 4,
};

describe("daily rollup", () => {
  it("I-ROLL-1 every counter of a seeded day equals a hand count (latest verdict at the merge head, excluded authors left out)", async () => {
    await seedDay();
    const res = await rollupRange(jobContext(t), { installationId: INSTALLATION_ID, ...range });
    expect(res).toEqual({ repositories: 1, days: 1 });
    expect(await stored(DAY)).toEqual(EXPECTED);
    const row = await t.db.selectFrom("metrics_daily").selectAll().executeTakeFirstOrThrow();
    expect(row.rollup_version).toBe(1);
    expect(row.day).toBe(DAY);
  });

  it("I-ROLL-2 re-running is idempotent; a late incident within the window updates the day", async () => {
    await seedDay();
    const ctx = { ...jobContext(t), clock: { now: () => D("2026-10-12", "03:00:00") } };
    await runRollup(ctx);
    expect(await stored(DAY)).toEqual(EXPECTED);
    const first = await t.db.selectFrom("metrics_daily").selectAll().orderBy("day").execute();
    await runRollup(ctx);
    const second = await t.db.selectFrom("metrics_daily").selectAll().orderBy("day").execute();
    expect(second.map((r) => [r.day, r.counts])).toEqual(first.map((r) => [r.day, r.counts]));
    // The run covers the 7 days before today (2026-10-05 to 2026-10-11).
    expect(first.map((r) => r.day)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    // An incident recorded late (occurred on DAY) shows up at the next run.
    await addIncidentRow(t.db, { repositoryId: REPO_ID, culprit: 11, at: D(DAY, "20:00:00") });
    await runRollup(ctx);
    expect((await stored(DAY))?.incidents).toBe(3);
    expect(await stored(DAY)).toEqual({ ...EXPECTED, incidents: 3 });
  });

  it("I-ROLL-3 rows older than 730 days are deleted; removed repositories are not recomputed", async () => {
    const now = D("2026-10-14", "03:00:00");
    const ctx = { ...jobContext(t), clock: { now: () => now } };
    const counts = JSON.stringify(emptyCounts());
    const insert = (day: string) =>
      sql`insert into metrics_daily (repository_id, day, rollup_version, counts, computed_at)
        values (${REPO_ID}, ${day}::date, 1, ${counts}::jsonb, now())`.execute(t.db);
    // today - 730 days = 2024-10-14: older goes, the boundary day stays.
    await insert("2024-10-13");
    await insert("2024-10-14");
    await insert("2026-01-01");
    await runRollup(ctx);
    const days = (await t.db.selectFrom("metrics_daily").select("day").execute()).map((r) => r.day);
    expect(days).not.toContain("2024-10-13");
    expect(days).toContain("2024-10-14");
    expect(days).toContain("2026-01-01");
    expect(days).toContain("2026-10-13");

    // A removed repository is not touched by the next run.
    await t.db.deleteFrom("metrics_daily").execute();
    await t.db.updateTable("repositories").set({ removed_at: new Date() }).execute();
    await runRollup(ctx);
    expect(await t.db.selectFrom("metrics_daily").selectAll().execute()).toEqual([]);
    // Nor is a deleted installation.
    await t.db.updateTable("repositories").set({ removed_at: null }).execute();
    await t.db.updateTable("installations").set({ deleted_at: new Date() }).execute();
    await runRollup(ctx);
    expect(await t.db.selectFrom("metrics_daily").selectAll().execute()).toEqual([]);
  });

  it("I-ROLL-4 the worker schedules the rollup cron; off unschedules it", async () => {
    const queue = createPgBossQueue({
      connectionString: t.deps.config.databaseUrl,
      schema: t.deps.config.pgbossSchema,
      registry: { jobs: [feedbackSweepJob, metricsRollupJob] },
      log: t.deps.log,
      supervise: true,
    });
    await queue.start();
    try {
      await applyCronSchedules(queue, testConfig());
      const rollup = await queue.boss.getSchedules(metricsRollupJob.name);
      expect(rollup).toHaveLength(1);
      expect(rollup[0]?.cron).toBe("15 2 * * *");
      expect(await queue.boss.getSchedules(feedbackSweepJob.name)).toHaveLength(1);

      await applyCronSchedules(queue, testConfig({ GRAFT_METRICS_ROLLUP_CRON: "30 3 * * *" }));
      expect((await queue.boss.getSchedules(metricsRollupJob.name))[0]?.cron).toBe("30 3 * * *");

      await applyCronSchedules(queue, testConfig({ GRAFT_METRICS_ROLLUP_CRON: "off" }));
      expect(await queue.boss.getSchedules(metricsRollupJob.name)).toEqual([]);
      // The feedback cron is independent of the rollup cron.
      expect(await queue.boss.getSchedules(feedbackSweepJob.name)).toHaveLength(1);
    } finally {
      // The schedules persist in the database: a later file's supervising worker would otherwise
      // send the sweep for a missed occurrence and call GitHub in the middle of its test.
      await applyCronSchedules(queue, { feedbackPollCron: null, metricsRollupCron: null });
      await queue.stop();
      await sql`delete from pgboss.job where name in (${metricsRollupJob.name}, ${feedbackSweepJob.name})`.execute(
        t.db,
      );
    }
  });
});
