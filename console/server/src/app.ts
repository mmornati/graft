import Fastify, { type FastifyReply } from "fastify";
import { sql } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import type { ApiError, DayResponse, DaysResponse, Me } from "../../shared/api.js";
import { type GithubOAuth, githubOAuth, registerGithubAuth, registerNoAuth } from "./auth.js";
import { type Config, isValidTimeZone } from "./config.js";
import type { Db } from "./db.js";
import { loginPage } from "./pages.js";
import { changeRecord, register } from "./queries/changes.js";
import { dayEntries } from "./queries/day.js";
import { installedAt, listDays } from "./queries/days.js";
import { overview } from "./queries/overview.js";
import { system } from "./queries/system.js";
import type { AppServer } from "./server-type.js";
import { registerStatic, type WebAssets } from "./static.js";
import { addDays, dateIn, isDate } from "./time.js";

export interface AppDeps {
  config: Config;
  db: Db;
  log: Logger;
  web: WebAssets;
  version: string;
  /** From the start-up role inspection: whether the role may read pgboss.job. */
  pgboss: boolean;
  oauth?: GithubOAuth;
  now?: () => number;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

class BadRequest extends Error {}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new BadRequest(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
}

const tzParam = z.string().refine(isValidTimeZone, "unknown time zone").optional();
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export async function buildApp(deps: AppDeps): Promise<AppServer> {
  const { config, db } = deps;
  const app = Fastify({
    loggerInstance: deps.log,
    bodyLimit: 16 * 1024,
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply
      .header("content-security-policy", CSP)
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("x-frame-options", "DENY")
      .header("cross-origin-opener-policy", "same-origin")
      .header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    return payload;
  });

  app.setErrorHandler(async (err: Error & { code?: string; statusCode?: number }, req, reply) => {
    if (err instanceof BadRequest) {
      return reply
        .code(400)
        .send({ error: "bad_request", message: err.message } satisfies ApiError);
    }
    if (err.code === "57014") {
      req.log.warn({ url: req.url }, "statement timeout");
      return reply.code(503).send({
        error: "timeout",
        message: "The database took too long to answer. Try a shorter range.",
      } satisfies ApiError);
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: "bad_request", message: err.message });
    }
    req.log.error({ err }, "request failed");
    return reply.code(500).send({
      error: "internal",
      message: "The console could not read that. The server log has the details.",
    } satisfies ApiError);
  });

  // Health routes stay open: they say nothing about the data.
  app.get("/healthz", async () => ({ status: "ok", version: deps.version }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await sql`select 1`.execute(db);
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  const renderLogin = (s: Parameters<typeof loginPage>[1]) => loginPage(deps.web.cssHref, s);
  if (config.auth.mode === "github") {
    registerGithubAuth(app, config.auth, deps.oauth ?? githubOAuth(config.auth), {
      renderLogin,
      ...(deps.now ? { now: deps.now } : {}),
    });
  } else {
    registerNoAuth(app);
  }

  const tzOf = (q: { tz?: string | undefined }) => q.tz ?? config.timeZone;
  const nowDate = () => new Date(deps.now ? deps.now() : Date.now());

  app.get(
    "/api/me",
    async (req): Promise<Me> => ({
      login: req.user?.login ?? "unknown",
      auth: config.auth.mode,
    }),
  );

  app.get("/api/days", async (req): Promise<DaysResponse> => {
    const q = parse(z.object({ tz: tzParam, days: int(1, 92).default(14) }), req.query);
    const tz = tzOf(q);
    const today = dateIn(tz, nowDate());
    const days = await listDays(db, tz, addDays(today, -(q.days - 1)), today);
    const at = await installedAt(db);
    return { timeZone: tz, today, installedAt: at ? at.toISOString() : null, days };
  });

  app.get("/api/days/:date", async (req, reply) => {
    const { date } = parse(
      z.object({ date: z.string().refine(isDate, "must be YYYY-MM-DD") }),
      req.params,
    );
    const q = parse(z.object({ tz: tzParam }), req.query);
    const tz = tzOf(q);
    if (date > dateIn(tz, nowDate())) {
      return notFound(reply, "That day has not happened yet.");
    }
    const [summary] = await listDays(db, tz, date, date);
    const entries = await dayEntries(db, tz, date);
    return { timeZone: tz, summary, entries } as DayResponse;
  });

  app.get("/api/overview", async () =>
    overview(db, {
      dailyTokenBudget: config.dailyTokenBudget,
      pgboss: deps.pgboss,
      now: nowDate(),
    }),
  );

  app.get("/api/changes", async (req) => {
    const q = parse(
      z.object({
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/name")
          .optional(),
        state: z.enum(["open", "closed", "merged"]).optional(),
        risk: z.enum(["trivial", "logic", "sensitive"]).optional(),
        verifier: z.enum(["agree", "disagree"]).optional(),
        author: z.enum(["agent", "human"]).optional(),
        pr: int(1, 10_000_000).optional(),
        cursor: z.string().max(200).optional(),
        limit: int(1, 200).default(50),
      }),
      req.query,
    );
    return register(db, q);
  });

  app.get("/api/changes/:id", async (req, reply) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const rec = await changeRecord(db, id);
    return rec ?? notFound(reply, "Graft has no record of that pull request.");
  });

  app.get("/api/system", async (req) => {
    const q = parse(z.object({ hours: int(1, 24 * 14).default(24) }), req.query);
    return system(db, {
      hours: q.hours,
      pgboss: deps.pgboss,
      version: deps.version,
      dailyTokenBudget: config.dailyTokenBudget,
      now: nowDate(),
    });
  });

  app.all("/api/*", async (_req, reply) => notFound(reply, "No such API route."));

  registerStatic(app, deps.web);
  return app;
}

function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: "not_found", message } satisfies ApiError);
}
