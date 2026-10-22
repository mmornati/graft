/**
 * Break-glass (Phase 1 step 3, spec §6 steps 1 and 2). `resolveBreakGlass` decides what the
 * break-glass label means for the PR's current head, outside the change lock. It reads the issue
 * events API (who applied or removed the label, D2) and the collaborator role (D3), and the audit
 * log (D6). It writes nothing: the job writes the rows inside the lock, in the publish transaction.
 *
 * Payloads are triggers. The payload values used here are the head SHA and the user id of the
 * `labeled` delivery (D4; review 1, finding 1), and the fact that an `unlabeled` delivery arrived
 * (review 1, finding 2). Each one can only refuse a break-glass, never grant one: who applied the
 * label, their login and their role come from the API, never from the webhook.
 *
 * Review 1 (finding 2): a bypass is bound to the issue event it was verified from
 * (`audit_log.label_event_id`). Every label trigger re-reads the label events and ends the bypass
 * when that event is no longer the newest `labeled` one, or an `unlabeled` event is newer. A push
 * ends it for good (finding 3), and so does an `unlabeled` delivery.
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
import { type AuditRow, activeBreakGlassForChange, latestAuditForHead } from "../audit/index.js";

/** D2: at most 10 pages of 100 issue events per evaluation. */
export const EVENT_PAGE = 100;
export const MAX_EVENT_PAGES = 10;

export interface BreakGlassActor {
  id: number;
  login: string;
}

export type IgnoredReason = "role_too_low" | "bot" | "role_unverified" | "actor_unknown";

/** An active bypass this evaluation ends: the job writes a `removed` row for it (D9, review 1). */
export interface Revocation {
  /** The head the ended `applied` row was written for. */
  headSha: string;
  /** Who removed the label (the newest `unlabeled` event); null for a push or when unknown. */
  actor: BreakGlassActor | null;
  labelEventAt: Date | null;
}

/**
 * What the label means for the current head. `record` says whether the job must write an audit
 * row for it (a new verification); a state replayed from the audit log writes nothing.
 */
export type BreakGlassState =
  | { state: "none" }
  | {
      state: "applied";
      record: boolean;
      actor: BreakGlassActor;
      role: CollaboratorRole;
      self: boolean;
      headSha: string;
      labelEventAt: Date | null;
      /** The issue event this bypass is bound to (review 1, finding 2). */
      labelEventId: number | null;
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
  | { state: "stale"; record: boolean };

/** The state, and the bypass it ended first, if any (written before the state's own row). */
export type BreakGlassFacts = BreakGlassState & { revoke: Revocation | null };

/**
 * Review 1, finding 1: the newest label event the API lists is not the `labeled` action of the
 * delivery's user (yet). The issue events API is not guaranteed to be consistent with webhook
 * delivery, so the job retries while its retry policy allows, then records `actor_unknown`.
 */
export class LabelEventsBehind extends Error {
  constructor() {
    super("break-glass: the issue events do not list the label action yet");
    this.name = "LabelEventsBehind";
  }
}

/** D1: label names are matched case-insensitively. A null label (`off`) matches nothing. */
export function isBreakGlassLabel(label: string | null, name: string): boolean {
  return label !== null && name.toLowerCase() === label.toLowerCase();
}

interface IssueEventLike {
  id?: number;
  event?: string;
  created_at?: string;
  label?: { name?: string } | null;
  actor?: { id?: number; login?: string; type?: string } | null;
}

export interface LabelEvent {
  kind: "labeled" | "unlabeled";
  /** The issue event id; null when the API gave none. */
  id: number | null;
  actor: (BreakGlassActor & { bot: boolean }) | null;
  at: Date | null;
}

/**
 * The label's events as far as the API lists them: the newest one of either kind, and the newest
 * of each kind. `complete: false` when the cap was reached with more events left (a newer event
 * could sit on an unread page): every caller then fails closed.
 */
export type LabelEvents =
  | { complete: false }
  | {
      complete: true;
      newest: LabelEvent | null;
      labeled: LabelEvent | null;
      unlabeled: LabelEvent | null;
      /** True when the newest `unlabeled` event is newer than the newest `labeled` one. */
      unlabeledLater: boolean;
      /** Every `labeled` and `unlabeled` event of the label, newest first. */
      trail: LabelEvent[];
    };

/**
 * D2: the label's `labeled` and `unlabeled` events on the PR. The API lists events oldest first
 * and has no ordering parameter (T1), so every page up to the cap is read and the list position
 * decides which is newest (not `created_at`, which has a one-second resolution).
 */
export async function readLabelEvents(
  octokit: GitHubClient,
  o: { owner: string; repo: string; prNumber: number; label: string },
): Promise<LabelEvents> {
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
  if (truncated) return { complete: false };
  let newest: LabelEvent | null = null;
  let labeled: LabelEvent | null = null;
  let unlabeled: LabelEvent | null = null;
  let unlabeledLater = false;
  const trail: LabelEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === undefined || (e.event !== "labeled" && e.event !== "unlabeled")) continue;
    if (typeof e.label?.name !== "string" || !isBreakGlassLabel(o.label, e.label.name)) continue;
    const a = e.actor;
    const at = typeof e.created_at === "string" ? new Date(e.created_at) : null;
    const ev: LabelEvent = {
      kind: e.event,
      id: typeof e.id === "number" && Number.isSafeInteger(e.id) && e.id > 0 ? e.id : null,
      actor:
        a && typeof a.id === "number" && typeof a.login === "string" && a.login.length > 0
          ? { id: a.id, login: a.login.slice(0, 100), bot: a.type === "Bot" }
          : null,
      at: at !== null && Number.isNaN(at.getTime()) ? null : at,
    };
    trail.push(ev);
    newest ??= ev;
    if (ev.kind === "labeled") {
      labeled ??= ev;
    } else if (unlabeled === null) {
      unlabeled = ev;
      unlabeledLater = labeled === null;
    }
  }
  return { complete: true, newest, labeled, unlabeled, unlabeledLater, trail };
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
  /** Review 1, finding 1: the user id of that `labeled` delivery. A filter, never the actor. */
  breakGlassActorId?: number | undefined;
  /** Review 1, finding 2: the run was queued by an `unlabeled` delivery of the label. */
  breakGlassUnlabeled?: boolean | undefined;
  /** Whether the queue retries this run on a retryable error (finding 1: events that lag). */
  canRetry: boolean;
}

const fromRow = (row: AuditRow): BreakGlassActor | null =>
  row.actor_id !== null && row.actor_login !== null
    ? { id: Number(row.actor_id), login: row.actor_login }
    : null;

const plain = (a: (BreakGlassActor & { bot: boolean }) | null): BreakGlassActor | null =>
  a === null ? null : { id: a.id, login: a.login };

export async function resolveBreakGlass(
  octokit: GitHubClient,
  db: Db,
  i: ResolveBreakGlassInput,
): Promise<BreakGlassFacts> {
  const onPr = i.labels.some((name) => isBreakGlassLabel(i.label, name));
  const where = { owner: i.owner, repo: i.repo, prNumber: i.prNumber, label: i.label };
  // At most one issue-events read per evaluation (D12).
  let read: Promise<LabelEvents> | null = null;
  const events = (): Promise<LabelEvents> => {
    read ??= readLabelEvents(octokit, where);
    return read;
  };

  let active: AuditRow | undefined = await activeBreakGlassForChange(db, i.changeId);
  let revoke: Revocation | null = null;
  const end = (actor: BreakGlassActor | null, labelEventAt: Date | null): void => {
    if (active === undefined) return;
    revoke = { headSha: active.head_sha, actor, labelEventAt };
    active = undefined;
  };
  /**
   * Who removed the label, for the `removed` row (D9): the newest `unlabeled` event listed after
   * the event the bypass was bound to (any `unlabeled` event when that one is not listed).
   */
  const remover = (ev: LabelEvents, row: AuditRow | undefined) => {
    if (!ev.complete) return { actor: null, at: null };
    const bound = row?.label_event_id ?? null;
    for (const e of ev.trail) {
      if (bound !== null && e.id === Number(bound)) break;
      if (e.kind === "unlabeled") return { actor: plain(e.actor), at: e.at };
    }
    return { actor: null, at: null };
  };

  // Finding 3: a push ends the bypass for good (no read: the head is API data).
  if (active !== undefined && active.head_sha !== i.headSha) end(null, null);

  // D9: the label was taken off; finding 2: or an unlabel delivery says so, even if it is back.
  if (active !== undefined && (!onPr || i.breakGlassUnlabeled === true)) {
    const who = remover(await events(), active);
    end(who.actor, who.at);
  }
  if (!onPr) return { state: "none", revoke };

  const replay = (row: AuditRow | undefined): BreakGlassFacts | null => {
    const actor = row === undefined ? null : fromRow(row);
    if (row === undefined || actor === null) return null;
    return {
      state: "applied",
      record: false,
      actor,
      role: row.actor_role ?? "none",
      self: row.self,
      headSha: i.headSha,
      labelEventAt: row.label_event_at,
      labelEventId: row.label_event_id === null ? null : Number(row.label_event_id),
      revoke,
    };
  };

  if (i.breakGlassHeadSha === undefined) {
    // D6: an applied row for this head keeps the bypass on other triggers, with no new read.
    const kept = replay(active);
    if (kept !== null) return kept;
    // Not the label's own trigger: show what the log says about this head, verify nothing.
    const last = await latestAuditForHead(db, i.changeId, i.headSha);
    if (last?.kind === "stale") return { state: "stale", record: false, revoke };
    if (last?.kind === "ignored" && last.reason !== null && last.reason !== "head_moved") {
      return {
        state: "ignored",
        record: false,
        reason: last.reason,
        actor: fromRow(last),
        role: last.actor_role,
        self: last.self,
        labelEventAt: last.label_event_at,
        revoke,
      };
    }
    return { state: "none", revoke };
  }

  // The label's own trigger. D4 with nothing active: refused before any read.
  if (active === undefined && i.breakGlassHeadSha !== i.headSha) {
    return { state: "stale", record: true, revoke };
  }
  const ev = await events();

  // Finding 2: the active bypass must still be bound to the newest `labeled` event, with no
  // `unlabeled` event after it. Otherwise the label was removed (and maybe re-added by someone
  // else) since it was verified: end it, then judge the current label from scratch.
  if (active !== undefined) {
    const stored = active.label_event_id === null ? null : Number(active.label_event_id);
    const bound =
      ev.complete &&
      !ev.unlabeledLater &&
      ev.labeled !== null &&
      ev.labeled.id !== null &&
      ev.labeled.id === stored;
    if (!bound) {
      const who = remover(ev, active);
      end(who.actor, who.at);
    }
  }

  // D4: the head moved between the label and this evaluation. An older delivery never ends a
  // bypass that is still bound to the newest label event.
  if (i.breakGlassHeadSha !== i.headSha) {
    return replay(active) ?? { state: "stale", record: true, revoke };
  }

  const ignored = (
    reason: IgnoredReason,
    actor: BreakGlassActor | null,
    role: CollaboratorRole | null,
    labelEventAt: Date | null,
  ): BreakGlassFacts => ({
    state: "ignored",
    record: true,
    reason,
    actor,
    role,
    self: actor !== null && actor.id === i.authorId,
    labelEventAt,
    revoke,
  });

  // D2 and finding 1: the newest label event must be the `labeled` action of the delivery's user.
  // Anything else means the events API does not list that action (yet): never use an older one.
  if (!ev.complete) {
    end(null, null);
    return ignored("actor_unknown", null, null, null);
  }
  const newest = ev.newest;
  const labeller =
    newest !== null && newest.kind === "labeled" && newest.actor !== null ? newest.actor : null;
  if (
    newest === null ||
    labeller === null ||
    i.breakGlassActorId === undefined ||
    labeller.id !== i.breakGlassActorId
  ) {
    if (i.canRetry && i.breakGlassActorId !== undefined) throw new LabelEventsBehind();
    // Fail closed: this delivery is not shown to be the action a bypass may bind to.
    end(null, null);
    return ignored("actor_unknown", null, null, null);
  }

  // Still bound to this very event: keep it, with no role read (D6).
  const kept = replay(active);
  if (kept !== null) return kept;

  const actor = { id: labeller.id, login: labeller.login };
  // D3: bots never count, whatever their role.
  if (labeller.bot) return ignored("bot", actor, null, newest.at);
  let answer: Awaited<ReturnType<typeof collaboratorRole>>;
  try {
    answer = await collaboratorRole(octokit, { owner: i.owner, repo: i.repo, user: actor });
  } catch (err) {
    if (err instanceof Error && classifiedErrors.has(err)) throw err;
    throw toJobError(err, "permission check");
  }
  if (answer.denied !== null) return ignored("role_unverified", actor, null, newest.at);
  if (!atLeast(answer.role, "maintain")) {
    return ignored("role_too_low", actor, answer.role, newest.at);
  }
  return {
    state: "applied",
    record: true,
    actor,
    role: answer.role,
    self: actor.id === i.authorId,
    headSha: i.headSha,
    labelEventAt: newest.at,
    labelEventId: newest.id,
    revoke,
  };
}
