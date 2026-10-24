/**
 * Phase 1 step 7 (D2, H1): every process computes with the lower of its own GRAFT_MODE_CEILING and
 * the value the last worker start stored (I-CEIL-1 to I-CEIL-3).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import type { GitHubClientFactory } from "../../src/github/client-factory.js";
import { MutationRefusedError } from "../../src/github/mutation-guard.js";
import { type AppServer, buildServer } from "../../src/http/server.js";
import { getEffectiveModes, mutationGate } from "../../src/modules/modes/index.js";
import { evaluatePolicyJobRun } from "../../src/modules/policy/job.js";
import { clearPolicyCache } from "../../src/policy/load.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { HEAD_SHA, INSTALLATION_ID, OWNER, REPO, REPO_ID } from "../helpers/github-builders.js";
import { call, createTestToken, type McpClientHandle, mcpClient } from "../helpers/mcp-client.js";
import { EVAL_DATA, loadPolicyScenario } from "../helpers/policy-scenario.js";
import { seedWorld } from "../helpers/seed.js";

const PERMISSIONS = {
  metadata: "read",
  contents: "write",
  issues: "read",
  pull_requests: "write",
  checks: "write",
};
const ENFORCE = { GRAFT_MODE_CEILING: "enforce" };

let t: TestApp;
let api: FakeGitHubApi;
const servers: AppServer[] = [];
const clients: McpClientHandle[] = [];
const refused: MutationRefusedError[] = [];

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  clearPolicyCache();
  api = createFakeGitHubApi();
  refused.length = 0;
  await seedWorld(t.db);
  await t.db
    .updateTable("installations")
    .set({ permissions: JSON.stringify(PERMISSIONS), permissions_read_at: FIXED_NOW })
    .execute();
  await t.db
    .updateTable("repositories")
    .set({ policy_mode: "enforce", guard_mode: "enforce", mcp_write: "on" })
    .where("id", "=", REPO_ID)
    .execute();
  loadPolicyScenario(api);
  api.state.branches.set("feat/ceil", HEAD_SHA);
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const s of servers.splice(0)) await s.close();
});

const storeCeiling = (value: string) =>
  t.db
    .insertInto("service_state")
    .values({ key: "mode_ceiling", value, updated_at: FIXED_NOW })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
    .execute();

function factoryFor(cfg: Record<string, string>): GitHubClientFactory {
  return fakeGitHubFactory(api, mutationGate(t.db, testConfig(cfg)), (e) => refused.push(e));
}

const evaluate = (cfg: Record<string, string>) =>
  evaluatePolicyJobRun(EVAL_DATA, {
    ...jobContext(t),
    config: testConfig(cfg),
    github: factoryFor(cfg),
  });

const policyCheck = () => api.state.checkRuns.filter((c) => c.name === "graft/policy").at(-1);

async function openChange(cfg: Record<string, string>): Promise<Record<string, unknown>> {
  const config = testConfig(cfg);
  const server = await buildServer({ ...t.deps, config, github: factoryFor(cfg) });
  servers.push(server);
  await server.listen({ port: 0, host: "127.0.0.1" });
  const { port } = server.server.address() as { port: number };
  const { token } = await createTestToken(t.db, { repositoryId: REPO_ID });
  const c = await mcpClient(new URL(`http://127.0.0.1:${port}/mcp`), token);
  clients.push(c);
  return (
    await call(c, "open_change", { repository: `${OWNER}/${REPO}`, head: "feat/ceil", title: "t" })
  ).out;
}

describe("the ceiling after a rolling restart (Phase 1 step 7, D2)", () => {
  it("I-CEIL-1 rolling restart, lowered: stored report and a process enforce → neutral check, a policy write refused mode_report, open_change mcp_write_off ceiling", async () => {
    await storeCeiling("report");
    const modes = await getEffectiveModes(t.db, REPO_ID, testConfig(ENFORCE));
    expect(modes.ceiling).toBe("report");
    expect(modes.policy).toMatchObject({ effective: "report", reason: "ceiling" });

    expect(await evaluate(ENFORCE)).toBe("published");
    expect(policyCheck()).toMatchObject({ status: "completed", conclusion: "neutral" });
    const verdict = await t.db.selectFrom("policy_verdicts").selectAll().executeTakeFirstOrThrow();
    expect(verdict.policy_mode).toBe("report");

    // A direct non-neutral write through a policy client is refused by the gate.
    const policy = await factoryFor(ENFORCE).forInstallation(INSTALLATION_ID, {
      feature: "policy",
    });
    const before = api.requests.length;
    const err = await policy.rest.checks
      .create({
        owner: OWNER,
        repo: REPO,
        name: "graft/policy",
        head_sha: HEAD_SHA,
        status: "completed",
        conclusion: "failure",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MutationRefusedError);
    expect((err as MutationRefusedError).refusal).toBe("mode_report");
    expect(api.requests.slice(before).filter((r) => r.method !== "GET")).toEqual([]);

    expect(await openChange(ENFORCE)).toEqual({ error: "mcp_write_off", detail: "ceiling" });
    expect(await t.db.selectFrom("mcp_changes").selectAll().execute()).toEqual([]);
  });

  it("I-CEIL-2 no service_state row and a process enforce → enforce (the first start)", async () => {
    const modes = await getEffectiveModes(t.db, REPO_ID, testConfig(ENFORCE));
    expect(modes.ceiling).toBe("enforce");
    expect(modes.policy).toMatchObject({ effective: "enforce", reason: "repository" });
    expect(modes.guard.effective).toBe("enforce");
    expect(modes.mcpWrite.effective).toBe("on");
    expect(await evaluate(ENFORCE)).toBe("published");
    const verdict = await t.db.selectFrom("policy_verdicts").selectAll().executeTakeFirstOrThrow();
    expect(verdict.policy_mode).toBe("enforce");
    expect(policyCheck()?.conclusion).not.toBe("neutral");
  });

  it("I-CEIL-3 raise: stored enforce, process report → report; mode show reports the worker's enforce and the shell warning", async () => {
    await storeCeiling("enforce");
    const modes = await getEffectiveModes(t.db, REPO_ID, testConfig({}));
    expect(modes.ceiling).toBe("report");
    expect(modes.policy).toMatchObject({ effective: "report", reason: "ceiling" });
    expect(await evaluate({})).toBe("published");
    expect(policyCheck()).toMatchObject({ status: "completed", conclusion: "neutral" });
    const gate = mutationGate(t.db, testConfig({}));
    expect(
      await gate({ installationId: INSTALLATION_ID, owner: OWNER, repo: REPO, feature: "guard" }),
    ).toEqual({ allowed: false, reason: "mode_report" });

    const deps: OpsDeps = {
      loadConfig: () => testConfig({ GRAFT_MODE_CEILING: "report" }),
      openDb: () => testDb(),
      github: () => fakeGitHubFactory(api),
      now: () => FIXED_NOW,
      sleep: async () => {},
    };
    let out = "";
    const code = await opsMain(
      ["mode", "show", "--repo", `${OWNER}/${REPO}`],
      { out: (s) => (out += s), err: () => undefined },
      deps,
    );
    expect(code).toBe(0);
    expect(out).toContain(
      "warning: this shell's GRAFT_MODE_CEILING is report; the worker runs with enforce",
    );
    expect(out).toContain("ceiling    enforce  (worker: enforce");
  });
});
