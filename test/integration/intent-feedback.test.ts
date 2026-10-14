import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GitHubClientFactory } from "../../src/github/client-factory.js";
import { buildServer } from "../../src/http/server.js";
import { upsertChangeFromPull } from "../../src/modules/changes/index.js";
import { pollReactions, recordFeedback, sweepFeedback } from "../../src/modules/intent/feedback.js";
import { generateIntent } from "../../src/modules/intent/job.js";
import { feedbackSummary, upsertFeedback } from "../../src/modules/intent/store.js";
import { singletonJobId } from "../../src/queue/queue.js";
import { startWorker } from "../../src/queue/worker.js";
import {
  createTestApp,
  fakeGitHubFactory,
  jobContext,
  postRaw,
  type TestApp,
} from "../helpers/app.js";
import { FIXED_NOW } from "../helpers/config.js";
import { truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture, setPath } from "../helpers/fixtures.js";
import {
  fakeSha,
  HEAD_SHA,
  INSTALLATION_ID,
  makePull,
  makeReaction,
  OWNER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";
import { GENERATE_DATA, loadIntentScenario, scenarioLlm } from "../helpers/intent-scenario.js";
import { seedWorld } from "../helpers/seed.js";
import { waitFor } from "../helpers/wait.js";

let t: TestApp;
let api: FakeGitHubApi;
let factory: GitHubClientFactory;
const github: GitHubClientFactory = {
  forInstallation: (id) => factory.forInstallation(id),
  asApp: () => factory.asApp(),
};

beforeAll(async () => {
  t = await createTestApp({ github, llm: scenarioLlm() });
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  await seedWorld(t.db);
  api = createFakeGitHubApi();
  factory = fakeGitHubFactory(api);
  loadIntentScenario(api);
});

const HOUR = 3_600_000;
const runAt = (offsetMs: number, over: Partial<typeof GENERATE_DATA> = {}) =>
  generateIntent(
    { ...GENERATE_DATA, ...over },
    { ...jobContext(t), clock: { now: () => new Date(FIXED_NOW.getTime() + offsetMs) } },
  );
const change = () => t.db.selectFrom("changes").selectAll().executeTakeFirstOrThrow();
const feedback = () =>
  t.db.selectFrom("intent_feedback").selectAll().orderBy("user_id").orderBy("source").execute();
const pollData = async () => ({
  installationId: INSTALLATION_ID,
  repositoryId: REPO_ID,
  owner: OWNER,
  repo: REPO,
  changeId: (await change()).id,
});
const at = (offsetMs: number) => new Date(FIXED_NOW.getTime() + offsetMs).toISOString();

/** Card A at 12:00 and card B (the description changed) at 13:00, on the same head. */
async function publishTwoCards() {
  await runAt(0);
  loadIntentScenario(api, {
    body: "Fixes #42\n\nA different description.",
    updated_at: "2026-10-14T12:30:00Z",
  });
  await runAt(HOUR, { trigger: "edited" });
  const cards = await t.db.selectFrom("intent_cards").selectAll().orderBy("published_at").execute();
  expect(cards).toHaveLength(2);
  return cards as [(typeof cards)[number], (typeof cards)[number]];
}

describe("reaction polling", () => {
  it("I-FB-1 reactions are attributed to the card displayed when they were made", async () => {
    const [a, b] = await publishTwoCards();
    const commentId = api.state.comments[0]?.id as number;
    api.state.reactions.set(commentId, [
      makeReaction(1, "reviewer-1", "+1", at(30 * 60_000)),
      makeReaction(2, "reviewer-2", "-1", at(90 * 60_000)),
      makeReaction(3, "graft-dev", "+1", at(45 * 60_000)),
      makeReaction(4, "reviewer-4", "heart", at(45 * 60_000)),
      makeReaction(5, "some-bot", "+1", at(45 * 60_000), "Bot"),
      makeReaction(6, "early-bird", "+1", at(-60 * 60_000)),
    ]);
    await pollReactions(await pollData(), jobContext(t));
    const rows = await feedback();
    expect(
      rows.map((r) => [r.card_id, r.user_id, r.user_login, r.verdict, r.source, r.is_pr_author]),
    ).toEqual([
      [a.id, 5_000_001, "reviewer-1", "up", "reaction", false],
      [b.id, 5_000_002, "reviewer-2", "down", "reaction", false],
      [a.id, 5_000_003, "graft-dev", "up", "reaction", true],
    ]);
    expect(rows[0]?.reacted_at).toEqual(new Date(at(30 * 60_000)));
    expect(rows[0]?.change_id).toBe((await change()).id);
  });

  it("I-FB-2 a second poll removes withdrawn reactions, updates changed ones and leaves button votes alone", async () => {
    const [a, b] = await publishTwoCards();
    const commentId = api.state.comments[0]?.id as number;
    api.state.reactions.set(commentId, [
      makeReaction(1, "reviewer-1", "+1", at(30 * 60_000)),
      makeReaction(2, "reviewer-2", "+1", at(90 * 60_000)),
    ]);
    const data = await pollData();
    await pollReactions(data, jobContext(t));
    await upsertFeedback(
      t.db,
      {
        card_id: b.id,
        change_id: data.changeId,
        user_id: 9,
        user_login: "button-user",
        verdict: "down",
        source: "check_action",
        reacted_at: new Date(at(100 * 60_000)),
        is_pr_author: false,
      },
      FIXED_NOW,
    );

    api.state.reactions.set(commentId, [makeReaction(2, "reviewer-2", "-1", at(100 * 60_000))]);
    await pollReactions(data, jobContext(t));
    const rows = await feedback();
    expect(rows.map((r) => [r.card_id, r.user_login, r.verdict, r.source])).toEqual([
      [b.id, "button-user", "down", "check_action"],
      [b.id, "reviewer-2", "down", "reaction"],
    ]);
    void a;
  });

  it("a poll for a change with no comment, or a missing comment, does nothing", async () => {
    await runAt(0);
    const data = await pollData();
    // 404 for the reactions of an unknown comment: no rows, no error
    expect(await pollReactions(data, jobContext(t))).toBeNull();
    await t.db.updateTable("changes").set({ graft_comment_id: null }).execute();
    expect(await pollReactions(data, jobContext(t))).toBeNull();
    expect(await feedback()).toEqual([]);
  });
});

describe("reaction attribution across displays", () => {
  const MIN = 60_000;
  const runWith = (
    offsetMs: number,
    llm: ReturnType<typeof scenarioLlm>,
    over: Partial<typeof GENERATE_DATA> = {},
  ) =>
    generateIntent(
      { ...GENERATE_DATA, ...over },
      { ...jobContext(t), llm, clock: { now: () => new Date(FIXED_NOW.getTime() + offsetMs) } },
    );

  it("I-FB-6 A, B, A again: reactions after the second display of A are credited to A", async () => {
    const [a, b] = await publishTwoCards();
    // The description goes back to the first one: the cached card A is shown again.
    loadIntentScenario(api, { updated_at: "2026-10-14T13:30:00Z" });
    await runAt(2 * HOUR, { trigger: "edited" });
    const commentId = api.state.comments[0]?.id as number;
    api.state.reactions.set(commentId, [
      makeReaction(1, "reviewer-1", "+1", at(30 * MIN)),
      makeReaction(2, "reviewer-2", "-1", at(90 * MIN)),
      makeReaction(3, "reviewer-3", "+1", at(150 * MIN)),
    ]);
    await pollReactions(await pollData(), jobContext(t));
    expect((await feedback()).map((r) => [r.card_id, r.user_login, r.verdict])).toEqual([
      [a.id, "reviewer-1", "up"],
      [b.id, "reviewer-2", "down"],
      [a.id, "reviewer-3", "up"],
    ]);
    const displays = await t.db
      .selectFrom("intent_displays")
      .select(["card_id", "status"])
      .orderBy("seq")
      .execute();
    expect(displays).toEqual([
      { card_id: a.id, status: "ok" },
      { card_id: b.id, status: "ok" },
      { card_id: a.id, status: "ok" },
    ]);
  });

  it("I-FB-7 a reaction to the 'card unavailable' notice is not a vote on the card that replaces it", async () => {
    await runWith(0, scenarioLlm({ writer: { failure: "unavailable" } }));
    const [unavailable] = await t.db.selectFrom("intent_cards").selectAll().execute();
    expect(unavailable?.status).toBe("unavailable");
    // The automatic retry fills the same row, 5 minutes later.
    await runWith(10 * MIN, scenarioLlm(), { trigger: "retry", attempt: 1 });
    const [card] = await t.db.selectFrom("intent_cards").selectAll().execute();
    expect(card).toMatchObject({ id: unavailable?.id, status: "ok" });
    const commentId = api.state.comments[0]?.id as number;
    api.state.reactions.set(commentId, [
      makeReaction(1, "on-notice", "-1", at(5 * MIN)),
      makeReaction(2, "on-card", "+1", at(20 * MIN)),
    ]);
    await pollReactions(await pollData(), jobContext(t));
    expect((await feedback()).map((r) => [r.card_id, r.user_login, r.verdict])).toEqual([
      [card?.id, "on-card", "up"],
    ]);
  });

  it("I-FB-8 a republish of the card already on screen adds no display", async () => {
    await runAt(0);
    await runAt(5 * MIN, { trigger: "rerequested" });
    expect(await t.db.selectFrom("intent_displays").selectAll().execute()).toHaveLength(1);
  });
});

describe("check-run button votes", () => {
  it("I-FB-9 a click on a card that the check run no longer shows is not credited to the newer card", async () => {
    const [a, b] = await publishTwoCards();
    const run = api.state.checkRuns[0];
    expect(run?.external_id).toBe(b.id);
    const data = {
      installationId: INSTALLATION_ID,
      repositoryId: REPO_ID,
      owner: OWNER,
      repo: REPO,
      checkRunId: run?.id as number,
      verdict: "down" as const,
      userId: 5000001,
      userLogin: "reviewer-1",
      deliveryId: "fb-old",
    };
    // The payload said the click was on card A; the check run has meanwhile been updated to B.
    expect(await recordFeedback({ ...data, externalId: a.id }, jobContext(t))).toBe("ignored");
    expect(await feedback()).toEqual([]);
    expect(await recordFeedback({ ...data, externalId: b.id }, jobContext(t))).toBe("recorded");
    expect((await feedback()).map((r) => r.card_id)).toEqual([b.id]);
  });
});

describe("feedback sweep", () => {
  it("I-FB-3 polls open changes and recently closed ones with a published card, once per 15-minute bucket", async () => {
    const day = 86_400_000;
    const mk = async (
      n: number,
      o: { state: string; closedDaysAgo?: number; card: boolean; publishedAgoDays?: number },
    ) => {
      const row = await t.db
        .insertInto("changes")
        .values({
          repository_id: REPO_ID,
          pr_number: n,
          pr_node_id: `n${n}`,
          task_id: null,
          head_sha: fakeSha(n),
          base_ref: "main",
          author_login: "x",
          state: o.state as "open",
          merge_commit_sha: null,
          opened_at: new Date(FIXED_NOW.getTime() - 10 * day),
          closed_at:
            o.closedDaysAgo === undefined
              ? null
              : new Date(FIXED_NOW.getTime() - o.closedDaysAgo * day),
          merged_at: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (o.card) {
        await sql`insert into intent_cards (change_id, head_sha, prompt_version, input_hash, status, goal, risk_class, risk_floor, verifier_status,
            files_total, files_listed, files_full, files_partial, files_omitted, lines_added, lines_deleted, inputs_truncated, published_at)
          values (${row.id}, ${fakeSha(n)}, 'v', ${"c".repeat(64)}, 'ok', 'g', 'logic', 'trivial', 'agree', 1, 1, 1, 0, 0, 1, 0, false,
            ${new Date(FIXED_NOW.getTime() - (o.publishedAgoDays ?? 1) * day)})`.execute(t.db);
      }
      return row.id;
    };
    const open = await mk(11, { state: "open", card: true });
    const merged = await mk(12, { state: "merged", closedDaysAgo: 2, card: true });
    await mk(13, { state: "closed", closedDaysAgo: 5, card: true });
    await mk(14, { state: "open", card: false });
    await mk(15, { state: "open", card: true, publishedAgoDays: 31 });

    const ctx = jobContext(t);
    expect(await sweepFeedback(ctx)).toBe(2);
    const jobs = await sql<{ id: string; data: { changeId: string; owner: string; repo: string } }>`
      select id, data from pgboss.job where name = 'intent.feedback.poll'`.execute(t.db);
    const bucket = Math.floor(FIXED_NOW.getTime() / 900_000);
    expect(jobs.rows.map((r) => r.id).sort()).toEqual(
      [open, merged]
        .map((id) => singletonJobId("intent.feedback.poll", `fb-poll:${id}:${bucket}`))
        .sort(),
    );
    expect(jobs.rows[0]?.data).toMatchObject({ owner: OWNER, repo: REPO });
    expect(await sweepFeedback(ctx)).toBe(0);
    const later = { ...ctx, clock: { now: () => new Date(FIXED_NOW.getTime() + 900_000) } };
    expect(await sweepFeedback(later)).toBe(2);
  });
});

describe("feedback summary", () => {
  it("I-FB-5 effective votes across sources, PR authors excluded by default, accuracy", async () => {
    await upsertChangeFromPull(t.db, REPO_ID, makePull() as never, FIXED_NOW);
    const ch = await change();
    expect(await feedbackSummary(t.db)).toEqual({
      votes: { up: 0, down: 0 },
      cards: { rated: 0, accurate: 0, inaccurate: 0 },
      accuracy: null,
    });
    const card = async (hash: string) =>
      (
        await sql<{
          id: string;
        }>`insert into intent_cards (change_id, head_sha, prompt_version, input_hash, status, goal, risk_class, risk_floor, verifier_status,
          files_total, files_listed, files_full, files_partial, files_omitted, lines_added, lines_deleted, inputs_truncated)
          values (${ch.id}, ${HEAD_SHA}, 'v', ${hash.repeat(64)}, 'ok', 'g', 'logic', 'trivial', 'agree', 1, 1, 1, 0, 0, 1, 0, false) returning id`.execute(
          t.db,
        )
      ).rows[0]?.id as string;
    const c1 = await card("1");
    const c2 = await card("2");
    const c3 = await card("3");
    const vote = (
      cardId: string,
      user: number,
      verdict: "up" | "down",
      source: "reaction" | "check_action",
      min: number,
      author = false,
    ) =>
      upsertFeedback(
        t.db,
        {
          card_id: cardId,
          change_id: ch.id,
          user_id: user,
          user_login: `u${user}`,
          verdict,
          source,
          reacted_at: new Date(FIXED_NOW.getTime() + min * 60_000),
          is_pr_author: author,
        },
        FIXED_NOW,
      );
    // c1: user 1 up by reaction, then down by button -> effective down. user 2 up.
    await vote(c1, 1, "up", "reaction", 0);
    await vote(c1, 1, "down", "check_action", 5);
    await vote(c1, 2, "up", "reaction", 1);
    // c2: user 1 down by button, then up by reaction (later) -> effective up. The PR author votes down.
    await vote(c2, 1, "down", "check_action", 0);
    await vote(c2, 1, "up", "reaction", 5);
    await vote(c2, 3, "down", "reaction", 1, true);
    // c3: no votes.
    void c3;
    const s = await feedbackSummary(t.db);
    expect(s).toEqual({
      votes: { up: 2, down: 1 },
      cards: { rated: 2, accurate: 1, inaccurate: 1 },
      accuracy: 0.5,
    });
    const withAuthors = await feedbackSummary(t.db, { includePrAuthors: true });
    expect(withAuthors.votes).toEqual({ up: 2, down: 2 });
    expect(withAuthors.cards).toEqual({ rated: 2, accurate: 0, inaccurate: 2 });
    expect(withAuthors.accuracy).toBe(0);
    expect(await feedbackSummary(t.db, { repositoryId: 424242 })).toMatchObject({ accuracy: null });
    expect(
      (await feedbackSummary(t.db, { since: new Date(FIXED_NOW.getTime() + 3 * 60_000) })).votes,
    ).toEqual({
      up: 1,
      down: 1,
    });
  });
});

describe("check-run buttons", () => {
  let tw: TestApp;
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    tw = await createTestApp({ supervise: true, github, llm: scenarioLlm() });
    server = await buildServer(tw.deps);
    await startWorker(tw.deps.queue, tw.deps.registry, jobContext(tw), { concurrency: 2 });
  });
  afterAll(async () => {
    await server.close();
    await tw.close();
  });

  const recordJobs = async (state?: string) =>
    (
      await sql<{
        n: string;
      }>`select count(*)::text n from pgboss.job where name = 'intent.feedback.record' ${
        state ? sql`and state = ${state}` : sql``
      }`.execute(t.db)
    ).rows[0]?.n;

  it("I-FB-4 a requested_action through the server records one vote per user and card; foreign check runs record nothing", async () => {
    await runAt(0);
    const run = api.state.checkRuns[0];
    const [card] = await t.db.selectFrom("intent_cards").selectAll().execute();
    expect(run?.external_id).toBe(card?.id);
    const body = (edit?: (p: Record<string, unknown>) => void) => {
      const p = structuredClone(loadFixture("check_run.requested_action").payload) as Record<
        string,
        unknown
      >;
      setPath(p, "check_run.id", run?.id);
      edit?.(p);
      return JSON.stringify(p);
    };
    const completed = (n: number) =>
      waitFor(async () => (await recordJobs("completed")) === String(n));

    const res = await postRaw(server, "check_run", body(), "fb-1");
    expect(res.statusCode).toBe(202);
    await completed(1);
    const job = await sql<{
      data: Record<string, unknown>;
    }>`select data from pgboss.job where name = 'intent.feedback.record'`.execute(t.db);
    expect(job.rows[0]?.data).toEqual({
      installationId: INSTALLATION_ID,
      repositoryId: REPO_ID,
      owner: OWNER,
      repo: REPO,
      checkRunId: run?.id,
      verdict: "up",
      userId: 5000001,
      userLogin: "reviewer-1",
      deliveryId: "fb-1",
    });
    let rows = await feedback();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      card_id: card?.id,
      user_id: 5000001,
      user_login: "reviewer-1",
      verdict: "up",
      source: "check_action",
      is_pr_author: false,
    });

    // A replay under a new delivery id, and a second user's click: still one vote per user.
    await postRaw(server, "check_run", body(), "fb-2");
    await postRaw(
      server,
      "check_run",
      body((p) => {
        setPath(p, "sender.id", 5000002);
        setPath(p, "sender.login", "reviewer-2");
        setPath(p, "requested_action.identifier", "card_down");
      }),
      "fb-3",
    );
    await completed(3);
    rows = await feedback();
    expect(rows.map((r) => [r.user_login, r.verdict])).toEqual([
      ["reviewer-1", "up"],
      ["reviewer-2", "down"],
    ]);

    // Another app's check run, and an unknown or malformed external_id: nothing is recorded.
    const data = {
      installationId: INSTALLATION_ID,
      repositoryId: REPO_ID,
      owner: OWNER,
      repo: REPO,
      checkRunId: run?.id as number,
      verdict: "up" as const,
      userId: 5000009,
      userLogin: "reviewer-9",
      deliveryId: "fb-x",
    };
    if (run) run.app.id = 999;
    expect(await recordFeedback(data, jobContext(t))).toBe("ignored");
    if (run) {
      run.app.id = api.appId;
      run.external_id = "00000000-0000-4000-8000-000000000000";
    }
    expect(await recordFeedback(data, jobContext(t))).toBe("ignored");
    if (run) run.external_id = "not-a-uuid";
    expect(await recordFeedback(data, jobContext(t))).toBe("ignored");
    expect(await recordFeedback({ ...data, checkRunId: 424242 }, jobContext(t))).toBe("ignored");
    if (run) run.external_id = card?.id as string;
    expect(await recordFeedback({ ...data, repositoryId: 777 }, jobContext(t))).toBe("ignored");
    expect(await feedback()).toHaveLength(2);
    expect(await recordFeedback(data, jobContext(t))).toBe("recorded");
    expect(await feedback()).toHaveLength(3);
  });
});
