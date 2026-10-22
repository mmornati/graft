import { userInfo } from "node:os";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import { migrateDownOne, migrateToLatest } from "../../src/db/migrator.js";
import { trackInstallations } from "../../src/modules/installations/handlers.js";
import {
  applyModeChanges,
  CEILING_STATE_KEY,
  claimUnappliedModeChanges,
  fanoutCeilingChange,
  getEffectiveModes,
  getServiceState,
  mutationGate,
  publishModeCeiling,
  refreshPermissions,
} from "../../src/modules/modes/index.js";
import { evaluatePolicyJobRun } from "../../src/modules/policy/job.js";
import type { PolicyView } from "../../src/modules/policy/render.js";
import { purgeInstallation } from "../../src/pilot/purge.js";
import { clearPolicyCache } from "../../src/policy/load.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture } from "../helpers/fixtures.js";
import { INSTALLATION_ID, OWNER, REPO, REPO_ID } from "../helpers/github-builders.js";
import { addDelivery } from "../helpers/pilot-seed.js";
import { EVAL_DATA, jobsNamed, loadPolicyScenario } from "../helpers/policy-scenario.js";
import { seedWorld } from "../helpers/seed.js";

// I-MODE-10 needs to tell the effect of the facts hash from the effect of the rendered text, so the
// details can be frozen for one test; every other test sees the real renderer.
const frozen = vi.hoisted(() => ({ details: null as string | null }));
vi.mock("../../src/modules/policy/render.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/modules/policy/render.js")>();
  return {
    ...real,
    renderPolicyDetails: (v: PolicyView) => frozen.details ?? real.renderPolicyDetails(v),
  };
});

const EARLIER = new Date(FIXED_NOW.getTime() - 60_000);
const FULL_NAME = `${OWNER}/${REPO}`;
const SECOND_REPO_ID = 2000002;

let t: TestApp;
let api: FakeGitHubApi;
let ceiling: "report" | "enforce";
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  await sql`delete from pgboss.schedule`.execute(t.db);
  await seedWorld(t.db);
  clearPolicyCache();
  frozen.details = null;
  ceiling = "report";
  api = createFakeGitHubApi();
  t.deps.github = fakeGitHubFactory(api);
});

const deps = (): OpsDeps => ({
  loadConfig: () => testConfig({ GRAFT_MODE_CEILING: ceiling }),
  openDb: () => testDb(),
  github: () => fakeGitHubFactory(api),
  now: () => FIXED_NOW,
  sleep: async () => {},
});
const run = async (...argv: string[]) => {
  let out = "";
  let err = "";
  const code = await opsMain(argv, { out: (s) => (out += s), err: (s) => (err += s) }, deps());
  return { code, out, err };
};
const set = (...flags: string[]) =>
  run("mode", "set", "--repo", FULL_NAME, "--actor", "tester", ...flags);
const rows = () => t.db.selectFrom("mode_changes").selectAll().orderBy("created_at").execute();
const repoRow = () =>
  t.db.selectFrom("repositories").selectAll().where("id", "=", REPO_ID).executeTakeFirstOrThrow();
const ctxWith = (over: Record<string, string>, nowMs = FIXED_NOW.getTime()) => ({
  ...jobContext(t),
  config: testConfig(over),
  clock: { now: () => new Date(nowMs) },
});

async function addSecondRepository(): Promise<void> {
  await t.db
    .insertInto("repositories")
    .values({
      id: SECOND_REPO_ID,
      installation_id: INSTALLATION_ID,
      full_name: `${OWNER}/sample-py`,
      private: true,
      default_branch: "main",
    })
    .execute();
}

describe("modes: schema", () => {
  it("I-MODE-1 migration 0008 down removes exactly what it added, then up restores it", async () => {
    await truncateAll(t.db);
    // Step 2's, step 3's and step 4's migrations sit on top of 0008.
    expect(await migrateDownOne(t.db)).toEqual(["0011_guard"]);
    expect(await migrateDownOne(t.db)).toEqual(["0010_audit_log"]);
    expect(await migrateDownOne(t.db)).toEqual(["0009_enforce"]);
    expect(await migrateDownOne(t.db)).toEqual(["0008_modes"]);
    try {
      const cols = await sql<{ table_name: string; column_name: string }>`
        select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and (table_name in ('mode_changes', 'service_state')
            or column_name in ('policy_mode', 'guard_mode', 'mcp_write', 'permissions', 'permissions_read_at'))`.execute(
        t.db,
      );
      expect(cols.rows).toEqual([]);
    } finally {
      expect(await migrateToLatest(t.db)).toEqual([
        "0008_modes",
        "0009_enforce",
        "0010_audit_log",
        "0011_guard",
      ]);
    }
    await seedWorld(t.db);
    const r = await repoRow();
    expect([r.policy_mode, r.guard_mode, r.mcp_write]).toEqual(["report", "report", "off"]);
    await expect(sql`update repositories set guard_mode = 'maybe'`.execute(t.db)).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      sql`insert into mode_changes (repository_id, key, from_value, to_value, actor, reason)
        values (${REPO_ID}, 'mcp_write', 'report', 'enforce', 'a', 'b')`.execute(t.db),
    ).rejects.toThrow(/check constraint/);
    await expect(
      sql`insert into mode_changes (repository_id, key, from_value, to_value, actor, reason)
        values (${REPO_ID}, 'policy_mode', 'report', 'report', 'a', 'b')`.execute(t.db),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("modes: the operator CLI", () => {
  it("I-MODE-2 mode set writes one audit row and the column; the same call again is no change", async () => {
    const first = await run(
      "mode",
      "set",
      "--repo",
      FULL_NAME,
      "--policy",
      "enforce",
      "--reason",
      "r",
    );
    expect(first.code, first.err).toBe(0);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      repository_id: REPO_ID,
      key: "policy_mode",
      from_value: "report",
      to_value: "enforce",
      actor: userInfo().username,
      reason: "r",
      applied_at: null,
    });
    expect((await repoRow()).policy_mode).toBe("enforce");
    // The requested value is recorded even though the ceiling keeps it from being effective.
    expect(first.out).toContain("requested enforce  effective report   ceiling");
    expect(first.out).toContain("note: policy is requested enforce but effective report (ceiling)");

    const again = await run(
      "mode",
      "set",
      "--repo",
      FULL_NAME,
      "--policy",
      "enforce",
      "--reason",
      "r",
    );
    expect(again.code).toBe(0);
    expect(again.out).toBe("no change\n");
    expect(await rows()).toHaveLength(1);

    // Several keys at once: one row per key that changes.
    const both = await set(
      "--policy",
      "report",
      "--guard",
      "enforce",
      "--mcp-write",
      "on",
      "--reason",
      "x",
    );
    expect(both.code, both.err).toBe(0);
    // All rows share one clock reading, so compare them in a fixed order.
    const keyed = (await rows())
      .map((r) => [r.key, r.from_value, r.to_value, r.actor])
      .sort((a, b) => a.join().localeCompare(b.join()));
    expect(keyed).toEqual(
      [
        ["policy_mode", "report", "enforce", userInfo().username],
        ["policy_mode", "enforce", "report", "tester"],
        ["guard_mode", "report", "enforce", "tester"],
        ["mcp_write", "off", "on", "tester"],
      ].sort((a, b) => (a as string[]).join().localeCompare((b as string[]).join())),
    );
  });

  it("I-MODE-3 usage errors exit 2 and write nothing", async () => {
    const base = ["mode", "set", "--repo", FULL_NAME, "--actor", "tester"];
    const cases: string[][] = [
      [...base, "--reason", "why"],
      [...base, "--policy", "enforce"],
      [...base, "--policy", "enforce", "--reason", "x".repeat(201)],
      [...base, "--policy", "enforce", "--reason", "two\nlines"],
      [...base, "--policy", "enforce", "--reason", "esc\u001b[31m"],
      [...base, "--policy", "enforce", "--reason", ""],
      [
        "mode",
        "set",
        "--repo",
        FULL_NAME,
        "--policy",
        "enforce",
        "--reason",
        "r",
        "--actor",
        "bad actor",
      ],
      [
        "mode",
        "set",
        "--repo",
        FULL_NAME,
        "--policy",
        "enforce",
        "--reason",
        "r",
        "--actor",
        "a".repeat(65),
      ],
      [...base, "--policy", "on", "--reason", "r"],
      [...base, "--mcp-write", "enforce", "--reason", "r"],
      ["mode", "set", "--policy", "enforce", "--reason", "r"],
      ["mode", "set", "--repo", "not-a-repo", "--policy", "enforce", "--reason", "r"],
      ["mode", "show"],
      ["mode", "show", "--repo", FULL_NAME, "--installation", "1"],
      ["mode", "history", "--repo", FULL_NAME, "--limit", "201"],
      ["mode", "nope"],
    ];
    for (const argv of cases) {
      const res = await run(...argv);
      expect(res.code, argv.join(" ")).toBe(2);
      expect(res.out).toBe("");
    }
    expect(await rows()).toEqual([]);
    expect((await repoRow()).policy_mode).toBe("report");
    // 200 characters is fine.
    const ok = await set("--policy", "enforce", "--reason", "x".repeat(200));
    expect(ok.code, ok.err).toBe(0);
  });

  it("I-MODE-4 mode set on a removed or unknown repository exits 1 and writes nothing", async () => {
    await t.db.updateTable("repositories").set({ removed_at: FIXED_NOW }).execute();
    const removed = await set("--policy", "enforce", "--reason", "r");
    expect(removed.code).toBe(1);
    expect(removed.err).toBe("unknown or removed repository\n");
    const unknown = await run(
      "mode",
      "set",
      "--repo",
      "nobody/nothing",
      "--policy",
      "enforce",
      "--reason",
      "r",
    );
    expect(unknown.code).toBe(1);
    expect(await rows()).toEqual([]);
    expect((await repoRow()).policy_mode).toBe("report");
  });

  it("I-MODE-4b mode set refuses a name that matches active rows of two installations", async () => {
    await t.db
      .insertInto("installations")
      .values({
        id: 1000010,
        account_id: 10,
        account_login: "dup",
        account_type: "Organization",
        repository_selection: "selected",
      })
      .execute();
    await t.db
      .insertInto("repositories")
      .values({ id: 2000010, installation_id: 1000010, full_name: FULL_NAME, private: true })
      .execute();
    const r = await set("--policy", "enforce", "--reason", "r");
    expect(r.code).toBe(1);
    expect(r.err).toContain("ambiguous repository");
    expect(r.err).toContain("1000010");
    expect(await rows()).toEqual([]);
    expect((await repoRow()).policy_mode).toBe("report");
  });

  async function seedShow() {
    await t.db
      .updateTable("installations")
      .set({
        permissions: JSON.stringify({
          pull_requests: "write",
          checks: "write",
          metadata: "read",
          contents: "read",
          issues: "read",
        }),
        permissions_read_at: new Date("2026-10-20T03:30:00Z"),
      })
      .execute();
    await t.db
      .insertInto("service_state")
      .values({
        key: "mode_ceiling",
        value: "report",
        updated_at: new Date("2026-10-20T10:00:00Z"),
      })
      .execute();
    expect((await set("--policy", "enforce", "--reason", "r")).code).toBe(0);
  }
  const SHOW = [
    `${FULL_NAME} (repository ${REPO_ID}, installation ${INSTALLATION_ID})`,
    "  ceiling    report  (worker: report since 2026-10-20T10:00:00Z)",
    "  policy     requested enforce  effective report   ceiling",
    "  guard      requested report   effective report",
    "  mcp_write  requested off      effective off",
    "  permissions  checks:write contents:read issues:read metadata:read pull_requests:write  (read 2026-10-20T03:30:00Z)",
    // Phase 1 step 4: no statuses:read.
    "  note: guard reads check runs only (no statuses:read)",
    "  pending    1 change not yet applied by the worker",
    "",
  ].join("\n");

  it("I-MODE-5 mode show prints the block literally; warns when shell and worker differ; --json has the shape", async () => {
    await seedShow();
    const shown = await run("mode", "show", "--repo", FULL_NAME);
    expect(shown.code).toBe(0);
    expect(shown.out).toBe(SHOW);
    expect((await run("mode", "show", "--installation", String(INSTALLATION_ID))).out).toBe(SHOW);

    ceiling = "enforce";
    const differ = await run("mode", "show", "--repo", FULL_NAME);
    expect(differ.code).toBe(0);
    expect(differ.out).toBe(
      `warning: this shell's GRAFT_MODE_CEILING is enforce; the worker runs with report\n${SHOW}`,
    );

    const json = JSON.parse((await run("mode", "show", "--repo", FULL_NAME, "--json")).out);
    expect(json).toEqual({
      repositories: [
        {
          fullName: FULL_NAME,
          repositoryId: REPO_ID,
          installationId: INSTALLATION_ID,
          ceiling: "report",
          ceilingSource: "worker",
          policy: { requested: "enforce", effective: "report", reason: "ceiling" },
          guard: { requested: "report", effective: "report", reason: "repository" },
          mcpWrite: { requested: "off", effective: "off", reason: "repository" },
          permissions: {
            pull_requests: "write",
            checks: "write",
            metadata: "read",
            contents: "read",
            issues: "read",
          },
          permissionsReadAt: "2026-10-20T03:30:00.000Z",
          pendingChanges: 1,
        },
      ],
    });
  });

  it("I-MODE-5b without a worker value the shell's ceiling is used and the line says so; a missing permission names it", async () => {
    ceiling = "enforce";
    await t.db
      .updateTable("installations")
      .set({
        permissions: JSON.stringify({ contents: "read", pull_requests: "write" }),
        permissions_read_at: new Date("2026-10-20T03:30:00Z"),
      })
      .execute();
    const res = await set("--guard", "enforce", "--reason", "r");
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain(
      "  ceiling    enforce  (worker: not seen; using this shell's GRAFT_MODE_CEILING)",
    );
    expect(res.out).toContain(
      "  guard      requested enforce  effective report   permission_missing contents:write",
    );
    expect(res.out).toContain(
      "note: guard is requested enforce but effective report (permission_missing contents:write)",
    );
    expect(res.out).not.toContain("warning:");
    // Never read: the permissions line says so.
    await t.db.updateTable("installations").set({ permissions_read_at: null }).execute();
    const unread = await run("mode", "show", "--repo", FULL_NAME);
    expect(unread.out).toContain("  permissions  not read");
    expect(unread.out).toContain("permissions_unknown");
  });

  it("mode history lists newest first with applied or pending, terminal-safe", async () => {
    await set("--policy", "enforce", "--reason", "first");
    await set("--policy", "report", "--reason", "second");
    await t.db
      .updateTable("mode_changes")
      .set({ applied_at: FIXED_NOW, created_at: EARLIER })
      .where("reason", "=", "first")
      .execute();
    await t.db
      .updateTable("mode_changes")
      .set({ reason: "bell\u0007here" })
      .where("reason", "=", "second")
      .execute();
    const res = await run("mode", "history", "--repo", FULL_NAME);
    expect(res.code).toBe(0);
    const lines = res.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `${FIXED_NOW.toISOString()}  policy_mode  enforce → report  tester  pending  bell[U+0007]here`,
    );
    expect(lines[1]).toBe(
      `${EARLIER.toISOString()}  policy_mode  report → enforce  tester  applied  first`,
    );
    expect(
      JSON.parse((await run("mode", "history", "--repo", FULL_NAME, "--limit", "1", "--json")).out),
    ).toHaveLength(1);
  });

  it("mode refresh-permissions stores the API's answer for one installation", async () => {
    api.state.installationPermissions = { checks: "write", contents: "read" };
    const res = await run("mode", "refresh-permissions", "--installation", String(INSTALLATION_ID));
    expect(res.code, res.err).toBe(0);
    expect(res.out).toBe("permissions: checks:write contents:read\n");
    const inst = await t.db.selectFrom("installations").selectAll().executeTakeFirstOrThrow();
    expect(inst.permissions).toEqual({ checks: "write", contents: "read" });
    expect(inst.permissions_read_at).toEqual(FIXED_NOW);
    api.state.installationPermissions = null;
    const gone = await run(
      "mode",
      "refresh-permissions",
      "--installation",
      String(INSTALLATION_ID),
    );
    expect(gone.code).toBe(1);
  });
});

describe("modes: applying changes", () => {
  async function seedChanges() {
    await addSecondRepository();
    const insert = (repositoryId: number, key: string, from: string, to: string, at: number) =>
      sql`insert into mode_changes (repository_id, key, from_value, to_value, actor, reason, created_at)
        values (${repositoryId}, ${key}, ${from}, ${to}, 'op', 'seed', ${new Date(FIXED_NOW.getTime() + at)})`.execute(
        t.db,
      );
    await insert(REPO_ID, "policy_mode", "report", "enforce", 1);
    await insert(REPO_ID, "policy_mode", "enforce", "report", 2);
    await insert(REPO_ID, "guard_mode", "report", "enforce", 3);
    await insert(SECOND_REPO_ID, "guard_mode", "report", "enforce", 4);
    await insert(SECOND_REPO_ID, "policy_mode", "report", "enforce", 5);
  }
  const fanouts = async () =>
    (await jobsNamed(t.db, "policy.fanout")).map((j) => j.data as Record<string, unknown>);

  it("I-MODE-6 modes.apply sends one repository fan-out per repository with policy rows and marks every row applied", async () => {
    await seedChanges();
    const res = await applyModeChanges(jobContext(t));
    expect(res).toEqual({ claimed: 5, fanouts: 2 });
    const all = await rows();
    expect(all.every((r) => r.applied_at !== null)).toBe(true);
    const newest = (repo: number) =>
      all.filter((r) => r.repository_id === repo && r.key === "policy_mode").at(-1)?.id;
    const sent = (await fanouts()).sort((a, b) => Number(a.repositoryId) - Number(b.repositoryId));
    expect(sent).toEqual([
      {
        scope: "repository",
        installationId: INSTALLATION_ID,
        repositoryId: REPO_ID,
        owner: OWNER,
        repo: REPO,
        reason: "mode_change",
        changeId: newest(REPO_ID),
        ceilingAt: null,
      },
      {
        scope: "repository",
        installationId: INSTALLATION_ID,
        repositoryId: SECOND_REPO_ID,
        owner: OWNER,
        repo: "sample-py",
        reason: "mode_change",
        changeId: newest(SECOND_REPO_ID),
        ceilingAt: null,
      },
    ]);
    // Nothing left: a second run does nothing.
    expect(await applyModeChanges(jobContext(t))).toEqual({ claimed: 0, fanouts: 0 });
    expect(await fanouts()).toHaveLength(2);
  });

  it("I-MODE-6b a guard-only change sends nothing; a removed repository or inactive installation is marked applied without a fan-out", async () => {
    await seedChanges();
    await t.db
      .updateTable("repositories")
      .set({ removed_at: FIXED_NOW })
      .where("id", "=", SECOND_REPO_ID)
      .execute();
    await t.db
      .deleteFrom("mode_changes")
      .where("key", "=", "policy_mode")
      .where("repository_id", "=", REPO_ID)
      .execute();
    const res = await applyModeChanges(jobContext(t));
    expect(res).toEqual({ claimed: 3, fanouts: 0 });
    expect(await fanouts()).toEqual([]);
    expect((await rows()).every((r) => r.applied_at !== null)).toBe(true);
  });

  it("I-MODE-6c two concurrent claims take disjoint rows (SKIP LOCKED); two concurrent runs send each fan-out once", async () => {
    await seedChanges();
    const first = t.db.transaction().execute(async (tx1) => {
      const mine = await claimUnappliedModeChanges(tx1, 2);
      // The second transaction runs while the first still holds its rows.
      const theirs = await t.db.transaction().execute((tx2) => claimUnappliedModeChanges(tx2, 50));
      return { mine, theirs };
    });
    const { mine, theirs } = await first;
    expect(mine).toHaveLength(2);
    expect(theirs).toHaveLength(3);
    const ids = new Set([...mine, ...theirs].map((r) => r.id));
    expect(ids.size).toBe(5);

    const [a, b] = await Promise.all([
      applyModeChanges(jobContext(t)),
      applyModeChanges(jobContext(t)),
    ]);
    expect(a.claimed + b.claimed).toBe(5);
    expect(a.fanouts + b.fanouts).toBeGreaterThanOrEqual(2);
    expect((await fanouts()).length).toBe(2);
  });

  it("I-MODE-7 a ceiling change at worker start gives one fan-out per active repository; two workers together give one set; the first start gives none", async () => {
    await addSecondRepository();
    // A removed repository and a suspended installation get nothing.
    await t.db
      .insertInto("repositories")
      .values({
        id: 2000003,
        installation_id: INSTALLATION_ID,
        full_name: `${OWNER}/gone`,
        private: true,
        removed_at: FIXED_NOW,
      })
      .execute();
    await t.db
      .insertInto("installations")
      .values({
        id: 1000009,
        account_id: 9,
        account_login: "other",
        account_type: "Organization",
        repository_selection: "selected",
        suspended_at: FIXED_NOW,
      })
      .execute();
    await t.db
      .insertInto("repositories")
      .values({ id: 2000009, installation_id: 1000009, full_name: "other/app", private: true })
      .execute();
    const ceilingJobs = () => jobsNamed(t.db, "modes.ceiling_fanout");

    expect(await publishModeCeiling(ctxWith({ GRAFT_MODE_CEILING: "report" }))).toBe("stored");
    expect(await ceilingJobs()).toEqual([]);
    expect(await publishModeCeiling(ctxWith({ GRAFT_MODE_CEILING: "report" }))).toBe("unchanged");
    expect(await ceilingJobs()).toEqual([]);

    const up = ctxWith({ GRAFT_MODE_CEILING: "enforce" }, FIXED_NOW.getTime() + 1000);
    const results = await Promise.all([publishModeCeiling(up), publishModeCeiling(up)]);
    expect(results.sort()).toEqual(["changed", "unchanged"]);
    const queued = await ceilingJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data).toEqual({ at: FIXED_NOW.getTime() + 1000 });

    expect(await fanoutCeilingChange(queued[0]?.data as { at: number }, jobContext(t))).toBe(2);
    const sent = (await fanouts()).sort((x, y) => Number(x.repositoryId) - Number(y.repositoryId));
    expect(sent.map((s) => [s.repositoryId, s.reason, s.changeId, s.scope])).toEqual([
      [REPO_ID, "ceiling_change", null, "repository"],
      [SECOND_REPO_ID, "ceiling_change", null, "repository"],
    ]);
    // Going back is a change too, and its fan-out is not swallowed by the first one's keys.
    const down = ctxWith({ GRAFT_MODE_CEILING: "report" }, FIXED_NOW.getTime() + 5000);
    expect(await publishModeCeiling(down)).toBe("changed");
    expect(await ceilingJobs()).toHaveLength(2);
    const again = ctxWith({ GRAFT_MODE_CEILING: "enforce" }, FIXED_NOW.getTime() + 9000);
    expect(await publishModeCeiling(again)).toBe("changed");
    expect(await ceilingJobs()).toHaveLength(3);
  });

  it("I-MODE-7 an enqueue that fails leaves the stored ceiling unchanged, so the next start still fans out", async () => {
    expect(await publishModeCeiling(ctxWith({ GRAFT_MODE_CEILING: "report" }))).toBe("stored");
    const failing = {
      ...ctxWith({ GRAFT_MODE_CEILING: "enforce" }, FIXED_NOW.getTime() + 1000),
      queue: {
        ...jobContext(t).queue,
        send: async () => {
          throw new Error("queue down");
        },
      },
    } as never;
    await expect(publishModeCeiling(failing)).rejects.toThrow("queue down");
    expect((await getServiceState(t.db, CEILING_STATE_KEY))?.value).toBe("report");
    expect(await jobsNamed(t.db, "modes.ceiling_fanout")).toEqual([]);
    const retry = ctxWith({ GRAFT_MODE_CEILING: "enforce" }, FIXED_NOW.getTime() + 2000);
    expect(await publishModeCeiling(retry)).toBe("changed");
    expect(await jobsNamed(t.db, "modes.ceiling_fanout")).toHaveLength(1);
    expect(await publishModeCeiling(retry)).toBe("unchanged");
  });
});

describe("modes: installation permissions", () => {
  const refreshJobs = () => jobsNamed(t.db, "installations.refresh_permissions");

  it("I-MODE-8 installation.created enqueues a refresh; the stored permissions come from the API, not the payload", async () => {
    await truncateAll(t.db);
    const { event, payload } = loadFixture("installation.created");
    const fromPayload = (payload.installation as { permissions?: unknown }).permissions;
    api.state.installationPermissions = { checks: "write", contents: "write", members: "read" };
    expect(fromPayload).not.toEqual(api.state.installationPermissions);
    await trackInstallations.handle(
      { id: "d-1", deliveryId: "d-1", name: event, payload } as never,
      jobContext(t),
    );

    const queued = await refreshJobs();
    expect(queued).toHaveLength(1);
    // IDs only: the payload's permissions are not copied into the job.
    expect(queued[0]?.data).toEqual({ installationId: INSTALLATION_ID });
    expect(
      (await t.db.selectFrom("installations").selectAll().executeTakeFirstOrThrow())
        .permissions_read_at,
    ).toBeNull();

    // A second delivery within the minute is deduplicated.
    await trackInstallations.handle(
      { id: "d-2", deliveryId: "d-2", name: event, payload } as never,
      jobContext(t),
    );
    expect(await refreshJobs()).toHaveLength(1);

    const stored = await refreshPermissions(
      queued[0]?.data as { installationId: number },
      jobContext(t),
    );
    expect(stored).toEqual({ checks: "write", contents: "write", members: "read" });
    const inst = await t.db.selectFrom("installations").selectAll().executeTakeFirstOrThrow();
    expect(inst.permissions).toEqual({ checks: "write", contents: "write", members: "read" });
    expect(inst.permissions_read_at).toEqual(FIXED_NOW);
  });

  it("new_permissions_accepted enqueues a refresh too; deleted, suspend and unsuspend do not", async () => {
    for (const name of [
      "installation.created",
      "installation.deleted",
      "installation.suspend",
      "installation.unsuspend",
    ]) {
      await t.db.deleteFrom("installations").execute();
      await sql`delete from pgboss.job where name = 'installations.refresh_permissions'`.execute(
        t.db,
      );
      const { event, payload } = loadFixture(name);
      await trackInstallations.handle(
        { id: name, deliveryId: name, name: event, payload } as never,
        jobContext(t),
      );
      expect(await refreshJobs(), name).toHaveLength(name === "installation.created" ? 1 : 0);
    }
    await sql`delete from pgboss.job where name = 'installations.refresh_permissions'`.execute(
      t.db,
    );
    const { event, payload } = loadFixture("installation.new_permissions_accepted");
    await trackInstallations.handle(
      { id: "n", deliveryId: "n", name: event, payload } as never,
      jobContext(t),
    );
    expect(await refreshJobs()).toHaveLength(1);
  });

  it("I-MODE-9 the refresh drops unknown values, names that fail the pattern and entries past 100", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 120; i++)
      many[
        `perm_${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`
      ] = "read";
    api.state.installationPermissions = {
      contents: "write",
      pull_requests: "maybe",
      "Bad-Name": "read",
      has_digit1: "read",
      ["x".repeat(65)]: "read",
      checks: "admin",
      empty: "",
      ...many,
    };
    const stored = await refreshPermissions({ installationId: INSTALLATION_ID }, jobContext(t));
    expect(stored).not.toBeNull();
    const keys = Object.keys(stored ?? {});
    expect(keys).toHaveLength(100);
    expect(stored?.contents).toBe("write");
    expect(stored?.checks).toBe("admin");
    for (const bad of ["pull_requests", "Bad-Name", "has_digit1", "x".repeat(65), "empty"]) {
      expect(keys).not.toContain(bad);
    }
    expect(Object.values(stored ?? {}).every((v) => ["read", "write", "admin"].includes(v))).toBe(
      true,
    );
  });

  it("a 404 stores nothing; another error is raised for the queue to retry", async () => {
    api.state.installationPermissions = null;
    expect(await refreshPermissions({ installationId: INSTALLATION_ID }, jobContext(t))).toBeNull();
    const inst = await t.db.selectFrom("installations").selectAll().executeTakeFirstOrThrow();
    expect(inst.permissions_read_at).toBeNull();
    api.failNext("GET", /\/app\/installations\/\d+$/, 500);
    await expect(
      refreshPermissions({ installationId: INSTALLATION_ID }, jobContext(t)),
    ).rejects.toThrow();
  });
});

describe("modes: the policy check", () => {
  const checks = () => api.state.checkRuns.filter((c) => c.name === "graft/policy");

  async function request(over: Partial<{ policy: string; guard: string; mcp: string }> = {}) {
    await t.db
      .updateTable("repositories")
      .set({
        policy_mode: (over.policy ?? "report") as "report",
        guard_mode: (over.guard ?? "report") as "report",
        mcp_write: (over.mcp ?? "off") as "off",
      })
      .execute();
  }
  const evaluate = (config: Record<string, string> = {}) =>
    evaluatePolicyJobRun(EVAL_DATA, { ...jobContext(t), config: testConfig(config) });

  beforeEach(() => {
    loadPolicyScenario(api);
    // Step 2: an effective enforce publishes a non-neutral check, which needs the real gate.
    t.deps.github = fakeGitHubFactory(api, mutationGate(t.db, { modeCeiling: "enforce" }));
  });

  it("I-MODE-10 changing only the effective mode republishes; the verdict row stores policy_mode", async () => {
    // The details are frozen so that only the facts hash can tell the two runs apart (D8).
    frozen.details = "frozen details";
    expect(await evaluate()).toBe("published");
    expect(await evaluate()).toBe("unchanged");
    const before = await t.db.selectFrom("policy_verdicts").selectAll().execute();
    expect(before.map((v) => v.policy_mode)).toEqual(["report"]);

    // Requested enforce under a report ceiling: the effective mode did not change.
    await request({ policy: "enforce" });
    expect(await evaluate()).toBe("unchanged");

    // The ceiling lets it through: the effective mode changed, nothing else did.
    expect(await evaluate({ GRAFT_MODE_CEILING: "enforce" })).toBe("published");
    const after = await t.db.selectFrom("policy_verdicts").selectAll().execute();
    expect(after).toHaveLength(1);
    expect(after[0]?.policy_mode).toBe("enforce");
    expect(after[0]?.facts_hash).not.toBe(before[0]?.facts_hash);
    expect(await evaluate({ GRAFT_MODE_CEILING: "enforce" })).toBe("unchanged");
    // Back to report: republished again.
    await request({ policy: "report" });
    expect(await evaluate({ GRAFT_MODE_CEILING: "enforce" })).toBe("published");
    expect((await t.db.selectFrom("policy_verdicts").selectAll().execute())[0]?.policy_mode).toBe(
      "report",
    );
    // Step 2: the enforce publication carried the enforce conclusion (the card is pending, so
    // in_progress); the rollback to report is completed and neutral again.
    const sent = api.find("PATCH", /\/check-runs\/\d+$/).map((r) => r.body?.status);
    expect(sent).toEqual(["in_progress", "completed"]);
    expect(checks().at(-1)).toMatchObject({ status: "completed", conclusion: "neutral" });
  });

  it("I-MODE-11 output.text starts with the mode line for each mode; enforce mode titles the check with its conclusion", async () => {
    const REPORT = "Graft mode: report. This check never blocks a merge.";
    const ENFORCE =
      "Graft mode: enforce. This check passes or fails on this policy; a passing check is not a review approval.";
    await evaluate();
    // The check run is updated in place, so keep what the report run said.
    const reportText = checks()[0]?.output.text ?? "";
    const reportTitle = checks()[0]?.output.title;
    const reportSummary = checks()[0]?.output.summary;
    expect(reportText.startsWith(`${REPORT}\n\n**Matched rules**`)).toBe(true);

    await request({ policy: "enforce" });
    await evaluate({ GRAFT_MODE_CEILING: "enforce" });
    expect(checks()).toHaveLength(1);
    const enforceRun = checks()[0];
    expect(enforceRun?.output.text?.startsWith(`${ENFORCE}\n\n**Matched rules**`)).toBe(true);
    // Step 2 (§9): report titles are the Phase 0 ones; enforce titles say what the check concludes.
    expect(reportTitle).toMatch(/^Would require/);
    expect(reportSummary).toContain("· report only");
    expect(reportSummary).toContain("**In enforce mode this check would be:** `pending`");
    expect(enforceRun?.output.title).toBe("Waiting for the intent card");
    expect(enforceRun?.output.summary).not.toContain("report only");
    expect(enforceRun?.output.summary).toContain(
      "Graft mode: enforce. This check is required only if branch protection says so.",
    );
    expect(enforceRun).toMatchObject({ status: "in_progress", conclusion: null });
    // The details are the same text under both lines.
    expect(enforceRun?.output.text?.slice(ENFORCE.length)).toBe(reportText.slice(REPORT.length));
  });

  it("I-MODE-11b with no graft.yaml the text is the mode line alone", async () => {
    loadPolicyScenario(api, { policy: null });
    await evaluate();
    expect(checks()[0]?.output.text).toBe("Graft mode: report. This check never blocks a merge.");
    expect(checks()[0]?.conclusion).toBe("neutral");
  });

  it("getEffectiveModes reads the database now and throws for an unknown repository", async () => {
    const cfg = testConfig({ GRAFT_MODE_CEILING: "enforce" });
    await request({ policy: "enforce", guard: "enforce" });
    await t.db
      .updateTable("installations")
      .set({ permissions: JSON.stringify({ contents: "write" }), permissions_read_at: FIXED_NOW })
      .execute();
    const m = await getEffectiveModes(t.db, REPO_ID, cfg);
    expect(m.policy.effective).toBe("enforce");
    expect(m.guard.effective).toBe("enforce");
    expect(m.mcpWrite).toMatchObject({ requested: "off", effective: "off" });
    await t.db.updateTable("installations").set({ suspended_at: FIXED_NOW }).execute();
    expect((await getEffectiveModes(t.db, REPO_ID, cfg)).policy).toMatchObject({
      effective: "report",
      reason: "installation_inactive",
    });
    await expect(getEffectiveModes(t.db, 1, cfg)).rejects.toThrow("unknown repository");
  });
});

describe("modes: purge and doctor", () => {
  it("I-MODE-12 pilot purge removes mode_changes and leaves service_state alone", async () => {
    await sql`insert into mode_changes (repository_id, key, from_value, to_value, actor, reason)
      values (${REPO_ID}, 'policy_mode', 'report', 'enforce', 'op', 'seed')`.execute(t.db);
    await t.db
      .insertInto("service_state")
      .values({ key: "mode_ceiling", value: "report", updated_at: FIXED_NOW })
      .execute();
    const dry = await purgeInstallation(t.db, {
      installationId: INSTALLATION_ID,
      schema: "pgboss",
      now: FIXED_NOW,
      dryRun: true,
    });
    expect(dry.counts.mode_changes).toBe(1);
    expect(dry.counts).not.toHaveProperty("service_state");
    const res = await purgeInstallation(t.db, {
      installationId: INSTALLATION_ID,
      schema: "pgboss",
      now: FIXED_NOW,
      dryRun: false,
      confirm: OWNER,
      evenIfActive: true,
    });
    expect(res.counts.mode_changes).toBe(1);
    expect(await t.db.selectFrom("mode_changes").selectAll().execute()).toEqual([]);
    expect(await t.db.selectFrom("service_state").selectAll().execute()).toHaveLength(1);
  });

  it("I-MODE-13 doctor warns about unread permissions and requested modes that are not effective, and still exits 0", async () => {
    await addDelivery(t.db, {
      id: "dl-1",
      installationId: INSTALLATION_ID,
      repositoryId: null,
      at: new Date(FIXED_NOW.getTime() - 3_600_000),
    });
    const doctor = async () => {
      const res = await run("pilot", "doctor", "--installation", String(INSTALLATION_ID), "--json");
      return {
        code: res.code,
        checks: JSON.parse(res.out).checks as { id: string; status: string; detail: string }[],
      };
    };
    const clean = await doctor();
    expect(clean.code).toBe(0);
    expect(clean.checks.find((c) => c.id === "permissions")?.status).toBe("WARN");
    expect(clean.checks.find((c) => c.id === "modes")?.status).toBe("OK");

    expect((await set("--policy", "enforce", "--guard", "enforce", "--reason", "r")).code).toBe(0);
    const warned = await doctor();
    expect(warned.code).toBe(0);
    expect(warned.checks.filter((c) => c.status === "FAIL")).toEqual([]);
    expect(warned.checks.find((c) => c.id === "permissions")).toMatchObject({
      status: "WARN",
      detail: expect.stringContaining("not read in the last 48 h"),
    });
    expect(warned.checks.find((c) => c.id === "modes")).toMatchObject({
      status: "WARN",
      detail: "2 requested modes are not effective: ceiling 2",
    });

    // Fresh permissions and a ceiling that lets the modes through: both checks are OK.
    ceiling = "enforce";
    await t.db
      .updateTable("installations")
      .set({
        permissions: JSON.stringify({ contents: "write" }),
        permissions_read_at: new Date(FIXED_NOW.getTime() - 3_600_000),
      })
      .execute();
    await sql`delete from service_state`.execute(t.db);
    const healthy = await doctor();
    expect(healthy.checks.find((c) => c.id === "permissions")?.status).toBe("OK");
    expect(healthy.checks.find((c) => c.id === "modes")?.status).toBe("OK");
  });
});

describe("modes: Phase 1 step 2", () => {
  const NEW_INSTALLATION = INSTALLATION_ID + 1;
  const added = async (installationId: number, fullName = FULL_NAME, delivery = "d") => {
    const { event, payload } = loadFixture("installation_repositories.added");
    const p = structuredClone(payload) as {
      installation: { id: number };
      repositories_added: { id: number; full_name: string; private: boolean }[];
    };
    p.installation.id = installationId;
    p.repositories_added = [
      { ...p.repositories_added[0], id: REPO_ID, full_name: fullName, private: true },
    ] as typeof p.repositories_added;
    await trackInstallations.handle(
      { id: delivery, deliveryId: delivery, name: event, payload: p } as never,
      jobContext(t),
    );
  };
  const enforceAll = () =>
    t.db
      .updateTable("repositories")
      .set({ policy_mode: "enforce", guard_mode: "enforce", mcp_write: "on" })
      .where("id", "=", REPO_ID)
      .execute();
  const modesOfRepo = async () => {
    const r = await repoRow();
    return [r.policy_mode, r.guard_mode, r.mcp_write];
  };

  it("I-MODE-14 a transfer or a re-add resets the modes with system rows; a rename in the same installation keeps them", async () => {
    // Transfer: the repository shows up on another installation.
    await enforceAll();
    await added(NEW_INSTALLATION, FULL_NAME, "d-transfer");
    expect(await modesOfRepo()).toEqual(["report", "report", "off"]);
    expect((await repoRow()).installation_id).toBe(NEW_INSTALLATION);
    const transfer = await rows();
    expect(
      transfer
        .map((r) => [r.key, r.from_value, r.to_value, r.actor, r.reason, r.applied_at])
        .sort(),
    ).toEqual([
      ["guard_mode", "enforce", "report", "system", "installation changed", null],
      ["mcp_write", "on", "off", "system", "installation changed", null],
      ["policy_mode", "enforce", "report", "system", "installation changed", null],
    ]);
    // `mode history` shows them like any other row.
    const history = await run("mode", "history", "--repo", FULL_NAME);
    expect(history.code).toBe(0);
    expect(history.out).toContain("system");
    expect(history.out).toContain("installation changed");

    // Re-added after removal, on the same installation.
    await t.db.deleteFrom("mode_changes").execute();
    await enforceAll();
    await t.db.updateTable("repositories").set({ removed_at: FIXED_NOW }).execute();
    await added(NEW_INSTALLATION, FULL_NAME, "d-readd");
    expect(await modesOfRepo()).toEqual(["report", "report", "off"]);
    expect((await repoRow()).removed_at).toBeNull();
    expect((await rows()).map((r) => [r.key, r.actor, r.reason]).sort()).toEqual([
      ["guard_mode", "system", "repository re-added"],
      ["mcp_write", "system", "repository re-added"],
      ["policy_mode", "system", "repository re-added"],
    ]);

    // A rename within the same installation keeps the modes and writes nothing.
    await t.db.deleteFrom("mode_changes").execute();
    await enforceAll();
    await added(NEW_INSTALLATION, `${OWNER}/renamed`, "d-rename");
    expect(await modesOfRepo()).toEqual(["enforce", "enforce", "on"]);
    expect((await repoRow()).full_name).toBe(`${OWNER}/renamed`);
    expect(await rows()).toEqual([]);

    // A transfer of a repository already at the floors writes nothing.
    await t.db
      .updateTable("repositories")
      .set({ policy_mode: "report", guard_mode: "report", mcp_write: "off" })
      .execute();
    await added(INSTALLATION_ID, FULL_NAME, "d-back");
    expect((await repoRow()).installation_id).toBe(INSTALLATION_ID);
    expect(await rows()).toEqual([]);
  });

  it("I-MODE-15 mode show notes a missing members:read when policy enforces; doctor warns and still exits 0", async () => {
    // A recent delivery, so that only the checks under test can warn.
    await addDelivery(t.db, {
      id: "dl-15",
      installationId: INSTALLATION_ID,
      repositoryId: null,
      at: new Date(FIXED_NOW.getTime() - 3_600_000),
    });
    ceiling = "enforce";
    expect((await set("--policy", "enforce", "--reason", "r")).code).toBe(0);
    const NOTE = "note: team constraints cannot be verified (no members:read); they will fail";
    // Permissions never read: the note.
    expect((await run("mode", "show", "--repo", FULL_NAME)).out).toContain(NOTE);
    await t.db
      .updateTable("installations")
      .set({ permissions: JSON.stringify({ checks: "write" }), permissions_read_at: FIXED_NOW })
      .execute();
    expect((await run("mode", "show", "--repo", FULL_NAME)).out).toContain(NOTE);
    const doctor = async () => {
      const res = await run("pilot", "doctor", "--installation", String(INSTALLATION_ID), "--json");
      return {
        code: res.code,
        checks: JSON.parse(res.out).checks as { id: string; status: string; detail: string }[],
      };
    };
    const warned = await doctor();
    expect(warned.code).toBe(0);
    expect(warned.checks.filter((c) => c.status === "FAIL")).toEqual([]);
    expect(warned.checks.find((c) => c.id === "teams")).toMatchObject({
      status: "WARN",
      detail: expect.stringContaining("1 repositories enforcing policy without members:read"),
    });
    // With members:read: no note, no warning.
    await t.db
      .updateTable("installations")
      .set({ permissions: JSON.stringify({ checks: "write", members: "read" }) })
      .execute();
    expect((await run("mode", "show", "--repo", FULL_NAME)).out).not.toContain(NOTE);
    expect((await doctor()).checks.find((c) => c.id === "teams")?.status).toBe("OK");
    // Report mode never needs it.
    await t.db
      .updateTable("installations")
      .set({ permissions: JSON.stringify({ checks: "write" }) })
      .execute();
    ceiling = "report";
    expect((await run("mode", "show", "--repo", FULL_NAME)).out).not.toContain(NOTE);
    expect((await doctor()).checks.find((c) => c.id === "teams")?.status).toBe("OK");
  });
});
