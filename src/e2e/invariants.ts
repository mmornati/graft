/**
 * System invariants (§7), checked after every scenario. Each returns `{ id, status, detail }`;
 * details hold counts, table and column names, ids and check names, never values of PR text.
 */
import { readFile } from "node:fs/promises";
import { sql } from "kysely";
import type { Db } from "../db/client.js";
import {
  type CheckObs,
  changeRow,
  commentObs,
  GRAFT_CHECKS,
  graftChecks,
  prComments,
} from "./observe.js";
import type { InvariantResult } from "./report-schema.js";
import type { SecretRegistry } from "./secrets.js";
import { SENTINEL_RE } from "./sentinels.js";
import type { LlmMode, RunCtx } from "./types.js";

const ok = (id: string, detail: string): InvariantResult => ({ id, status: "pass", detail });
const bad = (id: string, detail: string): InvariantResult => ({ id, status: "fail", detail });

// ---------------------------------------------------------------------------------------------
// INV-1: three neutral checks
// ---------------------------------------------------------------------------------------------

export function evaluateInv1(
  perPr: readonly { number: number; checks: CheckObs[] }[],
): InvariantResult {
  const problems: string[] = [];
  for (const pr of perPr) {
    const names = new Set(pr.checks.map((c) => c.name));
    const missing = GRAFT_CHECKS.filter((n) => !names.has(n));
    if (pr.checks.length < 3 || missing.length > 0) {
      problems.push(
        `PR #${pr.number}: ${pr.checks.length} Graft check runs, missing ${missing.join(", ") || "none"}`,
      );
    }
    for (const c of pr.checks) {
      if (c.status !== "completed" || c.conclusion !== "neutral") {
        problems.push(`PR #${pr.number}: ${c.name} is ${c.status}/${c.conclusion ?? "none"}`);
      }
    }
  }
  return problems.length === 0
    ? ok("INV-1", `${perPr.length} open PRs: all Graft checks completed and neutral`)
    : bad("INV-1", problems.join("; "));
}

export async function inv1(ctx: RunCtx, prNumbers: readonly number[]): Promise<InvariantResult> {
  const perPr: { number: number; checks: CheckObs[] }[] = [];
  for (const n of prNumbers) {
    const { data: pull } = await ctx.actorOctokit.rest.pulls.get({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: n,
    });
    if (pull.state !== "open") continue;
    perPr.push({ number: n, checks: await graftChecks(ctx, pull.head.sha) });
  }
  return evaluateInv1(perPr);
}

// ---------------------------------------------------------------------------------------------
// INV-1E: an enforce sandbox (Phase 1 step 7, D21)
// ---------------------------------------------------------------------------------------------

/**
 * Replaces INV-1 for an `enforce` sandbox: every Graft check on the current head of every open run
 * PR is completed; `graft/provenance` and `graft/intent` are `neutral`; `graft/policy` is `success`
 * or `failure`, equal to the scenario's last expectation for that PR (a PR with no expectation
 * fails: the policy check must have been judged).
 */
export function evaluateInv1E(
  perPr: readonly { number: number; checks: CheckObs[]; expected: string | undefined }[],
): InvariantResult {
  const problems: string[] = [];
  for (const pr of perPr) {
    const names = new Set(pr.checks.map((c) => c.name));
    const missing = GRAFT_CHECKS.filter((n) => !names.has(n));
    if (missing.length > 0) problems.push(`PR #${pr.number}: missing ${missing.join(", ")}`);
    for (const c of pr.checks) {
      if (c.status !== "completed") {
        problems.push(`PR #${pr.number}: ${c.name} is ${c.status}`);
        continue;
      }
      if (c.name === POLICY_CHECK) {
        if (c.conclusion !== "success" && c.conclusion !== "failure") {
          problems.push(
            `PR #${pr.number}: ${c.name} is ${c.conclusion ?? "none"}, not success or failure`,
          );
        } else if (c.conclusion !== pr.expected) {
          problems.push(
            `PR #${pr.number}: ${c.name} is ${c.conclusion}, the scenario expected ${pr.expected ?? "nothing"}`,
          );
        }
      } else if (c.conclusion !== "neutral") {
        problems.push(`PR #${pr.number}: ${c.name} is ${c.conclusion ?? "none"}, not neutral`);
      }
    }
  }
  return problems.length === 0
    ? ok("INV-1E", `${perPr.length} open PRs: checks completed, policy as expected, others neutral`)
    : bad("INV-1E", problems.join("; "));
}

const POLICY_CHECK = GRAFT_CHECKS[2];

export async function inv1e(
  ctx: RunCtx,
  prNumbers: readonly number[],
  expected: Readonly<Record<string, string>>,
): Promise<InvariantResult> {
  const perPr: { number: number; checks: CheckObs[]; expected: string | undefined }[] = [];
  for (const n of prNumbers) {
    const { data: pull } = await ctx.actorOctokit.rest.pulls.get({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: n,
    });
    if (pull.state !== "open") continue;
    perPr.push({
      number: n,
      checks: await graftChecks(ctx, pull.head.sha),
      expected: expected[String(n)],
    });
  }
  return evaluateInv1E(perPr);
}

// ---------------------------------------------------------------------------------------------
// INV-2: one Graft comment per PR
// ---------------------------------------------------------------------------------------------

export function evaluateInv2(
  perPr: readonly { number: number; ours: number[]; storedId: number | null }[],
): InvariantResult {
  const problems: string[] = [];
  for (const pr of perPr) {
    if (pr.ours.length !== 1) problems.push(`PR #${pr.number}: ${pr.ours.length} Graft comments`);
    else if (pr.ours[0] !== pr.storedId)
      problems.push(`PR #${pr.number}: comment id differs from changes.graft_comment_id`);
  }
  return problems.length === 0
    ? ok("INV-2", `${perPr.length} PRs: exactly one Graft comment each`)
    : bad("INV-2", problems.join("; "));
}

export async function inv2(ctx: RunCtx, prNumbers: readonly number[]): Promise<InvariantResult> {
  const perPr: { number: number; ours: number[]; storedId: number | null }[] = [];
  for (const n of prNumbers) {
    const ch = await changeRow(ctx, n);
    const comments = await prComments(ctx, n);
    const obs = commentObs(comments, {
      appId: ctx.config.githubAppId,
      slug: ctx.config.githubAppSlug,
      knownId: ch?.graft_comment_id ?? null,
      owner: ctx.owner,
    });
    perPr.push({ number: n, ours: obs.ours, storedId: ch?.graft_comment_id ?? null });
  }
  return evaluateInv2(perPr);
}

// ---------------------------------------------------------------------------------------------
// INV-3: sentinel scan
// ---------------------------------------------------------------------------------------------

export const ECHO_KEYS = new Set([
  "goal",
  "behavior_changes",
  "out_of_scope_edits",
  "model_risk_reason",
  "verifier_claims",
  "verifier_missing",
  "verifier_unexplained",
]);

export interface RawHit {
  table: string;
  key: string;
  sentinel: string;
  /** pg-boss job columns, when the table is the job table. */
  job?: { name: string; state: string; completedOn: Date | null };
}

export interface ClassifiedHit {
  /** The planted sentinel (internal: never written to a report). */
  sentinel: string;
  kind: string;
  table: string;
  key: string;
  class: "echo" | "accounted" | "fail";
  deadline?: string;
}

const HOUR_MS = 3_600_000;

export function classifyHit(
  hit: RawHit,
  o: { now: Date; pgbossSchema: string; afterRetention: boolean },
): ClassifiedHit {
  const kind = hit.sentinel.slice(-1);
  const base = { sentinel: hit.sentinel, kind, table: hit.table, key: hit.key };
  if (hit.table === "intent_cards" && ECHO_KEYS.has(hit.key)) return { ...base, class: "echo" };
  if (hit.table === `${o.pgbossSchema}.job` && hit.job?.name === "github.webhook") {
    if (o.afterRetention) return { ...base, class: "fail" };
    const finished = hit.job.state === "completed" || hit.job.state === "failed";
    if (!finished) return { ...base, class: "accounted", deadline: "when the job finishes, +1 h" };
    const deadline = new Date((hit.job.completedOn?.getTime() ?? 0) + HOUR_MS);
    if (deadline.getTime() > o.now.getTime()) {
      return { ...base, class: "accounted", deadline: deadline.toISOString() };
    }
  }
  return { ...base, class: "fail" };
}

/**
 * Tables of schema `public` and the pg-boss schema, except the migration bookkeeping and
 * partitions (pg-boss 12 partitions its job table: the parent already reads them).
 */
export async function listScanTables(
  db: Db,
  pgbossSchema: string,
): Promise<{ schema: string; table: string }[]> {
  const res = await sql<{ schema: string; name: string }>`
    select n.nspname as schema, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and not c.relispartition
      and n.nspname in ('public', ${pgbossSchema})
      and c.relname not like 'kysely_migration%'
    order by n.nspname, c.relname`.execute(db);
  return res.rows.map((r) => ({ schema: r.schema, table: r.name }));
}

export async function scanSentinels(
  db: Db,
  o: { sentinels: readonly string[]; pgbossSchema: string },
): Promise<RawHit[]> {
  if (o.sentinels.length === 0) return [];
  const hits: RawHit[] = [];
  const tables = await listScanTables(db, o.pgbossSchema);
  for (const { schema, table } of tables) {
    const isJob = schema === o.pgbossSchema && table === "job";
    const rows = await sql<{
      key: string;
      sentinel: string;
      job_name: string | null;
      job_state: string | null;
      job_completed: Date | null;
    }>`
      select k.key as key, s.s as sentinel,
        ${isJob ? sql`t.name` : sql`null`} as job_name,
        ${isJob ? sql`t.state::text` : sql`null`} as job_state,
        ${isJob ? sql`t.completed_on` : sql`null`} as job_completed
      from ${sql.table(`${schema}.${table}`)} t,
        jsonb_each_text(to_jsonb(t)) k,
        unnest(${sql.val(o.sentinels as string[])}::text[]) s(s)
      where strpos(k.value, s.s) > 0`.execute(db);
    for (const r of rows.rows) {
      hits.push({
        table: schema === "public" ? table : `${schema}.${table}`,
        key: r.key,
        sentinel: r.sentinel,
        ...(isJob
          ? {
              job: {
                name: String(r.job_name),
                state: String(r.job_state),
                completedOn: r.job_completed,
              },
            }
          : {}),
      });
    }
  }
  return hits;
}

export async function scanLogFiles(
  files: readonly string[],
  o: { sentinels: readonly string[]; secrets: SecretRegistry },
): Promise<{ file: number; what: "sentinel" | "secret" }[]> {
  const out: { file: number; what: "sentinel" | "secret" }[] = [];
  for (const [i, f] of files.entries()) {
    let text: string;
    try {
      text = await readFile(f, "utf8");
    } catch {
      continue;
    }
    if (o.sentinels.some((s) => text.includes(s)) || new RegExp(SENTINEL_RE).test(text)) {
      out.push({ file: i, what: "sentinel" });
    }
    if (o.secrets.contains(text)) out.push({ file: i, what: "secret" });
  }
  return out;
}

export function summarizeInv3(
  hits: readonly ClassifiedHit[],
  logProblems: readonly { file: number; what: string }[] = [],
): InvariantResult {
  const count = (c: ClassifiedHit["class"]) => hits.filter((h) => h.class === c).length;
  const fails = hits.filter((h) => h.class === "fail");
  const parts = [
    `echo ${count("echo")}`,
    `accounted ${count("accounted")}`,
    `fail ${fails.length}`,
  ];
  const where = [...new Set(fails.map((h) => `${h.table}.${h.key}`))];
  if (logProblems.length > 0)
    parts.push(`log files with a sentinel or secret: ${logProblems.length}`);
  const detail = `${parts.join(", ")}${where.length > 0 ? `; ${where.join(", ")}` : ""}`;
  if (fails.length > 0 || logProblems.length > 0) return bad("INV-3", detail);
  if (count("echo") > 0) return { id: "INV-3", status: "warn", detail };
  if (count("accounted") > 0) return { id: "INV-3", status: "accounted", detail };
  return ok("INV-3", "no sentinel in Graft's database");
}

export async function inv3(
  ctx: RunCtx,
  o: { sentinels: readonly string[]; afterRetention: boolean },
): Promise<{ result: InvariantResult; hits: ClassifiedHit[] }> {
  const raw = await scanSentinels(ctx.db, {
    sentinels: o.sentinels,
    pgbossSchema: ctx.config.pgbossSchema,
  });
  const hits = raw.map((h) =>
    classifyHit(h, {
      now: ctx.deps.now(),
      pgbossSchema: ctx.config.pgbossSchema,
      afterRetention: o.afterRetention,
    }),
  );
  const logs = [ctx.opts.serverLog, ctx.opts.workerLog].filter((x): x is string => x !== undefined);
  const logProblems = await scanLogFiles(logs, { sentinels: o.sentinels, secrets: ctx.secrets });
  return { result: summarizeInv3(hits, logProblems), hits };
}

// ---------------------------------------------------------------------------------------------
// INV-4: pilot doctor
// ---------------------------------------------------------------------------------------------

export function allowedDoctorWarns(
  mode: LlmMode,
  sandboxMode: "report" | "enforce" = "report",
): Set<string> {
  const allowed = new Set(
    mode === "none" ? ["rollup", "feedback", "cards"] : ["rollup", "feedback"],
  );
  // Phase 1 step 7 (D21): e01 applies a break-glass on purpose; the doctor lists every use.
  if (sandboxMode === "enforce") allowed.add("break_glass");
  return allowed;
}

export function evaluateInv4(
  doctor: { code: number; checks: { id: string; status: string }[] | null },
  mode: LlmMode,
  sandboxMode: "report" | "enforce" = "report",
): InvariantResult {
  if (doctor.code !== 0 || doctor.checks === null) {
    return bad("INV-4", `pilot doctor exited ${doctor.code}`);
  }
  const allowed = allowedDoctorWarns(mode, sandboxMode);
  const fails = doctor.checks.filter((c) => c.status === "FAIL").map((c) => c.id);
  const warns = doctor.checks
    .filter((c) => c.status === "WARN" && !allowed.has(c.id))
    .map((c) => c.id);
  if (fails.length > 0) return bad("INV-4", `FAIL: ${fails.join(", ")}`);
  if (warns.length > 0) return bad("INV-4", `unexpected WARN: ${warns.join(", ")}`);
  return ok("INV-4", `${doctor.checks.length} doctor checks, only allowed warnings`);
}

export async function inv4(ctx: RunCtx, mode: LlmMode): Promise<InvariantResult> {
  const res = await ctx.deps.ops([
    "pilot",
    "doctor",
    "--installation",
    String(ctx.installationId),
    "--json",
  ]);
  let checks: { id: string; status: string }[] | null = null;
  try {
    checks = (JSON.parse(res.out) as { checks: { id: string; status: string }[] }).checks;
  } catch {
    checks = null;
  }
  return evaluateInv4({ code: res.code, checks }, mode, ctx.sandbox.mode);
}

// ---------------------------------------------------------------------------------------------
// INV-5: token spend recorded
// ---------------------------------------------------------------------------------------------

export interface SpendFacts {
  /** Cards of the run created during the scenario with status ok that were not cached. */
  okCardsNotCached: { changeId: string; spendRowsWithTokens: number; costNull: number }[];
  /** `intent_spend` rows with tokens > 0 for the run's changes. */
  tokenRows: number;
}

export function evaluateInv5(mode: LlmMode, f: SpendFacts): InvariantResult {
  if (mode === "none") {
    return f.tokenRows === 0
      ? ok("INV-5", "mode none: no token spend recorded")
      : bad("INV-5", `mode none: ${f.tokenRows} spend rows with tokens`);
  }
  const missing = f.okCardsNotCached.filter((c) => c.spendRowsWithTokens === 0 || c.costNull > 0);
  return missing.length === 0
    ? ok("INV-5", `${f.okCardsNotCached.length} cards, each with priced token spend`)
    : bad("INV-5", `${missing.length} cards without priced token spend`);
}

export async function spendFacts(
  ctx: RunCtx,
  o: { since: Date; changeIds: readonly string[] },
): Promise<SpendFacts> {
  if (o.changeIds.length === 0) return { okCardsNotCached: [], tokenRows: 0 };
  const ids = [...o.changeIds];
  // A cached card (same head and inputs) is not saved again: it has no new row.
  const cards = await ctx.db
    .selectFrom("intent_cards")
    .select(["id", "change_id"])
    .where("change_id", "in", ids)
    .where("status", "=", "ok")
    .where("created_at", ">=", o.since)
    .execute();
  const spend = await ctx.db
    .selectFrom("intent_spend")
    .select(["change_id", "tokens", "cost_usd", "spent_at"])
    .where("change_id", "in", ids)
    .execute();
  const withTokens = spend.filter((s) => s.tokens > 0);
  return {
    okCardsNotCached: cards.map((c) => {
      const rows = withTokens.filter((s) => s.change_id === c.change_id && s.spent_at >= o.since);
      return {
        changeId: c.change_id,
        spendRowsWithTokens: rows.length,
        costNull: rows.filter((s) => s.cost_usd === null).length,
      };
    }),
    tokenRows: withTokens.length,
  };
}
