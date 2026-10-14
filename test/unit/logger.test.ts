import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { REDACT_PATHS } from "../../src/core/logger.js";
import { testConfig } from "../helpers/config.js";

describe("logger redaction", () => {
  it("U-LOG-1 logging { config } censors the private key, webhook secret and database URL", () => {
    let out = "";
    const stream = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, stream);
    const config = testConfig();
    log.info({ config }, "config");
    expect(out).not.toContain(config.githubAppPrivateKey);
    expect(out).not.toContain(config.githubWebhookSecret);
    expect(out).not.toContain(config.databaseUrl);
    expect(out).toContain("[redacted]");
  });
});
