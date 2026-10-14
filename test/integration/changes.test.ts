import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertChangeFromPull } from "../../src/modules/changes/index.js";
import { ensureRepository } from "../../src/modules/installations/index.js";
import { createTestApp, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";
import { fakeSha, makePull, REPO_ID } from "../helpers/github-builders.js";
import { seedWorld } from "../helpers/seed.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  await seedWorld(t.db);
});

const NOW = new Date("2026-10-14T12:00:00Z");
const changes = () => t.db.selectFrom("changes").selectAll().execute();

describe("changes store", () => {
  it("I-CHG-1 inserts every field; an open PR's test-merge SHA is not stored", async () => {
    const { change, applied } = await upsertChangeFromPull(
      t.db,
      REPO_ID,
      makePull({ merge_commit_sha: fakeSha(9), user: { login: "robot[bot]", type: "Bot" } }),
      NOW,
    );
    expect(applied).toBe(true);
    expect(change).toMatchObject({
      repository_id: REPO_ID,
      pr_number: 2,
      pr_node_id: "PR_fake2",
      head_sha: makePull().head.sha,
      base_ref: "main",
      author_login: "robot[bot]",
      author_is_bot: true,
      state: "open",
      merge_commit_sha: null,
      task_id: null,
      graft_comment_id: null,
      closed_at: null,
      merged_at: null,
    });
    expect(change.opened_at).toEqual(new Date("2026-10-14T10:00:00Z"));
    expect(change.pr_updated_at).toEqual(new Date("2026-10-14T11:00:00Z"));

    const ghost = await upsertChangeFromPull(
      t.db,
      REPO_ID,
      makePull({ number: 3, user: null }),
      NOW,
    );
    expect(ghost.change).toMatchObject({ author_login: "ghost", author_is_bot: false });
  });

  it("I-CHG-2 an older snapshot is not applied; an equal one is (idempotent)", async () => {
    await upsertChangeFromPull(
      t.db,
      REPO_ID,
      makePull({ updated_at: "2026-10-14T11:00:00Z" }),
      NOW,
    );
    const older = await upsertChangeFromPull(
      t.db,
      REPO_ID,
      makePull({ updated_at: "2026-10-14T10:30:00Z", head: { sha: fakeSha(7) }, body: "x" }),
      NOW,
    );
    expect(older.applied).toBe(false);
    expect(older.change.head_sha).toBe(makePull().head.sha);
    expect((await changes())[0]?.head_sha).toBe(makePull().head.sha);

    const equal = await upsertChangeFromPull(
      t.db,
      REPO_ID,
      makePull({ updated_at: "2026-10-14T11:00:00Z", head: { sha: fakeSha(8) } }),
      NOW,
    );
    expect(equal.applied).toBe(true);
    expect(equal.change.head_sha).toBe(fakeSha(8));

    const newer = await upsertChangeFromPull(
      t.db,
      REPO_ID,
      makePull({ updated_at: "2026-10-14T12:30:00Z", head: { sha: fakeSha(9) } }),
      NOW,
    );
    expect(newer.applied).toBe(true);
    expect(await changes()).toHaveLength(1);
  });

  it("I-CHG-3 a merged pull stores state merged, the merge commit and merged_at", async () => {
    const { change } = await upsertChangeFromPull(
      t.db,
      REPO_ID,
      makePull({
        state: "closed",
        merged: true,
        merge_commit_sha: fakeSha(5),
        closed_at: "2026-10-14T11:30:00Z",
        merged_at: "2026-10-14T11:30:00Z",
        updated_at: "2026-10-14T11:30:00Z",
      }),
      NOW,
    );
    expect(change).toMatchObject({ state: "merged", merge_commit_sha: fakeSha(5) });
    expect(change.merged_at).toEqual(new Date("2026-10-14T11:30:00Z"));
    expect(change.closed_at).toEqual(new Date("2026-10-14T11:30:00Z"));

    const closed = await upsertChangeFromPull(
      t.db,
      REPO_ID,
      makePull({
        number: 4,
        state: "closed",
        merge_commit_sha: fakeSha(6),
        closed_at: "2026-10-14T11:00:00Z",
      }),
      NOW,
    );
    expect(closed.change).toMatchObject({ state: "closed", merge_commit_sha: null });
  });

  it("I-CHG-4 ensureRepository inserts a missing row, leaves a removed one alone, updates a renamed one", async () => {
    const repo = {
      id: 2000002,
      full_name: "graft-sandbox/sample-py",
      private: true,
      default_branch: "main",
    };
    expect(await ensureRepository(t.db, 1000001, repo, NOW)).toBe("active");
    const row = await t.db
      .selectFrom("repositories")
      .selectAll()
      .where("id", "=", 2000002)
      .executeTakeFirst();
    expect(row).toMatchObject({
      full_name: "graft-sandbox/sample-py",
      removed_at: null,
      default_branch: "main",
    });

    await t.db
      .updateTable("repositories")
      .set({ removed_at: NOW })
      .where("id", "=", 2000002)
      .execute();
    expect(
      await ensureRepository(t.db, 1000001, { ...repo, full_name: "graft-sandbox/renamed" }, NOW),
    ).toBe("removed");
    const removed = await t.db
      .selectFrom("repositories")
      .selectAll()
      .where("id", "=", 2000002)
      .executeTakeFirst();
    expect(removed).toMatchObject({ full_name: "graft-sandbox/sample-py", removed_at: NOW });

    expect(
      await ensureRepository(
        t.db,
        1000001,
        {
          id: REPO_ID,
          full_name: "graft-sandbox/sample-renamed",
          private: false,
          default_branch: "dev",
        },
        NOW,
      ),
    ).toBe("active");
    const renamed = await t.db
      .selectFrom("repositories")
      .selectAll()
      .where("id", "=", REPO_ID)
      .executeTakeFirst();
    expect(renamed).toMatchObject({
      full_name: "graft-sandbox/sample-renamed",
      private: false,
      default_branch: "dev",
    });
  });
});
