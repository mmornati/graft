import { type Kysely, sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client.js";
import { createMigrator, migrateDown, migrateToLatest } from "../../src/db/migrator.js";
import { type Database, TABLE_NAMES } from "../../src/db/schema.js";
import { TEST_DATABASE_URL } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";

const db = testDb();
const SHA = "a".repeat(40);

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
  it("I-DB-1 after migration, the ten tables exist", async () => {
    const names = await tableNames(db);
    for (const t of TABLE_NAMES) expect(names).toContain(t);
    expect(TABLE_NAMES).toHaveLength(10);
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
      const after = await tableNames(db);
      for (const t of TABLE_NAMES) expect(after).not.toContain(t);

      const marker = await sql<{
        n: string;
      }>`select count(*)::text n from pgboss.i_db_2_marker`.execute(db);
      expect(marker.rows[0]?.n).toBe("1");

      expect(await migrateToLatest(db)).toEqual(["0001_initial", "0002_provenance"]);
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
        change_id: change.id,
        head_sha: SHA,
        prompt_version: "v1",
        goal: "g",
        behavior_changes: JSON.stringify(["a"]),
        out_of_scope_edits: JSON.stringify(["docs/x.md"]),
        risk_class: "logic",
        risk_floor: "trivial",
        model_risk_class: "logic",
        verifier_status: "agree",
        verifier_notes: null,
        writer_model: "w",
        verifier_model: "v",
        input_tokens: 1,
        output_tokens: 2,
        comment_id: 99,
        check_run_id: null,
      })
      .returning(["id", "behavior_changes", "comment_id"])
      .executeTakeFirstOrThrow();
    expect(card.behavior_changes).toEqual(["a"]);
    expect(card.comment_id).toBe(99);
    await db
      .insertInto("policy_verdicts")
      .values({
        change_id: change.id,
        head_sha: SHA,
        policy_sha: null,
        mode: "report",
        status: "pass",
        check_conclusion: "success",
        risk_class: "logic",
        check_run_id: null,
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

    const card = (risk: string, sha: string) =>
      sql`insert into intent_cards (change_id, head_sha, prompt_version, goal, risk_class, risk_floor, verifier_status, writer_model)
          values (${change.id}, ${sha}, 'v', 'g', ${risk}, 'trivial', 'pending', 'w')`.execute(db);

    await expect(card("huge", SHA)).rejects.toThrow(/check constraint/);
    await expect(card("logic", "abc")).rejects.toThrow(/check constraint/);
    await expect(
      sql`insert into webhook_deliveries (delivery_id, event, status) values ('x', 'ping', 'done')`.execute(
        db,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(card("logic", SHA)).resolves.toBeDefined();

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
      expect(await migrateToLatest(db)).toEqual(["0002_provenance"]);
    }
    expect(await tableNames(db)).toContain("change_provenance");
    await sql`insert into provenance (change_id, source) values (${change.id}, 'pr_body')`.execute(
      db,
    );
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
