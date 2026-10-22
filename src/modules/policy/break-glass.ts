/**
 * Break-glass (Phase 1 step 3, spec §6 steps 1 and 2). `resolveBreakGlass` decides what the
 * break-glass label means for the PR's current head, outside the change lock. It reads the issue
 * events API (who applied or removed the label, D2) and the collaborator role (D3), and the audit
 * log (D6). It writes nothing: the job writes the row inside the lock, in the publish transaction.
 *
 * Payloads are triggers. The only payload value used here is the head SHA of the `labeled`
 * delivery (D4), and only as an equality filter: it can refuse a break-glass, never grant one. Who
 * applied the label comes from the issue events API, never from the webhook.
 */
import type { Db } from "../../db/client.js";
import type { GitHubClient } from "../../github/client-factory.js";
import {
  atLeast,
  type CollaboratorRole,
  classifiedErrors,
  collaboratorRole,
} from "../../github/collaborator.js";
import { toJobError } from "../../github/errors.js";
import { type AuditRow, activeBreakGlass, latestAuditForHead } from "../audit/index.js";

/** D2: at most 10 pages of 100 issue events per evaluation. */
export const EVENT_PAGE = 100;
export const MAX_EVENT_PAGES = 10;

export interface BreakGlassActor {
  id: number;
  login: string;
}

export type IgnoredReason = "role_too_low" | "bot" | "role_unverified" | "actor_unknown";

/**
 * What the label means for the current head. `record` says whether the job must write an audit
 * row for it (a new verification); a state replayed from the audit log writes nothing.
 */
export type BreakGlassFacts =
  | { state: "none" }
  | {
      state: "applied";
      record: boolean;
      actor: BreakGlassActor;
      role: CollaboratorRole;
      self: boolean;
      headSha: string;
      labelEventAt: Date | null;
    }
  | {
      state: "ignored";
      record: boolean;
      reason: IgnoredReason;
      actor: BreakGlassActor | null;
      role: CollaboratorRole | null;
      self: boolean;
      labelEventAt: Date | null;
    }
  | { state: "stale"; record: boolean }
  | { state: "removed"; actor: BreakGlassActor | null; labelEventAt: Date | null };

/** D1: label names are matched case-insensitively. A null label (`off`) matches nothing. */
export function isBreakGlassLabel(label: string | null, name: string): boolean {
  return label !== null && name.toLowerCase() === label.toLowerCase();
}

interface IssueEventLike {
  event?: string;
  created_at?: string;
  label?: { name?: string } | null;
  actor?: { id?: number; login?: string; type?: string } | null;
}

type LabelEvent =
  | { found: false }
  | { found: true; actor: (BreakGlassActor & { bot: boolean }) | null; at: Date | null };

/**
 * D2: the latest `labeled` (or `unlabeled`) event for the label on the PR. The API lists events
 * oldest first and has no ordering parameter (T1), so every page up to the cap is read and the
 * newest match wins. When the cap is reached with more events left, a later event could be on an
 * unread page: not found (fail closed).
 */
export async function latestLabelEvent(
  octokit: GitHubClient,
  o: { owner: string; repo: string; prNumber: number; label: string },
  kind: "labeled" | "unlabeled",
): Promise<LabelEvent> {
  const events: IssueEventLike[] = [];
  let truncated = false;
  try {
    for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
      const res = await octokit.rest.issues.listEvents({
        owner: o.owner,
        repo: o.repo,
        issue_number: o.prNumber,
        per_page: EVENT_PAGE,
        page,
      });
      const data = res.data as unknown as IssueEventLike[];
      events.push(...data);
      if (data.length < EVENT_PAGE) break;
      if (page === MAX_EVENT_PAGES) truncated = true;
    }
  } catch (err) {
    throw toJobError(err, "issue events");
  }
  if (truncated) return { found: false };
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.event !== kind || typeof e.label?.name !== "string") continue;
    if (!isBreakGlassLabel(o.label, e.label.name)) continue;
    const a = e.actor;
    const at = typeof e.created_at === "string" ? new Date(e.created_at) : null;
    const actor =
      a && typeof a.id === "number" && typeof a.login === "string" && a.login.length > 0
        ? { id: a.id, login: a.login.slice(0, 100), bot: a.type === "Bot" }
        : null;
    return { found: true, actor, at: at !== null && Number.isNaN(at.getTime()) ? null : at };
  }
  return { found: false };
}

export interface ResolveBreakGlassInput {
  owner: string;
  repo: string;
  prNumber: number;
  changeId: string;
  /** The live head, from `pulls.get`. */
  headSha: string;
  /** `config.breakGlassLabel`, not null (the job does not call this when the feature is off). */
  label: string;
  /** The PR's label names, from `pulls.get`. */
  labels: readonly string[];
  /** The PR author's user id, from `pulls.get`. */
  authorId: number | null;
  /** D4: the head SHA of the `labeled` delivery that queued this run, when it was the label. */
  breakGlassHeadSha?: string | undefined;
}

const fromRow = (row: AuditRow): BreakGlassActor | null =>
  row.actor_id !== null && row.actor_login !== null
    ? { id: Number(row.actor_id), login: row.actor_login }
    : null;

export async function resolveBreakGlass(
  octokit: GitHubClient,
  db: Db,
  i: ResolveBreakGlassInput,
): Promise<BreakGlassFacts> {
  const onPr = i.labels.some((name) => isBreakGlassLabel(i.label, name));
  const active = await activeBreakGlass(db, i.changeId, i.headSha);
  const where = { owner: i.owner, repo: i.repo, prNumber: i.prNumber, label: i.label };

  if (!onPr) {
    // D9: the label was taken off while a break-glass was active for this head.
    if (!active) return { state: "none" };
    const ev = await latestLabelEvent(octokit, where, "unlabeled");
    return ev.found
      ? {
          state: "removed",
          actor: ev.actor === null ? null : { id: ev.actor.id, login: ev.actor.login },
          labelEventAt: ev.at,
        }
      : { state: "removed", actor: null, labelEventAt: null };
  }

  // D6: an applied row for this head keeps the bypass, on every trigger, with no new read.
  if (active) {
    const actor = fromRow(active);
    if (actor !== null) {
      return {
        state: "applied",
        record: false,
        actor,
        role: active.actor_role ?? "none",
        self: active.self,
        headSha: i.headSha,
        labelEventAt: active.label_event_at,
      };
    }
  }

  // Not the label's own trigger: show what the log says about this head, verify nothing.
  if (i.breakGlassHeadSha === undefined) {
    const last = await latestAuditForHead(db, i.changeId, i.headSha);
    if (last?.kind === "stale") return { state: "stale", record: false };
    if (last?.kind === "ignored" && last.reason !== null && last.reason !== "head_moved") {
      return {
        state: "ignored",
        record: false,
        reason: last.reason,
        actor: fromRow(last),
        role: last.actor_role,
        self: last.self,
        labelEventAt: last.label_event_at,
      };
    }
    return { state: "none" };
  }

  // D4: the head moved between the label and this evaluation.
  if (i.breakGlassHeadSha !== i.headSha) return { state: "stale", record: true };

  const ev = await latestLabelEvent(octokit, where, "labeled");
  const ignored = (
    reason: IgnoredReason,
    actor: BreakGlassActor | null,
    role: CollaboratorRole | null,
  ): BreakGlassFacts => ({
    state: "ignored",
    record: true,
    reason,
    actor,
    role,
    self: actor !== null && actor.id === i.authorId,
    labelEventAt: ev.found ? ev.at : null,
  });
  if (!ev.found || ev.actor === null) return ignored("actor_unknown", null, null);
  const actor = { id: ev.actor.id, login: ev.actor.login };
  // D3: bots never count, whatever their role.
  if (ev.actor.bot) return ignored("bot", actor, null);
  let answer: Awaited<ReturnType<typeof collaboratorRole>>;
  try {
    answer = await collaboratorRole(octokit, { owner: i.owner, repo: i.repo, user: actor });
  } catch (err) {
    if (err instanceof Error && classifiedErrors.has(err)) throw err;
    throw toJobError(err, "permission check");
  }
  if (answer.denied !== null) return ignored("role_unverified", actor, null);
  if (!atLeast(answer.role, "maintain")) return ignored("role_too_low", actor, answer.role);
  return {
    state: "applied",
    record: true,
    actor,
    role: answer.role,
    self: actor.id === i.authorId,
    headSha: i.headSha,
    labelEventAt: ev.at,
  };
}
