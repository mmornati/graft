import { type Kysely, sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client.js";
import { createMigrator, migrateDown, migrateToLatest } from "../../src/db/migrator.js";
import { type Database, TABLE_NAMES } from "../../src/db/schema.js";
import { TEST_DATABASE_URL } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";

const db = testDb();
const SHA = "a".repeat(40);
const HASH = "b".repeat(64);

/** The smallest valid `ok` card row (every NOT NULL column without a default). */
const OK_CARD = {
  head_sha: SHA,
  prompt_version: "intent-v1",
  input_hash: HASH,
  status: "ok" as const,
  failure_reason: null,
  goal: "g",
  risk_class: "logic" as const,
  risk_floor: "trivial" as const,
  verifier_status: "agree" as const,
  files_total: 1,
  files_listed: 1,
  files_full: 1,
  files_partial: 0,
  files_omitted: 0,
  lines_added: 1,
  lines_deleted: 0,
  inputs_truncated: false,
};

afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));

async function tableNames(d: Kysely<Database>): Promise<string[]> {
  const res = await sql<{ table_name: string }>`
    select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`.execute(
    d,
  );
  return res.rows.map((r) => r.table_name);
}

describe("database", () => {
  it("I-DB-1 after migration, all twenty-two tables exist", async () => {
    const names = await tableNames(db);
    for (const t of TABLE_NAMES) expect(names).toContain(t);
    expect(TABLE_NAMES).toHaveLength(22);
    expect(TABLE_NAMES).toContain("intent_feedback");
    expect(TABLE_NAMES).toContain("change_provenance");
  });

  it("I-DB-2 down to zero, then up again, succeeds; the pgboss schema is untouched", async () => {
    await sql`create schema if not exists pgboss`.execute(db);
    await sql`create table if not exists pgboss.i_db_2_marker (id int)`.execute(db);
    await sql`insert into pgboss.i_db_2_marker values (1)`.execute(db);
    try {
      const rolled = await migrateDown(db);
      expect(rolled).toContain("0001_initial");
      expect(rolled).toContain("0002_provenance");
      expect(rolled).toContain("0003_intent");
      expect(rolled).toContain("0004_intent_display_pending");
      expect(rolled).toContain("0005_policy");
      expect(rolled).toContain("0006_pilot");
      expect(rolled).toContain("0007_vote_eligibility");
      expect(rolled).toContain("0008_modes");
      expect(rolled).toContain("0009_enforce");
      const after = await tableNames(db);
      for (const t of TABLE_NAMES) expect(after).not.toContain(t);

      const marker = await sql<{
        n: string;
      }>`select count(*)::text n from pgboss.i_db_2_marker`.execute(db);
      expect(marker.rows[0]?.n).toBe("1");

      expect(await migrateToLatest(db)).toEqual([
        "0001_initial",
        "0002_provenance",
        "0003_intent",
        "0004_intent_display_pending",
        "0005_policy",
        "0006_pilot",
        "0007_vote_eligibility",
        "0008_modes",
        "0009_enforce",
      ]);
      expect(await migrateToLatest(db)).toEqual([]);
      const again = await tableNames(db);
      for (const t of TABLE_NAMES) expect(again).toContain(t);
      const marker2 = await sql<{
        n: string;
      }>`select count(*)::text n from pgboss.i_db_2_marker`.execute(db);
      expect(marker2.rows[0]?.n).toBe("1");
    } finally {
      await sql`drop table if exists pgboss.i_db_2_marker`.execute(db);
    }
  });

  it("I-DB-3 insert and select one row per table through Kysely", async () => {
    await db
      .insertInto("installations")
      .values({
        id: 1,
        account_id: 10,
        account_login: "Acme",
        account_type: "Organization",
        repository_selection: "selected",
        suspended_at: null,
        deleted_at: null,
      })
      .execute();
    await db
      .insertInto("repositories")
      .values({
        id: 2,
        installation_id: 1,
        full_name: "acme/app",
        private: true,
        default_branch: "main",
        removed_at: null,
      })
      .execute();
    const task = await db
      .insertInto("tasks")
      .values({
        repository_id: 2,
        external_id: "T-1",
        issue_number: 7,
        issue_url: "https://example.test/7",
        goal: "do it",
      })
      .returning(["id", "external_id"])
      .executeTakeFirstOrThrow();
    const now = new Date("2026-10-14T12:00:00Z");
    const change = await db
      .insertInto("changes")
      .values({
        repository_id: 2,
        pr_number: 5,
        pr_node_id: "PR_x",
        task_id: task.id,
        head_sha: SHA,
        base_ref: "main",
        author_login: "bot",
        state: "open",
        merge_commit_sha: null,
        opened_at: now,
        closed_at: null,
        merged_at: null,
      })
      .returning(["id", "pr_number"])
      .executeTakeFirstOrThrow();
    await db
      .insertInto("provenance")
      .values({
        change_id: change.id,
        source: "trailer",
        commit_sha: SHA,
        agent: "claude-code",
        model: "m",
        task_external_id: "T-1",
        session_url: null,
      })
      .execute();
    await db
      .insertInto("provenance")
      .values({
        change_id: change.id,
        source: "pr_body",
        commit_sha: null,
        agent: "claude-code",
        model: null,
        task_external_id: null,
        session_url: null,
      })
      .execute();
    await db
      .insertInto("change_provenance")
      .values({
        change_id: change.id,
        head_sha: SHA,
        author_kind: "agent",
        author_kind_reason: "trailer",
        agent: "claude-code",
        model: "m",
        task_external_id: "T-1",
        session_url: null,
        field_sources: JSON.stringify({ agent: { source: "commit", commitSha: SHA } }),
        conflicts: JSON.stringify({ model: ["a", "b"] }),
        warnings: JSON.stringify([]),
        commits_total: 3,
        commits_scanned: 3,
        commits_with_trailers: 2,
        agent_coauthor_commits: 0,
        check_run_id: null,
        computed_at: now,
      })
      .execute();
    const card = await db
      .insertInto("intent_cards")
      .values({
        ...OK_CARD,
        change_id: change.id,
        behavior_changes: JSON.stringify(["a"]),
        out_of_scope_edits: JSON.stringify([{ path: "docs/x.md", reason: "r" }]),
        comment_id: 99,
        check_run_id: null,
      })
      .returning(["id", "behavior_changes", "comment_id", "out_of_scope_edits"])
      .executeTakeFirstOrThrow();
    expect(card.behavior_changes).toEqual(["a"]);
    expect(card.out_of_scope_edits).toEqual([{ path: "docs/x.md", reason: "r" }]);
    expect(card.comment_id).toBe(99);
    await db
      .insertInto("intent_feedback")
      .values({
        card_id: card.id,
        change_id: change.id,
        user_id: 5000001,
        user_login: "reviewer-1",
        verdict: "up",
        source: "reaction",
        reacted_at: now,
      })
      .execute();
    await db
      .insertInto("intent_spend")
      .values({ repository_id: 2, change_id: change.id, tokens: 1100, llm_calls: 2, spent_at: now })
      .execute();
    await db
      .insertInto("intent_displays")
      .values({ change_id: change.id, card_id: card.id, status: "ok", shown_at: now })
      .execute();
    await db
      .insertInto("policy_verdicts")
      .values({
        change_id: change.id,
        head_sha: SHA,
        base_ref: "main",
        policy_commit_sha: SHA,
        policy_file_sha: SHA,
        policy_status: "ok",
        policy_hash: HASH,
        outcome: "would_require",
        risk_class: "logic",
        risk_source: "card",
        author_kind: "agent",
        rules_matched: JSON.stringify([{ index: 1 }]),
        required: JSON.stringify({ humans: 1 }),
        facts_hash: HASH,
        facts_read_at: now,
        check_run_id: null,
        published_at: null,
        evaluated_at: now,
      })
      .execute();
    await db
      .insertInto("guard_events")
      .values({
        repository_id: 2,
        branch: "main",
        failing_sha: SHA,
        ci_run_url: null,
        culprit_change_id: change.id,
        revert_pr_number: null,
        status: "detected",
      })
      .execute();
    await db
      .insertInto("webhook_deliveries")
      .values({
        delivery_id: "d-1",
        event: "ping",
        action: null,
        installation_id: null,
        repository_id: null,
        status: "ignored",
        job_id: null,
      })
      .execute();
    // Step 6 tables.
    await db
      .insertInto("pr_reviewers")
      .values({ change_id: change.id, user_id: 77, reason: "requested", first_seen_at: now })
      .execute();
    await db
      .insertInto("reviewer_check_denials")
      .values({ change_id: change.id, user_id: 77, status: 403, checked_at: now })
      .execute();
    const run = await db
      .insertInto("review_time_runs")
      .values({
        repository_id: 2,
        period: "baseline",
        from_date: "2026-08-01",
        to_date: "2026-10-31",
        base_ref: "main",
        extractor_version: 1,
        pr_count: 1,
        excluded_count: 0,
        aggregates: JSON.stringify({}),
        requests: 3,
        extracted_at: now,
      })
      .returning(["id", "from_date"])
      .executeTakeFirstOrThrow();
    expect(run.from_date).toBe("2026-08-01");
    await db
      .insertInto("review_time_prs")
      .values({
        run_id: run.id,
        pr_number: 5,
        state: "merged",
        author_kind: "agent",
        author_kind_reason: "trailer",
        size_bucket: "S",
        start_basis: "opened",
        minutes_to_first_approval: 12.5,
        minutes_to_merge: 30,
        review_rounds: 1,
        merged_without_review: false,
        paused_minutes: 0,
        excluded_reason: null,
      })
      .execute();
    await db
      .insertInto("incidents")
      .values({
        repository_id: 2,
        culprit_pr_number: 5,
        fix_pr_number: null,
        source: "cli",
        severity: 2,
        occurred_at: now,
        recorded_at: now,
      })
      .execute();
    await db
      .insertInto("metrics_daily")
      .values({
        repository_id: 2,
        day: "2026-10-13",
        rollup_version: 1,
        counts: JSON.stringify({ prs_opened: 1 }),
        computed_at: now,
      })
      .execute();
    await db
      .insertInto("pilot_purges")
      .values({ installation_id: 1, rows_deleted: JSON.stringify({ changes: 1 }), purged_at: now })
      .execute();

    await db
      .insertInto("mode_changes")
      .values({
        repository_id: 2,
        key: "policy_mode",
        from_value: "report",
        to_value: "enforce",
        actor: "op",
        reason: "test",
      })
      .execute();
    await db
      .insertInto("service_state")
      .values({ key: "mode_ceiling", value: "report", updated_at: now })
      .execute();

    for (const t of TABLE_NAMES) {
      const rows = await db.selectFrom(t).selectAll().execute();
      expect(rows, t).toHaveLength(t === "provenance" ? 2 : 1);
    }
    const cp = await db.selectFrom("change_provenance").selectAll().executeTakeFirstOrThrow();
    expect(cp.conflicts).toEqual({ model: ["a", "b"] });
    expect(cp.commits_truncated).toBe(false);
    expect(change.pr_number).toBe(5);
    expect(task.external_id).toBe("T-1");
  });

  it("I-DB-4 no column in the app tables looks like it holds code, diffs or patches", async () => {
    const res = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns where table_schema = 'public'`.execute(
      db,
    );
    const ours = res.rows.filter((r) => (TABLE_NAMES as readonly string[]).includes(r.table_name));
    expect(ours.length).toBeGreaterThan(50);
    const offenders = ours.filter((r) =>
      /(diff|patch|hunk|snippet|content|blob|code)/.test(r.column_name),
    );
    expect(offenders).toEqual([]);
  });

  it("I-DB-5 CHECK constraints reject bad risk_class, head_sha and webhook status", async () => {
    await db
      .insertInto("installations")
      .values({
        id: 1,
        account_id: 10,
        account_login: "a",
        account_type: "User",
        repository_selection: "all",
        suspended_at: null,
        deleted_at: null,
      })
      .execute();
    await db
      .insertInto("repositories")
      .values({
        id: 2,
        installation_id: 1,
        full_name: "a/b",
        private: false,
        default_branch: null,
        removed_at: null,
      })
      .execute();
    const change = await db
      .insertInto("changes")
      .values({
        repository_id: 2,
        pr_number: 1,
        pr_node_id: "n",
        task_id: null,
        head_sha: SHA,
        base_ref: "main",
        author_login: "x",
        state: "open",
        merge_commit_sha: null,
        opened_at: new Date(),
        closed_at: null,
        merged_at: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const card = (risk: string, sha: string, hash = HASH) =>
      sql`insert into intent_cards (change_id, head_sha, prompt_version, input_hash, status, goal, risk_class, risk_floor, verifier_status,
            files_total, files_listed, files_full, files_partial, files_omitted, lines_added, lines_deleted, inputs_truncated)
          values (${change.id}, ${sha}, 'v', ${hash}, 'ok', 'g', ${risk}, 'trivial', 'agree', 1, 1, 1, 0, 0, 1, 0, false)`.execute(
        db,
      );
    const rawCard = (status: string, goal: string | null, failure: string | null) =>
      sql`insert into intent_cards (change_id, head_sha, prompt_version, input_hash, status, goal, failure_reason, risk_class, risk_floor, verifier_status,
            files_total, files_listed, files_full, files_partial, files_omitted, lines_added, lines_deleted, inputs_truncated)
          values (${change.id}, ${SHA}, 'v2', ${HASH}, ${status}, ${goal}, ${failure}, 'logic', 'trivial', 'skipped', 1, 1, 1, 0, 0, 1, 0, false)`.execute(
        db,
      );

    await expect(card("huge", SHA)).rejects.toThrow(/check constraint/);
    await expect(card("logic", "abc")).rejects.toThrow(/check constraint/);
    await expect(
      sql`insert into webhook_deliveries (delivery_id, event, status) values ('x', 'ping', 'done')`.execute(
        db,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(card("logic", SHA)).resolves.toBeDefined();
    await expect(card("logic", SHA)).rejects.toThrow(/duplicate key/);
    await expect(rawCard("maybe", "g", null)).rejects.toThrow(/check constraint/);
    await expect(rawCard("ok", null, null)).rejects.toThrow(/check constraint/);
    await expect(rawCard("unavailable", null, null)).rejects.toThrow(/check constraint/);
    await expect(rawCard("unavailable", null, "llm_timeout")).resolves.toBeDefined();

    const stored = await db
      .selectFrom("intent_cards")
      .select("id")
      .limit(1)
      .executeTakeFirstOrThrow();
    const fb = (verdict: string, source: string) =>
      sql`insert into intent_feedback (card_id, change_id, user_id, user_login, verdict, source, reacted_at)
          values (${stored.id}, ${change.id}, 7, 'u', ${verdict}, ${source}, now())`.execute(db);
    await expect(fb("meh", "reaction")).rejects.toThrow(/check constraint/);
    await expect(fb("up", "email")).rejects.toThrow(/check constraint/);
    await expect(fb("up", "reaction")).resolves.toBeDefined();
    await expect(fb("down", "reaction")).rejects.toThrow(/duplicate key/);
    await expect(fb("down", "check_action")).resolves.toBeDefined();

    await expect(
      sql`insert into provenance (change_id, source) values (${change.id}, 'foo')`.execute(db),
    ).rejects.toThrow(/check constraint/);
    const cpInsert = (kind: string, reason: string) =>
      sql`insert into change_provenance (change_id, head_sha, author_kind, author_kind_reason, commits_total, commits_scanned, commits_with_trailers, agent_coauthor_commits, computed_at)
          values (${change.id}, ${SHA}, ${kind}, ${reason}, 1, 1, 0, 0, now())`.execute(db);
    await expect(cpInsert("robot", "none")).rejects.toThrow(/check constraint/);
    await expect(cpInsert("agent", "x")).rejects.toThrow(/check constraint/);
    await expect(cpInsert("human", "none")).resolves.toBeDefined();
  });

  it("I-DB-7 0002 down then up succeeds; after down pr_body is rejected and change_provenance is gone", async () => {
    await sql`insert into installations (id, account_id, account_login, account_type, repository_selection) values (1, 1, 'a', 'User', 'all')`.execute(
      db,
    );
    await sql`insert into repositories (id, installation_id, full_name, private) values (2, 1, 'a/b', false)`.execute(
      db,
    );
    const change = await db
      .insertInto("changes")
      .values({
        repository_id: 2,
        pr_number: 1,
        pr_node_id: "n",
        task_id: null,
        head_sha: SHA,
        base_ref: "main",
        author_login: "x",
        state: "open",
        merge_commit_sha: null,
        opened_at: new Date(),
        closed_at: null,
        merged_at: null,
        pr_updated_at: null,
        graft_comment_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await sql`insert into provenance (change_id, source) values (${change.id}, 'pr_body')`.execute(
      db,
    );
    const migrator = createMigrator(db);
    try {
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0009_enforce");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0008_modes");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
        "0007_vote_eligibility",
      );
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0006_pilot");
      const down5 = await migrator.migrateDown();
      expect(down5.results?.[0]?.migrationName).toBe("0005_policy");
      const down4 = await migrator.migrateDown();
      expect(down4.results?.[0]?.migrationName).toBe("0004_intent_display_pending");
      const down3 = await migrator.migrateDown();
      expect(down3.results?.[0]?.migrationName).toBe("0003_intent");
      const down = await migrator.migrateDown();
      expect(down.error).toBeUndefined();
      expect(down.results?.[0]?.migrationName).toBe("0002_provenance");
      expect(await tableNames(db)).not.toContain("change_provenance");
      // The pr_body rows were deleted and the source check is back to ('trailer','mcp').
      const left = await sql<{ n: string }>`select count(*)::text n from provenance`.execute(db);
      expect(left.rows[0]?.n).toBe("0");
      await expect(
        sql`insert into provenance (change_id, source) values (${change.id}, 'pr_body')`.execute(
          db,
        ),
      ).rejects.toThrow(/check constraint/);
      const cols = await sql<{ column_name: string }>`
        select column_name from information_schema.columns where table_name = 'changes'`.execute(
        db,
      );
      expect(cols.rows.map((r) => r.column_name)).not.toContain("graft_comment_id");
    } finally {
      expect(await migrateToLatest(db)).toEqual([
        "0002_provenance",
        "0003_intent",
        "0004_intent_display_pending",
        "0005_policy",
        "0006_pilot",
        "0007_vote_eligibility",
        "0008_modes",
        "0009_enforce",
      ]);
    }
    expect(await tableNames(db)).toContain("change_provenance");
    await sql`insert into provenance (change_id, source) values (${change.id}, 'pr_body')`.execute(
      db,
    );
  });

  it("I-DB-8 0003 down then up: down restores the 0001 intent_cards and drops intent_feedback", async () => {
    const migrator = createMigrator(db);
    try {
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0009_enforce");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0008_modes");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
        "0007_vote_eligibility",
      );
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0006_pilot");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0005_policy");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
        "0004_intent_display_pending",
      );
      const down = await migrator.migrateDown();
      expect(down.error).toBeUndefined();
      expect(down.results?.[0]?.migrationName).toBe("0003_intent");
      expect(await tableNames(db)).not.toContain("intent_feedback");
      expect(await tableNames(db)).not.toContain("intent_spend");
      expect(await tableNames(db)).not.toContain("intent_displays");
      const cols = await sql<{ column_name: string; is_nullable: string }>`
        select column_name, is_nullable from information_schema.columns where table_name = 'intent_cards'`.execute(
        db,
      );
      const names = cols.rows.map((r) => r.column_name);
      expect(names).toContain("verifier_notes");
      expect(names).not.toContain("input_hash");
      expect(cols.rows.find((r) => r.column_name === "goal")?.is_nullable).toBe("NO");
      const uniques = await sql<{ def: string }>`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'intent_cards'::regclass and contype = 'u'`.execute(db);
      expect(uniques.rows.map((r) => r.def)).toEqual([
        "UNIQUE (change_id, head_sha, prompt_version)",
      ]);
    } finally {
      expect(await migrateToLatest(db)).toEqual([
        "0003_intent",
        "0004_intent_display_pending",
        "0005_policy",
        "0006_pilot",
        "0007_vote_eligibility",
        "0008_modes",
        "0009_enforce",
      ]);
    }
    expect(await tableNames(db)).toContain("intent_feedback");
    expect(await tableNames(db)).toContain("intent_spend");
    expect(await tableNames(db)).toContain("intent_displays");
    const cols = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_name = 'intent_cards'`.execute(
      db,
    );
    expect(cols.rows.map((r) => r.column_name)).toContain("input_hash");
  });

  it("I-DB-9 0004 up/down round trip; 0003 down works after intent_displays and intent_spend were dropped by hand", async () => {
    await sql`insert into installations (id, account_id, account_login, account_type, repository_selection) values (1, 1, 'a', 'User', 'all')`.execute(
      db,
    );
    await sql`insert into repositories (id, installation_id, full_name, private) values (2, 1, 'a/b', false)`.execute(
      db,
    );
    const change = await db
      .insertInto("changes")
      .values({
        repository_id: 2,
        pr_number: 1,
        pr_node_id: "n",
        task_id: null,
        head_sha: SHA,
        base_ref: "main",
        author_login: "x",
        state: "open",
        merge_commit_sha: null,
        opened_at: new Date(),
        closed_at: null,
        merged_at: null,
        pr_updated_at: null,
        graft_comment_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const card = await db
      .insertInto("intent_cards")
      .values({ change_id: change.id, ...OK_CARD })
      .returning("id")
      .executeTakeFirstOrThrow();
    const display = (status: string) =>
      sql`insert into intent_displays (change_id, card_id, status, shown_at) values (${change.id}, ${card.id}, ${status}, now())`.execute(
        db,
      );
    const migrator = createMigrator(db);
    try {
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0009_enforce");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0008_modes");
      // up: 'pending' is accepted, anything else is not
      await expect(display("pending")).resolves.toBeDefined();
      await expect(display("ok")).resolves.toBeDefined();
      await expect(display("bogus")).rejects.toThrow(/check constraint/);

      // down: pending rows are deleted, the old constraint is back
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
        "0007_vote_eligibility",
      );
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0006_pilot");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0005_policy");
      const down4 = await migrator.migrateDown();
      expect(down4.error).toBeUndefined();
      expect(down4.results?.[0]?.migrationName).toBe("0004_intent_display_pending");
      const left = await sql<{ status: string }>`select status from intent_displays`.execute(db);
      expect(left.rows.map((r) => r.status)).toEqual(["ok"]);
      await expect(display("pending")).rejects.toThrow(/check constraint/);

      // 0003 down on a database where the two tables are already gone
      await sql`drop table intent_displays`.execute(db);
      await sql`drop table intent_spend`.execute(db);
      const down3 = await migrator.migrateDown();
      expect(down3.error).toBeUndefined();
      expect(down3.results?.[0]?.migrationName).toBe("0003_intent");
    } finally {
      await migrateToLatest(db);
    }
    expect(await tableNames(db)).toContain("intent_displays");
    expect(await tableNames(db)).toContain("intent_spend");
  });

  it("I-DB-10 0005 applies; its rollback restores the 0001 policy_verdicts exactly; up again works", async () => {
    const policyColumns = async () =>
      (
        await sql<{ column_name: string; is_nullable: string; data_type: string }>`
          select column_name, is_nullable, data_type from information_schema.columns
          where table_name = 'policy_verdicts' order by column_name`.execute(db)
      ).rows.map((r) => `${r.column_name}:${r.data_type}:${r.is_nullable}`);
    const policyConstraints = async () =>
      (
        await sql<{ def: string }>`
          select pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = 'policy_verdicts'::regclass and contype in ('c', 'u') order by 1`.execute(
          db,
        )
      ).rows.map((r) => r.def);
    const policyIndexes = async () =>
      (
        await sql<{ indexdef: string }>`
          select indexdef from pg_indexes where tablename = 'policy_verdicts'
          and indexname = 'policy_verdicts_change_idx' order by 1`.execute(db)
      ).rows.map((r) => r.indexdef);

    // Up: the new shape.
    const upColumns = await policyColumns();
    expect(upColumns).toContain("policy_file_sha:text:YES");
    expect(upColumns).toContain("facts_read_at:timestamp with time zone:NO");
    expect(await policyIndexes()).toEqual([
      "CREATE INDEX policy_verdicts_change_idx ON public.policy_verdicts USING btree (change_id, facts_read_at DESC)",
    ]);
    const upConstraints = await policyConstraints();
    expect(upConstraints.some((d) => d.startsWith("UNIQUE NULLS NOT DISTINCT"))).toBe(true);

    const migrator = createMigrator(db);
    try {
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0009_enforce");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0008_modes");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
        "0007_vote_eligibility",
      );
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0006_pilot");
      const down = await migrator.migrateDown();
      expect(down.error).toBeUndefined();
      expect(down.results?.[0]?.migrationName).toBe("0005_policy");
      expect(await policyColumns()).toEqual(
        [
          "approvals_present:jsonb:NO",
          "approvals_required:jsonb:NO",
          "change_id:uuid:NO",
          "check_conclusion:text:YES",
          "check_run_id:bigint:YES",
          "created_at:timestamp with time zone:NO",
          "evaluated_at:timestamp with time zone:NO",
          "head_sha:text:NO",
          "id:uuid:NO",
          "mode:text:NO",
          "policy_sha:text:YES",
          "risk_class:text:YES",
          "rules_matched:jsonb:NO",
          "status:text:NO",
        ].sort(),
      );
      expect(await policyIndexes()).toEqual([
        "CREATE INDEX policy_verdicts_change_idx ON public.policy_verdicts USING btree (change_id, evaluated_at DESC)",
      ]);
      expect((await policyConstraints()).some((d) => d.includes("'pass'"))).toBe(true);
    } finally {
      expect(await migrateToLatest(db)).toEqual([
        "0005_policy",
        "0006_pilot",
        "0007_vote_eligibility",
        "0008_modes",
        "0009_enforce",
      ]);
    }
    expect(await policyColumns()).toEqual(upColumns);
    expect(await policyConstraints()).toEqual(upConstraints);
  });

  it("I-DB-10 0006 down then up keeps intent_spend rows with cost_usd NULL and drops the six tables", async () => {
    await sql`insert into installations (id, account_id, account_login, account_type, repository_selection) values (1, 1, 'a', 'User', 'all')`.execute(
      db,
    );
    await sql`insert into repositories (id, installation_id, full_name, private) values (2, 1, 'a/b', false)`.execute(
      db,
    );
    await sql`insert into intent_spend (repository_id, tokens, llm_calls, spent_at, cost_usd) values (2, 1500, 2, now(), 0.5)`.execute(
      db,
    );
    const stepSix = [
      "pr_reviewers",
      "review_time_runs",
      "review_time_prs",
      "incidents",
      "metrics_daily",
      "pilot_purges",
    ];
    for (const t of stepSix) expect(await tableNames(db), t).toContain(t);
    const migrator = createMigrator(db);
    try {
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0009_enforce");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0008_modes");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe(
        "0007_vote_eligibility",
      );
      const down = await migrator.migrateDown();
      expect(down.error).toBeUndefined();
      expect(down.results?.[0]?.migrationName).toBe("0006_pilot");
      for (const t of stepSix) expect(await tableNames(db), t).not.toContain(t);
      const cols = await sql<{ column_name: string }>`
        select column_name from information_schema.columns where table_name = 'intent_spend'`.execute(
        db,
      );
      expect(cols.rows.map((r) => r.column_name)).not.toContain("cost_usd");
      const left = await sql<{ tokens: number }>`select tokens from intent_spend`.execute(db);
      expect(left.rows.map((r) => r.tokens)).toEqual([1500]);
    } finally {
      expect(await migrateToLatest(db)).toEqual([
        "0006_pilot",
        "0007_vote_eligibility",
        "0008_modes",
        "0009_enforce",
      ]);
    }
    for (const t of stepSix) expect(await tableNames(db), t).toContain(t);
    const rows = await sql<{ tokens: number; cost_usd: string | null }>`
      select tokens, cost_usd from intent_spend`.execute(db);
    expect(rows.rows).toEqual([{ tokens: 1500, cost_usd: null }]);
  });

  it("I-DB-12 0007 down then up: a row stored before the column existed comes back unverified, and nothing is deleted", async () => {
    await sql`insert into installations (id, account_id, account_login, account_type, repository_selection) values (1, 1, 'a', 'User', 'all')`.execute(
      db,
    );
    await sql`insert into repositories (id, installation_id, full_name, private) values (2, 1, 'a/b', false)`.execute(
      db,
    );
    const change = await db
      .insertInto("changes")
      .values({
        repository_id: 2,
        pr_number: 1,
        pr_node_id: "n1",
        task_id: null,
        head_sha: "a".repeat(40),
        base_ref: "main",
        author_login: "x",
        state: "open",
        merge_commit_sha: null,
        opened_at: new Date("2026-10-01T00:00:00Z"),
        closed_at: null,
        merged_at: null,
        pr_updated_at: null,
        graft_comment_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const migrator = createMigrator(db);
    try {
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0009_enforce");
      expect((await migrator.migrateDown()).results?.[0]?.migrationName).toBe("0008_modes");
      const down = await migrator.migrateDown();
      expect(down.error).toBeUndefined();
      expect(down.results?.[0]?.migrationName).toBe("0007_vote_eligibility");
      const cols = await sql<{ column_name: string }>`
        select column_name from information_schema.columns where table_name = 'pr_reviewers'`.execute(
        db,
      );
      expect(cols.rows.map((r) => r.column_name)).not.toContain("verified");
      await sql`insert into pr_reviewers (change_id, user_id, reason, first_seen_at)
        values (${change.id}, 7, 'reviewed', now())`.execute(db);
    } finally {
      expect(await migrateToLatest(db)).toEqual([
        "0007_vote_eligibility",
        "0008_modes",
        "0009_enforce",
      ]);
    }
    const rows = await sql<{ user_id: number; verified: boolean }>`
      select user_id, verified from pr_reviewers`.execute(db);
    expect(rows.rows).toEqual([{ user_id: 7, verified: false }]);
  });

  it("I-DB-10 policy_verdicts constraints: hash iff ok, one row per (change, head, file), neutral default", async () => {
    await sql`insert into installations (id, account_id, account_login, account_type, repository_selection) values (1, 1, 'a', 'User', 'all')`.execute(
      db,
    );
    await sql`insert into repositories (id, installation_id, full_name, private) values (2, 1, 'a/b', false)`.execute(
      db,
    );
    const change = await db
      .insertInto("changes")
      .values({
        repository_id: 2,
        pr_number: 1,
        pr_node_id: "n",
        task_id: null,
        head_sha: SHA,
        base_ref: "main",
        author_login: "x",
        state: "open",
        merge_commit_sha: null,
        opened_at: new Date(),
        closed_at: null,
        merged_at: null,
        pr_updated_at: null,
        graft_comment_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const row = (over: Record<string, unknown> = {}) => ({
      change_id: change.id,
      head_sha: SHA,
      base_ref: "main",
      policy_commit_sha: SHA,
      policy_file_sha: null,
      policy_status: "missing" as const,
      policy_hash: null,
      outcome: "no_policy" as const,
      risk_class: null,
      risk_source: null,
      author_kind: null,
      facts_hash: HASH,
      facts_read_at: new Date(),
      check_run_id: null,
      published_at: null,
      evaluated_at: new Date(),
      ...over,
    });
    const inserted = await db
      .insertInto("policy_verdicts")
      .values(row())
      .returning(["check_conclusion", "mode"])
      .executeTakeFirstOrThrow();
    expect(inserted).toEqual({ check_conclusion: "neutral", mode: "report" });
    // NULL policy_file_sha is one identity (NULLS NOT DISTINCT).
    await expect(db.insertInto("policy_verdicts").values(row()).execute()).rejects.toThrow(
      /unique|duplicate/,
    );
    // policy_hash is set iff the status is ok.
    await expect(
      db
        .insertInto("policy_verdicts")
        .values(row({ policy_file_sha: SHA, policy_status: "ok", policy_hash: null }))
        .execute(),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db
        .insertInto("policy_verdicts")
        .values(row({ policy_file_sha: SHA, policy_status: "invalid", policy_hash: HASH }))
        .execute(),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db
        .insertInto("policy_verdicts")
        .values(row({ policy_file_sha: SHA, outcome: "would_maybe" as never }))
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it("I-DB-6 a bigint above 2^53 read through createDb throws", async () => {
    const d = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      await expect(sql`select 9007199254740993::bigint as v`.execute(d)).rejects.toThrow(
        /MAX_SAFE_INTEGER/,
      );
      const ok = await sql<{ v: number }>`select 9007199254740991::bigint as v`.execute(d);
      expect(ok.rows[0]?.v).toBe(9007199254740991);
    } finally {
      await d.destroy();
    }
  });
});
