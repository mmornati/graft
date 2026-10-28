import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { z } from "zod";
import { anthropicCredential } from "../llm/anthropic.js";
import {
  type AnthropicFederation,
  credentialProblems,
  FEDERATION_FIELDS,
  federationFrom,
} from "../llm/federation.js";
import { type Deployment, type LlmRegistry, loadRegistry } from "../llm/registry.js";
import { MODEL_ID } from "../llm/types.js";
import { GLOB_REASONS } from "../policy/errors.js";
import { validateGlob } from "../policy/globs.js";

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

const accountList = z
  .string()
  .transform(csv)
  .refine((l) => l.every((x) => /^[a-z0-9-]+$/.test(x)), {
    message: "must be comma-separated GitHub account logins (letters, digits, '-')",
  });

const emailList = z
  .string()
  .transform(csv)
  .refine((l) => l.every((x) => x.split("@").length === 2 && !/\s/.test(x)), {
    message: "must be comma-separated emails, each with exactly one '@'",
  });

const url = z.string().refine((v) => URL.canParse(v), "must be a URL");
const httpUrl = z
  .string()
  .refine(
    (v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol),
    "must be an http(s) URL",
  );

const modelId = z.string().regex(MODEL_ID, "must be a Claude model ID");

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
  .superRefine((l, ctx) => {
    if (
      !l.every(
        (g) =>
          g.length >= 1 && g.length <= 200 && !g.startsWith("!") && !g.split("/").includes(".."),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "must be comma-separated globs (1-200 characters, no leading '!', no '..' segment)",
      });
      return;
    }
    // The same checks as `graft.yaml` (step 6, T14): a glob the matcher does not model would
    // silently match less than its author meant. Only the position and the reason are reported.
    const index = l.findIndex((g) => validateGlob(g) !== null);
    if (index >= 0) {
      const detail = validateGlob(l[index] as string) as number;
      ctx.addIssue({
        code: "custom",
        message: `glob ${index + 1} is invalid (${GLOB_REASONS[detail] ?? GLOB_REASONS[7]})`,
      });
    }
  });

const incidentLabel = z
  .string()
  .regex(/^(off|[A-Za-z0-9 ._:/-]{1,50})$/, 'must be "off" or 1-50 characters of [A-Za-z0-9 ._:/-]')
  .transform((v) => (v === "off" ? null : v));

/**
 * Phase 1 step 3 (D1): the break-glass label name, 1-50 characters, or `off` (any case) to switch
 * the feature off. No character class: label names are matched case-insensitively, never parsed.
 */
const breakGlassLabel = z
  .string()
  .refine((v) => v.trim() === v && Array.from(v).length >= 1 && Array.from(v).length <= 50, {
    message: 'must be "off" or a label name of 1-50 characters without surrounding spaces',
  })
  .refine((v) => Array.from(v).every((c) => c.charCodeAt(0) >= 0x20 && c !== "\u007f"), {
    message: "must not contain control characters",
  })
  .transform((v) => (v.toLowerCase() === "off" ? null : v));

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

const onOff = z
  .enum(["on", "off"], { error: 'must be "on" or "off"' })
  .transform((v) => v === "on");

/**
 * Phase 1 step 6 (D4): comma-separated origins (`scheme://host[:port]`, no path) a browser may call
 * `/mcp` from. Compared exactly with the request's `Origin` header, after lowercasing.
 */
const originList = z
  .string()
  .transform(csv)
  .refine(
    (l) =>
      l.every((o) => {
        if (!URL.canParse(o)) return false;
        const u = new URL(o);
        return /^https?:$/.test(u.protocol) && u.origin === o;
      }),
    { message: "must be comma-separated origins like https://app.example.com (no path)" },
  );

/**
 * Phase 1 step 7 (D6): one entry of `GRAFT_TRUST_PROXY`, an IPv4 or IPv6 address, or a CIDR range
 * with a prefix the address family allows. `true`, hop counts and hostnames are not entries.
 */
export function validProxyEntry(entry: string): boolean {
  const slash = entry.indexOf("/");
  const addr = slash < 0 ? entry : entry.slice(0, slash);
  const family = isIP(addr);
  if (family === 0) return false;
  if (slash < 0) return true;
  const prefix = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/** D6: comma-separated proxy addresses; a bad entry is named by its index, never its value. */
const proxyList = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== ""),
  )
  .superRefine((l, ctx) => {
    l.forEach((entry, i) => {
      if (!validProxyEntry(entry)) {
        ctx.addIssue({
          code: "custom",
          message: `entry ${i + 1} must be an IP address or a CIDR range`,
        });
      }
    });
  });

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
  ANTHROPIC_AUTH_TOKEN: opt(z.string().min(1)),
  ANTHROPIC_BASE_URL: opt(httpUrl),
  ANTHROPIC_FEDERATION_RULE_ID: opt(FEDERATION_FIELDS.ANTHROPIC_FEDERATION_RULE_ID),
  ANTHROPIC_ORGANIZATION_ID: opt(FEDERATION_FIELDS.ANTHROPIC_ORGANIZATION_ID),
  ANTHROPIC_SERVICE_ACCOUNT_ID: opt(FEDERATION_FIELDS.ANTHROPIC_SERVICE_ACCOUNT_ID),
  ANTHROPIC_WORKSPACE_ID: opt(FEDERATION_FIELDS.ANTHROPIC_WORKSPACE_ID),
  ANTHROPIC_IDENTITY_TOKEN_FILE: opt(FEDERATION_FIELDS.ANTHROPIC_IDENTITY_TOKEN_FILE),
  GRAFT_LLM_MODEL_FAST: withDefault(modelId, "claude-haiku-5-5"),
  GRAFT_LLM_MODEL_STRONG: withDefault(modelId, "claude-sonnet-5-5"),
  GRAFT_LLM_TIMEOUT_MS: withDefault(intString(5_000, 600_000), "120000"),
  GRAFT_LLM_MAX_RETRIES: withDefault(intString(0, 5), "2"),
  GRAFT_LLM_REFUSAL_FALLBACK: withDefault(boolString, "true"),
  GRAFT_LLM_REFUSAL_FALLBACK_MODEL: opt(modelId),
  GRAFT_DEPLOYMENT: withDefault(z.enum(["hosted", "self-hosted"]), "self-hosted"),
  GRAFT_LLM_PROVIDERS: opt(z.string().max(100_000)),
  GRAFT_LLM_PROVIDERS_FILE: opt(z.string()),
  GRAFT_LLM_DAILY_TOKEN_BUDGET: withDefault(intString(0, Number.MAX_SAFE_INTEGER), "2000000"),
  GRAFT_INTENT_SENSITIVE_PATHS: withDefault(globList, ""),
  GRAFT_FEEDBACK_POLL_CRON: withDefault(cronOrOff, "*/15 * * * *"),
  GRAFT_INCIDENT_LABEL: withDefault(incidentLabel, "incident"),
  GRAFT_METRICS_ROLLUP_CRON: withDefault(cronOrOff, "15 2 * * *"),
  GRAFT_METRICS_EXCLUDED_AUTHORS: withDefault(loginList, "dependabot[bot],renovate[bot]"),
  GRAFT_MODE_CEILING: withDefault(z.enum(["report", "enforce"]), "report"),
  GRAFT_MODE_APPLY_CRON: withDefault(cronOrOff, "* * * * *"),
  GRAFT_PERMISSIONS_REFRESH_CRON: withDefault(cronOrOff, "30 3 * * *"),
  GRAFT_POLICY_CARD_WAIT_SECONDS: withDefault(intString(0, 3600), "600"),
  GRAFT_BREAK_GLASS_LABEL: withDefault(breakGlassLabel, "graft:break-glass"),
  GRAFT_GUARD_DETECTION: withDefault(onOff, "on"),
  GRAFT_GUARD_CONFIRM: withDefault(onOff, "on"),
  GRAFT_GUARD_CONFIRM_SECONDS: withDefault(intString(300, 86_400), "7200"),
  GRAFT_GUARD_OBSERVE_DELAY_SECONDS: withDefault(intString(0, 600), "30"),
  GRAFT_GUARD_RETENTION_DAYS: withDefault(intString(7, 365), "30"),
  GRAFT_GUARD_PRUNE_CRON: withDefault(cronOrOff, "45 3 * * *"),
  GRAFT_GUARD_REVERT: withDefault(onOff, "on"),
  GRAFT_GUARD_MAX_OPEN_REVERTS: withDefault(intString(1, 10), "3"),
  GRAFT_GUARD_REVERT_MAX_PATHS: withDefault(intString(1, 1000), "300"),
  GRAFT_GUARD_REVERT_MAX_TREE_READS: withDefault(intString(10, 1000), "200"),
  GRAFT_GUARD_REVERT_MAX_AGE_HOURS: withDefault(intString(1, 168), "24"),
  GRAFT_MCP: withDefault(onOff, "on"),
  GRAFT_MCP_ALLOWED_ORIGINS: withDefault(originList, ""),
  GRAFT_MCP_RATE_LIMIT_PER_MINUTE: withDefault(intString(1, 600), "60"),
  GRAFT_MCP_AUTH_FAILURES_PER_MINUTE: withDefault(intString(1, 600), "20"),
  GRAFT_MCP_OPEN_CHANGE_PER_HOUR: withDefault(intString(1, 100), "10"),
  GRAFT_MCP_MAX_TOKENS_PER_REPO: withDefault(intString(1, 50), "10"),
  GRAFT_TRUST_PROXY: withDefault(proxyList, ""),
  GRAFT_ALLOWED_ACCOUNTS: withDefault(accountList, ""),
  GRAFT_UNINSTALL_UNLISTED: withDefault(onOff, "off"),
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
  /**
   * Anthropic API key (`x-api-key`). Without it or `anthropicAuthToken` the intent service writes
   * "unavailable" cards (step 3).
   */
  readonly anthropicApiKey: string | undefined;
  /** Bearer token instead of the API key, for gateways that expect one (OpenRouter, Bedrock). */
  readonly anthropicAuthToken: string | undefined;
  /** Workload Identity Federation, the third way to authenticate (never with a key or token). */
  readonly anthropicFederation: AnthropicFederation | undefined;
  /** Messages API base URL; undefined means the Claude API. */
  readonly anthropicBaseUrl: string | undefined;
  /**
   * The provider registry (`GRAFT_LLM_PROVIDERS` or `GRAFT_LLM_PROVIDERS_FILE`), or undefined for
   * the single client built from the `ANTHROPIC_*` settings. With a registry the three model
   * settings below are its roles, each `<provider id>/<model>`.
   */
  readonly llmRegistry: LlmRegistry | undefined;
  /**
   * `hosted`: Graft serves other people's repositories (the GitHub App others install), so the
   * registry refuses providers that run on a personal CLI login. `self-hosted` (the default)
   * allows them for single-tenant use.
   */
  readonly deployment: Deployment;
  readonly llmModelFast: string;
  readonly llmModelStrong: string;
  readonly llmTimeoutMs: number;
  readonly llmMaxRetries: number;
  /** Server-side refusal fallback (Claude API, Sonnet and Opus only). */
  readonly llmRefusalFallback: boolean;
  /** Model retried once, client-side, when a call is refused and no server-side fallback ran. */
  readonly llmRefusalFallbackModel: string | undefined;
  /** Per-repository daily token budget; 0 = unlimited. */
  readonly llmDailyTokenBudget: number;
  /** Extra globs that set the risk floor to `sensitive`. */
  readonly intentSensitivePaths: readonly string[];
  /** Cron for the reaction polling sweep, or null when switched off. */
  readonly feedbackPollCron: string | null;
  /** Label that marks a revert or fix PR as an incident (step 6), or null when switched off. */
  readonly incidentLabel: string | null;
  /** Cron for the daily metrics rollup (step 6), or null when switched off. */
  readonly metricsRollupCron: string | null;
  /** Lowercased logins left out of the baseline, the rollup PR counts and gate coverage. */
  readonly metricsExcludedAuthors: readonly string[];
  /**
   * The most any repository can be set to (Phase 1 step 1). Only the operator's environment sets
   * it; `report` (the default) makes every mode report/off whatever the database says.
   */
  readonly modeCeiling: "report" | "enforce";
  /** Cron for `modes.apply`, or null when switched off. */
  readonly modeApplyCron: string | null;
  /** Cron for the daily installation permissions refresh, or null when switched off. */
  readonly permissionsRefreshCron: string | null;
  /** Phase 1 step 2 (D9): how long enforce mode waits for the intent card; 0 = never. */
  readonly policyCardWaitSeconds: number;
  /**
   * Phase 1 step 3 (D1): the label that requests a break-glass, matched case-insensitively; null
   * when `GRAFT_BREAK_GLASS_LABEL=off` (the label is then an ordinary label).
   */
  readonly breakGlassLabel: string | null;
  /** Phase 1 step 4 (D14): the guard's kill switch. Off: handlers drop everything, crons idle. */
  readonly guardDetection: boolean;
  /** Phase 1 step 4 (D9): wait for the failure to persist before naming a culprit. */
  readonly guardConfirm: boolean;
  /** Phase 1 step 4 (D9): the confirmation window, in seconds. */
  readonly guardConfirmSeconds: number;
  /** Phase 1 step 4 (D12): how long `guard.observe` waits after a trigger, in seconds. */
  readonly guardObserveDelaySeconds: number;
  /** Phase 1 step 4 (D15): `main_commits` and `ci_results` rows older than this are pruned. */
  readonly guardRetentionDays: number;
  /** Cron for `guard.prune`, or null when switched off. */
  readonly guardPruneCron: string | null;
  /** Phase 1 step 5 (D19): the revert kill switch. Off: no plan, no revert; detection unaffected. */
  readonly guardRevert: boolean;
  /** Phase 1 step 5 (D13): at most this many events per repository in `revert_opened`. */
  readonly guardMaxOpenReverts: number;
  /** Phase 1 step 5 (D8): a culprit changing more paths than this is left to a human. */
  readonly guardRevertMaxPaths: number;
  /** Phase 1 step 5 (D8): tree reads one revert plan may make. */
  readonly guardRevertMaxTreeReads: number;
  /**
   * Step 5 review 1, finding 4: a culprit confirmed longer ago than this is `skipped` / `stale`
   * before any write, so a job sent again late never opens a revert days after the failure.
   */
  readonly guardRevertMaxAgeHours: number;
  /** Phase 1 step 6 (D22): the MCP endpoint's kill switch. Off: `/mcp` is not registered. */
  readonly mcp: boolean;
  /** Phase 1 step 6 (D4): lowercased origins allowed to call `/mcp`; empty refuses every browser. */
  readonly mcpAllowedOrigins: readonly string[];
  /** Phase 1 step 6 (D9 a): requests per token per minute, per process. */
  readonly mcpRateLimitPerMinute: number;
  /** Phase 1 step 6 (D9 b): failed authentications per client IP per minute, per process. */
  readonly mcpAuthFailuresPerMinute: number;
  /** Phase 1 step 6 (D9 c): `open_change` PRs per repository in any rolling hour. */
  readonly mcpOpenChangePerHour: number;
  /** Phase 1 step 6 (D11): active MCP tokens per repository. */
  readonly mcpMaxTokensPerRepo: number;
  /**
   * Phase 1 step 7 (D6): the proxies whose `X-Forwarded-For` is trusted (IPs or CIDR ranges).
   * Empty: Fastify's `trustProxy` is off and `req.ip` is the connection's peer.
   */
  readonly trustProxy: readonly string[];
  /**
   * Lowercased logins of the users and organizations whose installations Graft serves. Empty:
   * every installation is served. Otherwise a delivery from any other account is dropped before
   * it is stored, so a public App installed by a stranger costs nothing.
   */
  readonly allowedAccounts: readonly string[];
  /** Uninstall the App when an account outside `allowedAccounts` installs it. */
  readonly uninstallUnlisted: boolean;
}

/**
 * The registry, when one is configured. It replaces the three model variables instead of quietly
 * winning over them, so setting both is an error. Messages name variables, never values.
 */
function registryFrom(
  d: z.infer<typeof EnvSchema>,
  env: NodeJS.ProcessEnv,
): { registry: LlmRegistry | undefined; problems: string[] } {
  return loadRegistry({
    inline: d.GRAFT_LLM_PROVIDERS,
    file: d.GRAFT_LLM_PROVIDERS_FILE,
    env,
    defaults: {
      credential: anthropicCredential({
        anthropicApiKey: d.ANTHROPIC_API_KEY,
        anthropicAuthToken: d.ANTHROPIC_AUTH_TOKEN,
        anthropicFederation: federationFrom(d),
      }),
      baseUrl: d.ANTHROPIC_BASE_URL,
    },
    deployment: d.GRAFT_DEPLOYMENT,
  });
}

/** Placeholder secrets shipped in `.env.example`; refused in production. */
const EXAMPLE_WEBHOOK_SECRETS = new Set(["change-me-dev-webhook-secret"]);

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

  if (parsed.success) problems.push(...credentialProblems(parsed.data));

  let llmRegistry: LlmRegistry | undefined;
  if (parsed.success && problems.length === 0) {
    const r = registryFrom(parsed.data, env);
    problems.push(...r.problems);
    llmRegistry = r.registry;
  }

  if (
    parsed.success &&
    parsed.data.NODE_ENV === "production" &&
    EXAMPLE_WEBHOOK_SECRETS.has(parsed.data.GITHUB_WEBHOOK_SECRET)
  ) {
    problems.push("GITHUB_WEBHOOK_SECRET: is the .env.example placeholder; set the App's secret");
  }

  if (
    parsed.success &&
    parsed.data.GRAFT_UNINSTALL_UNLISTED &&
    parsed.data.GRAFT_ALLOWED_ACCOUNTS.length === 0
  ) {
    problems.push("GRAFT_UNINSTALL_UNLISTED: needs GRAFT_ALLOWED_ACCOUNTS");
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
    githubApiUrl: d.GITHUB_API_URL.replace(/\/+$/, ""),
    pgbossSchema: d.PGBOSS_SCHEMA,
    workerConcurrency: d.WORKER_CONCURRENCY,
    webhookBodyLimitBytes: d.WEBHOOK_BODY_LIMIT_BYTES,
    smeeUrl: d.SMEE_URL,
    agentLogins: Object.freeze([...d.GRAFT_AGENT_LOGINS]),
    agentCoauthorEmails: Object.freeze([...d.GRAFT_AGENT_COAUTHOR_EMAILS]),
    // Phase 1 step 7 (D9 c): compared with `<slug>[bot]` logins, which GitHub lowercases.
    githubAppSlug: d.GITHUB_APP_SLUG?.toLowerCase(),
    anthropicApiKey: d.ANTHROPIC_API_KEY,
    anthropicAuthToken: d.ANTHROPIC_AUTH_TOKEN,
    anthropicFederation: federationFrom(d),
    anthropicBaseUrl: d.ANTHROPIC_BASE_URL,
    llmRegistry,
    deployment: d.GRAFT_DEPLOYMENT,
    llmModelFast: llmRegistry?.roles.fast ?? d.GRAFT_LLM_MODEL_FAST,
    llmModelStrong: llmRegistry?.roles.strong ?? d.GRAFT_LLM_MODEL_STRONG,
    llmTimeoutMs: d.GRAFT_LLM_TIMEOUT_MS,
    llmMaxRetries: d.GRAFT_LLM_MAX_RETRIES,
    llmRefusalFallback: d.GRAFT_LLM_REFUSAL_FALLBACK,
    llmRefusalFallbackModel: llmRegistry
      ? llmRegistry.roles.refusalFallback
      : d.GRAFT_LLM_REFUSAL_FALLBACK_MODEL,
    llmDailyTokenBudget: d.GRAFT_LLM_DAILY_TOKEN_BUDGET,
    intentSensitivePaths: Object.freeze([...d.GRAFT_INTENT_SENSITIVE_PATHS]),
    feedbackPollCron: d.GRAFT_FEEDBACK_POLL_CRON,
    incidentLabel: d.GRAFT_INCIDENT_LABEL,
    metricsRollupCron: d.GRAFT_METRICS_ROLLUP_CRON,
    metricsExcludedAuthors: Object.freeze([...d.GRAFT_METRICS_EXCLUDED_AUTHORS]),
    modeCeiling: d.GRAFT_MODE_CEILING,
    modeApplyCron: d.GRAFT_MODE_APPLY_CRON,
    permissionsRefreshCron: d.GRAFT_PERMISSIONS_REFRESH_CRON,
    policyCardWaitSeconds: d.GRAFT_POLICY_CARD_WAIT_SECONDS,
    breakGlassLabel: d.GRAFT_BREAK_GLASS_LABEL,
    guardDetection: d.GRAFT_GUARD_DETECTION,
    guardConfirm: d.GRAFT_GUARD_CONFIRM,
    guardConfirmSeconds: d.GRAFT_GUARD_CONFIRM_SECONDS,
    guardObserveDelaySeconds: d.GRAFT_GUARD_OBSERVE_DELAY_SECONDS,
    guardRetentionDays: d.GRAFT_GUARD_RETENTION_DAYS,
    guardPruneCron: d.GRAFT_GUARD_PRUNE_CRON,
    guardRevert: d.GRAFT_GUARD_REVERT,
    guardMaxOpenReverts: d.GRAFT_GUARD_MAX_OPEN_REVERTS,
    guardRevertMaxPaths: d.GRAFT_GUARD_REVERT_MAX_PATHS,
    guardRevertMaxTreeReads: d.GRAFT_GUARD_REVERT_MAX_TREE_READS,
    guardRevertMaxAgeHours: d.GRAFT_GUARD_REVERT_MAX_AGE_HOURS,
    mcp: d.GRAFT_MCP,
    mcpAllowedOrigins: Object.freeze([...d.GRAFT_MCP_ALLOWED_ORIGINS]),
    mcpRateLimitPerMinute: d.GRAFT_MCP_RATE_LIMIT_PER_MINUTE,
    mcpAuthFailuresPerMinute: d.GRAFT_MCP_AUTH_FAILURES_PER_MINUTE,
    mcpOpenChangePerHour: d.GRAFT_MCP_OPEN_CHANGE_PER_HOUR,
    mcpMaxTokensPerRepo: d.GRAFT_MCP_MAX_TOKENS_PER_REPO,
    trustProxy: Object.freeze([...d.GRAFT_TRUST_PROXY]),
    allowedAccounts: Object.freeze([...d.GRAFT_ALLOWED_ACCOUNTS]),
    uninstallUnlisted: d.GRAFT_UNINSTALL_UNLISTED,
  });
}
