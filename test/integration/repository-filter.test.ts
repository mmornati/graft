import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { forToken } from "../../src/github/client-factory.js";
import { buildServer } from "../../src/http/server.js";
import { trackInstallations } from "../../src/modules/installations/handlers.js";
import {
  markRepositoriesRemoved,
  upsertRepositories,
} from "../../src/modules/installations/store.js";
import { repositoryEnabled } from "../../src/modules/repositories/filter.js";
import { defineJob } from "../../src/queue/job.js";
import { createTestApp, jobContext, postFixture, type TestApp } from "../helpers/app.js";
import { FIXED_NOW, testConfig } from "../helpers/config.js";
import { truncateAll } from "../helpers/db.js";
import { loadFixture } from "../helpers/fixtures.js";

const SECRET = "console-test-secret-".repeat(3);
const USER = { login: "operator", id: 7 };
const REPO = "graft-sandbox/sample-ts";
const FORK = "graft-sandbox/sample-fork";
let admin = true;
let member = true;
let githubFails = false;
let t: TestApp;
let app: Awaited<ReturnType<typeof buildServer>>;
let requests: string[] = [];

const github = forToken("test-token", {
  fetch: async (input) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    if (githubFails) return Response.json({ message: "unavailable" }, { status: 503 });
    if (url.pathname === "/users/operator") return Response.json(USER);
    if (url.pathname.endsWith("/collaborators/operator/permission")) {
      return Response.json({ permission: admin ? "admin" : "write", user: { ...USER } });
    }
    if (url.pathname === "/orgs/graft-sandbox/memberships/operator") {
      return member
        ? Response.json({ state: "active", role: "member" })
        : Response.json({}, { status: 404 });
    }
    if (
      url.pathname === `/repos/${REPO}/installation` ||
      url.pathname === `/repos/${FORK}/installation`
    )
      return Response.json({ id: 1000001 });
    if (url.pathname.endsWith("/installation")) return Response.json({}, { status: 404 });
    if (url.pathname === `/repos/${REPO}`)
      return Response.json({
        id: 2000001,
        full_name: REPO,
        owner: { login: "graft-sandbox" },
        private: true,
      });
    if (url.pathname === `/repos/${FORK}`)
      return Response.json({
        id: 2000002,
        full_name: FORK,
        owner: { login: "graft-sandbox" },
        private: true,
        fork: true,
      });
    if (url.pathname === "/search/repositories")
      return Response.json({
        items: [
          { id: 2000001, full_name: REPO },
          ...(url.searchParams.get("q")?.split(" ").includes("fork:true")
            ? [{ id: 2000002, full_name: FORK }]
            : []),
          { id: 33, full_name: "graft-sandbox/public-outside" },
        ],
        total_count: 2000,
        incomplete_results: false,
      });
    throw new Error(`Unexpected GitHub route: ${url.pathname}`);
  },
});

beforeAll(async () => {
  t = await createTestApp({
    config: { GRAFT_REPOSITORY_FILTER: "on", GRAFT_CONSOLE_SECRET: SECRET },
    github: { asApp: () => github, forInstallation: async () => github },
  });
  app = await buildServer(t.deps);
});
afterAll(async () => {
  await app.close();
  await t.close();
});
beforeEach(async () => {
  t.deps.config = testConfig({ GRAFT_REPOSITORY_FILTER: "on", GRAFT_CONSOLE_SECRET: SECRET });
  admin = true;
  member = true;
  githubFails = false;
  requests = [];
  await truncateAll(t.db);
  const { event, payload } = loadFixture("installation.created");
  await trackInstallations.handle({ id: "install", name: event, payload } as never, jobContext(t));
});

function call(action: string, body: object, opts: { time?: number; signature?: string } = {}) {
  const path = `/internal/console/${action}`;
  const timestamp = String(opts.time ?? FIXED_NOW.getTime());
  const payload = JSON.stringify(body);
  const signature =
    opts.signature ??
    createHmac("sha256", SECRET).update(`${timestamp}\nPOST\n${path}\n${payload}`).digest("hex");
  return app.inject({
    method: "POST",
    url: path,
    payload,
    headers: {
      "content-type": "application/json",
      "x-graft-console-time": timestamp,
      "x-graft-console-signature": signature,
    },
  });
}
const enable = () => call("activation", { user: USER, repository: REPO, enabled: true });

describe("repository activation", () => {
  it("paginates repository permission checks and bypasses cached permissions for mutations", async () => {
    await upsertRepositories(
      t.db,
      1000001,
      Array.from({ length: 60 }, (_, index) => ({
        id: 2001000 + index,
        fullName: `graft-sandbox/repo-${index}`,
        private: true,
      })),
      FIXED_NOW,
    );
    const first = await call("billing/repositories", { user: USER, after: 0 });
    expect(first.statusCode).toBe(200);
    expect(first.json().repositories).toHaveLength(50);
    expect(first.json().next).toBe(2001047);
    const permissionRequests = () =>
      requests.filter((request) => request.endsWith("/collaborators/operator/permission")).length;
    const countAfterFirstPage = permissionRequests();
    expect(countAfterFirstPage).toBe(50);

    admin = false;
    const denied = await call("billing/repository", {
      user: USER,
      teamId: "00000000-0000-4000-8000-000000000001",
      repositoryId: 2001000,
      attached: true,
    });
    expect(denied.statusCode).toBe(403);
    expect(permissionRequests()).toBe(countAfterFirstPage + 1);
    admin = true;

    const second = await call("billing/repositories", {
      user: USER,
      after: first.json().next,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().repositories).toHaveLength(12);
    expect(second.json().next).toBeNull();
    const repeated = await call("billing/repositories", { user: USER, after: 0 });
    expect(repeated.statusCode).toBe(200);
    expect(permissionRequests()).toBe(64);
  });

  it("keeps historical statement access when no active installation remains", async () => {
    await t.db
      .updateTable("installations")
      .set({ deleted_at: FIXED_NOW })
      .where("id", "=", 1000001)
      .execute();
    const statement = await call("billing/statement", { user: USER, month: "2026-10" });
    expect(statement.statusCode).toBe(200);
    expect(statement.json()).toMatchObject({ month: "2026-10", lines: [] });
  });

  it("allows repository administrators to manage chargeback memberships", async () => {
    const created = await call("billing/create", { user: USER, name: "Platform" });
    expect(created.statusCode).toBe(200);
    const teamId = created.json().id as string;

    admin = false;
    const denied = await call("billing/repository", {
      user: USER,
      teamId,
      repositoryId: 2000001,
      attached: true,
    });
    expect(denied.statusCode).toBe(403);
    expect(await t.db.selectFrom("billing_team_repositories").selectAll().execute()).toEqual([]);

    admin = true;
    const attached = await call("billing/repository", {
      user: USER,
      teamId,
      repositoryId: 2000001,
      attached: true,
    });
    expect(attached.statusCode).toBe(200);
    const permissionRequests = requests.filter((request) =>
      request.endsWith("/collaborators/operator/permission"),
    ).length;
    const teams = await call("billing/teams", { user: USER });
    expect(
      requests.filter((request) => request.endsWith("/collaborators/operator/permission")),
    ).toHaveLength(permissionRequests);
    expect(teams.json()).toMatchObject([
      {
        id: teamId,
        name: "Platform",
        repositories: [{ id: 2000001, fullName: REPO }],
      },
    ]);

    const statement = await call("billing/statement", { user: USER, month: "2026-10" });
    expect(statement.statusCode).toBe(200);
    expect(statement.json()).toMatchObject({
      month: "2026-10",
      closedAt: null,
      lines: [],
    });
  });

  it("matches allowed installation accounts case-insensitively", async () => {
    t.deps.config = testConfig({
      GRAFT_REPOSITORY_FILTER: "on",
      GRAFT_CONSOLE_SECRET: SECRET,
      GRAFT_ALLOWED_ACCOUNTS: "GRAFT-SANDBOX",
    });
    await t.db
      .updateTable("installations")
      .set({ account_login: "Graft-Sandbox" })
      .where("id", "=", 1000001)
      .execute();
    const result = await call("repositories", { user: USER });
    expect(result.statusCode).toBe(200);
    expect(result.json().accounts).toEqual(["Graft-Sandbox"]);
  });
  it("rejects forged, stale and body-tampered console requests before touching GitHub", async () => {
    expect(
      (await call("repositories", { user: USER }, { signature: "0".repeat(64) })).statusCode,
    ).toBe(401);
    expect(
      (await call("repositories", { user: USER }, { time: FIXED_NOW.getTime() - 31_000 }))
        .statusCode,
    ).toBe(401);
    expect(requests).toEqual([]);
  });

  it("requires admin on enable and disable, persists idempotently and audits changes", async () => {
    admin = false;
    expect((await enable()).statusCode).toBe(403);
    expect(await repositoryEnabled(t.db, t.deps.config, 2000001)).toBe(false);
    admin = true;
    expect((await enable()).statusCode).toBe(200);
    expect((await enable()).statusCode).toBe(200);
    expect(await repositoryEnabled(t.db, t.deps.config, 2000001)).toBe(true);
    expect(await t.db.selectFrom("repository_filter_changes").selectAll().execute()).toHaveLength(
      1,
    );
    expect(
      (await call("activation", { user: USER, repository: REPO, enabled: false })).statusCode,
    ).toBe(400);
    admin = false;
    expect(
      (
        await call("activation", {
          user: USER,
          repository: REPO,
          enabled: false,
          confirmation: REPO,
        })
      ).statusCode,
    ).toBe(403);
    expect(await repositoryEnabled(t.db, t.deps.config, 2000001)).toBe(true);
    admin = true;
    expect(
      (
        await call("activation", {
          user: USER,
          repository: REPO,
          enabled: false,
          confirmation: REPO,
        })
      ).statusCode,
    ).toBe(200);
    expect(await repositoryEnabled(t.db, t.deps.config, 2000001)).toBe(false);
    expect(await t.db.selectFrom("repository_filter_changes").selectAll().execute()).toHaveLength(
      2,
    );
  });

  it("lists enabled repositories and searches GitHub pages including installed forks", async () => {
    await enable();
    admin = false;
    const list = await call("repositories", { user: USER });
    expect(list.json()).toMatchObject({
      filtering: true,
      accounts: ["graft-sandbox"],
      repositories: [{ fullName: REPO, canAdmin: false }],
    });
    const result = await call("search", {
      user: USER,
      account: "graft-sandbox",
      query: "sample",
      page: 2,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      next: 3,
      repositories: [
        { fullName: REPO, enabled: true },
        { fullName: FORK, enabled: false },
      ],
    });
    expect(result.json().repositories).toHaveLength(2);
    const query = requests.find((r) => r.startsWith("/search/repositories")) as string;
    const params = new URL(`https://api.github.com${query}`).searchParams;
    expect(params.get("q")).toBe("sample in:name user:graft-sandbox fork:true");
    expect(params.get("per_page")).toBe("10");
    expect(params.get("page")).toBe("2");
    expect(
      (await call("search", { user: USER, account: "stranger", query: "sample" })).statusCode,
    ).toBe(403);
    expect(
      (await call("search", { user: USER, account: "graft-sandbox", query: "sample org:stranger" }))
        .statusCode,
    ).toBe(400);
  });

  it("checks active organization membership and rejects forged GitHub identities", async () => {
    expect((await call("access", { user: USER, organizations: ["graft-sandbox"] })).json()).toEqual(
      { allowed: true },
    );
    member = false;
    expect((await call("access", { user: USER, organizations: ["graft-sandbox"] })).json()).toEqual(
      { allowed: false },
    );
    expect(
      (await call("access", { user: { ...USER, id: 9 }, organizations: ["graft-sandbox"] }))
        .statusCode,
    ).toBe(403);
    githubFails = true;
    expect(
      (await call("access", { user: USER, organizations: ["graft-sandbox"] })).statusCode,
    ).toBe(503);
  });

  it("drops excluded webhooks while keeping lifecycle events, and skips already-queued repository jobs", async () => {
    expect((await postFixture(app, "pull_request.opened", "excluded")).json()).toEqual({
      status: "ignored",
    });
    expect(await t.db.selectFrom("webhook_deliveries").selectAll().execute()).toHaveLength(0);
    expect((await postFixture(app, "installation.suspend", "lifecycle")).json()).toEqual({
      status: "enqueued",
    });
    let handled = 0;
    const job = defineJob({
      name: "test.repo",
      schema: z.object({ repositoryId: z.number() }),
      async handle() {
        handled++;
      },
    });
    await job.handle({ repositoryId: 2000001 }, jobContext(t));
    expect(handled).toBe(0);
    await enable();
    await job.handle({ repositoryId: 2000001 }, jobContext(t));
    expect(handled).toBe(1);
    await call("activation", { user: USER, repository: REPO, enabled: false, confirmation: REPO });
    await job.handle({ repositoryId: 2000001 }, jobContext(t));
    expect(handled).toBe(1);
    expect(await repositoryEnabled(t.db, { repositoryFilter: false }, 2000001)).toBe(true);
  });

  it("does not carry activation through removal/re-addition or installation changes", async () => {
    await enable();
    await markRepositoriesRemoved(t.db, 1000001, [2000001], FIXED_NOW);
    await upsertRepositories(
      t.db,
      1000001,
      [{ id: 2000001, fullName: REPO, private: true }],
      FIXED_NOW,
    );
    expect(await repositoryEnabled(t.db, t.deps.config, 2000001)).toBe(false);
    await enable();
    expect(await repositoryEnabled(t.db, t.deps.config, 2000001, 99)).toBe(false);
  });
});
