/** Job payloads of the guard (Phase 1 step 4): IDs and SHAs only. A leaf: it imports no job. */
import { z } from "zod";

export const SHA = z.string().regex(/^[0-9a-f]{40}$/);
export const NAME_PART = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);

export const observeSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: NAME_PART,
  repo: NAME_PART,
  sha: SHA,
});
export type ObserveData = z.infer<typeof observeSchema>;

export const confirmSchema = z.object({ eventId: z.uuid() });
export type ConfirmData = z.infer<typeof confirmSchema>;

/**
 * D12: one `guard.observe` per repository, commit and window. The window is the observe delay
 * (30 s by default, which is the spec's `floor(now/30 s)`): a job starts `delay` seconds after the
 * first trigger of its window, so it runs after every trigger of that window, and a trigger after
 * it ran falls into a later window with its own job. With a delay of 0 there is no window and no
 * key (every trigger runs). The singleton id also deduplicates completed jobs for 7 days, which is
 * why the key carries the window and never only the SHA.
 */
export function observeKey(
  repositoryId: number,
  sha: string,
  nowMs: number,
  delaySeconds: number,
): string | undefined {
  if (delaySeconds <= 0) return undefined;
  return `guard:observe:${repositoryId}:${sha}:${Math.floor(nowMs / (delaySeconds * 1000))}`;
}
