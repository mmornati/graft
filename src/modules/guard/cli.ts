/**
 * `graft guard list` (Phase 1 step 4, §10). Reads the database only: no GitHub, no queue. The
 * output names SHAs, check names, PR numbers and statuses; `graft-ops.ts` makes it terminal-safe.
 */
import type { Db } from "../../db/client.js";
import type { GuardEventStatus } from "../../db/schema.js";
import { classifyStored } from "./observe.js";
import { type GuardEventRow, listEvents } from "./store.js";

export const GUARD_STATUSES: readonly GuardEventStatus[] = [
  "detected",
  "confirming",
  "culprit_found",
  "ambiguous",
  "no_culprit",
  "flaky",
  "revert_opened",
  "reverted",
  "dismissed",
  "error",
];

export type ListedEvent = GuardEventRow & { culprit_pr_number: number | null };

export async function guardList(
  db: Db,
  repositoryId: number,
  o: { status?: GuardEventStatus; limit: number },
): Promise<ListedEvent[]> {
  return listEvents(db, repositoryId, o);
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function prs(e: ListedEvent): { culprit: number | null; candidates: number[]; unresolved: number } {
  const candidates = [
    ...new Set(e.candidates.flatMap((c) => (c.prNumber === null ? [] : [c.prNumber]))),
  ].sort((a, b) => a - b);
  const unresolved = e.candidates.filter(
    (c) => c.kind === "unresolved" || c.kind === "multiple" || c.kind === "truncated",
  ).length;
  const c = classifyStored(e.candidates);
  const culprit = e.culprit_pr_number ?? (c.status === "culprit_found" ? c.prNumber : null);
  return { culprit, candidates, unresolved };
}

function who(e: ListedEvent): string {
  const p = prs(e);
  if (p.culprit !== null && classifyStored(e.candidates).status === "culprit_found") {
    return `culprit #${p.culprit}`;
  }
  if (p.candidates.length === 0 && p.unresolved === 0) return "no PR";
  const parts = p.candidates.map((n) => `#${n}`);
  if (p.unresolved > 0) parts.push(`(${p.unresolved} unresolved)`);
  return `candidates ${parts.join(" ")}`;
}

/** One line per event: `detected_at  status  failing_sha(7)  checks(first 3)  culprit`. */
export function renderGuardList(events: readonly ListedEvent[]): string {
  if (events.length === 0) return "no guard events\n";
  return events
    .map((e) => {
      const names = e.failing_checks.map((c) => c.name);
      const checks =
        names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
      return `${iso(e.detected_at ?? e.created_at)}  ${e.status}  ${e.failing_sha.slice(0, 7)}  ${checks}  ${who(e)}\n`;
    })
    .join("");
}

export function guardListJson(events: readonly ListedEvent[]): unknown {
  return {
    events: events.map((e) => {
      const p = prs(e);
      return {
        id: e.id,
        status: e.status,
        failingSha: e.failing_sha,
        lastGreenSha: e.last_green_sha,
        failingChecks: e.failing_checks,
        culpritPr: p.culprit,
        candidatePrs: p.candidates,
        unresolvedCommits: p.unresolved,
        detectedAt: (e.detected_at ?? e.created_at).toISOString(),
        confirmedAt: e.confirmed_at?.toISOString() ?? null,
        commentId: e.comment_id,
        guardMode: e.guard_mode,
      };
    }),
  };
}
