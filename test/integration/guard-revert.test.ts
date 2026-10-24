/**
 * Revert pull requests (Phase 1 step 5) against the in-memory GitHub API: the plan, report mode,
 * the writes and their resumption, auto-merge, the lifecycle, the CLI and the doctor.
 */
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import type { JobContext } from "../../src/core/context.js";
import { migrateDownOne, migrateToLatest } from "../../src/db/migrator.js";
import type { GuardEventStatus } from "../../src/db/schema.js";
import {
  ENABLE_AUTO_MERGE_MUTATION,
  type MutationGate,
  MutationRefusedError,
} from "../../src/github/mutation-guard.js";
import { REPORT_LINE, STEP4_PARAGRAPH } from "../../src/guard/revert-text.js";
import { insertAuditRow } from "../../src/modules/audit/index.js";
import { guardCheckRun } from "../../src/modules/guard/handlers.js";
import {
  guardPullRequestClosed,
  guardRevertJob,
  observeCommit,
  openRevert,
  type RevertData,
  revertClosed,
  runRevert,
  settleFailedRun,
  trackDefaultBranch,
} from "../../src/modules/guard/index.js";
import { countOpenReverts } from "../../src/modules/guard/store.js";
import { apiTreeReader } from "../../src/modules/guard/trees.js";
import { mutationGate } from "../../src/modules/modes/index.js";
import { runDoctor } from "../../src/pilot/doctor.js";
import { clearPolicyCache } from "../../src/policy/load.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import { resolveJobOptions } from "../../src/queue/queue.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";
import {
  createFakeGitHubApi,
  type FakeGitHubApi,
  type RecordedApiRequest,
} from "../helpers/fake-github-api.js";
import { FakeJobQueue } from "../helpers/fake-queue.js";
import { loadFixture } from "../helpers/fixtures.js";
import { blobSha, type FileSpec } from "../helpers/git-trees.js";
import {
  fakeSha,
  INSTALLATION_ID,
  makePull,
  OWNER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";
import { addCard } from "../helpers/pilot-seed.js";
import { putContent } from "../helpers/policy-scenario.js";
import { seedWorld } from "../helpers/seed.js";

const FULL_NAME = `${OWNER}/${REPO}`;
const ACTIONS = 15368;
const IDS = { installationId: INSTALLATION_ID, repositoryId: REPO_ID, owner: OWNER, repo: REPO };
const C = (n: number) => fakeSha(0xc000 + n);
const short = (sha: string) => sha.slice(0, 7);
const ENFORCE = { GRAFT_MODE_CEILING: "enforce" };
const RETRYING = { retryCount: 0, retryLimit: 3 };
const LAST_ATTEMPT = { retryCount: 3, retryLimit: 3 };
/** The PR number the fake gives the first pull request created through the API. */
const REVERT_PR = 500;

let t: TestApp;
let api: FakeGitHubApi;
let now = new Date(FIXED_NOW);
let refused: MutationRefusedError[] = [];
let gateCalls: { feature: string; allowed: boolean }[] = [];
/** I-REV-20: every request of every test of this file. */
const allRequests: RecordedApiRequest[] = [];

const ctx = (
  over: Record<string, string> = {},
  attempt?: { retryCount: number; retryLimit: number },
): JobContext => ({
  ...jobContext(t),
  config: testConfig(over),
  clock: { now: () => new Date(now) },
  ...(attempt === undefined ? {} : { attempt }),
});

/** The real mode gate, recorded; refusals are collected. */
function useGate(config: Record<string, string> = {}): void {
  const real = mutationGate(t.db, testConfig(config));
  const gate: MutationGate = async (q) => {
    const v = await real(q);
    gateCalls.push({ feature: q.feature, allowed: v.allowed });
    return v;
  };
  t.deps.github = fakeGitHubFactory(api, gate, (e) => refused.push(e));
}

async function reset(): Promise<void> {
  if (api) allRequests.push(...api.requests);
  await truncateAll(t.db);
  await seedWorld(t.db);
  clearPolicyCache();
  now = new Date(FIXED_NOW);
  api = createFakeGitHubApi();
  refused = [];
  gateCalls = [];
  useGate();
}

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(reset);
afterEach(() => {
  allRequests.push(...api.requests);
  api.requests.length = 0;
});

const advance = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
};

/** C1 (root) <- C2 <- ... <- Cn; `main` points at Cn. */
function history(n: number, from = 1): void {
  for (let k = from; k <= n; k++) {
    api.state.history.set(C(k), { parents: k === 1 ? [] : [C(k - 1)] });
  }
  api.state.branches.set("main", C(n));
}

/** An exact tree for a tracked commit (otherwise the fake makes one per commit). */
function files(sha: string, f: Record<string, FileSpec>): void {
  const parents = api.state.history.get(sha)?.parents ?? [];
  api.state.git.commits.set(sha, { tree: api.state.git.treeOf(f), parents, message: "x" });
}

function mergedPull(n: number, ...shas: string[]): void {
  api.state.pulls.set(
    n,
    makePull({
      number: n,
      node_id: `PR_fake${n}`,
      state: "closed",
      merged: true,
      merge_commit_sha: shas.at(-1) ?? null,
      merged_at: "2026-10-14T11:00:00Z",
      closed_at: "2026-10-14T11:00:00Z",
      head: { sha: fakeSha(0xd000 + n), ref: `feature-${n}` },
      merged_by: { id: 77, login: "merger", type: "User" },
    }),
  );
  for (const sha of shas) api.state.commitPulls.set(sha, [n]);
}

function run(sha: string, name: string, conclusion: string | null): void {
  const id = api.state.nextId++;
  api.state.checkRuns.push({
    id,
    name,
    head_sha: sha,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    external_id: "",
    output: { title: "", summary: "" },
    app: { id: ACTIONS },
    completed_at: conclusion === null ? null : now.toISOString(),
    html_url: `https://github.com/${FULL_NAME}/runs/${id}`,
  });
}

const track = (after: string, before: string | null, config: Record<string, string> = {}) =>
  trackDefaultBranch({ ...IDS, branch: "main", after, before, forced: false }, ctx(config));
const observeOnly = (sha: string, config: Record<string, string> = {}) =>
  observeCommit({ ...IDS, sha }, ctx(config));

/** The queued `guard.revert` jobs, taken out of pg-boss (no worker runs here). */
async function takeReverts(): Promise<RevertData[]> {
  return (
    await sql<{ data: RevertData }>`
      delete from pgboss.job where name = 'guard.revert' returning data`.execute(t.db)
  ).rows.map((r) => r.data);
}
async function runReverts(
  config: Record<string, string> = {},
  attempt?: { retryCount: number; retryLimit: number },
): Promise<RevertData[]> {
  const queued = await takeReverts();
  for (const d of queued) await runRevert(d, ctx(config, attempt));
  return queued;
}

const events = () => t.db.selectFrom("guard_events").selectAll().orderBy("created_at").execute();
const eventById = (id: string) =>
  t.db.selectFrom("guard_events").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const prId = async (n: number) =>
  (
    await t.db
      .selectFrom("changes")
      .select("id")
      .where("pr_number", "=", n)
      .executeTakeFirstOrThrow()
  ).id;
const writes = () =>
  api.requests.filter((r) => r.method !== "GET" && !r.path.endsWith("/access_tokens"));
const routes = () => writes().map((r) => `${r.method} ${r.path.replace(/\/\d+\//g, "/{n}/")}`);
const R = (method: string, rest: string) => `${method} /repos/${FULL_NAME}${rest}`;
const comments = () => api.find("POST", /\/issues\/\d+\/comments$/);
const commentBody = (i = 0) => String(comments()[i]?.body?.body ?? "");
const commentLines = (i = 0) => commentBody(i).split("\n");

/** The repository at `enforce`, with the ceiling, and the permissions of the full manifest. */
async function enforceMode(
  permissions: Record<string, string> = {
    checks: "write",
    contents: "write",
    pull_requests: "write",
  },
): Promise<void> {
  await t.db.updateTable("repositories").set({ guard_mode: "enforce" }).execute();
  await t.db
    .updateTable("installations")
    .set({ permissions: JSON.stringify(permissions), permissions_read_at: now })
    .execute();
  useGate(ENFORCE);
}

/**
 * C1 green, C2 = PR 7 red, C3 = PR 8 red: a `culprit_found` event for PR 7 confirmed by the next
 * commit, with its `guard.revert` queued (not run). Returns the event id.
 */
async function culprit(config: Record<string, string> = {}): Promise<string> {
  if (api.state.history.size === 0) history(3);
  if (!api.state.pulls.has(7)) mergedPull(7, C(2));
  if (!api.state.pulls.has(8)) mergedPull(8, C(3));
  await track(C(3), null, config);
  run(C(1), "test", "success");
  await observeOnly(C(1), config);
  advance(60);
  run(C(2), "test", "failure");
  await observeOnly(C(2), config);
  if (config.GRAFT_GUARD_CONFIRM !== "off") {
    advance(60);
    run(C(3), "test", "failure");
    await observeOnly(C(3), config);
  }
  const e = (await events()).find((x) => x.failing_sha === C(2));
  if (!e) throw new Error("no event");
  expect(e.status).toBe("culprit_found");
  return e.id;
}

/** An event row written directly (the cap, the CLI, statuses the flow cannot reach cheaply). */
async function insertEvent(o: {
  failingSha: string;
  status: GuardEventStatus;
  culpritChangeId?: string | null;
  confirmReason?: "next_commit" | "window" | "off" | "flaky_rerun" | "flaky_next" | null;
  revert?: Record<string, unknown>;
  detectedAt?: Date;
}): Promise<string> {
  const row = await t.db
    .insertInto("guard_events")
    .values({
      repository_id: REPO_ID,
      branch: "main",
      failing_sha: o.failingSha,
      last_green_sha: C(1),
      failing_checks: JSON.stringify([
        { key: `run:${ACTIONS}:test`, name: "test", source: "check_run" },
      ]),
      candidates: JSON.stringify([{ sha: o.failingSha, prNumber: 7, kind: "pr" }]),
      culprit_change_id: o.culpritChangeId ?? null,
      status: o.status,
      confirm_reason: o.confirmReason === undefined ? "next_commit" : o.confirmReason,
      detected_at: o.detectedAt ?? now,
      confirmed_at: now,
      created_at: o.detectedAt ?? now,
      updated_at: now,
      ...(o.revert ?? {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

const ops = async (argv: string[], over: Record<string, string> = {}) => {
  let out = "";
  let err = "";
  const deps: OpsDeps = {
    loadConfig: () => testConfig(over),
    openDb: () => testDb(),
    github: () => fakeGitHubFactory(api),
    now: () => now,
    sleep: async () => {},
  };
  const code = await opsMain(argv, { out: (s) => (out += s), err: (s) => (err += s) }, deps);
  return { code, out, err };
};

const event = (name: string, payload: unknown) =>
  ({ id: `d-${name}`, name, payload, deliveryId: `d-${name}` }) as never;

const FORBIDDEN_WRITE = /\/git\/|\/pulls|\/labels|^\/graphql$/;

describe("guard revert: schema", () => {
  it("I-REV-1 migration 0013 up, down, up; down restores the step 4 status check and fails on a new status", async () => {
    const cols = async () =>
      (
        await sql<{ column_name: string }>`
          select column_name from information_schema.columns
          where table_name = 'guard_events' and (column_name like 'revert_%' or column_name like 'auto_merge_%'
            or column_name = 'reverted_at')
          order by column_name`.execute(t.db)
      ).rows.map((r) => r.column_name);
    const indexes = async () =>
      (
        await sql<{ indexname: string }>`
          select indexname from pg_indexes where tablename = 'guard_events'
            and indexname in ('guard_events_one_revert_per_culprit', 'guard_events_revert_open_idx')
          order by indexname`.execute(t.db)
      ).rows.map((r) => r.indexname);
    expect(await cols()).toEqual([
      "auto_merge_reason",
      "auto_merge_state",
      "revert_branch",
      "revert_claimed_at",
      "revert_commit_sha",
      "revert_conflicts",
      "revert_labelled",
      "revert_outcome",
      "revert_plan_paths",
      "revert_pr_number",
      "revert_reason",
      "reverted_at",
    ]);
    expect(await indexes()).toEqual([
      "guard_events_one_revert_per_culprit",
      "guard_events_revert_open_idx",
    ]);
    expect(await migrateDownOne(t.db)).toEqual(["0016_phase1_gate"]);
    expect(await migrateDownOne(t.db)).toEqual(["0015_mcp_open_claims"]);
    expect(await migrateDownOne(t.db)).toEqual(["0014_mcp"]);
    expect(await migrateDownOne(t.db)).toEqual(["0013_guard_revert"]);
    try {
      // `revert_pr_number` is from 0001 and stays.
      expect(await cols()).toEqual(["revert_pr_number"]);
      expect(await indexes()).toEqual([]);
      await expect(
        sql`insert into guard_events (repository_id, branch, failing_sha, status)
          values (${REPO_ID}, 'main', ${C(1)}, 'needs_human')`.execute(t.db),
      ).rejects.toThrow(/check constraint/);
    } finally {
      expect(await migrateToLatest(t.db)).toEqual([
        "0013_guard_revert",
        "0014_mcp",
        "0015_mcp_open_claims",
        "0016_phase1_gate",
      ]);
    }
    // A row with a new status blocks the rollback, which then changes nothing.
    await insertEvent({ failingSha: C(1), status: "revert_closed" });
    expect(await migrateDownOne(t.db)).toEqual(["0016_phase1_gate"]);
    expect(await migrateDownOne(t.db)).toEqual(["0015_mcp_open_claims"]);
    expect(await migrateDownOne(t.db)).toEqual(["0014_mcp"]);
    await expect(migrateDownOne(t.db)).rejects.toThrow();
    expect(await indexes()).toHaveLength(2);
    expect(await migrateToLatest(t.db)).toEqual([
      "0014_mcp",
      "0015_mcp_open_claims",
      "0016_phase1_gate",
    ]);
    await t.db.deleteFrom("guard_events").execute();
    expect(await migrateDownOne(t.db)).toEqual(["0016_phase1_gate"]);
    expect(await migrateDownOne(t.db)).toEqual(["0015_mcp_open_claims"]);
    expect(await migrateDownOne(t.db)).toEqual(["0014_mcp"]);
    expect(await migrateDownOne(t.db)).toEqual(["0013_guard_revert"]);
    expect(await migrateToLatest(t.db)).toEqual([
      "0013_guard_revert",
      "0014_mcp",
      "0015_mcp_open_claims",
      "0016_phase1_gate",
    ]);
    // The CHECKs: a branch name and a commit SHA of the right shape only.
    await expect(
      insertEvent({ failingSha: C(2), status: "culprit_found", revert: { revert_branch: "main" } }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      insertEvent({
        failingSha: C(2),
        status: "culprit_found",
        revert: { revert_reason: "x".repeat(41) },
      }),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("guard revert: report mode", () => {
  it("I-REV-2 report mode is inert: the plan (GETs only), the would-open comment, outcome planned; no write besides the comment, no refusal", async () => {
    const id = await culprit();
    const before = api.requests.length;
    await runReverts();
    const during = api.requests.slice(before);
    const e = await eventById(id);
    expect(e).toMatchObject({
      status: "culprit_found",
      guard_mode: "report",
      revert_outcome: "planned",
      revert_reason: null,
      revert_plan_paths: 1,
      revert_conflicts: 0,
      revert_claimed_at: null,
      revert_commit_sha: null,
      auto_merge_state: "would",
      auto_merge_reason: "not_configured",
    });
    expect(commentLines().at(-3)).toBe(
      `Graft would open a pull request reverting this merge (1 path restored to \`${short(C(1))}\`) and would not enable auto-merge: \`guard.auto_merge_reverts\` is not set in graft.yaml at the last green commit.`,
    );
    expect(commentLines().at(-1)).toBe(REPORT_LINE);
    // The plan read trees and commits.
    expect(during.some((r) => r.method === "GET" && /\/git\/trees\//.test(r.path))).toBe(true);
    for (const r of api.requests) {
      if (r.method === "GET") continue;
      expect(r.path.slice(`/repos/${FULL_NAME}`.length), `${r.method} ${r.path}`).not.toMatch(
        FORBIDDEN_WRITE,
      );
      expect(r.path).not.toBe("/graphql");
    }
    expect(routes()).toEqual([R("POST", "/issues/{n}/comments")]);
    expect(refused).toEqual([]);
    expect(gateCalls).toEqual([]);
  });

  it("I-REV-2b a planned outcome whose comment failed is commented later with the report line, even after the repository moved to enforce", async () => {
    const id = await culprit();
    api.afterNext("POST", /\/issues\/\d+\/comments$/, async () => {
      throw new Error("worker crashed");
    });
    const [data] = await takeReverts();
    if (!data) throw new Error("no job");
    await expect(runRevert(data, ctx({}, RETRYING))).rejects.toThrow();
    // The lost answer: the fake kept no comment, as if GitHub never wrote it.
    api.state.comments.length = 0;
    expect((await eventById(id)).revert_outcome).toBe("planned");
    await enforceMode();
    expect(await runRevert(data, ctx(ENFORCE, RETRYING))).toBe("commented");
    expect(commentLines(1).at(-3)).toMatch(/^Graft would open a pull request reverting this merge/);
    expect(commentLines(1).at(-1)).toBe(REPORT_LINE);
    expect(api.find("POST", /\/git\//)).toEqual([]);
  });

  it("I-REV-3 report mode refused: the write step with a guard client while guard_mode is report: mode_report before any request", async () => {
    const id = await culprit();
    const guard = await t.deps.github.forInstallation(INSTALLATION_ID, { feature: "guard" });
    const plain = await t.deps.github.forInstallation(INSTALLATION_ID);
    const before = api.requests.length;
    const err = await openRevert(ctx(), guard, {
      data: { ...IDS, eventId: id },
      eventId: id,
      changeId: await prId(7),
      defaultBranch: "main",
      tip: { sha: C(3), tree: api.state.git.commits.get(C(3))?.tree ?? fakeSha(1) },
      changes: [
        {
          path: `history/${C(2)}.txt`,
          before: null,
          after: { mode: "100644", type: "blob", sha: blobSha(C(2)) },
        },
      ],
      reader: apiTreeReader(plain, { owner: OWNER, repo: REPO, maxTreeReads: 10 }),
      message: "m",
      title: "t",
      body: "b",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MutationRefusedError);
    expect((err as MutationRefusedError).refusal).toBe("mode_report");
    expect(
      api.requests
        .slice(before)
        .filter((r) => r.method !== "GET" && !r.path.endsWith("/access_tokens")),
    ).toEqual([]);
    expect(refused.map((r) => r.refusal)).toEqual(["mode_report"]);
  });

  it("I-REV-4 enforce requested without contents:write: effective report, the comment says why, no write", async () => {
    await enforceMode({ checks: "write", pull_requests: "write" });
    const id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    expect(await eventById(id)).toMatchObject({ guard_mode: "report", revert_outcome: "planned" });
    expect(commentLines().at(-1)).toBe(
      "Graft mode: report (enforce requested; permission_missing contents:write). Graft opens nothing; this is what it would do.",
    );
    expect(routes()).toEqual([R("POST", "/issues/{n}/comments")]);
    expect(gateCalls).toEqual([]);
  });
});

describe("guard revert: enforce", () => {
  it("I-REV-5 a single squash culprit: tree, commit on the tip, ref, PR with the fixed title and body, label; the tree is the base on the changed paths and the tip elsewhere", async () => {
    await enforceMode();
    history(3);
    const BASE = {
      "a.ts": "a1",
      "b.ts": "b1",
      "keep/k.ts": "k",
      "run.sh": { mode: "100755", sha: blobSha("r") },
    };
    files(C(1), BASE);
    files(C(2), {
      ...BASE,
      "a.ts": "a2",
      "new/n.ts": "n",
      "run.sh": { mode: "100644", sha: blobSha("r") },
    });
    files(C(3), {
      ...BASE,
      "a.ts": "a2",
      "new/n.ts": "n",
      "run.sh": { mode: "100644", sha: blobSha("r") },
      "later.ts": "l",
    });
    const id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    expect(routes()).toEqual([
      R("POST", "/git/trees"),
      R("POST", "/git/commits"),
      R("POST", "/git/refs"),
      R("POST", "/pulls"),
      R("POST", "/issues/{n}/labels"),
      R("POST", "/issues/{n}/comments"),
    ]);
    const e = await eventById(id);
    expect(e).toMatchObject({
      status: "revert_opened",
      guard_mode: "enforce",
      revert_outcome: "opened",
      revert_pr_number: REVERT_PR,
      revert_branch: `graft-revert/${id}`,
      revert_labelled: true,
      revert_plan_paths: 3,
      auto_merge_state: "not_eligible",
      auto_merge_reason: "not_configured",
    });
    expect(e.revert_claimed_at).toEqual(now);
    // The commit: the planned tree on the tip, the fixed message, no author.
    const commitReq = api.find("POST", /\/git\/commits$/)[0];
    expect(commitReq?.body).toEqual({
      message: [
        "Revert #7 (Graft guard)",
        "",
        `CI went red on main at ${short(C(2))} after pull request #7 was merged.`,
        `This restores the 3 paths #7 changed to their state at ${short(C(1))}.`,
        "",
        "Graft-Agent: graft-guard",
      ].join("\n"),
      tree: expect.any(String),
      parents: [C(3)],
    });
    const commit = api.state.git.commits.get(e.revert_commit_sha as string);
    expect(commit?.parents).toEqual([C(3)]);
    const result = api.state.git.flatten(commit?.tree as string);
    const expected = api.state.git.flatten(api.state.git.treeOf({ ...BASE, "later.ts": "l" }));
    expect(Object.fromEntries(result)).toEqual(Object.fromEntries(expected));
    // The ref and the pull request.
    expect(api.find("POST", /\/git\/refs$/)[0]?.body).toEqual({
      ref: `refs/heads/graft-revert/${id}`,
      sha: e.revert_commit_sha,
    });
    expect(api.state.branches.get(`graft-revert/${id}`)).toBe(e.revert_commit_sha);
    const create = api.find("POST", /\/pulls$/)[0]?.body;
    expect(create).toMatchObject({
      head: `graft-revert/${id}`,
      base: "main",
      title: "Revert #7 (Graft guard)",
      draft: false,
      maintainer_can_modify: false,
    });
    const body = String(create?.body);
    expect(body.split("\n\n")[0]).toBe(
      "Graft's post-merge guard opened this pull request to revert #7.",
    );
    expect(body).toContain(
      `CI check \`test\` went red on \`main\` at \`${short(C(2))}\` after #7 was merged. It was green at \`${short(C(1))}\`, the commit before, and the failure was confirmed (the next commit \`${short(C(3))}\` is also red).`,
    );
    expect(body).toContain(`- Reverts: 3 paths, restored to \`${short(C(1))}\``);
    expect(body).toContain("- Author: @graft-dev\n");
    expect(body.split("\n\n").at(-1)).toBe("Graft-Agent: graft-guard");
    expect(api.state.pulls.get(REVERT_PR)?.labels).toEqual([{ name: "graft:revert" }]);
    expect(api.find("POST", /\/labels$/)[0]?.body).toEqual({ labels: ["graft:revert"] });
    // The comment on the culprit.
    expect(comments()[0]?.path).toBe(`/repos/${FULL_NAME}/issues/7/comments`);
    expect(commentLines().at(-3)).toBe(
      `Graft opened #${REVERT_PR} to revert this merge. Auto-merge: off: \`guard.auto_merge_reverts\` is not set in graft.yaml at the last green commit.`,
    );
    expect(commentLines().at(-1)).toBe("Graft mode: enforce.");
    // Every write went through the guard client and the gate allowed it.
    expect(gateCalls).toEqual(
      Array.from({ length: 5 }, () => ({ feature: "guard", allowed: true })),
    );
    expect(refused).toEqual([]);
  });

  it("I-REV-5b the D9 check: a directory GitHub does not delete, or a path the request did not name, ends error tree_mismatch before the commit", async () => {
    const quirks: [string, (q: FakeGitHubApi["state"]["git"]["quirks"]) => void][] = [
      ["sha: null kept on a directory", (q) => (q.keepNullTrees = true)],
      [
        "an extra path written",
        (q) =>
          q.extra.push({ path: "keep/k.ts", mode: "100644", type: "blob", sha: blobSha("evil") }),
      ],
    ];
    for (const [name, quirk] of quirks) {
      await reset();
      await enforceMode();
      history(3);
      const BASE = { "a.ts": "a1", "keep/k.ts": "k" };
      files(C(1), BASE);
      // The culprit adds a whole directory (one change on its entry) and modifies a file.
      files(C(2), { ...BASE, "a.ts": "a2", "new/n.ts": "n", "new/m.ts": "m" });
      files(C(3), { ...BASE, "a.ts": "a2", "new/n.ts": "n", "new/m.ts": "m", "later.ts": "l" });
      quirk(api.state.git.quirks);
      const id = await culprit(ENFORCE);
      await runReverts(ENFORCE);
      expect(routes(), name).toEqual([R("POST", "/git/trees"), R("POST", "/issues/{n}/comments")]);
      expect(await eventById(id), name).toMatchObject({
        status: "culprit_found",
        revert_outcome: "error",
        revert_reason: "tree_mismatch",
        revert_commit_sha: null,
        revert_branch: null,
        revert_pr_number: null,
      });
      expect(api.find("POST", /\/git\/commits$/), name).toEqual([]);
      expect(api.find("POST", /\/git\/refs$/), name).toEqual([]);
      expect(api.find("POST", /\/pulls$/), name).toEqual([]);
      expect(commentLines().at(-3), name).toBe(
        "Graft could not open the revert (tree_mismatch). An operator can see the event with `graft guard list`.",
      );
    }
  });

  it("I-REV-6 a changed path modified again on main: needs_human, the comment lists it, no write besides the comment", async () => {
    await enforceMode();
    history(3);
    files(C(1), { "a.ts": "a1", "b.ts": "b1" });
    files(C(2), { "a.ts": "a2", "b.ts": "b2" });
    files(C(3), { "a.ts": "a3", "b.ts": "b2" });
    const id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    expect(await eventById(id)).toMatchObject({
      status: "needs_human",
      revert_outcome: "needs_human",
      revert_reason: "touched_later",
      revert_conflicts: 1,
      revert_pr_number: null,
    });
    expect(commentLines().at(-3)).toBe(
      "Graft did not open a revert: these paths changed again on `main` after this merge: `a.ts`. Revert by hand or fix forward.",
    );
    expect(routes()).toEqual([R("POST", "/issues/{n}/comments")]);
    expect(gateCalls).toEqual([]);
  });

  it("I-REV-7 flaky (re-run green), flaky with no reason, ambiguous, no_culprit and confirming events: guard.revert does nothing", async () => {
    await enforceMode();
    history(3);
    mergedPull(7, C(2));
    await track(C(3), null);
    const change = await prId(7);
    const cases: [GuardEventStatus, "flaky_rerun" | "next_commit" | null][] = [
      ["flaky", "flaky_rerun"],
      ["flaky", null],
      ["ambiguous", "next_commit"],
      ["no_culprit", "next_commit"],
      ["confirming", null],
    ];
    const ids: string[] = [];
    for (const [i, [status, reason]] of cases.entries()) {
      ids.push(
        await insertEvent({
          failingSha: fakeSha(0xf100 + i),
          status,
          confirmReason: reason,
          culpritChangeId: change,
        }),
      );
    }
    const before = api.requests.length;
    for (const id of ids) {
      expect(await runRevert({ ...IDS, eventId: id }, ctx(ENFORCE))).toBe("stopped");
    }
    expect(api.requests.slice(before)).toEqual([]);
    for (const id of ids) {
      expect(await eventById(id)).toMatchObject({ revert_outcome: null, comment_id: null });
    }
    expect((await eventById(ids[0] as string)).status).toBe("flaky");
  });

  it("I-REV-8 GRAFT_GUARD_CONFIRM=off: skipped confirmation_off, no write besides the comment", async () => {
    await enforceMode();
    const off = { ...ENFORCE, GRAFT_GUARD_CONFIRM: "off" };
    const id = await culprit(off);
    expect((await eventById(id)).confirm_reason).toBe("off");
    await runReverts(off);
    expect(await eventById(id)).toMatchObject({
      status: "culprit_found",
      revert_outcome: "skipped",
      revert_reason: "confirmation_off",
    });
    expect(commentLines().at(-3)).toMatch(/^Graft did not open a revert: confirmation is off/);
    expect(routes()).toEqual([R("POST", "/issues/{n}/comments")]);
  });

  it("I-REV-9 a culprit that is a Graft revert PR is skipped revert_of_revert; a look-alike branch and trailer no event opened is reverted", async () => {
    await enforceMode();
    history(3);
    mergedPull(7, C(2));
    // PR 7 was opened by an earlier event's revert.
    await insertEvent({
      failingSha: fakeSha(0xf001),
      status: "reverted",
      revert: { revert_pr_number: 7, revert_outcome: "opened" },
    });
    const id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    expect(await eventById(id)).toMatchObject({
      revert_outcome: "skipped",
      revert_reason: "revert_of_revert",
    });
    expect(commentLines().at(-3)).toBe(
      "Graft did not open a revert: this pull request is a Graft revert, and Graft never reverts a revert.",
    );
    expect(routes()).toEqual([R("POST", "/issues/{n}/comments")]);

    // Branch name, label and trailer prove nothing: only the database row does.
    await reset();
    await enforceMode();
    history(3);
    mergedPull(7, C(2));
    const seven = api.state.pulls.get(7);
    if (!seven) throw new Error("no PR 7");
    seven.head = { sha: fakeSha(0xd007), ref: "graft-revert/3f0c1a52-b6d8-4e0f-8a7d-2c4b1e5f6a30" };
    seven.body = "Graft's post-merge guard opened this pull request.\n\nGraft-Agent: graft-guard";
    seven.labels = [{ name: "graft:revert" }];
    const look = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    expect(await eventById(look)).toMatchObject({
      revert_outcome: "opened",
      status: "revert_opened",
    });
  });

  it("I-REV-10 crash after the ref: the retry adopts the branch, one PR; crash after the PR: found by head, no second PR; a stale branch is deleted and recreated", async () => {
    // Crash after POST …/git/refs (the answer is lost).
    await enforceMode();
    let id = await culprit(ENFORCE);
    api.afterNext("POST", /\/git\/refs$/, async () => {
      throw new Error("worker crashed");
    });
    const [data] = await takeReverts();
    if (!data) throw new Error("no job");
    await expect(runRevert(data, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    let e = await eventById(id);
    expect(e).toMatchObject({ revert_outcome: null, revert_branch: null, revert_pr_number: null });
    expect(e.revert_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(comments()).toEqual([]);
    expect(await runRevert(data, ctx(ENFORCE, RETRYING))).toBe("commented");
    e = await eventById(id);
    expect(e).toMatchObject({
      revert_outcome: "opened",
      revert_pr_number: REVERT_PR,
      revert_labelled: true,
    });
    expect(api.find("POST", /\/git\/refs$/)).toHaveLength(2);
    expect(api.find("POST", /\/git\/commits$/)).toHaveLength(1);
    expect(api.find("POST", /\/pulls$/)).toHaveLength(1);
    expect(api.find("DELETE", /\/git\/refs\//)).toEqual([]);
    expect(
      [...api.state.pulls.values()].filter((p) => p.head.ref?.startsWith("graft-revert/")),
    ).toHaveLength(1);
    expect(comments()).toHaveLength(1);

    // Crash after POST …/pulls.
    await reset();
    await enforceMode();
    id = await culprit(ENFORCE);
    api.afterNext("POST", /\/pulls$/, async () => {
      throw new Error("worker crashed");
    });
    const [data2] = await takeReverts();
    if (!data2) throw new Error("no job");
    await expect(runRevert(data2, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    expect(await eventById(id)).toMatchObject({
      revert_pr_number: null,
      revert_branch: `graft-revert/${id}`,
    });
    await runRevert(data2, ctx(ENFORCE, RETRYING));
    expect(await eventById(id)).toMatchObject({
      revert_outcome: "opened",
      revert_pr_number: REVERT_PR,
    });
    expect(api.find("POST", /\/pulls$/)).toHaveLength(1);
    expect(
      api.find("GET", /\/pulls$/).some((r) => r.query.head === `${OWNER}:graft-revert/${id}`),
    ).toBe(true);
    expect(api.state.pulls.has(REVERT_PR + 1)).toBe(false);

    // Step 5 review 1, finding 8: the same crash, and the PR is closed before the retry. The
    // adopted PR gets its final state: revert_closed, which the cap does not count.
    await reset();
    await enforceMode();
    id = await culprit(ENFORCE);
    api.afterNext("POST", /\/pulls$/, async () => {
      throw new Error("worker crashed");
    });
    const [dataClosed] = await takeReverts();
    if (!dataClosed) throw new Error("no job");
    await expect(runRevert(dataClosed, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    Object.assign(api.state.pulls.get(REVERT_PR) as object, {
      state: "closed",
      closed_at: now.toISOString(),
    });
    await runRevert(dataClosed, ctx(ENFORCE, RETRYING));
    expect(await eventById(id)).toMatchObject({
      status: "revert_closed",
      revert_outcome: "opened",
      revert_pr_number: REVERT_PR,
    });
    expect(api.find("POST", /\/pulls$/)).toHaveLength(1);

    // A stale branch: the tip moved between the crash and the retry.
    await reset();
    await enforceMode();
    id = await culprit(ENFORCE);
    api.afterNext("POST", /\/git\/refs$/, async () => {
      throw new Error("worker crashed");
    });
    const [data3] = await takeReverts();
    if (!data3) throw new Error("no job");
    await expect(runRevert(data3, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    const stale = (await eventById(id)).revert_commit_sha;
    history(4, 4);
    await runRevert(data3, ctx(ENFORCE, RETRYING));
    e = await eventById(id);
    expect(e).toMatchObject({ revert_outcome: "opened", revert_pr_number: REVERT_PR });
    expect(e.revert_commit_sha).not.toBe(stale);
    expect(api.state.git.commits.get(e.revert_commit_sha as string)?.parents).toEqual([C(4)]);
    expect(api.state.branches.get(`graft-revert/${id}`)).toBe(e.revert_commit_sha);
    expect(api.find("DELETE", new RegExp(`/git/refs/heads/graft-revert/${id}$`))).toHaveLength(1);
    expect(api.find("POST", /\/pulls$/)).toHaveLength(1);
  });

  it("I-REV-10b a run failing outside the write steps: retried while it can, then settled error with a comment on the last attempt; the job row is kept one hour; a late event is skipped stale unless its writes began", async () => {
    await enforceMode();
    const id = await culprit(ENFORCE);
    const [data] = await takeReverts();
    if (!data) throw new Error("no job");
    const real = t.deps.github;
    let failures = 0;
    t.deps.github = {
      ...real,
      forInstallation: async (...args: Parameters<typeof real.forInstallation>) => {
        if (failures > 0) {
          failures--;
          throw Object.assign(new Error("token service down"), { status: 500 });
        }
        return real.forInstallation(...args);
      },
    };
    // Not the last attempt: the error goes back to the queue, the event is untouched.
    failures = 1;
    await expect(guardRevertJob.handle(data, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    expect(await eventById(id)).toMatchObject({ revert_outcome: null, comment_id: null });
    // The last attempt: error with its class, and the comment is tried once (it succeeds here).
    failures = 1;
    await expect(guardRevertJob.handle(data, ctx(ENFORCE, LAST_ATTEMPT))).rejects.toThrow();
    const e = await eventById(id);
    expect(e.revert_outcome).toBe("error");
    expect(e.revert_reason).toMatch(/^github_/);
    expect(e.comment_id).not.toBeNull();
    expect(routes()).toEqual([R("POST", "/issues/{n}/comments")]);
    expect(commentLines().at(-3)).toBe(
      `Graft could not open the revert (${e.revert_reason}). An operator can see the event with \`graft guard list\`.`,
    );
    // A failed run can be sent again an hour later (D1's singleton id lives with the job row).
    expect(resolveJobOptions(guardRevertJob as never).deleteAfterSeconds).toBe(3600);
    t.deps.github = real;

    // A culprit confirmed longer ago than GRAFT_GUARD_REVERT_MAX_AGE_HOURS: skipped stale.
    await reset();
    await enforceMode();
    const late = await culprit(ENFORCE);
    advance(25 * 3600);
    await runReverts(ENFORCE);
    expect(await eventById(late)).toMatchObject({
      revert_outcome: "skipped",
      revert_reason: "stale",
    });
    expect(routes()).toEqual([R("POST", "/issues/{n}/comments")]);
    expect(commentLines().at(-3)).toBe(
      "Graft did not open a revert: the failure was confirmed too long ago for an automatic revert.",
    );
    // An event whose writes began is resumed whatever its age.
    await reset();
    await enforceMode();
    const begun = await culprit(ENFORCE);
    api.afterNext("POST", /\/git\/refs$/, async () => {
      throw new Error("worker crashed");
    });
    const [d2] = await takeReverts();
    if (!d2) throw new Error("no job");
    await expect(runRevert(d2, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    advance(25 * 3600);
    await runRevert(d2, ctx(ENFORCE, RETRYING));
    expect(await eventById(begun)).toMatchObject({
      revert_outcome: "opened",
      revert_pr_number: REVERT_PR,
    });
  });

  it("I-REV-11 redelivery: a replayed check_run, a second observe and a second guard.revert write nothing; a later event with the same culprit is skipped already_opened", async () => {
    await enforceMode();
    const id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    expect((await eventById(id)).revert_outcome).toBe("opened");
    const settled = writes().length;
    const queue = new FakeJobQueue();
    const payload = loadFixture("check_run.completed").payload as {
      check_run: { head_sha: string; check_suite: { head_sha: string } };
    };
    payload.check_run.head_sha = C(3);
    payload.check_run.check_suite.head_sha = C(3);
    await guardCheckRun.handle(event("check_run", payload), { ...ctx(ENFORCE), queue });
    expect(queue.sent.map((s) => s.name)).toEqual(["guard.observe"]);
    await observeOnly(C(3), ENFORCE);
    await observeOnly(C(2), ENFORCE);
    expect(await takeReverts()).toEqual([]);
    expect(await runRevert({ ...IDS, eventId: id }, ctx(ENFORCE))).toBe("stopped");
    expect(writes()).toHaveLength(settled);

    // Another event naming the same culprit (D17 e).
    const again = await insertEvent({
      failingSha: C(3),
      status: "culprit_found",
      culpritChangeId: await prId(7),
    });
    await runRevert({ ...IDS, eventId: again }, ctx(ENFORCE));
    expect(await eventById(again)).toMatchObject({
      revert_outcome: "skipped",
      revert_reason: "already_opened",
      revert_pr_number: null,
    });
    expect(api.find("POST", /\/pulls$/)).toHaveLength(1);
    // The index backs the check: a second revert PR of one culprit cannot be stored.
    await expect(
      t.db
        .updateTable("guard_events")
        .set({ revert_pr_number: 999 })
        .where("id", "=", again)
        .execute(),
    ).rejects.toThrow(/guard_events_one_revert_per_culprit/);
  });

  it("I-REV-12 the cap: three reverts open, a fourth culprit is skipped cap_reached; one revert PR closed releases a slot", async () => {
    await enforceMode();
    for (const n of [901, 902, 903]) {
      await insertEvent({
        failingSha: fakeSha(0xf000 + n),
        status: "revert_opened",
        revert: { revert_pr_number: n, revert_outcome: "opened" },
      });
      api.state.pulls.set(
        n,
        makePull({
          number: n,
          node_id: `PR_fake${n}`,
          state: "open",
          head: { sha: fakeSha(n), ref: `graft-revert/x${n}` },
        }),
      );
    }
    history(6);
    mergedPull(7, C(2));
    mergedPull(8, C(3));
    mergedPull(9, C(4));
    mergedPull(10, C(5));
    mergedPull(11, C(6));
    const first = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    expect(await eventById(first)).toMatchObject({
      revert_outcome: "skipped",
      revert_reason: "cap_reached",
    });
    expect(commentLines().at(-3)).toBe(
      "Graft did not open a revert: the limit of open revert pull requests for this repository is reached.",
    );
    expect(api.find("POST", /\/pulls$/)).toEqual([]);

    // PR 901 is closed without merge: D18 releases its slot.
    const pr = api.state.pulls.get(901);
    if (!pr) throw new Error("no PR");
    pr.state = "closed";
    pr.closed_at = now.toISOString();
    expect(await revertClosed({ repositoryId: REPO_ID, prNumber: 901 }, ctx(ENFORCE))).toBe(
      "revert_closed",
    );
    // The next culprit (PR 10, after C4 went green) opens.
    advance(60);
    run(C(4), "test", "success");
    await observeOnly(C(4), ENFORCE);
    advance(60);
    run(C(5), "test", "failure");
    await observeOnly(C(5), ENFORCE);
    advance(60);
    run(C(6), "test", "failure");
    await observeOnly(C(6), ENFORCE);
    await runReverts(ENFORCE);
    const next = (await events()).find((x) => x.failing_sha === C(5));
    expect(next).toMatchObject({
      status: "revert_opened",
      revert_outcome: "opened",
      revert_pr_number: REVERT_PR,
    });
  });

  it("I-REV-12b the cap counts a claim with no outcome: two reverts open and one claimed in progress, a new culprit is skipped cap_reached", async () => {
    await enforceMode();
    for (const n of [901, 902]) {
      await insertEvent({
        failingSha: fakeSha(0xf000 + n),
        status: "revert_opened",
        revert: { revert_pr_number: n, revert_outcome: "opened" },
      });
    }
    await insertEvent({
      failingSha: fakeSha(0xf903),
      status: "culprit_found",
      revert: { revert_claimed_at: now },
    });
    const id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    expect(await eventById(id)).toMatchObject({
      revert_outcome: "skipped",
      revert_reason: "cap_reached",
    });
    expect(api.find("POST", /\/git\//)).toEqual([]);
    expect(api.find("POST", /\/pulls$/)).toEqual([]);
  });

  it("I-REV-13 auto-merge: listed at the baseline, a logic card: the constant mutation with the PR's client mutation id; enabled", async () => {
    await enforceMode();
    history(3);
    mergedPull(7, C(2));
    mergedPull(8, C(3));
    putContent(api, C(1), "version: 1\nguard:\n  auto_merge_reverts: [logic]\n");
    api.state.repository.allow_auto_merge = true;
    api.state.repository.allow_squash_merge = false;
    await track(C(3), null);
    await addCard(t.db, {
      changeId: await prId(7),
      headSha: fakeSha(0xd007),
      risk: "logic",
      createdAt: now,
    });
    const id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    const gql = api.find("POST", /^\/graphql$/);
    expect(gql).toHaveLength(1);
    expect(gql[0]?.body).toEqual({
      query: ENABLE_AUTO_MERGE_MUTATION,
      variables: {
        pullRequestId: `PR_fake${REVERT_PR}`,
        mergeMethod: "MERGE",
        clientMutationId: `graft-guard:${FULL_NAME}#${REVERT_PR}`,
      },
    });
    expect(api.state.autoMerge.get(REVERT_PR)).toEqual({ mergeMethod: "MERGE" });
    expect(await eventById(id)).toMatchObject({
      auto_merge_state: "enabled",
      auto_merge_reason: null,
    });
    expect(String(api.find("POST", /\/pulls$/)[0]?.body?.body)).toContain(
      "- Auto-merge: on (risk `logic`, allowed by `guard.auto_merge_reverts`)",
    );
    expect(commentLines().at(-3)).toBe(
      `Graft opened #${REVERT_PR} to revert this merge. Auto-merge: on.`,
    );
    expect(api.requests.filter((r) => r.method === "PUT")).toEqual([]);
    expect(gateCalls.filter((c) => c.feature === "guard")).toHaveLength(6);
  });

  it("I-REV-13b D15: GitHub's answer for another pull request or repository is error auto_merge_mismatch; 'already enabled' counts as enabled", async () => {
    const setup = async () => {
      await reset();
      await enforceMode();
      history(3);
      mergedPull(7, C(2));
      mergedPull(8, C(3));
      putContent(api, C(1), "version: 1\nguard:\n  auto_merge_reverts: [logic]\n");
      api.state.repository.allow_auto_merge = true;
      await track(C(3), null);
      await addCard(t.db, {
        changeId: await prId(7),
        headSha: fakeSha(0xd007),
        risk: "logic",
        createdAt: now,
      });
    };
    for (const answer of [{ number: REVERT_PR + 1 }, { nameWithOwner: "other/repo" }]) {
      await setup();
      api.state.graphqlAnswer = answer;
      const id = await culprit(ENFORCE);
      await runReverts(ENFORCE, RETRYING);
      const label = JSON.stringify(answer);
      expect(await eventById(id), label).toMatchObject({
        revert_outcome: "error",
        revert_reason: "auto_merge_mismatch",
        revert_pr_number: REVERT_PR,
        auto_merge_state: null,
      });
      // Permanent: no retry, one GraphQL request.
      expect(api.find("POST", /^\/graphql$/), label).toHaveLength(1);
      expect(commentLines().at(-3), label).toBe(
        `Graft opened #${REVERT_PR} to revert this merge but could not finish (auto_merge_mismatch). An operator can see the event with \`graft guard list\`.`,
      );
    }
    await setup();
    api.state.graphqlErrors.push({
      type: "UNPROCESSABLE",
      message: "Pull request auto merge is already enabled",
    });
    const id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    expect(await eventById(id)).toMatchObject({
      revert_outcome: "opened",
      auto_merge_state: "enabled",
      auto_merge_reason: null,
    });
    expect(commentLines().at(-3)).toBe(
      `Graft opened #${REVERT_PR} to revert this merge. Auto-merge: on.`,
    );
  });

  it("I-REV-14 auto-merge refused: break-glass, a sensitive card, no card, the key only in the culprit's own graft.yaml, the repository setting, a GitHub error", async () => {
    type Variant = {
      name: string;
      setup: (change: string) => Promise<void>;
      state: string;
      reason: string | null;
      graphql: number;
    };
    const card = (risk: "logic" | "sensitive") => async (change: string) => {
      await addCard(t.db, { changeId: change, headSha: fakeSha(0xd007), risk, createdAt: now });
    };
    const variants: Variant[] = [
      {
        name: "break_glass",
        setup: async (change) => {
          await card("logic")(change);
          await t.db.transaction().execute((tx) =>
            insertAuditRow(tx, {
              repositoryId: REPO_ID,
              changeId: change,
              prNumber: 7,
              headSha: fakeSha(0xd007),
              kind: "applied",
              reason: null,
              actor: { id: 42, login: "maya" },
              role: "maintain",
              self: false,
              policyMode: "enforce",
              labelEventAt: now,
              labelEventId: 1,
              createdAt: now,
            }),
          );
        },
        state: "not_eligible",
        reason: "break_glass",
        graphql: 0,
      },
      {
        name: "sensitive",
        setup: card("sensitive"),
        state: "not_eligible",
        reason: "risk_not_listed",
        graphql: 0,
      },
      {
        name: "no card",
        setup: async () => {},
        state: "not_eligible",
        reason: "card_missing",
        graphql: 0,
      },
      {
        // Step 5 review 1, finding 8: a logic card at an earlier head is not the merged head's.
        name: "card at an earlier head",
        setup: async (change) => {
          await addCard(t.db, {
            changeId: change,
            headSha: fakeSha(0xd006),
            risk: "logic",
            createdAt: now,
          });
        },
        state: "not_eligible",
        reason: "card_missing",
        graphql: 0,
      },
      {
        name: "only in the culprit's graft.yaml",
        setup: async (change) => {
          putContent(api, C(1), "version: 1\n");
          putContent(api, C(2), "version: 1\nguard:\n  auto_merge_reverts: [logic]\n");
          await card("logic")(change);
        },
        state: "not_eligible",
        reason: "not_configured",
        graphql: 0,
      },
      {
        name: "repository setting",
        setup: async (change) => {
          api.state.repository.allow_auto_merge = false;
          await card("logic")(change);
        },
        state: "not_eligible",
        reason: "repo_setting_off",
        graphql: 0,
      },
      {
        name: "clean status",
        setup: async (change) => {
          api.state.graphqlErrors.push({
            type: "UNPROCESSABLE",
            message: "Pull request is in clean status",
          });
          await card("logic")(change);
        },
        state: "unavailable",
        reason: null,
        graphql: 1,
      },
    ];
    for (const v of variants) {
      await reset();
      await enforceMode();
      history(3);
      mergedPull(7, C(2));
      mergedPull(8, C(3));
      putContent(api, C(1), "version: 1\nguard:\n  auto_merge_reverts: [logic]\n");
      api.state.repository.allow_auto_merge = true;
      await track(C(3), null);
      await v.setup(await prId(7));
      const id = await culprit(ENFORCE);
      await runReverts(ENFORCE);
      expect(await eventById(id), v.name).toMatchObject({
        revert_outcome: "opened",
        auto_merge_state: v.state,
        auto_merge_reason: v.reason,
      });
      expect(api.find("POST", /^\/graphql$/), v.name).toHaveLength(v.graphql);
      expect(
        api.requests.filter((r) => r.method === "PUT"),
        v.name,
      ).toEqual([]);
      expect(api.state.autoMerge.size, v.name).toBe(0);
      if (v.state === "unavailable") {
        expect(commentLines().at(-3)).toBe(
          `Graft opened #${REVERT_PR} to revert this merge. Auto-merge: off: GitHub did not enable it.`,
        );
      }
    }
  });

  it("I-REV-15 a narrowed event: lint is in guard.checks at the original baseline, not at the narrowed one: skipped filtered_at_baseline", async () => {
    history(4);
    mergedPull(7, C(2));
    mergedPull(8, C(3));
    mergedPull(9, C(4));
    await track(C(4), null);
    putContent(api, C(1), "version: 1\nguard:\n  checks: [lint]\n");
    putContent(api, C(2), "version: 1\nguard:\n  checks: [test]\n");
    run(C(1), "lint", "success");
    await observeOnly(C(1));
    run(C(2), "lint", null);
    await observeOnly(C(2));
    run(C(3), "lint", "failure");
    await observeOnly(C(3));
    expect((await events()).map((e) => e.last_green_sha)).toEqual([C(1)]);
    advance(60);
    run(C(2), "lint", "success");
    await observeOnly(C(2));
    expect((await events()).map((e) => [e.last_green_sha, e.status])).toEqual([
      [C(2), "confirming"],
    ]);
    advance(60);
    run(C(4), "lint", "failure");
    await observeOnly(C(4));
    await runReverts();
    const [e] = await events();
    expect(e).toMatchObject({
      status: "culprit_found",
      revert_outcome: "skipped",
      revert_reason: "filtered_at_baseline",
    });
    expect(commentLines().at(-3)).toBe(
      "Graft would not open a revert: the failing checks are not in `guard.checks` at the last green commit.",
    );
  });

  it("I-REV-16 already green: a later commit is green on the failing keys before the job opens: skipped already_green", async () => {
    await enforceMode();
    const id = await culprit(ENFORCE);
    api.state.history.set(C(4), { parents: [C(3)] });
    api.state.branches.set("main", C(4));
    mergedPull(9, C(4));
    await track(C(4), C(3), ENFORCE);
    run(C(4), "test", "success");
    await observeOnly(C(4), ENFORCE);
    await runReverts(ENFORCE);
    expect(await eventById(id)).toMatchObject({
      revert_outcome: "skipped",
      revert_reason: "already_green",
      revert_claimed_at: null,
    });
    expect(commentLines().at(-3)).toBe(
      "Graft did not open a revert: the failing checks are green again on a later commit.",
    );
    expect(routes()).toEqual([R("POST", "/issues/{n}/comments")]);
  });

  it("I-REV-17 a rollback mid-job: report after the PR, before auto-merge: the GraphQL write is refused, error mode_changed, the PR stays, no retry", async () => {
    await enforceMode();
    history(3);
    mergedPull(7, C(2));
    mergedPull(8, C(3));
    putContent(api, C(1), "version: 1\nguard:\n  auto_merge_reverts: [logic]\n");
    api.state.repository.allow_auto_merge = true;
    await track(C(3), null);
    await addCard(t.db, {
      changeId: await prId(7),
      headSha: fakeSha(0xd007),
      risk: "logic",
      createdAt: now,
    });
    const id = await culprit(ENFORCE);
    api.afterNext("POST", /\/labels$/, async () => {
      await t.db.updateTable("repositories").set({ guard_mode: "report" }).execute();
    });
    const queued = await runReverts(ENFORCE);
    expect(await eventById(id)).toMatchObject({
      status: "revert_opened",
      revert_outcome: "error",
      revert_reason: "mode_changed",
      revert_pr_number: REVERT_PR,
      revert_labelled: true,
      auto_merge_state: null,
    });
    expect(api.find("POST", /^\/graphql$/)).toEqual([]);
    expect(refused.map((r) => [r.method, r.refusal])).toEqual([["POST", "mode_report"]]);
    expect(api.state.pulls.get(REVERT_PR)?.state).toBe("open");
    expect(commentLines().at(-3)).toBe(
      `Graft opened #${REVERT_PR} to revert this merge but could not finish (mode_changed). An operator can see the event with \`graft guard list\`.`,
    );
    // Nothing is left to retry.
    expect(await runRevert(queued[0] as RevertData, ctx(ENFORCE))).toBe("stopped");
    expect(api.find("POST", /\/pulls$/)).toHaveLength(1);
    // The same rollback before the pull request: the branch Graft created stays, nothing else.
    await reset();
    await enforceMode();
    const early = await culprit(ENFORCE);
    api.afterNext("POST", /\/git\/refs$/, async () => {
      await t.db.updateTable("repositories").set({ guard_mode: "report" }).execute();
    });
    await runReverts(ENFORCE);
    expect(await eventById(early)).toMatchObject({
      status: "culprit_found",
      revert_outcome: "error",
      revert_reason: "mode_changed",
      revert_branch: `graft-revert/${early}`,
      revert_pr_number: null,
    });
    expect(api.state.branches.has(`graft-revert/${early}`)).toBe(true);
    expect(api.find("POST", /\/pulls$/)).toEqual([]);
    expect(refused.map((r) => [r.method, r.route.endsWith("/pulls"), r.refusal])).toEqual([
      ["POST", true, "mode_report"],
    ]);
    expect(commentLines().at(-3)).toBe(
      "Graft could not open the revert (mode_changed). An operator can see the event with `graft guard list`.",
    );
  });

  it("I-REV-17b a rollback between runs: a PR opened but not stored is adopted, a branch with no PR, or an opened revert's label left, all end error mode_changed, never planned; another refusal is not mode_changed", async () => {
    const rollback = () => t.db.updateTable("repositories").set({ guard_mode: "report" }).execute();
    // The PR was opened, the answer lost; the retry reads report.
    await enforceMode();
    let id = await culprit(ENFORCE);
    api.afterNext("POST", /\/pulls$/, async () => {
      throw new Error("worker crashed");
    });
    let [data] = await takeReverts();
    if (!data) throw new Error("no job");
    await expect(runRevert(data, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    await rollback();
    let before = writes().length;
    await runRevert(data, ctx(ENFORCE, RETRYING));
    expect(await eventById(id)).toMatchObject({
      status: "revert_opened",
      revert_outcome: "error",
      revert_reason: "mode_changed",
      revert_pr_number: REVERT_PR,
    });
    expect(routes().slice(before)).toEqual([R("POST", "/issues/{n}/comments")]);
    expect(refused).toEqual([]);
    expect(commentLines().at(-3)).toBe(
      `Graft opened #${REVERT_PR} to revert this merge but could not finish (mode_changed). An operator can see the event with \`graft guard list\`.`,
    );

    // The commit was written, the ref answer lost: no PR exists.
    await reset();
    await enforceMode();
    id = await culprit(ENFORCE);
    api.afterNext("POST", /\/git\/refs$/, async () => {
      throw new Error("worker crashed");
    });
    [data] = await takeReverts();
    if (!data) throw new Error("no job");
    await expect(runRevert(data, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    await rollback();
    before = writes().length;
    await runRevert(data, ctx(ENFORCE, RETRYING));
    expect(await eventById(id)).toMatchObject({
      status: "culprit_found",
      revert_outcome: "error",
      revert_reason: "mode_changed",
      revert_pr_number: null,
    });
    expect(routes().slice(before)).toEqual([R("POST", "/issues/{n}/comments")]);
    expect(commentLines().at(-3)).toBe(
      "Graft could not open the revert (mode_changed). An operator can see the event with `graft guard list`.",
    );

    // An opened revert whose label answer was lost, resumed in report mode.
    await reset();
    await enforceMode();
    id = await culprit(ENFORCE);
    api.afterNext("POST", /\/labels$/, async () => {
      throw new Error("worker crashed");
    });
    [data] = await takeReverts();
    if (!data) throw new Error("no job");
    await expect(runRevert(data, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    expect(await eventById(id)).toMatchObject({ revert_outcome: "opened", revert_labelled: false });
    await rollback();
    before = writes().length;
    await runRevert(data, ctx(ENFORCE, RETRYING));
    expect(await eventById(id)).toMatchObject({
      status: "revert_opened",
      revert_outcome: "error",
      revert_reason: "mode_changed",
      revert_pr_number: REVERT_PR,
    });
    expect(routes().slice(before)).toEqual([R("POST", "/issues/{n}/comments")]);
    expect(refused).toEqual([]);

    // Finding 5: the repository deactivated mid-job is a refusal, but not a rollback.
    await reset();
    await enforceMode();
    id = await culprit(ENFORCE);
    api.afterNext("POST", /\/git\/refs$/, async () => {
      await t.db.updateTable("repositories").set({ removed_at: now }).execute();
    });
    await runReverts(ENFORCE, RETRYING);
    expect(await eventById(id)).toMatchObject({
      revert_outcome: "error",
      revert_reason: "refused_repository_unknown",
    });
    expect(refused.map((r) => r.refusal)).toEqual(["repository_unknown"]);
  });

  it("I-REV-18 lifecycle: merged gives reverted, closed gives revert_closed, an unknown graft-revert PR gives nothing, a missed webhook is caught by the next push", async () => {
    const closed = (number: number, ref: string) => {
      const p = loadFixture("pull_request.closed.revert").payload as {
        number: number;
        pull_request: { number: number; head: { ref: string } };
      };
      p.number = number;
      p.pull_request.number = number;
      p.pull_request.head.ref = ref;
      return p;
    };
    const deliver = async (payload: unknown) => {
      const queue = new FakeJobQueue();
      await guardPullRequestClosed.handle(event("pull_request", payload), {
        ...ctx(ENFORCE),
        queue,
      });
      return queue.sent;
    };
    // Merged.
    await enforceMode();
    let id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    const pr = api.state.pulls.get(REVERT_PR);
    if (!pr) throw new Error("no revert PR");
    // The payload says closed; the API still says open: nothing changes (the API decides).
    let sent = await deliver(closed(REVERT_PR, `graft-revert/${id}`));
    expect(sent.map((s) => [s.name, s.data])).toEqual([
      ["guard.revert_closed", { repositoryId: REPO_ID, prNumber: REVERT_PR }],
    ]);
    expect(await revertClosed(sent[0]?.data as never, ctx(ENFORCE))).toBe("open");
    expect((await eventById(id)).status).toBe("revert_opened");
    Object.assign(pr, {
      state: "closed",
      merged: true,
      merged_at: "2026-10-14T13:00:00Z",
      closed_at: "2026-10-14T13:00:00Z",
    });
    expect(await revertClosed(sent[0]?.data as never, ctx(ENFORCE))).toBe("reverted");
    expect(await eventById(id)).toMatchObject({
      status: "reverted",
      reverted_at: new Date("2026-10-14T13:00:00Z"),
    });

    // Closed without merge.
    await reset();
    await enforceMode();
    id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    Object.assign(api.state.pulls.get(REVERT_PR) as object, {
      state: "closed",
      closed_at: now.toISOString(),
    });
    sent = await deliver(closed(REVERT_PR, `graft-revert/${id}`));
    expect(await revertClosed(sent[0]?.data as never, ctx(ENFORCE))).toBe("revert_closed");
    expect((await eventById(id)).status).toBe("revert_closed");

    // Step 5 review 1, finding 8: a late webhook for a revert already settled changes nothing,
    // and asks the API nothing.
    const reads = api.find("GET", /\/pulls\/\d+$/).length;
    await t.db
      .updateTable("guard_events")
      .set({ status: "reverted", reverted_at: new Date("2026-10-14T13:00:00Z") })
      .where("id", "=", id)
      .execute();
    expect(await revertClosed(sent[0]?.data as never, ctx(ENFORCE))).toBe("settled");
    expect(await eventById(id)).toMatchObject({
      status: "reverted",
      reverted_at: new Date("2026-10-14T13:00:00Z"),
    });
    expect(api.find("GET", /\/pulls\/\d+$/)).toHaveLength(reads);

    // A graft-revert PR the database does not know, and a PR from another branch.
    expect(await revertClosed({ repositoryId: REPO_ID, prNumber: 4242 }, ctx(ENFORCE))).toBe(
      "no_event",
    );
    expect(await deliver(closed(4242, "feature/x"))).toEqual([]);

    // A missed webhook: the next push maps a default-branch commit to the revert PR.
    await reset();
    await enforceMode();
    id = await culprit(ENFORCE);
    await runReverts(ENFORCE);
    Object.assign(api.state.pulls.get(REVERT_PR) as object, {
      state: "closed",
      merged: true,
      merged_at: "2026-10-14T13:00:00Z",
      closed_at: "2026-10-14T13:00:00Z",
    });
    api.state.history.set(C(4), { parents: [C(3)] });
    api.state.branches.set("main", C(4));
    api.state.commitPulls.set(C(4), [REVERT_PR]);
    await track(C(4), C(3), ENFORCE);
    expect(await eventById(id)).toMatchObject({ status: "reverted" });
  });

  it("I-REV-19 a rebase merge culprit (three commits) is reverted in one PR; a culprit with another commit between its own is history_incomplete", async () => {
    await enforceMode();
    history(5);
    mergedPull(7, C(2), C(3), C(4));
    mergedPull(8, C(5));
    await track(C(5), null);
    run(C(1), "test", "success");
    await observeOnly(C(1), ENFORCE);
    advance(60);
    run(C(4), "test", "failure");
    await observeOnly(C(4), ENFORCE);
    advance(60);
    run(C(5), "test", "failure");
    await observeOnly(C(5), ENFORCE);
    await runReverts(ENFORCE);
    const [e] = await events();
    expect(e).toMatchObject({
      status: "revert_opened",
      revert_plan_paths: 3,
      revert_pr_number: REVERT_PR,
    });
    const tree = api.state.git.commits.get(e?.revert_commit_sha as string)?.tree as string;
    expect([...api.state.git.flatten(tree).keys()].sort()).toEqual(
      [`history/${C(1)}.txt`, `history/${C(5)}.txt`].sort(),
    );
    expect(String(api.find("POST", /\/pulls$/)[0]?.body?.body)).toContain(
      `- Reverts: 3 paths, restored to \`${short(C(1))}\``,
    );

    await reset();
    await enforceMode();
    history(4);
    mergedPull(7, C(2), C(4));
    mergedPull(9, C(3));
    await track(C(4), null);
    const id = await insertEvent({
      failingSha: C(4),
      status: "culprit_found",
      culpritChangeId: await prId(7),
    });
    await runRevert({ ...IDS, eventId: id }, ctx(ENFORCE));
    expect(await eventById(id)).toMatchObject({
      status: "needs_human",
      revert_outcome: "needs_human",
      revert_reason: "history_incomplete",
    });
    expect(routes()).toEqual([R("POST", "/issues/{n}/comments")]);
  });

  it("I-REV-21 GRAFT_GUARD_REVERT=off: the step 4 comment, skipped revert_off, no plan reads", async () => {
    await enforceMode();
    const off = { ...ENFORCE, GRAFT_GUARD_REVERT: "off" };
    const id = await culprit(off);
    const before = api.requests.length;
    await runReverts(off);
    const during = api.requests.slice(before);
    expect(during.filter((r) => /\/git\/|\/pulls|\/contents\//.test(r.path))).toEqual([]);
    expect(during.filter((r) => r.path === `/repos/${FULL_NAME}`)).toEqual([]);
    expect(await eventById(id)).toMatchObject({
      revert_outcome: "skipped",
      revert_reason: "revert_off",
    });
    expect(commentLines().slice(-3)).toEqual([STEP4_PARAGRAPH, "", REPORT_LINE]);
    expect(routes()).toEqual([R("POST", "/issues/{n}/comments")]);
  });

  it("I-REV-22 graft guard list with each outcome, text and --json; doctor warnings with exit 0; mode show note", async () => {
    history(3);
    mergedPull(7, C(2));
    await track(C(3), null);
    const at = (m: number) => new Date(FIXED_NOW.getTime() - m * 60_000);
    const rows: [string, Record<string, unknown>, GuardEventStatus][] = [
      [
        "would revert 4 paths",
        { revert_outcome: "planned", revert_plan_paths: 4, auto_merge_state: "would" },
        "culprit_found",
      ],
      [
        "revert #456 (auto-merge on)",
        {
          revert_outcome: "opened",
          revert_pr_number: 456,
          auto_merge_state: "enabled",
          revert_claimed_at: at(4 * 24 * 60),
        },
        "revert_opened",
      ],
      [
        "needs human: touched later (3)",
        { revert_outcome: "needs_human", revert_reason: "touched_later", revert_conflicts: 3 },
        "needs_human",
      ],
      [
        "skipped: cap reached",
        { revert_outcome: "skipped", revert_reason: "cap_reached" },
        "culprit_found",
      ],
      [
        "error: tree_mismatch",
        { revert_outcome: "error", revert_reason: "tree_mismatch" },
        "culprit_found",
      ],
    ];
    for (const [i, [, revert, status]] of rows.entries()) {
      await insertEvent({ failingSha: fakeSha(0xf200 + i), status, revert, detectedAt: at(i) });
    }
    const text = await ops(["guard", "list", "--repo", FULL_NAME]);
    expect(text.code, text.err).toBe(0);
    const lines = text.out.trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    for (const [i, [label]] of rows.entries())
      expect(lines[i], label).toMatch(new RegExp(`  ${label.replace(/[()#]/g, "\\$&")}$`));
    const json = JSON.parse((await ops(["guard", "list", "--repo", FULL_NAME, "--json"])).out) as {
      events: { revert: Record<string, unknown> }[];
    };
    expect(Object.keys(json.events[0]?.revert ?? {}).sort()).toEqual(
      [
        "autoMergeReason",
        "autoMergeState",
        "branch",
        "commitSha",
        "conflicts",
        "outcome",
        "planPaths",
        "prNumber",
        "reason",
      ].sort(),
    );
    expect(json.events[1]?.revert).toMatchObject({
      outcome: "opened",
      prNumber: 456,
      autoMergeState: "enabled",
    });
    for (const status of ["needs_human", "revert_opened", "reverted", "revert_closed"]) {
      expect(
        (await ops(["guard", "list", "--repo", FULL_NAME, "--status", status])).code,
        status,
      ).toBe(0);
    }
    expect(
      (await ops(["guard", "list", "--repo", FULL_NAME, "--status", "needs_human"])).out,
    ).toContain("needs human: touched later (3)");

    const checks = await runDoctor(t.db, testConfig(), { installationId: INSTALLATION_ID, now });
    expect(
      checks.filter((c) => c.id.startsWith("guard_revert")).map((c) => [c.id, c.status, c.detail]),
    ).toEqual([
      ["guard_reverts_open", "WARN", "1 revert PRs open for more than 72 hours"],
      ["guard_revert_claims", "OK", "no revert claim older than an hour without an outcome"],
      [
        "guard_revert_errors",
        "WARN",
        "1 guard events with revert outcome error in the last 7 days",
      ],
    ]);
    // Warnings never fail the doctor: its exit code is the one this world has without them.
    const doctor = await ops(["pilot", "doctor", "--installation", String(INSTALLATION_ID)]);
    expect(doctor.out).toContain(
      "WARN  guard_reverts_open: 1 revert PRs open for more than 72 hours",
    );
    await t.db
      .updateTable("guard_events")
      .set({ revert_outcome: null, revert_reason: null, status: "culprit_found" })
      .execute();
    const without = await ops(["pilot", "doctor", "--installation", String(INSTALLATION_ID)]);
    expect(without.out).toContain("OK    guard_reverts_open");
    expect(without.out).toContain("OK    guard_revert_errors");
    // Step 5 review 1, finding 4: #456's claim (4 days old) now has no outcome.
    expect(without.out).toContain(
      "WARN  guard_revert_claims: 1 guard events claimed for a revert more than an hour ago with no outcome",
    );
    expect(doctor.code).toBe(without.code);
    expect(
      checks.filter((c) => c.id.startsWith("guard_revert")).every((c) => c.status !== "FAIL"),
    ).toBe(true);

    const show = await ops(["mode", "show", "--repo", FULL_NAME], { GRAFT_GUARD_REVERT: "off" });
    expect(show.out).toContain("  note: guard reverts are off on this shell's config");
    expect((await ops(["mode", "show", "--repo", FULL_NAME])).out).not.toContain(
      "guard reverts are off",
    );
  });

  it("I-REV-10c crash after POST …/pulls, then the installation token fails on the last attempt: the PR is adopted by the lookup, counted by the cap, labelled by the next run; one PR", async () => {
    await enforceMode();
    const id = await culprit(ENFORCE);
    api.afterNext("POST", /\/pulls$/, async () => {
      throw new Error("worker crashed");
    });
    const [data] = await takeReverts();
    if (!data) throw new Error("no job");
    await expect(runRevert(data, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    expect(await eventById(id)).toMatchObject({ revert_pr_number: null, revert_outcome: null });
    const real = t.deps.github;
    let failures = 1;
    t.deps.github = {
      ...real,
      forInstallation: async (...args: Parameters<typeof real.forInstallation>) => {
        if (failures > 0) {
          failures--;
          throw Object.assign(new Error("token service down"), { status: 500 });
        }
        return real.forInstallation(...args);
      },
    };
    await expect(guardRevertJob.handle(data, ctx(ENFORCE, LAST_ATTEMPT))).rejects.toThrow();
    t.deps.github = real;
    let e = await eventById(id);
    expect(e).toMatchObject({
      status: "revert_opened",
      revert_outcome: "opened",
      revert_pr_number: REVERT_PR,
      revert_labelled: false,
      comment_id: null,
    });
    // Counted by the cap (D4): another event sees one open revert.
    expect(await countOpenReverts(t.db, REPO_ID, "00000000-0000-0000-0000-000000000000")).toBe(1);
    expect(comments()).toEqual([]);
    // The next run resumes the label and auto-merge steps, and writes the comment.
    expect(await runRevert(data, ctx(ENFORCE, RETRYING))).toBe("commented");
    e = await eventById(id);
    expect(e).toMatchObject({ revert_outcome: "opened", revert_labelled: true });
    expect(e.comment_id).not.toBeNull();
    expect(api.find("POST", /\/pulls$/)).toHaveLength(1);
    expect(api.find("POST", /\/issues\/\d+\/labels$/)).toHaveLength(1);
  });

  it("I-REV-10d the ref is created, no PR exists, the last attempt fails: no outcome; the next observe re-sends guard.revert, which resumes and opens one PR", async () => {
    await enforceMode();
    const id = await culprit(ENFORCE);
    api.afterNext("POST", /\/git\/refs$/, async () => {
      throw new Error("worker crashed");
    });
    const [data] = await takeReverts();
    if (!data) throw new Error("no job");
    expect(await runRevert(data, ctx(ENFORCE, LAST_ATTEMPT))).toBe("stopped");
    let e = await eventById(id);
    expect(e).toMatchObject({ revert_outcome: null, revert_pr_number: null, comment_id: null });
    expect(e.revert_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(comments()).toEqual([]);
    expect(api.find("POST", /\/pulls$/)).toEqual([]);
    // The job row has expired (taken out above): the next observe sends guard.revert again.
    advance(2 * 3600);
    await observeOnly(C(3), ENFORCE);
    const again = await takeReverts();
    expect(again.map((d) => d.eventId)).toEqual([id]);
    for (const d of again) await runRevert(d, ctx(ENFORCE, RETRYING));
    e = await eventById(id);
    expect(e).toMatchObject({ revert_outcome: "opened", revert_pr_number: REVERT_PR });
    expect(e.comment_id).not.toBeNull();
    expect(api.find("POST", /\/pulls$/)).toHaveLength(1);
    expect(
      [...api.state.pulls.values()].filter((p) => p.head.ref?.startsWith("graft-revert/")),
    ).toHaveLength(1);
  });

  it("I-REV-10d lookup failure: the ref is created, the last attempt fails and its PR lookup fails too: no outcome, left resumable (step 7 review 1, X6)", async () => {
    await enforceMode();
    const id = await culprit(ENFORCE);
    api.afterNext("POST", /\/git\/refs$/, async () => {
      api.failNext("GET", /\/pulls$/, 500);
      throw new Error("worker crashed");
    });
    const [data] = await takeReverts();
    if (!data) throw new Error("no job");
    expect(await runRevert(data, ctx(ENFORCE, LAST_ATTEMPT))).toBe("stopped");
    const e = await eventById(id);
    expect(e).toMatchObject({ revert_outcome: null, revert_pr_number: null, comment_id: null });
    expect(e.revert_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(api.find("GET", /\/pulls$/).length).toBeGreaterThan(0);
    expect(comments()).toEqual([]);
  });

  it("I-REV-10f a permanent error after the ref (POST …/pulls answers 422): settled error with a comment, the cap slot released, no later guard.revert (step 7 review 1, finding 1)", async () => {
    await enforceMode();
    const id = await culprit(ENFORCE);
    api.afterNext("POST", /\/git\/refs$/, async () => {
      api.failNext("POST", /\/pulls$/, 422);
    });
    const [data] = await takeReverts();
    if (!data) throw new Error("no job");
    // Not the last attempt: a permanent error is never retried, so it settles now.
    expect(await runRevert(data, ctx(ENFORCE, RETRYING))).toBe("commented");
    const e = await eventById(id);
    expect(e).toMatchObject({ revert_outcome: "error", revert_pr_number: null });
    expect(e.revert_branch).not.toBeNull();
    expect(e.comment_id).not.toBeNull();
    expect(comments()).toHaveLength(1);
    expect(await countOpenReverts(t.db, REPO_ID, "00000000-0000-0000-0000-000000000000")).toBe(0);
    expect(api.find("POST", /\/pulls$/)).toHaveLength(1);
    // The job row has expired: a later observe sends no guard.revert, and nothing is retried.
    advance(2 * 3600);
    await observeOnly(C(3), ENFORCE);
    expect(await takeReverts()).toEqual([]);
    expect(api.find("POST", /\/pulls$/)).toHaveLength(1);
  });

  it("I-REV-10f settleFailedRun: writes began, then a permanent error outside failed(): settled error with a comment; a retryable one on the last attempt stays resumable", async () => {
    await enforceMode();
    const id = await culprit(ENFORCE);
    api.afterNext("POST", /\/git\/refs$/, async () => {
      throw new Error("worker crashed");
    });
    const [data] = await takeReverts();
    if (!data) throw new Error("no job");
    await expect(runRevert(data, ctx(ENFORCE, RETRYING))).rejects.toThrow();
    expect(await eventById(id)).toMatchObject({ revert_outcome: null, comment_id: null });
    await settleFailedRun(data, ctx(ENFORCE, LAST_ATTEMPT), new Error("token service down"));
    expect(await eventById(id)).toMatchObject({ revert_outcome: null, comment_id: null });
    await settleFailedRun(
      data,
      ctx(ENFORCE, RETRYING),
      new PermanentJobError("forbidden", "github_403"),
    );
    const e = await eventById(id);
    expect(e).toMatchObject({ revert_outcome: "error", revert_pr_number: null });
    expect(e.comment_id).not.toBeNull();
    expect(await countOpenReverts(t.db, REPO_ID, "00000000-0000-0000-0000-000000000000")).toBe(0);
  });

  it("I-REV-10e detected, then the clock passes GRAFT_GUARD_REVERT_MAX_AGE_HOURS, then confirmed now: plans and opens, not stale (step 5 review 2, finding B)", async () => {
    await enforceMode();
    history(3);
    mergedPull(7, C(2));
    mergedPull(8, C(3));
    await track(C(3), null, ENFORCE);
    run(C(1), "test", "success");
    await observeOnly(C(1), ENFORCE);
    advance(60);
    run(C(2), "test", "failure");
    await observeOnly(C(2), ENFORCE);
    advance(25 * 3600);
    run(C(3), "test", "failure");
    await observeOnly(C(3), ENFORCE);
    const e0 = (await events()).find((x) => x.failing_sha === C(2));
    if (!e0) throw new Error("no event");
    expect(e0.status).toBe("culprit_found");
    expect(now.getTime() - (e0.detected_at as Date).getTime()).toBeGreaterThan(24 * 3_600_000);
    await runReverts(ENFORCE);
    expect(await eventById(e0.id)).toMatchObject({
      revert_outcome: "opened",
      revert_pr_number: REVERT_PR,
    });
  });

  it("U-RVC-1 guard.revert_closed: the event becomes reverted between the job's read and its update → settled, reverted_at unchanged (step 5 review 2, nit C)", async () => {
    const id = await culprit();
    const merged = new Date("2026-10-14T12:00:00Z");
    await t.db
      .updateTable("guard_events")
      .set({ status: "revert_opened", revert_outcome: "opened", revert_pr_number: REVERT_PR })
      .where("id", "=", id)
      .execute();
    api.state.pulls.set(
      REVERT_PR,
      makePull({
        number: REVERT_PR,
        node_id: "PR_rvc",
        state: "closed",
        merged: true,
        merged_at: "2026-10-14T13:00:00Z",
        closed_at: "2026-10-14T13:00:00Z",
        head: { sha: fakeSha(0xe500), ref: `graft-revert/${id}` },
      }),
    );
    // guard.track marks it reverted while the job is between its read and its update.
    api.afterNext("GET", new RegExp(`/pulls/${REVERT_PR}$`), async () => {
      await t.db
        .updateTable("guard_events")
        .set({ status: "reverted", reverted_at: merged })
        .where("id", "=", id)
        .execute();
    });
    expect(await revertClosed({ repositoryId: REPO_ID, prNumber: REVERT_PR }, ctx())).toBe(
      "settled",
    );
    const e = await eventById(id);
    expect(e.status).toBe("reverted");
    expect(e.reverted_at?.toISOString()).toBe(merged.toISOString());
  });

  it("I-REV-20 no code read: across this file no request to contents (other than graft.yaml), blobs, compare, a REST commit, or a diff or patch media type", () => {
    const all = [...allRequests, ...api.requests];
    expect(all.length).toBeGreaterThan(200);
    const repo = `/repos/${FULL_NAME}`;
    for (const r of all) {
      const rest = r.path.startsWith(repo) ? r.path.slice(repo.length) : r.path;
      const what = `${r.method} ${r.path}`;
      if (rest.startsWith("/contents/")) expect(rest, what).toBe("/contents/graft.yaml");
      expect(rest, what).not.toMatch(/\/git\/blobs|\/compare\//);
      expect(rest, what).not.toMatch(/^\/commits\/[0-9a-f]{40}$/);
      expect(r.path, what).not.toMatch(/\.(diff|patch)$/);
      expect(r.accept ?? "", what).not.toMatch(/diff|patch/);
    }
    // The guard read trees and commits through the Git Data API.
    expect(all.some((r) => r.method === "GET" && r.path.includes("/git/trees/"))).toBe(true);
  });
});
