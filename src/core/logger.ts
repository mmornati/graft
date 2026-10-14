import { type DestinationStream, type Logger, pino } from "pino";
import type { Config } from "../config/index.js";

export type { Logger };

export const REDACT_PATHS = [
  'req.headers["x-hub-signature-256"]',
  "req.headers.authorization",
  "*.privateKey",
  "*.webhookSecret",
  "*.githubAppPrivateKey",
  "*.githubWebhookSecret",
  "*.databaseUrl",
  "*.token",
];

export function createLogger(
  config: Pick<Config, "logLevel">,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: config.logLevel,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    },
    destination,
  );
}
