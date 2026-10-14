import { readFileSync } from "node:fs";
import { z } from "zod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
/** Unset or empty → the default (given in its string, i.e. env, form), then validated. */
const withDefault = <T extends z.ZodType>(schema: T, def: string) =>
  z.preprocess((v) => emptyToUndefined(v) ?? def, schema);

const intString = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const url = z.string().refine((v) => URL.canParse(v), "must be a URL");

const EnvSchema = z.object({
  NODE_ENV: withDefault(z.enum(["development", "test", "production"]), "development"),
  HOST: withDefault(z.string().min(1), "0.0.0.0"),
  PORT: withDefault(intString(1, 65535), "3000"),
  LOG_LEVEL: withDefault(z.enum(LOG_LEVELS), "info"),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/.+/, "must be a postgres:// or postgresql:// URL"),
  GITHUB_APP_ID: intString(1, Number.MAX_SAFE_INTEGER),
  GITHUB_APP_PRIVATE_KEY: opt(z.string()),
  GITHUB_APP_PRIVATE_KEY_PATH: opt(z.string()),
  GITHUB_WEBHOOK_SECRET: z.string().min(16, "must be at least 16 characters"),
  GITHUB_API_URL: withDefault(url, "https://api.github.com"),
  PGBOSS_SCHEMA: withDefault(
    z.string().regex(/^[a-z_][a-z0-9_]*$/, "must match ^[a-z_][a-z0-9_]*$"),
    "pgboss",
  ),
  WORKER_CONCURRENCY: withDefault(intString(1, 50), "5"),
  WEBHOOK_BODY_LIMIT_BYTES: withDefault(intString(1, Number.MAX_SAFE_INTEGER), "26214400"),
  SMEE_URL: opt(url),
});

export interface Config {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly databaseUrl: string;
  readonly githubAppId: number;
  readonly githubAppPrivateKey: string;
  readonly githubWebhookSecret: string;
  readonly githubApiUrl: string;
  readonly pgbossSchema: string;
  readonly workerConcurrency: number;
  readonly webhookBodyLimitBytes: number;
  readonly smeeUrl: string | undefined;
}

function isPem(key: string): boolean {
  return key.includes("-----BEGIN") && key.includes("PRIVATE KEY-----");
}

/**
 * Pure apart from reading the key file named by GITHUB_APP_PRIVATE_KEY_PATH.
 * Error messages name variables only, never their values.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  const problems: string[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? "env");
      // Never echo a value: only the variable name and the rule's own message.
      const msg = issue.code === "invalid_type" ? "is required" : issue.message;
      problems.push(`${name}: ${msg}`);
    }
  }

  const inline = parsed.success
    ? parsed.data.GITHUB_APP_PRIVATE_KEY
    : opt(z.string()).parse(env.GITHUB_APP_PRIVATE_KEY);
  const keyPath = parsed.success
    ? parsed.data.GITHUB_APP_PRIVATE_KEY_PATH
    : opt(z.string()).parse(env.GITHUB_APP_PRIVATE_KEY_PATH);

  let privateKey: string | undefined;
  if (inline !== undefined && keyPath !== undefined) {
    problems.push(
      "GITHUB_APP_PRIVATE_KEY / GITHUB_APP_PRIVATE_KEY_PATH: set exactly one, not both",
    );
  } else if (inline === undefined && keyPath === undefined) {
    problems.push("GITHUB_APP_PRIVATE_KEY / GITHUB_APP_PRIVATE_KEY_PATH: set exactly one of them");
  } else if (inline !== undefined) {
    privateKey = inline.replace(/\\n/g, "\n");
    if (!isPem(privateKey)) {
      problems.push("GITHUB_APP_PRIVATE_KEY: is not a PEM private key");
      privateKey = undefined;
    }
  } else if (keyPath !== undefined) {
    try {
      privateKey = readFileSync(keyPath, "utf8");
      if (!isPem(privateKey)) {
        problems.push("GITHUB_APP_PRIVATE_KEY_PATH: file is not a PEM private key");
        privateKey = undefined;
      }
    } catch {
      problems.push("GITHUB_APP_PRIVATE_KEY_PATH: file cannot be read");
    }
  }

  if (problems.length > 0 || !parsed.success || privateKey === undefined) {
    throw new ConfigError(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  }

  const d = parsed.data;
  return Object.freeze({
    nodeEnv: d.NODE_ENV,
    host: d.HOST,
    port: d.PORT,
    logLevel: d.LOG_LEVEL,
    databaseUrl: d.DATABASE_URL,
    githubAppId: d.GITHUB_APP_ID,
    githubAppPrivateKey: privateKey,
    githubWebhookSecret: d.GITHUB_WEBHOOK_SECRET,
    githubApiUrl: d.GITHUB_API_URL,
    pgbossSchema: d.PGBOSS_SCHEMA,
    workerConcurrency: d.WORKER_CONCURRENCY,
    webhookBodyLimitBytes: d.WEBHOOK_BODY_LIMIT_BYTES,
    smeeUrl: d.SMEE_URL,
  });
}
