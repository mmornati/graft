import { Writable } from "node:stream";
import { inspect } from "node:util";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/logger.js";
import { parseManagedComment } from "../../src/github/managed-comment.js";
import { forbiddenLlm } from "../../src/llm/fake.js";
import type { LlmClient } from "../../src/llm/types.js";
import { upsertChangeFromPull } from "../../src/modules/changes/index.js";
import {
  defaultGenerateOptions,
  prepareCardInputs,
  unavailableResult,
} from "../../src/modules/intent/generate.js";
import {
  generateKey,
  rerequestIntent,
  rerunKey,
  scheduleIntent,
} from "../../src/modules/intent/handlers.js";
import { cardInputsSchema } from "../../src/modules/intent/inputs.js";
import {
  type GenerateData,
  generateIntent,
  intentGenerateJob,
} from "../../src/modules/intent/job.js";
import { PROMPT_VERSION } from "../../src/modules/intent/prompts.js";
import {
  INTENT_CHECK_ACTIONS,
  renderIntentCheckOutput,
  renderIntentSection,
} from "../../src/modules/intent/render.js";
import {
  findCard,
  publishedCards,
  rowToView,
  saveCard,
  tokensUsedToday,
} from "../../src/modules/intent/store.js";
import { provenanceRefreshJob } from "../../src/modules/provenance/job.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import { singletonJobId } from "../../src/queue/queue.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { countJobs, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture, setPath } from "../helpers/fixtures.js";
import {
  commitMessage,
  fakeSha,
  HEAD_SHA,
  INSTALLATION_ID,
  makeCommit,
  makePull,
  OWNER,
  PR_NUMBER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";
import { file, inputs } from "../helpers/intent-inputs.js";
import {
  CANARY,
  GENERATE_DATA,
  loadIntentScenario,
  scenarioLlm,
  writerReply,
} from "../helpers/intent-scenario.js";
import { seedWorld } from "../helpers/seed.js";

let t: TestApp;
let api: FakeGitHubApi;
let current: LlmClient & { calls: unknown[] };
let logged = "";
const llm: LlmClient = { complete: (r) => current.complete(r) };

beforeAll(async () => {
  const stream = new Writable({
    write(chunk, _e, cb) {
      logged += String(chunk);
      cb();
    },
  });
  t = await createTestApp({ log: createLogger({ logLevel: "info" }, stream), llm });
});
afterAll(() => t.close());
beforeEach(async () => {
  logged = "";
  await truncateAll(t.db);
  await seedWorld(t.db);
  api = createFakeGitHubApi();
  t.deps.github = fakeGitHubFactory(api);
  current = scenarioLlm();
  loadIntentScenario(api);
  api.state.commits.set(PR_NUMBER, [makeCommit(HEAD_SHA, commitMessage("Fix"))]);
});

const runJob = (over: Partial<GenerateData> = {}) =>
  generateIntent({ ...GENERATE_DATA, ...over }, jobContext(t));
const repoWrites = () =>
  api.requests.filter((r) => r.method !== "GET" && !r.path.includes("access_tokens"));
const writes = (re: RegExp) => api.requests.filter((r) => r.method !== "GET" && re.test(r.path));
const cards = () => t.db.selectFrom("intent_cards").selectAll().orderBy("created_at").execute();
const change = () => t.db.selectFrom("changes").selectAll().executeTakeFirstOrThrow();
const intentJobs = () =>
  sql<{ id: string; data: GenerateData; start_after: Date; now: Date }>`
    select id, data, start_after, now() as now from pgboss.job where name = 'intent.generate' order by created_on`.execute(
    t.db,
  );
const moveHead = (sha: string, updatedAt: string) =>
  api.state.pulls.set(
    PR_NUMBER,
    makePull({
      head: { sha },
      updated_at: updatedAt,
      title: "Fix the retry loop",
      body: "Fixes #42\n\nRetries failed webhook deliveries.",
      changed_files: 3,
      additions: 9,
      deletions: 4,
    }),
  );

describe("intent webhook handlers", () => {
  const event = (
    fixture: string,
    deliveryId: string,
    edit?: (p: Record<string, unknown>) => void,
  ) => {
    const p = structuredClone(loadFixture(fixture).payload) as Record<string, unknown>;
    edit?.(p);
    return { name: fixture.split(".")[0], deliveryId, id: deliveryId, payload: p } as never;
  };
  const schedule = (e: never) => scheduleIntent.handle(e, jobContext(t));
  const rerequest = (e: never, offsetMs = 0) =>
    rerequestIntent.handle(e, {
      ...jobContext(t),
      clock: { now: () => new Date(FIXED_NOW.getTime() + offsetMs) },
    });

  it("I-INT-1 pull_request.opened enqueues one intent.generate job with the D8 key and writes nothing", async () => {
    await schedule(event("pull_request.opened", "h-1"));
    const jobs = await intentJobs();
    expect(jobs.rows).toHaveLength(1);
    const pr = loadFixture("pull_request.opened").payload.pull_request as {
      head: { sha: string };
      base: { ref: string };
      title: string;
      body: string;
      updated_at: string;
    };
    const key = generateKey({
      repositoryId: REPO_ID,
      prNumber: 2,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      title: pr.title,
      body: pr.body,
      updatedAt: pr.updated_at,
      action: "opened",
    });
    expect(key).toMatch(
      /^intent:2000001:2:[0-9a-f]{40}:master:[0-9a-f]{16}:2019-05-15T15:20:33Z:opened$/,
    );
    expect(jobs.rows[0]?.id).toBe(singletonJobId("intent.generate", key));
    expect(jobs.rows[0]?.data).toEqual({
      installationId: INSTALLATION_ID,
      repositoryId: REPO_ID,
      owner: OWNER,
      repo: REPO,
      prNumber: 2,
      headSha: pr.head.sha,
      trigger: "opened",
      attempt: 0,
      deliveryId: "h-1",
    });
    for (const table of ["changes", "intent_cards", "intent_feedback", "tasks"] as const) {
      expect(await t.db.selectFrom(table).selectAll().execute(), table).toEqual([]);
    }
    expect(api.requests).toHaveLength(0);
  });

  it("I-INT-2 replays collapse; a real edit, or a new updated_at, is a new job", async () => {
    await schedule(event("pull_request.opened", "h-1"));
    await schedule(event("pull_request.opened", "h-2")); // replay under a new delivery id
    expect(await countJobs(t.db, "intent.generate")).toBe(1);
    const edited = (id: string, body: string, updatedAt?: string) =>
      event("pull_request.edited", id, (p) => {
        setPath(p, "pull_request.body", body);
        if (updatedAt) setPath(p, "pull_request.updated_at", updatedAt);
      });
    await schedule(edited("h-3", "New description"));
    expect(await countJobs(t.db, "intent.generate")).toBe(2);
    await schedule(edited("h-4", "New description")); // replay
    expect(await countJobs(t.db, "intent.generate")).toBe(2);
    await schedule(edited("h-5", "New description", "2030-01-01T00:00:00Z")); // same body, new time
    expect(await countJobs(t.db, "intent.generate")).toBe(3);
    // a title-only edit changes the key too
    await schedule(
      event("pull_request.edited", "h-6", (p) => {
        setPath(p, "pull_request.title", "A new title");
        setPath(p, "pull_request.body", "New description");
      }),
    );
    expect(await countJobs(t.db, "intent.generate")).toBe(4);
  });

  it("I-INT-3 check_run.rerequested: one re-run per PR per minute; other checks and apps ignored", async () => {
    const intentRun = (id: string, edit?: (p: Record<string, unknown>) => void) =>
      event("check_run.rerequested", id, (p) => {
        setPath(p, "check_run.name", "graft/intent");
        edit?.(p);
      });
    const minute = Math.floor(FIXED_NOW.getTime() / 60_000);
    await rerequest(intentRun("r-1"));
    const jobs = await intentJobs();
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.id).toBe(
      singletonJobId("intent.generate", rerunKey(REPO_ID, 2, FIXED_NOW.getTime())),
    );
    expect(rerunKey(REPO_ID, 2, FIXED_NOW.getTime())).toBe(`intent-rerun:${REPO_ID}:2:${minute}`);
    expect(jobs.rows[0]?.data).toMatchObject({ trigger: "rerequested", attempt: 0, prNumber: 2 });

    await rerequest(intentRun("r-2"));
    expect(await countJobs(t.db, "intent.generate")).toBe(1);
    await rerequest(intentRun("r-3"), 60_000);
    expect(await countJobs(t.db, "intent.generate")).toBe(2);

    await rerequest(event("check_run.rerequested", "r-4")); // graft/provenance
    await rerequest(
      intentRun("r-5", (p) => setPath(p, "check_run.app.id", 999)),
      120_000,
    );
    expect(await countJobs(t.db, "intent.generate")).toBe(2);
  });
});

describe("intent.generate job", () => {
  it("I-INT-4 end to end: card row, one comment with both sections, one check run", async () => {
    expect(await runJob()).toBe("published");
    await provenanceRefreshJob.handle(
      {
        installationId: INSTALLATION_ID,
        repositoryId: REPO_ID,
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha: HEAD_SHA,
        trigger: "opened",
        deliveryId: "d-prov",
      },
      jobContext(t),
    );

    const [card] = await cards();
    expect(card).toMatchObject({
      head_sha: HEAD_SHA,
      prompt_version: PROMPT_VERSION,
      status: "ok",
      failure_reason: null,
      goal: "Retry failed webhook deliveries up to 5 times with exponential backoff.",
      risk_class: "sensitive",
      risk_floor: "sensitive",
      model_risk_class: "logic",
      first_pass_risk_class: null,
      verifier_risk_class: "trivial",
      risk_raised_by: [],
      verifier_status: "agree",
      verifier_failure: null,
      instructions_in_data: false,
      writer_model: "claude-sonnet-5-5",
      first_pass_model: null,
      verifier_model: "claude-sonnet-5-5",
      llm_calls: 2,
      input_tokens: 2000,
      output_tokens: 200,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      files_total: 3,
      files_listed: 3,
      files_full: 3,
      files_partial: 0,
      files_omitted: 0,
      lines_added: 9,
      lines_deleted: 4,
      inputs_truncated: false,
      linked_issue_number: 42,
    });
    expect(card?.floor_reasons).toEqual([
      { rule: "dependency_manifest", floor: "sensitive", paths: ["package.json"], count: 1 },
    ]);
    expect(card?.behavior_changes).toHaveLength(2);
    expect(card?.out_of_scope_edits).toEqual([
      { path: "README.md", reason: "Rewords the installation section." },
    ]);
    expect(card?.verifier_claims).toHaveLength(4);
    expect(api.find("GET", /\/issues\/42$/)).toHaveLength(1);
    expect(api.find("GET", /\/pulls\/2\/files$/)).toHaveLength(1);
    expect(current.calls).toHaveLength(2);

    // One comment holding both sections, in the managed order.
    expect(api.state.comments).toHaveLength(1);
    const body = api.state.comments[0]?.body ?? "";
    expect(body.indexOf("### Intent")).toBeGreaterThan(0);
    expect(body.indexOf("### Intent")).toBeLessThan(body.indexOf("### Provenance"));
    const view = rowToView(card as never);
    const section = renderIntentSection(view, { retryScheduled: false });
    const sections = parseManagedComment(body);
    expect(sections?.get("intent")).toBe(section);
    expect(sections?.get("provenance")).toContain("### Provenance");

    // Each module's write keeps the other's section byte for byte.
    const before = new Map(sections);
    await runJob({ trigger: "edited" });
    expect(parseManagedComment(api.state.comments[0]?.body ?? "")).toEqual(before);

    // One check run with the card id as external_id and the buttons.
    const intentRuns = api.state.checkRuns.filter((r) => r.name === "graft/intent");
    expect(intentRuns).toHaveLength(1);
    expect(api.state.checkRuns.filter((r) => r.name === "graft/provenance")).toHaveLength(1);
    const post = writes(/check-runs$/).find((r) => r.body?.name === "graft/intent");
    expect(post?.method).toBe("POST");
    expect(post?.body).toMatchObject({
      name: "graft/intent",
      head_sha: HEAD_SHA,
      status: "completed",
      conclusion: "neutral",
      external_id: card?.id,
      actions: INTENT_CHECK_ACTIONS,
      output: renderIntentCheckOutput(view, { retryScheduled: false }),
    });
    const postedOutput = post?.body?.output as { summary: string };
    expect(postedOutput.summary).toBe(section);
    expect(card?.published_at).not.toBeNull();
    expect(card?.comment_id).toBe(api.state.comments[0]?.id);
    expect(card?.check_run_id).toBe(intentRuns[0]?.id);
    expect((await change()).graft_comment_id).toBe(api.state.comments[0]?.id);
  });

  it("I-INT-5 no diff, prompt, PR text or issue text is persisted or logged", async () => {
    await runJob();
    // Job data carries IDs only: enqueue through the real queue and look at pgboss.job.
    await t.deps.queue.send(intentGenerateJob, { ...GENERATE_DATA, deliveryId: "d-queued" });
    // The model did see the canary, so the check below is meaningful.
    expect(JSON.stringify(current.calls)).toContain(CANARY);
    expect(JSON.stringify(current.calls)).toContain("Retries failed webhook deliveries");

    const tables = await sql<{ table_schema: string; table_name: string }>`
      select table_schema, table_name from information_schema.tables
      where table_schema in ('public', 'pgboss') and table_type = 'BASE TABLE'`.execute(t.db);
    expect(tables.rows.length).toBeGreaterThan(10);
    for (const { table_schema, table_name } of tables.rows) {
      const res = await sql<{
        j: string;
      }>`select row_to_json(x)::text as j from ${sql.table(`${table_schema}.${table_name}`)} x`.execute(
        t.db,
      );
      for (const row of res.rows) {
        for (const needle of [
          CANARY,
          "Retries failed webhook deliveries",
          "Webhook deliveries are dropped",
        ]) {
          expect(row.j, `${table_schema}.${table_name}`).not.toContain(needle);
        }
      }
    }
    const jobData = await sql<{
      data: unknown;
    }>`select data from pgboss.job where name = 'intent.generate'`.execute(t.db);
    expect(jobData.rows.length).toBeGreaterThan(0);
    for (const r of jobData.rows) {
      expect(Object.keys(r.data as object).sort()).toEqual(Object.keys(GENERATE_DATA).sort());
    }
    for (const needle of [
      CANARY,
      "Retries failed webhook deliveries",
      "Fix the retry loop",
      "Webhook deliveries are dropped",
      "You write intent cards",
    ]) {
      expect(logged, needle).not.toContain(needle);
    }
    expect(logged).toContain("intent generate done");
  });

  it("I-INT-6 the same job again is served from the cache: no model call, check PATCHed, comment unchanged", async () => {
    await runJob();
    const callsBefore = current.calls.length;
    const reqs = api.requests.length;
    expect(await runJob()).toBe("cached");
    expect(current.calls).toHaveLength(callsBefore);
    const second = api.requests.slice(reqs).filter((r) => r.method !== "GET");
    expect(second.map((r) => r.method)).toEqual(["PATCH"]);
    expect(second[0]?.path).toMatch(/check-runs\/\d+$/);
    expect(api.state.comments).toHaveLength(1);
    expect(await cards()).toHaveLength(1);

    expect(await runJob({ trigger: "rerequested" })).toBe("cached");
    expect(current.calls).toHaveLength(callsBefore);
    expect(api.state.checkRuns).toHaveLength(1);
  });

  it("I-INT-7 a new head writes the pending note first, then a new card and a new check run", async () => {
    await runJob();
    const [cardA] = await cards();
    const headB = "b".repeat(40);
    moveHead(headB, "2026-10-14T12:30:00Z");
    const reqs = api.requests.length;
    expect(await runJob({ headSha: headB, trigger: "synchronize" })).toBe("published");

    const patches = api.requests
      .slice(reqs)
      .filter((r) => r.method === "PATCH" && /issues\/comments/.test(r.path));
    expect(patches).toHaveLength(2);
    expect(String(patches[0]?.body?.body)).toContain("Writing the card for head `bbbbbbb`");
    expect(String(patches[0]?.body?.body)).toContain("(head `ec26c3e`)");
    expect(String(patches[1]?.body?.body)).not.toContain("Writing the card for head");
    expect(String(patches[1]?.body?.body)).toContain("**Goal:**");

    expect(api.state.checkRuns.map((r) => r.head_sha)).toEqual([HEAD_SHA, headB]);
    const all = await cards();
    expect(all).toHaveLength(2);
    const stillA = all.find((c) => c.id === cardA?.id);
    expect(stillA).toMatchObject({ head_sha: HEAD_SHA, check_run_id: cardA?.check_run_id });
    expect(stillA?.updated_at).toEqual(cardA?.updated_at);
    expect(all.find((c) => c.head_sha === headB)?.check_run_id).toBe(api.state.checkRuns[1]?.id);
  });

  async function staleScenario(clearUpdatedAt: boolean) {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reachedP = new Promise<void>((r) => {
      reached = r;
    });
    current = scenarioLlm({
      writer: async () => {
        reached();
        await gate;
        return writerReply();
      },
    });
    const job = runJob();
    await reachedP;
    // The PR moves while the model is working.
    const headB = fakeSha(0xb);
    const pullB = makePull({ head: { sha: headB }, updated_at: "2026-10-14T12:30:00Z" });
    await upsertChangeFromPull(t.db, REPO_ID, pullB as never, new Date());
    if (clearUpdatedAt) {
      await t.db.updateTable("changes").set({ pr_updated_at: null }).execute();
    }
    release();
    return { outcome: await job, headB };
  }

  it("I-INT-8 the PR moves during the model call: the card is saved but nothing is published", async () => {
    const { outcome } = await staleScenario(false);
    expect(outcome).toBe("stale");
    const all = await cards();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      head_sha: HEAD_SHA,
      published_at: null,
      comment_id: null,
      check_run_id: null,
    });
    expect(repoWrites()).toEqual([]);
  });

  it("I-INT-9 only the in-lock head check can stop the publish when the snapshot time is cleared", async () => {
    const { outcome } = await staleScenario(true);
    expect(outcome).toBe("stale");
    expect((await cards())[0]?.published_at).toBeNull();
    expect(repoWrites()).toEqual([]);
  });

  it("I-INT-10 model down: an unavailable card at the floor, then automatic retries", async () => {
    current = scenarioLlm({ writer: { failure: "unavailable" } });
    expect(await runJob()).toBe("published");
    const [card] = await cards();
    expect(card).toMatchObject({
      status: "unavailable",
      failure_reason: "llm_unavailable",
      risk_floor: "sensitive",
      risk_class: "sensitive",
      goal: null,
      verifier_status: "skipped",
    });
    const body = api.state.comments[0]?.body ?? "";
    expect(body).toContain("**Card unavailable:** the model service is unavailable.");
    expect(body).toContain("Graft retries automatically.");
    const run = api.state.checkRuns[0];
    expect(run?.output.title).toBe("Card unavailable · risk: sensitive");
    expect(run?.actions ?? []).toEqual([]);

    const jobs = await intentJobs();
    expect(jobs.rows).toHaveLength(1);
    const key = `intent-retry:${card?.change_id}:${HEAD_SHA}:${card?.input_hash.slice(0, 16)}:1:${GENERATE_DATA.deliveryId}`;
    expect(jobs.rows[0]?.id).toBe(singletonJobId("intent.generate", key));
    expect(jobs.rows[0]?.data).toMatchObject({ trigger: "retry", attempt: 1, headSha: HEAD_SHA });
    const delay =
      ((jobs.rows[0]?.start_after.getTime() ?? 0) - (jobs.rows[0]?.now.getTime() ?? 0)) / 1000;
    expect(delay).toBeGreaterThan(290);
    expect(delay).toBeLessThanOrEqual(300);

    // Running the retry with a healthy model fills the same row and updates the same outputs.
    current = scenarioLlm();
    expect(await runJob({ trigger: "retry", attempt: 1 })).toBe("published");
    const after = await cards();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: card?.id, status: "ok", failure_reason: null });
    expect(api.state.comments).toHaveLength(1);
    expect(api.state.comments[0]?.body).toContain("**Goal:**");
    expect(api.state.checkRuns).toHaveLength(1);
    expect(api.state.checkRuns[0]?.actions).toHaveLength(2);

    // At attempt 2 a failure schedules nothing more.
    await t.db.deleteFrom("intent_cards").execute();
    current = scenarioLlm({ writer: { failure: "unavailable" } });
    const jobsBefore = (await intentJobs()).rows.length;
    await runJob({ trigger: "retry", attempt: 2 });
    expect((await intentJobs()).rows).toHaveLength(jobsBefore);
    expect((await cards())[0]?.status).toBe("unavailable");
    expect(api.state.comments[0]?.body).toContain("Re-run the `graft/intent` check to try again.");
  });

  it("I-INT-11 the daily budget: today's usage counts, yesterday's does not; no model call, no retry", async () => {
    await upsertChangeFromPull(t.db, REPO_ID, makePull() as never, FIXED_NOW);
    const ch = await change();
    // Spend is a ledger of model runs (D21): one row per run.
    const filler = (spentAt: Date, tokens: number, _hash: string) =>
      t.db
        .insertInto("intent_spend")
        .values({
          repository_id: REPO_ID,
          change_id: ch.id,
          tokens,
          llm_calls: 1,
          spent_at: spentAt,
        })
        .execute();
    await filler(new Date("2026-10-13T23:59:00Z"), 5_000_000, "1".repeat(64)); // yesterday
    expect(await runJob()).toBe("published");
    expect((await cards()).find((c) => c.head_sha === HEAD_SHA)?.status).toBe("ok");
    await t.db.deleteFrom("intent_cards").where("head_sha", "=", HEAD_SHA).execute();
    const callsBefore = current.calls.length;

    await filler(new Date("2026-10-14T01:00:00Z"), 2_000_000, "2".repeat(64)); // today
    const jobsBefore = (await intentJobs()).rows.length;
    expect(await runJob()).toBe("published");
    expect(current.calls).toHaveLength(callsBefore);
    const card = (await cards()).find((c) => c.head_sha === HEAD_SHA);
    expect(card).toMatchObject({
      status: "unavailable",
      failure_reason: "budget_exceeded",
      llm_calls: 0,
    });
    expect((await intentJobs()).rows).toHaveLength(jobsBefore);
    expect(api.state.comments[0]?.body).toContain("daily model budget is used up");
  });

  it("I-INT-12 a GitHub failure after the model call rolls back; the rerun pays nothing and publishes once", async () => {
    const SENTINEL = "RenderedCardSentinelQ7Z";
    current = scenarioLlm({ writer: writerReply({ goal: `Goal ${SENTINEL} for the card.` }) });
    api.failNext("POST", /\/check-runs$/, 500);
    const err = await runJob().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    // The request that failed carried the card, but the error that leaves the job does not.
    expect(JSON.stringify(api.requests)).toContain(SENTINEL);
    t.deps.log.error({ err }, "job failed");
    expect(inspect(err, { depth: 10 })).not.toContain(SENTINEL);
    expect(logged).toContain("job failed");
    expect(logged).not.toContain(SENTINEL);
    expect(err).toMatchObject({ status: 500, method: "POST" });
    const [card] = await cards();
    expect(card).toMatchObject({
      status: "ok",
      published_at: null,
      check_run_id: null,
      comment_id: null,
    });
    expect((await change()).graft_comment_id).toBeNull();
    const callsBefore = current.calls.length;

    expect(await runJob()).toBe("cached");
    expect(current.calls).toHaveLength(callsBefore);
    expect(api.state.comments).toHaveLength(1);
    expect(api.state.checkRuns).toHaveLength(1);
    expect((await cards())[0]?.published_at).not.toBeNull();
  });

  it("I-INT-13 a rate-limited file listing is retryable and writes nothing; a missing PR is permanent", async () => {
    api.failNext("GET", /\/pulls\/2\/files$/, 403, { "x-ratelimit-remaining": "0" });
    const err = await runJob().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    expect(await cards()).toEqual([]);
    expect(current.calls).toHaveLength(0);
    expect(repoWrites()).toEqual([]);

    api.state.pulls.delete(PR_NUMBER);
    await expect(runJob()).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("I-INT-14 a huge PR makes no listing request and no model call", async () => {
    current = forbiddenLlm();
    loadIntentScenario(api, { changed_files: 1500 });
    expect(await runJob()).toBe("published");
    expect(api.find("GET", /\/files$/)).toHaveLength(0);
    const [card] = await cards();
    expect(card).toMatchObject({
      status: "unavailable",
      failure_reason: "too_large",
      risk_class: "sensitive",
      risk_floor: "sensitive",
    });
    expect((await intentJobs()).rows).toHaveLength(0);
    expect(api.state.comments[0]?.body).toContain("too large for a card");
  });

  it("I-INT-15 a closed PR publishes nothing; a superseded retry is stale", async () => {
    api.state.pulls.set(
      PR_NUMBER,
      makePull({ state: "closed", closed_at: "2026-10-14T11:30:00Z" }),
    );
    expect(await runJob()).toBe("closed");
    expect(
      api.requests
        .filter((r) => !r.path.includes("access_tokens"))
        .map((r) => `${r.method} ${r.path}`),
    ).toEqual([`GET /repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`]);
    expect(await cards()).toEqual([]);

    loadIntentScenario(api);
    expect(await runJob({ trigger: "retry", attempt: 1, headSha: fakeSha(0x77) })).toBe("stale");
    expect(await cards()).toEqual([]);
    expect(current.calls).toHaveLength(0);
  });

  it("I-INT-16 saveCard: concurrent saves give one row, and an ok row is never replaced", async () => {
    await upsertChangeFromPull(t.db, REPO_ID, makePull() as never, FIXED_NOW);
    const ch = await change();
    const o = defaultGenerateOptions(testConfig(), { extraSensitiveGlobs: [] });
    const prepared = prepareCardInputs(inputs({ files: [file("src/a.ts")] }), o);
    const unavailable = unavailableResult(prepared, "llm_timeout");
    const { generateCard } = await import("../../src/modules/intent/generate.js");
    const okResult = await generateCard(
      inputs({ files: [file("src/a.ts")] }),
      scenarioLlm({ writer: writerReply({ risk_class: "trivial", out_of_scope_edits: [] }) }),
      o,
    );
    expect(okResult.inputHash).toBe(prepared.inputHash);
    const save = (result: typeof okResult) =>
      saveCard(t.db, { changeId: ch.id, headSha: HEAD_SHA, result, now: FIXED_NOW });

    const [a, b] = await Promise.all([save(unavailable), save(okResult)]);
    expect(a.id).toBe(b.id);
    expect(await cards()).toHaveLength(1);
    expect((await cards())[0]?.status).toBe("ok");
    const again = await save(unavailable);
    expect(again.status).toBe("ok");
    expect(again.goal).toBe(okResult.card?.goal);
    expect(
      await findCard(t.db, {
        changeId: ch.id,
        headSha: HEAD_SHA,
        promptVersion: PROMPT_VERSION,
        inputHash: prepared.inputHash,
      }),
    ).toMatchObject({ status: "ok" });

    // An unavailable row is replaced in place (same id) by a later ok card.
    await t.db.deleteFrom("intent_cards").execute();
    const first = await save(unavailable);
    const second = await save(okResult);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("ok");
  });

  it("the stored inputs schema accepts what the pipeline builds (step 4 loads fixtures with it)", () => {
    const i = inputs();
    expect(cardInputsSchema.parse(i)).toEqual(i);
    expect(() => cardInputsSchema.parse({ ...i, extra: 1 })).toThrow();
  });

  it("a removed repository and an inactive installation are skipped", async () => {
    await t.db.updateTable("repositories").set({ removed_at: new Date() }).execute();
    expect(await runJob()).toBe("skipped");
    await t.db.updateTable("installations").set({ suspended_at: new Date() }).execute();
    expect(await runJob()).toBe("skipped");
    expect(current.calls).toHaveLength(0);
  });
});

describe("review 1: spend, display time, retry notice", () => {
  const spent = () => tokensUsedToday(t.db, REPO_ID, FIXED_NOW);
  const tokensOf = (r: {
    usage: { inputTokens: number; outputTokens: number; cacheWriteTokens: number };
  }) => r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheWriteTokens;

  async function okAndUnavailable() {
    await upsertChangeFromPull(t.db, REPO_ID, makePull() as never, FIXED_NOW);
    const ch = await change();
    const o = defaultGenerateOptions(testConfig(), { extraSensitiveGlobs: [] });
    const prepared = prepareCardInputs(inputs({ files: [file("src/a.ts")] }), o);
    const { generateCard } = await import("../../src/modules/intent/generate.js");
    const okResult = await generateCard(
      inputs({ files: [file("src/a.ts")] }),
      scenarioLlm({ writer: writerReply({ risk_class: "trivial", out_of_scope_edits: [] }) }),
      o,
    );
    // An unavailable result that spent tokens, as a failed escalation or an invalid reply does.
    const unavailable = {
      ...unavailableResult(prepared, "invalid_output"),
      usage: {
        inputTokens: 1500,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 200,
        calls: 2,
      },
    };
    return { ch, okResult, unavailable };
  }

  it("I-INT-17 a retry of an unavailable row adds its spend: the budget sees both attempts", async () => {
    current = scenarioLlm({ writer: { json: { not: "a card" } } });
    expect(await runJob()).toBe("published");
    const first = await spent();
    expect(first).toBeGreaterThan(0);
    const [card] = await cards();
    expect(card).toMatchObject({ status: "unavailable", failure_reason: "invalid_output" });
    // The row keeps only the last attempt, the ledger keeps every attempt.
    expect(first).toBe(
      (card?.input_tokens ?? 0) + (card?.output_tokens ?? 0) + (card?.cache_write_tokens ?? 0),
    );

    expect(await runJob({ trigger: "rerequested" })).toBe("published");
    expect(await cards()).toHaveLength(1);
    expect(await spent()).toBe(first * 2);
    expect(await runJob({ trigger: "retry", attempt: 1 })).toBe("published");
    expect(await spent()).toBe(first * 3);
  });

  it("I-INT-18 a concurrent ok save that is dropped still counts its tokens", async () => {
    const { ch, okResult } = await okAndUnavailable();
    const save = () =>
      saveCard(t.db, { changeId: ch.id, headSha: HEAD_SHA, result: okResult, now: FIXED_NOW });
    await save();
    await save(); // the second one loses to the existing ok row
    expect(await cards()).toHaveLength(1);
    expect(await spent()).toBe(tokensOf(okResult) * 2);
    const ledger = await t.db.selectFrom("intent_spend").selectAll().execute();
    expect(ledger).toHaveLength(2);
    expect(ledger.every((r) => r.repository_id === REPO_ID && r.change_id === ch.id)).toBe(true);
  });

  it("I-INT-19 a row regenerated the next day does not move the earlier spend to the new day", async () => {
    const { ch, unavailable } = await okAndUnavailable();
    const day1 = new Date("2026-10-13T10:00:00Z");
    const day2 = new Date("2026-10-14T10:00:00Z");
    await saveCard(t.db, { changeId: ch.id, headSha: HEAD_SHA, result: unavailable, now: day1 });
    expect(await tokensUsedToday(t.db, REPO_ID, day1)).toBe(2000);
    await saveCard(t.db, { changeId: ch.id, headSha: HEAD_SHA, result: unavailable, now: day2 });
    expect(await cards()).toHaveLength(1);
    expect(await tokensUsedToday(t.db, REPO_ID, day1)).toBe(2000);
    expect(await tokensUsedToday(t.db, REPO_ID, day2)).toBe(2000);
    expect(await tokensUsedToday(t.db, REPO_ID + 1, day2)).toBe(0);
  });

  it("I-INT-20 the display time is taken inside the lock, after the model calls", async () => {
    let n = 0;
    const ctx = {
      ...jobContext(t),
      clock: { now: () => new Date(FIXED_NOW.getTime() + 60_000 * n++) },
    };
    expect(await generateIntent({ ...GENERATE_DATA }, ctx)).toBe("published");
    const [card] = await cards();
    // The job start is FIXED_NOW (call 0); the publish asks the clock again, later.
    expect(card?.published_at?.getTime()).toBeGreaterThan(FIXED_NOW.getTime());
    const shown = await publishedCards(t.db, card?.id ? (await change()).id : "");
    expect(shown).toEqual([{ id: card?.id, publishedAt: card?.published_at, available: true }]);
  });

  it("I-INT-21 'retries automatically' is shown only when a retry job was queued", async () => {
    current = scenarioLlm({ writer: { failure: "unavailable" } });
    expect(await runJob()).toBe("published");
    expect(api.state.comments[0]?.body).toContain("Graft retries automatically.");
    expect((await intentJobs()).rows).toHaveLength(1);

    // The same triggering delivery again (a pg-boss retry of the job): the send is deduplicated.
    expect(await runJob()).toBe("published");
    expect((await intentJobs()).rows).toHaveLength(1);
    expect(api.state.comments[0]?.body).not.toContain("retries automatically");
    expect(api.state.comments[0]?.body).toContain("Re-run the `graft/intent` check to try again.");
    expect(api.state.checkRuns[0]?.output.summary).not.toContain("retries automatically");

    // A new triggering delivery with the same inputs queues its own retry and says so.
    expect(await runJob({ deliveryId: "d-later" })).toBe("published");
    expect((await intentJobs()).rows).toHaveLength(2);
    expect(api.state.comments[0]?.body).toContain("Graft retries automatically.");
  });
});
