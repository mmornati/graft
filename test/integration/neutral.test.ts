/**
 * The neutral regression suite (Phase 1 step 1, T10; Phase 1 step 2, T11; Phase 1 step 4, T12).
 *
 * Every Phase 1 step adds its feature to this suite in report mode. A failure here means Graft
 * would change outcomes for a team that has not opted in.
 *
 * It drives every Phase 0 flow through the real server, queue and worker against the in-memory
 * GitHub, once with default modes and once with every mode at its maximum, and asserts that the
 * writes to GitHub are exactly the Phase 0 set. With default modes every check is `neutral`; with
 * every mode at its maximum, only `graft/policy` may conclude otherwise, and only through the
 * `policy` feature client (step 2).
 */
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import {
  classifyWrite,
  type MutationGate,
  type MutationRefusedError,
} from "../../src/github/mutation-guard.js";
import { buildServer } from "../../src/http/server.js";
import { confirmEvent } from "../../src/modules/guard/index.js";
import { modesApplyJob, mutationGate } from "../../src/modules/modes/index.js";
import { fanoutTeamChange } from "../../src/modules/policy/team-fanout.js";
import { clearPolicyCache } from "../../src/policy/load.js";
import { startWorker } from "../../src/queue/worker.js";
import {
  createTestApp,
  fakeGitHubFactory,
  jobContext,
  postRaw,
  type TestApp,
} from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture } from "../helpers/fixtures.js";
import {
  commitMessage,
  fakeSha,
  HEAD_SHA,
  INSTALLATION_ID,
  makeCommit,
  makeReview,
  OWNER,
  PR_NUMBER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";
import { loadIntentScenario, scenarioLlm } from "../helpers/intent-scenario.js";
import { B1, B2, EXAMPLE_POLICY, putContent } from "../helpers/policy-scenario.js";
import { sleep } from "../helpers/wait.js";

const FULL_NAME = `${OWNER}/${REPO}`;
const REPORT_LINE = "Graft mode: report. This check never blocks a merge.";
const ENFORCE_LINE =
  "Graft mode: enforce. This check passes or fails on this policy; a passing check is not a review approval.";
const HEAD_2 = fakeSha(0xbeef);
/** Step 2: the example policy, with a team constraint as the default. */
const TEAM_POLICY = EXAMPLE_POLICY.replace(
  "default:\n  require: { humans: 1 }",
  "default:\n  require: { humans: 1, team: security }",
).replace(
  "match: { author: agent, risk: sensitive }\n    require: { humans: 2 }",
  "match: { author: agent, risk: sensitive }\n    require: { humans: 1, team: security }",
);
const OTHER_INSTALLATION = INSTALLATION_ID + 1;
/** Phase 1 step 4: the default branch after PR 2 is merged (M) and one more commit (N). */
const MERGE_SHA = fakeSha(0x4e01);
const NEXT_SHA = fakeSha(0x4e02);
const ACTIONS_APP = 15368;

interface Profile {
  name: "default" | "max";
  ceiling: "report" | "enforce";
  /** What the API reports for the installation. */
  permissions: Record<string, string>;
}
const PROFILES: Profile[] = [
  {
    name: "default",
    ceiling: "report",
    permissions: {
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "write",
      checks: "write",
      members: "read",
      statuses: "read",
    },
  },
  {
    name: "max",
    ceiling: "enforce",
    permissions: {
      metadata: "read",
      contents: "write",
      issues: "read",
      pull_requests: "write",
      checks: "write",
      members: "read",
      statuses: "read",
    },
  },
];

describe.each(PROFILES)("neutral regression suite, $name modes", (profile) => {
  let t: TestApp;
  let api: FakeGitHubApi;
  let server: Awaited<ReturnType<typeof buildServer>>;
  const refused: MutationRefusedError[] = [];
  /** Every gate question, with its answer: the gate is asked only for feature-client writes. */
  const gateCalls: { feature: string; allowed: boolean }[] = [];
  // The policy check's mode line before the mode changes, after the first and after the second.
  const lines = { before: "", first: "", second: "" };
  const writesAround = { before: 0, afterFirst: 0 };
  /** Phase 1 step 4: every feature a client was built for, and the guard scenario's results. */
  const featureClients: (string | null)[] = [];
  const guard = {
    requestsAtEnd: 0,
    featureClients: [] as (string | null)[],
    gateFeatures: [] as string[],
    writesBeforeReplay: 0,
    writesAfterReplay: 0,
  };
  // default: enforce, then back to report. max: it starts at enforce, so report (a rollback) first.
  const FIRST = profile.name === "max" ? "report" : "enforce";
  const SECOND = profile.name === "max" ? "enforce" : "report";

  // The guard observes right away (no delay) so that the suite's drain sees its jobs.
  const config = () =>
    testConfig({ GRAFT_MODE_CEILING: profile.ceiling, GRAFT_GUARD_OBSERVE_DELAY_SECONDS: "0" });
  const policyRun = () =>
    api.state.checkRuns.filter((c) => c.name === "graft/policy" && c.head_sha === HEAD_2).at(0);
  const writes = () => api.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD");
  const checkWrites = () =>
    api.requests.filter((r) => r.method !== "GET" && /\/check-runs(\/\d+)?$/.test(r.path));
  const nonNeutral = (r: { body?: Record<string, unknown> | undefined }) =>
    (r.body?.status !== undefined && r.body.status !== "completed") ||
    (r.body?.conclusion !== undefined && r.body.conclusion !== "neutral");

  /**
   * No unfinished job for four polls in a row. A failed or retrying job fails the test. A job
   * deferred into the future (the card wait, the team fan-out's debounce) is not waited for.
   */
  async function drain(): Promise<void> {
    let quiet = 0;
    const deadline = Date.now() + 40_000;
    while (quiet < 4) {
      if (Date.now() > deadline) throw new Error("the queue did not drain");
      const res = await sql<{ n: string }>`
        select count(*)::text as n from pgboss.job
        where state in ('created', 'retry', 'active') and start_after <= now()`.execute(t.db);
      quiet = res.rows[0]?.n === "0" ? quiet + 1 : 0;
      await sleep(150);
    }
  }
  async function post(
    fixture: string,
    delivery: string,
    edit: (p: Record<string, unknown>) => void = () => {},
  ) {
    const { event, payload } = loadFixture(fixture);
    edit(payload);
    const res = await postRaw(server, event, JSON.stringify(payload), delivery);
    expect(res.statusCode, `${fixture} ${res.body}`).toBe(202);
    await drain();
  }
  let tick = 0;
  const ops = async (...argv: string[]) => {
    let out = "";
    const deps: OpsDeps = {
      loadConfig: config,
      openDb: () => testDb(),
      github: () => fakeGitHubFactory(api),
      // Each mode change gets its own second, so the history has an order.
      now: () => new Date(FIXED_NOW.getTime() + 1000 * tick++),
      sleep: async () => {},
    };
    const code = await opsMain(argv, { out: (s) => (out += s), err: (s) => (out += s) }, deps);
    expect(code, out).toBe(0);
  };
  const apply = async () => {
    await t.deps.queue.send(modesApplyJob, {});
    await drain();
  };
  /** installation_repositories.added on another installation: a transfer (D13). */
  const transfer = (to: number, delivery: string) =>
    post("installation_repositories.added", delivery, (p) => {
      (p.installation as { id: number }).id = to;
      p.repositories_added = [{ id: REPO_ID, full_name: FULL_NAME, private: true }];
    });

  beforeAll(async () => {
    t = await createTestApp({
      supervise: true,
      llm: scenarioLlm(),
      config: { GRAFT_MODE_CEILING: profile.ceiling, GRAFT_GUARD_OBSERVE_DELAY_SECONDS: "0" },
    });
    await truncateAll(t.db);
    clearPolicyCache();
    api = createFakeGitHubApi();
    const real = mutationGate(t.db, config());
    const gate: MutationGate = async (q) => {
      const v = await real(q);
      gateCalls.push({ feature: q.feature, allowed: v.allowed });
      return v;
    };
    const factory = fakeGitHubFactory(api, gate, (e) => refused.push(e));
    t.deps.github = {
      asApp: () => factory.asApp(),
      forInstallation: (id, opts) => {
        featureClients.push(opts?.feature ?? null);
        return factory.forInstallation(id, opts);
      },
    };
    api.state.installationPermissions = profile.permissions;
    server = await buildServer(t.deps);
    await startWorker(t.deps.queue, t.deps.registry, jobContext(t), {
      concurrency: 4,
      pollingIntervalSeconds: 0.5,
    });

    // The world: PR 2 by an agent, a base branch with a team-constrained policy.
    loadIntentScenario(api);
    api.state.branches.set("main", B1);
    putContent(api, B1, TEAM_POLICY);
    api.state.commits.set(PR_NUMBER, [
      makeCommit(
        HEAD_SHA,
        commitMessage("Fix the retry loop", undefined, [
          ["Graft-Agent", "claude-code"],
          ["Graft-Model", "claude-sonnet-5-5"],
        ]),
      ),
    ]);
    // Step 2: alice is in the team, bob is not; both can write; dave can write too.
    api.state.teams.set("security", { members: new Map([["alice", "active"]]) });
    for (const [login, id] of [
      ["alice", 601],
      ["bob", 602],
      ["dave", 604],
    ] as const) {
      api.state.permissions.set(login, { id, role: "write" });
    }

    // installation created
    await post("installation.created", "n-inst");
    if (profile.name === "max") {
      // Every mode at its maximum, on every repository.
      await t.db
        .updateTable("repositories")
        .set({ policy_mode: "enforce", guard_mode: "enforce", mcp_write: "on" })
        .execute();
    }
    // PR opened (agent trailers), intent card (it arrives after the PR), policy
    await post("pull_request.opened", "n-open");
    // reviews: a team member, a non-member, and a change request
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 11, login: "alice", userId: 601 }),
      makeReview({ id: 12, login: "bob", userId: 602 }),
      makeReview({ id: 13, login: "dave", userId: 604, state: "CHANGES_REQUESTED" }),
    ]);
    await post("pull_request_review.submitted", "n-review");
    // the change request is dismissed
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 11, login: "alice", userId: 601 }),
      makeReview({ id: 12, login: "bob", userId: 602 }),
      makeReview({ id: 13, login: "dave", userId: 604, state: "DISMISSED" }),
    ]);
    await post("pull_request_review.dismissed", "n-dismiss");
    // a team membership changes: the handler debounces, the fan-out re-evaluates
    await post("membership.added", "n-member");
    // The fan-out is deferred past its window (trailing edge): run the queued job's data directly.
    const fanout = await sql<{ data: { installationId: number; window: number } }>`
      select data from pgboss.job where name = 'policy.team_fanout'`.execute(t.db);
    expect(fanout.rows).toHaveLength(1);
    await fanoutTeamChange(fanout.rows[0]?.data as never, jobContext(t));
    await drain();
    // label added
    const pull = api.state.pulls.get(PR_NUMBER);
    if (!pull) throw new Error("no pull");
    pull.labels = [{ name: "needs-review" }];
    pull.updated_at = "2026-10-14T11:10:00Z";
    await post("pull_request.labeled", "n-label", (p) => {
      p.label = { name: "needs-review" };
    });
    // push to the PR: every approval is now on an older head
    pull.head.sha = HEAD_2;
    pull.updated_at = "2026-10-14T11:20:00Z";
    api.state.commits.set(PR_NUMBER, [
      makeCommit(
        HEAD_2,
        commitMessage("Retry harder", undefined, [["Graft-Agent", "claude-code"]]),
      ),
    ]);
    await post("pull_request.synchronize", "n-sync", (p) => {
      (p.pull_request as { head: { sha: string } }).head.sha = HEAD_2;
      p.after = HEAD_2;
    });
    // push to main changing graft.yaml (fan-out)
    api.state.branches.set("main", B2);
    putContent(api, B2, `${TEAM_POLICY}\n# tightened\n`);
    await post("push", "n-push", (p) => {
      p.ref = "refs/heads/main";
      p.after = B2;
      p.forced = false;
    });
    // check_run.rerequested on the policy check
    await post("check_run.rerequested", "n-rerun", (p) => {
      const run = p.check_run as Record<string, unknown>;
      run.name = "graft/policy";
      run.head_sha = HEAD_2;
      run.app = { id: 12345 };
      run.pull_requests = [{ number: PR_NUMBER }];
    });
    // requested_action "Accurate" on the intent check
    const intent = api.state.checkRuns.find((c) => c.name === "graft/intent");
    if (!intent) throw new Error("no intent check run");
    await post("check_run.requested_action", "n-action", (p) => {
      const run = p.check_run as Record<string, unknown>;
      run.id = intent.id;
      run.name = "graft/intent";
      run.head_sha = intent.head_sha;
      run.external_id = intent.external_id;
      run.app = { id: 12345 };
      p.requested_action = { identifier: "card_up" };
    });
    // feedback sweep
    const { feedbackSweepJob } = await import("../../src/modules/intent/index.js");
    await t.deps.queue.send(feedbackSweepJob, {});
    await drain();

    // mode set, each followed by modes.apply and no webhook
    lines.before = policyRun()?.output.text?.split("\n")[0] ?? "";
    writesAround.before = writes().length;
    await ops(
      "mode",
      "set",
      "--repo",
      FULL_NAME,
      "--policy",
      FIRST,
      "--actor",
      "tester",
      "--reason",
      "neutral suite",
    );
    await apply();
    lines.first = policyRun()?.output.text?.split("\n")[0] ?? "";
    writesAround.afterFirst = writes().length;
    await ops(
      "mode",
      "set",
      "--repo",
      FULL_NAME,
      "--policy",
      SECOND,
      "--actor",
      "tester",
      "--reason",
      "back again",
    );
    await apply();
    lines.second = policyRun()?.output.text?.split("\n")[0] ?? "";

    // a repository transfer, away and back: the modes reset (D13) and the apply republishes
    await transfer(OTHER_INSTALLATION, "n-transfer-away");
    await transfer(INSTALLATION_ID, "n-transfer-back");
    await apply();
    // The transfer reset the modes; the max profile goes back to every mode at its maximum.
    if (profile.name === "max") {
      await t.db
        .updateTable("repositories")
        .set({ policy_mode: "enforce", guard_mode: "enforce", mcp_write: "on" })
        .execute();
    }
    // The pull request is merged last: the mode changes above re-evaluate open PRs only.
    const merged = api.state.pulls.get(PR_NUMBER);
    if (!merged) throw new Error("no pull");
    // Phase 1 step 4 (T12): the guard. PR 2 is merged into main as M; CI was green on the
    // parent (B2), is red on M, and red again on the next commit N. Both pushes and the check
    // runs arrive as webhooks; the confirm job runs too.
    merged.state = "closed";
    merged.merged = true;
    merged.merge_commit_sha = MERGE_SHA;
    merged.merged_at = "2026-10-14T11:40:00Z";
    merged.closed_at = "2026-10-14T11:40:00Z";
    api.state.history.set(B2, { parents: [] });
    api.state.history.set(MERGE_SHA, { parents: [B2] });
    api.state.history.set(NEXT_SHA, { parents: [MERGE_SHA] });
    api.state.commitPulls.set(MERGE_SHA, [PR_NUMBER]);
    const ciRun = (sha: string, conclusion: string) => {
      const id = api.state.nextId++;
      api.state.checkRuns.push({
        id,
        name: "test",
        head_sha: sha,
        status: "completed",
        conclusion,
        external_id: "",
        output: { title: "", summary: "" },
        app: { id: ACTIONS_APP },
        completed_at: "2026-10-14T11:45:00Z",
        html_url: `https://github.com/${FULL_NAME}/runs/${id}`,
      });
    };
    const pushMain = (delivery: string, before: string, after: string) =>
      post("push.default", delivery, (p) => {
        p.before = before;
        p.after = after;
      });
    ciRun(B2, "success");
    await pushMain("n-guard-base", "0".repeat(40), B2);
    ciRun(MERGE_SHA, "failure");
    api.state.branches.set("main", MERGE_SHA);
    putContent(api, MERGE_SHA, `${TEAM_POLICY}\n# tightened\n`);
    await pushMain("n-guard-merge", B2, MERGE_SHA);
    ciRun(NEXT_SHA, "failure");
    api.state.branches.set("main", NEXT_SHA);
    await pushMain("n-guard-next", MERGE_SHA, NEXT_SHA);
    await post("check_run.completed", "n-guard-run", (p) => {
      const run = p.check_run as { head_sha: string; check_suite: { head_sha: string } };
      run.head_sha = NEXT_SHA;
      run.check_suite.head_sha = NEXT_SHA;
    });
    const confirmJobs = await sql<{ data: { eventId: string } }>`
      select data from pgboss.job where name = 'guard.confirm'`.execute(t.db);
    expect(confirmJobs.rows).toHaveLength(1);
    await confirmEvent(confirmJobs.rows[0]?.data as { eventId: string }, jobContext(t));
    await drain();
    guard.requestsAtEnd = api.requests.length;
    guard.featureClients = [...featureClients];
    guard.gateFeatures = gateCalls.map((c) => c.feature);
    // N-9: a second observe and a replayed check_run.completed, also after the stored comment id
    // was lost (a retry after the POST but before the commit): no write.
    guard.writesBeforeReplay = writes().length;
    await post("check_run.completed", "n-guard-replay", (p) => {
      const run = p.check_run as { head_sha: string; check_suite: { head_sha: string } };
      run.head_sha = NEXT_SHA;
      run.check_suite.head_sha = NEXT_SHA;
    });
    await t.db.updateTable("guard_events").set({ comment_id: null }).execute();
    await post("check_run.completed", "n-guard-replay-2", (p) => {
      const run = p.check_run as { head_sha: string; check_suite: { head_sha: string } };
      run.head_sha = MERGE_SHA;
      run.check_suite.head_sha = MERGE_SHA;
    });
    guard.writesAfterReplay = writes().length;
  }, 240_000);

  afterAll(async () => {
    await server.close();
    await t.close();
  });

  it(`N-1 [${profile.name}] every non-GET request matches a phase 0 or auth row of the route table`, () => {
    const all = writes();
    expect(all.length).toBeGreaterThan(5);
    for (const r of all) {
      const kind = classifyWrite(r.method, r.path).kind;
      expect(["phase0", "auth"], `${r.method} ${r.path}`).toContain(kind);
    }
    const paths = new Set(all.map((r) => `${r.method} ${r.path.replace(/\d+$/, "{n}")}`));
    expect(paths).toContain(`POST /repos/${FULL_NAME}/check-runs`);
    expect(paths).toContain(`PATCH /repos/${FULL_NAME}/check-runs/{n}`);
    expect(paths).toContain(`POST /repos/${FULL_NAME}/issues/${PR_NUMBER}/comments`);
  });

  if (profile.name === "default") {
    it("N-2 [default] every Graft check run created or updated has conclusion neutral", () => {
      const all = checkWrites();
      expect(all.length).toBeGreaterThan(3);
      for (const r of all) {
        // A write without a conclusion leaves the stored one alone; one with it says neutral.
        if (r.body && "conclusion" in r.body) expect(r.body.conclusion).toBe("neutral");
        expect(nonNeutral(r), JSON.stringify(r.body?.status)).toBe(false);
      }
      // Graft's own runs (step 4 adds other apps' CI runs on the default branch to the fake).
      const own = api.state.checkRuns.filter((c) => c.app.id === 12345);
      const names = new Set(own.map((c) => c.name));
      expect([...names].sort()).toEqual(["graft/intent", "graft/policy", "graft/provenance"]);
      for (const run of own) {
        if (run.status === "completed")
          expect(run.conclusion, `${run.name} ${run.id}`).toBe("neutral");
      }
      expect(
        api.state.checkRuns
          .filter((c) => c.name === "graft/policy")
          .every((c) => c.status === "completed"),
      ).toBe(true);
      expect(api.state.checkRuns.filter((c) => c.name === "graft/policy").length).toBeGreaterThan(
        0,
      );
      // The gate was never asked: nothing tried a Phase 1 write.
      expect(gateCalls).toEqual([]);
    });

    it("N-6 [default] every verdict row was published neutral and stores what enforce would conclude", async () => {
      const rows = await t.db.selectFrom("policy_verdicts").selectAll().execute();
      expect(rows.length).toBeGreaterThan(1);
      for (const r of rows) {
        expect(r.check_conclusion).toBe("neutral");
        expect(r.policy_mode).toBe("report");
        expect(r.enforced_conclusion).not.toBeNull();
        expect(r.enforced_reason).not.toBeNull();
      }
      // The team constraint was verified: alice counted for it while her approval was current.
      const first = rows.filter((r) => r.head_sha === HEAD_SHA);
      const constraints = first.flatMap(
        (r) =>
          ((r.approvals as { constraints?: unknown[] }).constraints ?? []) as {
            teamCount: number;
            met: boolean;
            approved: number;
          }[],
      );
      expect(
        constraints.some((c) => c.teamCount > 0 && c.met && c.approved >= 1),
        JSON.stringify(first.map((r) => r.approvals)),
      ).toBe(true);
      // After the push her approval is stale: what enforce would say is a failure.
      expect(rows.find((r) => r.head_sha === HEAD_2)?.enforced_conclusion).toBe("failure");
    });
  } else {
    it("N-2b [max] intent and provenance are always neutral; every non-neutral or in_progress check write is graft/policy, through the policy feature client", () => {
      const all = checkWrites();
      expect(all.length).toBeGreaterThan(3);
      const byId = new Map(api.state.checkRuns.map((c) => [c.id, c.name]));
      const nameOf = (r: (typeof all)[number]) =>
        (r.body?.name as string | undefined) ?? byId.get(Number(r.path.split("/").at(-1)));
      const enforcing = all.filter(nonNeutral);
      expect(enforcing.length).toBeGreaterThan(0);
      for (const r of enforcing) expect(nameOf(r)).toBe("graft/policy");
      for (const r of all.filter((x) => nameOf(x) !== "graft/policy")) {
        expect(nonNeutral(r), `${nameOf(r)} ${JSON.stringify(r.body)}`).toBe(false);
      }
      for (const run of api.state.checkRuns.filter(
        (c) => c.name !== "graft/policy" && c.app.id === 12345,
      )) {
        expect(run.conclusion, `${run.name} ${run.id}`).toBe("neutral");
      }
      // The gate is asked only for feature-client writes: one allowed `policy` answer per
      // non-neutral check write that reached GitHub.
      expect(gateCalls.every((c) => c.feature === "policy")).toBe(true);
      expect(gateCalls.filter((c) => c.allowed)).toHaveLength(enforcing.length);
    });

    it("N-6 [max] every verdict row stores what enforce would conclude; report rows were published neutral", async () => {
      const rows = await t.db.selectFrom("policy_verdicts").selectAll().execute();
      for (const r of rows) {
        expect(r.enforced_conclusion).not.toBeNull();
        if (r.policy_mode === "report") expect(r.check_conclusion).toBe("neutral");
        else expect(r.check_conclusion).toBe(r.enforced_conclusion);
      }
    });
  }

  it(`N-1g [${profile.name}] the guard's only write is one comment on the culprit PR, with the marker`, async () => {
    const rows = await t.db.selectFrom("guard_events").selectAll().execute();
    expect(rows.map((r) => [r.failing_sha, r.status, r.confirm_reason])).toEqual([
      [MERGE_SHA, "culprit_found", "next_commit"],
    ]);
    const guardComments = api.state.comments.filter((c) =>
      c.body.startsWith("<!-- graft:guard-event "),
    );
    expect(guardComments).toHaveLength(1);
    expect(guardComments[0]?.issue_number).toBe(PR_NUMBER);
    expect(guardComments[0]?.body.split("\n")[0]).toBe(`<!-- graft:guard-event ${rows[0]?.id} -->`);
    // Report mode in the default profile; enforce (effective) in max, which only changes the line.
    expect(guardComments[0]?.body.split("\n").at(-1)).toBe(
      profile.name === "max"
        ? "Graft mode: enforce. Revert PRs are not available in this version; nothing was opened."
        : "Graft mode: report. Graft opens nothing; this is what it would do.",
    );
    expect(rows[0]?.guard_mode).toBe(profile.name === "max" ? "enforce" : "report");
  });

  it(`N-8 [${profile.name}] no request used a phase1 route or a guard feature client`, () => {
    const upTo = api.requests.slice(0, guard.requestsAtEnd);
    for (const r of upTo) {
      if (r.method === "GET" || r.method === "HEAD") continue;
      expect(classifyWrite(r.method, r.path).kind, `${r.method} ${r.path}`).not.toBe("phase1");
    }
    expect(guard.featureClients).not.toContain("guard");
    expect(guard.gateFeatures).not.toContain("guard");
  });

  it(`N-9 [${profile.name}] a second observe after confirmation and a replayed check_run.completed add no write`, () => {
    expect(guard.writesAfterReplay).toBe(guard.writesBeforeReplay);
  });

  it(`N-3 [${profile.name}] the guard refused nothing in the Phase 0 flows, and no job failed`, async () => {
    expect(refused.map((e) => e.message)).toEqual([]);
    const bad = await sql<{ name: string; state: string }>`
      select name, state from pgboss.job where state in ('failed', 'retry')`.execute(t.db);
    expect(bad.rows).toEqual([]);
  });

  it(`N-4 [${profile.name}] after mode set, the next modes.apply republishes the policy check without a webhook`, async () => {
    if (profile.name === "max") {
      // Enforce is effective: the rollback to report is republished in place, then enforce again.
      expect([lines.before, lines.first, lines.second]).toEqual([
        ENFORCE_LINE,
        REPORT_LINE,
        ENFORCE_LINE,
      ]);
      expect(writesAround.afterFirst).toBeGreaterThan(writesAround.before);
    } else {
      // Under a report ceiling the request is recorded and changes nothing GitHub shows.
      expect([lines.before, lines.first, lines.second]).toEqual([
        REPORT_LINE,
        REPORT_LINE,
        REPORT_LINE,
      ]);
      expect(writesAround.afterFirst).toBe(writesAround.before);
    }
    const history = await t.db
      .selectFrom("mode_changes")
      .selectAll()
      .where("actor", "=", "tester")
      .orderBy("created_at")
      .execute();
    expect(history.map((h) => [h.key, h.to_value, h.applied_at !== null])).toEqual([
      ["policy_mode", FIRST, true],
      ["policy_mode", SECOND, true],
    ]);
    // The transfer reset the modes with system rows (max only: default was already at the floors),
    // and the apply after it left the check completed and neutral.
    const system = await t.db
      .selectFrom("mode_changes")
      .selectAll()
      .where("actor", "=", "system")
      .execute();
    expect(system.map((s) => [s.key, s.reason]).sort()).toEqual(
      profile.name === "max"
        ? [
            ["guard_mode", "installation changed"],
            ["mcp_write", "installation changed"],
            ["policy_mode", "installation changed"],
          ]
        : [],
    );
    expect(system.every((s) => s.applied_at !== null)).toBe(true);
    expect(policyRun()).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(policyRun()?.output.text?.split("\n")[0]).toBe(REPORT_LINE);
  });

  /** N-5 and N-7 need the repository back at its profile's modes after the transfer. */
  const restoreModes = async () => {
    if (profile.name === "max") {
      await t.db
        .updateTable("repositories")
        .set({ policy_mode: "enforce", guard_mode: "enforce", mcp_write: "on" })
        .execute();
    }
  };

  it(`N-5 [${profile.name}] a Phase 1 write is refused by mode or by the missing feature, and the gate is read at request time`, async () => {
    await restoreModes();
    const createRef = (c: Awaited<ReturnType<typeof t.deps.github.forInstallation>>) =>
      c.rest.git.createRef({
        owner: OWNER,
        repo: REPO,
        ref: "refs/heads/graft-revert/n5",
        sha: HEAD_2,
      });
    const reason = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
      } catch (e) {
        return (e as MutationRefusedError).refusal ?? `other: ${(e as Error).message}`;
      }
      return "sent";
    };
    const feature = await t.deps.github.forInstallation(INSTALLATION_ID, { feature: "guard" });
    const plain = await t.deps.github.forInstallation(INSTALLATION_ID);
    const before = refused.length;
    const sent = () =>
      api.requests.filter((r) => r.method === "POST" && r.path.endsWith("/git/refs"));

    if (profile.name === "default") {
      expect(await reason(createRef(feature))).toBe("mode_report");
      expect(sent()).toEqual([]);
    } else {
      // The default client has no feature, whatever the mode.
      expect(await reason(createRef(plain))).toBe("no_feature");
      expect(sent()).toEqual([]);
      // The feature client reaches the fake (which answers 404: no such route), not a refusal.
      const first = await reason(createRef(feature));
      expect(first).toMatch(/^other: /);
      expect(sent()).toHaveLength(1);
      // Flip the mode between two calls on the same client: the next one is refused.
      await t.db.updateTable("repositories").set({ guard_mode: "report" }).execute();
      expect(await reason(createRef(feature))).toBe("mode_report");
      expect(sent()).toHaveLength(1);
      await t.db.updateTable("repositories").set({ guard_mode: "enforce" }).execute();
      expect(await reason(createRef(feature))).toMatch(/^other: /);
      expect(sent()).toHaveLength(2);
      // An unknown repository (the gate resolves it by name) is refused too.
      const stranger = await t.deps.github.forInstallation(INSTALLATION_ID + 1, {
        feature: "guard",
      });
      expect(await reason(createRef(stranger))).toBe("repository_unknown");
    }
    expect(refused.length).toBeGreaterThan(before);
  });

  it(`N-7 [${profile.name}] a non-neutral check: refused without the policy feature; with it, refused in report and sent in enforce; never for another check`, async () => {
    await restoreModes();
    const reason = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
      } catch (e) {
        return (e as MutationRefusedError).refusal ?? `other: ${(e as Error).message}`;
      }
      return "sent";
    };
    const failing = (c: Awaited<ReturnType<typeof t.deps.github.forInstallation>>, name: string) =>
      c.rest.checks.create({
        owner: OWNER,
        repo: REPO,
        head_sha: HEAD_2,
        name,
        status: "completed",
        conclusion: "failure",
        output: { title: "n7", summary: "n7" },
      });
    const plain = await t.deps.github.forInstallation(INSTALLATION_ID);
    const policy = await t.deps.github.forInstallation(INSTALLATION_ID, { feature: "policy" });
    const sentFailures = () =>
      checkWrites().filter((r) => r.body?.conclusion === "failure" && r.body?.output);
    const before = sentFailures().length;

    expect(await reason(failing(plain, "graft/policy"))).toBe("no_feature");
    if (profile.name === "default") {
      expect(await reason(failing(policy, "graft/policy"))).toBe("mode_report");
      expect(sentFailures()).toHaveLength(before);
    } else {
      expect(await reason(failing(policy, "graft/policy"))).toBe("sent");
      expect(sentFailures()).toHaveLength(before + 1);
      expect(await reason(failing(policy, "graft/intent"))).toBe("feature_not_allowed");
      expect(sentFailures()).toHaveLength(before + 1);
    }
  });

  /**
   * Phase 1 step 3 (T8): the break-glass label, through the real server and worker. A triage user
   * labels (ignored) and takes it off, a maintainer labels (applied), the PR is pushed, and the
   * label is removed. Under `default` nothing changes on GitHub; under `max` the only `success`
   * is on the labelled head, and the next head goes back to the normal conclusion.
   */
  const breakGlass = {
    from: 0,
    gateFrom: 0,
    refusedFrom: 0,
    labelledHead: "",
    nextHead: fakeSha(0xbe33),
  };
  const breakGlassScenario = async () => {
    await restoreModes();
    breakGlass.from = api.requests.length;
    breakGlass.gateFrom = gateCalls.length;
    // N-5 and N-7 provoke refusals on purpose; only this scenario's count.
    breakGlass.refusedFrom = refused.length;
    const pull = api.state.pulls.get(PR_NUMBER);
    if (!pull) throw new Error("no pull");
    // The step 4 guard scenario merged PR 2 earlier in this suite; break-glass needs an open PR,
    // so it is reopened here with times after that merge (the change row then takes them).
    pull.state = "open";
    pull.merged = false;
    pull.merge_commit_sha = null;
    pull.merged_at = null;
    pull.closed_at = null;
    breakGlass.labelledHead = pull.head.sha;
    api.state.permissions.set("maya", { id: 701, role: "maintain" });
    api.state.permissions.set("tom", { id: 702, role: "triage" });
    let minute = 40;
    let eventId = 9000;
    const labelAction = async (action: "labeled" | "unlabeled", login: string, id: number) => {
      const events = api.state.issueEvents.get(PR_NUMBER) ?? [];
      const at = `2026-10-14T12:${String(minute++).padStart(2, "0")}:00Z`;
      events.push({
        id: eventId++,
        event: action,
        actor: { id, login, type: "User" },
        label: { name: "graft:break-glass", color: "b60205" },
        created_at: at,
      });
      api.state.issueEvents.set(PR_NUMBER, events);
      const others = (pull.labels ?? []).filter((l) => l.name !== "graft:break-glass");
      pull.labels = action === "labeled" ? [...others, { name: "graft:break-glass" }] : others;
      pull.updated_at = at;
      await post("pull_request.labeled.break-glass", `n-bg-${eventId}`, (p) => {
        p.action = action;
        const pr = p.pull_request as { head: { sha: string }; updated_at: string };
        pr.head.sha = pull.head.sha;
        pr.updated_at = at;
      });
    };
    await labelAction("labeled", "tom", 702);
    await labelAction("unlabeled", "tom", 702);
    await labelAction("labeled", "maya", 701);
    // A push after labelling: the bypass ends with it.
    pull.head.sha = breakGlass.nextHead;
    pull.updated_at = `2026-10-14T12:${String(minute++).padStart(2, "0")}:00Z`;
    api.state.commits.set(PR_NUMBER, [
      makeCommit(
        breakGlass.nextHead,
        commitMessage("Retry again", undefined, [["Graft-Agent", "claude-code"]]),
      ),
    ]);
    await post("pull_request.synchronize", "n-bg-sync", (p) => {
      (p.pull_request as { head: { sha: string } }).head.sha = breakGlass.nextHead;
      p.after = breakGlass.nextHead;
    });
    await labelAction("unlabeled", "maya", 701);
  };
  const scenarioWrites = () =>
    api.requests.slice(breakGlass.from).filter((r) => r.method !== "GET" && r.method !== "HEAD");
  // The app's clock is fixed, so the rows share a time: ordered by kind (applied, ignored).
  const scenarioAudit = () =>
    t.db.selectFrom("audit_log").selectAll().orderBy("created_at").orderBy("kind").execute();

  if (profile.name === "default") {
    it("N-10 [default] break-glass: the check stays neutral throughout and the only writes are Phase 0 routes", async () => {
      await breakGlassScenario();
      const writes = scenarioWrites();
      expect(writes.length).toBeGreaterThan(3);
      for (const r of writes) {
        expect(["phase0", "auth"], `${r.method} ${r.path}`).toContain(
          classifyWrite(r.method, r.path).kind,
        );
        if (/\/check-runs(\/\d+)?$/.test(r.path)) {
          expect(nonNeutral(r), JSON.stringify(r.body)).toBe(false);
        }
      }
      for (const run of api.state.checkRuns.filter((c) => c.name === "graft/policy")) {
        expect(run, `${run.head_sha}`).toMatchObject({
          status: "completed",
          conclusion: "neutral",
        });
      }
      expect(gateCalls.slice(breakGlass.gateFrom)).toEqual([]);
      expect(refused.slice(breakGlass.refusedFrom).map((e) => e.message)).toEqual([]);
      // Recorded in report mode: the triage label ignored, the maintainer's applied, in report.
      const rows = await scenarioAudit();
      expect(rows.map((r) => [r.kind, r.reason, r.actor_login, r.policy_mode])).toEqual([
        ["applied", null, "maya", "report"],
        ["ignored", "role_too_low", "tom", "report"],
      ]);
      expect(rows.every((r) => r.head_sha === breakGlass.labelledHead)).toBe(true);
      // What enforce would have said for the labelled head: bypassed.
      const verdicts = await t.db
        .selectFrom("policy_verdicts")
        .selectAll()
        .where("enforced_reason", "=", "break_glass")
        .execute();
      expect(verdicts.length).toBeGreaterThan(0);
      for (const v of verdicts) {
        expect(v.head_sha).toBe(breakGlass.labelledHead);
        expect(v.check_conclusion).toBe("neutral");
      }
    });
  } else {
    it("N-11 [max] break-glass: the only success is on the labelled head, through the policy feature client; the next head goes back to the normal conclusion", async () => {
      await breakGlassScenario();
      const writes = scenarioWrites();
      for (const r of writes) {
        expect(["phase0", "auth"], `${r.method} ${r.path}`).toContain(
          classifyWrite(r.method, r.path).kind,
        );
      }
      const headOf = (r: (typeof writes)[number]): string | undefined => {
        if (typeof r.body?.head_sha === "string") return r.body.head_sha;
        const id = Number(r.path.split("/").at(-1));
        return api.state.checkRuns.find((c) => c.id === id)?.head_sha;
      };
      const checkWritesHere = writes.filter((r) => /\/check-runs(\/\d+)?$/.test(r.path));
      const successes = checkWritesHere.filter((r) => r.body?.conclusion === "success");
      expect(successes.length).toBeGreaterThan(0);
      for (const r of successes) expect(headOf(r)).toBe(breakGlass.labelledHead);
      // Every non-neutral write went through the policy client and an allowed gate answer.
      const enforcing = checkWritesHere.filter(nonNeutral);
      const gate = gateCalls.slice(breakGlass.gateFrom);
      expect(gate.every((c) => c.feature === "policy")).toBe(true);
      expect(gate.filter((c) => c.allowed)).toHaveLength(enforcing.length);
      expect(refused.slice(breakGlass.refusedFrom).map((e) => e.message)).toEqual([]);

      // The job's own run (N-7 created extra graft/policy runs with no external id on this head).
      const runOf = (head: string) =>
        api.state.checkRuns
          .filter((c) => c.name === "graft/policy" && c.head_sha === head && c.external_id !== "")
          .at(-1);
      expect(runOf(breakGlass.labelledHead)).toMatchObject({ conclusion: "success" });
      expect(runOf(breakGlass.labelledHead)?.output.title).toBe("Bypassed by break-glass (maya)");
      const next = runOf(breakGlass.nextHead);
      expect(next?.status).toBe("completed");
      expect(next?.conclusion).not.toBe("success");
      const latest = await t.db
        .selectFrom("policy_verdicts")
        .selectAll()
        .where("head_sha", "=", breakGlass.nextHead)
        .orderBy("facts_read_at", "desc")
        .executeTakeFirstOrThrow();
      expect(latest.enforced_reason).not.toBe("break_glass");
      expect(latest.check_conclusion).toBe(next?.conclusion);

      const rows = await scenarioAudit();
      expect(rows.map((r) => [r.kind, r.reason, r.actor_login, r.policy_mode])).toEqual([
        ["applied", null, "maya", "enforce"],
        ["ignored", "role_too_low", "tom", "enforce"],
      ]);
    });
  }
});
