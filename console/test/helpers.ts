import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { buildApp } from "../server/src/app.js";
import type { GithubOAuth } from "../server/src/auth.js";
import { type Config, loadConfig } from "../server/src/config.js";
import { createReadOnlyDb, type Db } from "../server/src/db.js";
import { loadWebAssets } from "../server/src/static.js";

export const SESSION_SECRET = "s".repeat(40);

/** A minimal web build: the console serves whatever the build wrote, so tests write their own. */
export function testWeb() {
  const dir = mkdtempSync(join(tmpdir(), "graft-console-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Graft Console</title>");
  writeFileSync(join(dir, "assets", "app-TEST.css"), "body{}");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ css: "/assets/app-TEST.css" }));
  return loadWebAssets(dir);
}

export function githubConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    CONSOLE_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
    CONSOLE_AUTH: "github",
    CONSOLE_PUBLIC_URL: "https://console.example.test",
    CONSOLE_GITHUB_CLIENT_ID: "Iv1.0123456789abcdef",
    CONSOLE_GITHUB_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567",
    CONSOLE_ALLOWED_USERS: "octo-op, 4242",
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    ...over,
  });
}

export function fakeOAuth(
  user: { login: string; id: number } | Error,
): GithubOAuth & { codes: string[] } {
  const codes: string[] = [];
  return {
    codes,
    async exchangeCode(code) {
      codes.push(code);
      if (user instanceof Error) throw user;
      return "gho_test";
    },
    async fetchUser() {
      if (user instanceof Error) throw user;
      return user;
    },
  };
}

export async function testApp(o: {
  config: Config;
  db?: Db;
  oauth?: GithubOAuth;
  now?: () => number;
  pgboss?: boolean;
}) {
  const db = o.db ?? createReadOnlyDb(o.config.databaseUrl, { statementTimeoutMs: 5000 });
  return buildApp({
    config: o.config,
    db,
    log: pino({ level: "silent" }),
    web: testWeb(),
    version: "test",
    pgboss: o.pgboss ?? false,
    ...(o.oauth ? { oauth: o.oauth } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
}
