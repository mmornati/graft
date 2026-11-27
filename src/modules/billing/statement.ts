import { sql } from "kysely";
import type { Db } from "../../db/client.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function period(month: string): string {
  if (!MONTH.test(month)) throw new BillingStatementError(400, "Month must be YYYY-MM.");
  return `${month}-01`;
}

function periodDate(month: string): Date {
  return new Date(`${period(month)}T00:00:00.000Z`);
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function nextMonth(start: Date): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

export class BillingStatementError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "BillingStatementError";
  }
}

export interface BillingStatementLine {
  id: string;
  teamId: string | null;
  teamName: string;
  repositoryId: number;
  repositoryName: string;
  model: string;
  lineType: "usage" | "adjustment";
  description: string | null;
  calls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: string | null;
  sourcePeriod: string | null;
  sourceLineId: string | null;
  sourceCallId: string | null;
}

export interface BillingStatement {
  month: string;
  closedAt: string | null;
  closedBy: string | null;
  lines: BillingStatementLine[];
}

type RawLine = {
  id: string;
  team_id: string | null;
  team_name: string;
  repository_id: string | number;
  repository_name: string;
  model: string;
  line_type: "usage" | "adjustment";
  description: string | null;
  calls: string | number;
  unpriced_calls: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  cost_usd: string | null;
  source_period: string | null;
  source_line_id: string | null;
  source_call_id: string | null;
};

function line(row: RawLine): BillingStatementLine {
  return {
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name,
    repositoryId: Number(row.repository_id),
    repositoryName: row.repository_name,
    model: row.model,
    lineType: row.line_type,
    description: row.description,
    calls: Number(row.calls),
    unpricedCalls: Number(row.unpriced_calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    costUsd: row.cost_usd,
    sourcePeriod: row.source_period,
    sourceLineId: row.source_line_id,
    sourceCallId: row.source_call_id,
  };
}

export async function getBillingStatement(db: Db, month: string): Promise<BillingStatement> {
  const start = periodDate(month);
  const startDate = `${month}-01`;
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (tx) => {
      const closed = await tx
        .selectFrom("billing_periods")
        .select(["closed_at", "closed_by"])
        .where("period_start", "=", `${month}-01`)
        .executeTakeFirst();
      if (closed) {
        const saved = await sql<RawLine>`
          select l.id::text, l.team_id::text, l.team_name, l.repository_id::text,
                 l.repository_name, l.model, l.line_type, l.description, l.calls::text,
                 l.unpriced_calls::text, l.input_tokens::text, l.output_tokens::text,
                 l.cache_read_tokens::text, l.cache_write_tokens::text, l.cost_usd::text,
                 a.source_period::text, a.source_statement_line_id::text as source_line_id,
                 a.source_call_id::text as source_call_id
            from billing_statement_lines l
            left join billing_adjustments a on a.id = l.adjustment_id
           where l.period_start = ${startDate}
           order by l.team_name, l.repository_name, l.model, l.line_type, l.id`.execute(tx);
        return {
          month,
          closedAt: closed.closed_at.toISOString(),
          closedBy: closed.closed_by,
          lines: saved.rows.map(line),
        };
      }

      const end = nextMonth(start);
      const spend = await sql<RawLine>`
        select md5(concat_ws(':', coalesce(a.team_id::text, 'unattributed'), a.team_name,
                             c.repository_id, c.repository_name, c.model)) as id,
               a.team_id::text, a.team_name, c.repository_id::text, c.repository_name, c.model,
               'usage'::text as line_type, null::text as description,
               count(*)::text as calls,
               count(*) filter (where c.cost_usd is null)::text as unpriced_calls,
               sum(a.input_tokens)::text as input_tokens, sum(a.output_tokens)::text as output_tokens,
               sum(a.cache_read_tokens)::text as cache_read_tokens,
               sum(a.cache_write_tokens)::text as cache_write_tokens,
               sum(a.cost_usd)::text as cost_usd,
               null::text as source_period, null::text as source_line_id,
               null::text as source_call_id
          from billing_spend_allocations a
          join billing_spend_calls c on c.id = a.spend_call_id
         where c.spent_at >= ${start} and c.spent_at < ${end}
         group by a.team_id, a.team_name, c.repository_id, c.repository_name, c.model
         order by a.team_name, c.repository_name, c.model`.execute(tx);
      const adjustments = await sql<RawLine>`
        select id::text, team_id::text, team_name, repository_id::text, repository_name, model,
               'adjustment'::text as line_type, reason as description,
               case when source_call_id is null then 0 else 1 end::text as calls,
               (cost_usd is null)::int::text as unpriced_calls,
               input_tokens::text, output_tokens::text, cache_read_tokens::text,
               cache_write_tokens::text, cost_usd::text,
               source_period::text, source_statement_line_id::text as source_line_id,
               source_call_id::text as source_call_id
          from billing_adjustments
         where period_start = ${startDate}
         order by team_name, repository_name, id`.execute(tx);
      return {
        month,
        closedAt: null,
        closedBy: null,
        lines: [...spend.rows.map(line), ...adjustments.rows.map(line)],
      };
    });
}

async function closePeriod(
  db: Db,
  start: Date,
  now: Date,
): Promise<{ closed: boolean; unpricedCalls: number }> {
  const month = monthOf(start);
  const startDate = `${month}-01`;
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('graft-billing'), hashtext(${month}))`.execute(
      tx,
    );
    const existing = await tx
      .selectFrom("billing_periods")
      .select("period_start")
      .where("period_start", "=", `${month}-01`)
      .executeTakeFirst();
    if (existing) return { closed: true, unpricedCalls: 0 };

    const end = nextMonth(start);
    const unpriced = await sql<{ n: string }>`
      select (
        (select count(*) from billing_spend_calls
          where spent_at >= ${start} and spent_at < ${end} and cost_usd is null)
        +
        (select count(*) from billing_adjustments
          where period_start = ${startDate} and cost_usd is null)
      )::text as n`.execute(tx);
    const unpricedCalls = Number(unpriced.rows[0]?.n ?? 0);
    if (unpricedCalls > 0) return { closed: false, unpricedCalls };

    const hasSpend = await sql<{ n: string }>`
      select (
        (select count(*) from billing_spend_calls where spent_at >= ${start} and spent_at < ${end})
        +
        (select count(*) from billing_adjustments where period_start = ${startDate})
      )::text as n`.execute(tx);
    if (Number(hasSpend.rows[0]?.n ?? 0) === 0) return { closed: false, unpricedCalls: 0 };

    await tx
      .insertInto("billing_periods")
      .values({ period_start: startDate, closed_at: now, closed_by: "system" })
      .execute();
    await sql`
      insert into billing_statement_lines
        (period_start, team_id, team_name, repository_id, repository_name, model, line_type,
         description, calls, unpriced_calls, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cost_usd)
      select ${startDate}, a.team_id, a.team_name, c.repository_id, c.repository_name, c.model,
             'usage', null, count(*), 0, sum(a.input_tokens), sum(a.output_tokens),
             sum(a.cache_read_tokens), sum(a.cache_write_tokens), sum(a.cost_usd)
        from billing_spend_allocations a
        join billing_spend_calls c on c.id = a.spend_call_id
       where c.spent_at >= ${start} and c.spent_at < ${end}
       group by a.team_id, a.team_name, c.repository_id, c.repository_name, c.model`.execute(tx);
    await sql`
      insert into billing_statement_lines
        (period_start, team_id, team_name, repository_id, repository_name, model, line_type,
         description, adjustment_id, calls, unpriced_calls, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd)
      select period_start, team_id, team_name, repository_id, repository_name, model,
             'adjustment', reason, id,
             case when source_call_id is null then 0 else 1 end, 0,
             input_tokens, output_tokens, cache_read_tokens,
             cache_write_tokens, cost_usd
        from billing_adjustments where period_start = ${startDate}`.execute(tx);
    return { closed: true, unpricedCalls: 0 };
  });
}

export async function closeEligibleBillingPeriods(
  db: Db,
  now: Date,
): Promise<{ closed: string[]; blocked: { month: string; unpricedCalls: number }[] }> {
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const currentMonthDate = new Date(`${currentMonth}T00:00:00.000Z`);
  const candidates = await sql<{ period_start: string }>`
    select distinct period_start::text from (
      select date_trunc('month', spent_at at time zone 'UTC')::date as period_start
        from billing_spend_calls where spent_at < ${currentMonthDate}
      union
      select period_start from billing_adjustments where period_start < ${currentMonth}
    ) periods order by period_start`.execute(db);
  const closed: string[] = [];
  const blocked: { month: string; unpricedCalls: number }[] = [];
  for (const candidate of candidates.rows) {
    const start = periodDate(candidate.period_start.slice(0, 7));
    const result = await closePeriod(db, start, now);
    const month = monthOf(start);
    if (result.closed) closed.push(month);
    else if (result.unpricedCalls > 0) blocked.push({ month, unpricedCalls: result.unpricedCalls });
  }
  return { closed, blocked };
}

export async function createBillingAdjustment(
  db: Db,
  o: {
    sourcePeriod: string;
    sourceLineId: string;
    amountUsd: string;
    reason: string;
    actor: string;
    now: Date;
    operationId: string;
  },
): Promise<{ period: string }> {
  const sourceStartDate = period(o.sourcePeriod);
  if (!/^-?\d{1,12}(?:\.\d{1,2})?$/.test(o.amountUsd) || Number(o.amountUsd) === 0) {
    throw new BillingStatementError(
      400,
      "Adjustment amount must be a non-zero USD amount to cents.",
    );
  }
  const reason = o.reason.trim();
  if (!reason || reason.length > 500) {
    throw new BillingStatementError(400, "Adjustment reason must be 1–500 characters.");
  }
  const next = nextMonth(periodDate(o.sourcePeriod));
  return db.transaction().execute(async (tx) => {
    const prior = await tx
      .selectFrom("billing_adjustments")
      .select("period_start")
      .where("operation_id", "=", o.operationId)
      .executeTakeFirst();
    if (prior) return { period: String(prior.period_start).slice(0, 7) };
    const source = await tx
      .selectFrom("billing_statement_lines")
      .selectAll()
      .where("id", "=", o.sourceLineId)
      .where("period_start", "=", sourceStartDate)
      .executeTakeFirst();
    if (!source) throw new BillingStatementError(404, "Closed statement line not found.");
    if (source.line_type !== "usage")
      throw new BillingStatementError(400, "Adjustments must reference a usage line.");
    let target = next;
    for (let i = 0; i < 120; i++) {
      await sql`select pg_advisory_xact_lock(hashtext('graft-billing'), hashtext(${monthOf(target)}))`.execute(
        tx,
      );
      const closed = await tx
        .selectFrom("billing_periods")
        .select("period_start")
        .where("period_start", "=", `${monthOf(target)}-01`)
        .executeTakeFirst();
      if (!closed) break;
      target = nextMonth(target);
      if (i === 119) throw new BillingStatementError(409, "No open billing month is available.");
    }
    const inserted = await tx
      .insertInto("billing_adjustments")
      .values({
        operation_id: o.operationId,
        period_start: `${monthOf(target)}-01`,
        team_id: source.team_id,
        team_name: source.team_name,
        repository_id: source.repository_id,
        repository_name: source.repository_name,
        model: source.model,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: o.amountUsd,
        source_call_id: null,
        source_period: sourceStartDate,
        source_statement_line_id: o.sourceLineId,
        reason,
        created_by: o.actor,
        created_at: o.now,
      })
      .onConflict((oc) => oc.column("operation_id").doNothing())
      .returning("id")
      .execute();
    if (!inserted.length) {
      const retry = await tx
        .selectFrom("billing_adjustments")
        .select("period_start")
        .where("operation_id", "=", o.operationId)
        .executeTakeFirstOrThrow();
      return { period: String(retry.period_start).slice(0, 7) };
    }
    return { period: monthOf(target) };
  });
}

export function billingMonthStart(month: string): Date {
  return periodDate(month);
}

export function nextBillingMonth(month: string): string {
  period(month);
  return monthOf(nextMonth(periodDate(month)));
}
