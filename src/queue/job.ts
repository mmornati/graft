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
  };
  handle(data: T, ctx: JobContext): Promise<void>;
}

export function defineJob<T>(def: JobDefinition<T>): JobDefinition<T> {
  return def;
}
