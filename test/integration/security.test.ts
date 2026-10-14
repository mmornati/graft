import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/logger.js";
import type { GitHubClientFactory } from "../../src/github/client-factory.js";
import { buildServer } from "../../src/http/server.js";
import { forbiddenLlm } from "../../src/llm/fake.js";
import type { LlmClient } from "../../src/llm/types.js";
import { startWorker } from "../../src/queue/worker.js";
import {
  createTestApp,
  fakeGitHubFactory,
  jobContext,
  postRaw,
  type TestApp,
} from "../helpers/app.js";
import { countJobs, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture, setPath } from "../helpers/fixtures.js";
import {
  commitMessage,
  fakeSha,
  makeCommit,
  makePull,
  PR_NUMBER,
} from "../helpers/github-builders.js";
import { loadIntentScenario, scenarioLlm, writerReply } from "../helpers/intent-scenario.js";
import { seedWorld } from "../helpers/seed.js";
import { waitFor } from "../helpers/wait.js";

let t: TestApp;
let server: Awaited<ReturnType<typeof buildServer>>;
let api: FakeGitHubApi;
let logged = "";
// The model is per test, reached through this proxy because the worker captured its context.
let model: LlmClient = forbiddenLlm();
const llm: LlmClient = { complete: (r) => model.complete(r) };
// The worker captured its context at start, so the per-test fake is reached through this proxy.
let factory: GitHubClientFactory;
const github: GitHubClientFactory = {
  forInstallation: (id) => factory.forInstallation(id),
  asApp: () => factory.asApp(),
};

beforeAll(async () => {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logged += String(chunk);
      cb();
    },
  });
  t = await createTestApp({
    supervise: true,
    github,
    llm,
    log: createLogger({ logLevel: "info" }, stream),
  });
  server = await buildServer(t.deps);
  await startWorker(t.deps.queue, t.deps.registry, jobContext(t), { concurrency: 2 });
});
afterAll(async () => {
  await server.close();
  await t.close();
});
beforeEach(async () => {
  logged = "";
  model = forbiddenLlm();
  await truncateAll(t.db);
  await seedWorld(t.db);
  api = createFakeGitHubApi();
  factory = fakeGitHubFactory(api);
});

const dispatchDone = async (n: number) =>
  (
    await sql<{ n: string }>`
      select count(*)::text n from pgboss.job where name = 'github.webhook' and state = 'completed'`.execute(
      t.db,
    )
  ).rows[0]?.n === String(n);

const body = (fixture: string, edit?: (p: Record<string, unknown>) => void) => {
  const p = structuredClone(loadFixture(fixture).payload);
  edit?.(p);
  return JSON.stringify(p);
};

describe("webhook replay and relabel hardening", () => {
  it("I-SEC-1 the same signed body under two delivery IDs: two delivery rows, one refresh job", async () => {
    const raw = body("pull_request.synchronize");
    expect((await postRaw(server, "pull_request", raw, "sec-1a")).statusCode).toBe(202);
    expect((await postRaw(server, "pull_request", raw, "sec-1b")).statusCode).toBe(202);
    expect(await t.db.selectFrom("webhook_deliveries").selectAll().execute()).toHaveLength(2);
    await waitFor(() => dispatchDone(2));
    expect(await countJobs(t.db, "provenance.refresh")).toBe(1);
  });

  it("I-SEC-2 a stale payload (head A) while GitHub says head B: only B is computed and published", async () => {
    const headA = (
      loadFixture("pull_request.synchronize").payload.pull_request as { head: { sha: string } }
    ).head.sha;
    const headB = fakeSha(0xb);
    api.state.pulls.set(PR_NUMBER, makePull({ head: { sha: headB }, commits: 1 }));
    api.state.commits.set(PR_NUMBER, [
      makeCommit(headB, commitMessage("B", undefined, [["Graft-Agent", "agent-b"]])),
    ]);
    const res = await postRaw(server, "pull_request", body("pull_request.synchronize"), "sec-2");
    expect(res.statusCode).toBe(202);

    const cp = await waitFor(async () => {
      const rows = await t.db.selectFrom("change_provenance").selectAll().execute();
      return rows[0];
    });
    expect(cp.head_sha).toBe(headB);
    const change = await t.db.selectFrom("changes").selectAll().executeTakeFirstOrThrow();
    expect(change.head_sha).toBe(headB);
    expect(JSON.stringify(api.requests)).not.toContain(headA);
    expect(JSON.stringify(api.state)).not.toContain(headA);
    expect(JSON.stringify(cp)).not.toContain(headA);
  });

  it("I-SEC-3 an installation body sent with x-github-event: pull_request writes and enqueues nothing", async () => {
    // As-is: the action 'created' is not one provenance handles, so the receiver ignores it.
    const asIs = await postRaw(server, "pull_request", body("installation.created"), "sec-3a");
    expect(asIs.statusCode).toBe(202);
    expect(asIs.json()).toEqual({ status: "ignored" });

    // With an action the receiver does route (it cannot tell the body is wrong), the handler's shape check rejects it.
    const routed = body("installation.created", (p) => setPath(p, "action", "opened"));
    const res = await postRaw(server, "pull_request", routed, "sec-3b");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "enqueued" });
    await waitFor(() => dispatchDone(1));
    expect(await countJobs(t.db, "provenance.refresh")).toBe(0);
    expect(await t.db.selectFrom("changes").selectAll().execute()).toEqual([]);
    expect(logged).toContain("payload_shape_mismatch");
    expect(api.requests).toHaveLength(0);
  });

  it("I-SEC-4 a pull_request body sent as installation_repositories writes no installation or repository rows", async () => {
    await truncateAll(t.db); // no seeded world: any write would show
    const res = await postRaw(
      server,
      "installation_repositories",
      body("pull_request.opened"),
      "sec-4",
    );
    expect(res.statusCode).toBe(202);
    await waitFor(() => dispatchDone(1));
    expect(await t.db.selectFrom("installations").selectAll().execute()).toEqual([]);
    expect(await t.db.selectFrom("repositories").selectAll().execute()).toEqual([]);
    expect(logged).toContain("payload_shape_mismatch");
  });
});

describe("intent handlers", () => {
  it("I-SEC-5 intent handlers only validate and enqueue; an installation body as check_run creates no intent job", async () => {
    const src = readFileSync(
      new URL("../../src/modules/intent/handlers.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(
      /insertInto|updateTable|deleteFrom|\.rest\.|forInstallation|asApp|octokit/i,
    );

    // As-is the action 'created' is not one any check_run handler routes; with a routed action
    // the receiver cannot tell the body is wrong, and the handlers' shape checks reject it.
    expect(
      (await postRaw(server, "check_run", body("installation.created"), "sec-5a")).statusCode,
    ).toBe(202);
    for (const [i, action] of ["rerequested", "requested_action"].entries()) {
      const routed = body("installation.created", (p) => setPath(p, "action", action));
      expect((await postRaw(server, "check_run", routed, `sec-5b${i}`)).statusCode).toBe(202);
    }
    await waitFor(() => dispatchDone(2));
    expect(await countJobs(t.db, "intent.generate")).toBe(0);
    expect(await countJobs(t.db, "intent.feedback.record")).toBe(0);
    expect(api.requests).toHaveLength(0);
    expect(logged).toContain("payload_shape_mismatch");
  });
});

describe("end to end", () => {
  it("I-E2E-2 server + worker + fake GitHub: a signed pull_request.opened with trailers publishes within 10 s", async () => {
    const trailers = commitMessage("Add feature", undefined, [
      ["Graft-Agent", "claude-code"],
      ["Graft-Model", "claude-sonnet-5-5"],
    ]);
    const prBody = `Adds a feature.\n\n${trailers.split("\n\n")[1]}`;
    api.state.pulls.set(PR_NUMBER, makePull({ body: prBody, commits: 1 }));
    api.state.commits.set(PR_NUMBER, [makeCommit(makePull().head.sha, trailers)]);

    // Body rewritten to carry the trailers, then re-signed by postRaw.
    const raw = body("pull_request.opened", (p) => {
      (p.pull_request as Record<string, unknown>).body = prBody;
    });
    const res = await postRaw(server, "pull_request", raw, "e2e-2");
    expect(res.statusCode).toBe(202);

    const cp = await waitFor(
      async () => (await t.db.selectFrom("change_provenance").selectAll().execute())[0],
    );
    expect(cp).toMatchObject({
      author_kind: "agent",
      agent: "claude-code",
      model: "claude-sonnet-5-5",
    });
    expect(api.find("POST", /\/issues\/2\/comments$/)).toHaveLength(1);
    expect(api.find("POST", /\/check-runs$/)).toHaveLength(1);
  });

  it("I-E2E-3 server + worker + fake model + fake GitHub: a signed pull_request.opened publishes the intent card and provenance within 15 s", async () => {
    loadIntentScenario(api);
    api.state.commits.set(PR_NUMBER, [makeCommit(makePull().head.sha, commitMessage("Fix"))]);
    model = scenarioLlm();
    const raw = body("pull_request.opened", (p) => {
      const pr = p.pull_request as Record<string, unknown>;
      pr.title = "Fix the retry loop";
      pr.body = "Fixes #42\n\nRetries failed webhook deliveries.";
    });
    const res = await postRaw(server, "pull_request", raw, "e2e-3");
    expect(res.statusCode).toBe(202);

    await waitFor(async () => {
      const text = api.state.comments[0]?.body ?? "";
      // The check runs come after the comment in each publish.
      return (
        text.includes("### Intent") &&
        text.includes("### Provenance") &&
        api.state.checkRuns.some((r) => r.name === "graft/intent") &&
        api.state.checkRuns.some((r) => r.name === "graft/provenance")
      );
    }, 15_000);
    expect(api.state.comments).toHaveLength(1);
    expect(api.state.checkRuns.filter((r) => r.name === "graft/intent")).toHaveLength(1);
    expect(api.state.checkRuns.filter((r) => r.name === "graft/provenance")).toHaveLength(1);
  });

  it("I-E2E-4 a GitHub failure while publishing leaves no rendered-card text in the logs or in pgboss.job.output", async () => {
    const SENTINEL = "RenderedCardSentinelQ7Z";
    loadIntentScenario(api);
    api.state.commits.set(PR_NUMBER, [makeCommit(makePull().head.sha, commitMessage("Fix"))]);
    model = scenarioLlm({ writer: writerReply({ goal: `Goal ${SENTINEL} for the card.` }) });
    // Both publishers fail once on the check-run POST; the response body carries the sentinel too.
    for (let i = 0; i < 2; i++) {
      api.failNext("POST", /\/check-runs$/, 500, {}, { message: "boom", extra: SENTINEL });
    }
    const raw = body("pull_request.opened", (p) => {
      const pr = p.pull_request as Record<string, unknown>;
      pr.title = "Fix the retry loop";
      pr.body = "Fixes #42\n\nRetries failed webhook deliveries.";
    });
    expect((await postRaw(server, "pull_request", raw, "e2e-4")).statusCode).toBe(202);

    const failed = await waitFor(async () => {
      const r = await sql<{ output: unknown }>`
        select output from pgboss.job where name = 'intent.generate' and output is not null`.execute(
        t.db,
      );
      return r.rows[0];
    }, 15_000);
    // The model ran and the card text was sent in the request that failed.
    expect(api.find("POST", /\/check-runs$/).length).toBeGreaterThan(0);
    expect(JSON.stringify(api.requests)).toContain(SENTINEL);
    const outputs = await sql<{ output: unknown }>`select output from pgboss.job`.execute(t.db);
    expect(JSON.stringify(outputs.rows)).not.toContain(SENTINEL);
    expect(JSON.stringify(failed.output)).toContain("500");
    expect(logged).toContain("job failed");
    expect(logged).not.toContain(SENTINEL);
  });
});
