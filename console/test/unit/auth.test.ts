import { describe, expect, it } from "vitest";
import {
  isAllowed,
  parseCookies,
  readSession,
  SESSION_COOKIE,
  signSession,
} from "../../server/src/auth.js";
import { fakeOAuth, githubConfig, SESSION_SECRET, testApp } from "../helpers.js";

const NOW = Date.UTC(2026, 9, 25, 12);

describe("sessions", () => {
  const s = { login: "octo-op", id: 7, exp: NOW / 1000 + 3600 };

  it("reads back a session it signed", () => {
    expect(readSession(SESSION_SECRET, signSession(SESSION_SECRET, s), NOW)).toEqual(s);
  });

  it("refuses a tampered, foreign or expired session", () => {
    const v = signSession(SESSION_SECRET, s);
    const [payload, sig] = v.split(".");
    const forged = Buffer.from(JSON.stringify({ ...s, login: "mallory" })).toString("base64url");
    expect(readSession(SESSION_SECRET, `${forged}.${sig}`, NOW)).toBeNull();
    expect(readSession("x".repeat(40), v, NOW)).toBeNull();
    expect(readSession(SESSION_SECRET, `${payload}.${sig}.extra`, NOW)).toBeNull();
    expect(readSession(SESSION_SECRET, v, NOW + 3601_000)).toBeNull();
    expect(readSession(SESSION_SECRET, undefined, NOW)).toBeNull();
  });

  it("allows logins case-insensitively and numeric ids exactly", () => {
    expect(isAllowed(["octo-op", "4242"], { login: "Octo-Op", id: 1 })).toBe(true);
    expect(isAllowed(["octo-op", "4242"], { login: "renamed", id: 4242 })).toBe(true);
    expect(isAllowed(["octo-op", "4242"], { login: "4242", id: 1 })).toBe(false);
    expect(isAllowed(["octo-op"], { login: "octo-op-2", id: 2 })).toBe(false);
  });

  it("parses cookies and keeps the first of a duplicate", () => {
    expect(parseCookies("a=1; b=x%20y; a=2; junk")).toEqual({ a: "1", b: "x y" });
  });
});

describe("sign-in with GitHub", () => {
  const cookieOf = (setCookie: string | string[] | undefined, name: string) => {
    const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const hit = all.find((c) => c.startsWith(`${name}=`));
    return hit?.split(";")[0]?.slice(name.length + 1);
  };

  it("sends an anonymous visitor to sign-in and refuses the API", async () => {
    const app = await testApp({ config: githubConfig(), now: () => NOW });
    const page = await app.inject("/");
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/auth/login");
    const api = await app.inject("/api/overview");
    expect(api.statusCode).toBe(401);
    expect(api.json()).toMatchObject({ error: "unauthenticated" });
    const login = await app.inject("/auth/login");
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain("Sign in with GitHub");
    expect(login.headers["content-security-policy"]).toContain("default-src 'self'");
    await app.close();
  });

  it("completes the flow for an allowed user, then signs out", async () => {
    const oauth = fakeOAuth({ login: "octo-op", id: 99 });
    const app = await testApp({ config: githubConfig(), oauth, now: () => NOW });
    const start = await app.inject("/auth/login?start=1");
    expect(start.statusCode).toBe(302);
    const to = new URL(start.headers.location as string);
    expect(to.origin).toBe("https://github.com");
    expect(to.searchParams.get("redirect_uri")).toBe("https://console.example.test/auth/callback");
    const state = to.searchParams.get("state") as string;
    const stateCookie = cookieOf(start.headers["set-cookie"], "graft_console_state");
    expect(stateCookie).toBeTruthy();
    expect(start.headers["set-cookie"]).toContain("Secure");

    const cb = await app.inject({
      url: `/auth/callback?code=c0de&state=${state}`,
      headers: { cookie: `graft_console_state=${stateCookie}` },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/");
    expect(oauth.codes).toEqual(["c0de"]);
    const session = cookieOf(cb.headers["set-cookie"], SESSION_COOKIE) as string;
    expect(readSession(SESSION_SECRET, session, NOW)).toMatchObject({ login: "octo-op", id: 99 });

    const me = await app.inject({
      url: "/api/me",
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(me.json()).toEqual({ login: "octo-op", auth: "github" });

    const foreign = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: "https://evil.example" },
    });
    expect(foreign.statusCode).toBe(403);
    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: "https://console.example.test" },
    });
    expect(out.statusCode).toBe(303);
    expect(cookieOf(out.headers["set-cookie"], SESSION_COOKIE)).toBe("");
    await app.close();
  });

  it("refuses a user who is not on the list, and a callback without its state", async () => {
    const oauth = fakeOAuth({ login: "stranger", id: 5 });
    const app = await testApp({ config: githubConfig(), oauth, now: () => NOW });
    const start = await app.inject("/auth/login?start=1");
    const state = new URL(start.headers.location as string).searchParams.get("state") as string;
    const stateCookie = cookieOf(start.headers["set-cookie"], "graft_console_state");

    const noState = await app.inject(`/auth/callback?code=c&state=${state}`);
    expect(noState.statusCode).toBe(400);
    expect(oauth.codes).toEqual([]);

    const wrong = await app.inject({
      url: "/auth/callback?code=c&state=another",
      headers: { cookie: `graft_console_state=${stateCookie}` },
    });
    expect(wrong.statusCode).toBe(400);

    const denied = await app.inject({
      url: `/auth/callback?code=c&state=${state}`,
      headers: { cookie: `graft_console_state=${stateCookie}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain("stranger is not on this console");
    expect(cookieOf(denied.headers["set-cookie"], SESSION_COOKIE)).toBeUndefined();
    await app.close();
  });

  it("refuses a session for a user who was removed from the list", async () => {
    const app = await testApp({
      config: githubConfig({ CONSOLE_ALLOWED_USERS: "someone-else" }),
      now: () => NOW,
    });
    const session = signSession(SESSION_SECRET, { login: "octo-op", id: 99, exp: NOW / 1000 + 60 });
    const r = await app.inject({
      url: "/api/me",
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });
});
