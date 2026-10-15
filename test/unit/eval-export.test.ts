import fs from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { evalCaseSchema } from "../../src/eval/case-schema.js";
import { generateKey, parseKey } from "../../src/eval/crypto.js";
import {
  buildExportClient,
  ExportError,
  exportPrs,
  type Stage1Candidate,
} from "../../src/eval/export.js";
import { EvalAbort, installRateLimit } from "../../src/eval/rate-limit.js";
import {
  type CaseSet,
  createSet,
  EvalStoreError,
  listCaseIds,
  openSet,
  readCase,
} from "../../src/eval/store.js";
import { cleanupTmpDirs, tmpDir } from "../helpers/eval-fixtures.js";
import { createFakeGitHubApi, type FakeGitHubApi } from "../helpers/fake-github-api.js";
import {
  commitMessage,
  fakeSha,
  makeCommit,
  makeFile,
  makeIssue,
  makePull,
  OWNER,
  REPO,
} from "../helpers/github-builders.js";

cleanupTmpDirs();

const T0 = Date.parse("2026-10-15T10:00:00Z");
const FROM = new Date("2026-06-01T00:00:00Z");
const TO_EXCLUSIVE = new Date("2026-10-01T00:00:00Z");
const GH_TOKEN = `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`;

// --- rate limiting -------------------------------------------------------------------------------

function scripted(responses: (() => Response)[]) {
  const calls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    calls.push(String(input instanceof Request ? input.url : input));
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    return next();
  };
  return { fetch: fetchFn, calls };
}
const reply =
  (status: number, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(status < 400 ? { ok: true } : { message: "limited" }), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

function limited(
  responses: (() => Response)[],
  o: Partial<Parameters<typeof installRateLimit>[1]> = {},
) {
  const s = scripted(responses);
  const slept: number[] = [];
  const octokit = new Octokit({ request: { fetch: s.fetch } });
  const stats = installRateLimit(octokit, {
    sleep: async (ms) => void slept.push(ms),
    now: () => T0,
    minRemaining: 50,
    maxWaitMs: 15 * 60_000,
    maxRequests: 100,
    ...o,
  });
  const get = () => octokit.request("GET /repos/{owner}/{repo}", { owner: "o", repo: "r" });
  return { get, slept, stats, calls: s.calls };
}

describe("eval rate limiting", () => {
  it("U-RL-1 a low remaining count makes the wrapper sleep until reset plus one second", async () => {
    const reset = String(T0 / 1000 + 120);
    const w = limited([
      reply(200, { "x-ratelimit-remaining": "10", "x-ratelimit-reset": reset }),
      reply(200),
    ]);
    await w.get();
    expect(w.slept).toEqual([121_000]);
    await w.get();
    expect(w.slept).toEqual([121_000]);
  });

  it("U-RL-2 a 429 with retry-after sleeps that long and retries", async () => {
    const w = limited([reply(429, { "retry-after": "3" }), reply(200)]);
    await expect(w.get()).resolves.toMatchObject({ status: 200 });
    expect(w.slept).toEqual([3000]);
    expect(w.calls).toHaveLength(2);
  });

  it("U-RL-3 four rate-limited 403s in a row: three sleeps and retries, then the error propagates", async () => {
    const h = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(T0 / 1000 + 30) };
    const w = limited([reply(403, h), reply(403, h), reply(403, h), reply(403, h)]);
    await expect(w.get()).rejects.toMatchObject({ status: 403 });
    expect(w.slept).toEqual([31_000, 31_000, 31_000]);
    expect(w.calls).toHaveLength(4);
  });

  it("U-RL-4 a wait longer than maxWait aborts without sleeping", async () => {
    const h = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(T0 / 1000 + 20 * 60) };
    const w = limited([reply(403, h)]);
    const err = await w.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalAbort);
    expect((err as EvalAbort).code).toBe("rate_limit_wait");
    expect(w.slept).toEqual([]);
  });

  it("U-RL-5 maxRequests stops the fourth request", async () => {
    const w = limited([reply(200), reply(200), reply(200), reply(200)], { maxRequests: 3 });
    await w.get();
    await w.get();
    await w.get();
    const err = await w.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalAbort);
    expect((err as EvalAbort).code).toBe("max_requests");
    expect(w.stats.requests()).toBe(4);
    expect(w.calls).toHaveLength(3);
  });
});

// --- export ---------------------------------------------------------------------------------------

interface PrSpec {
  n: number;
  merged?: string | null;
  updated?: string;
  user?: { login: string; type: string };
  trailers?: [string, string][];
  body?: string;
  title?: string;
  files?: Parameters<typeof makeFile>[0][];
  additions?: number;
  deletions?: number;
}

function addPr(api: FakeGitHubApi, s: PrSpec) {
  const merged = s.merged === undefined ? "2026-08-10T10:00:00Z" : s.merged;
  const files = s.files ?? [
    { path: `src/f${s.n}.ts`, patch: `@@ -1 +1 @@\n-old\n+PATCH_MARKER_${s.n}` },
  ];
  api.state.pulls.set(
    s.n,
    makePull({
      number: s.n,
      state: "closed",
      merged: merged !== null,
      merged_at: merged,
      closed_at: merged,
      updated_at: s.updated ?? merged ?? "2026-08-10T10:00:00Z",
      title: s.title ?? `Title ${s.n}`,
      body: s.body ?? `Fixes #${100 + s.n}`,
      changed_files: files.length,
      additions: s.additions ?? files.length * 3,
      deletions: s.deletions ?? files.length,
      commits: 1,
      user: s.user ?? { login: "dev", type: "User" },
      head: { sha: fakeSha(0x1000 + s.n) },
    }),
  );
  api.state.commits.set(s.n, [
    makeCommit(
      fakeSha(0x1000 + s.n),
      commitMessage(`Change ${s.n}`, undefined, s.trailers ?? [["Graft-Agent", "claude-code"]]),
    ),
  ]);
  api.state.files.set(
    s.n,
    files.map((f) => makeFile(f)),
  );
  api.state.issues.set(
    100 + s.n,
    makeIssue(100 + s.n, { title: `Issue ${100 + s.n}`, body: "issue body" }),
  );
}

async function world(setup?: (api: FakeGitHubApi) => void) {
  const clock = { ms: T0 };
  const slept: number[] = [];
  const api = createFakeGitHubApi({ now: () => clock.ms });
  setup?.(api);
  const sleep = async (ms: number) => {
    slept.push(ms);
    clock.ms += ms;
  };
  const key = parseKey(generateKey());
  const root = await tmpDir();
  const set = await createSet(
    path.join(root, "pilot-a"),
    {
      setId: "pilot-a",
      kind: "pilot",
      description: "",
      encrypted: true,
      consentRef: "agreement 1",
      defaultFloorConfig: { extraSensitiveGlobs: ["services/billing/**"] },
    },
    { key, now: new Date(T0) },
  );
  const client = async (over: Partial<Parameters<typeof buildExportClient>[0]> = {}) =>
    buildExportClient({
      auth: "token",
      env: { GITHUB_API_URL: "https://api.github.com", GRAFT_EVAL_GITHUB_TOKEN: "test-token" },
      fetch: api.fetch,
      sleep,
      nowMs: () => clock.ms,
      minRemaining: 50,
      maxWaitMs: 15 * 60_000,
      maxRequests: 5000,
      ...over,
    });
  const lines: string[] = [];
  const run = async (
    over: Partial<Parameters<typeof exportPrs>[0]> = {},
    clientOver: Partial<Parameters<typeof buildExportClient>[0]> = {},
    target: CaseSet = set,
  ) => {
    const { octokit } = await client(clientOver);
    return exportPrs({
      set: target,
      repo: `${OWNER}/${REPO}`,
      from: FROM,
      toExclusive: TO_EXCLUSIVE,
      author: "agent",
      agentLogins: [],
      agentCoauthorEmails: ["noreply@anthropic.com"],
      sample: 50,
      minPerStratum: 2,
      maxCandidates: 400,
      seed: 1,
      redact: {},
      dryRun: false,
      octokit,
      now: () => new Date(T0),
      out: (l) => void lines.push(l),
      ...over,
    });
  };
  return { api, set, key, root, slept, clock, run, lines, client };
}

const getPulls = (api: FakeGitHubApi) =>
  api.find("GET", /\/pulls\/\d+$/).map((r) => Number(r.path.split("/").pop()));

describe("eval export", () => {
  it("U-EXP-1 lists closed PRs page by page, filters by merge date, and stops at the first PR older than from", async () => {
    const w = await world((api) => {
      addPr(api, { n: 5, merged: "2026-10-05T10:00:00Z" }); // merged after the range
      addPr(api, { n: 7, merged: "2026-09-29T10:00:00Z" });
      addPr(api, { n: 6, merged: null, updated: "2026-09-28T10:00:00Z" }); // never merged
      addPr(api, { n: 4, merged: "2026-09-20T10:00:00Z" });
      addPr(api, { n: 3, merged: "2026-09-10T10:00:00Z" });
      addPr(api, { n: 2, merged: "2026-09-01T10:00:00Z" });
      addPr(api, { n: 1, merged: "2026-05-19T10:00:00Z", updated: "2026-05-20T10:00:00Z" }); // merged before
      addPr(api, { n: 9, merged: "2026-04-01T10:00:00Z" });
      api.state.listPageSize = 2;
    });
    let seen: readonly Stage1Candidate[] = [];
    const summary = await w.run({
      onStage1: (c) => {
        seen = c;
      },
    });
    expect(summary.candidates).toBe(4);
    expect(seen.map((c) => c.prNumber).sort((a, b) => a - b)).toEqual([2, 3, 4, 7]);
    expect(getPulls(w.api).sort((a, b) => a - b)).toEqual([2, 3, 4, 7]);
    // pages: [5,7] [6,4] [3,2] [1,9]; the listing stopped at #1, #9 was never fetched
    expect(w.api.find("GET", /\/pulls$/)).toHaveLength(4);
    expect(getPulls(w.api)).not.toContain(9);
    expect(getPulls(w.api)).not.toContain(1);
  });

  it("U-EXP-2 --author agent keeps trailer and bot PRs and drops human ones; --author bot makes no commit request", async () => {
    const setup = (api: FakeGitHubApi) => {
      addPr(api, { n: 11, trailers: [["Graft-Agent", "claude-code"]] });
      addPr(api, { n: 12, trailers: [] });
      addPr(api, { n: 13, trailers: [], user: { login: "robo[bot]", type: "Bot" } });
    };
    const w = await world(setup);
    let seen: readonly Stage1Candidate[] = [];
    await w.run({
      onStage1: (c) => {
        seen = c;
      },
    });
    expect(seen.map((c) => [c.prNumber, c.provenance.authorKindReason])).toEqual([
      [11, "trailer"],
      [13, "bot_account"],
    ]);
    expect(await listCaseIds(w.set)).toEqual(["pilot-a--sample-ts-11", "pilot-a--sample-ts-13"]);

    const b = await world(setup);
    await b.run({ author: "bot" });
    expect(b.api.find("GET", /\/commits$/)).toHaveLength(0);
    expect(await listCaseIds(b.set)).toEqual(["pilot-a--sample-ts-13"]);
  });

  it("U-EXP-3 stage 2 runs only for sampled PRs, and stage 1 keeps no patch text", async () => {
    const w = await world((api) => {
      for (const n of [21, 22, 23, 24]) addPr(api, { n });
    });
    let seen: readonly Stage1Candidate[] = [];
    const summary = await w.run({
      sample: 2,
      minPerStratum: 0,
      onStage1: (c) => {
        seen = c;
      },
    });
    expect(summary.sampled).toBe(2);
    expect(seen).toHaveLength(4);
    expect(JSON.stringify(seen.map((c) => ({ ...c, pull: undefined })))).not.toContain(
      "PATCH_MARKER",
    );
    expect(seen.every((c) => c.files.every((f) => !("patch" in f)))).toBe(true);
    // listFiles ran for all four in stage 1 and again for the two sampled; issues only for the two
    expect(w.api.find("GET", /\/pulls\/\d+\/files$/)).toHaveLength(6);
    expect(w.api.find("GET", /\/issues\/\d+$/)).toHaveLength(2);
    expect(await listCaseIds(w.set)).toHaveLength(2);
  });

  it("U-EXP-4 the written case is sealed and valid, with source fields, default floor config and the task issue", async () => {
    const w = await world((api) => {
      addPr(api, {
        n: 31,
        body: "Does a thing without any reference.",
        trailers: [
          ["Graft-Agent", "claude-code"],
          ["Graft-Model", "claude-sonnet-5-5"],
          ["Graft-Task", "#77"],
        ],
        files: [{ path: "src/billing-thing.ts", patch: "@@ -1 +1 @@\n-a\n+b" }],
      });
      api.state.issues.set(77, makeIssue(77, { title: "The task issue", body: "task body" }));
    });
    await w.run();
    const raw = await fs.readFile(
      path.join(w.set.dir, "cases/pilot-a--sample-ts-31.case.enc"),
      "utf8",
    );
    expect(JSON.parse(raw).graftEval).toBe("enc-v1");
    const c = await readCase(w.set, "pilot-a--sample-ts-31");
    expect(evalCaseSchema.safeParse(c).success).toBe(true);
    expect(c.labels).toEqual([]);
    expect(c.adjudicated).toBeNull();
    expect(c.fakeLlm).toBeNull();
    expect(c.floorConfig).toEqual({ extraSensitiveGlobs: ["services/billing/**"] });
    expect(c.inputs.issue?.number).toBe(77);
    expect(c.source).toMatchObject({
      kind: "pilot",
      setId: "pilot-a",
      repository: `${OWNER}/${REPO}`,
      prNumber: 31,
      headSha: fakeSha(0x1000 + 31),
      baseSha: fakeSha(0xba5e),
      mergedAt: "2026-08-10T10:00:00Z",
      exportTool: "graft-eval-export/1",
      authorKind: "agent",
      authorKindReason: "trailer",
      agent: "claude-code",
      model: "claude-sonnet-5-5",
    });
  });

  it("U-EXP-5 re-running the same export writes nothing new and makes no stage-2 request", async () => {
    const w = await world((api) => {
      for (const n of [41, 42, 43]) addPr(api, { n });
    });
    await w.run();
    const ids = await listCaseIds(w.set);
    expect(ids).toHaveLength(3);
    const mtimes = await Promise.all(
      ids.map(async (id) => (await fs.stat(path.join(w.set.dir, `cases/${id}.case.enc`))).mtimeMs),
    );
    const before = w.api.requests.length;
    const again = await w.run();
    expect(again.exported).toBe(0);
    expect(again.existing).toBe(3);
    expect(
      w.api.requests.slice(before).filter((r) => /\/(pulls\/\d+|issues\/\d+)/.test(r.path)),
    ).toEqual([]);
    expect(
      await Promise.all(
        ids.map(
          async (id) => (await fs.stat(path.join(w.set.dir, `cases/${id}.case.enc`))).mtimeMs,
        ),
      ),
    ).toEqual(mtimes);
  });

  it("U-EXP-6 a pilot set whose consent reference was emptied by hand is refused before any request", async () => {
    const w = await world((api) => addPr(api, { n: 51 }));
    const file = path.join(w.set.dir, "set.json");
    const meta = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...meta, consentRef: "" }));
    const reopened = await openSet(w.set.dir, { key: w.key });
    await expect(w.run({}, {}, reopened)).rejects.toBeInstanceOf(EvalStoreError);
    expect(w.api.requests).toHaveLength(0);
  });

  it("U-EXP-7 a 404 on one pulls.get skips that PR and exports the others", async () => {
    const w = await world((api) => {
      for (const n of [61, 62, 63]) addPr(api, { n });
      api.failNext("GET", /\/pulls\/62$/, 404, {}, { message: "Not Found" });
    });
    const summary = await w.run();
    expect(summary.skippedNotFound).toBe(1);
    expect(await listCaseIds(w.set)).toEqual(["pilot-a--sample-ts-61", "pilot-a--sample-ts-63"]);
  });

  it("U-EXP-7b any other GitHub error stops the run with an ExportError after what was written", async () => {
    const w = await world((api) => {
      for (const n of [71, 72]) addPr(api, { n });
      api.failNext("GET", /\/pulls\/72$/, 500);
    });
    const err = await w.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).summary.exported).toBe(0);
  });

  it("U-EXP-8 an exhausted rate limit makes the injected sleep run and the export completes", async () => {
    const w = await world((api) => {
      for (const n of [81, 82, 83]) addPr(api, { n });
      api.state.rateLimit = { limit: 5000, remaining: 6, reset: T0 / 1000 + 600 };
    });
    // proactive sleeping off, so the 403 path is the one exercised
    const summary = await w.run({}, { minRemaining: -1 });
    expect(summary.exported).toBe(3);
    expect(w.slept.length).toBeGreaterThanOrEqual(1);
    expect(w.slept[0]).toBeGreaterThan(0);
    // and the proactive path
    const p = await world((api) => {
      for (const n of [84]) addPr(api, { n });
      api.state.rateLimit = { limit: 5000, remaining: 40, reset: T0 / 1000 + 600 };
    });
    await p.run();
    expect(p.slept.length).toBeGreaterThanOrEqual(1);
  });

  it("U-EXP-9 --dry-run writes nothing and makes only stage-1 requests", async () => {
    const w = await world((api) => {
      for (const n of [91, 92, 93]) addPr(api, { n });
    });
    const summary = await w.run({ dryRun: true, sample: 2, minPerStratum: 0 });
    expect(summary.sampled).toBe(2);
    expect(summary.exported).toBe(0);
    expect(await listCaseIds(w.set)).toEqual([]);
    expect(await fs.readdir(path.join(w.set.dir, "cases"))).toEqual([]);
    expect(w.api.find("GET", /\/issues\/\d+$/)).toHaveLength(0);
    expect(w.api.find("GET", /\/pulls\/\d+\/files$/)).toHaveLength(3);
    expect(w.lines.join("\n")).toContain("would export PRs");
    expect(w.lines.join("\n")).not.toMatch(/Title \d+/);
  });

  it("U-EXP-10 redaction is applied: a token in the PR body is absent from the decrypted case", async () => {
    const w = await world((api) => {
      addPr(api, { n: 101, body: `Fixes #200 and uses ${GH_TOKEN} directly` });
      api.state.issues.set(200, makeIssue(200, { body: `issue with ${GH_TOKEN}` }));
    });
    await w.run();
    const c = await readCase(w.set, "pilot-a--sample-ts-101");
    expect(JSON.stringify(c)).not.toContain(GH_TOKEN);
    expect(c.inputs.pr.body).toContain("[REDACTED:github_token]");
    expect(c.source.kind === "pilot" && c.source.redactions).toEqual([
      { kind: "github_token", count: 2 },
    ]);
  });

  it("the sample keeps rare strata: a sensitive-path PR is picked at a tiny sample size", async () => {
    const w = await world((api) => {
      for (let n = 111; n < 131; n++) addPr(api, { n });
      addPr(api, {
        n: 140,
        files: [{ path: ".github/workflows/ci.yml", patch: "@@ -1 +1 @@\n-a\n+b" }],
      });
    });
    await w.run({ sample: 4, minPerStratum: 1 });
    const ids = await listCaseIds(w.set);
    expect(ids).toHaveLength(4);
    expect(ids).toContain("pilot-a--sample-ts-140");
    expect((await readCase(w.set, "pilot-a--sample-ts-140")).tags).toEqual([
      "size-s",
      "path-sensitive",
    ]);
  });
});
