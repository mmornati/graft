import type { z } from "zod";
import type { JobContext } from "../core/context.js";

export interface JobDefinition<T> {
  /** Dotted name, e.g. "github.webhook", "intent.generate". */
  name: string;
  /** Validated on send AND on receive. */
  schema: z.ZodType<T>;
  options?: {
    retryLimit?: number;
    retryDelaySeconds?: number;
    retryBackoff?: boolean;
    expireInSeconds?: number;
    /**
     * How long a completed or failed job stays in pg-boss (queue option `deleteAfterSeconds`).
     * Default 7 days. Jobs whose data holds PR text (`github.webhook`) set a much shorter value.
     */
    deleteAfterSeconds?: number;
  };
  handle(data: T, ctx: JobContext): Promise<void>;
}

export function defineJob<T>(def: JobDefinition<T>): JobDefinition<T> {
  return def;
}
