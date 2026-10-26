import { sql } from "kysely";
import type { DaySummary } from "../../../shared/api.js";
import type { Db } from "../db.js";

/** `[lo, hi)` in UTC for the local dates `from`..`to` (inclusive) in `tz`. */
export const windowSql = (tz: string, from: string, to: string) => sql`
  select (${from}::date)::timestamp at time zone ${tz}::text as lo,
         ((${to}::date + 1)::timestamp at time zone ${tz}::text) as hi`;

/** One summary per local date from `from` to `to` (inclusive), newest first, zero-filled. */
export async function listDays(
  db: Db,
  tz: string,
  from: string,
  to: string,
): Promise<DaySummary[]> {
  const r = await sql<{
    date: string;
    prs_opened: number;
    prs_merged: number;
    cards: number;
    cards_unavailable: number;
    cards_budget: number;
    verifier_agree: number;
    verifier_disagree: number;
    repositories: number;
    deliveries: number;
    deliveries_ignored: number;
    tokens: number;
    cost_usd: number;
    guard_events: number;
    guard_needs_human: number;
  }>`
    with b as (${windowSql(tz, from, to)}),
    d as (select generate_series(${from}::date, ${to}::date, interval '1 day')::date as day),
    o as (
      select (opened_at at time zone ${tz}::text)::date as day, count(*)::int as n
        from changes, b where opened_at >= b.lo and opened_at < b.hi group by 1),
    m as (
      select (merged_at at time zone ${tz}::text)::date as day, count(*)::int as n
        from changes, b where merged_at >= b.lo and merged_at < b.hi group by 1),
    c as (
      select (ic.created_at at time zone ${tz}::text)::date as day,
             count(*)::int as n,
             count(*) filter (where ic.status = 'unavailable')::int as unavailable,
             count(*) filter (where ic.failure_reason = 'budget_exceeded')::int as budget,
             count(*) filter (where ic.status = 'ok' and ic.verifier_status = 'agree')::int as agree,
             count(*) filter (where ic.status = 'ok' and ic.verifier_status = 'disagree')::int as disagree,
             count(distinct ch.repository_id)::int as repos
        from intent_cards ic join changes ch on ch.id = ic.change_id, b
       where ic.created_at >= b.lo and ic.created_at < b.hi group by 1),
    w as (
      select (received_at at time zone ${tz}::text)::date as day, count(*)::int as n,
             count(*) filter (where status = 'ignored')::int as ignored
        from webhook_deliveries, b where received_at >= b.lo and received_at < b.hi group by 1),
    s as (
      select (spent_at at time zone ${tz}::text)::date as day,
             coalesce(sum(tokens), 0)::bigint as tokens, coalesce(sum(cost_usd), 0)::numeric as cost
        from intent_spend, b where spent_at >= b.lo and spent_at < b.hi group by 1),
    g as (
      select (created_at at time zone ${tz}::text)::date as day, count(*)::int as n,
             count(*) filter (where status in ('needs_human', 'ambiguous', 'error'))::int as human
        from guard_events, b where created_at >= b.lo and created_at < b.hi group by 1)
    select d.day::text as date,
           coalesce(o.n, 0) as prs_opened, coalesce(m.n, 0) as prs_merged,
           coalesce(c.n, 0) as cards, coalesce(c.unavailable, 0) as cards_unavailable,
           coalesce(c.budget, 0) as cards_budget, coalesce(c.agree, 0) as verifier_agree,
           coalesce(c.disagree, 0) as verifier_disagree, coalesce(c.repos, 0) as repositories,
           coalesce(w.n, 0) as deliveries, coalesce(w.ignored, 0) as deliveries_ignored,
           coalesce(s.tokens, 0) as tokens, coalesce(s.cost, 0) as cost_usd,
           coalesce(g.n, 0) as guard_events, coalesce(g.human, 0) as guard_needs_human
      from d
      left join o using (day) left join m using (day) left join c using (day)
      left join w using (day) left join s using (day) left join g using (day)
     order by d.day desc
  `.execute(db);
  return r.rows.map((x) => ({
    date: x.date,
    prsOpened: x.prs_opened,
    prsMerged: x.prs_merged,
    cards: x.cards,
    cardsUnavailable: x.cards_unavailable,
    cardsBudget: x.cards_budget,
    verifierAgree: x.verifier_agree,
    verifierDisagree: x.verifier_disagree,
    deliveries: x.deliveries,
    deliveriesIgnored: x.deliveries_ignored,
    tokens: Number(x.tokens),
    costUsd: Number(x.cost_usd),
    guardEvents: x.guard_events,
    guardNeedsHuman: x.guard_needs_human,
    repositories: x.repositories,
  }));
}

export async function installedAt(db: Db): Promise<Date | null> {
  const r = await db
    .selectFrom("installations")
    .select((eb) => eb.fn.min("created_at").as("at"))
    .executeTakeFirst();
  return (r?.at as Date | null | undefined) ?? null;
}
