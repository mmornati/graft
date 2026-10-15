import { describe, expect, it } from "vitest";
import {
  allowedDoctorWarns,
  classifyHit,
  evaluateInv1,
  evaluateInv2,
  evaluateInv4,
  evaluateInv5,
  summarizeInv3,
} from "../../src/e2e/invariants.js";
import { commentObs, graftChecks, prComments } from "../../src/e2e/observe.js";
import type { RunCtx } from "../../src/e2e/types.js";
import { forToken } from "../../src/github/client-factory.js";
import { MANAGED_COMMENT_MARKER } from "../../src/github/managed-comment.js";
import { createFakeGitHubApi, type FakeCheckRun } from "../helpers/fake-github-api.js";
import { fakeSha } from "../helpers/github-builders.js";
import { checks } from "../helpers/live-e2e-obs.js";

const APP_ID = 12345;
const HEAD = fakeSha(7);

function ctxFor(api: ReturnType<typeof createFakeGitHubApi>): RunCtx {
  const octokit = forToken("ghp_x0123456789abcdef", { fetch: api.fetch });
  return {
    owner: "graft-sandbox",
    repo: "sample-ts",
    config: { githubAppId: APP_ID, githubAppSlug: undefined },
    actorOctokit: octokit,
  } as unknown as RunCtx;
}

const run = (id: number, name: string, over: Partial<FakeCheckRun> = {}): FakeCheckRun => ({
  id,
  name,
  head_sha: HEAD,
  status: "completed",
  conclusion: "neutral",
  external_id: "",
  output: { title: name === "graft/policy" ? "Would auto-approve" : "x", summary: "" },
  app: { id: APP_ID },
  ...over,
});

describe("INV-1: three neutral checks", () => {
  it("U-LIVE-INV-1 a success or in_progress Graft check fails; another app's failing check is ignored; 2 Graft checks fail; pagination beyond 100 check runs", async () => {
    const base = [run(1, "graft/provenance"), run(2, "graft/intent"), run(3, "graft/policy")];
    const observe = async (runs: FakeCheckRun[], pageSize: number | null = null) => {
      const api = createFakeGitHubApi({ appId: APP_ID });
      api.state.checkRuns.push(...runs);
      api.state.checkRunsPageSize = pageSize;
      return graftChecks(ctxFor(api), HEAD);
    };
    expect(evaluateInv1([{ number: 1, checks: await observe(base) }]).status).toBe("pass");

    const success = await observe([
      run(1, "graft/provenance"),
      run(2, "graft/intent"),
      run(3, "graft/policy", { conclusion: "success" }),
    ]);
    const r1 = evaluateInv1([{ number: 1, checks: success }]);
    expect(r1.status).toBe("fail");
    expect(r1.detail).toContain("graft/policy");

    const running = await observe([
      run(1, "graft/provenance"),
      run(2, "graft/intent", { status: "in_progress", conclusion: null }),
      run(3, "graft/policy"),
    ]);
    expect(evaluateInv1([{ number: 1, checks: running }]).status).toBe("fail");

    // Another App's failing check on the same head is not ours.
    const other = await observe([
      ...base,
      run(4, "ci/build", { conclusion: "failure", app: { id: 999 } }),
    ]);
    expect(other.map((c) => c.name).sort()).toEqual([
      "graft/intent",
      "graft/policy",
      "graft/provenance",
    ]);
    expect(evaluateInv1([{ number: 1, checks: other }]).status).toBe("pass");

    const two = await observe([run(1, "graft/provenance"), run(2, "graft/policy")]);
    const r2 = evaluateInv1([{ number: 1, checks: two }]);
    expect(r2.status).toBe("fail");
    expect(r2.detail).toContain("graft/intent");

    // 250 check runs of another App, ours on the last page.
    const many = Array.from({ length: 250 }, (_, i) =>
      run(100 + i, `noise/${i}`, { app: { id: 999 } }),
    );
    const paged = await observe([...many, ...base], 100);
    expect(paged.map((c) => c.name).sort()).toEqual([
      "graft/intent",
      "graft/policy",
      "graft/provenance",
    ]);
    expect(evaluateInv1([{ number: 1, checks: paged }]).status).toBe("pass");
  });
});

describe("INV-2: one Graft comment per PR", () => {
  const ours = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    body: `${MANAGED_COMMENT_MARKER}\n\n## Graft\n`,
    user: { login: "graft-dev[bot]", type: "Bot" },
    performed_via_github_app: { id: APP_ID },
    ...over,
  });
  const human = (id: number, body = "hello") => ({
    id,
    body,
    user: { login: "someone", type: "User" },
  });
  const view = (
    comments: Parameters<typeof commentObs>[0],
    slug?: string,
    knownId: number | null = null,
  ) => commentObs(comments, { appId: APP_ID, slug, knownId, owner: "graft-sandbox" });

  it("U-LIVE-INV-2 two of ours fail; a human-pasted marker is not counted; a bot-login comment counts only with the slug; a Graft comment on page 2 of 35 is found", async () => {
    const two = view([ours(1), ours(2)]);
    const bad = evaluateInv2([{ number: 1, ours: two.ours, storedId: 1 }]);
    expect(bad.status).toBe("fail");
    expect(bad.detail).toContain("2 Graft comments");

    const pasted = view([human(1, `${MANAGED_COMMENT_MARKER}\nlook what I found`), ours(2)]);
    expect(pasted.markerComments).toBe(2);
    expect(pasted.ours).toEqual([2]);
    expect(evaluateInv2([{ number: 1, ours: pasted.ours, storedId: 2 }]).status).toBe("pass");

    const botOnly = ours(3, {
      performed_via_github_app: null,
      user: { login: "graft-dev[bot]", type: "Bot" },
    });
    expect(view([botOnly]).ours).toEqual([]);
    expect(view([botOnly], "graft-dev").ours).toEqual([3]);
    expect(view([botOnly], "other-slug").ours).toEqual([]);

    expect(evaluateInv2([{ number: 1, ours: [5], storedId: 6 }]).detail).toContain(
      "changes.graft_comment_id",
    );
    expect(evaluateInv2([{ number: 1, ours: [], storedId: null }]).status).toBe("fail");

    // 35 comments, 10 per page: ours is the last one (page 4).
    const api = createFakeGitHubApi({ appId: APP_ID });
    for (let i = 1; i <= 34; i++)
      api.state.comments.push({ ...human(i), issue_number: 9 } as never);
    api.state.comments.push({ ...ours(35), issue_number: 9 } as never);
    api.state.commentsPageSize = 10;
    const all = await prComments(ctxFor(api), 9);
    expect(all).toHaveLength(35);
    const found = view(all);
    expect(found.ours).toEqual([35]);
    expect(evaluateInv2([{ number: 9, ours: found.ours, storedId: 35 }]).status).toBe("pass");
  });
});

describe("INV-3 classification", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const opts = { now, pgbossSchema: "pgboss", afterRetention: false };

  it("U-LIVE-SENT-1 model prose in intent_cards is an echo; a recent github.webhook job is accounted with its deadline, an old one fails; any other table or queue fails; details hold no sentinel or row text", () => {
    const sentinel = "ZQSNTabcdefghijklm2-T";
    const echo = classifyHit({ table: "intent_cards", key: "goal", sentinel }, opts);
    expect(echo).toMatchObject({ class: "echo", kind: "T" });
    expect(classifyHit({ table: "intent_cards", key: "head_sha", sentinel }, opts).class).toBe(
      "fail",
    );

    const recent = classifyHit(
      {
        table: "pgboss.job",
        key: "data",
        sentinel,
        job: {
          name: "github.webhook",
          state: "completed",
          completedOn: new Date("2026-10-15T11:50:00Z"),
        },
      },
      opts,
    );
    expect(recent).toMatchObject({ class: "accounted", deadline: "2026-10-15T12:50:00.000Z" });
    const old = classifyHit(
      {
        table: "pgboss.job",
        key: "data",
        sentinel,
        job: {
          name: "github.webhook",
          state: "completed",
          completedOn: new Date("2026-10-15T10:00:00Z"),
        },
      },
      opts,
    );
    expect(old.class).toBe("fail");
    const queued = classifyHit(
      {
        table: "pgboss.job",
        key: "data",
        sentinel,
        job: { name: "github.webhook", state: "created", completedOn: null },
      },
      opts,
    );
    expect(queued.class).toBe("accounted");
    // M3: another queue's job, or another table, is never accounted.
    expect(
      classifyHit(
        {
          table: "pgboss.job",
          key: "data",
          sentinel,
          job: { name: "intent.generate", state: "completed", completedOn: now },
        },
        opts,
      ).class,
    ).toBe("fail");
    expect(
      classifyHit(
        {
          table: "pgboss.archive",
          key: "data",
          sentinel,
          job: { name: "github.webhook", state: "completed", completedOn: now },
        },
        opts,
      ).class,
    ).toBe("fail");
    expect(classifyHit({ table: "policy_verdicts", key: "errors", sentinel }, opts).class).toBe(
      "fail",
    );
    // After the retention window every remaining webhook job fails.
    expect(
      classifyHit(
        {
          table: "pgboss.job",
          key: "data",
          sentinel,
          job: { name: "github.webhook", state: "completed", completedOn: now },
        },
        { ...opts, afterRetention: true },
      ).class,
    ).toBe("fail");

    const summary = summarizeInv3([echo, recent, old]);
    expect(summary.status).toBe("fail");
    expect(summary.detail).toContain("pgboss.job.data");
    expect(JSON.stringify(summary)).not.toContain(sentinel);
    expect(summarizeInv3([echo]).status).toBe("warn");
    expect(summarizeInv3([recent]).status).toBe("accounted");
    expect(summarizeInv3([]).status).toBe("pass");
    expect(summarizeInv3([], [{ file: 0, what: "secret" }]).status).toBe("fail");
  });
});

describe("INV-4 and INV-5", () => {
  const doctor = (over: Record<string, "OK" | "WARN" | "FAIL">) => ({
    code: 0,
    checks: Object.entries({
      installation: "OK",
      rollup: "OK",
      feedback: "OK",
      cards: "OK",
      ...over,
    }).map(([id, status]) => ({ id, status })),
  });

  it("U-LIVE-INV-4 the allowed WARN sets per mode; any FAIL, another WARN or a non-zero exit fails", () => {
    expect([...allowedDoctorWarns("live")].sort()).toEqual(["feedback", "rollup"]);
    expect([...allowedDoctorWarns("none")].sort()).toEqual(["cards", "feedback", "rollup"]);
    expect(evaluateInv4(doctor({ rollup: "WARN", feedback: "WARN" }), "live").status).toBe("pass");
    expect(evaluateInv4(doctor({ cards: "WARN" }), "live").status).toBe("fail");
    expect(evaluateInv4(doctor({ cards: "WARN" }), "none").status).toBe("pass");
    expect(evaluateInv4(doctor({ policy: "WARN" }), "none").status).toBe("fail");
    expect(evaluateInv4(doctor({ jobs_failed: "FAIL" }), "live").status).toBe("fail");
    expect(evaluateInv4({ code: 1, checks: doctor({}).checks }, "live").status).toBe("fail");
    expect(evaluateInv4({ code: 0, checks: null }, "live").status).toBe("fail");
  });

  it("U-LIVE-INV-5 live: every new ok card has priced token spend (a cached card needs none); none: no spend with tokens", () => {
    expect(
      evaluateInv5("live", {
        okCardsNotCached: [{ changeId: "c", spendRowsWithTokens: 1, costNull: 0 }],
        tokenRows: 1,
      }).status,
    ).toBe("pass");
    // A cached card creates no new card row, hence no entry and no requirement.
    expect(evaluateInv5("live", { okCardsNotCached: [], tokenRows: 1 }).status).toBe("pass");
    expect(
      evaluateInv5("live", {
        okCardsNotCached: [{ changeId: "c", spendRowsWithTokens: 0, costNull: 0 }],
        tokenRows: 0,
      }).status,
    ).toBe("fail");
    expect(
      evaluateInv5("live", {
        okCardsNotCached: [{ changeId: "c", spendRowsWithTokens: 1, costNull: 1 }],
        tokenRows: 1,
      }).status,
    ).toBe("fail");
    expect(evaluateInv5("none", { okCardsNotCached: [], tokenRows: 0 }).status).toBe("pass");
    expect(evaluateInv5("none", { okCardsNotCached: [], tokenRows: 2 }).status).toBe("fail");
  });
});

void checks;
