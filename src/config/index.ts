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

const csv = (v: string): string[] =>
  v
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x !== "");

const loginList = z
  .string()
  .transform(csv)
  .refine((l) => l.every((x) => /^[a-z0-9-]+(\[bot\])?$/.test(x)), {
    message: "must be comma-separated GitHub logins (letters, digits, '-', optional [bot])",
  });

const emailList = z
  .string()
  .transform(csv)
  .refine((l) => l.every((x) => x.split("@").length === 2 && !/\s/.test(x)), {
    message: "must be comma-separated emails, each with exactly one '@'",
  });

const url = z.string().refine((v) => URL.canParse(v), "must be a URL");

const modelId = z.string().regex(/^claude-[a-z0-9-]{1,60}$/, "must match ^claude-[a-z0-9-]{1,60}$");

const boolString = z
  .enum(["true", "false"], { error: "must be true or false" })
  .transform((v) => v === "true");

const globList = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== ""),
  )
  .refine(
    (l) =>
      l.every(
        (g) =>
          g.length >= 1 && g.length <= 200 && !g.startsWith("!") && !g.split("/").includes(".."),
      ),
    {
      message: "must be comma-separated globs (1-200 characters, no leading '!', no '..' segment)",
    },
  );

const CRON_FIELD = /^[0-9*/,-]+$/;
const cronOrOff = z
  .string()
  .refine(
    (v) =>
      v === "off" ||
      (v.trim().split(/\s+/).length === 5 &&
        v
          .trim()
          .split(/\s+/)
          .every((f) => CRON_FIELD.test(f))),
    { message: 'must be a 5-field cron expression or "off"' },
  )
  .transform((v) => (v === "off" ? null : v.trim().split(/\s+/).join(" ")));

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
  GRAFT_AGENT_LOGINS: withDefault(loginList, ""),
  GRAFT_AGENT_COAUTHOR_EMAILS: withDefault(emailList, "noreply@anthropic.com"),
  GITHUB_APP_SLUG: opt(
    z.string().regex(/^[A-Za-z0-9-]+$/, "must be the App slug (letters, digits, '-')"),
  ),
  ANTHROPIC_API_KEY: opt(z.string().min(1)),
  GRAFT_LLM_MODEL_FAST: withDefault(modelId, "claude-haiku-5-5"),
  GRAFT_LLM_MODEL_STRONG: withDefault(modelId, "claude-sonnet-5-5"),
  GRAFT_LLM_TIMEOUT_MS: withDefault(intString(5_000, 600_000), "120000"),
  GRAFT_LLM_MAX_RETRIES: withDefault(intString(0, 5), "2"),
  GRAFT_LLM_REFUSAL_FALLBACK: withDefault(boolString, "true"),
  GRAFT_LLM_DAILY_TOKEN_BUDGET: withDefault(intString(0, Number.MAX_SAFE_INTEGER), "2000000"),
  GRAFT_INTENT_SENSITIVE_PATHS: withDefault(globList, ""),
  GRAFT_FEEDBACK_POLL_CRON: withDefault(cronOrOff, "*/15 * * * *"),
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
  /** Lowercased logins that count as agent accounts (step 2). */
  readonly agentLogins: readonly string[];
  /** Lowercased co-author emails that mark a commit as agent-written (step 2). */
  readonly agentCoauthorEmails: readonly string[];
  /** The App's slug; enables the `<slug>[bot]` fallback for recognising Graft's comment. */
  readonly githubAppSlug: string | undefined;
  /** Anthropic API key; without it the intent service writes "unavailable" cards (step 3). */
  readonly anthropicApiKey: string | undefined;
  readonly llmModelFast: string;
  readonly llmModelStrong: string;
  readonly llmTimeoutMs: number;
  readonly llmMaxRetries: number;
  readonly llmRefusalFallback: boolean;
  /** Per-repository daily token budget; 0 = unlimited. */
  readonly llmDailyTokenBudget: number;
  /** Extra globs that set the risk floor to `sensitive`. */
  readonly intentSensitivePaths: readonly string[];
  /** Cron for the reaction polling sweep, or null when switched off. */
  readonly feedbackPollCron: string | null;
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
    agentLogins: Object.freeze([...d.GRAFT_AGENT_LOGINS]),
    agentCoauthorEmails: Object.freeze([...d.GRAFT_AGENT_COAUTHOR_EMAILS]),
    githubAppSlug: d.GITHUB_APP_SLUG,
    anthropicApiKey: d.ANTHROPIC_API_KEY,
    llmModelFast: d.GRAFT_LLM_MODEL_FAST,
    llmModelStrong: d.GRAFT_LLM_MODEL_STRONG,
    llmTimeoutMs: d.GRAFT_LLM_TIMEOUT_MS,
    llmMaxRetries: d.GRAFT_LLM_MAX_RETRIES,
    llmRefusalFallback: d.GRAFT_LLM_REFUSAL_FALLBACK,
    llmDailyTokenBudget: d.GRAFT_LLM_DAILY_TOKEN_BUDGET,
    intentSensitivePaths: Object.freeze([...d.GRAFT_INTENT_SENSITIVE_PATHS]),
    feedbackPollCron: d.GRAFT_FEEDBACK_POLL_CRON,
  });
}
