import { describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, signSession } from "../../server/src/auth.js";
import { type GraftApi, GraftError, graftApi } from "../../server/src/graft.js";
import { fakeOAuth, githubConfig, SESSION_SECRET, testApp } from "../helpers.js";

const NOW = Date.UTC(2026, 10, 8, 12);
const USER = { login: "org-member", id: 7 };
const bridge = (): GraftApi => ({
  access: vi.fn(async () => ({ allowed: true })),
  repositories: vi.fn(async () => ({
    filtering: true,
    repositories: [],
    accounts: ["acme"],
    next: null,
  })),
  search: vi.fn(async () => ({ repositories: [], next: null, incomplete: false })),
  activation: vi.fn(async (_u, _r, enabled) => ({ enabled, filtering: true })),
  billingTeams: vi.fn(async () => []),
  billingRepositories: vi.fn(async (_u, after) => ({ after, repositories: [], next: null })),
  billingStatement: vi.fn(async (_u, month) => ({
    month,
    closedAt: null,
    closedBy: null,
    lines: [],
  })),
  billingChange: vi.fn(async (_u, action) => ({ action })),
});
const orgConfig = () =>
  githubConfig({
    CONSOLE_ALLOWED_USERS: "",
    CONSOLE_ALLOWED_ORGANIZATIONS: "acme",
    CONSOLE_GRAFT_URL: "https://graft.example.test",
    CONSOLE_GRAFT_SECRET: "k".repeat(40),
  });
const cookie = () =>
  `${SESSION_COOKIE}=${signSession(SESSION_SECRET, { ...USER, exp: NOW / 1000 + 3600 })}`;

describe("organization access and repository management", () => {
  it("accepts organization-only configuration and rejects an empty gate or incomplete bridge", () => {
    expect(orgConfig().auth).toMatchObject({ allowedUsers: [], allowedOrganizations: ["acme"] });
    expect(() => githubConfig({ CONSOLE_ALLOWED_USERS: "" })).toThrow(
      /CONSOLE_ALLOWED_USERS or CONSOLE_ALLOWED_ORGANIZATIONS/,
    );
    expect(() => githubConfig({ CONSOLE_GRAFT_URL: "https://graft.example.test" })).toThrow(
      /must be set together/,
    );
    expect(() => githubConfig({ CONSOLE_ALLOWED_ORGANIZATIONS: "acme" })).toThrow(
      /needs CONSOLE_GRAFT_URL/,
    );
  });

  it("accepts active members, expires the membership cache, and denies removed members", async () => {
    let now = NOW;
    const graft = bridge();
    const app = await testApp({ config: orgConfig(), graft, now: () => now });
    const first = await app.inject({ url: "/api/repositories", headers: { cookie: cookie() } });
    expect(first.statusCode).toBe(200);
    expect(graft.repositories).toHaveBeenCalledWith(USER, 0);
    expect(graft.access).toHaveBeenCalledTimes(1);
    await app.inject({ url: "/api/me", headers: { cookie: cookie() } });
    expect(graft.access).toHaveBeenCalledTimes(1);
    vi.mocked(graft.access).mockResolvedValue({ allowed: false });
    now += 61_000;
    expect((await app.inject({ url: "/api/me", headers: { cookie: cookie() } })).statusCode).toBe(
      401,
    );
    await app.close();
  });

  it("uses user OR organization access and does not turn a GitHub failure into permission", async () => {
    const graft = bridge();
    vi.mocked(graft.access).mockRejectedValue(new GraftError(503, "unavailable"));
    const config = orgConfig();
    if (config.auth.mode !== "github") throw new Error("expected GitHub");
    config.auth.allowedUsers = ["org-member"];
    const app = await testApp({ config, graft, now: () => NOW });
    expect((await app.inject({ url: "/api/me", headers: { cookie: cookie() } })).statusCode).toBe(
      200,
    );
    expect(graft.access).not.toHaveBeenCalled();
    config.auth.allowedUsers = [];
    expect((await app.inject({ url: "/api/me", headers: { cookie: cookie() } })).statusCode).toBe(
      503,
    );
    await app.close();
  });

  it("accepts an organization member during the OAuth callback without requesting extra OAuth scopes", async () => {
    const graft = bridge();
    const app = await testApp({
      config: orgConfig(),
      graft,
      oauth: fakeOAuth(USER),
      now: () => NOW,
    });
    const start = await app.inject("/auth/login?start=1");
    const url = new URL(start.headers.location as string);
    expect(url.searchParams.has("scope")).toBe(false);
    const raw = start.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : [raw as string];
    const stateCookie = cookies.find((c) => c.startsWith("graft_console_state="))?.split(";")[0];
    const callback = await app.inject({
      url: `/auth/callback?code=code&state=${url.searchParams.get("state")}`,
      headers: { cookie: stateCookie as string },
    });
    expect(callback.statusCode).toBe(302);
    expect(graft.access).toHaveBeenCalledWith(USER, ["acme"]);
    await app.close();
  });

  it("protects mutations against CSRF and forwards only the signed-in principal", async () => {
    const graft = bridge();
    const app = await testApp({ config: orgConfig(), graft, now: () => NOW });
    for (const origin of [undefined, "https://evil.example"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/repositories/activation",
        headers: { cookie: cookie(), ...(origin ? { origin } : {}) },
        payload: { repository: "acme/payments", enabled: false, confirmation: "acme/payments" },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(graft.activation).not.toHaveBeenCalled();
    const res = await app.inject({
      method: "POST",
      url: "/api/repositories/activation",
      headers: { cookie: cookie(), origin: "https://console.example.test" },
      payload: {
        repository: "acme/payments",
        enabled: false,
        confirmation: "acme/payments",
        user: { login: "forged", id: 9 },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(graft.activation).toHaveBeenCalledWith(USER, "acme/payments", false, "acme/payments");
    const badQuery = await app.inject({
      url: "/api/repositories/search?account=acme&query=x%20org:evil",
      headers: { cookie: cookie() },
    });
    expect(badQuery.statusCode).toBe(400);
    await app.close();
  });

  it("propagates permission failures rather than returning a success-shaped mutation", async () => {
    const graft = bridge();
    vi.mocked(graft.activation).mockRejectedValue(new GraftError(403, "Only repository admins"));
    const app = await testApp({ config: orgConfig(), graft, now: () => NOW });
    const result = await app.inject({
      method: "POST",
      url: "/api/repositories/activation",
      headers: { cookie: cookie(), origin: "https://console.example.test" },
      payload: { repository: "acme/payments", enabled: true },
    });
    expect(result.statusCode).toBe(403);
    expect(result.json()).toMatchObject({ message: "Only repository admins" });
    await app.close();
  });

  it("protects billing changes and forwards only the authenticated user", async () => {
    const graft = bridge();
    const app = await testApp({ config: orgConfig(), graft, now: () => NOW });
    const headers = { cookie: cookie(), origin: "https://console.example.test" };
    const statement = await app.inject({
      url: "/api/billing/statement?month=2026-10",
      headers: { cookie: cookie() },
    });
    expect(statement.statusCode).toBe(200);
    expect(statement.json()).toMatchObject({ month: "2026-10", lines: [] });
    expect(graft.billingStatement).toHaveBeenCalledWith(USER, "2026-10");

    const rejected = await app.inject({
      method: "POST",
      url: "/api/billing/change",
      headers: { cookie: cookie() },
      payload: { action: "create", name: "Platform" },
    });
    expect(rejected.statusCode).toBe(403);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/billing/change",
      headers,
      payload: { action: "create", name: "Platform", user: { login: "forged", id: 8 } },
    });
    expect(accepted.statusCode).toBe(200);
    expect(graft.billingChange).toHaveBeenCalledWith(USER, "create", { name: "Platform" });
    const invalid = await app.inject({
      url: "/api/billing/statement?month=2026-13",
      headers: { cookie: cookie() },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("fails billing requests explicitly when the optional Graft bridge is absent", async () => {
    const app = await testApp({
      config: githubConfig({ CONSOLE_ALLOWED_USERS: "org-member" }),
      now: () => NOW,
    });
    for (const url of ["/api/billing/teams", "/api/billing/repositories?after=0"]) {
      const response = await app.inject({ url, headers: { cookie: cookie() } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        message: "Repository management needs CONSOLE_GRAFT_URL and CONSOLE_GRAFT_SECRET.",
      });
    }
    await app.close();
  });

  it("signs bridge requests and never redirects credentials to another host", async () => {
    let observed: RequestInit | undefined;
    const api = graftApi(
      { url: "https://graft.test", secret: "k".repeat(40) },
      async (_url, init) => {
        observed = init;
        return Response.json({ allowed: true });
      },
      () => NOW,
    );
    expect(await api.access(USER, ["acme"])).toEqual({ allowed: true });
    expect(observed?.redirect).toBe("error");
    expect(observed?.headers).toMatchObject({
      "x-graft-console-time": String(NOW),
      "x-graft-console-signature": expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.parse(observed?.body as string)).toEqual({ user: USER, organizations: ["acme"] });
  });
});
