import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import { rollupRange } from "../../src/modules/pilot/index.js";
import { parseAllowList } from "../../src/pilot/allow-list.js";
import { GateUsageError, gatherGate } from "../../src/pilot/gate.js";
import { gateReportSchema, renderGateMarkdown } from "../../src/pilot/gate-render.js";
import { createTestApp, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";
import { fakeSha } from "../helpers/github-builders.js";
import {
  addIncidentRow,
  GATE_SINCE,
  GATE_UNTIL,
  PILOT_A,
  PILOT_B,
  PILOT_C,
  seedGateWorld,
} from "../helpers/pilot-seed.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
});

const gate = (ids: number[], over: Partial<Parameters<typeof gatherGate>[2]> = {}) =>
  gatherGate(t.db, t.deps.config, {
    installationIds: ids,
    since: GATE_SINCE,
    until: GATE_UNTIL,
    allow: null,
    ...over,
  });
const rollup = async (installationId: number) => {
  await rollupRange(jobContext(t), { installationId, from: GATE_SINCE, to: GATE_UNTIL });
};
async function seed(o: Parameters<typeof seedGateWorld>[1] = {}) {
  const world = await seedGateWorld(t.db, o);
  await rollup(PILOT_A.id);
  await rollup(PILOT_B.id);
  return world;
}

/**
 * The hand count of the seeded world (test/helpers/pilot-seed.ts): per pilot 30 PRs with one card
 * each, 3 reviewers voting per PR. Pilot A has 5 down votes (PRs 1-5), pilot B 6 (PRs 1-6), so
 * 169 up and 11 down over 180 eligible votes, on 60 PRs, from 8 voters. Not counted: 4 author votes
 * (A, PRs 1-4), 2 bot votes (B, PRs 1-2) and 3 votes from someone who never reviewed (A, PRs 5-7).
 */
describe("gate report", () => {
  it("I-GATE-1 two pilots: the report equals the hand count and the verdict is PASS", async () => {
    await seed();
    const r = await gate([PILOT_A.id, PILOT_B.id]);
    expect(r.verdict).toBe("PASS");
    // A PASS says why: accuracy, the lower bound and n.
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatchObject({ code: "pass", n: 180 });
    // The 14-day minimum is measured on the data: the first to the last vote (PRs 3 to 22 Nov).
    expect(r.window).toEqual({
      since: "2026-11-01",
      until: "2026-11-29",
      days: 28,
      dataSpanDays: 19,
    });
    expect(r.installations).toEqual([
      { id: PILOT_A.id, account: "graft-sandbox", repositories: 1 },
      { id: PILOT_B.id, account: "globex", repositories: 1 },
    ]);
    const a = r.accuracy;
    expect(a).toMatchObject({ up: 169, down: 11, n: 180, prs: 60, voters: 8 });
    expect(a.accuracy).toBeCloseTo(169 / 180, 12);
    expect(a.wilson?.lower).toBeCloseTo(0.8938988871786024, 9);
    expect(a.wilson?.upper).toBeCloseTo(0.9655372865846754, 9);
    expect(a.dropped).toEqual({ author: 4, bot_or_agent: 2, not_reviewer: 3 });
    expect(a.cards).toEqual({ rated: 60, accurate: 49, inaccurate: 11 });
    expect(a.bySource).toEqual({ reaction: 160, check_action: 20 });
    expect(a.votesWithoutReviewerSync).toBe(0);
    expect(
      a.perInstallation.map((p) => [p.installationId, p.up, p.down, p.n, p.prs, p.voters]),
    ).toEqual([
      [PILOT_A.id, 85, 5, 90, 30, 4],
      [PILOT_B.id, 84, 6, 90, 30, 4],
    ]);
    expect(a.perInstallation[0]?.wilson?.lower).toBeCloseTo(0.8764626370797953, 9);
    // 59 of the 60 PRs have a card on screen (B's PR 30 has none); every PR has provenance. The
    // dependabot PR and the PR closed after 5 minutes are not in the population.
    expect(r.coverage.cards).toMatchObject({ count: 59, total: 60 });
    expect(r.coverage.cards.ratio).toBeCloseTo(59 / 60, 12);
    expect(r.coverage.provenance).toMatchObject({ count: 60, total: 60, ratio: 1 });
    expect(r.warnings).toEqual([]);

    // Side metrics, from the rollup: 10 merged PRs per pilot.
    expect(r.policy).toEqual({
      merged: 20,
      wouldApprove: 8,
      wouldRequire: 8,
      wouldBlock: 2,
      noPolicy: 2,
      policyInvalid: 0,
      noVerdict: 0,
      wouldApproveAgent: 4,
      mergedAgent: 10,
      mergedTrivial: 8,
    });
    expect(r.cards).toMatchObject({
      created: 62,
      ok: 60,
      unavailable: 2,
      verifier: { agree: 56, disagree: 4, error: 0, skipped: 2 },
      unavailableByReason: [{ reason: "llm_timeout", count: 2 }],
      prsWithDisplay: 59,
      prsLastUnavailable: 2,
      costUsd: "0.06",
      pricedPrs: 6,
      tokens: 7000,
      unpricedRuns: 2,
      unpricedTokens: 1000,
    });
    expect(r.escapedDefects).toMatchObject({ incidents: 0, merged: 20, per100: 0 });
    expect(r.escapedDefects.baselinePer100).toBeNull();

    // The markdown and JSON hold counts only: no voter, author or reviewer login.
    const md = renderGateMarkdown(r);
    const json = JSON.stringify(gateReportSchema.parse(r));
    for (const secret of [
      "a-rev-",
      "b-rev-",
      "driveby-person",
      "ci-bot",
      "dev-a-",
      "dev-b-",
      "dependabot",
    ]) {
      expect(md, secret).not.toContain(secret);
      expect(json, secret).not.toContain(secret);
    }
    expect(md).toContain("**Verdict: PASS**");
    expect(md).toContain("| All | 169 | 11 | 180 | 93.9% | 89.4–96.6% | 60 | 8 |");
  });

  it("I-GATE-1 (data span) a 28-day --since to --until does not satisfy the 14-day minimum when the votes span 3.5 days", async () => {
    await seed();
    await sql`update intent_feedback set reacted_at = '2026-11-05T10:00:00Z'::timestamptz + (user_id % 4) * interval '1 day' + (case when user_id % 4 = 3 then interval '12 hours' else interval '0' end)`.execute(
      t.db,
    );
    const r = await gate([PILOT_A.id, PILOT_B.id]);
    expect(r.window).toMatchObject({ days: 28, dataSpanDays: 3.5 });
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.reasons).toContainEqual({ code: "window_too_short", days: 3.5, required: 14 });
  });

  it("U-GATE-11 (sentinel voters) no report file holds a voter login, whatever the verdict", async () => {
    await seed();
    await t.db
      .updateTable("intent_feedback")
      .set({ user_login: sql`'sentinel-voter-' || user_id` })
      .execute();
    const r = await gate([PILOT_A.id, PILOT_B.id]);
    const md = renderGateMarkdown(r);
    expect(md).not.toContain("sentinel-voter");
    expect(JSON.stringify(r)).not.toContain("sentinel-voter");
    expect(r.accuracy.n).toBeGreaterThan(0);
  });

  it("I-GATE-2 without reviewer rows every vote is not_reviewer (INSUFFICIENT_DATA); an allow-file of the voters restores PASS", async () => {
    const world = await seed();
    await t.db.deleteFrom("pr_reviewers").execute();
    const none = await gate([PILOT_A.id, PILOT_B.id]);
    expect(none.verdict).toBe("INSUFFICIENT_DATA");
    expect(none.accuracy.n).toBe(0);
    expect(none.accuracy.dropped).toEqual({ author: 4, bot_or_agent: 2, not_reviewer: 183 });
    expect(none.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining(["below_min_votes", "below_min_prs", "below_min_voters"]),
    );
    expect(none.accuracy.wilson).toBeNull();
    expect(none.accuracy.votesWithoutReviewerSync).toBeGreaterThan(0);
    expect(none.warnings).toContain("votes_without_reviewer_sync");

    // Case does not matter in the allow-list.
    const allow = parseAllowList(
      `# every reviewer\n${world.voterLogins.map((l) => l.toUpperCase()).join("\n")}\n`,
    );
    const back = await gate([PILOT_A.id, PILOT_B.id], { allow });
    expect(back.verdict).toBe("PASS");
    expect(back.accuracy).toMatchObject({ up: 169, down: 11, n: 180, voters: 8 });
    expect(back.allowList).toEqual({ count: 8, sha256: allow.sha256 });
    expect(back.accuracy.dropped).toEqual({ author: 4, bot_or_agent: 2, not_reviewer: 3 });
  });

  it("I-GATE-3 a third installation's votes do not leak into a report for the first two", async () => {
    await seed();
    const before = await gate([PILOT_A.id, PILOT_B.id]);
    await seedThird();
    const after = await gate([PILOT_A.id, PILOT_B.id]);
    expect(after).toEqual(before);
    // Asked for, the third installation counts on its own.
    const third = await gate([PILOT_C.id, PILOT_A.id]);
    expect(third.accuracy.n).toBe(90 + 45);
    expect(third.accuracy.down).toBe(45 + 5);
    await expect(gate([PILOT_A.id, 7777])).rejects.toBeInstanceOf(GateUsageError);
  });

  async function seedThird() {
    // seedGateWorld with `third` re-creates the pilots, so add only the third by hand.
    const { addInstallation, addChange, addCard, addVote, addReviewer, SHA } = await import(
      "../helpers/pilot-seed.js"
    );
    await addInstallation(t.db, {
      id: PILOT_C.id,
      login: PILOT_C.login,
      repos: [{ id: PILOT_C.repo, name: "web" }],
    });
    for (let i = 1; i <= 45; i++) {
      const opened = new Date("2026-11-06T10:00:00Z");
      const head = SHA(PILOT_C.repo * 100 + i);
      const change = await addChange(t.db, {
        repositoryId: PILOT_C.repo,
        prNumber: i,
        author: `dev-c-${i}`,
        openedAt: opened,
        headSha: head,
      });
      const card = await addCard(t.db, { changeId: change, headSha: head, createdAt: opened });
      await addVote(t.db, {
        changeId: change,
        cardId: card,
        userId: 300 + (i % 5),
        login: `c-rev-${i % 5}`,
        verdict: "down",
        at: new Date(opened.getTime() + 1_800_000),
      });
      await addReviewer(t.db, { changeId: change, userId: 300 + (i % 5) });
    }
  }

  it("I-GATE-4 the latest run per period is used; the shadow comparison is exact", async () => {
    await seed();
    const run = async (
      period: "baseline" | "shadow",
      at: string,
      rows: [number, "agent" | "human", number | null, number | null, (string | null)?][],
      repo: number = PILOT_A.repo,
    ) => {
      const res = await sql<{ id: string }>`
        insert into review_time_runs (repository_id, period, from_date, to_date, base_ref, extractor_version,
          pr_count, excluded_count, aggregates, requests, extracted_at)
        values (${repo}, ${period}, '2026-08-01', '2026-10-31', 'main', 1, ${rows.length}, 0, '{}'::jsonb, 1, ${new Date(at)})
        returning id`.execute(t.db);
      const id = res.rows[0]?.id as string;
      for (const [pr, kind, first, merge, excluded] of rows) {
        await sql`insert into review_time_prs (run_id, pr_number, state, author_kind, author_kind_reason, size_bucket,
          start_basis, minutes_to_first_approval, minutes_to_merge, review_rounds, merged_without_review, paused_minutes, excluded_reason)
          values (${id}, ${pr}, 'merged', ${kind}, 'none', 'S', 'opened', ${first}, ${merge}, 1, false, 0, ${excluded ?? null})`.execute(
          t.db,
        );
      }
    };
    // An older baseline run that must be ignored.
    await run("baseline", "2026-09-01T00:00:00Z", [[1, "agent", 9999, 9999]]);
    await run("baseline", "2026-10-01T00:00:00Z", [
      [1, "agent", 100, 200],
      [2, "agent", 200, 400],
      [3, "agent", 300, 600],
      [4, "human", 50, 100],
      [5, "human", 150, 300],
      [6, "human", 7777, 7777, "excluded_author"],
    ]);
    await run("shadow", "2026-11-10T00:00:00Z", [
      [1, "agent", 60, 100],
      [2, "agent", 120, 200],
      [3, "agent", 180, 300],
      [4, "human", 60, 120],
      [5, "human", 140, 240],
    ]);
    // A repository with a baseline only (pilot B) and one with a shadow run only (a new repository
    // of pilot A) must not shift either side: they are left out and counted.
    await run(
      "baseline",
      "2026-10-01T00:00:00Z",
      [
        [1, "agent", 5000, 5000],
        [2, "human", 5000, 5000],
      ],
      PILOT_B.repo,
    );
    await sql`insert into repositories (id, installation_id, full_name, private, default_branch)
      values (2000009, ${PILOT_A.id}, 'graft-sandbox/new', true, 'main')`.execute(t.db);
    await run(
      "shadow",
      "2026-11-10T00:00:00Z",
      [
        [1, "agent", 1, 1],
        [2, "human", 1, 1],
      ],
      2000009,
    );
    const r = await gate([PILOT_A.id, PILOT_B.id]);
    expect(r.reviewTimeScope).toEqual({ pairedRepositories: 1, baselineOnly: 1, shadowOnly: 1 });
    // Unfinished PRs are counted next to the percentiles (here none are open yet).
    expect(r.reviewTime.find((g) => g.group === "all")).toMatchObject({
      baseline: { prs: 5, open: 0 },
      shadow: { prs: 5, open: 0 },
    });
    const by = Object.fromEntries(r.reviewTime.map((g) => [g.group, g]));
    expect(by.agent?.baseline.firstApproval).toMatchObject({ n: 3, p50: 200 });
    expect(by.agent?.shadow.firstApproval).toMatchObject({ n: 3, p50: 120 });
    expect(by.agent?.deltaFirstApprovalPct).toBeCloseTo(-0.4, 12);
    expect(by.agent?.deltaMergePct).toBeCloseTo((200 - 400) / 400, 12);
    expect(by.human?.baseline.firstApproval.p50).toBe(100);
    expect(by.human?.shadow.firstApproval.p50).toBe(100);
    expect(by.human?.deltaFirstApprovalPct).toBe(0);
    // all: baseline [100, 200, 300, 50, 150] p50 150; shadow [60, 120, 180, 60, 140] p50 120.
    expect(by.all?.baseline.firstApproval).toMatchObject({ n: 5, p50: 150 });
    expect(by.all?.shadow.firstApproval).toMatchObject({ n: 5, p50: 120 });
    expect(by.all?.deltaFirstApprovalPct).toBeCloseTo(-0.2, 12);
    await sql`update review_time_prs set state = 'open'
      where pr_number = 5 and run_id in (select id from review_time_runs where period = 'shadow' and repository_id = ${PILOT_A.repo})`.execute(
      t.db,
    );
    const censored = await gate([PILOT_A.id, PILOT_B.id]);
    expect(censored.reviewTime.find((g) => g.group === "all")?.shadow).toMatchObject({
      prs: 5,
      open: 1,
    });
    expect(renderGateMarkdown(censored)).toContain("all baseline 0 of 5, shadow 1 of 5");
    const md = renderGateMarkdown(r);
    expect(md).toContain("## Review time (indicative: shadow mode, Graft blocks nothing)");
    expect(md).toContain("left out: 1 with a baseline only, 1 with a shadow run only");
    expect(md).toContain("| agent | 200 → 120 min | −40% (Phase 1 target ≤ −50%) |");
  });

  it("I-GATE-5 escaped defects: incidents on PRs merged in the window and on baseline PRs give the two rates", async () => {
    await seed();
    // Culprits: PR 2 (agent, would-approve) and PR 6 (agent, would-require), both merged in the
    // window; PR 15 is still open; PR 3 of pilot B is merged but this one is on A.
    for (const culprit of [2, 6, 15]) {
      await addIncidentRow(t.db, {
        repositoryId: PILOT_A.repo,
        culprit,
        at: new Date("2026-11-20T00:00:00Z"),
      });
    }
    // The baseline: the latest run has 4 merged PRs (101 to 104) and one open; PR 101 caused an incident.
    const run = await sql<{ id: string }>`
      insert into review_time_runs (repository_id, period, from_date, to_date, base_ref, extractor_version,
        pr_count, excluded_count, aggregates, requests, extracted_at)
      values (${PILOT_A.repo}, 'baseline', '2026-08-01', '2026-10-31', 'main', 1, 5, 0, '{}'::jsonb, 1, now()) returning id`.execute(
      t.db,
    );
    const id = run.rows[0]?.id as string;
    for (const [pr, state] of [
      [101, "merged"],
      [102, "merged"],
      [103, "merged"],
      [104, "merged"],
      [105, "open"],
    ] as const) {
      await sql`insert into review_time_prs (run_id, pr_number, state, author_kind, author_kind_reason, size_bucket,
        start_basis, review_rounds, merged_without_review, paused_minutes)
        values (${id}, ${pr}, ${state}, 'human', 'none', 'S', 'opened', 0, false, 0)`.execute(t.db);
    }
    await addIncidentRow(t.db, {
      repositoryId: PILOT_A.repo,
      culprit: 101,
      at: new Date("2026-09-01T00:00:00Z"),
    });
    const e = (await gate([PILOT_A.id, PILOT_B.id])).escapedDefects;
    expect(e).toMatchObject({
      incidents: 2,
      merged: 20,
      agentIncidents: 2,
      agentMerged: 10,
      humanIncidents: 0,
      humanMerged: 10,
      onWouldApproveIncidents: 1,
      onWouldApproveMerged: 8,
      baselineIncidents: 1,
      baselineMerged: 4,
    });
    expect(e.per100).toBeCloseTo(10, 12);
    expect(e.baselinePer100).toBeCloseTo(25, 12);
    expect(renderGateMarkdown(await gate([PILOT_A.id, PILOT_B.id]))).toContain(
      "10.0 incidents per 100 merged PRs (2 of 20; baseline 25.0) | agent 2 of 10, human 0 of 10 | on would-approve PRs: 1 of 8",
    );
  });

  describe("CLI", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), "graft-gate-"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const deps = (): OpsDeps => ({
      loadConfig: () => testConfig(),
      openDb: () => testDb(),
      github: () => {
        throw new Error("no GitHub call expected");
      },
      now: () => FIXED_NOW,
      sleep: async () => {},
    });
    const run = async (...argv: string[]) => {
      let out = "";
      let err = "";
      const code = await opsMain(argv, { out: (s) => (out += s), err: (s) => (err += s) }, deps());
      return { code, out, err };
    };
    const BASE = [
      "gate",
      "report",
      "--installation",
      String(PILOT_A.id),
      "--installation",
      String(PILOT_B.id),
      "--since",
      "2026-11-01",
      "--until",
      "2026-11-29",
    ];

    it("I-GATE-6 --out writes both files with mode 0600; --check exits 0, 1 and 4", async () => {
      await seed();
      const out = path.join(dir, "reports");
      const res = await run(...BASE, "--out", out, "--check");
      expect(res.code).toBe(0);
      for (const ext of ["md", "json"]) {
        const file = path.join(out, `gate-2026-11-29.${ext}`);
        expect(statSync(file).mode & 0o777, file).toBe(0o600);
      }
      const written = JSON.parse(readFileSync(path.join(out, "gate-2026-11-29.json"), "utf8"));
      expect(gateReportSchema.safeParse(written).success).toBe(true);
      expect(written.verdict).toBe("PASS");
      expect(readFileSync(path.join(out, "gate-2026-11-29.md"), "utf8")).toContain(
        "**Verdict: PASS**",
      );
      // Rewriting an existing report keeps the mode.
      expect((await run(...BASE, "--out", out)).code).toBe(0);
      expect(statSync(path.join(out, "gate-2026-11-29.json")).mode & 0o777).toBe(0o600);

      // Without --out: markdown on stdout; with --json: JSON on stdout.
      const md = await run(...BASE);
      expect(md.out).toContain("# Graft Phase 0 gate — 2026-11-01 to 2026-11-29");
      expect(JSON.parse((await run(...BASE, "--json")).out).schemaVersion).toBe(1);

      // FAIL: no card on screen anywhere.
      await t.db.deleteFrom("intent_displays").execute();
      expect((await run(...BASE, "--check")).code).toBe(1);
      // INSUFFICIENT DATA: nobody is a reviewer.
      await t.db.deleteFrom("pr_reviewers").execute();
      expect((await run(...BASE, "--check")).code).toBe(4);
      // Without --check the exit code is 0 whatever the verdict.
      expect((await run(...BASE)).code).toBe(0);
    });

    it("usage errors exit 2 and name no value: unknown installation, bad date, bad allow-file", async () => {
      await seed();
      const unknown = await run(
        "gate",
        "report",
        "--installation",
        "424242",
        "--since",
        "2026-11-01",
        "--until",
        "2026-11-29",
      );
      expect(unknown.code).toBe(2);
      expect(
        (await run("gate", "report", "--installation", "1", "--since", "11/01/2026")).code,
      ).toBe(2);
      const file = path.join(dir, "allow.txt");
      writeFileSync(file, "good-login\nnot a login!\n");
      const bad = await run(...BASE, "--allow-file", file);
      expect(bad.code).toBe(2);
      expect(bad.err).toContain("line 2");
      expect(bad.err).not.toContain("not a login!");
      expect((await run(...BASE, "--allow-file", path.join(dir, "missing.txt"))).code).toBe(2);
      expect((await run("gate", "nope")).code).toBe(2);
      expect((await run("frobnicate")).code).toBe(2);
      void fakeSha;
    });
  });
});
