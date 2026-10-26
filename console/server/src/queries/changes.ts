import { type RawBuilder, sql } from "kysely";
import type {
  CardDetail,
  ChangeRecord,
  PolicyOutcome,
  RegisterResponse,
  RegisterRow,
  RiskClass,
  VerifierStatus,
} from "../../../shared/api.js";
import type { Db } from "../db.js";

export interface RegisterFilter {
  repo?: string | undefined;
  state?: "open" | "closed" | "merged" | undefined;
  risk?: RiskClass | undefined;
  verifier?: "agree" | "disagree" | undefined;
  author?: "agent" | "human" | undefined;
  pr?: number | undefined;
  cursor?: string | undefined;
  limit: number;
}

export function encodeCursor(openedAt: Date, id: string): string {
  return Buffer.from(`${openedAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(c: string): { openedAt: Date; id: string } | null {
  const [at, id, extra] = Buffer.from(c, "base64url").toString("utf8").split("|");
  if (!at || !id || extra !== undefined) return null;
  const openedAt = new Date(at);
  if (Number.isNaN(openedAt.getTime())) return null;
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return { openedAt, id };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Every PR Graft handled, newest first, with the latest card, verdict and guard status. */
export async function register(db: Db, f: RegisterFilter): Promise<RegisterResponse> {
  const where: RawBuilder<unknown>[] = [sql`true`];
  if (f.repo) where.push(sql`lower(r.full_name) = lower(${f.repo})`);
  if (f.state) where.push(sql`ch.state = ${f.state}`);
  if (f.risk) where.push(sql`ic.risk_class = ${f.risk}`);
  if (f.verifier) where.push(sql`ic.verifier_status = ${f.verifier}`);
  if (f.author) where.push(sql`cp.author_kind = ${f.author}`);
  if (f.pr !== undefined) where.push(sql`ch.pr_number = ${f.pr}`);
  const cur = f.cursor ? decodeCursor(f.cursor) : null;
  if (cur) where.push(sql`(ch.opened_at, ch.id) < (${cur.openedAt}, ${cur.id}::uuid)`);

  const r = await sql<{
    id: string;
    repo: string;
    pr_number: number;
    state: "open" | "closed" | "merged";
    opened_at: Date;
    merged_at: Date | null;
    author_kind: "agent" | "human" | null;
    author_kind_reason: string | null;
    agent: string | null;
    model: string | null;
    cards: number;
    risk_class: RiskClass | null;
    risk_floor: RiskClass | null;
    verifier_status: VerifierStatus | null;
    card_status: "ok" | "unavailable" | null;
    outcome: PolicyOutcome | null;
    guard_status: string | null;
  }>`
    select ch.id, r.full_name as repo, ch.pr_number, ch.state, ch.opened_at, ch.merged_at,
           cp.author_kind, cp.author_kind_reason, cp.agent, cp.model,
           (select count(*)::int from intent_cards x where x.change_id = ch.id) as cards,
           ic.risk_class, ic.risk_floor, ic.verifier_status, ic.status as card_status,
           pv.outcome, ge.status as guard_status
      from changes ch
      join repositories r on r.id = ch.repository_id
      left join change_provenance cp on cp.change_id = ch.id
      left join lateral (select risk_class, risk_floor, verifier_status, status from intent_cards i
                          where i.change_id = ch.id order by created_at desc limit 1) ic on true
      left join lateral (select outcome from policy_verdicts p where p.change_id = ch.id
                          order by evaluated_at desc limit 1) pv on true
      left join lateral (select status from guard_events g where g.culprit_change_id = ch.id
                          order by created_at desc limit 1) ge on true
     where ${sql.join(where, sql` and `)}
     order by ch.opened_at desc, ch.id desc
     limit ${f.limit + 1}`.execute(db);

  const more = r.rows.length > f.limit;
  const rows = r.rows.slice(0, f.limit);
  const last = rows.at(-1);
  return {
    rows: rows.map(
      (x): RegisterRow => ({
        changeId: x.id,
        repo: x.repo,
        prNumber: x.pr_number,
        state: x.state,
        openedAt: x.opened_at.toISOString(),
        mergedAt: iso(x.merged_at),
        authorKind: x.author_kind,
        authorReason: x.author_kind_reason,
        agent: x.agent,
        model: x.model,
        cards: x.cards,
        riskClass: x.risk_class,
        riskFloor: x.risk_floor,
        verifierStatus: x.verifier_status,
        cardStatus: x.card_status,
        policyOutcome: x.outcome,
        guardStatus: x.guard_status,
      }),
    ),
    nextCursor: more && last ? encodeCursor(last.opened_at, last.id) : null,
  };
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function asFloorReasons(v: unknown): CardDetail["floorReasons"] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const o = x as Record<string, unknown>;
    return typeof o.rule === "string"
      ? [
          {
            rule: o.rule,
            floor: typeof o.floor === "string" ? o.floor : "",
            count: typeof o.count === "number" ? o.count : 0,
            paths: asStrings(o.paths),
          },
        ]
      : [];
  });
}

function asPathReasons(v: unknown): { path: string; reason: string }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const o = x as Record<string, unknown>;
    return typeof o.path === "string"
      ? [{ path: o.path, reason: typeof o.reason === "string" ? o.reason : "" }]
      : [];
  });
}

/** One PR's whole record, or null when the id is unknown. */
export async function changeRecord(db: Db, id: string): Promise<ChangeRecord | null> {
  const ch = await db
    .selectFrom("changes as c")
    .innerJoin("repositories as r", "r.id", "c.repository_id")
    .leftJoin("tasks as t", "t.id", "c.task_id")
    .select([
      "c.id",
      "r.full_name",
      "c.pr_number",
      "c.state",
      "c.base_ref",
      "c.head_sha",
      "c.author_login",
      "c.opened_at",
      "c.merged_at",
      "c.closed_at",
      "t.external_id",
      "t.issue_number",
      "t.issue_url",
    ])
    .where("c.id", "=", id)
    .executeTakeFirst();
  if (!ch) return null;

  const prov = await db
    .selectFrom("change_provenance")
    .selectAll()
    .where("change_id", "=", id)
    .executeTakeFirst();

  const cards = await db
    .selectFrom("intent_cards")
    .selectAll()
    .where("change_id", "=", id)
    .orderBy("created_at", "desc")
    .execute();

  const verdicts = await db
    .selectFrom("policy_verdicts")
    .selectAll()
    .where("change_id", "=", id)
    .orderBy("evaluated_at", "desc")
    .execute();
  const v = verdicts[0];

  const guards = await db
    .selectFrom("guard_events")
    .select(["id", "status", "branch", "created_at", "revert_pr_number"])
    .where("culprit_change_id", "=", id)
    .orderBy("created_at", "desc")
    .execute();

  const audit = await db
    .selectFrom("audit_log")
    .select(["kind", "reason", "actor_login", "created_at"])
    .where("change_id", "=", id)
    .orderBy("created_at", "desc")
    .execute();

  const fb = await sql<{ up: number; down: number; by_author: number }>`
    select count(*) filter (where f.verdict = 'up')::int as up,
           count(*) filter (where f.verdict = 'down')::int as down,
           count(*) filter (where f.is_pr_author or f.user_id = c.author_id)::int as by_author
      from intent_feedback f join changes c on c.id = f.change_id
     where f.change_id = ${id}`.execute(db);

  return {
    changeId: ch.id,
    repo: ch.full_name,
    prNumber: ch.pr_number,
    state: ch.state,
    baseRef: ch.base_ref,
    headSha: ch.head_sha,
    authorLogin: ch.author_login,
    openedAt: ch.opened_at.toISOString(),
    mergedAt: iso(ch.merged_at),
    closedAt: iso(ch.closed_at),
    task: ch.external_id
      ? { externalId: ch.external_id, issueNumber: ch.issue_number, issueUrl: ch.issue_url }
      : null,
    provenance: prov
      ? {
          authorKind: prov.author_kind,
          reason: prov.author_kind_reason,
          agent: prov.agent,
          model: prov.model,
          task: prov.task_external_id,
          sessionUrl: prov.session_url,
          commitsTotal: prov.commits_total,
          commitsWithTrailers: prov.commits_with_trailers,
          agentCoauthorCommits: prov.agent_coauthor_commits,
          warnings: Array.isArray(prov.warnings) ? prov.warnings.length : 0,
          mcpReport: prov.mcp_report,
        }
      : null,
    cards: cards.map(
      (c): CardDetail => ({
        id: c.id,
        at: c.created_at.toISOString(),
        headSha: c.head_sha,
        status: c.status,
        failureReason: c.failure_reason,
        riskClass: c.risk_class,
        riskFloor: c.risk_floor,
        verifierStatus: c.verifier_status,
        goal: c.goal,
        behaviorChanges: asStrings(c.behavior_changes),
        outOfScope: asPathReasons(c.out_of_scope_edits),
        floorReasons: asFloorReasons(c.floor_reasons),
        modelRiskClass: c.model_risk_class,
        modelRiskReason: c.model_risk_reason,
        verifierRiskClass: c.verifier_risk_class,
        riskRaisedBy: asStrings(c.risk_raised_by),
        verifierFailure: c.verifier_failure,
        verifierMissing: asStrings(c.verifier_missing),
        verifierUnexplained: asStrings(c.verifier_unexplained),
        instructionsInData: c.instructions_in_data,
        writerModel: c.writer_model,
        verifierModel: c.verifier_model,
        tokens: Number(c.input_tokens) + Number(c.output_tokens),
        llmCalls: c.llm_calls,
        filesTotal: c.files_total,
        linesAdded: c.lines_added,
        linesDeleted: c.lines_deleted,
        inputsTruncated: c.inputs_truncated,
        publishedAt: iso(c.published_at),
      }),
    ),
    verdict: v
      ? {
          outcome: v.outcome,
          policyStatus: v.policy_status,
          policyMode: v.policy_mode,
          checkConclusion: v.check_conclusion,
          enforcedConclusion: v.enforced_conclusion,
          enforcedReason: v.enforced_reason,
          riskClass: v.risk_class,
          rulesMatched: Array.isArray(v.rules_matched) ? v.rules_matched.length : 0,
          errors: Array.isArray(v.errors) ? v.errors.length : 0,
          evaluatedAt: v.evaluated_at.toISOString(),
          evaluations: verdicts.length,
        }
      : null,
    guardEvents: guards.map((g) => ({
      id: g.id,
      status: g.status,
      branch: g.branch,
      at: g.created_at.toISOString(),
      revertPr: g.revert_pr_number,
    })),
    breakGlass: audit.map((a) => ({
      kind: a.kind,
      reason: a.reason,
      actor: a.actor_login,
      at: a.created_at.toISOString(),
    })),
    feedback: {
      up: fb.rows[0]?.up ?? 0,
      down: fb.rows[0]?.down ?? 0,
      byAuthor: fb.rows[0]?.by_author ?? 0,
    },
  };
}
