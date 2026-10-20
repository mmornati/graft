/**
 * The neutral regression suite (Phase 1 step 1, T10).
 *
 * Every Phase 1 step adds its feature to this suite in report mode. A failure here means Graft
 * would change outcomes for a team that has not opted in.
 *
 * It drives every Phase 0 flow through the real server, queue and worker against the in-memory
 * GitHub, once with default modes and once with every mode at its maximum, and asserts that the
 * writes to GitHub are exactly the Phase 0 set and that every check is `neutral`.
 */
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import { classifyWrite, type MutationRefusedError } from "../../src/github/mutation-guard.js";
import { buildServer } from "../../src/http/server.js";
import { modesApplyJob, mutationGate } from "../../src/modules/modes/index.js";
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
} from "../helpers/github-builders.js";
import { loadIntentScenario, scenarioLlm } from "../helpers/intent-scenario.js";
import { B1, B2, EXAMPLE_POLICY, putContent } from "../helpers/policy-scenario.js";
import { sleep } from "../helpers/wait.js";

const FULL_NAME = `${OWNER}/${REPO}`;
const REPORT_LINE = "Graft mode: report. This check never blocks a merge.";
const ENFORCE_LINE =
  "Graft mode: enforce. Enforcement is not active in this version; this check never blocks a merge.";
const HEAD_2 = fakeSha(0xbeef);

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
    },
  },
];

describe.each(PROFILES)("neutral regression suite, $name modes", (profile) => {
  let t: TestApp;
  let api: FakeGitHubApi;
  let server: Awaited<ReturnType<typeof buildServer>>;
  const refused: MutationRefusedError[] = [];
  // The policy check's mode line before the mode changes, after the first and after the second.
  const lines = { before: "", first: "", second: "" };
  const writesAround = { before: 0, afterFirst: 0 };
  // default: enforce, then back to report. max: it starts at enforce, so report (a rollback) first.
  const FIRST = profile.name === "max" ? "report" : "enforce";
  const SECOND = profile.name === "max" ? "enforce" : "report";

  const config = () => testConfig({ GRAFT_MODE_CEILING: profile.ceiling });
  const policyRun = () =>
    api.state.checkRuns.filter((c) => c.name === "graft/policy" && c.head_sha === HEAD_2).at(0);
  const writes = () => api.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD");

  /** No unfinished job for four polls in a row. A failed or retrying job fails the test. */
  async function drain(): Promise<void> {
    let quiet = 0;
    const deadline = Date.now() + 40_000;
    while (quiet < 4) {
      if (Date.now() > deadline) throw new Error("the queue did not drain");
      const res = await sql<{ n: string }>`
        select count(*)::text as n from pgboss.job where state in ('created', 'retry', 'active')`.execute(
        t.db,
      );
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

  beforeAll(async () => {
    t = await createTestApp({
      supervise: true,
      llm: scenarioLlm(),
      config: { GRAFT_MODE_CEILING: profile.ceiling },
    });
    await truncateAll(t.db);
    clearPolicyCache();
    api = createFakeGitHubApi();
    t.deps.github = fakeGitHubFactory(api, mutationGate(t.db, config()), (e) => refused.push(e));
    api.state.installationPermissions = profile.permissions;
    server = await buildServer(t.deps);
    await startWorker(t.deps.queue, t.deps.registry, jobContext(t), {
      concurrency: 4,
      pollingIntervalSeconds: 0.5,
    });

    // The world: PR 2 by an agent, a base branch with a policy.
    loadIntentScenario(api);
    api.state.branches.set("main", B1);
    putContent(api, B1, EXAMPLE_POLICY);
    api.state.commits.set(PR_NUMBER, [
      makeCommit(
        HEAD_SHA,
        commitMessage("Fix the retry loop", undefined, [
          ["Graft-Agent", "claude-code"],
          ["Graft-Model", "claude-sonnet-5-5"],
        ]),
      ),
    ]);

    // installation created
    await post("installation.created", "n-inst");
    if (profile.name === "max") {
      // Every mode at its maximum, on every repository.
      await t.db
        .updateTable("repositories")
        .set({ policy_mode: "enforce", guard_mode: "enforce", mcp_write: "on" })
        .execute();
    }
    // PR opened (agent trailers), intent card, policy
    await post("pull_request.opened", "n-open");
    // review approved
    api.state.reviews.set(PR_NUMBER, [makeReview({ id: 11 })]);
    await post("pull_request_review.submitted", "n-review");
    // label added
    const pull = api.state.pulls.get(PR_NUMBER);
    if (!pull) throw new Error("no pull");
    pull.labels = [{ name: "needs-review" }];
    pull.updated_at = "2026-10-14T11:10:00Z";
    await post("pull_request.labeled", "n-label", (p) => {
      p.label = { name: "needs-review" };
    });
    // push to the PR
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
    putContent(api, B2, `${EXAMPLE_POLICY}\n# tightened\n`);
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
  }, 180_000);

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

  it(`N-2 [${profile.name}] every Graft check run created or updated has conclusion neutral`, () => {
    const checkWrites = api.requests.filter(
      (r) => r.method !== "GET" && /\/check-runs(\/\d+)?$/.test(r.path),
    );
    expect(checkWrites.length).toBeGreaterThan(3);
    for (const r of checkWrites) {
      // A write without a conclusion leaves the stored one alone; one with it says neutral.
      if (r.body && "conclusion" in r.body) expect(r.body.conclusion).toBe("neutral");
    }
    const names = new Set(api.state.checkRuns.map((c) => c.name));
    expect([...names].sort()).toEqual(["graft/intent", "graft/policy", "graft/provenance"]);
    for (const run of api.state.checkRuns) {
      if (run.status === "completed")
        expect(run.conclusion, `${run.name} ${run.id}`).toBe("neutral");
    }
    expect(api.state.checkRuns.filter((c) => c.name === "graft/policy").length).toBeGreaterThan(0);
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
      .orderBy("created_at")
      .execute();
    expect(history.map((h) => [h.key, h.to_value, h.applied_at !== null])).toEqual([
      ["policy_mode", FIRST, true],
      ["policy_mode", SECOND, true],
    ]);
    // The conclusion is the literal neutral after every republication.
    expect(policyRun()?.conclusion).toBe("neutral");
  });

  it(`N-5 [${profile.name}] a Phase 1 write is refused by mode or by the missing feature, and the gate is read at request time`, async () => {
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
});
