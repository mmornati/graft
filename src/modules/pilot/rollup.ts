/**
 * Daily rollup (step 6, T6, D8, §8.4): additive counters per repository and UTC day, recomputed
 * for the last 7 days by a cron job (an idempotent upsert) and pruned after 730 days. Accuracy and
 * percentiles are never rolled up: they are computed from raw rows at report time.
 */
import { sql } from "kysely";
import { z } from "zod";
import type { JobContext } from "../../core/context.js";
import type { Db } from "../../db/client.js";
import { defineJob } from "../../queue/job.js";

export const METRICS_ROLLUP_JOB = "pilot.metrics.rollup";
export const ROLLUP_VERSION = 1;
export const ROLLUP_WINDOW_DAYS = 7;
export const ROLLUP_RETENTION_DAYS = 730;
const DAY_MS = 86_400_000;

const COUNT_KEYS = [
  "prs_opened",
  "prs_opened_agent",
  "prs_merged",
  "prs_closed_unmerged",
  "cards_ok",
  "cards_unavailable",
  "verifier_agree",
  "verifier_disagree",
  "verifier_error",
  "verifier_skipped",
  "displays_ok",
  "displays_unavailable",
  "displays_pending",
  "spend_runs",
  "spend_tokens",
  "unpriced_runs",
  "unpriced_tokens",
  "merged_would_approve",
  "merged_would_require",
  "merged_would_block",
  "merged_no_policy",
  "merged_policy_invalid",
  "merged_no_verdict",
  "merged_would_approve_agent",
  "merged_agent",
  "merged_trivial",
  "incidents",
  "deliveries",
] as const;
export type CountKey = (typeof COUNT_KEYS)[number] | "cost_usd";

const count = z.number().int().min(0);
/** `cost_usd` is a decimal string (numeric sums do not fit a JSON number exactly). */
export const metricsCountsSchema = z.strictObject({
  ...(Object.fromEntries(COUNT_KEYS.map((k) => [k, count])) as Record<
    (typeof COUNT_KEYS)[number],
    typeof count
  >),
  cost_usd: z.string().regex(/^\d+(\.\d{1,8})?$/),
});
export type MetricsCounts = z.infer<typeof metricsCountsSchema>;

export const emptyCounts = (): MetricsCounts => ({
  ...(Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Record<
    (typeof COUNT_KEYS)[number],
    number
  >),
  cost_usd: "0",
});

export const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

type Rows<T> = { rows: T[] };

/** Counters for every day of `[from, to)` (UTC days) of one repository. */
export async function computeDays(
  db: Db,
  o: { repositoryId: number; from: Date; to: Date; excludedAuthors: readonly string[] },
): Promise<Map<string, MetricsCounts>> {
  const days = new Map<string, MetricsCounts>();
  for (let t = o.from.getTime(); t < o.to.getTime(); t += DAY_MS) {
    days.set(ymd(new Date(t)), emptyCounts());
  }
  const bump = (day: string, key: Exclude<CountKey, "cost_usd">, n: number) => {
    const c = days.get(day);
    if (c) c[key] += n;
  };
  const excluded = o.excludedAuthors.length > 0 ? o.excludedAuthors : [""];
  const repo = o.repositoryId;
  const { from, to } = o;
  const day = (col: ReturnType<typeof sql.raw>) => sql`(${col} at time zone 'UTC')::date::text`;

  // PRs (excluded authors left out).
  const opened = (await sql<{ day: string; n: string; agent: string }>`
    select ${day(sql.raw("ch.opened_at"))} as day, count(*)::text as n,
      count(*) filter (where cp.author_kind = 'agent')::text as agent
    from changes ch left join change_provenance cp on cp.change_id = ch.id
    where ch.repository_id = ${repo} and ch.opened_at >= ${from} and ch.opened_at < ${to}
      and lower(ch.author_login) not in (${sql.join(excluded)})
    group by 1`.execute(db)) as Rows<{ day: string; n: string; agent: string }>;
  for (const r of opened.rows) {
    bump(r.day, "prs_opened", Number(r.n));
    bump(r.day, "prs_opened_agent", Number(r.agent));
  }
  const closed = await sql<{ day: string; n: string }>`
    select ${day(sql.raw("ch.closed_at"))} as day, count(*)::text as n
    from changes ch
    where ch.repository_id = ${repo} and ch.state = 'closed'
      and ch.closed_at >= ${from} and ch.closed_at < ${to}
      and lower(ch.author_login) not in (${sql.join(excluded)})
    group by 1`.execute(db);
  for (const r of closed.rows) bump(r.day, "prs_closed_unmerged", Number(r.n));

  // Merged PRs: the latest verdict for the merge head (greatest facts_read_at) and the final card.
  const merged = await sql<{
    day: string;
    outcome: string | null;
    agent: boolean;
    trivial: boolean;
    n: string;
  }>`
    select ${day(sql.raw("ch.merged_at"))} as day, v.outcome,
      coalesce(cp.author_kind = 'agent', false) as agent,
      coalesce(card.risk_class = 'trivial' and card.status = 'ok', false) as trivial,
      count(*)::text as n
    from changes ch
    left join change_provenance cp on cp.change_id = ch.id
    left join lateral (
      select pv.outcome from policy_verdicts pv
      where pv.change_id = ch.id and pv.head_sha = ch.head_sha
      order by pv.facts_read_at desc, pv.created_at desc limit 1
    ) v on true
    left join lateral (
      select c.risk_class, c.status from intent_cards c
      where c.change_id = ch.id and c.head_sha = ch.head_sha
      order by (c.status = 'ok') desc, c.created_at desc limit 1
    ) card on true
    where ch.repository_id = ${repo} and ch.state = 'merged'
      and ch.merged_at >= ${from} and ch.merged_at < ${to}
      and lower(ch.author_login) not in (${sql.join(excluded)})
    group by 1, 2, 3, 4`.execute(db);
  const outcomeKey = {
    would_approve: "merged_would_approve",
    would_require: "merged_would_require",
    would_block: "merged_would_block",
    no_policy: "merged_no_policy",
    policy_invalid: "merged_policy_invalid",
  } as const;
  for (const r of merged.rows) {
    const n = Number(r.n);
    bump(r.day, "prs_merged", n);
    const key =
      r.outcome === null ? "merged_no_verdict" : outcomeKey[r.outcome as keyof typeof outcomeKey];
    if (key !== undefined) bump(r.day, key, n);
    if (r.agent) bump(r.day, "merged_agent", n);
    if (r.agent && r.outcome === "would_approve") bump(r.day, "merged_would_approve_agent", n);
    if (r.trivial) bump(r.day, "merged_trivial", n);
  }

  // Cards by creation day; displays by display day.
  const cards = await sql<{ day: string; status: string; verifier: string; n: string }>`
    select ${day(sql.raw("c.created_at"))} as day, c.status, c.verifier_status as verifier,
      count(*)::text as n
    from intent_cards c join changes ch on ch.id = c.change_id
    where ch.repository_id = ${repo} and c.created_at >= ${from} and c.created_at < ${to}
    group by 1, 2, 3`.execute(db);
  for (const r of cards.rows) {
    const n = Number(r.n);
    bump(r.day, r.status === "ok" ? "cards_ok" : "cards_unavailable", n);
    const vk = `verifier_${r.verifier}` as const;
    if (
      vk === "verifier_agree" ||
      vk === "verifier_disagree" ||
      vk === "verifier_error" ||
      vk === "verifier_skipped"
    ) {
      bump(r.day, vk, n);
    }
  }
  const displays = await sql<{ day: string; status: string; n: string }>`
    select ${day(sql.raw("d.shown_at"))} as day, d.status, count(*)::text as n
    from intent_displays d join changes ch on ch.id = d.change_id
    where ch.repository_id = ${repo} and d.shown_at >= ${from} and d.shown_at < ${to}
    group by 1, 2`.execute(db);
  for (const r of displays.rows) {
    const k = `displays_${r.status}` as const;
    if (k === "displays_ok" || k === "displays_unavailable" || k === "displays_pending") {
      bump(r.day, k, Number(r.n));
    }
  }

  // Spend by day.
  const spend = await sql<{
    day: string;
    runs: string;
    tokens: string;
    cost: string | null;
    unpriced_runs: string;
    unpriced_tokens: string;
  }>`
    select ${day(sql.raw("s.spent_at"))} as day, count(*)::text as runs,
      coalesce(sum(s.tokens), 0)::text as tokens,
      sum(s.cost_usd)::text as cost,
      count(*) filter (where s.cost_usd is null)::text as unpriced_runs,
      coalesce(sum(s.tokens) filter (where s.cost_usd is null), 0)::text as unpriced_tokens
    from intent_spend s
    where s.repository_id = ${repo} and s.spent_at >= ${from} and s.spent_at < ${to}
    group by 1`.execute(db);
  for (const r of spend.rows) {
    bump(r.day, "spend_runs", Number(r.runs));
    bump(r.day, "spend_tokens", Number(r.tokens));
    bump(r.day, "unpriced_runs", Number(r.unpriced_runs));
    bump(r.day, "unpriced_tokens", Number(r.unpriced_tokens));
    const c = days.get(r.day);
    if (c && r.cost !== null) c.cost_usd = trimDecimal(r.cost);
  }

  const incidents = await sql<{ day: string; n: string }>`
    select ${day(sql.raw("i.occurred_at"))} as day, count(*)::text as n from incidents i
    where i.repository_id = ${repo} and i.occurred_at >= ${from} and i.occurred_at < ${to}
    group by 1`.execute(db);
  for (const r of incidents.rows) bump(r.day, "incidents", Number(r.n));
  const deliveries = await sql<{ day: string; n: string }>`
    select ${day(sql.raw("w.received_at"))} as day, count(*)::text as n from webhook_deliveries w
    where w.repository_id = ${repo} and w.received_at >= ${from} and w.received_at < ${to}
    group by 1`.execute(db);
  for (const r of deliveries.rows) bump(r.day, "deliveries", Number(r.n));

  return days;
}

/** `0.01200000` becomes `0.012`; `3.00000000` becomes `3`. */
function trimDecimal(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Recompute `[from, to)` for the active repositories of one installation (or of all). */
export async function rollupRange(
  ctx: JobContext,
  o: { installationId?: number; from: Date; to: Date },
): Promise<{ repositories: number; days: number }> {
  const repos = await sql<{ id: number }>`
    select r.id from repositories r join installations i on i.id = r.installation_id
    where r.removed_at is null and i.deleted_at is null and i.suspended_at is null
      ${o.installationId === undefined ? sql`` : sql`and i.id = ${o.installationId}`}
    order by r.id`.execute(ctx.db);
  const now = ctx.clock.now();
  let days = 0;
  for (const r of repos.rows) {
    const computed = await computeDays(ctx.db, {
      repositoryId: Number(r.id),
      from: o.from,
      to: o.to,
      excludedAuthors: ctx.config.metricsExcludedAuthors,
    });
    for (const [d, counts] of computed) {
      const parsed = metricsCountsSchema.parse(counts);
      await ctx.db
        .insertInto("metrics_daily")
        .values({
          repository_id: Number(r.id),
          day: d,
          rollup_version: ROLLUP_VERSION,
          counts: JSON.stringify(parsed),
          computed_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["repository_id", "day"]).doUpdateSet({
            rollup_version: ROLLUP_VERSION,
            counts: JSON.stringify(parsed),
            computed_at: now,
          }),
        )
        .execute();
      days++;
    }
  }
  return { repositories: repos.rows.length, days };
}

/** The scheduled run: the last 7 UTC days, then prune. */
export async function runRollup(ctx: JobContext): Promise<{ repositories: number; days: number }> {
  const today = startOfUtcDay(ctx.clock.now());
  const out = await rollupRange(ctx, {
    from: new Date(today.getTime() - ROLLUP_WINDOW_DAYS * DAY_MS),
    to: today,
  });
  const cutoff = ymd(new Date(today.getTime() - ROLLUP_RETENTION_DAYS * DAY_MS));
  await ctx.db.deleteFrom("metrics_daily").where("day", "<", cutoff).execute();
  return out;
}

export const metricsRollupJob = defineJob<Record<string, never>>({
  name: METRICS_ROLLUP_JOB,
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  options: { retryLimit: 1 },
  async handle(_data, ctx) {
    const r = await runRollup(ctx);
    ctx.log.info(r, "metrics rollup done");
  },
});
