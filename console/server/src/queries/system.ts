import { sql } from "kysely";
import type { SystemResponse } from "../../../shared/api.js";
import type { Db } from "../db.js";

export async function system(
  db: Db,
  opts: { hours: number; pgboss: boolean; version: string; dailyTokenBudget: number; now: Date },
): Promise<SystemResponse> {
  const hours = opts.hours;
  const now = opts.now;

  const migration = await sql<{ name: string }>`
    select name from kysely_migration order by name desc limit 1`
    .execute(db)
    .catch(() => ({ rows: [] as { name: string }[] }));

  let jobs: SystemResponse["jobs"] = null;
  let jobsUnavailable: string | null = null;
  if (opts.pgboss) {
    const r = await sql<{
      name: string;
      completed: number;
      failed: number;
      active: number;
      waiting: number;
      oldest: number | null;
    }>`
      select name,
             count(*) filter (where state = 'completed')::int as completed,
             count(*) filter (where state = 'failed')::int as failed,
             count(*) filter (where state = 'active')::int as active,
             count(*) filter (where state in ('created', 'retry'))::int as waiting,
             extract(epoch from ${now}::timestamptz - min(created_on)
               filter (where state in ('created', 'retry') and start_after <= ${now}::timestamptz))::int as oldest
        from pgboss.job
       where created_on > ${now}::timestamptz - make_interval(hours => ${hours})
          or state in ('created', 'retry', 'active')
       group by name
       order by count(*) desc, name`.execute(db);
    jobs = r.rows.map((j) => ({
      name: j.name,
      completed: j.completed,
      failed: j.failed,
      active: j.active,
      waiting: j.waiting,
      oldestWaitingSeconds: j.oldest,
    }));
  } else {
    jobsUnavailable =
      "The console's role cannot read the pgboss schema, or Graft's worker has never started. Re-run console/sql/readonly-role.sql after the worker's first start.";
  }

  const webhooks = await sql<{ event: string; status: "enqueued" | "ignored"; n: number }>`
    select event, status, count(*)::int as n from webhook_deliveries
     where received_at > ${now}::timestamptz - make_interval(hours => ${hours})
     group by 1, 2 order by 3 desc`.execute(db);

  const modeChanges = await db
    .selectFrom("mode_changes as m")
    .innerJoin("repositories as r", "r.id", "m.repository_id")
    .select([
      "m.created_at",
      "r.full_name",
      "m.key",
      "m.from_value",
      "m.to_value",
      "m.actor",
      "m.applied_at",
    ])
    .orderBy("m.created_at", "desc")
    .limit(20)
    .execute();

  const audit = await db
    .selectFrom("audit_log as a")
    .innerJoin("repositories as r", "r.id", "a.repository_id")
    .select(["a.created_at", "r.full_name", "a.pr_number", "a.kind", "a.reason", "a.actor_login"])
    .orderBy("a.created_at", "desc")
    .limit(20)
    .execute();

  // The token hash is never selected: the console shows which tokens exist, not what they are.
  const tokens = await db
    .selectFrom("mcp_tokens as t")
    .innerJoin("repositories as r", "r.id", "t.repository_id")
    .select([
      "t.id",
      "r.full_name",
      "t.name",
      "t.token_prefix",
      "t.created_by",
      "t.created_at",
      "t.expires_at",
      "t.last_used_at",
      "t.revoked_at",
    ])
    .orderBy("t.created_at", "desc")
    .limit(50)
    .execute();

  const purges = await db
    .selectFrom("pilot_purges")
    .select(["purged_at", "installation_id", "rows_deleted"])
    .orderBy("purged_at", "desc")
    .limit(10)
    .execute();

  return {
    hours,
    schemaVersion: migration.rows[0]?.name ?? null,
    jobs,
    jobsUnavailable,
    webhooks: webhooks.rows.map((w) => ({ event: w.event, status: w.status, count: w.n })),
    modeChanges: modeChanges.map((m) => ({
      at: m.created_at.toISOString(),
      repo: m.full_name,
      key: m.key,
      from: m.from_value,
      to: m.to_value,
      actor: m.actor,
      appliedAt: m.applied_at ? m.applied_at.toISOString() : null,
    })),
    audit: audit.map((a) => ({
      at: a.created_at.toISOString(),
      repo: a.full_name,
      prNumber: a.pr_number,
      kind: a.kind,
      reason: a.reason,
      actor: a.actor_login,
    })),
    mcpTokens: tokens.map((t) => ({
      id: t.id,
      repo: t.full_name,
      name: t.name,
      prefix: t.token_prefix,
      createdBy: t.created_by,
      createdAt: t.created_at.toISOString(),
      expiresAt: t.expires_at.toISOString(),
      lastUsedAt: t.last_used_at ? t.last_used_at.toISOString() : null,
      revokedAt: t.revoked_at ? t.revoked_at.toISOString() : null,
    })),
    purges: purges.map((p) => ({
      at: p.purged_at.toISOString(),
      installationId: p.installation_id,
      rows: Object.values(p.rows_deleted ?? {}).reduce((a, b) => a + Number(b), 0),
    })),
    console: { version: opts.version, readOnly: true, dailyTokenBudget: opts.dailyTokenBudget },
  };
}
