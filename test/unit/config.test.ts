import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/index.js";
import { TEST_PRIVATE_KEY } from "../helpers/config.js";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  GITHUB_APP_ID: "42",
  GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
  GITHUB_WEBHOOK_SECRET: "0123456789abcdef0123",
};

function errorOf(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected loadConfig to throw");
}

describe("config", () => {
  it("U-CFG-1 a valid env parses; defaults are applied; the result is frozen", () => {
    const c = loadConfig(valid);
    expect(c).toMatchObject({
      nodeEnv: "development",
      host: "0.0.0.0",
      port: 3000,
      logLevel: "info",
      githubAppId: 42,
      githubApiUrl: "https://api.github.com",
      pgbossSchema: "pgboss",
      workerConcurrency: 5,
      webhookBodyLimitBytes: 26214400,
    });
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("U-CFG-1b trailing slashes on GITHUB_API_URL are stripped", () => {
    const c = loadConfig({ ...valid, GITHUB_API_URL: "https://ghe.example.com/api/v3//" });
    expect(c.githubApiUrl).toBe("https://ghe.example.com/api/v3");
  });

  it("U-CFG-2 an empty env names every required variable in one message", () => {
    const msg = errorOf({}).message;
    for (const name of [
      "DATABASE_URL",
      "GITHUB_APP_ID",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_PRIVATE_KEY_PATH",
    ]) {
      expect(msg).toContain(name);
    }
  });

  it("U-CFG-3 error messages never contain provided secret or key values", () => {
    const secret = "short-secret";
    const badKey = "not-a-pem-SUPERSECRETKEYMATERIAL";
    const msg = errorOf({
      DATABASE_URL: "mysql://user:hunter2@host/db",
      GITHUB_APP_ID: "abc",
      GITHUB_APP_PRIVATE_KEY: badKey,
      GITHUB_WEBHOOK_SECRET: secret,
      PORT: "99999",
    }).message;
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain("SUPERSECRETKEYMATERIAL");
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("99999");
    expect(msg).toContain("GITHUB_WEBHOOK_SECRET");
    expect(msg).toContain("DATABASE_URL");
  });

  it("U-CFG-4 literal \\n in a key is normalized; the key path reads a temp file", () => {
    const escaped = TEST_PRIVATE_KEY.trim().replace(/\n/g, "\\n");
    expect(escaped).not.toContain("\n");
    const c = loadConfig({ ...valid, GITHUB_APP_PRIVATE_KEY: escaped });
    expect(c.githubAppPrivateKey).toBe(TEST_PRIVATE_KEY.trim());

    const dir = mkdtempSync(join(tmpdir(), "graft-cfg-"));
    const file = join(dir, "key.pem");
    writeFileSync(file, TEST_PRIVATE_KEY);
    const { GITHUB_APP_PRIVATE_KEY: _omit, ...rest } = valid;
    const c2 = loadConfig({ ...rest, GITHUB_APP_PRIVATE_KEY_PATH: file });
    expect(c2.githubAppPrivateKey).toBe(TEST_PRIVATE_KEY);
  });

  it("U-CFG-5 both or neither key variable is an error; a non-PEM key is an error", () => {
    const { GITHUB_APP_PRIVATE_KEY: _omit, ...rest } = valid;
    expect(errorOf({ ...valid, GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/x.pem" }).message).toContain(
      "exactly one",
    );
    expect(errorOf(rest).message).toContain("exactly one");
    expect(errorOf({ ...valid, GITHUB_APP_PRIVATE_KEY: "nope" }).message).toContain(
      "GITHUB_APP_PRIVATE_KEY",
    );
  });

  it("U-CFG-6 bad DATABASE_URL scheme, PORT=0 and a short webhook secret are each rejected", () => {
    expect(errorOf({ ...valid, DATABASE_URL: "mysql://x/y" }).message).toContain("DATABASE_URL");
    expect(errorOf({ ...valid, PORT: "0" }).message).toContain("PORT");
    expect(errorOf({ ...valid, GITHUB_WEBHOOK_SECRET: "short" }).message).toContain(
      "GITHUB_WEBHOOK_SECRET",
    );
  });

  it("U-CFG-6b the .env.example webhook secret is refused in production only", () => {
    const placeholder = { ...valid, GITHUB_WEBHOOK_SECRET: "change-me-dev-webhook-secret" };
    expect(loadConfig(placeholder).githubWebhookSecret).toBe("change-me-dev-webhook-secret");
    const msg = errorOf({ ...placeholder, NODE_ENV: "production" }).message;
    expect(msg).toContain("GITHUB_WEBHOOK_SECRET");
    expect(msg).not.toContain("change-me-dev-webhook-secret");
    expect(loadConfig({ ...valid, NODE_ENV: "production" }).nodeEnv).toBe("production");
  });

  it("U-CFG-7 agent logins and co-author emails: defaults, normalization, and rejection by name only", () => {
    const d = loadConfig(valid);
    expect(d.agentLogins).toEqual([]);
    expect(d.agentCoauthorEmails).toEqual(["noreply@anthropic.com"]);
    expect(Object.isFrozen(d.agentLogins)).toBe(true);
    expect(Object.isFrozen(d.agentCoauthorEmails)).toBe(true);

    const c = loadConfig({
      ...valid,
      GRAFT_AGENT_LOGINS: " Claude-Bot ,my-agent[bot],, ",
      GRAFT_AGENT_COAUTHOR_EMAILS: " A@Example.com , b@x.dev ",
      GITHUB_APP_SLUG: "graft-dev",
    });
    expect(c.agentLogins).toEqual(["claude-bot", "my-agent[bot]"]);
    expect(c.agentCoauthorEmails).toEqual(["a@example.com", "b@x.dev"]);
    expect(c.githubAppSlug).toBe("graft-dev");

    const badLogin = errorOf({ ...valid, GRAFT_AGENT_LOGINS: "ok-one,bad login" }).message;
    expect(badLogin).toContain("GRAFT_AGENT_LOGINS");
    expect(badLogin).not.toContain("bad login");
    const badEmail = errorOf({ ...valid, GRAFT_AGENT_COAUTHOR_EMAILS: "no-at-sign" }).message;
    expect(badEmail).toContain("GRAFT_AGENT_COAUTHOR_EMAILS");
    expect(badEmail).not.toContain("no-at-sign");
    expect(errorOf({ ...valid, GRAFT_AGENT_COAUTHOR_EMAILS: "a@b@c" }).message).toContain(
      "GRAFT_AGENT_COAUTHOR_EMAILS",
    );
  });
  it("U-CFG-8 LLM and intent settings: defaults, rules, and rejection by variable name only", () => {
    const d = loadConfig(valid);
    expect(d).toMatchObject({
      anthropicApiKey: undefined,
      llmModelFast: "claude-haiku-5-5",
      llmModelStrong: "claude-sonnet-5-5",
      llmTimeoutMs: 120000,
      llmMaxRetries: 2,
      llmRefusalFallback: true,
      llmDailyTokenBudget: 2000000,
      intentSensitivePaths: [],
      feedbackPollCron: "*/15 * * * *",
    });
    expect(Object.isFrozen(d.intentSensitivePaths)).toBe(true);

    const c = loadConfig({
      ...valid,
      ANTHROPIC_API_KEY: "sk-ant-test-value",
      GRAFT_LLM_MODEL_FAST: "claude-haiku-5-5",
      GRAFT_LLM_REFUSAL_FALLBACK: "false",
      GRAFT_LLM_DAILY_TOKEN_BUDGET: "0",
      GRAFT_LLM_TIMEOUT_MS: "5000",
      GRAFT_LLM_MAX_RETRIES: "5",
      GRAFT_INTENT_SENSITIVE_PATHS: " services/billing/** , **/payments/** ,, ",
      GRAFT_FEEDBACK_POLL_CRON: "off",
    });
    expect(c).toMatchObject({
      anthropicApiKey: "sk-ant-test-value",
      llmRefusalFallback: false,
      llmDailyTokenBudget: 0,
      llmTimeoutMs: 5000,
      llmMaxRetries: 5,
      intentSensitivePaths: ["services/billing/**", "**/payments/**"],
      feedbackPollCron: null,
    });

    const bad: [string, string][] = [
      ["GRAFT_LLM_MODEL_FAST", "gpt-4-SECRETVALUE"],
      ["GRAFT_LLM_MODEL_STRONG", "claude-UPPER"],
      ["GRAFT_LLM_TIMEOUT_MS", "1000"],
      ["GRAFT_LLM_MAX_RETRIES", "6"],
      ["GRAFT_LLM_REFUSAL_FALLBACK", "yes-SECRETVALUE"],
      ["GRAFT_LLM_DAILY_TOKEN_BUDGET", "-1"],
      ["GRAFT_INTENT_SENSITIVE_PATHS", "ok/**,../SECRETVALUE/x"],
      ["GRAFT_INTENT_SENSITIVE_PATHS", "!SECRETVALUE/**"],
      ["GRAFT_INTENT_SENSITIVE_PATHS", "a".repeat(201)],
      ["GRAFT_FEEDBACK_POLL_CRON", "every SECRETVALUE minutes"],
    ];
    for (const [name, value] of bad) {
      const msg = errorOf({ ...valid, [name]: value }).message;
      expect(msg, `${name}=${value.slice(0, 10)}`).toContain(name);
      expect(msg).not.toContain("SECRETVALUE");
    }
    // the API key value never appears in an error message caused by something else
    const other = errorOf({ ...valid, PORT: "0", ANTHROPIC_API_KEY: "sk-ant-LEAKCHECK" }).message;
    expect(other).not.toContain("sk-ant-LEAKCHECK");
  });
  it("U-CFG-33 gateway settings: base URL, bearer token, gateway model IDs, refusal fallback model", () => {
    const d = loadConfig(valid);
    expect(d).toMatchObject({
      anthropicAuthToken: undefined,
      anthropicBaseUrl: undefined,
      llmRefusalFallbackModel: undefined,
    });
    const c = loadConfig({
      ...valid,
      ANTHROPIC_AUTH_TOKEN: "or-token-value",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      GRAFT_LLM_MODEL_FAST: "anthropic/claude-haiku-5.5",
      GRAFT_LLM_MODEL_STRONG: "us.anthropic.claude-sonnet-5-5-v1:0",
      GRAFT_LLM_REFUSAL_FALLBACK_MODEL: "claude-opus-5-5",
    });
    expect(c).toMatchObject({
      anthropicApiKey: undefined,
      anthropicAuthToken: "or-token-value",
      anthropicBaseUrl: "https://openrouter.ai/api",
      llmModelFast: "anthropic/claude-haiku-5.5",
      llmModelStrong: "us.anthropic.claude-sonnet-5-5-v1:0",
      llmRefusalFallbackModel: "claude-opus-5-5",
    });

    const both = errorOf({
      ...valid,
      ANTHROPIC_API_KEY: "sk-ant-KEYCANARY",
      ANTHROPIC_AUTH_TOKEN: "TOKENCANARY",
    }).message;
    expect(both).toContain("ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN");
    expect(both).not.toContain("KEYCANARY");
    expect(both).not.toContain("TOKENCANARY");

    const bad: [string, string][] = [
      ["ANTHROPIC_BASE_URL", "not a SECRETVALUE url"],
      ["ANTHROPIC_BASE_URL", "ftp://SECRETVALUE.example/"],
      ["GRAFT_LLM_REFUSAL_FALLBACK_MODEL", "gpt-5-SECRETVALUE"],
      ["GRAFT_LLM_MODEL_FAST", "openai/gpt-5-secretvalue"],
      ["GRAFT_LLM_MODEL_FAST", "a.b.c.d.claude-secretvalue"],
    ];
    for (const [name, value] of bad) {
      const msg = errorOf({ ...valid, [name]: value }).message;
      expect(msg, `${name}=${value.slice(0, 10)}`).toContain(name);
      expect(msg.toLowerCase()).not.toContain("secretvalue");
    }
  });
  it("U-CFG-34 workload identity federation: all-or-nothing, one way to authenticate, names only", () => {
    const fed = {
      ANTHROPIC_FEDERATION_RULE_ID: "fdrl_01RULECANARY",
      ANTHROPIC_ORGANIZATION_ID: "00000000-0000-4000-8000-00000000cafe",
      ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_01SVACCANARY",
      ANTHROPIC_IDENTITY_TOKEN_FILE: "/var/run/secrets/PATHCANARY/token",
    };
    expect(loadConfig(valid).anthropicFederation).toBeUndefined();
    expect(loadConfig({ ...valid, ...fed }).anthropicFederation).toEqual({
      ruleId: "fdrl_01RULECANARY",
      organizationId: "00000000-0000-4000-8000-00000000cafe",
      serviceAccountId: "svac_01SVACCANARY",
      workspaceId: undefined,
      identityTokenFile: "/var/run/secrets/PATHCANARY/token",
    });
    expect(
      loadConfig({ ...valid, ...fed, ANTHROPIC_WORKSPACE_ID: "wrkspc_01W" }).anthropicFederation
        ?.workspaceId,
    ).toBe("wrkspc_01W");
    // Loopback http is fine for a local proxy; empty values count as unset.
    expect(
      loadConfig({ ...valid, ...fed, ANTHROPIC_BASE_URL: "http://localhost:8080" })
        .anthropicFederation,
    ).toBeDefined();
    expect(loadConfig({ ...valid, ANTHROPIC_FEDERATION_RULE_ID: " " }).anthropicFederation).toBe(
      undefined,
    );

    const canaries = ["RULECANARY", "00000000cafe", "SVACCANARY", "PATHCANARY", "KEYCANARY"];
    const noLeak = (msg: string) => {
      for (const c of canaries) expect(msg).not.toContain(c);
    };

    for (const missing of Object.keys(fed)) {
      const partial: Record<string, string> = { ...valid, ...fed };
      delete partial[missing];
      const msg = errorOf(partial).message;
      expect(msg, missing).toContain(`${missing}: federation needs all of`);
      noLeak(msg);
    }
    const onlyWorkspace = errorOf({ ...valid, ANTHROPIC_WORKSPACE_ID: "wrkspc_01W" }).message;
    expect(onlyWorkspace).toContain("ANTHROPIC_FEDERATION_RULE_ID / ANTHROPIC_ORGANIZATION_ID");

    for (const other of [
      { ANTHROPIC_API_KEY: "sk-ant-KEYCANARY" },
      { ANTHROPIC_AUTH_TOKEN: "KEYCANARY-token" },
    ]) {
      const msg = errorOf({ ...valid, ...fed, ...other }).message;
      expect(msg).toContain("ANTHROPIC_FEDERATION_*: set at most one way to authenticate");
      expect(msg).toContain(Object.keys(other)[0]);
      noLeak(msg);
    }

    const bad: [string, string][] = [
      ["ANTHROPIC_FEDERATION_RULE_ID", "rule-RULECANARY"],
      ["ANTHROPIC_ORGANIZATION_ID", "org-00000000cafe"],
      ["ANTHROPIC_SERVICE_ACCOUNT_ID", "fdrl_SVACCANARY"],
      ["ANTHROPIC_WORKSPACE_ID", "ws-SVACCANARY"],
      ["ANTHROPIC_IDENTITY_TOKEN_FILE", "relative/PATHCANARY"],
    ];
    for (const [name, value] of bad) {
      const msg = errorOf({ ...valid, ...fed, [name]: value }).message;
      expect(msg, name).toContain(`${name}: must be`);
      noLeak(msg);
    }
    const cleartext = errorOf({
      ...valid,
      ...fed,
      ANTHROPIC_BASE_URL: "http://proxy.example.test",
    }).message;
    expect(cleartext).toContain("ANTHROPIC_BASE_URL: must be https with federation");
    noLeak(cleartext);
  });
  it("U-CFG-30 an invalid env glob names its position and the reason, never the value", () => {
    const msg = errorOf({ ...valid, GRAFT_INTENT_SENSITIVE_PATHS: "a/**,/**.pem" }).message;
    expect(msg).toContain("GRAFT_INTENT_SENSITIVE_PATHS: glob 2 is invalid");
    expect(msg).toContain("does not compile");
    expect(msg).not.toContain(".pem");
    const costly = errorOf({
      ...valid,
      GRAFT_INTENT_SENSITIVE_PATHS: `ok/**,${"x".repeat(60)}/SECRETVALUE/**`,
    }).message;
    expect(costly).toContain("glob 2 is invalid (too costly");
    expect(costly).not.toContain("SECRETVALUE");
    // Valid lists still load.
    expect(
      loadConfig({ ...valid, GRAFT_INTENT_SENSITIVE_PATHS: "a/**, **/b/*.ts" })
        .intentSensitivePaths,
    ).toEqual(["a/**", "**/b/*.ts"]);
  });

  it("U-CFG-31 a lookalike glob in the env is rejected (detail 9)", () => {
    const msg = errorOf({ ...valid, GRAFT_INTENT_SENSITIVE_PATHS: "s\u0435crets/**" }).message;
    expect(msg).toContain("GRAFT_INTENT_SENSITIVE_PATHS: glob 1 is invalid");
    expect(msg).toContain("mixes writing systems");
    expect(msg).not.toContain("s\u0435crets");
    // An honest non-ASCII glob loads.
    expect(
      loadConfig({ ...valid, GRAFT_INTENT_SENSITIVE_PATHS: "docs/\u0440\u0443\u043a/**" })
        .intentSensitivePaths,
    ).toEqual(["docs/\u0440\u0443\u043a/**"]);
  });

  it("U-CFG-31 (invisible and compatibility lookalikes) are rejected in the env too", () => {
    for (const value of [
      "sec\u034Frets/**",
      "secrets\uFE0F/**",
      "\uFF53ecrets/**",
      "\u{1D42C}ecrets/**",
    ]) {
      const msg = errorOf({ ...valid, GRAFT_INTENT_SENSITIVE_PATHS: value }).message;
      expect(msg).toContain("GRAFT_INTENT_SENSITIVE_PATHS: glob 1 is invalid");
    }
    expect(
      loadConfig({
        ...valid,
        GRAFT_INTENT_SENSITIVE_PATHS: "caf\u00e9/**,\u65e5\u672c/**,\ud55c\uae00/**",
      }).intentSensitivePaths,
    ).toHaveLength(3);
  });

  it("U-CFG-32 step 6 settings: defaults, off values and rejection by variable name only", () => {
    expect(loadConfig(valid)).toMatchObject({
      incidentLabel: "incident",
      metricsRollupCron: "15 2 * * *",
      metricsExcludedAuthors: ["dependabot[bot]", "renovate[bot]"],
    });
    const c = loadConfig({
      ...valid,
      GRAFT_INCIDENT_LABEL: "off",
      GRAFT_METRICS_ROLLUP_CRON: "off",
      GRAFT_METRICS_EXCLUDED_AUTHORS: "Some-Bot[bot], other",
    });
    expect(c).toMatchObject({
      incidentLabel: null,
      metricsRollupCron: null,
      metricsExcludedAuthors: ["some-bot[bot]", "other"],
    });
    expect(Object.isFrozen(c.metricsExcludedAuthors)).toBe(true);
    expect(loadConfig({ ...valid, GRAFT_INCIDENT_LABEL: "sev:1 / prod-1.2" }).incidentLabel).toBe(
      "sev:1 / prod-1.2",
    );
    for (const [name, value] of [
      ["GRAFT_INCIDENT_LABEL", "bad<SECRETVALUE>"],
      ["GRAFT_INCIDENT_LABEL", "x".repeat(51)],
      ["GRAFT_METRICS_ROLLUP_CRON", "every SECRETVALUE minutes"],
      ["GRAFT_METRICS_EXCLUDED_AUTHORS", "bad login SECRETVALUE"],
    ] as const) {
      const msg = errorOf({ ...valid, [name]: value }).message;
      expect(msg, name).toContain(name);
      expect(msg).not.toContain("SECRETVALUE");
    }
  });
});

describe("config: Phase 1 step 7", () => {
  it("U-CFG-40 GRAFT_TRUST_PROXY: empty → off; addresses and CIDR ranges accepted; true, a hop count, a hostname and a bad prefix → ConfigError naming the entry index only", () => {
    expect(loadConfig(valid).trustProxy).toEqual([]);
    expect(loadConfig({ ...valid, GRAFT_TRUST_PROXY: "" }).trustProxy).toEqual([]);
    const c = loadConfig({ ...valid, GRAFT_TRUST_PROXY: "10.0.0.1,10.0.0.0/8,::1,fd00::/8" });
    expect(c.trustProxy).toEqual(["10.0.0.1", "10.0.0.0/8", "::1", "fd00::/8"]);
    expect(Object.isFrozen(c.trustProxy)).toBe(true);
    for (const value of ["true", "2", "proxy.local", "10.0.0.0/33"]) {
      const msg = errorOf({ ...valid, GRAFT_TRUST_PROXY: `10.0.0.1,${value}` }).message;
      expect(msg, value).toContain(
        "GRAFT_TRUST_PROXY: entry 2 must be an IP address or a CIDR range",
      );
      expect(msg, value).not.toContain(value === "2" ? "proxy.local" : value);
    }
  });

  it("U-CFG-41 GITHUB_APP_SLUG=Graft-Dev is stored as graft-dev (step 6 review 2, nit F)", () => {
    expect(loadConfig({ ...valid, GITHUB_APP_SLUG: "Graft-Dev" }).githubAppSlug).toBe("graft-dev");
    expect(loadConfig(valid).githubAppSlug).toBeUndefined();
  });
});
