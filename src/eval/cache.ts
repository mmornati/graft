/** Live results are cached by (inputs, prompt fingerprint) (E20). Fake mode never uses this. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CardResult } from "../modules/intent/index.js";
import { promptFingerprint } from "../modules/intent/index.js";
import type { MeteredCall } from "./metered.js";
import { type CaseSet, readPrivate, writePrivate } from "./store.js";

export interface CacheEntry {
  result: CardResult;
  calls: MeteredCall[];
  costUsd: number;
}

export function cacheKey(inputHash: string): string {
  return createHash("sha256")
    .update(JSON.stringify([inputHash, promptFingerprint(), "live"]))
    .digest("hex");
}

/** A result is frozen in only when it is final: ok, or a failure that a retry cannot fix. */
export const isCacheable = (r: CardResult): boolean => r.status === "ok" || !r.retryable;

const shape = z.object({
  result: z.custom<CardResult>(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as CardResult).inputHash === "string" &&
      typeof (v as CardResult).status === "string" &&
      typeof (v as CardResult).risk === "object",
  ),
  calls: z.array(
    z.object({
      model: z.string(),
      usage: z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadTokens: z.number(),
        cacheWriteTokens: z.number(),
      }),
    }),
  ),
  costUsd: z.number(),
});

export async function readCache(
  set: CaseSet,
  key: string,
  inputHash: string,
): Promise<CacheEntry | null> {
  let text: string | null;
  try {
    text = await readPrivate(set, `cache/${key}.json`);
  } catch {
    return null; // unreadable or sealed with another key: a miss
  }
  if (text === null) return null;
  try {
    const parsed = shape.parse(JSON.parse(text)) as CacheEntry;
    return parsed.result.inputHash === inputHash ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeCache(set: CaseSet, key: string, entry: CacheEntry): Promise<void> {
  await writePrivate(set, `cache/${key}.json`, JSON.stringify(entry));
}
