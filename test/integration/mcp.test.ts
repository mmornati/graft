/**
 * Phase 1 step 6: the MCP server, through a real `@modelcontextprotocol/client` over HTTP against
 * `buildServer` on a random port, with the fake GitHub world (spec §14, I-MCP-1 to I-MCP-19).
 */
import { Writable } from "node:stream";
import { type KyselyPlugin, sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OpsDeps, main as opsMain } from "../../src/bin/graft-ops.js";
import type { JobContext } from "../../src/core/context.js";
import { createLogger } from "../../src/core/logger.js";
import { migrateDownOne, migrateToLatest } from "../../src/db/migrator.js";
import type { GitHubClientFactory } from "../../src/github/client-factory.js";
import { MutationRefusedError } from "../../src/github/mutation-guard.js";
import { type AppServer, buildServer } from "../../src/http/server.js";
import { hashToken } from "../../src/mcp/tokens.js";
import { upsertRepositories } from "../../src/modules/installations/store.js";
import { authorizeToken } from "../../src/modules/mcp/auth.js";
import { insertMcpChange } from "../../src/modules/mcp/store.js";
import { mutationGate } from "../../src/modules/modes/index.js";
import { evaluatePolicyJobRun } from "../../src/modules/policy/job.js";
import { refreshProvenance } from "../../src/modules/provenance/job.js";
import { clearPolicyCache } from "../../src/policy/load.js";
import { canonicalHash } from "../../src/policy/parse.js";
import { createTestApp, fakeGitHubFactory, jobContext, type TestApp } from "../helpers/app.js";
import { testConfig } from "../helpers/config.js";
import { testDb, truncateAll } from "../helpers/db.js";
import {
  createFakeGitHubApi,
  type FakeGitHubApi,
  type RecordedApiRequest,
} from "../helpers/fake-github-api.js";
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
  REPO_ID,
} from "../helpers/github-builders.js";
import {
  call,
  createTestToken,
  INITIALIZE,
  LIST_TOOLS,
  type McpClientHandle,
  mcpClient,
  rawPost,
} from "../helpers/mcp-client.js";
import { addCard, addDelivery, addDisplay } from "../helpers/pilot-seed.js";
import { jobsNamed, loadPolicyScenario } from "../helpers/policy-scenario.js";
import { seedWorld } from "../helpers/seed.js";

const FULL = `${OWNER}/${REPO}`;
const REPO_B = 2_000_002;
const FULL_B = `${OWNER}/other-repo`;
const HEAD_2 = fakeSha(0xbeef);
const FEAT_SHA = fakeSha(0xfea7);
const TITLE_SENTINEL = "MCP_TITLE_SENTINEL_zq";
const BODY_SENTINEL = "MCP_BODY_SENTINEL_zq";
const AGENT_SENTINEL = "sentinel-agent-zq";
const ARG_SENTINEL = "argsentinel-zq";
/** The policy of I-MCP-8: a require rule on agent codex, and an approve rule for everything else. */
const AGENT_POLICY = [
  "version: 1",
  "default:",
  "  require: { humans: 1 }",
  "rules:",
  "  - name: codex-needs-review",
  "    match: { agent: [codex] }",
  "    require: { humans: 1 }",
  "  - name: everything-else",
  "    match: { risk: [trivial, logic, sensitive] }",
  "    approve: auto",
  "",
].join("\n");
const PERMISSIONS = {
  metadata: "read",
  contents: "read",
  issues: "read",
  pull_requests: "write",
  checks: "write",
};

let t: TestApp;
let api: FakeGitHubApi;
let logged = "";
/** Every token and token hash created in this file (I-MCP-16). */
const secrets: string[] = [];
/** Every fake GitHub request of this file (I-MCP-19). */
const allRequests: RecordedApiRequest[] = [];
const servers: AppServer[] = [];
const clients: McpClientHandle[] = [];
/** The feature of every client built through the factory, in order (null: the default client). */
const features: (string | null)[] = [];
const refused: MutationRefusedError[] = [];
let tokenLookups = 0;
/** I-MCP-16: thrown once by the next modes read of the server (a tool failure that is no ToolError). */
let failModesRead: Error | null = null;

const countTokenLookups: KyselyPlugin = {
  transformQuery(a) {
    if (a.node.kind === "SelectQueryNode" && JSON.stringify(a.node).includes('"mcp_tokens"')) {
      tokenLookups++;
    }
    return a.node;
  },
  async transformResult(a) {
    return a.result;
  },
};

const failModes: KyselyPlugin = {
  transformQuery(a) {
    const q = JSON.stringify(a.node);
    if (
      failModesRead !== null &&
      a.node.kind === "SelectQueryNode" &&
      q.includes('"mcp_write"') &&
      !q.includes('"mcp_tokens"')
    ) {
      const err = failModesRead;
      failModesRead = null;
      throw err;
    }
    return a.node;
  },
  async transformResult(a) {
    return a.result;
  },
};

function factoryFor(config: ReturnType<typeof testConfig>): GitHubClientFactory {
  const factory = fakeGitHubFactory(api, mutationGate(t.db, config), (e) => refused.push(e));
  return {
    asApp: () => factory.asApp(),
    forInstallation: (id, o) => {
      features.push(o?.feature ?? null);
      return factory.forInstallation(id, o);
    },
  };
}

const ENFORCE = { GRAFT_MODE_CEILING: "enforce" };
/** The fake API opens PRs as `graft-dev[bot]`: Graft's own bot when the slug is `graft-dev`. */
const ENFORCE_APP = { ...ENFORCE, GITHUB_APP_SLUG: "graft-dev" };

async function start(cfg: Record<string, string> = {}): Promise<URL> {
  const config = testConfig(cfg);
  const server = await buildServer({
    ...t.deps,
    config,
    github: factoryFor(config),
    db: t.db.withPlugin(countTokenLookups).withPlugin(failModes),
  });
  servers.push(server);
  await server.listen({ port: 0, host: "127.0.0.1" });
  const { port } = server.server.address() as { port: number };
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

async function connect(
  url: URL,
  token: string,
  era: "legacy" | "modern" = "legacy",
): Promise<McpClientHandle> {
  const c = await mcpClient(url, token, { era });
  clients.push(c);
  return c;
}

async function token(
  repositoryId = REPO_ID,
  name?: string,
): Promise<{ token: string; id: string }> {
  const created = await createTestToken(t.db, { repositoryId, ...(name ? { name } : {}) });
  secrets.push(created.token, hashToken(created.token));
  return created;
}

function ctxFor(cfg: Record<string, string> = {}): JobContext {
  const config = testConfig(cfg);
  return { ...jobContext(t), config, github: factoryFor(config) };
}

const PROV = {
  installationId: INSTALLATION_ID,
  repositoryId: REPO_ID,
  owner: OWNER,
  repo: REPO,
  prNumber: PR_NUMBER,
  headSha: HEAD_SHA,
  trigger: "opened" as const,
  deliveryId: "d-mcp",
};
const POLICY_RUN = {
  installationId: INSTALLATION_ID,
  repositoryId: REPO_ID,
  owner: OWNER,
  repo: REPO,
  prNumber: PR_NUMBER,
  trigger: "provenance" as const,
};

async function setMcpWrite(value: "on" | "off", repositoryId = REPO_ID): Promise<void> {
  await t.db
    .updateTable("repositories")
    .set({ mcp_write: value })
    .where("id", "=", repositoryId)
    .execute();
}

const writes = (from = 0) =>
  api.requests
    .slice(from)
    .filter((r) => r.method !== "GET" && r.method !== "HEAD" && !r.path.endsWith("/access_tokens"));

/** The verdict of the change's current head (the test clock is fixed, so time cannot order them). */
const latestVerdict = () =>
  t.db
    .selectFrom("policy_verdicts as v")
    .innerJoin("changes as c", (j) =>
      j.onRef("c.id", "=", "v.change_id").onRef("c.head_sha", "=", "v.head_sha"),
    )
    .selectAll("v")
    .orderBy("facts_read_at", "desc")
    .orderBy("evaluated_at", "desc")
    .executeTakeFirstOrThrow();

beforeAll(async () => {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logged += String(chunk);
      cb();
    },
  });
  t = await createTestApp({ log: createLogger({ logLevel: "info" }, stream) });
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await truncateAll(t.db);
  clearPolicyCache();
  api = createFakeGitHubApi();
  features.length = 0;
  refused.length = 0;
  tokenLookups = 0;
  await seedWorld(t.db);
  await t.db
    .updateTable("installations")
    .set({ permissions: JSON.stringify(PERMISSIONS), permissions_read_at: new Date() })
    .execute();
  await t.db
    .insertInto("repositories")
    .values({
      id: REPO_B,
      installation_id: INSTALLATION_ID,
      full_name: FULL_B,
      private: true,
      default_branch: "main",
    })
    .execute();
  loadPolicyScenario(api, { policy: AGENT_POLICY });
  api.state.commits.set(PR_NUMBER, [
    makeCommit(
      HEAD_SHA,
      commitMessage("Fix the retry loop", undefined, [
        ["Graft-Agent", "claude-code"],
        ["Graft-Model", "claude-sonnet-5-5"],
      ]),
    ),
  ]);
  api.state.branches.set("feat/mcp", FEAT_SHA);
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const s of servers.splice(0)) await s.close();
  allRequests.push(...api.requests);
});

/** PR 2 as the provenance and policy jobs leave it: a change, trailers, a verdict. */
async function seedPr(cfg: Record<string, string> = {}): Promise<string> {
  const ctx = ctxFor(cfg);
  expect(await refreshProvenance(PROV, ctx)).toBe("published");
  expect(await evaluatePolicyJobRun(POLICY_RUN, ctx)).toBe("published");
  const change = await t.db
    .selectFrom("changes")
    .select("id")
    .where("pr_number", "=", PR_NUMBER)
    .executeTakeFirstOrThrow();
  return change.id;
}

describe("MCP server (Phase 1 step 6)", () => {
  it("I-MCP-1 migration 0014 up, down, up: down removes both tables and the column, and the mcp provenance rows", async () => {
    const tables = async () =>
      (
        await sql<{ t: string }>`select table_name as t from information_schema.tables
          where table_schema = 'public' and table_name in ('mcp_tokens', 'mcp_changes')
          order by 1`.execute(t.db)
      ).rows.map((r) => r.t);
    const column = async () =>
      (
        await sql<{ n: string }>`select count(*)::text as n from information_schema.columns
          where table_name = 'change_provenance' and column_name = 'mcp_report'`.execute(t.db)
      ).rows[0]?.n;
    expect(await tables()).toEqual(["mcp_changes", "mcp_tokens"]);
    expect(await column()).toBe("1");
    await seedPr();
    const change = await t.db.selectFrom("changes").select("id").executeTakeFirstOrThrow();
    await t.db
      .insertInto("provenance")
      .values({ change_id: change.id, source: "mcp", commit_sha: HEAD_SHA, agent: "codex" })
      .execute();
    expect(await migrateDownOne(t.db)).toEqual(["0014_mcp"]);
    try {
      expect(await tables()).toEqual([]);
      expect(await column()).toBe("0");
      const mcpRows = await t.db
        .selectFrom("provenance")
        .select("id")
        .where("source", "=", "mcp")
        .execute();
      expect(mcpRows).toEqual([]);
    } finally {
      expect(await migrateToLatest(t.db)).toEqual(["0014_mcp"]);
    }
    expect(await tables()).toEqual(["mcp_changes", "mcp_tokens"]);
    // The CHECKs: a hex hash, an 8-character prefix, expiry after creation, revoked iff by.
    await expect(
      sql`insert into mcp_tokens (repository_id, name, token_hash, token_prefix, created_by, expires_at)
        values (${REPO_ID}, 'x', 'not-a-hash', 'abcdEFGH', 'a', now() + interval '1 day')`.execute(
        t.db,
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      sql`insert into mcp_tokens (repository_id, name, token_hash, token_prefix, created_by, expires_at, revoked_at)
        values (${REPO_ID}, 'x', ${"a".repeat(64)}, 'abcdEFGH', 'a', now() + interval '1 day', now())`.execute(
        t.db,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("I-MCP-2 reads with a valid token: exactly four tools with schemas; get_status returns card, provenance, verdict with wouldBe, guard events; get_policy the parsed policy, hash and modes; no GitHub write", async () => {
    const changeId = await seedPr();
    const cardId = await addCard(t.db, {
      changeId,
      headSha: HEAD_SHA,
      risk: "logic",
      createdAt: new Date("2026-10-14T11:30:00Z"),
    });
    await addDisplay(t.db, {
      changeId,
      cardId,
      status: "ok",
      shownAt: new Date("2026-10-14T11:31:00Z"),
    });
    await t.db
      .insertInto("guard_events")
      .values({
        repository_id: REPO_ID,
        branch: "main",
        failing_sha: fakeSha(0x4e01),
        culprit_change_id: changeId,
        status: "culprit_found",
        failing_checks: JSON.stringify([{ key: "run:1:test", name: "test", source: "check_run" }]),
        detected_at: new Date("2026-10-14T11:40:00Z"),
        revert_outcome: "planned",
      })
      .execute();
    const { token: tok } = await token();
    const url = await start();
    const before = api.requests.length;
    const featuresBefore = features.length;
    const c = await connect(url, tok);

    const tools = (await c.client.listTools()).tools;
    expect(tools.map((x) => x.name).sort()).toEqual([
      "get_policy",
      "get_status",
      "open_change",
      "report_provenance",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.inputSchema.required, tool.name).toContain("repository");
      expect(tool.outputSchema, tool.name).toMatchObject({ type: "object" });
    }
    const byName = new Map(tools.map((x) => [x.name, x]));
    for (const read of ["get_status", "get_policy", "report_provenance"]) {
      expect(byName.get(read)?.annotations, read).toMatchObject({ readOnlyHint: true });
    }
    expect(byName.get("open_change")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });

    const status = await call(c, "get_status", { repository: FULL, pr: PR_NUMBER });
    expect(status.isError).toBe(false);
    expect(JSON.parse(status.text)).toEqual(status.out);
    expect(status.out).toMatchObject({
      pr: {
        number: PR_NUMBER,
        state: "open",
        headSha: HEAD_SHA,
        baseRef: "main",
        openedThroughMcp: false,
      },
      card: { headSha: HEAD_SHA, current: true, status: "ok", riskClass: "logic", goal: "a goal" },
      provenance: {
        headSha: HEAD_SHA,
        current: true,
        authorKind: "agent",
        agent: "claude-code",
        model: "claude-sonnet-5-5",
        conflicts: [],
        mcp: { report: "none", agent: null },
      },
      policy: {
        headSha: HEAD_SHA,
        current: true,
        outcome: "would_approve",
        policyMode: "report",
        published: "neutral",
        // The card arrived after the verdict: enforce mode would still wait for it.
        wouldBe: "pending",
        wouldBeReason: "card_pending",
        breakGlass: "none",
      },
      guard: [
        {
          status: "culprit_found",
          failingChecks: ["test"],
          revertOutcome: "planned",
          detectedAt: "2026-10-14T11:40:00.000Z",
        },
      ],
      modes: {
        policy: { effective: "report", reason: "repository" },
        guard: { effective: "report", reason: "repository" },
        mcpWrite: { effective: "off", reason: "repository" },
      },
    });

    const policy = await call(c, "get_policy", { repository: FULL });
    expect(policy.isError).toBe(false);
    expect(policy.out).toMatchObject({
      base: "main",
      commitSha: fakeSha(0xba5e),
      status: "ok",
      errors: [],
      modes: { ceiling: "report", mcpWrite: { effective: "off" } },
    });
    expect(policy.out.hash).toBe(canonicalHash(policy.out.policy));
    expect(JSON.stringify(policy.out.policy)).toContain("codex");
    // The parsed object, not the file: no YAML, no comments.
    expect(policy.text).not.toContain("version: 1");
    expect(await call(c, "get_policy", { repository: FULL, base: "nope" })).toMatchObject({
      isError: true,
      out: { error: "base_not_found" },
    });
    expect(writes(before)).toEqual([]);
    // The reads made no client with a feature.
    expect(features.slice(featuresBefore).filter((f) => f !== null)).toEqual([]);
    // One log line per call, with the tool, ids and outcome.
    expect(logged).toContain('"msg":"mcp call"');
    expect(logged).toMatch(
      /"tool":"get_status","tokenId":"[0-9a-f-]{36}","repositoryId":2000001,"outcome":"ok"/,
    );
  });

  it("I-MCP-3 refused tokens: none, malformed, unknown, sharing a valid prefix, expired, revoked between two calls, a removed repository's → 401 with identical bodies", async () => {
    const url = await start();
    const valid = await token();
    const expired = await token(REPO_ID, "expired");
    await t.db
      .updateTable("mcp_tokens")
      .set({
        created_at: new Date(Date.now() - 10 * 86_400_000),
        expires_at: new Date(Date.now() - 86_400_000),
      })
      .where("id", "=", expired.id)
      .execute();
    const removedRepo = await token(REPO_B, "removed");
    await t.db
      .updateTable("repositories")
      .set({ removed_at: new Date() })
      .where("id", "=", REPO_B)
      .execute();

    // Same `graft_mcp_` and 8-character prefix as the valid token, one later character changed:
    // the lookup is by the hash of the whole string, never by the prefix.
    const flip = (ch: string) => (ch === "A" ? "B" : "A");
    const samePrefix = `${valid.token.slice(0, 30)}${flip(valid.token[30] as string)}${valid.token.slice(31)}`;
    expect(samePrefix.slice(0, 18)).toBe(valid.token.slice(0, 18));
    expect(samePrefix).not.toBe(valid.token);

    const bodies: string[] = [];
    for (const headers of [
      {} as Record<string, string>,
      { authorization: `Bearer ${samePrefix}` },
      { authorization: "Bearer nope" },
      { authorization: `bearer ${valid.token}` },
      { authorization: `Bearer graft_mcp_${"A".repeat(43)}` },
      { authorization: `Bearer ${expired.token}` },
      { authorization: `Bearer ${removedRepo.token}` },
    ]) {
      const res = await rawPost(url, INITIALIZE, headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="graft"');
      bodies.push(await res.text());
    }
    // A token in the query string or a cookie is ignored.
    const query = new URL(url);
    query.searchParams.set("token", valid.token);
    expect((await rawPost(query, INITIALIZE)).status).toBe(401);
    expect((await rawPost(url, INITIALIZE, { cookie: `token=${valid.token}` })).status).toBe(401);

    // Revoked between two calls of the same client.
    const c = await connect(url, valid.token);
    expect((await call(c, "get_status", { repository: FULL, pr: 9 })).out).toEqual({
      error: "not_found",
    });
    await t.db
      .updateTable("mcp_tokens")
      .set({ revoked_at: new Date(), revoked_by: "tester", revoke_reason: "test" })
      .where("id", "=", valid.id)
      .execute();
    await expect(call(c, "get_status", { repository: FULL, pr: 9 })).rejects.toThrow();
    expect(c.statuses.at(-1)).toBe(401);
    const after = await rawPost(url, INITIALIZE, { authorization: `Bearer ${valid.token}` });
    expect(after.status).toBe(401);
    bodies.push(await after.text());
    expect(new Set(bodies)).toEqual(new Set(['{"error":"unauthorized"}']));
  });

  it("I-MCP-4 another repository: a token for B naming A, or a repository Graft does not know → forbidden_repository; PR numbers resolve only within B for get_status and report_provenance", async () => {
    await seedPr();
    const b = await token(REPO_B);
    const url = await start();
    const c = await connect(url, b.token);
    const calls: [string, Record<string, unknown>][] = [
      ["get_status", { pr: PR_NUMBER }],
      ["get_policy", {}],
      ["report_provenance", { pr: PR_NUMBER, headSha: HEAD_SHA, agent: "codex" }],
      ["open_change", { head: "feat/mcp", title: "x" }],
    ];
    for (const [name, args] of calls) {
      for (const repository of [FULL, "someone/unknown-repo"]) {
        expect(await call(c, name, { repository, ...args }), `${name} ${repository}`).toEqual({
          isError: true,
          out: { error: "forbidden_repository" },
          text: '{"error":"forbidden_repository"}',
        });
      }
    }
    // Case-insensitive match on the token's own repository; PR 2 exists only in A, so neither
    // tool finds it through B's token, with A's head.
    expect(
      (await call(c, "get_status", { repository: FULL_B.toUpperCase(), pr: PR_NUMBER })).out,
    ).toEqual({ error: "not_found" });
    expect(
      (
        await call(c, "report_provenance", {
          repository: FULL_B,
          pr: PR_NUMBER,
          headSha: HEAD_SHA,
          agent: "codex",
        })
      ).out,
    ).toEqual({ error: "not_found" });
    expect(await jobsNamed(t.db, "provenance.refresh")).toEqual([]);
    const mcpRows = await t.db
      .selectFrom("provenance")
      .select("id")
      .where("source", "=", "mcp")
      .execute();
    expect(mcpRows).toEqual([]);
  });

  it("I-MCP-5 a 2025-era client (initialize first) and a 2026-07-28 client both list and call tools; GET and DELETE /mcp → 405", async () => {
    const { token: tok } = await token();
    const url = await start();
    for (const era of ["legacy", "modern"] as const) {
      const c = await connect(url, tok, era);
      expect((await c.client.listTools()).tools, era).toHaveLength(4);
      expect((await call(c, "get_status", { repository: FULL, pr: 9 })).out, era).toEqual({
        error: "not_found",
      });
      // An input the schema refuses is a tool error from the SDK (T1 d), never run.
      const bad = await call(c, "get_status", { repository: FULL, pr: 0 });
      expect(bad.isError, era).toBe(true);
      expect(bad.text, era).toMatch(/^Input validation error/);
      const extra = await call(c, "get_status", { repository: FULL, pr: 1, extra: true });
      expect(extra.isError, era).toBe(true);
    }
    expect(clients[0]?.statuses.slice(0, 2)).toEqual([200, 202]);
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(url, { method, headers: { authorization: `Bearer ${tok}` } });
      expect(res.status, method).toBe(405);
    }
    // Without a token the same methods are 401: auth comes first.
    expect((await fetch(url, { method: "GET" })).status).toBe(401);
  });

  it("I-MCP-6 Origin: a foreign origin → 403; an allowed one → served; a body over 64 KiB → 413; text/plain → 415", async () => {
    const { token: tok } = await token();
    const auth = { authorization: `Bearer ${tok}` };
    const url = await start({ GRAFT_MCP_ALLOWED_ORIGINS: "https://ok.example" });
    const evil = await rawPost(url, LIST_TOOLS, { ...auth, origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "origin not allowed" },
      id: null,
    });
    // Refused before the token is looked up.
    expect(tokenLookups).toBe(0);
    const ok = await rawPost(url, LIST_TOOLS, { ...auth, origin: "https://OK.example" });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("get_status");
    const big = await rawPost(url, { ...LIST_TOOLS, pad: "x".repeat(70_000) }, auth);
    expect(big.status).toBe(413);
    const plain = await rawPost(url, "hello", { ...auth, "content-type": "text/plain" });
    expect(plain.status).toBe(415);
  });

  it("I-MCP-7 rate limits: the 61st call in a minute → 429 with Retry-After; 21 bad tokens from one IP → 429, and the 22nd is not looked up", async () => {
    const { token: tok } = await token();
    const url = await start();
    const auth = { authorization: `Bearer ${tok}` };
    for (let i = 0; i < 60; i++) {
      expect((await rawPost(url, LIST_TOOLS, auth)).status, `call ${i + 1}`).toBe(200);
    }
    const limited = await rawPost(url, LIST_TOOLS, auth);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Another token of the same repository has its own bucket.
    const other = await token(REPO_ID, "other");
    expect(
      (await rawPost(url, LIST_TOOLS, { authorization: `Bearer ${other.token}` })).status,
    ).toBe(200);

    const url2 = await start();
    tokenLookups = 0;
    const bad = { authorization: `Bearer graft_mcp_${"B".repeat(43)}` };
    for (let i = 0; i < 20; i++) {
      expect((await rawPost(url2, LIST_TOOLS, bad)).status, `bad ${i + 1}`).toBe(401);
    }
    expect(tokenLookups).toBe(20);
    const r21 = await rawPost(url2, LIST_TOOLS, bad);
    expect(r21.status).toBe(429);
    expect(Number(r21.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await rawPost(url2, LIST_TOOLS, bad)).status).toBe(429);
    expect(tokenLookups).toBe(20);
    // For the rest of the minute even a valid token from that IP is refused.
    expect((await rawPost(url2, LIST_TOOLS, auth)).status).toBe(429);
    expect(tokenLookups).toBe(20);
  });

  it("I-MCP-8 report_provenance: stale head, closed PR, invalid session URL; a disagreeing report makes the codex rule match uncertain (would_require); once per head; an agreeing report changes nothing; a new push allows a new report", async () => {
    const changeId = await seedPr();
    expect((await latestVerdict()).outcome).toBe("would_approve");
    const { token: tok } = await token();
    const url = await start();
    const c = await connect(url, tok);
    const report = (args: Record<string, unknown>) =>
      call(c, "report_provenance", { repository: FULL, pr: PR_NUMBER, ...args });
    const mcpRows = () =>
      t.db.selectFrom("provenance").selectAll().where("source", "=", "mcp").execute();

    expect((await report({ headSha: HEAD_2, agent: "codex" })).out).toEqual({
      error: "stale_head",
    });
    expect(
      (await report({ headSha: HEAD_SHA, agent: "codex", sessionUrl: "http://insecure.example/s" }))
        .out,
    ).toEqual({ error: "invalid_argument", detail: "sessionUrl" });
    expect((await report({ headSha: HEAD_SHA, agent: "bad‮agent" })).out).toEqual({
      error: "invalid_argument",
      detail: "agent",
    });
    expect(await mcpRows()).toEqual([]);
    expect(await jobsNamed(t.db, "provenance.refresh")).toEqual([]);

    const writesBefore = api.requests.length;
    const first = await report({
      headSha: HEAD_SHA,
      agent: "codex",
      model: "gpt-5-codex",
      task: "#42",
    });
    expect(first.out).toEqual({ stored: true, existing: false, agreement: "disagrees" });
    // No GitHub request in the call itself.
    expect(api.requests.length).toBe(writesBefore);
    const rows = await mcpRows();
    expect(rows.map((r) => [r.commit_sha, r.agent, r.model, r.task_external_id])).toEqual([
      [HEAD_SHA, "codex", "gpt-5-codex", "#42"],
    ]);
    const queued = await jobsNamed(t.db, "provenance.refresh");
    expect(queued.map((j) => [j.data.trigger, j.data.deliveryId])).toEqual([
      ["mcp_report", `mcp:${rows[0]?.id}`],
    ]);

    // The job (run inline): mcp_report stored, the comment line, then the policy job.
    const ctx = ctxFor();
    expect(await refreshProvenance(queued[0]?.data as never, ctx)).toBe("published");
    const cp = await t.db
      .selectFrom("change_provenance")
      .selectAll()
      .where("change_id", "=", changeId)
      .executeTakeFirstOrThrow();
    expect([cp.mcp_report, cp.agent, cp.author_kind]).toEqual([
      "disagrees",
      "claude-code",
      "agent",
    ]);
    const comment = api.state.comments.find((x) => x.body.includes("graft:section:provenance"));
    expect(comment?.body).toContain(
      "Reported through MCP (unverified): agent `codex`, model `gpt-5-codex`, task `#42` · differs from trailers: the policy treats the author as unknown",
    );
    expect(await evaluatePolicyJobRun(POLICY_RUN, ctx)).toBe("published");
    const verdict = await latestVerdict();
    expect(verdict.outcome).toBe("would_require");
    expect(verdict.author_kind).toBe("unknown");
    const matched = verdict.rules_matched as {
      index: number;
      reasons: { key: string; uncertain: boolean }[];
    }[];
    expect(matched.find((m) => m.index === 1)?.reasons).toEqual([
      expect.objectContaining({ key: "agent", uncertain: true }),
    ]);
    expect(
      (await call(c, "get_status", { repository: FULL, pr: PR_NUMBER })).out.provenance,
    ).toMatchObject({
      agent: "claude-code",
      mcp: { report: "disagrees", agent: "codex", model: "gpt-5-codex", task: "#42" },
    });

    // Once per head: a different report is refused; the identical one returns the stored result.
    expect((await report({ headSha: HEAD_SHA, agent: "claude-code" })).out).toEqual({
      error: "already_reported",
    });
    expect(
      (await report({ headSha: HEAD_SHA, agent: "codex", model: "gpt-5-codex", task: "#42" })).out,
    ).toEqual({ stored: true, existing: true, agreement: "disagrees" });
    expect(await mcpRows()).toHaveLength(1);

    // A new push: a new head, a new report allowed. This one agrees: the verdict is unchanged.
    const pull = api.state.pulls.get(PR_NUMBER);
    if (!pull) throw new Error("no pull");
    pull.head.sha = HEAD_2;
    pull.updated_at = "2026-10-14T11:20:00Z";
    api.state.commits.set(PR_NUMBER, [
      makeCommit(HEAD_2, commitMessage("More", undefined, [["Graft-Agent", "claude-code"]])),
    ]);
    expect(await refreshProvenance({ ...PROV, headSha: HEAD_2, trigger: "synchronize" }, ctx)).toBe(
      "published",
    );
    expect(await evaluatePolicyJobRun(POLICY_RUN, ctx)).toBe("published");
    expect((await latestVerdict()).outcome).toBe("would_approve");
    const agree = await report({ headSha: HEAD_2, agent: "Claude-Code" });
    expect(agree.out).toEqual({ stored: true, existing: false, agreement: "agrees" });
    const job = (await jobsNamed(t.db, "provenance.refresh")).at(-1);
    expect(await refreshProvenance(job?.data as never, ctx)).toBe("published");
    expect(await evaluatePolicyJobRun(POLICY_RUN, ctx)).toMatch(/published|unchanged/);
    const after = await latestVerdict();
    expect([after.head_sha, after.outcome, after.author_kind]).toEqual([
      HEAD_2,
      "would_approve",
      "agent",
    ]);

    // A closed PR.
    await t.db.updateTable("changes").set({ state: "closed" }).where("id", "=", changeId).execute();
    expect((await report({ headSha: HEAD_2, agent: "codex" })).out).toEqual({ error: "pr_closed" });
    expect(await mcpRows()).toHaveLength(2);
  });

  it("I-MCP-8b the D13 merge in the jobs: a default with a team and a looser rule on agent: [codex]; a disagreeing report naming codex keeps the security reviewer required", async () => {
    loadPolicyScenario(api, {
      policy:
        "version: 1\ndefault:\n  require: { humans: 1, team: security }\nrules:\n  - match: { agent: [codex] }\n    require: { humans: 1 }\n",
    });
    api.state.teams.set("security", { members: new Map([["carol", "active"]]) });
    await seedPr();
    const before = await latestVerdict();
    expect(before.outcome).toBe("would_require");
    expect(before.required).toMatchObject({
      constraints: [{ rules: [], humans: 1, teamCount: 1 }],
      usedDefault: true,
    });
    const { token: tok } = await token();
    const url = await start();
    const c = await connect(url, tok);
    expect(
      (
        await call(c, "report_provenance", {
          repository: FULL,
          pr: PR_NUMBER,
          headSha: HEAD_SHA,
          agent: "codex",
        })
      ).out,
    ).toEqual({ stored: true, existing: false, agreement: "disagrees" });
    const ctx = ctxFor();
    const job = (await jobsNamed(t.db, "provenance.refresh")).at(-1);
    expect(await refreshProvenance(job?.data as never, ctx)).toBe("published");
    expect(await evaluatePolicyJobRun(POLICY_RUN, ctx)).toBe("published");
    const verdict = await latestVerdict();
    expect([verdict.outcome, verdict.author_kind]).toEqual(["would_require", "unknown"]);
    // The unknown author alone would match the codex rule and drop the team: the stricter of
    // the two verdicts keeps the default's security reviewer, and adds the codex rule.
    expect(verdict.required).toMatchObject({
      constraints: [
        { rules: [], humans: 1, teamCount: 1 },
        { rules: [1], humans: 1, teamCount: 0 },
      ],
      usedDefault: true,
    });
    const matched = verdict.rules_matched as {
      index: number;
      reasons: { key: string; uncertain: boolean }[];
    }[];
    expect(matched.find((m) => m.index === 1)?.reasons).toEqual([
      expect.objectContaining({ key: "agent", uncertain: true }),
    ]);
  });

  it("I-MCP-9 report mode inert: open_change with default modes and mcp_write requested on → mcp_write_off (ceiling); no request at all during the call; no mcp client", async () => {
    await setMcpWrite("on");
    const { token: tok } = await token();
    const url = await start();
    const c = await connect(url, tok);
    const before = api.requests.length;
    const featuresBefore = features.length;
    const res = await call(c, "open_change", {
      repository: FULL,
      head: "feat/mcp",
      title: TITLE_SENTINEL,
      body: BODY_SENTINEL,
    });
    expect(res.out).toEqual({ error: "mcp_write_off", detail: "ceiling" });
    expect(api.requests.length).toBe(before);
    // No client of any kind was made for the call.
    expect(features.slice(featuresBefore)).toEqual([]);
    expect(refused).toEqual([]);
    expect(await t.db.selectFrom("mcp_changes").selectAll().execute()).toEqual([]);
    // Off for the repository (ceiling enforce): the reason is the repository's.
    await setMcpWrite("off");
    const url2 = await start(ENFORCE);
    const c2 = await connect(url2, tok);
    expect(
      (await call(c2, "open_change", { repository: FULL, head: "feat/mcp", title: "x" })).out,
    ).toEqual({
      error: "mcp_write_off",
      detail: "repository",
    });
    // On, but without pull_requests:write: the missing permission is named.
    await setMcpWrite("on");
    await t.db
      .updateTable("installations")
      .set({ permissions: JSON.stringify({ ...PERMISSIONS, pull_requests: "read" }) })
      .execute();
    expect(
      (await call(c2, "open_change", { repository: FULL, head: "feat/mcp", title: "x" })).out,
    ).toEqual({
      error: "mcp_write_off",
      detail: "permission_missing pull_requests:write",
    });
    expect(api.requests.length).toBe(before);
  });

  it("I-MCP-10 report mode refused: the write step with an mcp client while mcp_write is off → MutationRefusedError mode_off before any request", async () => {
    await setMcpWrite("on");
    const factory = factoryFor(testConfig());
    const mcp = await factory.forInstallation(INSTALLATION_ID, { feature: "mcp" });
    const err = await mcp.rest.pulls
      .create({
        owner: OWNER,
        repo: REPO,
        title: "t",
        body: "b",
        head: "feat/mcp",
        base: "main",
        draft: false,
        maintainer_can_modify: false,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MutationRefusedError);
    expect((err as MutationRefusedError).refusal).toBe("mode_off");
    expect(api.requests).toEqual([]);
  });

  it("I-MCP-11 open_change enforcing: one POST /pulls with exactly the §7 body, the trailer block last; an mcp_changes row; the URL from stored values; repeated → existing; a 422 already exists → adopted; only Graft's own PR is adopted, never a person's or another bot's", async () => {
    await setMcpWrite("on");
    const { token: tok, id: tokenId } = await token();
    const url = await start(ENFORCE_APP);
    const c = await connect(url, tok);
    const res = await call(c, "open_change", {
      repository: FULL,
      head: "feat/mcp",
      title: `  ${TITLE_SENTINEL}  `,
      body: `${BODY_SENTINEL} adds x.`,
      draft: true,
      provenance: {
        agent: AGENT_SENTINEL,
        model: "claude-sonnet-5-5",
        task: "not a valid task!",
        sessionUrl: "https://claude.ai/code/session/abc",
      },
    });
    expect(res.isError, res.text).toBe(false);
    const pulls = api.find("POST", /\/pulls$/);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]?.body).toEqual({
      title: TITLE_SENTINEL,
      body: `${BODY_SENTINEL} adds x.\n\nGraft-Agent: ${AGENT_SENTINEL}\nGraft-Model: claude-sonnet-5-5\nGraft-Session: https://claude.ai/code/session/abc`,
      head: "feat/mcp",
      base: "main",
      draft: true,
      maintainer_can_modify: false,
    });
    const n = res.out.prNumber as number;
    expect(res.out).toEqual({
      prNumber: n,
      url: `https://github.com/${FULL}/pull/${n}`,
      headSha: FEAT_SHA,
      existing: false,
      warnings: ["provenance.task dropped: invalid value"],
    });
    const rows = await t.db.selectFrom("mcp_changes").selectAll().execute();
    expect(rows.map((r) => [r.repository_id, r.token_id, r.pr_number, r.head_sha])).toEqual([
      [REPO_ID, tokenId, n, FEAT_SHA],
    ]);
    expect(features).toContain("mcp");
    expect(features.filter((f) => f === "mcp")).toHaveLength(1);
    // The title and body went to GitHub only: not in the result, not stored.
    expect(res.text).not.toContain(TITLE_SENTINEL);
    expect(JSON.stringify(rows)).not.toContain(TITLE_SENTINEL);

    // Repeated: the open PR is returned, nothing written.
    const writesBefore = writes().length;
    const again = await call(c, "open_change", { repository: FULL, head: "feat/mcp", title: "x" });
    expect(again.out).toMatchObject({ prNumber: n, existing: true, headSha: FEAT_SHA });
    expect(writes().length).toBe(writesBefore);
    expect(await t.db.selectFrom("mcp_changes").selectAll().execute()).toHaveLength(1);
    // A row lost after the create (a crash) is restored by the retry that finds the bot's PR.
    await t.db.deleteFrom("mcp_changes").execute();
    expect(
      (await call(c, "open_change", { repository: FULL, head: "feat/mcp", title: "x" })).out,
    ).toMatchObject({ prNumber: n, existing: true });
    expect(
      (await t.db.selectFrom("mcp_changes").select("pr_number").execute()).map((r) => r.pr_number),
    ).toEqual([n]);
    // A person's open PR for a branch is returned as it is, and never marked as opened by MCP.
    api.state.branches.set("feat/human", fakeSha(0xbeb));
    api.state.pulls.set(778, {
      ...(api.state.pulls.get(n) as NonNullable<ReturnType<typeof api.state.pulls.get>>),
      number: 778,
      node_id: "PR_fake778",
      user: { id: 77, login: "alice", type: "User" },
      head: { sha: fakeSha(0xbeb), ref: "feat/human" },
    });
    expect(
      (await call(c, "open_change", { repository: FULL, head: "feat/human", title: "x" })).out,
    ).toMatchObject({ prNumber: 778, existing: true });
    expect(await t.db.selectFrom("mcp_changes").selectAll().execute()).toHaveLength(1);
    // Another bot's open PR (Renovate) is returned too, and never marked either.
    api.state.branches.set("renovate/x", fakeSha(0xbec));
    api.state.pulls.set(779, {
      ...(api.state.pulls.get(n) as NonNullable<ReturnType<typeof api.state.pulls.get>>),
      number: 779,
      node_id: "PR_fake779",
      user: { id: 78, login: "renovate[bot]", type: "Bot" },
      head: { sha: fakeSha(0xbec), ref: "renovate/x" },
    });
    expect(
      (await call(c, "open_change", { repository: FULL, head: "renovate/x", title: "x" })).out,
    ).toMatchObject({ prNumber: 779, existing: true });
    expect(await t.db.selectFrom("mcp_changes").selectAll().execute()).toHaveLength(1);
    // Without GITHUB_APP_SLUG Graft cannot tell its own PR: a lost row is not restored.
    const noSlug = await connect(await start(ENFORCE), tok);
    await t.db.deleteFrom("mcp_changes").execute();
    expect(
      (await call(noSlug, "open_change", { repository: FULL, head: "feat/mcp", title: "x" })).out,
    ).toMatchObject({ prNumber: n, existing: true });
    expect(await t.db.selectFrom("mcp_changes").selectAll().execute()).toEqual([]);
    await insertMcpChange(t.db, {
      repositoryId: REPO_ID,
      tokenId,
      prNumber: n,
      headSha: FEAT_SHA,
    });

    // A race: the PR appears between the lookup and the create (422 "already exists").
    api.state.branches.set("feat/race", fakeSha(0xace));
    api.afterNext("GET", /\/pulls$/, async () => {
      api.state.pulls.set(777, {
        ...(api.state.pulls.get(n) as NonNullable<ReturnType<typeof api.state.pulls.get>>),
        number: 777,
        node_id: "PR_fake777",
        head: { sha: fakeSha(0xace), ref: "feat/race" },
      });
    });
    const raced = await call(c, "open_change", { repository: FULL, head: "feat/race", title: "x" });
    expect(raced.out).toMatchObject({ prNumber: 777, existing: true, headSha: fakeSha(0xace) });
    expect(api.find("POST", /\/pulls$/)).toHaveLength(2);
    // The adopted PR is the bot's: recorded, so D19 applies to it.
    expect(
      (await t.db.selectFrom("mcp_changes").select("pr_number").orderBy("pr_number").execute()).map(
        (r) => r.pr_number,
      ),
    ).toEqual([n, 777]);
  });

  it("I-MCP-12 open_change refusals with no write: invalid_head (default branch, graft-revert/x), head_not_found, base_not_found, the hourly cap (the 11th open, two server instances)", async () => {
    await setMcpWrite("on");
    const { token: tok } = await token();
    const url = await start(ENFORCE);
    const url2 = await start(ENFORCE);
    const c = await connect(url, tok);
    const c2 = await connect(url2, tok);
    const open = (h: McpClientHandle, args: Record<string, unknown>) =>
      call(h, "open_change", { repository: FULL, title: "x", ...args });
    for (const head of ["main", "graft-revert/x", "owner:feat", "../x", "x.lock"]) {
      expect((await open(c, { head })).out, head).toEqual({ error: "invalid_head" });
    }
    expect((await open(c, { head: "feat/missing" })).out).toEqual({ error: "head_not_found" });
    expect((await open(c, { head: "feat/mcp", base: "nope" })).out).toEqual({
      error: "base_not_found",
    });
    expect((await open(c, { head: "feat/mcp", base: "-bad" })).out).toEqual({
      error: "base_not_found",
    });
    expect(writes()).toEqual([]);
    expect(features.filter((f) => f === "mcp")).toEqual([]);

    // Ten opens across two processes, then the eleventh is refused.
    for (let i = 1; i <= 10; i++) {
      api.state.branches.set(`feat/${i}`, fakeSha(0x1000 + i));
      const res = await open(i % 2 === 0 ? c : c2, { head: `feat/${i}` });
      expect(res.out.existing, `open ${i} ${res.text}`).toBe(false);
    }
    api.state.branches.set("feat/11", fakeSha(0x100b));
    const before = writes().length;
    expect((await open(c, { head: "feat/11" })).out).toEqual({ error: "rate_limited" });
    expect((await open(c2, { head: "feat/11" })).out).toEqual({ error: "rate_limited" });
    expect(writes().length).toBe(before);
    // An hour later the slots are free again.
    await t.db
      .updateTable("mcp_changes")
      .set({ created_at: new Date(Date.now() - 2 * 3600_000) })
      .execute();
    expect((await open(c, { head: "feat/11" })).out.existing).toBe(false);
  });

  it("I-MCP-13 a rollback mid-call: mcp_write set off after the early read → the gate refuses, mcp_write_off mode_changed, no mcp_changes row", async () => {
    await setMcpWrite("on");
    const { token: tok } = await token();
    const url = await start(ENFORCE);
    const c = await connect(url, tok);
    // The last read before the write is the lookup by head.
    api.afterNext("GET", /\/pulls$/, async () => {
      await setMcpWrite("off");
    });
    const res = await call(c, "open_change", { repository: FULL, head: "feat/mcp", title: "x" });
    expect(res.out).toEqual({ error: "mcp_write_off", detail: "mode_changed" });
    expect(api.find("POST", /\/pulls$/)).toEqual([]);
    expect(refused.map((e) => e.refusal)).toEqual(["mode_off"]);
    expect(await t.db.selectFrom("mcp_changes").selectAll().execute()).toEqual([]);
  });

  it("I-MCP-14 self-approval (D19): the commit author and committer of an MCP-opened PR do not count; another reviewer does; more than 250 commits or a commit with a null author → no approval counts", async () => {
    const { id: tokenId } = await token();
    await seedPr();
    await t.db
      .insertInto("mcp_changes")
      .values({
        repository_id: REPO_ID,
        token_id: tokenId,
        pr_number: PR_NUMBER,
        head_sha: HEAD_SHA,
      })
      .execute();
    const withLogins = (author: string | null, committer = "web-flow") => [
      {
        ...makeCommit(HEAD_SHA, commitMessage("Fix", undefined, [["Graft-Agent", "claude-code"]])),
        author: author === null ? null : { login: author },
        committer: { login: committer },
      },
    ];
    api.state.commits.set(PR_NUMBER, withLogins("alice") as never);
    for (const [login, id] of [
      ["alice", 601],
      ["bob", 602],
      ["carol", 603],
    ] as const) {
      api.state.permissions.set(login, { id, role: "write" });
    }
    const approvals = async () =>
      (await latestVerdict()).approvals as { current: number; truncated: boolean };
    const ctx = ctxFor();

    api.state.reviews.set(PR_NUMBER, [makeReview({ id: 1, login: "alice", userId: 601 })]);
    await evaluatePolicyJobRun({ ...POLICY_RUN, trigger: "review" }, ctx);
    expect(await approvals()).toMatchObject({ current: 0, truncated: false });

    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 1, login: "alice", userId: 601 }),
      makeReview({ id: 2, login: "bob", userId: 602 }),
    ]);
    await evaluatePolicyJobRun({ ...POLICY_RUN, trigger: "review" }, ctx);
    expect(await approvals()).toMatchObject({ current: 1, users: ["bob"], truncated: false });

    // A committer is excluded like an author: carol committed alice's commit.
    api.state.commits.set(PR_NUMBER, withLogins("alice", "carol") as never);
    api.state.reviews.set(PR_NUMBER, [
      makeReview({ id: 3, login: "carol", userId: 603 }),
      makeReview({ id: 2, login: "bob", userId: 602 }),
    ]);
    await evaluatePolicyJobRun({ ...POLICY_RUN, trigger: "review" }, ctx);
    expect(await approvals()).toMatchObject({ current: 1, users: ["bob"], truncated: false });

    // More than 250 commits (GitHub lists at most 250): nobody can be ruled out, no approval counts.
    const pull = api.state.pulls.get(PR_NUMBER);
    if (!pull) throw new Error("no pull");
    pull.commits = 260;
    api.state.commits.set(
      PR_NUMBER,
      Array.from({ length: 260 }, () => withLogins("alice")[0]) as never,
    );
    await evaluatePolicyJobRun({ ...POLICY_RUN, trigger: "review" }, ctx);
    expect(await approvals()).toMatchObject({ current: 0, truncated: true });
    pull.commits = 1;

    api.state.commits.set(PR_NUMBER, withLogins(null) as never);
    await evaluatePolicyJobRun({ ...POLICY_RUN, trigger: "review" }, ctx);
    expect(await approvals()).toMatchObject({ current: 0, truncated: true });
    // Logins only were read: the commits listing, never a commit's content.
    expect(api.find("GET", /\/pulls\/2\/commits$/).length).toBeGreaterThan(0);
  });

  it("I-MCP-15 transfer (D12): the repository moves to another installation → every active token revoked by system, and the next call → 401; a re-add revokes too", async () => {
    const a = await token();
    const b = await token(REPO_ID, "second");
    const url = await start();
    expect((await rawPost(url, LIST_TOOLS, { authorization: `Bearer ${a.token}` })).status).toBe(
      200,
    );
    await t.db
      .insertInto("installations")
      .values({
        id: INSTALLATION_ID + 1,
        account_id: 9_000_002,
        account_login: "new-owner",
        account_type: "Organization",
        repository_selection: "selected",
      })
      .execute();
    await t.db
      .transaction()
      .execute((tx) =>
        upsertRepositories(
          tx,
          INSTALLATION_ID + 1,
          [{ id: REPO_ID, fullName: FULL, private: true }],
          new Date(),
        ),
      );
    const rows = await t.db
      .selectFrom("mcp_tokens")
      .select(["id", "revoked_by", "revoke_reason"])
      .where("repository_id", "=", REPO_ID)
      .orderBy("id")
      .execute();
    expect(rows.map((r) => [r.revoked_by, r.revoke_reason])).toEqual([
      ["system", "repository_transferred"],
      ["system", "repository_transferred"],
    ]);
    for (const tok of [a, b]) {
      expect(
        (await rawPost(url, LIST_TOOLS, { authorization: `Bearer ${tok.token}` })).status,
      ).toBe(401);
    }
    // A rename within the same installation keeps tokens; a removal and re-add revokes them.
    const c = await token(REPO_B, "b");
    await t.db
      .transaction()
      .execute((tx) =>
        upsertRepositories(
          tx,
          INSTALLATION_ID,
          [{ id: REPO_B, fullName: `${OWNER}/renamed`, private: true }],
          new Date(),
        ),
      );
    expect((await rawPost(url, LIST_TOOLS, { authorization: `Bearer ${c.token}` })).status).toBe(
      200,
    );
    await t.db
      .updateTable("repositories")
      .set({ removed_at: new Date() })
      .where("id", "=", REPO_B)
      .execute();
    await t.db
      .transaction()
      .execute((tx) =>
        upsertRepositories(
          tx,
          INSTALLATION_ID,
          [{ id: REPO_B, fullName: `${OWNER}/renamed`, private: true }],
          new Date(),
        ),
      );
    const readded = await t.db
      .selectFrom("mcp_tokens")
      .select("revoke_reason")
      .where("id", "=", c.id)
      .executeTakeFirstOrThrow();
    expect(readded.revoke_reason).toBe("repository_readded");
  });

  it("I-MCP-16 never logged: no token, token hash, PR title or body sentinel, or provenance value sentinel in the logs; the SDK onerror path logs a sanitised error", async () => {
    const { token: tok } = await token();
    const url = await start();
    // A JSON-RPC message the SDK rejects, carrying the token and a sentinel in its body.
    const res = await rawPost(
      url,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: 7, arguments: { x: tok, y: BODY_SENTINEL } },
      },
      { authorization: `Bearer ${tok}` },
    );
    expect(res.status).toBeLessThan(500);
    // Not a JSON-RPC message: the SDK rejects it and reports it through onerror.
    const bad = await rawPost(
      url,
      { foo: tok, bar: BODY_SENTINEL },
      { authorization: `Bearer ${tok}` },
    );
    expect(bad.status).toBe(400);
    // The SDK reported them through onerror, logged sanitised.
    expect(logged).toContain('"msg":"mcp sdk error"');
    // An SDK error whose message holds the token (an unsupported protocol version header echoes
    // it): the onerror line holds the redacted form only.
    const echoed = await rawPost(url, LIST_TOOLS, {
      authorization: `Bearer ${tok}`,
      "mcp-protocol-version": tok,
    });
    expect(echoed.status).toBe(400);
    const sdkLines = logged.split("\n").filter((l) => l.includes('"msg":"mcp sdk error"'));
    expect(sdkLines.some((l) => l.includes("graft_mcp_[redacted]"))).toBe(true);

    // A tool that fails with an error that is no ToolError, shaped like an Octokit error: its
    // message holds the token, its request body a PR body; the call's argument holds a sentinel.
    api.state.branches.set(ARG_SENTINEL, fakeSha(0xba5e));
    failModesRead = Object.assign(new Error(`boom ${tok}`), {
      status: 500,
      request: {
        method: "POST",
        url: `https://api.github.com/repos/${FULL}/pulls`,
        body: JSON.stringify({ title: TITLE_SENTINEL, body: BODY_SENTINEL }),
      },
    });
    const c = await connect(url, tok);
    const failed = await call(c, "get_policy", { repository: FULL, base: ARG_SENTINEL });
    expect(failed.out).toEqual({ error: "internal" });
    expect(failModesRead).toBeNull();
    const toolLines = logged.split("\n").filter((l) => l.includes('"msg":"mcp tool failed"'));
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0]).toContain("graft_mcp_[redacted]");
    expect(toolLines[0]).toContain('"tool":"get_policy"');
    for (const s of [ARG_SENTINEL, TITLE_SENTINEL, BODY_SENTINEL]) {
      expect(logged.includes(s), s).toBe(false);
    }
    expect(logged.length).toBeGreaterThan(0);
    for (const s of [...secrets, TITLE_SENTINEL, BODY_SENTINEL, AGENT_SENTINEL]) {
      expect(logged.includes(s), s.slice(0, 16)).toBe(false);
    }
    expect(logged).not.toMatch(/graft_mcp_[A-Za-z0-9_-]{43}/);
    // The AuthInfo handed to the SDK (and so to every tool) never holds the secret (D7).
    const auth = await authorizeToken(t.db, tok);
    expect(auth?.token).toBe("[redacted]");
    expect(JSON.stringify(auth)).not.toContain(tok.slice(10));
    expect(JSON.stringify(auth)).not.toContain(hashToken(tok));
    // Tool arguments never reach a log line.
    expect(logged).not.toContain("not a valid task!");
    expect(logged).not.toContain("gpt-5-codex");
    // Every mcp error line holds metadata only (no stack frames with request text).
    for (const line of logged
      .split("\n")
      .filter((l) => l.includes("mcp sdk error") || l.includes("mcp tool failed"))) {
      const parsed = JSON.parse(line) as { err?: { message?: string } };
      expect(parsed.err?.message ?? "").not.toMatch(/graft_mcp_[A-Za-z0-9_-]{43}/);
    }
  });

  it("I-MCP-17 CLI: create prints the token once and stores only its hash; duplicate name, cap, unknown repository → exit 1; list has no hash; revoke twice → 0; mode show line; doctor warnings with exit 0", async () => {
    const run = async (cfg: Record<string, string>, ...argv: string[]) => {
      let out = "";
      let err = "";
      const deps: OpsDeps = {
        loadConfig: () => testConfig(cfg),
        openDb: () => testDb(),
        github: () => fakeGitHubFactory(api),
        now: () => new Date(),
        sleep: async () => {},
      };
      const code = await opsMain(argv, { out: (s) => (out += s), err: (s) => (err += s) }, deps);
      return { code, out, err };
    };
    const cap = { GRAFT_MCP_MAX_TOKENS_PER_REPO: "2" };
    const created = await run(
      cap,
      "mcp-token",
      "create",
      "--repo",
      FULL,
      "--name",
      "codex ci",
      "--actor",
      "ops",
    );
    expect(created.code, created.err).toBe(0);
    const lines = created.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const tok = lines[0] as string;
    expect(tok).toMatch(/^graft_mcp_[A-Za-z0-9_-]{43}$/);
    secrets.push(tok, hashToken(tok));
    expect(lines[1]).toMatch(
      /^id [0-9a-f-]{36} {2}expires \d{4}-\d{2}-\d{2} {2}shown once; store it now$/,
    );
    const stored = await t.db.selectFrom("mcp_tokens").selectAll().execute();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).toBe(hashToken(tok));
    expect(stored[0]?.created_by).toBe("ops");
    expect(JSON.stringify(stored)).not.toContain(tok.slice(10));
    // The token works.
    const url = await start();
    expect((await rawPost(url, LIST_TOOLS, { authorization: `Bearer ${tok}` })).status).toBe(200);

    const dup = await run(cap, "mcp-token", "create", "--repo", FULL, "--name", "codex ci");
    expect([dup.code, dup.out]).toEqual([1, ""]);
    expect(dup.err).toContain("already active");
    expect(
      (await run(cap, "mcp-token", "create", "--repo", FULL, "--name", "two", "--expires-in", "3"))
        .code,
    ).toBe(0);
    const capped = await run(cap, "mcp-token", "create", "--repo", FULL, "--name", "three");
    expect([capped.code, capped.out]).toEqual([1, ""]);
    expect(capped.err).toContain("maximum of 2");
    const unknown = await run(
      cap,
      "mcp-token",
      "create",
      "--repo",
      "nobody/nothing",
      "--name",
      "x",
    );
    expect([unknown.code, unknown.out]).toEqual([1, ""]);
    expect(
      (await run(cap, "mcp-token", "create", "--repo", FULL, "--name", "x", "--expires-in", "366"))
        .code,
    ).toBe(2);
    expect(await t.db.selectFrom("mcp_tokens").selectAll().execute()).toHaveLength(2);

    const list = await run({}, "mcp-token", "list", "--repo", FULL);
    expect(list.code).toBe(0);
    expect(list.out).toContain(`graft_mcp_${tok.slice(10, 18)}…`);
    expect(list.out).toContain('"codex ci"');
    const json = await run({}, "mcp-token", "list", "--repo", FULL, "--json");
    const parsed = JSON.parse(json.out) as Record<string, unknown>[];
    expect(parsed).toHaveLength(2);
    expect(Object.keys(parsed[0] ?? {}).sort()).toEqual([
      "createdAt",
      "createdBy",
      "expiresAt",
      "id",
      "lastUsedAt",
      "name",
      "prefix",
      "revokeReason",
      "revokedAt",
      "revokedBy",
    ]);
    for (const out of [list.out, json.out]) {
      for (const row of stored) expect(out).not.toContain(row.token_hash);
      expect(out).not.toContain(tok);
    }
    expect(parsed.find((p) => p.name === "codex ci")?.lastUsedAt).not.toBeNull();

    const id = stored[0]?.id as string;
    expect(
      (await run({}, "mcp-token", "revoke", "--id", id, "--reason", "rotated", "--actor", "ops"))
        .code,
    ).toBe(0);
    expect((await run({}, "mcp-token", "revoke", "--id", id, "--reason", "rotated")).code).toBe(0);
    expect(
      (
        await run(
          {},
          "mcp-token",
          "revoke",
          "--id",
          "00000000-0000-4000-8000-000000000000",
          "--reason",
          "x",
        )
      ).code,
    ).toBe(1);
    expect((await rawPost(url, LIST_TOOLS, { authorization: `Bearer ${tok}` })).status).toBe(401);
    const all = JSON.parse(
      (await run({}, "mcp-token", "list", "--repo", FULL, "--all", "--json")).out,
    ) as Record<string, unknown>[];
    expect(all.find((p) => p.id === id)).toMatchObject({
      revokedBy: "ops",
      revokeReason: "rotated",
    });
    expect(
      JSON.parse((await run({}, "mcp-token", "list", "--repo", FULL, "--json")).out),
    ).toHaveLength(1);

    const show = await run({}, "mode", "show", "--repo", FULL);
    expect(show.out).toContain("  mcp tokens  1 active (never used)\n");

    // Doctor: the 3-day token expires within 7 days; an unused one older than 14 days.
    await t.db
      .insertInto("mcp_tokens")
      .values({
        repository_id: REPO_ID,
        name: "old",
        token_hash: "e".repeat(64),
        token_prefix: "abcdEFGH",
        created_by: "ops",
        created_at: new Date(Date.now() - 20 * 86_400_000),
        expires_at: new Date(Date.now() + 30 * 86_400_000),
      })
      .execute();
    await addDelivery(t.db, {
      id: "d-mcp-doctor",
      installationId: INSTALLATION_ID,
      repositoryId: null,
      at: new Date(),
    });
    const doctor = await run({}, "pilot", "doctor", "--installation", String(INSTALLATION_ID));
    expect(doctor.code, doctor.out).toBe(0);
    expect(doctor.out).toContain("WARN  mcp_tokens_expiring");
    expect(doctor.out).toContain("1 MCP tokens expiring within 7 days");
    expect(doctor.out).toContain("1 MCP tokens never used, older than 14 days");
  });

  it("I-MCP-18 GRAFT_MCP=off → /mcp is 404; the CLI still works", async () => {
    const { token: tok } = await token();
    const url = await start({ GRAFT_MCP: "off" });
    const res = await rawPost(url, LIST_TOOLS, { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    let out = "";
    const deps: OpsDeps = {
      loadConfig: () => testConfig({ GRAFT_MCP: "off" }),
      openDb: () => testDb(),
      github: () => fakeGitHubFactory(api),
      now: () => new Date(),
      sleep: async () => {},
    };
    const io = { out: (s: string) => (out += s), err: (s: string) => (out += s) };
    expect(await opsMain(["mcp-token", "list", "--repo", FULL], io, deps)).toBe(0);
    expect(await opsMain(["mode", "show", "--repo", FULL], io, deps)).toBe(0);
    expect(out).toContain("note: the MCP endpoint is off on this shell's config");
  });

  it("I-MCP-19 no code read: across this file no request to /contents/ other than graft.yaml, /git/blobs, /compare/, a REST commit, or a .diff/.patch media type", () => {
    expect(allRequests.length).toBeGreaterThan(20);
    for (const r of allRequests) {
      const where = `${r.method} ${r.path}`;
      if (r.path.includes("/contents/")) expect(r.path, where).toMatch(/\/contents\/graft\.yaml$/);
      expect(r.path, where).not.toMatch(/\/git\/blobs/);
      expect(r.path, where).not.toMatch(/\/compare\//);
      expect(r.path, where).not.toMatch(/\/commits\/[0-9a-f]{40}$/);
      expect(r.accept ?? "", where).not.toMatch(/diff|patch/);
    }
  });
});
