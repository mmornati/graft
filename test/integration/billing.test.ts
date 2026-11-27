import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  billingTeamSnapshot,
  closeEligibleBillingPeriods,
  createBillingAdjustment,
  getBillingStatement,
  storeBillingCalls,
} from "../../src/modules/billing/index.js";
import {
  markRepositoriesRemoved,
  upsertRepositories,
} from "../../src/modules/installations/store.js";
import type { SpendCall } from "../../src/modules/intent/generate.js";
import { purgeInstallation } from "../../src/pilot/purge.js";
import { testDb, truncateAll } from "../helpers/db.js";
import { addInstallation } from "../helpers/pilot-seed.js";

const db = testDb();
const REPOSITORY_ID = 2000001;
const TEAM_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];
const call = (spentAt: Date, costUsd: number | null): SpendCall => ({
  model: "test-provider/model",
  usage: {
    inputTokens: 5,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
  },
  costUsd,
  priceVersion: costUsd === null ? null : "test-price-v1",
  spentAt,
  billingTeams: [],
});

beforeEach(async () => {
  await truncateAll(db);
  await addInstallation(db, {
    id: 1000001,
    login: "acme",
    repos: [{ id: REPOSITORY_ID, name: "api" }],
  });
  for (const [index, id] of TEAM_IDS.entries()) {
    await db
      .insertInto("billing_teams")
      .values({
        id,
        name: `Team ${index + 1}`,
        created_by: "operator",
        created_at: new Date("2026-09-01T00:00:00Z"),
      })
      .execute();
    await db
      .insertInto("billing_team_repositories")
      .values({
        team_id: id,
        repository_id: REPOSITORY_ID,
        created_by: "operator",
        created_at: new Date("2026-09-01T00:00:00Z"),
      })
      .execute();
  }
});

afterAll(async () => {
  await db.destroy();
});

async function save(
  spend: SpendCall,
  recordedAt = spend.spentAt,
  snapshot?: { id: string; name: string }[],
) {
  const teams = snapshot ?? (await billingTeamSnapshot(db, REPOSITORY_ID));
  await db.transaction().execute((tx) =>
    storeBillingCalls(tx, {
      calls: [{ ...spend, billingTeams: teams }],
      repositoryId: REPOSITORY_ID,
      repositoryName: "acme/api",
      changeId: randomUUID(),
      recordedAt,
    }),
  );
}

describe("team chargeback ledger", () => {
  it("rounds through ledger precision and makes persisted call IDs idempotent", async () => {
    const spend = {
      ...call(new Date("2026-09-12T10:00:00Z"), 0.145),
      id: randomUUID(),
      priceSnapshot: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },
    };
    await save(spend);
    await save(spend);
    const calls = await db.selectFrom("billing_spend_calls").selectAll().execute();
    const allocations = await db.selectFrom("billing_spend_allocations").selectAll().execute();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.price_snapshot).toEqual(spend.priceSnapshot);
    expect(allocations.map((row) => row.cost_usd)).toEqual(["0.05", "0.05", "0.05"]);
  });

  it("retains a successful zero-token call with unknown usage and blocks period closure", async () => {
    await save({
      ...call(new Date("2026-09-12T10:00:00Z"), null),
      id: randomUUID(),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(await db.selectFrom("billing_spend_calls").selectAll().execute()).toHaveLength(1);
    const statement = await getBillingStatement(db, "2026-09");
    expect(statement.lines).toHaveLength(3);
    expect(statement.lines[0]).toMatchObject({ calls: 1, unpricedCalls: 1, costUsd: null });
    expect(await closeEligibleBillingPeriods(db, new Date("2026-10-02T00:05:00Z"))).toMatchObject({
      blocked: [{ month: "2026-09", unpricedCalls: 1 }],
    });
  });

  it("keeps live statement IDs unique when team display names change mid-period", async () => {
    const firstTeam = await billingTeamSnapshot(db, REPOSITORY_ID);
    await save(call(new Date("2026-09-12T10:00:00Z"), 0.05), undefined, firstTeam);
    const teamId = TEAM_IDS[0];
    if (!teamId) throw new Error("test team id is missing");
    await db
      .updateTable("billing_teams")
      .set({ name: "Renamed team" })
      .where("id", "=", teamId)
      .execute();
    await save(call(new Date("2026-09-13T10:00:00Z"), 0.05));
    const statement = await getBillingStatement(db, "2026-09");
    expect(new Set(statement.lines.map((line) => line.id)).size).toBe(statement.lines.length);
  });

  it("freezes equal allocation and distributes token/cents remainders deterministically", async () => {
    await save(call(new Date("2026-09-12T10:00:00Z"), 0.05));
    const allocations = await db
      .selectFrom("billing_spend_allocations")
      .select([
        "team_id",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "cost_usd",
      ])
      .orderBy("team_id")
      .execute();

    expect(allocations.map((row) => row.cost_usd)).toEqual(["0.02", "0.02", "0.01"]);
    expect(allocations.map((row) => Number(row.input_tokens))).toEqual([2, 2, 1]);
    expect(allocations.map((row) => Number(row.output_tokens))).toEqual([2, 1, 1]);
    expect(allocations.map((row) => Number(row.cache_read_tokens))).toEqual([1, 1, 0]);
    expect(allocations.map((row) => Number(row.cache_write_tokens))).toEqual([1, 0, 0]);

    const firstTeamId = TEAM_IDS[0];
    if (!firstTeamId) throw new Error("test team id is missing");
    await db.deleteFrom("billing_team_repositories").where("team_id", "=", firstTeamId).execute();
    const statement = await getBillingStatement(db, "2026-09");
    expect(statement.lines).toHaveLength(3);
    expect(statement.lines.map((line) => line.teamId).sort()).toEqual([...TEAM_IDS].sort());
  });

  it("keeps closed statements immutable and writes late usage and corrections to a later period", async () => {
    await save(call(new Date("2026-09-12T10:00:00Z"), 0.05));
    const closed = await closeEligibleBillingPeriods(db, new Date("2026-10-02T00:05:00Z"));
    expect(closed.closed).toContain("2026-09");
    const original = await getBillingStatement(db, "2026-09");
    expect(original.closedAt).not.toBeNull();

    const lateCallId = randomUUID();
    await save(
      { ...call(new Date("2026-09-20T10:00:00Z"), 0.03), id: lateCallId },
      new Date("2026-10-02T00:06:00Z"),
    );
    expect(await getBillingStatement(db, "2026-09")).toEqual(original);
    const usageLine = original.lines.find((line) => line.lineType === "usage");
    expect(usageLine).toBeDefined();
    const correction = await createBillingAdjustment(db, {
      sourcePeriod: "2026-09",
      sourceLineId: usageLine?.id ?? "",
      amountUsd: "-1.25",
      reason: "Provider reconciliation",
      actor: "operator",
      now: new Date("2026-10-02T00:07:00Z"),
      operationId: randomUUID(),
    });
    expect(correction.period).toBe("2026-10");
    const later = await getBillingStatement(db, "2026-10");
    const manualCorrection = later.lines.find(
      (line) => line.description === "Provider reconciliation",
    );
    expect(manualCorrection).toMatchObject({
      calls: 0,
      sourcePeriod: "2026-09-01",
      sourceLineId: usageLine?.id,
      sourceCallId: null,
    });
    expect(later.lines.find((line) => line.sourceCallId !== null)?.sourceCallId).toBe(lateCallId);
    expect(later.lines.filter((line) => line.lineType === "adjustment")).toHaveLength(4);
    await closeEligibleBillingPeriods(db, new Date("2026-11-02T00:05:00Z"));
    const closedLater = await getBillingStatement(db, "2026-10");
    expect(closedLater.lines).toContainEqual(
      expect.objectContaining({
        description: "Provider reconciliation",
        calls: 0,
        sourcePeriod: "2026-09-01",
        sourceLineId: usageLine?.id,
        sourceCallId: null,
      }),
    );
    expect(closedLater.lines.find((line) => line.sourceCallId !== null)?.sourceCallId).toBe(
      lateCallId,
    );
  });

  it("skips already closed correction months while preserving the original source line", async () => {
    await save(call(new Date("2026-09-12T10:00:00Z"), 0.05));
    await closeEligibleBillingPeriods(db, new Date("2026-10-02T00:05:00Z"));
    const source = (await getBillingStatement(db, "2026-09")).lines[0];
    if (!source) throw new Error("test source line is missing");
    await db
      .insertInto("billing_periods")
      .values({ period_start: "2026-10-01", closed_at: new Date(), closed_by: "test" })
      .execute();
    const result = await createBillingAdjustment(db, {
      sourcePeriod: "2026-09",
      sourceLineId: source.id,
      amountUsd: "1.00",
      reason: "After close",
      actor: "operator",
      now: new Date("2026-10-03T00:00:00Z"),
      operationId: randomUUID(),
    });
    expect(result.period).toBe("2026-11");
    expect((await getBillingStatement(db, "2026-11")).lines[0]).toMatchObject({
      sourcePeriod: "2026-09-01",
      sourceLineId: source.id,
      sourceCallId: null,
      calls: 0,
    });
  });

  it("reuses the result of a correction submitted with the same operation ID", async () => {
    await save(call(new Date("2026-09-12T10:00:00Z"), 0.05));
    await closeEligibleBillingPeriods(db, new Date("2026-10-02T00:05:00Z"));
    const source = (await getBillingStatement(db, "2026-09")).lines[0];
    if (!source) throw new Error("test source line is missing");
    const operationId = randomUUID();
    const input = {
      sourcePeriod: "2026-09",
      sourceLineId: source.id,
      amountUsd: "1.00",
      reason: "One correction",
      actor: "operator",
      now: new Date("2026-10-03T00:00:00Z"),
      operationId,
    };
    expect(await createBillingAdjustment(db, input)).toEqual({ period: "2026-10" });
    expect(await createBillingAdjustment(db, input)).toEqual({ period: "2026-10" });
    expect(
      await db
        .selectFrom("billing_adjustments")
        .selectAll()
        .where("operation_id", "=", operationId)
        .execute(),
    ).toHaveLength(1);
  });

  it("clears current team memberships when a repository is removed and re-added", async () => {
    await save(call(new Date("2026-09-12T10:00:00Z"), 0.05));
    await markRepositoriesRemoved(db, 1000001, [REPOSITORY_ID], new Date("2026-10-01T00:00:00Z"));
    await upsertRepositories(
      db,
      1000001,
      [{ id: REPOSITORY_ID, fullName: "acme/api", private: true }],
      new Date("2026-10-02T00:00:00Z"),
    );
    expect(
      await db
        .selectFrom("billing_team_repositories")
        .where("repository_id", "=", REPOSITORY_ID)
        .execute(),
    ).toEqual([]);
    expect((await getBillingStatement(db, "2026-09")).lines).toHaveLength(3);
  });

  it("leaves a month open while any model call is unpriced", async () => {
    await save(call(new Date("2026-09-12T10:00:00Z"), null));
    const closed = await closeEligibleBillingPeriods(db, new Date("2026-10-02T00:05:00Z"));
    expect(closed.closed).toEqual([]);
    expect(closed.blocked).toEqual([{ month: "2026-09", unpricedCalls: 1 }]);
    expect((await getBillingStatement(db, "2026-09")).lines[0]).toMatchObject({
      unpricedCalls: 1,
      costUsd: null,
    });
  });

  it("preserves billing statements and ledger rows when a repository is purged", async () => {
    await save(call(new Date("2026-09-12T10:00:00Z"), 0.05));
    await closeEligibleBillingPeriods(db, new Date("2026-10-02T00:05:00Z"));
    await db
      .updateTable("installations")
      .set({ deleted_at: new Date("2026-10-01T00:00:00Z") })
      .where("id", "=", 1000001)
      .execute();

    const result = await purgeInstallation(db, {
      installationId: 1000001,
      schema: "pgboss",
      now: new Date("2026-10-02T00:10:00Z"),
      dryRun: false,
    });

    expect(result.preservedCounts).toMatchObject({
      billing_spend_calls: 1,
      billing_spend_allocations: 3,
      billing_statement_lines: 3,
    });
    expect(await db.selectFrom("billing_spend_calls").selectAll().execute()).toHaveLength(1);
    expect((await getBillingStatement(db, "2026-09")).lines).toHaveLength(3);
    expect(await db.selectFrom("billing_team_repositories").selectAll().execute()).toHaveLength(0);
  });
});
