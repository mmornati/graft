import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../server/src/config.js";

const DB = { CONSOLE_DATABASE_URL: "postgres://c@localhost/graft" };

describe("loadConfig", () => {
  it("needs every GitHub setting by default", () => {
    expect(() => loadConfig(DB)).toThrow(
      /CONSOLE_AUTH=github needs CONSOLE_PUBLIC_URL, .*CONSOLE_SESSION_SECRET/,
    );
  });

  it("allows no sign-in only on loopback", () => {
    expect(loadConfig({ ...DB, CONSOLE_AUTH: "none" }).auth).toEqual({ mode: "none" });
    expect(() => loadConfig({ ...DB, CONSOLE_AUTH: "none", HOST: "0.0.0.0" })).toThrow(ConfigError);
  });

  it("validates the database URL, time zone and users", () => {
    expect(() => loadConfig({ CONSOLE_DATABASE_URL: "mysql://x" })).toThrow(/postgres:\/\//);
    expect(() =>
      loadConfig({ ...DB, CONSOLE_AUTH: "none", CONSOLE_TIME_ZONE: "Mars/Olympus" }),
    ).toThrow(/IANA time zone/);
    expect(() =>
      loadConfig({
        ...DB,
        CONSOLE_PUBLIC_URL: "https://c.example",
        CONSOLE_GITHUB_CLIENT_ID: "Iv1.0123456789",
        CONSOLE_GITHUB_CLIENT_SECRET: "x".repeat(40),
        CONSOLE_ALLOWED_USERS: "not a login!",
        CONSOLE_SESSION_SECRET: "s".repeat(32),
      }),
    ).toThrow(/GitHub logins or numeric user ids/);
  });

  it("reads defaults", () => {
    const c = loadConfig({ ...DB, CONSOLE_AUTH: "none" });
    expect(c).toMatchObject({
      host: "127.0.0.1",
      port: 3100,
      timeZone: "UTC",
      dailyTokenBudget: 2_000_000,
      requireReadOnlyRole: true,
      statementTimeoutMs: 10_000,
    });
  });
});
