import { generateKeyPairSync } from "node:crypto";
import { type Config, loadConfig } from "../../src/config/index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export const TEST_PRIVATE_KEY = privateKey;
export const TEST_PUBLIC_KEY = publicKey;
export const TEST_WEBHOOK_SECRET = "test-webhook-secret-0123456789";
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://graft:graft@localhost:55432/graft_test";
export const FIXED_NOW = new Date("2026-10-14T12:00:00Z");
export const fixedClock = { now: () => new Date(FIXED_NOW) };

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: TEST_DATABASE_URL,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    ...overrides,
  });
}
