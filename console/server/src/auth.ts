import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { GithubAuth } from "./config.js";
import type { LoginPageState } from "./pages.js";
import type { AppServer } from "./server-type.js";

export const SESSION_COOKIE = "graft_console";
const STATE_COOKIE = "graft_console_state";
const STATE_TTL_S = 600;

export interface Session {
  login: string;
  id: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: { login: string };
  }
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function mac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `payload.mac`: a session only Graft's console can have written; nothing is stored server-side. */
export function signSession(secret: string, s: Session): string {
  const payload = b64(JSON.stringify(s));
  return `${payload}.${mac(secret, `session:${payload}`)}`;
}

export function readSession(
  secret: string,
  value: string | undefined,
  now: number,
): Session | null {
  if (!value) return null;
  const [payload, sig, extra] = value.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, mac(secret, `session:${payload}`))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Session>;
    if (typeof s.login !== "string" || typeof s.id !== "number" || typeof s.exp !== "number") {
      return null;
    }
    if (s.exp * 1000 <= now) return null;
    return { login: s.login, id: s.id, exp: s.exp };
  } catch {
    return null;
  }
}

export function isAllowed(allowed: string[], user: { login: string; id: number }): boolean {
  const login = user.login.toLowerCase();
  return allowed.some((a) => (/^\d+$/.test(a) ? Number(a) === user.id : a === login));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function cookie(
  name: string,
  value: string,
  opts: { maxAge: number; secure: boolean; path?: string },
): string {
  return [
    `${name}=${value}`,
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${opts.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

/** The GitHub calls of the sign-in flow; injectable so tests never reach GitHub. */
export interface GithubOAuth {
  exchangeCode(code: string): Promise<string>;
  fetchUser(token: string): Promise<{ login: string; id: number }>;
}

export function githubOAuth(cfg: GithubAuth, fetchImpl: typeof fetch = fetch): GithubOAuth {
  return {
    async exchangeCode(code) {
      const res = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
          redirect_uri: `${cfg.publicUrl}/auth/callback`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { access_token?: string; error?: string };
      if (!res.ok || !body.access_token) {
        throw new Error(`GitHub refused the code (${body.error ?? res.status})`);
      }
      return body.access_token;
    },
    async fetchUser(token) {
      const res = await fetchImpl("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "graft-console",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`GitHub user lookup failed (${res.status})`);
      const u = (await res.json()) as { login?: unknown; id?: unknown };
      if (typeof u.login !== "string" || typeof u.id !== "number") {
        throw new Error("GitHub user lookup returned no login");
      }
      return { login: u.login, id: u.id };
    },
  };
}

function isApi(req: FastifyRequest): boolean {
  return req.url.startsWith("/api/");
}

/**
 * Sign-in with GitHub (OAuth web flow) restricted to an allow-list. The GitHub token is used once to
 * read who signed in and then dropped; the console keeps only a signed cookie with login, id and
 * expiry.
 */
export function registerGithubAuth(
  app: AppServer,
  cfg: GithubAuth,
  oauth: GithubOAuth,
  opts: { renderLogin: (s: LoginPageState) => string; now?: () => number },
): void {
  const now = opts.now ?? Date.now;
  const loginPage = opts.renderLogin;
  const secure = cfg.publicUrl.startsWith("https://");

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "/";
    if (path.startsWith("/auth/") || path === "/healthz" || path === "/readyz") return;
    if (path.startsWith("/assets/") || path === "/favicon.svg") return;
    const s = readSession(
      cfg.sessionSecret,
      parseCookies(req.headers.cookie)[SESSION_COOKIE],
      now(),
    );
    if (s && isAllowed(cfg.allowedUsers, s)) {
      req.user = { login: s.login };
      return;
    }
    if (isApi(req)) {
      return reply
        .code(401)
        .send({ error: "unauthenticated", message: "Sign in to use the console." });
    }
    return reply.redirect("/auth/login");
  });

  app.get("/auth/login", async (req, reply) => {
    const q = req.query as { start?: string };
    if (q.start !== "1") {
      return reply.type("text/html; charset=utf-8").send(loginPage({ state: "start" }));
    }
    const state = randomBytes(24).toString("base64url");
    const signed = `${state}.${mac(cfg.sessionSecret, `state:${state}`)}`;
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", `${cfg.publicUrl}/auth/callback`);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    return reply
      .header(
        "set-cookie",
        cookie(STATE_COOKIE, signed, { maxAge: STATE_TTL_S, secure, path: "/auth" }),
      )
      .redirect(url.toString());
  });

  app.get("/auth/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const clearState = cookie(STATE_COOKIE, "", { maxAge: 0, secure, path: "/auth" });
    const fail = (status: number, message: string) =>
      reply
        .code(status)
        .header("set-cookie", clearState)
        .type("text/html; charset=utf-8")
        .send(loginPage({ state: "error", message }));

    if (q.error) return fail(400, "GitHub did not complete the sign-in. Try again.");
    const [state, sig] = (parseCookies(req.headers.cookie)[STATE_COOKIE] ?? "").split(".");
    if (
      !q.code ||
      !q.state ||
      !state ||
      !sig ||
      !safeEqual(q.state, state) ||
      !safeEqual(sig, mac(cfg.sessionSecret, `state:${state}`))
    ) {
      return fail(400, "The sign-in link expired or was opened in another browser. Try again.");
    }
    let user: { login: string; id: number };
    try {
      const token = await oauth.exchangeCode(q.code);
      user = await oauth.fetchUser(token);
    } catch (err) {
      req.log.warn({ err }, "github sign-in failed");
      return fail(502, "GitHub could not confirm who you are. Try again in a minute.");
    }
    if (!isAllowed(cfg.allowedUsers, user)) {
      req.log.warn({ login: user.login }, "sign-in refused: not in CONSOLE_ALLOWED_USERS");
      return fail(
        403,
        `${user.login} is not on this console's list of operators. Ask whoever runs Graft to add you to CONSOLE_ALLOWED_USERS.`,
      );
    }
    const exp = Math.floor(now() / 1000) + cfg.sessionHours * 3600;
    const value = signSession(cfg.sessionSecret, { login: user.login, id: user.id, exp });
    req.log.info({ login: user.login }, "signed in");
    return reply
      .header("set-cookie", [
        clearState,
        cookie(SESSION_COOKIE, value, { maxAge: cfg.sessionHours * 3600, secure }),
      ])
      .redirect("/");
  });

  app.post("/auth/logout", async (req, reply) => {
    // Same-origin only: the cookie is SameSite=Lax, and the Origin check closes the rest.
    const origin = req.headers.origin;
    if (origin && origin !== cfg.publicUrl) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Cross-origin sign-out refused." });
    }
    return reply
      .header("set-cookie", cookie(SESSION_COOKIE, "", { maxAge: 0, secure }))
      .redirect("/auth/login", 303);
  });
}

export function registerNoAuth(app: AppServer): void {
  app.addHook("onRequest", async (req: FastifyRequest, _reply: FastifyReply) => {
    req.user = { login: "local" };
  });
}
