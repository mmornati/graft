import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/logger.js";
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
    const config = testConfig();
    const log = createLogger({ logLevel: "info" }, stream);
    log.info({ config }, "config");
    expect(out).not.toContain(config.githubAppPrivateKey);
    expect(out).not.toContain(config.githubWebhookSecret);
    expect(out).not.toContain(config.databaseUrl);
    expect(out).toContain("[redacted]");
  });
});
