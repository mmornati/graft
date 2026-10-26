import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, def: string) =>
  z.preprocess((v) => emptyToUndefined(v) ?? def, schema);

const intString = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const boolString = z
  .enum(["true", "false"], { error: "must be true or false" })
  .transform((v) => v === "true");

const httpUrl = z
  .string()
  .refine(
    (v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol),
    "must be an http(s) URL",
  );

/** `mmornati, 1234567`: GitHub logins (case-insensitive) or numeric user ids (rename-proof). */
const userList = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x !== ""),
  )
  .refine((l) => l.length > 0, "must name at least one GitHub login or user id")
  .refine((l) => l.every((x) => /^[a-z0-9-]{1,39}$/.test(x)), {
    message: "must be comma-separated GitHub logins or numeric user ids",
  });

export function isValidTimeZone(tz: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timeZone = z
  .string()
  .refine(isValidTimeZone, "must be an IANA time zone such as Europe/Paris");

const EnvSchema = z.object({
  HOST: withDefault(z.string(), "127.0.0.1"),
  PORT: withDefault(intString(1, 65535), "3100"),
  LOG_LEVEL: withDefault(z.enum(LOG_LEVELS), "info"),
  CONSOLE_DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .string({ error: "is required" })
      .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL"),
  ),
  CONSOLE_AUTH: withDefault(z.enum(["github", "none"]), "github"),
  CONSOLE_PUBLIC_URL: opt(httpUrl),
  CONSOLE_GITHUB_CLIENT_ID: opt(z.string().regex(/^[A-Za-z0-9._-]{8,100}$/, "is not a client id")),
  CONSOLE_GITHUB_CLIENT_SECRET: opt(z.string().min(20, "is too short")),
  CONSOLE_ALLOWED_USERS: opt(userList),
  CONSOLE_SESSION_SECRET: opt(z.string().min(32, "must be at least 32 characters")),
  CONSOLE_SESSION_HOURS: withDefault(intString(1, 168), "12"),
  CONSOLE_TIME_ZONE: withDefault(timeZone, "UTC"),
  CONSOLE_DAILY_TOKEN_BUDGET: withDefault(intString(0, Number.MAX_SAFE_INTEGER), "2000000"),
  CONSOLE_REQUIRE_READONLY_ROLE: withDefault(boolString, "true"),
  CONSOLE_STATEMENT_TIMEOUT_MS: withDefault(intString(100, 120_000), "10000"),
});

export type GithubAuth = {
  mode: "github";
  publicUrl: string;
  clientId: string;
  clientSecret: string;
  allowedUsers: string[];
  sessionSecret: string;
  sessionHours: number;
};

export interface Config {
  host: string;
  port: number;
  logLevel: (typeof LOG_LEVELS)[number];
  databaseUrl: string;
  auth: GithubAuth | { mode: "none" };
  timeZone: string;
  dailyTokenBudget: number;
  requireReadOnlyRole: boolean;
  statementTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`);
    throw new ConfigError(`invalid console configuration:\n  ${lines.join("\n  ")}`);
  }
  const e = parsed.data;
  let auth: Config["auth"];
  if (e.CONSOLE_AUTH === "none") {
    // Without sign-in the console must not be reachable from the network.
    if (!LOOPBACK.has(e.HOST)) {
      throw new ConfigError(
        `CONSOLE_AUTH=none is only allowed when HOST is a loopback address (got ${e.HOST})`,
      );
    }
    auth = { mode: "none" };
  } else {
    const missing = (
      [
        "CONSOLE_PUBLIC_URL",
        "CONSOLE_GITHUB_CLIENT_ID",
        "CONSOLE_GITHUB_CLIENT_SECRET",
        "CONSOLE_ALLOWED_USERS",
        "CONSOLE_SESSION_SECRET",
      ] as const
    ).filter((k) => e[k] === undefined);
    if (missing.length > 0) {
      throw new ConfigError(`CONSOLE_AUTH=github needs ${missing.join(", ")}`);
    }
    auth = {
      mode: "github",
      publicUrl: (e.CONSOLE_PUBLIC_URL as string).replace(/\/+$/, ""),
      clientId: e.CONSOLE_GITHUB_CLIENT_ID as string,
      clientSecret: e.CONSOLE_GITHUB_CLIENT_SECRET as string,
      allowedUsers: e.CONSOLE_ALLOWED_USERS as string[],
      sessionSecret: e.CONSOLE_SESSION_SECRET as string,
      sessionHours: e.CONSOLE_SESSION_HOURS,
    };
  }
  return {
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.CONSOLE_DATABASE_URL,
    auth,
    timeZone: e.CONSOLE_TIME_ZONE,
    dailyTokenBudget: e.CONSOLE_DAILY_TOKEN_BUDGET,
    requireReadOnlyRole: e.CONSOLE_REQUIRE_READONLY_ROLE,
    statementTimeoutMs: e.CONSOLE_STATEMENT_TIMEOUT_MS,
  };
}
