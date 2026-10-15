import { Writable } from "node:stream";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/logger.js";
import { parseManagedComment } from "../../src/github/managed-comment.js";
import type { LlmClient } from "../../src/llm/types.js";
import { upsertChangeFromPull } from "../../src/modules/changes/index.js";
import { generateIntent } from "../../src/modules/intent/job.js";
import {
  basePushPolicy,
  rerequestPolicy,
  reviewPolicy,
  schedulePolicy,
} from "../../src/modules/policy/handlers.js";
import {
  type EvaluateData,
  evaluatePolicyJobRun,
  type FanoutData,
  fanoutPolicy,
  policyEvaluateJob,
} from "../../src/modules/policy/job.js";
import { refreshProvenance } from "../../src/modules/provenance/job.js";
import { clearPolicyCache } from "../../src/policy/load.js";
import { PermanentJobError } from "../../src/queue/errors.js";
import { singletonJobId } from "../../src/queue/queue.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { FIXED_NOW } from "../helpers/config.js";
import { countJobs, truncateAll } from "../helpers/db.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import { loadFixture } from "../helpers/fixtures.js";
import {
  commitMessage,
  fakeSha,
  HEAD_SHA,
  INSTALLATION_ID,
  makeCommit,
  makeFile,
  makePull,
  makeReview,
  OWNER,
  PR_NUMBER,
  REPO,
  REPO_ID,
} from "../helpers/github-builders.js";
import {
  CANARY,
  canaryPatch,
  GENERATE_DATA,
  loadIntentScenario,
  scenarioLlm,
  writerReply,
} from "../helpers/intent-scenario.js";
import {
  B1,
  B2,
  contentRefs,
  EVAL_DATA,
  EXAMPLE_POLICY,
  jobsNamed,
  loadPolicyScenario,
  MARKER_POLICY,
  putContent,
  repoWrites,
  srcFile,
} from "../helpers/policy-scenario.js";
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

async function fresh() {
  logged = "";
  await truncateAll(t.db);
  await seedWorld(t.db);
  clearPolicyCache();
  api = createFakeGitHubApi();
  t.deps.github = fakeGitHubFactory(api);
  current = scenarioLlm();
}
beforeEach(async () => {
  await fresh();
  loadPolicyScenario(api);
});

const at = (offsetMs: number) => ({ now: () => new Date(FIXED_NOW.getTime() + offsetMs) });
const run = (over: Partial<EvaluateData> = {}, offsetMs = 0) =>
  evaluatePolicyJobRun({ ...EVAL_DATA, ...over }, { ...jobContext(t), clock: at(offsetMs) });
const verdicts = () =>
  t.db.selectFrom("policy_verdicts").selectAll().orderBy("facts_read_at").execute();
const lastCheck = () => api.state.checkRuns.filter((c) => c.name === "graft/policy").at(-1);
const policySection = (): string => {
  const body = api.state.comments[0]?.body ?? "";
  return parseManagedComment(body)?.get("policy") ?? "";
};
const event = (
  fixture: string,
  deliveryId: string,
  edit?: (p: Record<string, unknown>) => void,
) => {
  const p = structuredClone(loadFixture(fixture).payload) as Record<string, unknown>;
  edit?.(p);
  return { name: fixture.split(".")[0], deliveryId, id: deliveryId, payload: p } as never;
};
const policyChecks = () => api.state.checkRuns.filter((c) => c.name === "graft/policy");

/** Provenance (a human) and a trivial, final intent card for a docs-only PR. */
async function publishTrivialCard(opts: { agent?: string } = {}) {
  loadIntentScenario(api, { changed_files: 1, additions: 6, deletions: 2 });
  api.state.files.set(PR_NUMBER, [
    makeFile({ path: "docs/a.md", additions: 6, deletions: 2, patch: canaryPatch() }),
  ]);
  putContent(api, B1, EXAMPLE_POLICY);
  api.state.branches.set("main", B1);
  const trailers: [string, string][] = opts.agent ? [["Graft-Agent", opts.agent]] : [];
  api.state.commits.set(PR_NUMBER, [
    makeCommit(HEAD_SHA, commitMessage("Fix", undefined, trailers)),
  ]);
  await refreshProvenance({ ...provenanceData(), trigger: "opened" }, jobContext(t));
  current = scenarioLlm({ writer: writerReply({ risk_class: "trivial", out_of_scope_edits: [] }) });
  await generateIntent({ ...GENERATE_DATA }, jobContext(t));
}
const provenanceData = () => ({
  installationId: INSTALLATION_ID,
  repositoryId: REPO_ID,
  owner: OWNER,
  repo: REPO,
  prNumber: PR_NUMBER,
  headSha: HEAD_SHA,
  trigger: "opened" as const,
  deliveryId: "d-prov",
});

describe("policy engine (integration)", () => {
  it("I-POL-1 pull_request.opened enqueues policy.evaluate; the job publishes a neutral check, the section and a verdict row", async () => {
    await schedulePolicy.handle(event("pull_request.opened", "wh-1"), jobContext(t));
    const jobs = await jobsNamed(t.db, "policy.evaluate");
    expect(jobs).toHaveLength(1);
    const opened = loadFixture("pull_request.opened").payload as {
      pull_request: { head: { sha: string }; base: { ref: string }; updated_at: string };
    };
    const key = `policy:pr:${REPO_ID}:${PR_NUMBER}:${opened.pull_request.head.sha}:${opened.pull_request.base.ref}:${opened.pull_request.updated_at}:opened:${"e3b0c44298fc1c14"}`;
    expect(jobs[0]?.id).toBe(singletonJobId("policy.evaluate", key));
    expect(jobs[0]?.data).toMatchObject({ prNumber: PR_NUMBER, trigger: "pr", owner: OWNER });

    expect(await run()).toBe("published");
    const checks = policyChecks();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "graft/policy",
      status: "completed",
      conclusion: "neutral",
      head_sha: HEAD_SHA,
    });
    expect(checks[0]?.actions).toBeUndefined();
    // Facts that are not there yet make the tightening rules apply (D11).
    expect(checks[0]?.output.title).toBe(
      "Would require 2 humans (1 from @graft-sandbox/platform or @graft-sandbox/security) · risk provisional",
    );
    expect(checks[0]?.output.summary).toBe(policySection());
    expect(policySection()).toContain("### Policy");
    expect(policySection()).toContain("· report only");

    const rows = await verdicts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      head_sha: HEAD_SHA,
      base_ref: "main",
      policy_commit_sha: B1,
      policy_status: "ok",
      outcome: "would_require",
      check_conclusion: "neutral",
      mode: "report",
      risk_source: "card_pending",
      risk_final: false,
      author_kind: "unknown",
    });
    expect(rows[0]?.published_at).not.toBeNull();
    expect(rows[0]?.check_run_id).toBe(checks[0]?.id);
    expect(rows[0]?.policy_hash).toMatch(/^[0-9a-f]{64}$/);
    const change = await t.db.selectFrom("changes").selectAll().executeTakeFirstOrThrow();
    expect(change.graft_comment_id).toBe(api.state.comments[0]?.id);
  });

  it("I-POL-2 the same body under a new delivery id enqueues no new job", async () => {
    await schedulePolicy.handle(event("pull_request.opened", "wh-2a"), jobContext(t));
    await schedulePolicy.handle(event("pull_request.opened", "wh-2b"), jobContext(t));
    expect(await countJobs(t.db, "policy.evaluate")).toBe(1);
    // A different state of the PR (a new head) is a new job.
    await schedulePolicy.handle(event("pull_request.synchronize", "wh-2c"), jobContext(t));
    expect(await countJobs(t.db, "policy.evaluate")).toBe(2);
  });

  it("I-POL-3 only the base branch is read: a PR that deletes its own blocking rule is still blocked", async () => {
    const baseYaml = [
      "version: 1",
      "rules:",
      "  - name: no-agent-secrets",
      "    match: { paths: ['secrets/**'], author: agent }",
      "    block: true",
      "",
    ].join("\n");
    loadPolicyScenario(api, {
      policy: baseYaml,
      files: [
        makeFile({
          path: "graft.yaml",
          status: "modified",
          additions: 0,
          deletions: 4,
          patch: canaryPatch(),
        }),
        makeFile({
          path: "secrets/a",
          status: "added",
          additions: 2,
          deletions: 0,
          patch: canaryPatch(),
        }),
      ],
    });
    api.state.commits.set(PR_NUMBER, [
      makeCommit(HEAD_SHA, commitMessage("Fix", undefined, [["Graft-Agent", "claude-code"]])),
    ]);
    await refreshProvenance(provenanceData(), jobContext(t));

    expect(await run()).toBe("published");
    expect(lastCheck()?.output.title).toBe(
      "Would block: rule 1 · risk provisional".replace(" · risk provisional", ""),
    );
    const section = policySection();
    expect(section).toContain("> [!IMPORTANT]\n> This pull request changes `graft.yaml`.");
    expect(section).toContain("**Would block: rule 1**");
    const refs = contentRefs(api);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toBe(B1);
      expect(ref).not.toBe(HEAD_SHA);
      expect(ref).not.toMatch(/^refs\/pull/);
    }
    const row = (await verdicts())[0];
    expect(row).toMatchObject({ outcome: "would_block", policy_file_changed: true });
  });

  it("I-POL-21 an approving base policy never approves a PR that edits graft.yaml: the built-in needs 1 human", async () => {
    loadPolicyScenario(api, {
      policy: [
        "version: 1",
        "rules:",
        "  - name: approve-everything",
        "    match: { only_paths: ['**'] }",
        "    approve: auto",
        "",
      ].join("\n"),
      files: [
        makeFile({
          path: "graft.yaml",
          status: "modified",
          additions: 3,
          deletions: 1,
          patch: canaryPatch(),
        }),
      ],
    });
    api.state.commits.set(PR_NUMBER, [makeCommit(HEAD_SHA, commitMessage("Fix", undefined, []))]);
    await refreshProvenance(provenanceData(), jobContext(t));

    expect(await run()).toBe("published");
    expect(lastCheck()?.output.title).toMatch(/^Would require 1 human/);
    expect(policySection()).toContain("> [!IMPORTANT]\n> This pull request changes `graft.yaml`.");
    const [row] = await verdicts();
    expect(row).toMatchObject({ outcome: "would_require", policy_file_changed: true });
    expect(row?.required).toMatchObject({ builtIn: "policy_file_changed", humans: 1 });
  });

  it("I-POL-4 a missing graft.yaml is no_policy: 'No graft.yaml on main', neutral", async () => {
    loadPolicyScenario(api, { policy: null });
    expect(await run()).toBe("published");
    expect(lastCheck()).toMatchObject({ conclusion: "neutral" });
    expect(lastCheck()?.output.title).toBe("No graft.yaml on main");
    expect(policySection()).toContain("**No policy** · report only");
    const [row] = await verdicts();
    expect(row).toMatchObject({
      outcome: "no_policy",
      policy_status: "missing",
      policy_file_sha: null,
      policy_hash: null,
      check_conclusion: "neutral",
    });
  });

  it("I-POL-5 an alias bomb, a symlink, a directory and a 40 KB file are policy_invalid, never approving, neutral", async () => {
    const { readFileSync } = await import("node:fs");
    const bomb = readFileSync(
      new URL("../fixtures/policy/alias-bomb.yaml", import.meta.url),
      "utf8",
    );
    const cases: [string, Parameters<typeof putContent>[2], string][] = [
      ["alias bomb", bomb, "yaml_alias"],
      ["symlink", { kind: "symlink", target: "docs/real.yaml" }, "file_not_regular"],
      ["directory", { kind: "dir" }, "file_not_regular"],
      ["40 KB", `version: 1\n# ${"x".repeat(40_000)}\n`, "file_too_large"],
    ];
    for (const [label, entry, code] of cases) {
      clearPolicyCache();
      putContent(api, B1, entry);
      expect(await run(), label).toBe("published");
      const check = lastCheck();
      expect(check?.conclusion, label).toBe("neutral");
      expect(check?.output.title, label).toMatch(/^Policy invalid: no decision \(\d+ errors?\)$/);
      expect(check?.output.title, label).not.toContain("auto-approve");
      const row = (await verdicts()).at(-1);
      expect(row?.outcome, label).toBe("policy_invalid");
      expect(row?.policy_status, label).toBe("invalid");
      expect(row?.policy_hash, label).toBeNull();
      expect(JSON.stringify(row?.errors), label).toContain(code);
      expect(policySection(), label).toContain(
        "cannot be used, so Graft would not auto-approve anything",
      );
    }
    expect((await verdicts()).filter((r) => r.outcome === "would_approve")).toEqual([]);
  });

  it("I-POL-6 when the base branch moves, the next evaluation reads the new tip", async () => {
    expect(await run()).toBe("published");
    expect(new Set(contentRefs(api))).toEqual(new Set([B1]));
    putContent(api, B2, "version: 1\ndefault:\n  require: { humans: 3 }\n");
    api.state.branches.set("main", B2);
    expect(await run(undefined, 60_000)).toBe("published");
    expect(contentRefs(api).at(-1)).toBe(B2);
    expect(lastCheck()?.output.title).toBe("Would require 3 humans (default) · risk provisional");
    const rows = await verdicts();
    expect(rows.map((r) => r.policy_commit_sha)).toEqual([B1, B2]);
    // The pull request still reports the old base.sha; it is not what is read.
    const pull = api.state.pulls.get(PR_NUMBER);
    expect(pull?.base.sha).toBe(B1);
  });

  it("I-POL-7 a pending card makes the risk provisional; the published card re-evaluates through the signal", async () => {
    await publishTrivialCard();
    // The card is on screen already: delete the display to model "pending", then re-publish.
    const cardRows = await t.db.selectFrom("intent_cards").selectAll().execute();
    expect(cardRows).toHaveLength(1);
    expect(cardRows[0]?.risk_class).toBe("trivial");
    const displays = await t.db.selectFrom("intent_displays").selectAll().execute();
    await t.db.deleteFrom("intent_displays").execute();
    await t.db
      .deleteFrom("pgboss.job" as never)
      .where("name" as never, "=", "policy.evaluate" as never)
      .execute();
    expect(await run()).toBe("published");
    expect(lastCheck()?.output.title).toBe("Would require 1 human (default) · risk provisional");
    expect(policySection()).toContain("[!NOTE]");
    expect(lastCheck()?.output.text).toContain(
      "- Risk `logic` from rules; card pending (provisional)",
    );

    // The card appears (the display is back) and the intent job's signal enqueues the re-run.
    await t.db
      .insertInto("intent_displays")
      .values(displays.map(({ seq: _s, id: _i, ...d }) => d))
      .execute();
    await t.db.deleteFrom("intent_cards").execute();
    await t.db.deleteFrom("intent_displays").execute();
    await generateIntent({ ...GENERATE_DATA }, jobContext(t));
    const signals = (await jobsNamed(t.db, "policy.evaluate")).filter((j) =>
      (j.singleton_key ?? "").includes("intent_published"),
    );
    expect(signals.length).toBeGreaterThanOrEqual(1);
    const sig = signals.at(-1);
    expect(sig?.data).toMatchObject({ trigger: "intent", prNumber: PR_NUMBER });
    expect(
      await evaluatePolicyJobRun(sig?.data as EvaluateData, {
        ...jobContext(t),
        clock: at(120_000),
      }),
    ).toBe("published");
    expect(lastCheck()?.output.title).toBe("Would auto-approve");
    expect(policySection()).not.toContain("[!NOTE]");
    expect(policySection()).toContain("risk `trivial` (card)");
    expect((await verdicts()).at(-1)).toMatchObject({
      outcome: "would_approve",
      risk_final: true,
      risk_source: "card",
      author_kind: "human",
    });
  });

  it("I-POL-8 pending provenance leaves the author unknown; the provenance signal makes it known", async () => {
    const yaml = [
      "version: 1",
      "rules:",
      "  - name: agents",
      "    match: { author: agent }",
      "    require: { humans: 2 }",
      "",
    ].join("\n");
    loadPolicyScenario(api, { policy: yaml });
    expect(await run()).toBe("published");
    expect(policySection()).toContain("author unknown (unknown: provenance pending)");
    expect(lastCheck()?.output.title).toBe("Would require 2 humans · risk provisional");
    expect((await verdicts())[0]?.author_kind).toBe("unknown");

    api.state.commits.set(PR_NUMBER, [makeCommit(HEAD_SHA, commitMessage("Fix"))]);
    await refreshProvenance(provenanceData(), jobContext(t));
    const sig = (await jobsNamed(t.db, "policy.evaluate")).find((j) =>
      (j.singleton_key ?? "").includes("provenance_published"),
    );
    expect(sig?.data).toMatchObject({ trigger: "provenance" });
    expect(
      await evaluatePolicyJobRun(sig?.data as EvaluateData, {
        ...jobContext(t),
        clock: at(60_000),
      }),
    ).toBe("published");
    expect(policySection()).not.toContain("provenance pending");
    expect(policySection()).toContain("No rule matched; the default applies.");
    expect((await verdicts()).at(-1)?.author_kind).toBe("human");
  });

  it("I-POL-9 a review shows in the approvals line; a dismissal takes it back", async () => {
    await schedulePolicy.handle(event("pull_request.opened", "wh-9a"), jobContext(t));
    expect(await run()).toBe("published");
    expect(policySection()).toContain("**Approvals so far:** 0 on this head.");

    api.state.reviews.set(PR_NUMBER, [makeReview({ id: 1, login: "alice" })]);
    await reviewPolicy.handle(event("pull_request_review.submitted", "wh-9b"), jobContext(t));
    const job = (await jobsNamed(t.db, "policy.evaluate")).find((j) =>
      (j.singleton_key ?? "").startsWith("policy:review:"),
    );
    expect(job?.data).toMatchObject({ trigger: "review" });
    expect(await run({ trigger: "review" }, 30_000)).toBe("published");
    expect(policySection()).toContain("**Approvals so far:** 1 on this head (`alice`).");

    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 1, login: "alice", userId: 77, submittedAt: "2026-10-14T11:01:00Z" }),
      makeReview({
        id: 2,
        login: "alice",
        userId: 77,
        state: "DISMISSED",
        submittedAt: "2026-10-14T11:09:00Z",
      }),
    ]);
    expect(await run({ trigger: "review" }, 60_000)).toBe("published");
    expect(policySection()).toContain("**Approvals so far:** 0 on this head.");
    // An approval on an older commit is counted apart; the count never changes the outcome.
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 3, login: "bob", commitId: fakeSha(0x0d) }),
    ]);
    expect(await run({ trigger: "review" }, 90_000)).toBe("published");
    expect(policySection()).toContain("0 on this head, 1 on an older commit.");
    expect(lastCheck()?.conclusion).toBe("neutral");
  });

  it("I-POL-10 a hotfix label adds a requirement that overrides an approving rule", async () => {
    await publishTrivialCard();
    api.state.pulls.set(
      PR_NUMBER,
      makePull({ ...api.state.pulls.get(PR_NUMBER), labels: [{ name: "hotfix" }] }),
    );
    expect(await run()).toBe("published");
    expect(lastCheck()?.output.title).toBe("Would require 1 human from @graft-sandbox/oncall");
    const section = policySection();
    expect(section).toContain("- Rule 2 trivial: risk `trivial` (card) (overridden)");
    expect(section).toContain("- Rule 8 hotfix: label `hotfix`");
    // Without the label the same PR is auto-approved.
    clearPolicyCache();
    api.state.pulls.set(PR_NUMBER, makePull({ ...api.state.pulls.get(PR_NUMBER), labels: [] }));
    expect(await run({}, 60_000)).toBe("published");
    expect(lastCheck()?.output.title).toBe("Would auto-approve");
  });

  async function movingHead(clearUpdatedAt: boolean) {
    const blocker = api.block("GET", /\/pulls\/\d+\/reviews$/);
    const job = run();
    await blocker.reached;
    // The PR moves while the job is reading facts.
    const headB = fakeSha(0xb);
    await upsertChangeFromPull(
      t.db,
      REPO_ID,
      makePull({ head: { sha: headB }, updated_at: "2026-10-14T12:30:00Z" }) as never,
      new Date(),
    );
    if (clearUpdatedAt) await t.db.updateTable("changes").set({ pr_updated_at: null }).execute();
    blocker.release();
    return job;
  }

  it("I-POL-11 the head moves between the fact read and the lock: nothing is published", async () => {
    expect(await movingHead(false)).toBe("stale");
    expect(repoWrites(api)).toEqual([]);
    expect(await verdicts()).toEqual([]);
  });

  it("I-POL-11 only the in-lock head check can stop the publish when the snapshot time is cleared", async () => {
    expect(await movingHead(true)).toBe("stale");
    expect(repoWrites(api)).toEqual([]);
    expect(await verdicts()).toEqual([]);
  });

  it("I-POL-12 older facts never overwrite newer ones", async () => {
    api.state.reviews.set(PR_NUMBER, [makeReview({ id: 1, login: "alice" })]);
    expect(await run({ trigger: "review" }, 60_000)).toBe("published"); // job B reads at t2
    const stored = (await verdicts())[0];
    expect(stored?.approvals).toMatchObject({ current: 1 });
    const writesBefore = repoWrites(api).length;

    // Job A read at t1 < t2, and saw no review; it reaches the lock after B published.
    api.state.reviews.set(PR_NUMBER, []);
    expect(await run({ trigger: "pr" }, 0)).toBe("stale");
    expect(repoWrites(api)).toHaveLength(writesBefore);
    const after = await verdicts();
    expect(after).toHaveLength(1);
    expect(after[0]?.approvals).toMatchObject({ current: 1 });
    expect(after[0]?.facts_read_at.getTime()).toBe(FIXED_NOW.getTime() + 60_000);
    expect(policySection()).toContain("1 on this head (`alice`)");
  });

  it("I-POL-13 the same facts twice make no check-run or comment request", async () => {
    expect(await run()).toBe("published");
    const writes = repoWrites(api).length;
    expect(writes).toBeGreaterThan(0);
    const before = (await verdicts())[0];
    expect(await run({}, 30_000)).toBe("unchanged");
    expect(repoWrites(api)).toHaveLength(writes);
    const after = await verdicts();
    expect(after).toHaveLength(1);
    // The row keeps the latest read time so an older job cannot overtake it.
    expect(after[0]?.facts_read_at.getTime()).toBe(FIXED_NOW.getTime() + 30_000);
    expect(after[0]?.published_at?.getTime()).toBe(before?.published_at?.getTime());
    expect(policyChecks()).toHaveLength(1);
    expect(api.state.comments).toHaveLength(1);
  });

  it("I-POL-14 a rerequested graft/policy check re-runs once per minute", async () => {
    const rerequest = (delivery: string, offsetMs: number) =>
      rerequestPolicy.handle(
        event("check_run.rerequested", delivery, (p) => {
          (p.check_run as Record<string, unknown>).name = "graft/policy";
        }),
        { ...jobContext(t), clock: at(offsetMs) },
      );
    await rerequest("rr-1", 0);
    await rerequest("rr-2", 20_000);
    expect(await countJobs(t.db, "policy.evaluate")).toBe(1);
    await rerequest("rr-3", 70_000);
    expect(await countJobs(t.db, "policy.evaluate")).toBe(2);
    const jobs = await jobsNamed(t.db, "policy.evaluate");
    expect(jobs.every((j) => (j.singleton_key ?? "").startsWith("policy-rerun:"))).toBe(true);
    expect(jobs[0]?.data).toMatchObject({ trigger: "rerequested", prNumber: PR_NUMBER });
  });

  it("I-POL-15 a closed PR is not evaluated: no publish, no row", async () => {
    api.state.pulls.set(
      PR_NUMBER,
      makePull({
        ...api.state.pulls.get(PR_NUMBER),
        state: "closed",
        closed_at: "2026-10-14T11:30:00Z",
        updated_at: "2026-10-14T11:30:00Z",
      }),
    );
    expect(await run()).toBe("closed");
    expect(repoWrites(api)).toEqual([]);
    expect(await verdicts()).toEqual([]);
    expect(contentRefs(api)).toEqual([]);
  });

  it("I-POL-16 every check run body is neutral, whatever the outcome", async () => {
    const scenarios: [string, () => Promise<void>][] = [
      ["would_approve", async () => publishTrivialCard()],
      [
        "would_require",
        async () =>
          loadPolicyScenario(api, {
            files: [makeFile({ path: "infra/main.tf", patch: canaryPatch() })],
          }),
      ],
      [
        "would_block",
        async () => {
          loadPolicyScenario(api, {
            files: [makeFile({ path: "secrets/a", patch: canaryPatch() })],
          });
          api.state.commits.set(PR_NUMBER, [
            makeCommit(HEAD_SHA, commitMessage("Fix", undefined, [["Graft-Agent", "claude-code"]])),
          ]);
          await refreshProvenance(provenanceData(), jobContext(t));
        },
      ],
      [
        "policy_invalid",
        async () => loadPolicyScenario(api, { policy: "version: 1\nrules: nope\n" }),
      ],
      ["no_policy", async () => loadPolicyScenario(api, { policy: null })],
    ];
    const expectedTitle: Record<string, RegExp> = {
      would_approve: /^Would auto-approve$/,
      would_require: /^Would require/,
      would_block: /^Would block: rule 5/,
      policy_invalid: /^Policy invalid/,
      no_policy: /^No graft\.yaml/,
    };
    for (const [outcome, setup] of scenarios) {
      await fresh();
      loadPolicyScenario(api);
      await setup();
      expect(await run(), outcome).toBe("published");
      const writes = api.requests.filter((r) => r.method !== "GET" && /\/check-runs/.test(r.path));
      expect(writes.length, outcome).toBeGreaterThan(0);
      for (const w of writes) {
        if ((w.body as { name?: string }).name === "graft/intent") continue;
        expect(w.body?.conclusion, outcome).toBe("neutral");
      }
      const check = lastCheck();
      expect(check?.conclusion, outcome).toBe("neutral");
      expect(check?.output.title, outcome).toMatch(expectedTitle[outcome] as RegExp);
      expect((await verdicts()).at(-1)?.check_conclusion, outcome).toBe("neutral");
    }
  });

  it("I-POL-17 nothing from the file is stored: no rule name, glob, team slug or YAML line in a row, a job or a log", async () => {
    const markers = [
      "marker-rule-zq",
      "marker-glob-zq",
      "marker-team-zq",
      "marker-sens-zq",
      "marker-default-team-zq",
      "marker-badkey-zq",
      "version: 1",
      "require: {",
    ];
    loadPolicyScenario(api, {
      policy: MARKER_POLICY,
      files: [makeFile({ path: "infra/main.tf", patch: canaryPatch() })],
    });
    await schedulePolicy.handle(event("pull_request.opened", "wh-17"), jobContext(t));
    expect(await run()).toBe("published");
    expect(lastCheck()?.output.title).toContain("@graft-sandbox/marker-team-zq");
    // Then an invalid file with a recognisable key.
    clearPolicyCache();
    putContent(
      api,
      B1,
      "version: 1\nmarker-badkey-zq: 1\nrules:\n  - name: marker-rule-zq\n    aprove: x\n",
    );
    expect(await run({}, 30_000)).toBe("published");
    expect(lastCheck()?.output.title).toMatch(/^Policy invalid/);

    const dump = {
      rows: JSON.stringify(
        (
          await sql<
            Record<string, unknown>
          >`select to_jsonb(p) as row from policy_verdicts p`.execute(t.db)
        ).rows,
      ),
      jobs: JSON.stringify(
        (
          await sql`select name, data, singleton_key from pgboss.job where name like 'policy.%'`.execute(
            t.db,
          )
        ).rows,
      ),
      log: logged,
    };
    expect(dump.rows.length).toBeGreaterThan(100);
    for (const [where, text] of Object.entries(dump)) {
      for (const m of markers) expect(text, `${where}: ${m}`).not.toContain(m);
    }
    // What is stored: indices, codes, PR paths and counts.
    const [first] = await verdicts();
    expect(first?.rules_matched).toEqual([
      {
        index: 1,
        action: "require",
        overridden: false,
        reasons: [{ key: "paths", uncertain: false, paths: ["infra/main.tf"], count: 1 }],
      },
    ]);
    expect(first?.required).toEqual({
      humans: 1,
      constraints: [{ humans: 1, teamCount: 1, rules: [1] }],
      usedDefault: false,
      builtIn: null,
    });
    const invalid = (await verdicts()).at(-1);
    expect(invalid?.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unknown_key", location: "rules[1]" }),
      ]),
    );
    for (const e of (invalid?.errors ?? []) as Record<string, unknown>[]) {
      expect("key" in e).toBe(false);
    }
  });

  it("I-POL-18 the other sections of the comment are byte-identical; teams in the policy section are code spans", async () => {
    await publishTrivialCard();
    const before = parseManagedComment(api.state.comments[0]?.body ?? "");
    expect(before?.has("intent")).toBe(true);
    expect(before?.has("provenance")).toBe(true);
    expect(before?.has("policy")).toBe(false);
    api.state.pulls.set(
      PR_NUMBER,
      makePull({ ...api.state.pulls.get(PR_NUMBER), labels: [{ name: "hotfix" }] }),
    );
    expect(await run()).toBe("published");
    const after = parseManagedComment(api.state.comments[0]?.body ?? "");
    expect(api.state.comments).toHaveLength(1);
    expect(after?.get("intent")).toBe(before?.get("intent"));
    expect(after?.get("provenance")).toBe(before?.get("provenance"));
    const policy = after?.get("policy") ?? "";
    expect(policy).toContain("`@graft-sandbox/oncall`");
    expect(policy.replace(/`[^`]*`/g, "")).not.toContain("@");
    // The policy section sits after the others.
    const body = api.state.comments[0]?.body ?? "";
    expect(body.indexOf("section:policy:start")).toBeGreaterThan(
      body.indexOf("section:provenance:start"),
    );
  });

  it("I-POL-19 a transient 502 retries and publishes nothing; a missing base branch is permanent", async () => {
    api.failNext("GET", /\/contents\//, 502);
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    expect(repoWrites(api)).toEqual([]);
    expect(await verdicts()).toEqual([]);
    // The job definition retries transient errors (the worker rethrows them to pg-boss).
    expect(policyEvaluateJob.options).toMatchObject({ retryLimit: 5, retryBackoff: true });
    // The retry succeeds: nothing was cached and nothing half-written.
    expect(await run({}, 30_000)).toBe("published");

    api.state.branches.delete("main");
    clearPolicyCache();
    const gone = await run({}, 60_000).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(PermanentJobError);
    expect((gone as PermanentJobError).reason).toBe("base_missing");
    // A 5xx while publishing rolls back, so the retry does not find a half-written row.
    api.state.branches.set("main", B1);
    await t.db.deleteFrom("policy_verdicts").execute();
    api.state.checkRuns.length = 0;
    api.failNext("POST", /\/check-runs$/, 502);
    const publishErr = await run({}, 90_000).catch((e: unknown) => e);
    expect(publishErr).toBeInstanceOf(Error);
    expect(await verdicts()).toEqual([]);
    expect(await run({}, 120_000)).toBe("published");
  });

  it("I-POL-20 a PR that adds graft.yaml where the base has none gets the 'adds' note", async () => {
    loadPolicyScenario(api, {
      policy: null,
      files: [
        makeFile({
          path: "graft.yaml",
          status: "added",
          additions: 9,
          deletions: 0,
          patch: canaryPatch(),
        }),
      ],
    });
    expect(await run()).toBe("published");
    expect(lastCheck()?.output.title).toBe("No graft.yaml on main");
    expect(policySection()).toContain(
      "> [!IMPORTANT]\n> This pull request adds `graft.yaml`. It takes effect after merge; until then there is no policy.",
    );
    expect((await verdicts())[0]).toMatchObject({
      outcome: "no_policy",
      policy_file_changed: true,
    });
    // Without that file there is no note.
    loadPolicyScenario(api, { policy: null });
    expect(await run({}, 30_000)).toBe("published");
    expect(policySection()).not.toContain("adds `graft.yaml`");
  });
});

// The recorded push targets the fixture PR's base (`master`); this suite's world uses `main`.
const pushEvent = (delivery: string, edit?: (p: Record<string, unknown>) => void) =>
  event("push", delivery, (p) => {
    p.ref = "refs/heads/main";
    edit?.(p);
  });
const evaluateJobs = () => jobsNamed(t.db, "policy.evaluate");

async function addOpenChange(
  prNumber: number,
  o: { baseRef?: string; state?: "open" | "closed"; updatedAt?: Date } = {},
) {
  await t.db
    .insertInto("changes")
    .values({
      repository_id: REPO_ID,
      pr_number: prNumber,
      pr_node_id: `PR_${prNumber}`,
      task_id: null,
      head_sha: fakeSha(prNumber),
      base_ref: o.baseRef ?? "main",
      author_login: "graft-dev",
      state: o.state ?? "open",
      merge_commit_sha: null,
      opened_at: new Date("2026-10-01T00:00:00Z"),
      closed_at: null,
      merged_at: null,
      pr_updated_at: o.updatedAt ?? new Date("2026-10-10T00:00:00Z"),
      graft_comment_id: null,
    })
    .execute();
}

describe("policy fan-out", () => {
  const AFTER = "a".repeat(40);

  it("I-POLF-1 a push that modifies graft.yaml re-evaluates the open PRs of that branch only", async () => {
    await addOpenChange(2);
    await addOpenChange(3, { state: "closed" });
    await addOpenChange(4, { baseRef: "develop" });
    await addOpenChange(5);
    await basePushPolicy.handle(pushEvent("push-1"), jobContext(t));
    const fanouts = await jobsNamed(t.db, "policy.fanout");
    expect(fanouts).toHaveLength(1);
    expect(fanouts[0]?.singleton_key).toBe(`policy-push:${REPO_ID}:refs/heads/main:${AFTER}`);
    expect(fanouts[0]?.data).toMatchObject({
      branch: "main",
      afterSha: AFTER,
      repositoryId: REPO_ID,
    });

    expect(await fanoutPolicy(fanouts[0]?.data as FanoutData, jobContext(t))).toBe(2);
    const jobs = await evaluateJobs();
    expect(jobs.map((j) => j.singleton_key).sort()).toEqual([
      `policy:base:${REPO_ID}:2:${AFTER}`,
      `policy:base:${REPO_ID}:5:${AFTER}`,
    ]);
    expect(jobs.every((j) => (j.data as { trigger: string }).trigger === "base_push")).toBe(true);
    expect(jobs.map((j) => (j.data as { prNumber: number }).prNumber).sort()).toEqual([2, 5]);
    // Running the fan-out again for the same push adds nothing.
    await fanoutPolicy(fanouts[0]?.data as FanoutData, jobContext(t));
    expect(await evaluateJobs()).toHaveLength(2);
  });

  it("I-POLF-2 a push that does not touch graft.yaml does nothing; a replay is deduplicated", async () => {
    await basePushPolicy.handle(
      pushEvent("push-2a", (p) => {
        (p.commits as Record<string, unknown>[])[0] = {
          ...(p.commits as Record<string, unknown>[])[0],
          modified: ["src/a.ts"],
        };
        (p.head_commit as Record<string, unknown>).modified = ["src/a.ts"];
      }),
      jobContext(t),
    );
    expect(await countJobs(t.db, "policy.fanout")).toBe(0);
    await basePushPolicy.handle(pushEvent("push-2b"), jobContext(t));
    await basePushPolicy.handle(pushEvent("push-2c"), jobContext(t));
    expect(await countJobs(t.db, "policy.fanout")).toBe(1);
  });

  it("I-POLF-3 101 open PRs give 100 evaluate jobs, newest first, staggered by 5 seconds per 10", async () => {
    for (let i = 1; i <= 101; i++) {
      // PR 1 is the oldest.
      await addOpenChange(i, { updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) });
    }
    const data: FanoutData = {
      installationId: INSTALLATION_ID,
      repositoryId: REPO_ID,
      owner: OWNER,
      repo: REPO,
      branch: "main",
      afterSha: AFTER,
      deliveryId: "d-fan",
    };
    expect(await fanoutPolicy(data, jobContext(t))).toBe(100);
    expect(logged).toContain("fanout_truncated");
    const jobs = await evaluateJobs();
    expect(jobs).toHaveLength(100);
    const prs = jobs.map((j) => (j.data as { prNumber: number }).prNumber);
    expect(prs).not.toContain(1);
    expect(prs).toContain(101);
    const offsets = new Map<number, number>();
    for (const j of jobs) {
      const delay = Math.round((j.start_after.getTime() - j.created_on.getTime()) / 5_000) * 5;
      offsets.set((j.data as { prNumber: number }).prNumber, delay);
    }
    // The newest ten start at once; the next ten five seconds later; the oldest ten at 45 s.
    for (const pr of [101, 100, 92]) expect(offsets.get(pr), `PR ${pr}`).toBeLessThanOrEqual(0);
    expect(offsets.get(91)).toBe(5);
    expect(offsets.get(2)).toBe(45);
    expect(new Set(offsets.values()).size).toBe(10);
  });

  it("I-POLF-4 a removed repository or an inactive installation enqueues nothing", async () => {
    await addOpenChange(2);
    const data: FanoutData = {
      installationId: INSTALLATION_ID,
      repositoryId: REPO_ID,
      owner: OWNER,
      repo: REPO,
      branch: "main",
      afterSha: AFTER,
      deliveryId: "d-fan",
    };
    await t.db.updateTable("repositories").set({ removed_at: new Date() }).execute();
    expect(await fanoutPolicy(data, jobContext(t))).toBe(0);
    await t.db.updateTable("repositories").set({ removed_at: null }).execute();
    await t.db.updateTable("installations").set({ suspended_at: new Date() }).execute();
    expect(await fanoutPolicy(data, jobContext(t))).toBe(0);
    expect(await evaluateJobs()).toEqual([]);
    // The handler does not even enqueue the fan-out for an inactive installation.
    await basePushPolicy.handle(pushEvent("push-4"), jobContext(t));
    expect(await countJobs(t.db, "policy.fanout")).toBe(0);
  });

  it("I-POLF-5 end to end: a new base policy flips a verdict from would_approve to would_require", async () => {
    await publishTrivialCard();
    expect(await run()).toBe("published");
    expect(lastCheck()?.output.title).toBe("Would auto-approve");

    // main moves: the new graft.yaml adds a rule that requires a security review of everything.
    putContent(
      api,
      B2,
      `${EXAMPLE_POLICY}\n  - name: everything\n    match: { risk: trivial }\n    require: { humans: 1, team: security }\n`,
    );
    api.state.branches.set("main", B2);
    await basePushPolicy.handle(
      pushEvent("push-5", (p) => {
        p.after = B2;
      }),
      jobContext(t),
    );
    const fan = (await jobsNamed(t.db, "policy.fanout"))[0];
    expect(fan?.data).toMatchObject({ afterSha: B2 });
    expect(await fanoutPolicy(fan?.data as FanoutData, jobContext(t))).toBe(1);
    const job = (await evaluateJobs()).find((j) =>
      (j.singleton_key ?? "").startsWith("policy:base:"),
    );
    expect(job?.singleton_key).toBe(`policy:base:${REPO_ID}:${PR_NUMBER}:${B2}`);
    expect(
      await evaluatePolicyJobRun(job?.data as EvaluateData, {
        ...jobContext(t),
        clock: at(60_000),
      }),
    ).toBe("published");
    expect(lastCheck()?.output.title).toBe("Would require 1 human from @graft-sandbox/security");
    expect(policySection()).toContain("- Rule 2 trivial: risk `trivial` (card) (overridden)");
    expect((await verdicts()).map((r) => r.outcome)).toEqual(["would_approve", "would_require"]);
    expect(policyChecks()).toHaveLength(1); // the same check run, updated
    void CANARY;
    void srcFile;
  });
});

describe("intent hook (graft.yaml sensitive_paths)", () => {
  const SENSITIVE = "version: 1\nsensitive_paths:\n  - services/billing/**\n";
  const runIntent = (over: Record<string, unknown> = {}, ctxOver: Record<string, unknown> = {}) =>
    generateIntent({ ...GENERATE_DATA, ...over }, { ...jobContext(t), ...ctxOver });
  const card = () => t.db.selectFrom("intent_cards").selectAll().executeTakeFirstOrThrow();
  const floorRules = async () =>
    ((await card()).floor_reasons as { rule: string }[]).map((r) => r.rule);
  const billingFiles = () => {
    loadIntentScenario(api, { changed_files: 1, additions: 6, deletions: 2 });
    api.state.files.set(PR_NUMBER, [
      makeFile({ path: "services/billing/a.ts", additions: 6, deletions: 2, patch: canaryPatch() }),
    ]);
  };

  it("I-POLH-1 sensitive_paths from the base graft.yaml raise the intent floor", async () => {
    billingFiles();
    putContent(api, B1, SENSITIVE);
    expect(await runIntent()).toBe("published");
    const c = await card();
    expect(c.risk_floor).toBe("sensitive");
    expect(await floorRules()).toContain("configured_path");
  });

  it("I-POLH-2 the head's graft.yaml is ignored: contents are requested only at pull.base.sha", async () => {
    billingFiles();
    api.state.files.set(PR_NUMBER, [
      makeFile({ path: "src/retry.ts", additions: 6, deletions: 2, patch: canaryPatch() }),
    ]);
    putContent(api, B1, "version: 1\n");
    putContent(api, HEAD_SHA, "version: 1\nsensitive_paths:\n  - src/**\n");
    putContent(api, `refs/pull/${PR_NUMBER}/head`, "version: 1\nsensitive_paths:\n  - src/**\n");
    expect(await runIntent()).toBe("published");
    expect(new Set(contentRefs(api))).toEqual(new Set([B1]));
    expect(await floorRules()).not.toContain("configured_path");
    expect((await card()).risk_floor).toBe("trivial");
  });

  it("I-POLH-3 an invalid or missing base graft.yaml leaves the configured globs only; the card is generated", async () => {
    api.state.files.set(PR_NUMBER, [
      makeFile({ path: "cfg/a.ts", additions: 6, deletions: 2, patch: canaryPatch() }),
      makeFile({ path: "services/billing/a.ts", additions: 6, deletions: 2, patch: canaryPatch() }),
    ]);
    loadIntentScenario(api, { changed_files: 2, additions: 12, deletions: 4 });
    api.state.files.set(PR_NUMBER, [
      makeFile({ path: "cfg/a.ts", additions: 6, deletions: 2, patch: canaryPatch() }),
      makeFile({ path: "services/billing/a.ts", additions: 6, deletions: 2, patch: canaryPatch() }),
    ]);
    const ctxWithConfig = {
      config: { ...jobContext(t).config, intentSensitivePaths: ["cfg/**"] },
    };
    for (const entry of [
      null,
      "version: 1\nsensitive_paths: [not a list\n",
      "version: 1\nsensitive_paths: ['!bad']\n",
    ]) {
      clearPolicyCache();
      await t.db.deleteFrom("intent_cards").execute();
      putContent(api, B1, entry);
      expect(await runIntent({}, ctxWithConfig)).toBe("published");
      const c = await card();
      expect(c.status).toBe("ok");
      const reasons = c.floor_reasons as { rule: string; paths: string[] }[];
      const configured = reasons.find((r) => r.rule === "configured_path");
      expect(configured?.paths).toEqual(["cfg/a.ts"]);
    }
    // A valid base file adds its globs to the configured ones.
    clearPolicyCache();
    await t.db.deleteFrom("intent_cards").execute();
    putContent(api, B1, SENSITIVE);
    expect(await runIntent({}, ctxWithConfig)).toBe("published");
    const merged = ((await card()).floor_reasons as { rule: string; paths: string[] }[]).find(
      (r) => r.rule === "configured_path",
    );
    expect(merged?.paths).toEqual(["cfg/a.ts", "services/billing/a.ts"]);
  });

  it("I-POLH-4 the intent hook and the policy job share one contents request for the same base commit", async () => {
    loadIntentScenario(api);
    putContent(api, B1, EXAMPLE_POLICY);
    api.state.branches.set("main", B1);
    expect(await runIntent()).toBe("published");
    expect(contentRefs(api)).toEqual([B1]);
    expect(await run({}, 30_000)).toBe("published");
    expect(contentRefs(api)).toEqual([B1]);
  });

  it("I-POLH-5 a 502 reading graft.yaml in the hook retries the intent job: no card, no spend", async () => {
    loadIntentScenario(api);
    putContent(api, B1, SENSITIVE);
    api.failNext("GET", /\/contents\//, 502);
    const err = await runIntent().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    expect(await t.db.selectFrom("intent_cards").selectAll().execute()).toEqual([]);
    expect(await t.db.selectFrom("intent_spend").selectAll().execute()).toEqual([]);
    expect(current.calls).toHaveLength(0);
    expect(repoWrites(api)).toEqual([]);
  });

  it("I-POLH-6 without pull.base.sha the hook asks for the branch tip and reads graft.yaml there", async () => {
    billingFiles();
    const pull = api.state.pulls.get(PR_NUMBER);
    if (!pull) throw new Error("no pull");
    api.state.pulls.set(PR_NUMBER, {
      ...pull,
      base: { ref: pull.base.ref, repo: pull.base.repo },
    });
    api.state.branches.set("main", B2);
    putContent(api, B2, SENSITIVE);
    expect(await runIntent()).toBe("published");
    expect(api.find("GET", /\/git\/ref\//).length).toBeGreaterThanOrEqual(1);
    expect(contentRefs(api)).toEqual([B2]);
    expect(await floorRules()).toContain("configured_path");
  });
});
