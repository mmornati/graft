import type { z } from "zod";
import type { Logger } from "../core/logger.js";

/**
 * Validates a webhook payload against the fields a handler reads. On mismatch it logs the issue
 * PATHS only (never payload values) and returns undefined; the handler then returns instead of
 * throwing, because retrying a malformed or relabeled payload cannot help.
 */
export function parsePayload<T>(
  schema: z.ZodType<T>,
  event: { name: string; deliveryId: string; payload: unknown },
  log: Logger,
): T | undefined {
  const res = schema.safeParse(event.payload);
  if (res.success) return res.data;
  log.warn(
    {
      outcome: "payload_shape_mismatch",
      event: event.name,
      deliveryId: event.deliveryId,
      issues: res.error.issues.map((i) => i.path.join(".") || "(root)"),
    },
    "webhook payload does not match the expected shape",
  );
  return undefined;
}
