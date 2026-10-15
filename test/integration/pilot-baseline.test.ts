import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RateLimitAbort } from "../../src/github/rate-limit.js";
import { type BaselineOptions, runBaseline } from "../../src/pilot/baseline.js";
import { createTestApp, fakeGitHubFactory, type TestApp } from "../helpers/app.js";
import { truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import {
  commitMessage,
  fakeSha,
  makeCommit,
  makePull,
  makeReview,
  OWNER,
  REPO,
} from "../helpers/github-builders.js";
import { seedWorld } from "../helpers/seed.js";

let t: TestApp;
let api: FakeGitHubApi;
let nowMs: number;
let waits: number[];

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  await seedWorld(t.db);
  nowMs = Date.parse("2026-11-01T00:00:00Z");
  waits = [];
  api = createFakeGitHubApi({ now: () => nowMs });
});

const MIN = 60_000;
const at = (created: string, min: number): string =>
  new Date(Date.parse(created) + min * MIN).toISOString();

interface PrWorld {
  created: string;
  base?: string;
  author?: string;
  title?: string;
  body?: string | null;
  commitMessage?: string;
  additions?: number;
  deletions?: number;
  /** Minutes after creation: the review request, the approval, the merge. */
  request?: number;
  approve?: number;
  merge?: number | null;
  reviewer?: string;
}

/** A PR with a timeline of: review requested, approved, merged (all optional). */
function addPr(n: number, w: PrWorld): void {
  const merged =
    w.merge === undefined ? at(w.created, 100) : w.merge === null ? null : at(w.created, w.merge);
  const head = fakeSha(0x1000 + n);
  api.state.pulls.set(
    n,
    makePull({
      number: n,
      node_id: `PR_${n}`,
      state: merged ? "closed" : "open",
      merged: merged !== null,
      created_at: w.created,
      updated_at: w.created,
      closed_at: merged,
      merged_at: merged,
      title: w.title ?? `Title of ${n}`,
      body: w.body === undefined ? `Body of ${n}` : w.body,
      additions: w.additions ?? 10,
      deletions: w.deletions ?? 2,
      user: { login: w.author ?? "human-dev", type: w.author?.endsWith("[bot]") ? "Bot" : "User" },
      head: { sha: head },
      base: { ref: w.base ?? "main", repo: makePull().base.repo },
      commits: 1,
    }),
  );
  api.state.commits.set(n, [makeCommit(head, w.commitMessage ?? commitMessage("A change"))]);
  const reviewer = w.reviewer ?? "rev-login";
  const events: Record<string, unknown>[] = [];
  if (w.request !== undefined) {
    events.push({
      event: "review_requested",
      created_at: at(w.created, w.request),
      requested_reviewer: { login: reviewer, type: "User" },
    });
  }
  if (w.approve !== undefined) {
    events.push({
      event: "reviewed",
      submitted_at: at(w.created, w.approve),
      user: { login: reviewer, type: "User" },
      state: "approved",
      commit_id: head,
    });
  }
  if (merged !== null) {
    events.push({ event: "merged", created_at: merged }, { event: "closed", created_at: merged });
  }
  api.state.timelines.set(n, events);
}

const opts = (over: Partial<BaselineOptions> = {}): BaselineOptions => ({
  repo: `${OWNER}/${REPO}`,
  from: "2026-08-10",
  to: "2026-08-25",
  period: "baseline",
  maxRequests: 5000,
  maxWaitMs: 15 * MIN,
  dryRun: false,
  ...over,
});
const deps = () => ({
  db: t.db,
  github: fakeGitHubFactory(api),
  config: t.deps.config,
  now: () => nowMs,
  sleep: async (ms: number) => {
    waits.push(ms);
    nowMs += ms;
  },
});
const runs = () => t.db.selectFrom("review_time_runs").selectAll().execute();
const prs = () => t.db.selectFrom("review_time_prs").selectAll().orderBy("pr_number").execute();

describe("baseline extraction", () => {
  it("I-BASE-1 30 PRs over 3 list pages: only PRs created in [from, to) on the base branch are stored, with exact numbers", async () => {
    api.state.listPageSize = 10;
    for (let n = 1; n <= 30; n++) {
      // PR n was created 2026-08-01 + n days at 10:00 UTC.
      const created = new Date(Date.UTC(2026, 7, 1 + n, 10, 0, 0)).toISOString();
      addPr(n, {
        created,
        base: n === 15 ? "develop" : "main",
        request: 10,
        approve: 70,
        merge: n === 20 ? null : 100,
      });
    }
    const res = await runBaseline(deps(), opts());
    // 2026-08-10 is n = 9, and 2026-08-25 (10:00) is n = 24, which is outside [from, to).
    const stored = await prs();
    expect(stored.map((r) => r.pr_number)).toEqual([
      9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(res.prCount).toBe(14);
    for (const r of stored) {
      expect(r.excluded_reason).toBeNull();
      expect(r.start_basis).toBe("review_requested");
      expect(Number(r.minutes_to_first_approval)).toBe(60); // 70 - 10
      expect(r.size_bucket).toBe("S");
      expect(r.author_kind).toBe("human");
      expect(r.review_rounds).toBe(1);
      expect(r.merged_without_review).toBe(false);
      expect(Number(r.paused_minutes)).toBe(0);
      if (r.pr_number === 20) {
        expect(r.state).toBe("open");
        expect(r.minutes_to_merge).toBeNull();
      } else {
        expect(r.state).toBe("merged");
        expect(Number(r.minutes_to_merge)).toBe(90); // 100 - 10
      }
    }
    // The list was walked in pages of 10 and stopped after the first PR older than `from`.
    const listCalls = api.find("GET", /\/pulls$/);
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
    expect(listCalls.length).toBeLessThanOrEqual(3);
    const [run] = await runs();
    expect(run).toMatchObject({
      period: "baseline",
      from_date: "2026-08-10",
      to_date: "2026-08-25",
      base_ref: "main",
      extractor_version: 1,
      pr_count: 14,
      excluded_count: 0,
    });
    expect(run?.requests).toBe(res.requests);
    const agg = run?.aggregates as {
      all: { prs: number; merged: number; open: number; firstApproval: { n: number; p50: number } };
    };
    expect(agg.all).toMatchObject({ prs: 14, merged: 13, open: 1 });
    expect(agg.all.firstApproval).toMatchObject({ n: 14, p50: 60 });
  });

  it("I-BASE-2 rate limit: one wait of reset - now at the floor; a wait above --max-wait aborts with no run row", async () => {
    for (let n = 1; n <= 6; n++) {
      addPr(n, { created: `2026-08-1${n}T10:00:00Z`, request: 10, approve: 70 });
    }
    const resetSec = Math.floor(nowMs / 1000) + 120;
    api.state.rateLimit = { limit: 5000, remaining: 108, reset: resetSec };
    await runBaseline(deps(), opts());
    // Exactly one wait, until the reset instant (plus one second of margin).
    expect(waits).toEqual([resetSec * 1000 + 1000 - Date.parse("2026-11-01T00:00:00Z")]);
    expect(await runs()).toHaveLength(1);

    await t.db.deleteFrom("review_time_runs").execute();
    waits = [];
    nowMs = Date.parse("2026-11-01T00:00:00Z");
    api.state.rateLimit = { limit: 5000, remaining: 108, reset: Math.floor(nowMs / 1000) + 3600 };
    await expect(runBaseline(deps(), opts({ maxWaitMs: 15 * MIN }))).rejects.toBeInstanceOf(
      RateLimitAbort,
    );
    expect(waits).toEqual([]);
    expect(await runs()).toEqual([]);
    expect(await prs()).toEqual([]);

    // --max-requests aborts too, again without a partial run.
    api.state.rateLimit = null;
    const err = await runBaseline(deps(), opts({ maxRequests: 5 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitAbort);
    expect((err as RateLimitAbort).code).toBe("max_requests");
    expect(await runs()).toEqual([]);
  });

  it("I-BASE-3 author kind from trailers and from a human PR; an excluded author has a row and no times", async () => {
    addPr(1, {
      created: "2026-08-11T10:00:00Z",
      author: "someone",
      commitMessage: commitMessage("Agent work", undefined, [["Graft-Agent", "claude-code"]]),
      request: 5,
      approve: 50,
    });
    addPr(2, { created: "2026-08-12T10:00:00Z", request: 5, approve: 50 });
    addPr(3, {
      created: "2026-08-13T10:00:00Z",
      author: "dependabot[bot]",
      request: 5,
      approve: 50,
    });
    addPr(4, { created: "2026-08-14T10:00:00Z", author: "renovate[bot]", merge: null });
    const four = api.state.pulls.get(4);
    if (four) four.state = "closed";
    await runBaseline(deps(), opts());
    const rows = await prs();
    expect(
      rows.map((r) => [r.pr_number, r.author_kind, r.author_kind_reason, r.excluded_reason]),
    ).toEqual([
      [1, "agent", "trailer", null],
      [2, "human", "none", null],
      [3, "human", "none", "excluded_author"],
      [4, "human", "none", "excluded_author"],
    ]);
    const excluded = rows.find((r) => r.pr_number === 3);
    expect(excluded).toMatchObject({
      minutes_to_first_approval: null,
      minutes_to_merge: null,
      review_rounds: 0,
    });
    const [run] = await runs();
    expect(run).toMatchObject({ pr_count: 4, excluded_count: 2 });
    // Excluded rows are in no aggregate group; no request was spent on their timelines.
    const agg = run?.aggregates as Record<string, { prs: number }>;
    expect(agg.all?.prs).toBe(2);
    expect(agg.agent?.prs).toBe(1);
    expect(agg.human?.prs).toBe(1);
    expect(api.find("GET", /\/issues\/3\/timeline$/)).toEqual([]);
    expect(api.find("GET", /\/pulls\/3\/commits$/)).toEqual([]);
  });

  it("I-BASE-4 stored rows and aggregates hold no title, body, login or SHA (sentinels searched in every column)", async () => {
    const S = {
      title: "SENTINEL_TITLE_q7",
      body: "SENTINEL_BODY_q7 Graft-Model: sentinel-model-q7",
      author: "sentinel-author-q7",
      reviewer: "sentinel-reviewer-q7",
      commit: "SENTINEL_COMMIT_q7",
    };
    addPr(1, {
      created: "2026-08-11T10:00:00Z",
      title: S.title,
      body: S.body,
      author: S.author,
      reviewer: S.reviewer,
      commitMessage: commitMessage(S.commit, undefined, [
        ["Graft-Agent", "sentinel-agent-q7"],
        ["Graft-Session", "https://example.test/sentinel-session-q7"],
      ]),
      request: 5,
      approve: 50,
    });
    api.state.reviews.set(1, [makeReview({ id: 1, login: S.reviewer })]);
    await runBaseline(deps(), opts());
    expect(await prs()).toHaveLength(1);
    const text = [
      ...(
        await sql<{ t: string }>`select to_json(r)::text as t from review_time_runs r`.execute(t.db)
      ).rows,
      ...(
        await sql<{ t: string }>`select to_json(p)::text as t from review_time_prs p`.execute(t.db)
      ).rows,
    ]
      .map((r) => r.t)
      .join("\n");
    expect(text.length).toBeGreaterThan(100);
    for (const secret of [
      "SENTINEL",
      "sentinel",
      S.author,
      S.reviewer,
      fakeSha(0x1001),
      "example.test",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // The same holds for the aggregates the run prints.
    const printed = JSON.stringify((await runs())[0]?.aggregates);
    expect(printed).not.toMatch(/sentinel/i);
  });

  it("I-BASE-5 --dry-run writes nothing; --period shadow stores shadow", async () => {
    addPr(1, { created: "2026-08-11T10:00:00Z", request: 5, approve: 50 });
    const dry = await runBaseline(deps(), opts({ dryRun: true }));
    expect(dry.runId).toBeNull();
    expect(dry.prCount).toBe(1);
    expect(dry.aggregates.all.prs).toBe(1);
    expect(await runs()).toEqual([]);
    expect(await prs()).toEqual([]);

    const shadow = await runBaseline(deps(), opts({ period: "shadow" }));
    expect(shadow.runId).not.toBeNull();
    expect((await runs()).map((r) => r.period)).toEqual(["shadow"]);

    // An unknown repository is a usage error, not an empty run.
    await expect(runBaseline(deps(), opts({ repo: "nobody/nothing" }))).rejects.toThrow(
      /not found/,
    );
  });
});
