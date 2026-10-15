/**
 * Review time of one PR from its timeline (step 6, §8.2). Pure: the baseline normalizes the API
 * events into `TimelineEvent`s and calls `reviewTimes`; nothing here reads text or identities
 * beyond the logins it compares (author, agent logins), and none of them are returned.
 */

export interface TimelineInput {
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  draftNow: boolean;
  authorLogin: string;
  now: Date;
  /** Normalized from issues.listEventsForTimeline, oldest first. */
  events: readonly TimelineEvent[];
  /** Lowercased agent logins. */
  excludedReviewerLogins: readonly string[];
}

export type TimelineEvent =
  | {
      kind: "review_requested";
      at: string;
      reviewer: { login: string; type: string } | null;
      team: boolean;
    }
  | { kind: "ready_for_review" | "convert_to_draft" | "closed" | "reopened" | "merged"; at: string }
  | {
      kind: "reviewed";
      at: string;
      user: { login: string; type: string } | null;
      state: string;
      commitId: string | null;
    };

export interface PrReviewTimes {
  startBasis: "review_requested" | "ready_for_review" | "opened";
  minutesToFirstApproval: number | null;
  minutesToMerge: number | null;
  reviewRounds: number;
  mergedWithoutReview: boolean;
  pausedMinutes: number;
  excludedApprovals: { self: number; bot: number };
}

const MINUTE = 60_000;
const round1 = (x: number): number => Math.round(x * 10) / 10;

type Interval = [number, number];

/** Sorted, merged union of intervals (draft and closed time may overlap). */
function union(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function overlap(paused: readonly Interval[], from: number, to: number): number {
  let total = 0;
  for (const [a, b] of paused) {
    const lo = Math.max(a, from);
    const hi = Math.min(b, to);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

const isBotLogin = (login: string): boolean => login.toLowerCase().endsWith("[bot]");

export function reviewTimes(i: TimelineInput): PrReviewTimes {
  const created = Date.parse(i.createdAt);
  const merged = i.mergedAt === null ? null : Date.parse(i.mergedAt);
  const nowMs = i.now.getTime();
  const author = i.authorLogin.toLowerCase();
  const agents = new Set(i.excludedReviewerLogins.map((l) => l.toLowerCase()));
  const events = [...i.events]
    .map((e) => ({ e, t: Date.parse(e.at) }))
    .filter((x) => Number.isFinite(x.t));

  // 1. Paused intervals: draft and closed time.
  const firstDraftEvent = events.find(
    (x) => x.e.kind === "ready_for_review" || x.e.kind === "convert_to_draft",
  );
  const initiallyDraft =
    firstDraftEvent === undefined ? i.draftNow : firstDraftEvent.e.kind === "ready_for_review";
  const raw: Interval[] = [];
  let draftStart: number | null = initiallyDraft ? created : null;
  let closedStart: number | null = null;
  for (const { e, t } of events) {
    if (e.kind === "convert_to_draft") {
      if (draftStart === null) draftStart = t;
    } else if (e.kind === "ready_for_review") {
      if (draftStart !== null) {
        raw.push([draftStart, t]);
        draftStart = null;
      }
    } else if (e.kind === "closed") {
      if (closedStart === null) closedStart = t;
    } else if (e.kind === "reopened") {
      if (closedStart !== null) {
        raw.push([closedStart, t]);
        closedStart = null;
      }
    }
  }
  // An interval that never ended is open-ended (the PR is still draft or closed).
  if (draftStart !== null) raw.push([draftStart, Number.POSITIVE_INFINITY]);
  if (closedStart !== null) raw.push([closedStart, Number.POSITIVE_INFINITY]);
  const paused = union(raw);
  const dur = (from: number, to: number): number =>
    round1(Math.max(0, to - from - overlap(paused, from, to)) / MINUTE);
  /** When a moment inside a pause takes effect: the end of that pause; null when it never ends. */
  const effective = (t: number): number | null => {
    for (const [a, b] of paused) {
      if (t >= a && t < b) return Number.isFinite(b) ? b : null;
    }
    return t;
  };

  // 2. Start S.
  let start = created;
  let startBasis: PrReviewTimes["startBasis"] = "opened";
  let found = false;
  for (const { e, t } of events) {
    if (e.kind !== "review_requested") continue;
    if (merged !== null && t > merged) continue;
    if (!e.team) {
      const r = e.reviewer;
      if (r === null) continue;
      if (
        r.login.toLowerCase() === author ||
        r.type === "Bot" ||
        isBotLogin(r.login) ||
        agents.has(r.login.toLowerCase())
      ) {
        continue;
      }
    }
    // The first qualifying request decides; later ones (re-requests) never move S.
    const eff = effective(t);
    if (eff !== null && (merged === null || eff <= merged)) {
      start = eff;
      startBasis = "review_requested";
      found = true;
    }
    break;
  }
  if (!found) {
    const ready = events.find((x) => x.e.kind === "ready_for_review");
    if (initiallyDraft && ready !== undefined) {
      start = ready.t;
      startBasis = "ready_for_review";
    }
  }

  // 3. Qualifying reviews.
  const excludedApprovals = { self: 0, bot: 0 };
  const reviews: { t: number; state: string; commitId: string | null }[] = [];
  for (const { e, t } of events) {
    if (e.kind !== "reviewed") continue;
    const state = e.state.toLowerCase();
    if (state === "pending") continue;
    const u = e.user;
    if (u === null) continue;
    const login = u.login.toLowerCase();
    if (login === author) {
      if (state === "approved") excludedApprovals.self++;
      continue;
    }
    if (u.type === "Bot" || isBotLogin(login) || agents.has(login)) {
      if (state === "approved") excludedApprovals.bot++;
      continue;
    }
    reviews.push({ t, state, commitId: e.commitId });
  }
  const approval = reviews.find((r) => r.state === "approved");
  const minutesToFirstApproval = approval ? dur(start, Math.max(approval.t, start)) : null;
  const minutesToMerge = merged === null ? null : dur(start, merged);

  // Rounds: distinct commit ids of qualifying reviews in [S, A] (or [S, merge], or [S, now]).
  const windowEnd = approval ? approval.t : (merged ?? nowMs);
  const inWindow = reviews.filter((r) => r.t >= start && r.t <= windowEnd);
  const commits = new Set<string>();
  let nullCommit = 0;
  for (const r of inWindow) {
    if (r.commitId === null) nullCommit++;
    else commits.add(r.commitId);
  }
  const reviewRounds = commits.size + nullCommit;

  // `<=`: timeline timestamps have one-second resolution, and an approval and the merge it
  // triggers can share a second.
  const mergedWithoutReview = merged !== null && !reviews.some((r) => r.t <= merged);
  const end = merged ?? (i.closedAt === null ? nowMs : Date.parse(i.closedAt));
  const pausedMinutes = round1(overlap(paused, start, Math.max(end, start)) / MINUTE);

  return {
    startBasis,
    minutesToFirstApproval,
    minutesToMerge,
    reviewRounds,
    mergedWithoutReview,
    pausedMinutes,
    excludedApprovals,
  };
}
