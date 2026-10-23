/**
 * Phase 1 step 7: direct-SQL seeding for the Phase 1 gate tests (I-P1G). Five pilot installations,
 * one repository each, with merged changes and their merge-head verdicts in both modes, guard
 * events, review-time runs, incidents, audit rows and MCP rows. Every text column a seed writes
 * carries a sentinel, so I-P1G-9 can search the report for them.
 */
import { sql } from "kysely";
import type { Db } from "../../src/db/client.js";
import {
  addChange,
  addDelivery,
  addIncidentRow,
  addInstallation,
  HASH,
  SHA,
} from "./pilot-seed.js";

export const P1_SINCE = new Date("2026-09-01T00:00:00Z");
export const P1_UNTIL = new Date("2026-10-15T00:00:00Z");
/** Sentinels: none may appear in a Phase 1 gate report. */
export const P1_SENTINELS = {
  author: "sentinel-p1-author",
  actor: "sentinel-p1-actor",
  token: "sentinel-p1-token-name",
  agent: "sentinel-p1-agent",
} as const;

export const P1_PILOTS = [9001, 9002, 9003, 9004, 9005].map((id, i) => ({
  id,
  repo: 9101 + i,
  login: `pilot${i + 1}`,
}));

const day = (d: number, hour = 12): Date =>
  new Date(P1_SINCE.getTime() + d * 86_400_000 + hour * 3_600_000);

type Reason =
  | "approved_by_policy"
  | "requirements_met"
  | "break_glass"
  | "no_policy"
  | "policy_invalid"
  | "blocked"
  | "reviews_truncated"
  | "changes_requested"
  | "approvals_missing"
  | "card_pending";

const conclusionOf = (r: Reason): "success" | "failure" | "pending" =>
  r === "approved_by_policy" || r === "requirements_met" || r === "break_glass"
    ? "success"
    : r === "card_pending"
      ? "pending"
      : "failure";

let n = 0;

/** A verdict row for `(change, head)`, in a mode, with the enforce reason (and its conclusion). */
export async function addP1Verdict(
  db: Db,
  v: {
    changeId: string;
    headSha: string;
    mode: "report" | "enforce";
    reason: Reason | null;
    factsReadAt: Date;
    counted?: number;
  },
): Promise<void> {
  n++;
  await sql`
    insert into policy_verdicts (change_id, head_sha, base_ref, policy_commit_sha, policy_file_sha,
      policy_status, policy_hash, outcome, facts_hash, facts_read_at, evaluated_at, policy_mode, mode,
      enforced_conclusion, enforced_reason, approvals)
    values (${v.changeId}, ${v.headSha}, 'main', ${SHA(0xba5e)}, ${SHA(0x5000 + n)}, 'ok',
      ${HASH(0x7000 + n)}, 'would_require', ${HASH(0x9000 + n)}, ${v.factsReadAt}, ${v.factsReadAt},
      ${v.mode}, ${v.mode}, ${v.reason === null ? null : conclusionOf(v.reason)}, ${v.reason},
      ${JSON.stringify({ counted: v.counted ?? 0, current: v.counted ?? 0 })}::jsonb)`.execute(db);
}

/** A merged change with its merge-head verdict; returns the change id. */
export async function addMerged(
  db: Db,
  o: {
    repo: number;
    pr: number;
    at: Date;
    mode: "report" | "enforce";
    reason: Reason | null;
    author?: string;
    counted?: number;
  },
): Promise<string> {
  const head = SHA(0x100000 + o.repo * 1000 + o.pr);
  const id = await addChange(db, {
    repositoryId: o.repo,
    prNumber: o.pr,
    author: o.author ?? P1_SENTINELS.author,
    state: "merged",
    openedAt: new Date(o.at.getTime() - 3_600_000),
    mergedAt: o.at,
    headSha: head,
  });
  await addP1Verdict(db, {
    changeId: id,
    headSha: head,
    mode: o.mode,
    reason: o.reason,
    factsReadAt: new Date(o.at.getTime() - 60_000),
    ...(o.counted === undefined ? {} : { counted: o.counted }),
  });
  return id;
}

export async function addGuardEvent(
  db: Db,
  g: {
    repo: number;
    status: string;
    mode: "report" | "enforce" | null;
    at: Date;
    confirmReason?: string | null;
    revertPr?: number | null;
    outcome?: string | null;
    reason?: string | null;
    autoMerge?: string | null;
  },
): Promise<void> {
  n++;
  await sql`
    insert into guard_events (repository_id, branch, failing_sha, status, detected_at, created_at,
      updated_at, confirm_reason, revert_pr_number, revert_outcome, revert_reason, guard_mode,
      auto_merge_state)
    values (${g.repo}, 'main', ${SHA(0x200000 + n)}, ${g.status}, ${g.at}, ${g.at}, ${g.at},
      ${g.confirmReason === undefined ? "next_commit" : g.confirmReason}, ${g.revertPr ?? null},
      ${g.outcome ?? null}, ${g.reason ?? null}, ${g.mode}, ${g.autoMerge ?? null})`.execute(db);
}

export async function addRun(
  db: Db,
  o: {
    repo: number;
    period: "baseline" | "phase1" | "shadow";
    extractedAt: Date;
    rows: { pr: number; kind: "agent" | "human"; first: number | null; merge: number | null }[];
  },
): Promise<string> {
  const res = await sql<{ id: string }>`
    insert into review_time_runs (repository_id, period, from_date, to_date, base_ref,
      extractor_version, pr_count, excluded_count, aggregates, requests, extracted_at)
    values (${o.repo}, ${o.period}, '2026-06-01', '2026-08-31', 'main', 1, ${o.rows.length}, 0,
      '{}'::jsonb, 1, ${o.extractedAt})
    returning id`.execute(db);
  const id = res.rows[0]?.id as string;
  for (const r of o.rows) {
    await sql`insert into review_time_prs (run_id, pr_number, state, author_kind, author_kind_reason,
      size_bucket, start_basis, minutes_to_first_approval, minutes_to_merge, review_rounds,
      merged_without_review, paused_minutes, excluded_reason)
      values (${id}, ${r.pr}, 'merged', ${r.kind}, 'none', 'S', 'opened', ${r.first}, ${r.merge}, 1,
        false, 0, null)`.execute(db);
  }
  return id;
}

/**
 * The I-P1G-1 world, with hand-computed answers:
 * - M1: 50 enforce rows per pilot (20 `auto`, 30 `human`) and 10 report rows per pilot (5 `auto`,
 *   5 `would_fail`), merged on days 1 to 28: measured 100 of 250, projected 125 of 300.
 * - M2: repositories 1 and 2 have a baseline (20 agent rows at 100 min, 10 human rows) and a
 *   phase1 run (20 agent rows at 40 min linked to enforce `human` changes, 5 linked to report
 *   `auto` changes at 80 min): measured 40 vs 40 rows, Δ −0.6; projected 50 rows, 10 zeros, Δ −0.6.
 *   Repositories 3 to 5 have a baseline of 30 human rows only.
 * - M3: 10 enforce events on repositories 1 and 2 (9 caught, 1 needs_human); report events on
 *   repository 3 (2 planned, 1 unconfirmed flaky, 1 confirming): measured 9 of 10, projected 11 of 12.
 * - M4: all 300 merged rows are before `until − 14 days`, 2 incidents (on enforce `human` rows);
 *   the baseline has 150 merged rows and 3 incidents. 1 unlinked incident.
 * - Retention: every installation was created 60 days before `until`, with a delivery in its
 *   last 7 days, except pilot 5 (no recent delivery): retained 4 of 5.
 */
export async function seedPhase1World(db: Db): Promise<void> {
  const created = new Date(P1_UNTIL.getTime() - 60 * 86_400_000);
  for (const p of P1_PILOTS) {
    await addInstallation(db, { id: p.id, login: p.login, repos: [{ id: p.repo, name: "api" }] });
    await db
      .updateTable("installations")
      .set({ created_at: created })
      .where("id", "=", p.id)
      .execute();
  }
  for (const [i, p] of P1_PILOTS.entries()) {
    let pr = 1;
    for (let k = 0; k < 50; k++) {
      await addMerged(db, {
        repo: p.repo,
        pr: pr++,
        at: day(1 + (k % 28)),
        mode: "enforce",
        reason: k < 20 ? "approved_by_policy" : "requirements_met",
      });
    }
    for (let k = 0; k < 10; k++) {
      await addMerged(db, {
        repo: p.repo,
        pr: pr++,
        at: day(1 + (k % 28)),
        mode: "report",
        reason: k < 5 ? "approved_by_policy" : "approvals_missing",
      });
    }
    if (i < 4) {
      await addDelivery(db, {
        id: `p1-dl-${p.id}`,
        installationId: p.id,
        repositoryId: p.repo,
        at: new Date(P1_UNTIL.getTime() - 2 * 86_400_000),
      });
    }
  }
  // M2: PR numbers 21..40 of repos 1 and 2 are enforce `human`; 51..55 are report `auto`.
  const [r1, r2, r3, r4, r5] = P1_PILOTS.map((p) => p.repo) as [
    number,
    number,
    number,
    number,
    number,
  ];
  for (const repo of [r1, r2]) {
    await addRun(db, {
      repo,
      period: "baseline",
      extractedAt: new Date("2026-08-31T00:00:00Z"),
      rows: [
        ...Array.from({ length: 20 }, (_, k) => ({
          pr: 5001 + k,
          kind: "agent" as const,
          first: 100,
          merge: 200,
        })),
        ...Array.from({ length: 10 }, (_, k) => ({
          pr: 5101 + k,
          kind: "human" as const,
          first: 50,
          merge: 60,
        })),
      ],
    });
    await addRun(db, {
      repo,
      period: "phase1",
      extractedAt: new Date("2026-10-14T00:00:00Z"),
      rows: [
        ...Array.from({ length: 20 }, (_, k) => ({
          pr: 21 + k,
          kind: "agent" as const,
          first: 40,
          merge: 90,
        })),
        ...Array.from({ length: 5 }, (_, k) => ({
          pr: 51 + k,
          kind: "agent" as const,
          first: 80,
          merge: 90,
        })),
      ],
    });
  }
  for (const repo of [r3, r4, r5]) {
    await addRun(db, {
      repo,
      period: "baseline",
      extractedAt: new Date("2026-08-31T00:00:00Z"),
      rows: Array.from({ length: 30 }, (_, k) => ({
        pr: 5001 + k,
        kind: "human" as const,
        first: 50,
        merge: 60,
      })),
    });
  }
  // M3.
  for (let k = 0; k < 9; k++) {
    await addGuardEvent(db, {
      repo: k < 5 ? r1 : r2,
      status: k === 0 ? "revert_opened" : k === 1 ? "revert_closed" : "reverted",
      mode: "enforce",
      at: day(3 + k),
      revertPr: 8001 + k,
      outcome: "opened",
      autoMerge: k === 2 ? "enabled" : "not_eligible",
    });
  }
  await addGuardEvent(db, {
    repo: r2,
    status: "needs_human",
    mode: "enforce",
    at: day(15),
    outcome: "needs_human",
    reason: "touched_later",
  });
  await addGuardEvent(db, {
    repo: r3,
    status: "culprit_found",
    mode: "report",
    at: day(16),
    outcome: "planned",
  });
  await addGuardEvent(db, {
    repo: r3,
    status: "culprit_found",
    mode: null,
    at: day(17),
    outcome: "planned",
  });
  await addGuardEvent(db, {
    repo: r3,
    status: "flaky",
    mode: "report",
    at: day(18),
    confirmReason: null,
  });
  await addGuardEvent(db, {
    repo: r3,
    status: "confirming",
    mode: null,
    at: day(19),
    confirmReason: null,
  });
  // M4: two window incidents on enforce `human` rows, three baseline incidents, one unlinked.
  await addIncidentRow(db, { repositoryId: r1, culprit: 30, at: day(20) });
  await addIncidentRow(db, { repositoryId: r4, culprit: 31, at: day(21) });
  await addIncidentRow(db, {
    repositoryId: r3,
    culprit: 5001,
    at: new Date("2026-08-10T00:00:00Z"),
  });
  await addIncidentRow(db, {
    repositoryId: r4,
    culprit: 5002,
    at: new Date("2026-08-10T00:00:00Z"),
  });
  await addIncidentRow(db, {
    repositoryId: r5,
    culprit: 5003,
    at: new Date("2026-08-10T00:00:00Z"),
  });
  await addIncidentRow(db, { repositoryId: r5, culprit: null, at: day(22) });
}
