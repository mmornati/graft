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
  "*.anthropicApiKey",
  "*.anthropicAuthToken",
  "*.apiKey",
  "*.authToken",
  // Federation: everything but the rule ID, which is logged on purpose.
  "*.anthropicFederation",
  "*.federation",
  "*.organizationId",
  "*.serviceAccountId",
  "*.identityTokenFile",
  "*.identityToken",
  "*.assertion",
  "*.access_token",
  'req.headers["x-api-key"]',
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
