import { sql } from "kysely";
import type {
  AuditEntry,
  CardVersion,
  ChangeEntry,
  Entry,
  GuardEntry,
  ModeEntry,
  PolicyOutcome,
  RiskClass,
  VerifierStatus,
} from "../../../shared/api.js";
import type { Db } from "../db.js";
import { windowSql } from "./days.js";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

interface CardRow {
  id: string;
  change_id: string;
  created_at: Date;
  head_sha: string;
  status: "ok" | "unavailable";
  failure_reason: string | null;
  risk_class: RiskClass;
  risk_floor: RiskClass;
  verifier_status: VerifierStatus;
  goal: string | null;
  missing: number;
  unexplained: number;
  files_total: number;
  lines_added: number;
  lines_deleted: number;
}

/** Everything Graft did on one local date: one entry per PR, guard event, break-glass and mode change. */
export async function dayEntries(db: Db, tz: string, date: string): Promise<Entry[]> {
  const cards = await sql<CardRow>`
    with b as (${windowSql(tz, date, date)})
    select ic.id, ic.change_id, ic.created_at, ic.head_sha, ic.status, ic.failure_reason,
           ic.risk_class, ic.risk_floor, ic.verifier_status, ic.goal,
           jsonb_array_length(ic.verifier_missing)::int as missing,
           jsonb_array_length(ic.verifier_unexplained)::int as unexplained,
           ic.files_total, ic.lines_added, ic.lines_deleted
      from intent_cards ic, b
     where ic.created_at >= b.lo and ic.created_at < b.hi
     order by ic.created_at, ic.id`.execute(db);

  const byChange = new Map<string, CardRow[]>();
  for (const c of cards.rows) {
    const list = byChange.get(c.change_id) ?? [];
    list.push(c);
    byChange.set(c.change_id, list);
  }
  const cardIds = [...byChange.keys()];

  // PRs with a card that day, plus PRs opened or merged that day without one.
  const changes = await sql<{
    id: string;
    repo: string;
    pr_number: number;
    state: "open" | "closed" | "merged";
    opened_at: Date;
    merged_at: Date | null;
    author_kind: "agent" | "human" | null;
    outcome: PolicyOutcome | null;
    guard_status: string | null;
    last_goal: string | null;
    merged_in_day: boolean | null;
  }>`
    with b as (${windowSql(tz, date, date)})
    select ch.id, r.full_name as repo, ch.pr_number, ch.state, ch.opened_at, ch.merged_at,
           cp.author_kind, pv.outcome, ge.status as guard_status, lc.goal as last_goal,
           (ch.merged_at >= b.lo and ch.merged_at < b.hi) as merged_in_day
      from changes ch
      join repositories r on r.id = ch.repository_id
      cross join b
      left join change_provenance cp on cp.change_id = ch.id
      left join lateral (select outcome from policy_verdicts p where p.change_id = ch.id
                          order by evaluated_at desc limit 1) pv on true
      left join lateral (select status from guard_events g where g.culprit_change_id = ch.id
                          order by created_at desc limit 1) ge on true
      left join lateral (select goal from intent_cards i where i.change_id = ch.id and i.goal is not null
                          order by created_at desc limit 1) lc on true
     where ch.id = any(${cardIds}::uuid[])
        or (ch.opened_at >= b.lo and ch.opened_at < b.hi)
        or (ch.merged_at >= b.lo and ch.merged_at < b.hi)`.execute(db);

  const entries: Entry[] = [];

  for (const ch of changes.rows) {
    const list = byChange.get(ch.id) ?? [];
    const last = list.at(-1);
    const versions: CardVersion[] = list.map((c) => ({
      id: c.id,
      at: c.created_at.toISOString(),
      headSha: c.head_sha,
      status: c.status,
      failureReason: c.failure_reason,
      riskClass: c.risk_class,
      riskFloor: c.risk_floor,
      verifierStatus: c.verifier_status,
    }));
    const first =
      list[0]?.created_at ?? (ch.merged_in_day && ch.merged_at ? ch.merged_at : ch.opened_at);
    const entry: ChangeEntry = {
      kind: "change",
      at: first.toISOString(),
      changeId: ch.id,
      repo: ch.repo,
      prNumber: ch.pr_number,
      state: ch.state,
      mergedAt: iso(ch.merged_at),
      goal: last?.goal ?? ch.last_goal,
      card: last
        ? {
            status: last.status,
            failureReason: last.failure_reason,
            riskClass: last.risk_class,
            riskFloor: last.risk_floor,
            verifierStatus: last.verifier_status,
            verifierMissing: last.missing,
            verifierUnexplained: last.unexplained,
            filesTotal: last.files_total,
            linesAdded: last.lines_added,
            linesDeleted: last.lines_deleted,
          }
        : null,
      versions,
      policyOutcome: ch.outcome,
      guardStatus: ch.guard_status,
      authorKind: ch.author_kind,
    };
    entries.push(entry);
  }

  const guards = await sql<{
    id: string;
    created_at: Date;
    repo: string;
    branch: string;
    status: string;
    failing_sha: string;
    culprit_pr: number | null;
    failing_checks: { name?: unknown }[];
    revert_outcome: string | null;
    revert_reason: string | null;
    revert_pr_number: number | null;
    ci_run_url: string | null;
  }>`
    with b as (${windowSql(tz, date, date)})
    select g.id, g.created_at, r.full_name as repo, g.branch, g.status, g.failing_sha,
           ch.pr_number as culprit_pr, g.failing_checks, g.revert_outcome, g.revert_reason,
           g.revert_pr_number, g.ci_run_url
      from guard_events g join repositories r on r.id = g.repository_id
      left join changes ch on ch.id = g.culprit_change_id, b
     where g.created_at >= b.lo and g.created_at < b.hi`.execute(db);
  for (const g of guards.rows) {
    const e: GuardEntry = {
      kind: "guard",
      at: g.created_at.toISOString(),
      eventId: g.id,
      repo: g.repo,
      branch: g.branch,
      status: g.status,
      failingSha: g.failing_sha,
      culpritPr: g.culprit_pr,
      failingChecks: (g.failing_checks ?? [])
        .map((c) => (typeof c.name === "string" ? c.name : ""))
        .filter((n) => n !== ""),
      revertOutcome: g.revert_outcome,
      revertReason: g.revert_reason,
      revertPr: g.revert_pr_number,
      ciRunUrl: g.ci_run_url,
    };
    entries.push(e);
  }

  const audit = await sql<{
    created_at: Date;
    repo: string;
    pr_number: number;
    kind: AuditEntry["auditKind"];
    reason: string | null;
    actor_login: string | null;
  }>`
    with b as (${windowSql(tz, date, date)})
    select a.created_at, r.full_name as repo, a.pr_number, a.kind, a.reason, a.actor_login
      from audit_log a join repositories r on r.id = a.repository_id, b
     where a.created_at >= b.lo and a.created_at < b.hi`.execute(db);
  for (const a of audit.rows) {
    entries.push({
      kind: "break_glass",
      at: a.created_at.toISOString(),
      repo: a.repo,
      prNumber: a.pr_number,
      auditKind: a.kind,
      reason: a.reason,
      actor: a.actor_login,
    });
  }

  const modes = await sql<{
    created_at: Date;
    repo: string;
    key: string;
    from_value: string;
    to_value: string;
    actor: string;
    applied_at: Date | null;
  }>`
    with b as (${windowSql(tz, date, date)})
    select m.created_at, r.full_name as repo, m.key, m.from_value, m.to_value, m.actor, m.applied_at
      from mode_changes m join repositories r on r.id = m.repository_id, b
     where m.created_at >= b.lo and m.created_at < b.hi`.execute(db);
  for (const m of modes.rows) {
    const e: ModeEntry = {
      kind: "mode",
      at: m.created_at.toISOString(),
      repo: m.repo,
      key: m.key,
      from: m.from_value,
      to: m.to_value,
      actor: m.actor,
      applied: m.applied_at !== null,
    };
    entries.push(e);
  }

  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
