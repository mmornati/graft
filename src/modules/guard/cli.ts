/**
 * `graft guard list` (Phase 1 step 4, §10; step 5, §13). Reads the database only: no GitHub, no
 * queue. The output names SHAs, check names, PR numbers, statuses and revert outcomes;
 * `graft-ops.ts` makes it terminal-safe.
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
  "needs_human",
  "revert_opened",
  "reverted",
  "revert_closed",
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

/**
 * `flaky` with no reason was still undecided at its last confirm attempt, not green again (D9):
 * neither a caught breakage nor a flake (step 4 review 2, nit D).
 */
function statusLabel(e: ListedEvent): string {
  return e.status === "flaky" && e.confirm_reason === null ? "flaky (unconfirmed)" : e.status;
}

const words = (code: string): string => code.replace(/_/g, " ");

/** Step 5 (§13): what the revert became, or "" when there is no revert story. */
export function revertLabel(e: ListedEvent): string {
  switch (e.revert_outcome) {
    case null:
      return "";
    case "planned":
      return `would revert ${e.revert_plan_paths ?? 0} paths`;
    case "opened":
      return `revert #${e.revert_pr_number ?? "?"} (auto-merge ${e.auto_merge_state === "enabled" ? "on" : "off"})`;
    case "needs_human":
      return `needs human: ${words(e.revert_reason ?? "unknown")}${
        e.revert_reason === "touched_later" ? ` (${e.revert_conflicts ?? 0})` : ""
      }`;
    case "skipped":
      return `skipped: ${words(e.revert_reason ?? "unknown")}`;
    case "error":
      return `error: ${e.revert_reason ?? "unknown"}${
        e.revert_pr_number === null ? "" : ` (revert #${e.revert_pr_number})`
      }`;
  }
}

/**
 * One line per event: `detected_at  status  failing_sha(7)  checks(first 3)  culprit`, then the
 * revert column when there is one.
 */
export function renderGuardList(events: readonly ListedEvent[]): string {
  if (events.length === 0) return "no guard events\n";
  return events
    .map((e) => {
      const names = e.failing_checks.map((c) => c.name);
      const checks =
        names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
      const revert = revertLabel(e);
      return `${iso(e.detected_at ?? e.created_at)}  ${statusLabel(e)}  ${e.failing_sha.slice(0, 7)}  ${checks}  ${who(e)}${revert === "" ? "" : `  ${revert}`}\n`;
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
        confirmReason: e.confirm_reason,
        commentId: e.comment_id,
        guardMode: e.guard_mode,
        revert: {
          outcome: e.revert_outcome,
          reason: e.revert_reason,
          prNumber: e.revert_pr_number,
          branch: e.revert_branch,
          commitSha: e.revert_commit_sha,
          planPaths: e.revert_plan_paths,
          conflicts: e.revert_conflicts,
          autoMergeState: e.auto_merge_state,
          autoMergeReason: e.auto_merge_reason,
        },
      };
    }),
  };
}
