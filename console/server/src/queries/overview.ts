import { sql } from "kysely";
import type { Attention, BudgetRepo, GateStats, OverviewResponse } from "../../../shared/api.js";
import type { Db } from "../db.js";
import { addDays, dateIn, wilson } from "../time.js";

const GATE_TARGET = 0.9;
const GUARD_WINDOW_DAYS = 14;
const POLICY_WINDOW_DAYS = 7;
const MODE_APPLY_GRACE_MIN = 10;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function overview(
  db: Db,
  opts: { dailyTokenBudget: number; pgboss: boolean; now?: Date },
): Promise<OverviewResponse> {
  const now = opts.now ?? new Date();

  const installations = await db
    .selectFrom("installations")
    .select([
      "id",
      "account_login",
      "account_type",
      "repository_selection",
      "suspended_at",
      "permissions_read_at",
    ])
    .where("deleted_at", "is", null)
    .orderBy("id")
    .execute();

  const repositories = await db
    .selectFrom("repositories")
    .select(["id", "full_name", "policy_mode", "guard_mode", "mcp_write", "removed_at"])
    .orderBy("full_name")
    .execute();

  const ceiling = await db
    .selectFrom("service_state")
    .select(["value", "updated_at"])
    .where("key", "=", "mode_ceiling")
    .executeTakeFirst();

  const gate = await gateStats(db);
  const attention = await attentionItems(db, { now, gate, pgboss: opts.pgboss });

  const t = await sql<{
    cards: number;
    unavailable: number;
    budget: number;
    agree: number;
    judged: number;
    raised: number;
  }>`
    select count(*)::int as cards,
           count(*) filter (where status = 'unavailable')::int as unavailable,
           count(*) filter (where failure_reason = 'budget_exceeded')::int as budget,
           count(*) filter (where status = 'ok' and verifier_status = 'agree')::int as agree,
           count(*) filter (where status = 'ok' and verifier_status in ('agree', 'disagree'))::int as judged,
           count(*) filter (where status = 'ok' and risk_class <> risk_floor)::int as raised
      from intent_cards`.execute(db);
  const spend = await sql<{ cost: number; runs: number }>`
    select coalesce(sum(cost_usd), 0)::numeric as cost, count(*)::int as runs from intent_spend`.execute(
    db,
  );
  const tr = t.rows[0];
  const sr = spend.rows[0];

  return {
    installations: installations.map((i) => ({
      id: i.id,
      login: i.account_login,
      type: i.account_type,
      selection: i.repository_selection,
      suspended: i.suspended_at !== null,
      permissionsReadAt: iso(i.permissions_read_at),
    })),
    repositories: repositories.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      policyMode: r.policy_mode,
      guardMode: r.guard_mode,
      mcpWrite: r.mcp_write,
      removed: r.removed_at !== null,
    })),
    ceiling: ceiling ? { value: ceiling.value, updatedAt: ceiling.updated_at.toISOString() } : null,
    attention,
    totals: {
      cards: tr?.cards ?? 0,
      cardsUnavailable: tr?.unavailable ?? 0,
      cardsBudget: tr?.budget ?? 0,
      verifierAgree: tr?.agree ?? 0,
      verifierJudged: tr?.judged ?? 0,
      raised: tr?.raised ?? 0,
      costUsd: Number(sr?.cost ?? 0),
      spendRuns: sr?.runs ?? 0,
    },
    budget: await budget(db, opts.dailyTokenBudget, now),
    gate,
  };
}

/**
 * Card votes, split the way the Phase 0 gate splits them: a vote by the PR's author never counts.
 * This is a preview; `graft gate report` applies every rule of the gate and is authoritative.
 */
export async function gateStats(db: Db): Promise<GateStats> {
  const r = await sql<{ votes: number; author: number; up: number; down: number }>`
    select count(*)::int as votes,
           count(*) filter (where f.is_pr_author or f.user_id = c.author_id)::int as author,
           count(*) filter (where not (f.is_pr_author or f.user_id is not distinct from c.author_id)
                              and f.verdict = 'up')::int as up,
           count(*) filter (where not (f.is_pr_author or f.user_id is not distinct from c.author_id)
                              and f.verdict = 'down')::int as down
      from intent_feedback f join changes c on c.id = f.change_id`.execute(db);
  const x = r.rows[0] ?? { votes: 0, author: 0, up: 0, down: 0 };
  return {
    votes: x.votes,
    authorVotes: x.author,
    eligibleUp: x.up,
    eligibleDown: x.down,
    interval: wilson(x.up, x.up + x.down),
    target: GATE_TARGET,
  };
}

/** Today's tokens per repository against Graft's per-repository UTC-day budget, and the last week. */
async function budget(db: Db, perDay: number, now: Date): Promise<BudgetRepo[]> {
  const today = dateIn("UTC", now);
  const from = addDays(today, -6);
  const r = await sql<{ repo: string; day: string; tokens: number; skipped: number }>`
    with d as (select generate_series(${from}::date, ${today}::date, interval '1 day')::date as day),
    rr as (select id, full_name from repositories where removed_at is null),
    s as (select repository_id, (spent_at at time zone 'UTC')::date as day, sum(tokens)::bigint as tokens
            from intent_spend where spent_at >= ${from}::date::timestamp at time zone 'UTC'
           group by 1, 2),
    k as (select c.repository_id, (ic.created_at at time zone 'UTC')::date as day, count(*)::int as n
            from intent_cards ic join changes c on c.id = ic.change_id
           where ic.failure_reason = 'budget_exceeded'
             and ic.created_at >= ${from}::date::timestamp at time zone 'UTC'
           group by 1, 2)
    select rr.full_name as repo, d.day::text as day, coalesce(s.tokens, 0) as tokens,
           coalesce(k.n, 0) as skipped
      from rr cross join d
      left join s on s.repository_id = rr.id and s.day = d.day
      left join k on k.repository_id = rr.id and k.day = d.day
     order by rr.full_name, d.day`.execute(db);
  const byRepo = new Map<string, BudgetRepo>();
  for (const row of r.rows) {
    const b = byRepo.get(row.repo) ?? { repo: row.repo, todayTokens: 0, budget: perDay, days: [] };
    const tokens = Number(row.tokens);
    b.days.push({ date: row.day, tokens, skipped: row.skipped });
    if (row.day === today) b.todayTokens = tokens;
    byRepo.set(row.repo, b);
  }
  return [...byRepo.values()].sort((a, b) => b.todayTokens - a.todayTokens);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function attentionItems(
  db: Db,
  ctx: { now: Date; gate: GateStats; pgboss: boolean },
): Promise<Attention[]> {
  const items: Attention[] = [];

  const guards = await sql<{
    id: string;
    repo: string;
    branch: string;
    status: string;
    created_at: Date;
    failing_sha: string;
    culprit_pr: number | null;
    revert_reason: string | null;
    revert_pr_number: number | null;
    ci_run_url: string | null;
    checks: string | null;
  }>`
    select g.id, r.full_name as repo, g.branch, g.status, g.created_at, g.failing_sha,
           ch.pr_number as culprit_pr, g.revert_reason, g.revert_pr_number, g.ci_run_url,
           (select string_agg(x->>'name', ', ') from jsonb_array_elements(g.failing_checks) x) as checks
      from guard_events g join repositories r on r.id = g.repository_id
      left join changes ch on ch.id = g.culprit_change_id
     where g.status in ('detected', 'confirming', 'culprit_found', 'ambiguous', 'needs_human',
                        'revert_opened', 'error')
       and g.created_at > ${ctx.now}::timestamptz - make_interval(days => ${GUARD_WINDOW_DAYS})
     order by g.created_at desc`.execute(db);
  for (const g of guards.rows) {
    const act = ["needs_human", "ambiguous", "error"].includes(g.status);
    const after = g.culprit_pr ? ` after #${g.culprit_pr}` : "";
    const checks = g.checks ? `${g.checks} went red` : "A required check went red";
    const sha = g.failing_sha.slice(0, 7);
    const titles: Record<string, string> = {
      needs_human: `The guard stopped on ${g.branch} and wants a human`,
      ambiguous: `The guard could not name one culprit on ${g.branch}`,
      error: `The guard failed while handling ${g.branch}`,
      revert_opened: `A revert PR is open for ${g.branch}`,
      culprit_found: `The guard named a culprit on ${g.branch}`,
    };
    const reason = g.revert_reason ? ` Reason: ${g.revert_reason}.` : "";
    items.push({
      id: `guard:${g.id}`,
      kind: "guard",
      severity: act ? "act" : "watch",
      at: g.created_at.toISOString(),
      title: titles[g.status] ?? `The guard is checking ${g.branch}`,
      detail:
        g.status === "revert_opened" && g.revert_pr_number
          ? `${checks} at ${sha}${after}. Revert PR #${g.revert_pr_number} is waiting for review.`
          : `${checks} at ${sha}${after}. Status ${g.status}.${reason}`,
      command: `pnpm graft guard list --repo ${g.repo}`,
      link: g.ci_run_url,
      repo: g.repo,
    });
  }

  const invalid = await sql<{ repo: string; n: number; last_pr: number; last_at: Date }>`
    with latest as (
      select distinct on (p.change_id) p.change_id, p.policy_status, p.evaluated_at
        from policy_verdicts p order by p.change_id, p.evaluated_at desc)
    select r.full_name as repo, count(*)::int as n,
           (array_agg(c.pr_number order by l.evaluated_at desc))[1] as last_pr,
           max(l.evaluated_at) as last_at
      from latest l join changes c on c.id = l.change_id
      join repositories r on r.id = c.repository_id
     where l.policy_status = 'invalid'
       and (c.state = 'open' or c.merged_at > ${ctx.now}::timestamptz - make_interval(days => ${POLICY_WINDOW_DAYS}))
     group by r.full_name`.execute(db);
  for (const p of invalid.rows) {
    items.push({
      id: `policy:${p.repo}`,
      kind: "policy",
      severity: "act",
      at: p.last_at.toISOString(),
      title: `graft.yaml is invalid on ${p.repo.split("/")[1] ?? p.repo}`,
      detail: `${plural(p.n, "pull request")} got a policy invalid verdict, so no rule ran on ${p.n === 1 ? "it" : "them"} (latest #${p.last_pr}). Check the base branch's graft.yaml.`,
      command: "pnpm graft policy check graft.yaml",
      link: null,
      repo: p.repo,
    });
  }

  const skipped = await sql<{ repo: string; reason: string; n: number; first_at: Date }>`
    select r.full_name as repo, ic.failure_reason as reason, count(*)::int as n,
           min(ic.created_at) as first_at
      from intent_cards ic join changes c on c.id = ic.change_id
      join repositories r on r.id = c.repository_id
     where ic.status = 'unavailable' and ic.created_at > ${ctx.now}::timestamptz - interval '24 hours'
     group by 1, 2 order by 3 desc`.execute(db);
  for (const s of skipped.rows) {
    const budget = s.reason === "budget_exceeded";
    items.push({
      id: `${budget ? "budget" : "llm"}:${s.repo}:${s.reason}`,
      kind: budget ? "budget" : "llm",
      severity: "act",
      at: s.first_at.toISOString(),
      title: budget
        ? `${plural(s.n, "card")} not written: the token budget ran out`
        : `${plural(s.n, "card")} not written: ${s.reason.replaceAll("_", " ")}`,
      detail: budget
        ? `On ${s.repo} since ${s.first_at.toISOString().slice(11, 16)} UTC. Policy fell back to the rules floor. Raise GRAFT_LLM_DAILY_TOKEN_BUDGET or wait for the next UTC day.`
        : `On ${s.repo} in the last 24 hours. The checks said the card was unavailable.`,
      command: null,
      link: null,
      repo: s.repo,
    });
  }

  const g = ctx.gate;
  if (g.votes > 0 && g.eligibleUp + g.eligibleDown === 0) {
    items.push({
      id: "gate:author-only",
      kind: "gate",
      severity: "watch",
      at: null,
      title: "No vote counts toward the gate yet",
      detail: `All ${plural(g.votes, "card vote")} came from the PR's own author, and the gate drops those. Ask a second reviewer to react on cards.`,
      command: "pnpm graft gate report --phase 0",
      link: null,
      repo: null,
    });
  }

  const inst = await db
    .selectFrom("installations")
    .select(["id", "account_login", "suspended_at", "permissions_read_at"])
    .where("deleted_at", "is", null)
    .where((eb) =>
      eb.or([eb("suspended_at", "is not", null), eb("permissions_read_at", "is", null)]),
    )
    .execute();
  for (const i of inst) {
    items.push({
      id: `installation:${i.id}`,
      kind: "installation",
      severity: i.suspended_at ? "act" : "watch",
      at: i.suspended_at ? i.suspended_at.toISOString() : null,
      title: i.suspended_at
        ? `The installation on ${i.account_login} is suspended`
        : `Graft has not read its permissions on ${i.account_login}`,
      detail: i.suspended_at
        ? "Graft does nothing on its repositories until it is unsuspended."
        : "Enforce mode treats unknown permissions as missing.",
      command: `pnpm graft mode refresh-permissions --installation ${i.id}`,
      link: null,
      repo: null,
    });
  }

  const pending = await sql<{ repo: string; n: number; first_at: Date }>`
    select r.full_name as repo, count(*)::int as n, min(m.created_at) as first_at
      from mode_changes m join repositories r on r.id = m.repository_id
     where m.applied_at is null and m.created_at < ${ctx.now}::timestamptz - make_interval(mins => ${MODE_APPLY_GRACE_MIN})
     group by 1`.execute(db);
  for (const m of pending.rows) {
    items.push({
      id: `mode:${m.repo}`,
      kind: "mode",
      severity: "act",
      at: m.first_at.toISOString(),
      title: `A mode change on ${m.repo} has not been applied`,
      detail: `${plural(m.n, "change")} still waiting for the worker's modes.apply job. Is the worker running?`,
      command: `pnpm graft mode history --repo ${m.repo}`,
      link: null,
      repo: m.repo,
    });
  }

  if (ctx.pgboss) {
    const failed = await sql<{ name: string; n: number; last_at: Date }>`
      select name, count(*)::int as n, max(coalesce(completed_on, created_on)) as last_at
        from pgboss.job where state = 'failed' and created_on > ${ctx.now}::timestamptz - interval '24 hours'
       group by name order by 2 desc`.execute(db);
    for (const j of failed.rows) {
      items.push({
        id: `jobs:${j.name}`,
        kind: "jobs",
        severity: "act",
        at: j.last_at.toISOString(),
        title: `${plural(j.n, "job")} failed: ${j.name}`,
        detail: "In the last 24 hours. The worker's logs have the error.",
        command: null,
        link: null,
        repo: null,
      });
    }
  }

  const rank = (a: Attention) => (a.severity === "act" ? 0 : 1);
  return items.sort((a, b) => rank(a) - rank(b) || (b.at ?? "").localeCompare(a.at ?? ""));
}
