/**
 * `pnpm graft pilot doctor` (step 6, T10, D12): health checks that read the database only (no
 * GitHub call). Lines name counts, repositories and job names; never PR text or voter logins.
 */
import { sql } from "kysely";
import type { Config } from "../config/index.js";
import type { Db } from "../db/client.js";
import { hasMembersRead, hasStatusesRead } from "../modes/index.js";
import { countAppliedSince } from "../modules/audit/index.js";
import { resolveCeiling } from "../modules/modes/cli.js";
import { modesOf } from "../modules/modes/effective.js";
import { listRepositoryModeRows } from "../modules/modes/store.js";

export type CheckStatus = "OK" | "WARN" | "FAIL";
export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

const DAY_MS = 86_400_000;
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const num = (v: unknown): number => Number(v ?? 0);

export async function runDoctor(
  db: Db,
  config: Pick<
    Config,
    | "pgbossSchema"
    | "llmDailyTokenBudget"
    | "feedbackPollCron"
    | "metricsRollupCron"
    | "modeCeiling"
    | "guardConfirmSeconds"
  >,
  o: { installationId: number; now: Date },
): Promise<Check[]> {
  const id = o.installationId;
  const now = o.now;
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const checks: Check[] = [];
  const add = (c: string, status: CheckStatus, detail: string) =>
    checks.push({ id: c, status, detail });

  // installation
  const inst = await db
    .selectFrom("installations")
    .select(["repository_selection", "suspended_at", "deleted_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!inst) add("installation", "FAIL", "installation not found");
  else if (inst.deleted_at !== null) add("installation", "FAIL", "installation was uninstalled");
  else if (inst.suspended_at !== null) add("installation", "FAIL", "installation is suspended");
  else if (inst.repository_selection === "all") {
    add(
      "installation",
      "WARN",
      "repository_selection is all: pilots should install on selected repositories only",
    );
  } else add("installation", "OK", "installed on selected repositories");

  // repositories
  const repos = await sql<{ id: number; full_name: string }>`
    select id, full_name from repositories
    where installation_id = ${id} and removed_at is null order by id`.execute(db);
  if (repos.rows.length === 0) add("repositories", "FAIL", "0 active repositories");
  else {
    const names = repos.rows.slice(0, 5).map((r) => r.full_name);
    const more = repos.rows.length > 5 ? `, +${repos.rows.length - 5} more` : "";
    add("repositories", "OK", `${repos.rows.length} active: ${names.join(", ")}${more}`);
  }

  // deliveries
  const lastDelivery = await sql<{ at: Date | null }>`
    select max(received_at) as at from webhook_deliveries
    where installation_id = ${id}
       or repository_id in (select id from repositories where installation_id = ${id})`.execute(db);
  const last = lastDelivery.rows[0]?.at ?? null;
  if (last === null || last < ago(7 * DAY_MS)) {
    add("deliveries", "FAIL", "no webhook delivery in the last 7 days");
  } else if (last < ago(3 * DAY_MS)) {
    add("deliveries", "WARN", "no webhook delivery in the last 72 hours");
  } else add("deliveries", "OK", "webhooks are arriving");

  // jobs_failed (pg-boss: <schema>.job, state 'failed', data->>'installationId')
  const hasBoss = (
    await sql<{
      r: string | null;
    }>`select to_regclass(${`${quote(config.pgbossSchema)}.job`})::text as r`.execute(db)
  ).rows[0]?.r;
  if (!hasBoss) add("jobs_failed", "WARN", "the job queue schema is not installed");
  else {
    const failed = await sql<{ name: string; n: string }>`
      select name, count(*)::text as n from ${sql.raw(quote(config.pgbossSchema))}.job
      where state = 'failed' and data->>'installationId' = ${String(id)}
        and coalesce(completed_on, created_on) >= ${ago(DAY_MS)}
      group by name order by name`.execute(db);
    const total = failed.rows.reduce((s, r) => s + num(r.n), 0);
    const byName = failed.rows.map((r) => `${r.name} ${r.n}`).join(", ");
    if (total > 10) add("jobs_failed", "FAIL", `${total} failed jobs in 24 h: ${byName}`);
    else if (total >= 1) add("jobs_failed", "WARN", `${total} failed jobs in 24 h: ${byName}`);
    else add("jobs_failed", "OK", "no failed jobs in 24 h");
  }

  // cards
  const prs = await sql<{ prs: string; cards: string }>`
    select
      (select count(*) from changes ch join repositories r on r.id = ch.repository_id
        where r.installation_id = ${id} and ch.opened_at >= ${ago(7 * DAY_MS)})::text as prs,
      (select count(*) from intent_cards c join changes ch on ch.id = c.change_id
        join repositories r on r.id = ch.repository_id
        where r.installation_id = ${id} and c.created_at >= ${ago(7 * DAY_MS)})::text as cards`.execute(
    db,
  );
  const nPrs = num(prs.rows[0]?.prs);
  const nCards = num(prs.rows[0]?.cards);
  if (nPrs > 0 && nCards === 0) add("cards", "FAIL", `${nPrs} PRs opened in 7 days but 0 cards`);
  else if (nCards === 0) add("cards", "OK", "no PRs opened in the last 7 days");
  else {
    const unavailable = await sql<{ reason: string | null; n: string }>`
      select c.failure_reason as reason, count(*)::text as n
      from intent_cards c join changes ch on ch.id = c.change_id
        join repositories r on r.id = ch.repository_id
      where r.installation_id = ${id} and c.created_at >= ${ago(7 * DAY_MS)} and c.status = 'unavailable'
      group by 1 order by 2 desc, 1`.execute(db);
    const bad = unavailable.rows.reduce((s, r) => s + num(r.n), 0);
    const reasons = unavailable.rows.map((r) => `${r.reason ?? "unknown"} ${r.n}`).join(", ");
    if (bad / nCards > 0.2) {
      add("cards", "WARN", `${bad} of ${nCards} cards unavailable in 7 days (${reasons})`);
    } else add("cards", "OK", `${nCards} cards in 7 days, ${bad} unavailable`);
  }

  // feedback
  const fb = await sql<{ votes: string; shown: string; unsynced: string }>`
    select
      (select count(*) from intent_feedback f join changes ch on ch.id = f.change_id
        join repositories r on r.id = ch.repository_id
        where r.installation_id = ${id} and f.reacted_at >= ${ago(7 * DAY_MS)})::text as votes,
      (select count(*) from intent_displays d join changes ch on ch.id = d.change_id
        join repositories r on r.id = ch.repository_id
        where r.installation_id = ${id} and d.shown_at >= ${ago(7 * DAY_MS)} and d.status = 'ok')::text as shown,
      (select count(distinct f.change_id) from intent_feedback f join changes ch on ch.id = f.change_id
        join repositories r on r.id = ch.repository_id
        where r.installation_id = ${id}
          and not exists (select 1 from pr_reviewers p where p.change_id = f.change_id and p.verified))::text as unsynced`.execute(
    db,
  );
  const fr = fb.rows[0];
  const den = await sql<{ forbidden: string; not_found: string }>`
    select count(*) filter (where d.status = 403)::text as forbidden,
      count(*) filter (where d.status = 404)::text as not_found
    from reviewer_check_denials d join changes ch on ch.id = d.change_id
    join repositories r on r.id = ch.repository_id
    where r.installation_id = ${id} and d.checked_at >= ${ago(7 * DAY_MS)}`.execute(db);
  if (num(fr?.votes) === 0 && num(fr?.shown) > 0) {
    add("feedback", "WARN", "0 votes in 7 days while cards were shown");
  } else if (num(den.rows[0]?.forbidden) > 0) {
    add(
      "feedback",
      "WARN",
      `${num(den.rows[0]?.forbidden)} reviewer permission checks were forbidden (403) in 7 days: does the App have Metadata: read? Those reviewers are not eligible`,
    );
  } else if (num(fr?.unsynced) > 0) {
    add(
      "feedback",
      "WARN",
      `${num(fr?.unsynced)} PRs have votes but no verified reviewer row (run pilot sync-reviewers)`,
    );
  } else {
    const nf = num(den.rows[0]?.not_found);
    add(
      "feedback",
      "OK",
      `${num(fr?.votes)} votes in 7 days${nf > 0 ? `; ${nf} reviewer permission checks answered 404 (not a collaborator)` : ""}`,
    );
  }

  // policy
  const pol = await sql<{ full_name: string; outcome: string }>`
    select r.full_name, v.outcome
    from repositories r
    join lateral (
      select pv.outcome from policy_verdicts pv join changes ch on ch.id = pv.change_id
      where ch.repository_id = r.id order by pv.facts_read_at desc limit 1
    ) v on true
    where r.installation_id = ${id} and r.removed_at is null`.execute(db);
  const badPolicy = pol.rows.filter(
    (r) => r.outcome === "policy_invalid" || r.outcome === "no_policy",
  );
  if (badPolicy.length > 0) {
    add("policy", "WARN", badPolicy.map((r) => `${r.full_name}: ${r.outcome}`).join(", "));
  } else add("policy", "OK", "policy files load");

  // budget
  const budget = config.llmDailyTokenBudget;
  if (budget <= 0) add("budget", "OK", "no daily token budget set");
  else {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const spent = await sql<{ full_name: string; tokens: string }>`
      select r.full_name, coalesce(sum(s.tokens), 0)::text as tokens
      from repositories r left join intent_spend s
        on s.repository_id = r.id and s.spent_at >= ${dayStart} and s.spent_at < ${new Date(dayStart.getTime() + DAY_MS)}
      where r.installation_id = ${id} and r.removed_at is null
      group by r.full_name order by r.full_name`.execute(db);
    const over = spent.rows.filter((r) => num(r.tokens) >= budget);
    const near = spent.rows.filter((r) => num(r.tokens) >= budget * 0.8 && num(r.tokens) < budget);
    if (over.length > 0) {
      add(
        "budget",
        "FAIL",
        `over the daily token budget: ${over.map((r) => r.full_name).join(", ")}`,
      );
    } else if (near.length > 0) {
      add(
        "budget",
        "WARN",
        `at 80% of the daily token budget: ${near.map((r) => r.full_name).join(", ")}`,
      );
    } else add("budget", "OK", "within the daily token budget");
  }

  // rollup
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  const missing = await sql<{ n: string }>`
    select count(*)::text as n from repositories r
    where r.installation_id = ${id} and r.removed_at is null
      and not exists (select 1 from metrics_daily m where m.repository_id = r.id and m.day = ${yesterday}::date)`.execute(
    db,
  );
  if (num(missing.rows[0]?.n) > 0) {
    add(
      "rollup",
      "WARN",
      `no metrics_daily row for ${yesterday} for ${num(missing.rows[0]?.n)} repositories`,
    );
  } else add("rollup", "OK", `metrics rolled up through ${yesterday}`);

  // crons
  if (!hasBoss) add("crons", "WARN", "the job queue schema is not installed");
  else {
    const wanted: [string, string | null][] = [
      ["intent.feedback.sweep", config.feedbackPollCron],
      ["pilot.metrics.rollup", config.metricsRollupCron],
    ];
    const sched = await sql<{ name: string }>`
      select name from ${sql.raw(quote(config.pgbossSchema))}.schedule`.execute(db);
    const have = new Set(sched.rows.map((r) => r.name));
    const gone = wanted.filter(([name, cron]) => cron !== null && !have.has(name)).map(([n]) => n);
    if (gone.length > 0) add("crons", "WARN", `schedule missing in pg-boss: ${gone.join(", ")}`);
    else add("crons", "OK", "feedback and rollup schedules are present");
  }

  // permissions (Phase 1 step 1): a mode that needs a permission stays in report until it is read
  const unread = await sql<{ n: string }>`
    select count(*)::text as n from installations
    where id = ${id} and deleted_at is null and suspended_at is null
      and (permissions_read_at is null or permissions_read_at < ${ago(2 * DAY_MS)})`.execute(db);
  if (num(unread.rows[0]?.n) > 0) {
    add(
      "permissions",
      "WARN",
      `permissions not read in the last 48 h (run pnpm graft mode refresh-permissions --installation ${id})`,
    );
  } else add("permissions", "OK", "permissions were read in the last 48 h");

  // modes (Phase 1 step 1): a requested mode that is not effective, by reason
  const ceiling = await resolveCeiling(db, config);
  const notEffective = new Map<string, number>();
  let enforcingWithoutMembers = 0;
  for (const row of await listRepositoryModeRows(db, { installationId: id })) {
    const m = modesOf(row, ceiling.ceiling);
    if (m.policy.effective === "enforce" && !hasMembersRead(row.permissions)) {
      enforcingWithoutMembers++;
    }
    for (const s of [m.policy, m.guard, m.mcpWrite]) {
      if (s.requested !== s.effective) {
        notEffective.set(s.reason, (notEffective.get(s.reason) ?? 0) + 1);
      }
    }
  }
  if (notEffective.size > 0) {
    const total = [...notEffective.values()].reduce((a, b) => a + b, 0);
    const byReason = [...notEffective]
      .map(([reason, n]) => `${reason} ${n}`)
      .sort()
      .join(", ");
    add("modes", "WARN", `${total} requested modes are not effective: ${byReason}`);
  } else add("modes", "OK", "every requested mode is effective");

  // teams (Phase 1 step 2, T10): enforcing without members:read fails every team constraint
  if (enforcingWithoutMembers > 0) {
    add(
      "teams",
      "WARN",
      `${enforcingWithoutMembers} repositories enforcing policy without members:read (team constraints will fail)`,
    );
  } else add("teams", "OK", "no repository enforces policy without members:read");

  // break_glass (Phase 1 step 3, T7): every bypass in the last 7 days, so operators notice them
  const bypasses = await countAppliedSince(db, id, ago(7 * DAY_MS));
  if (bypasses.length > 0) {
    const total = bypasses.reduce((n, b) => n + b.n, 0);
    add(
      "break_glass",
      "WARN",
      `break-glass applied in the last 7 days: ${total} (${bypasses.map((b) => `${b.fullName} ${b.n}`).join(", ")})`,
    );
  } else add("break_glass", "OK", "no break-glass applied in the last 7 days");

  // guard (Phase 1 step 4, T10): without statuses:read the guard reads check runs only
  const perms = await db
    .selectFrom("installations")
    .select(["permissions", "permissions_read_at"])
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (perms && !hasStatusesRead(perms.permissions_read_at === null ? null : perms.permissions)) {
    add(
      "guard_statuses",
      "WARN",
      "installation without statuses:read (guard reads check runs only)",
    );
  } else add("guard_statuses", "OK", "the guard can read commit statuses");

  // guard (Phase 1 step 4, T10): events still confirming past twice the window
  const stuck = await sql<{ n: string }>`
    select count(*)::text as n from guard_events
    where repository_id in (select id from repositories where installation_id = ${id})
      and status = 'confirming'
      and coalesce(detected_at, created_at) < ${ago(2 * config.guardConfirmSeconds * 1000)}`.execute(
    db,
  );
  const nStuck = num(stuck.rows[0]?.n);
  if (nStuck > 0) {
    add(
      "guard_confirming",
      "WARN",
      `${nStuck} guard events stuck in confirming past twice the window`,
    );
  } else add("guard_confirming", "OK", "no guard event is stuck in confirming");

  // guard (Phase 1 step 5, §13): revert PRs nobody has merged or closed
  const stale = await sql<{ n: string }>`
    select count(*)::text as n from guard_events
    where repository_id in (select id from repositories where installation_id = ${id})
      and status = 'revert_opened'
      and coalesce(revert_claimed_at, updated_at) < ${ago(72 * 3600_000)}`.execute(db);
  const nStale = num(stale.rows[0]?.n);
  if (nStale > 0) {
    add("guard_reverts_open", "WARN", `${nStale} revert PRs open for more than 72 hours`);
  } else add("guard_reverts_open", "OK", "no revert PR open for more than 72 hours");

  // guard (Phase 1 step 5, §13): revert jobs that ended in error
  const errors = await sql<{ n: string }>`
    select count(*)::text as n from guard_events
    where repository_id in (select id from repositories where installation_id = ${id})
      and revert_outcome = 'error'
      and updated_at >= ${ago(7 * DAY_MS)}`.execute(db);
  const nErrors = num(errors.rows[0]?.n);
  if (nErrors > 0) {
    add(
      "guard_revert_errors",
      "WARN",
      `${nErrors} guard events with revert outcome error in the last 7 days`,
    );
  } else add("guard_revert_errors", "OK", "no guard revert ended in error in the last 7 days");
  return checks;
}

export const doctorFailed = (checks: readonly Check[]): boolean =>
  checks.some((c) => c.status === "FAIL");
