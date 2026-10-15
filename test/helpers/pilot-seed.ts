/** Direct-SQL seeding for the step 6 tests: changes, cards, votes, verdicts, spend and friends. */
import { sql } from "kysely";
import type { Db } from "../../src/db/client.js";
import { fakeSha } from "./github-builders.js";

export const SHA = (n: number): string => fakeSha(n);
export const HASH = (n: number): string => n.toString(16).padStart(64, "0");

let counter = 0;
const next = (): number => ++counter;

export async function addInstallation(
  db: Db,
  o: { id: number; login: string; repos: { id: number; name: string }[]; deleted?: boolean },
): Promise<void> {
  await db
    .insertInto("installations")
    .values({
      id: o.id,
      account_id: o.id + 9_000_000,
      account_login: o.login,
      account_type: "Organization",
      repository_selection: "selected",
      suspended_at: null,
      deleted_at: o.deleted ? new Date("2026-10-01T00:00:00Z") : null,
    })
    .execute();
  for (const r of o.repos) {
    await db
      .insertInto("repositories")
      .values({
        id: r.id,
        installation_id: o.id,
        full_name: `${o.login}/${r.name}`,
        private: true,
        default_branch: "main",
        removed_at: null,
      })
      .execute();
  }
}

export interface ChangeSeed {
  repositoryId: number;
  prNumber: number;
  author?: string;
  state?: "open" | "closed" | "merged";
  openedAt: Date;
  closedAt?: Date | null;
  mergedAt?: Date | null;
  headSha?: string;
}

export async function addChange(db: Db, c: ChangeSeed): Promise<string> {
  const merged = c.state === "merged";
  const row = await db
    .insertInto("changes")
    .values({
      repository_id: c.repositoryId,
      pr_number: c.prNumber,
      pr_node_id: `node-${c.repositoryId}-${c.prNumber}`,
      task_id: null,
      head_sha: c.headSha ?? SHA(c.prNumber),
      base_ref: "main",
      author_login: c.author ?? "author-1",
      author_is_bot: false,
      state: c.state ?? "open",
      merge_commit_sha: merged ? SHA(0xabc0 + c.prNumber) : null,
      opened_at: c.openedAt,
      closed_at: c.closedAt ?? (merged ? (c.mergedAt ?? null) : null),
      merged_at: c.mergedAt ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface CardSeed {
  changeId: string;
  headSha: string;
  status?: "ok" | "unavailable";
  risk?: "trivial" | "logic" | "sensitive";
  verifier?: "agree" | "disagree" | "error" | "skipped";
  failure?: string | null;
  createdAt: Date;
}

export async function addCard(db: Db, c: CardSeed): Promise<string> {
  const status = c.status ?? "ok";
  const res = await sql<{ id: string }>`
    insert into intent_cards (change_id, head_sha, prompt_version, input_hash, status, failure_reason, goal,
      risk_class, risk_floor, verifier_status, files_total, files_listed, files_full, files_partial,
      files_omitted, lines_added, lines_deleted, inputs_truncated, created_at, updated_at)
    values (${c.changeId}, ${c.headSha}, 'v', ${HASH(next())}, ${status},
      ${status === "unavailable" ? (c.failure ?? "llm_timeout") : null},
      ${status === "ok" ? "a goal" : null},
      ${c.risk ?? "logic"}, 'trivial', ${c.verifier ?? "agree"}, 1, 1, 1, 0, 0, 1, 0, false,
      ${c.createdAt}, ${c.createdAt})
    returning id`.execute(db);
  return res.rows[0]?.id as string;
}

export async function addDisplay(
  db: Db,
  d: { changeId: string; cardId: string; status: "ok" | "unavailable" | "pending"; shownAt: Date },
): Promise<void> {
  await db
    .insertInto("intent_displays")
    .values({
      change_id: d.changeId,
      card_id: d.cardId,
      status: d.status,
      shown_at: d.shownAt,
    })
    .execute();
}

export async function addVote(
  db: Db,
  v: {
    changeId: string;
    cardId: string;
    userId: number;
    login: string;
    verdict: "up" | "down";
    source?: "reaction" | "check_action";
    at: Date;
    author?: boolean;
  },
): Promise<void> {
  await db
    .insertInto("intent_feedback")
    .values({
      card_id: v.cardId,
      change_id: v.changeId,
      user_id: v.userId,
      user_login: v.login,
      verdict: v.verdict,
      source: v.source ?? "reaction",
      reacted_at: v.at,
      is_pr_author: v.author ?? false,
    })
    .execute();
}

export async function addVerdict(
  db: Db,
  v: {
    changeId: string;
    headSha: string;
    outcome: "would_approve" | "would_require" | "would_block" | "no_policy" | "policy_invalid";
    factsReadAt: Date;
  },
): Promise<void> {
  const status =
    v.outcome === "no_policy" ? "missing" : v.outcome === "policy_invalid" ? "invalid" : "ok";
  const n = next();
  await sql`
    insert into policy_verdicts (change_id, head_sha, base_ref, policy_commit_sha, policy_file_sha, policy_status,
      policy_hash, outcome, facts_hash, facts_read_at, evaluated_at)
    values (${v.changeId}, ${v.headSha}, 'main', ${SHA(0xba5e)}, ${status === "missing" ? null : SHA(n)},
      ${status}, ${status === "ok" ? HASH(n) : null}, ${v.outcome}, ${HASH(n + 1000)},
      ${v.factsReadAt}, ${v.factsReadAt})`.execute(db);
}

export async function addProvenance(
  db: Db,
  p: { changeId: string; headSha: string; kind: "agent" | "human" },
): Promise<void> {
  await sql`
    insert into change_provenance (change_id, head_sha, author_kind, author_kind_reason, field_sources,
      conflicts, warnings, commits_total, commits_scanned, commits_with_trailers, agent_coauthor_commits, computed_at)
    values (${p.changeId}, ${p.headSha}, ${p.kind}, ${p.kind === "agent" ? "trailer" : "none"},
      '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 1, 1, 0, 0, now())`.execute(db);
}

export async function addSpend(
  db: Db,
  s: {
    repositoryId: number;
    changeId?: string | null;
    tokens: number;
    cost: number | null;
    at: Date;
  },
): Promise<void> {
  await sql`insert into intent_spend (repository_id, change_id, tokens, llm_calls, spent_at, cost_usd)
    values (${s.repositoryId}, ${s.changeId ?? null}, ${s.tokens}, 2, ${s.at}, ${s.cost})`.execute(
    db,
  );
}

export async function addReviewer(
  db: Db,
  r: {
    changeId: string;
    userId: number;
    reason?: "requested" | "reviewed";
    /** Default true; false is a legacy row stored before eligibility was verified. */
    verified?: boolean;
  },
): Promise<void> {
  await db
    .insertInto("pr_reviewers")
    .values({
      change_id: r.changeId,
      user_id: r.userId,
      reason: r.reason ?? "requested",
      first_seen_at: new Date("2026-10-01T00:00:00Z"),
      verified: r.verified ?? true,
    })
    .execute();
}

export async function addDelivery(
  db: Db,
  d: { id: string; installationId: number | null; repositoryId: number | null; at: Date },
): Promise<void> {
  await db
    .insertInto("webhook_deliveries")
    .values({
      delivery_id: d.id,
      event: "pull_request",
      action: "opened",
      installation_id: d.installationId,
      repository_id: d.repositoryId,
      status: "enqueued",
      job_id: null,
      received_at: d.at,
    })
    .execute();
}

export async function addIncidentRow(
  db: Db,
  i: {
    repositoryId: number;
    culprit: number | null;
    fix?: number | null;
    at: Date;
    source?: "cli" | "label";
  },
): Promise<void> {
  await db
    .insertInto("incidents")
    .values({
      repository_id: i.repositoryId,
      culprit_pr_number: i.culprit,
      fix_pr_number: i.fix ?? null,
      source: i.source ?? "cli",
      severity: null,
      occurred_at: i.at,
      recorded_at: i.at,
    })
    .execute();
}

// ---------------------------------------------------------------------------------------------
// The two-pilot world of the gate tests
// ---------------------------------------------------------------------------------------------

export const PILOT_A = { id: 1000001, repo: 2000001, login: "graft-sandbox" };
export const PILOT_B = { id: 1000002, repo: 2000002, login: "globex" };
export const PILOT_C = { id: 1000003, repo: 2000003, login: "initech" };
export const GATE_SINCE = new Date("2026-11-01T00:00:00Z");
export const GATE_UNTIL = new Date("2026-11-29T00:00:00Z");

const D = (s: string): Date => new Date(s);

export interface GateWorld {
  /** Logins of every eligible voter (to build an allow-list). */
  voterLogins: string[];
  /** User ids of every eligible voter, in the same order. */
  voterIds: number[];
  /** `${changeId}` of each PR by installation, for tests that remove reviewers. */
  changes: Map<number, string[]>;
}

/**
 * Two pilots, 30 PRs each (see the comments in pilot-gate.test.ts for the hand count): 180
 * eligible votes (169 up, 11 down), 60 PRs, 8 voters, plus 4 author, 2 bot and 3 non-reviewer
 * votes. `seedWorld` is NOT called: this helper adds both installations.
 */
export async function seedGateWorld(db: Db, o: { votes?: boolean } = {}): Promise<GateWorld> {
  const world: GateWorld = { voterLogins: [], voterIds: [], changes: new Map() };
  const pilots = [
    { ...PILOT_A, name: "api", downs: 5, voterBase: 100, prefix: "a" },
    { ...PILOT_B, name: "svc", downs: 6, voterBase: 200, prefix: "b" },
  ];
  for (const p of pilots) {
    await addInstallation(db, { id: p.id, login: p.login, repos: [{ id: p.repo, name: p.name }] });
    const ids: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const opened = D(`2026-11-${String(3 + (i % 20)).padStart(2, "0")}T10:00:00Z`);
      const merged = i <= 10;
      const head = SHA(p.repo * 100 + i);
      const change = await addChange(db, {
        repositoryId: p.repo,
        prNumber: i,
        author: `dev-${p.prefix}-${i}`,
        state: merged ? "merged" : "open",
        openedAt: opened,
        mergedAt: merged ? new Date(opened.getTime() + 3_600_000) : null,
        headSha: head,
      });
      ids.push(change);
      await addProvenance(db, {
        changeId: change,
        headSha: head,
        kind: i % 2 === 0 ? "agent" : "human",
      });
      const card = await addCard(db, {
        changeId: change,
        headSha: head,
        risk: i <= 4 ? "trivial" : "logic",
        verifier: i === 3 || i === 8 ? "disagree" : "agree",
        createdAt: opened,
      });
      if (!(p.prefix === "b" && i === 30)) {
        await addDisplay(db, { changeId: change, cardId: card, status: "ok", shownAt: opened });
      }
      if (merged) {
        const outcome =
          i <= 4
            ? "would_approve"
            : i <= 8
              ? "would_require"
              : i === 9
                ? "would_block"
                : "no_policy";
        await addVerdict(db, {
          changeId: change,
          headSha: head,
          outcome,
          factsReadAt: new Date(opened.getTime() + 1_800_000),
        });
      }
      if (i === 11) {
        const bad = await addCard(db, {
          changeId: change,
          headSha: head,
          status: "unavailable",
          failure: "llm_timeout",
          verifier: "skipped",
          createdAt: new Date(opened.getTime() + 600_000),
        });
        await addDisplay(db, {
          changeId: change,
          cardId: bad,
          status: "unavailable",
          shownAt: new Date(opened.getTime() + 3_600_000),
        });
      }
      if (i <= 3) {
        await addSpend(db, {
          repositoryId: p.repo,
          changeId: change,
          tokens: i === 1 ? 1000 : i === 2 ? 2000 : 500,
          cost: i === 1 ? 0.01 : i === 2 ? 0.02 : null,
          at: opened,
        });
      }
      if (o.votes === false) continue;
      for (let k = 0; k < 3; k++) {
        const voter = p.voterBase + ((i + k) % 4) + 1;
        const login = `${p.prefix}-rev-${voter}`;
        if (!world.voterLogins.includes(login)) {
          world.voterLogins.push(login);
          world.voterIds.push(voter);
        }
        await addVote(db, {
          changeId: change,
          cardId: card,
          userId: voter,
          login,
          verdict: k === 0 && i <= p.downs ? "down" : "up",
          source: k === 2 && i > 20 ? "check_action" : "reaction",
          at: new Date(opened.getTime() + 1_800_000),
        });
        await addReviewer(db, {
          changeId: change,
          userId: voter,
          reason: k === 2 ? "reviewed" : "requested",
        });
      }
      // Votes that must not count.
      if (p.prefix === "a" && i <= 4) {
        await addVote(db, {
          changeId: change,
          cardId: card,
          userId: 900 + i,
          login: `dev-a-${i}`,
          verdict: "up",
          at: new Date(opened.getTime() + 1_900_000),
          author: true,
        });
      }
      if (p.prefix === "b" && i <= 2) {
        await addVote(db, {
          changeId: change,
          cardId: card,
          userId: 950 + i,
          login: "ci-bot[bot]",
          verdict: "up",
          at: new Date(opened.getTime() + 1_900_000),
        });
      }
      if (p.prefix === "a" && i >= 5 && i <= 7) {
        await addVote(db, {
          changeId: change,
          cardId: card,
          userId: 960 + i,
          login: "driveby-person",
          verdict: "down",
          at: new Date(opened.getTime() + 1_900_000),
        });
      }
    }
    world.changes.set(p.id, ids);
  }
  // Ignored by the report: an excluded author's PR and a PR closed within 10 minutes of opening.
  await addChange(db, {
    repositoryId: PILOT_A.repo,
    prNumber: 31,
    author: "dependabot[bot]",
    openedAt: D("2026-11-05T10:00:00Z"),
  });
  await addChange(db, {
    repositoryId: PILOT_A.repo,
    prNumber: 32,
    author: "quitter",
    state: "closed",
    openedAt: D("2026-11-05T11:00:00Z"),
    closedAt: D("2026-11-05T11:05:00Z"),
  });
  return world;
}
