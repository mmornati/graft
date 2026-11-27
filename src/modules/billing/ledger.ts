import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { Db } from "../../db/client.js";
import type { Database } from "../../db/schema.js";
import type { SpendCall } from "../intent/generate.js";

type Executor = Db | Transaction<Database>;
export type BillingTeamSnapshot = { id: string; name: string };

export async function billingTeamSnapshot(
  ex: Executor,
  repositoryId: number,
): Promise<BillingTeamSnapshot[]> {
  const rows = await ex
    .selectFrom("billing_team_repositories as tr")
    .innerJoin("billing_teams as bt", "bt.id", "tr.team_id")
    .select(["bt.id", "bt.name"])
    .where("tr.repository_id", "=", repositoryId)
    .where("bt.archived_at", "is", null)
    .orderBy("bt.id")
    .execute();
  return rows.map(({ id, name }) => ({ id, name }));
}

function splitInteger(total: number, count: number, index: number): number {
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
}

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthId(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function nextMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

export async function storeBillingCalls(
  ex: Transaction<Database>,
  o: {
    calls: readonly SpendCall[];
    repositoryId: number;
    repositoryName: string;
    changeId: string;
    recordedAt: Date;
  },
): Promise<void> {
  for (const call of o.calls) {
    const originalPeriod = monthStart(call.spentAt);
    await sql`select pg_advisory_xact_lock(hashtext('graft-billing'), hashtext(${monthId(originalPeriod)}))`.execute(
      ex,
    );
    const originalClosed = await ex
      .selectFrom("billing_periods")
      .select("period_start")
      .where("period_start", "=", `${monthId(originalPeriod)}-01`)
      .executeTakeFirst();

    const spend = await ex
      .insertInto("billing_spend_calls")
      .values({
        id: call.id ?? randomUUID(),
        repository_id: o.repositoryId,
        repository_name: o.repositoryName,
        change_id: o.changeId,
        model: call.model,
        input_tokens: call.usage.inputTokens,
        output_tokens: call.usage.outputTokens,
        cache_read_tokens: call.usage.cacheReadTokens,
        cache_write_tokens: call.usage.cacheWriteTokens,
        cost_usd: call.costUsd,
        price_version: call.priceVersion,
        price_snapshot: call.priceSnapshot ? JSON.stringify(call.priceSnapshot) : null,
        spent_at: call.spentAt,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!spend) continue;

    const teams = call.billingTeams.length
      ? [...call.billingTeams].sort((a, b) => a.id.localeCompare(b.id))
      : [{ id: null, name: "Unattributed" }];
    const totalCents =
      call.costUsd === null ? null : Math.round(Math.round(call.costUsd * 1e8) / 1e6);
    const allocationRows = teams.map((team, index) => ({
      spend_call_id: spend.id,
      team_id: team.id,
      team_name: team.name,
      input_tokens: splitInteger(call.usage.inputTokens, teams.length, index),
      output_tokens: splitInteger(call.usage.outputTokens, teams.length, index),
      cache_read_tokens: splitInteger(call.usage.cacheReadTokens, teams.length, index),
      cache_write_tokens: splitInteger(call.usage.cacheWriteTokens, teams.length, index),
      cost_usd:
        totalCents === null
          ? null
          : (splitInteger(totalCents, teams.length, index) / 100).toFixed(2),
    }));
    await ex.insertInto("billing_spend_allocations").values(allocationRows).execute();
    if (originalClosed) {
      let target = nextMonth(originalPeriod);
      let foundOpen = false;
      for (let i = 0; i < 120; i++) {
        await sql`select pg_advisory_xact_lock(hashtext('graft-billing'), hashtext(${monthId(target)}))`.execute(
          ex,
        );
        const closed = await ex
          .selectFrom("billing_periods")
          .select("period_start")
          .where("period_start", "=", `${monthId(target)}-01`)
          .executeTakeFirst();
        if (!closed) {
          foundOpen = true;
          break;
        }
        target = nextMonth(target);
      }
      if (!foundOpen) {
        throw new Error("could not find an open billing period for a late model call");
      }
      await ex
        .insertInto("billing_adjustments")
        .values(
          allocationRows.map((allocation) => ({
            period_start: `${monthId(target)}-01`,
            team_id: allocation.team_id,
            team_name: allocation.team_name,
            repository_id: o.repositoryId,
            repository_name: o.repositoryName,
            model: call.model,
            input_tokens: allocation.input_tokens,
            output_tokens: allocation.output_tokens,
            cache_read_tokens: allocation.cache_read_tokens,
            cache_write_tokens: allocation.cache_write_tokens,
            cost_usd: allocation.cost_usd,
            source_call_id: spend.id,
            reason: `Late-recorded model call from ${monthId(originalPeriod)}.`,
            created_by: "system",
            created_at: o.recordedAt,
          })),
        )
        .execute();
    }
  }
}
