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
});
