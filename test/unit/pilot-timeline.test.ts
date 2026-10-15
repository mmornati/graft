import { describe, expect, it } from "vitest";
import {
  aggregate,
  cell,
  normalizeEvent,
  type PrRow,
  renderAggregates,
} from "../../src/pilot/baseline.js";
import { reviewTimes, type TimelineEvent, type TimelineInput } from "../../src/pilot/timeline.js";

const T0 = Date.parse("2026-10-01T10:00:00Z");
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const NOW = new Date(T0 + 24 * 60 * 60_000);

const request = (min: number, login: string, type = "User"): TimelineEvent => ({
  kind: "review_requested",
  at: at(min),
  reviewer: { login, type },
  team: false,
});
const teamRequest = (min: number): TimelineEvent => ({
  kind: "review_requested",
  at: at(min),
  reviewer: null,
  team: true,
});
const state = (
  kind: "ready_for_review" | "convert_to_draft" | "closed" | "reopened" | "merged",
  min: number,
): TimelineEvent => ({ kind, at: at(min) });
const review = (
  min: number,
  login: string,
  st: string,
  commitId: string | null = "c1",
  type = "User",
): TimelineEvent => ({
  kind: "reviewed",
  at: at(min),
  user: { login, type },
  state: st,
  commitId,
});

function times(over: Partial<TimelineInput> & { events: TimelineEvent[] }) {
  return reviewTimes({
    createdAt: at(0),
    mergedAt: null,
    closedAt: null,
    draftNow: false,
    authorLogin: "Author",
    now: NOW,
    excludedReviewerLogins: [],
    ...over,
  });
}

describe("reviewTimes", () => {
  it("U-BASE-1 no request, not draft: S = created_at, approval and merge minutes exact", () => {
    const r = times({
      mergedAt: at(120),
      events: [review(90, "rev", "approved"), state("closed", 120), state("merged", 120)],
    });
    expect(r).toMatchObject({
      startBasis: "opened",
      minutesToFirstApproval: 90,
      minutesToMerge: 120,
      pausedMinutes: 0,
      mergedWithoutReview: false,
    });
  });

  it("U-BASE-2 opened as draft: S is the request after ready; a request while draft waits for ready", () => {
    const after = times({
      mergedAt: at(300),
      events: [state("ready_for_review", 120), request(180, "rev"), review(200, "rev", "approved")],
    });
    expect(after.startBasis).toBe("review_requested");
    expect(after.minutesToFirstApproval).toBe(20); // 200 - 180
    expect(after.minutesToMerge).toBe(120); // 300 - 180

    const during = times({
      mergedAt: at(300),
      events: [
        request(60, "rev"),
        review(90, "rev", "commented", "c0"), // still a draft: before S, not a round
        state("ready_for_review", 120),
        review(150, "rev", "approved", "c1"),
      ],
    });
    expect(during.startBasis).toBe("review_requested");
    // S = 120 (the request takes effect at ready_for_review), not 60: the draft time before S is
    // neither paused time of the review clock nor part of the rounds.
    expect(during.minutesToFirstApproval).toBe(30);
    expect(during.minutesToMerge).toBe(180);
    expect(during.pausedMinutes).toBe(0);
    expect(during.reviewRounds).toBe(1);

    // Opened as draft with no request at all: S = ready_for_review.
    const ready = times({
      mergedAt: at(300),
      events: [state("ready_for_review", 120), review(150, "rev", "approved")],
    });
    expect(ready.startBasis).toBe("ready_for_review");
    expect(ready.minutesToFirstApproval).toBe(30);
  });

  it("U-BASE-3 paused (draft) minutes are subtracted from both durations", () => {
    const r = times({
      mergedAt: at(180),
      events: [
        state("convert_to_draft", 30),
        state("ready_for_review", 90),
        review(150, "rev", "approved"),
      ],
    });
    expect(r.startBasis).toBe("opened");
    expect(r.pausedMinutes).toBe(60);
    expect(r.minutesToFirstApproval).toBe(90); // 150 - 60
    expect(r.minutesToMerge).toBe(120); // 180 - 60
  });

  it("U-BASE-4 a re-request after changes requested does not move S", () => {
    const r = times({
      mergedAt: at(130),
      events: [
        request(10, "rev"),
        review(60, "rev", "changes_requested", "c1"),
        request(100, "rev"),
        review(120, "rev", "approved", "c2"),
      ],
    });
    expect(r.startBasis).toBe("review_requested");
    expect(r.minutesToFirstApproval).toBe(110); // 120 - 10, not 120 - 100
    expect(r.minutesToMerge).toBe(120);
  });

  it("U-BASE-5 a team request counts; a request for the author or a bot does not", () => {
    const team = times({ events: [teamRequest(40), review(100, "rev", "approved")] });
    expect(team.startBasis).toBe("review_requested");
    expect(team.minutesToFirstApproval).toBe(60);

    for (const ev of [
      request(40, "author"), // the author, other case
      request(40, "dependabot", "Bot"),
      request(40, "ci-helper[bot]"),
      request(40, "Agent-One"), // an agent login
    ]) {
      const r = times({
        events: [ev, review(100, "rev", "approved")],
        excludedReviewerLogins: ["agent-one"],
      });
      expect(r.startBasis, JSON.stringify(ev)).toBe("opened");
      expect(r.minutesToFirstApproval).toBe(100);
    }
  });

  it("U-BASE-6 self, bot and agent approvals are ignored and counted", () => {
    const r = times({
      mergedAt: at(200),
      excludedReviewerLogins: ["agent-one"],
      events: [
        review(10, "AUTHOR", "approved"),
        review(20, "dependabot", "approved", "c1", "Bot"),
        review(30, "agent-one", "approved"),
        review(40, "ci[bot]", "approved"),
        review(50, "author", "commented"),
        review(150, "human", "approved"),
      ],
    });
    expect(r.excludedApprovals).toEqual({ self: 1, bot: 3 });
    expect(r.minutesToFirstApproval).toBe(150);
    expect(r.mergedWithoutReview).toBe(false);
  });

  it("U-BASE-7 merged without any review", () => {
    const r = times({
      mergedAt: at(60),
      events: [review(10, "author", "approved"), state("merged", 60)],
    });
    expect(r).toMatchObject({
      mergedWithoutReview: true,
      minutesToFirstApproval: null,
      minutesToMerge: 60,
      reviewRounds: 0,
    });
  });

  it("U-BASE-8 rounds are distinct commit ids of qualifying reviews in [S, A]", () => {
    const events = [
      review(10, "rev", "changes_requested", "c1"),
      review(20, "rev", "commented", "c1"),
      review(30, "rev", "changes_requested", "c2"),
      review(50, "rev", "approved", "c3"),
      review(60, "rev", "commented", "c4"), // after A: ignored
    ];
    const r = times({ mergedAt: at(70), events });
    expect(r.reviewRounds).toBe(3);
    // A review without a commit counts as its own round.
    const withNull = times({
      mergedAt: at(70),
      events: [...events.slice(0, 1), review(15, "rev", "commented", null), ...events.slice(1)],
    });
    expect(withNull.reviewRounds).toBe(4);
    // Two reviews on the same commit are one round.
    expect(
      times({
        mergedAt: at(70),
        events: [review(10, "a", "commented", "c1"), review(20, "b", "approved", "c1")],
      }).reviewRounds,
    ).toBe(1);
    // Pending reviews are not reviews.
    expect(times({ events: [review(10, "a", "pending", "c1")] }).reviewRounds).toBe(0);
  });

  it("U-BASE-9 an approval before S counts as 0 minutes; a request after the merge is ignored", () => {
    const early = times({
      mergedAt: at(100),
      events: [review(30, "rev", "approved"), request(60, "rev2")],
    });
    expect(early.startBasis).toBe("review_requested");
    expect(early.minutesToFirstApproval).toBe(0);
    expect(early.minutesToMerge).toBe(40);

    const late = times({
      mergedAt: at(100),
      events: [review(50, "rev", "approved"), request(200, "rev2")],
    });
    expect(late.startBasis).toBe("opened");
    expect(late.minutesToFirstApproval).toBe(50);
  });

  it("U-BASE-10 closed, reopened and then merged: the closed interval is subtracted", () => {
    const r = times({
      mergedAt: at(150),
      events: [
        review(20, "rev", "approved"),
        state("closed", 30),
        state("reopened", 90),
        state("merged", 150),
        state("closed", 150),
      ],
    });
    expect(r.minutesToFirstApproval).toBe(20);
    expect(r.minutesToMerge).toBe(90); // 150 - 60
    expect(r.pausedMinutes).toBe(60);
  });

  it("U-BASE-11 a PR still open is censored: no approval, no merge", () => {
    const r = times({ events: [review(10, "rev", "commented", "c1")] });
    expect(r).toMatchObject({
      minutesToFirstApproval: null,
      minutesToMerge: null,
      mergedWithoutReview: false,
      reviewRounds: 1,
    });
    // A draft that never became ready: all of its life is paused.
    const draft = times({ draftNow: true, events: [] });
    expect(draft.pausedMinutes).toBe(24 * 60);
  });
});

const row = (over: Partial<PrRow> = {}): PrRow => ({
  prNumber: 1,
  state: "merged",
  authorKind: "agent",
  authorKindReason: "trailer",
  sizeBucket: "S",
  startBasis: "opened",
  minutesToFirstApproval: 10,
  minutesToMerge: 20,
  reviewRounds: 1,
  mergedWithoutReview: false,
  pausedMinutes: 0,
  excludedReason: null,
  ...over,
});

describe("aggregates", () => {
  it("U-BASE-13 groups by author kind x size, leaves excluded rows out and renders n<5", () => {
    const rows: PrRow[] = [
      ...[1, 2, 3, 4, 5].map((n) => row({ prNumber: n, minutesToFirstApproval: n * 10 })),
      row({ prNumber: 6, authorKind: "human", sizeBucket: "XL", minutesToFirstApproval: 7 }),
      row({ prNumber: 7, state: "open", minutesToFirstApproval: null, minutesToMerge: null }),
      row({ prNumber: 8, mergedWithoutReview: true, minutesToFirstApproval: null }),
      row({ prNumber: 9, excludedReason: "excluded_author", minutesToFirstApproval: null }),
    ];
    const a = aggregate(rows);
    expect(a.all.prs).toBe(8); // the excluded row is in no group
    expect(a.agent.prs).toBe(7);
    expect(a.human.prs).toBe(1);
    expect(a["agent:S"].prs).toBe(7);
    expect(a["human:XL"].prs).toBe(1);
    expect(a["agent:M"].prs).toBe(0);
    expect(a.agent.open).toBe(1);
    expect(a.agent.merged).toBe(6);
    expect(a.agent.mergedWithoutReview).toBe(1);
    expect(a.agent.firstApproval).toEqual({ n: 5, p50: 30, p75: 40, p90: 46 });
    // JSON keeps small cells; markdown shows n<5.
    expect(a.human.firstApproval.n).toBe(1);
    expect(a.human.firstApproval.p50).toBe(7);
    expect(cell(1, 7)).toBe("n<5");
    expect(cell(5, 30)).toBe("30");
    expect(cell(5, null)).toBe("-");
    const table = renderAggregates(a);
    expect(table).toContain("human:XL");
    expect(table.split("\n").find((l) => l.startsWith("human "))).toContain("n<5/n<5");
    expect(table.split("\n").find((l) => l.startsWith("agent "))).toContain("30/46");
  });

  it("normalizes API timeline events and drops unknown kinds", () => {
    expect(
      normalizeEvent({
        event: "reviewed",
        submitted_at: at(5),
        user: { login: "a", type: "User" },
        state: "approved",
        commit_id: "abc",
      }),
    ).toEqual({
      kind: "reviewed",
      at: at(5),
      user: { login: "a", type: "User" },
      state: "approved",
      commitId: "abc",
    });
    expect(
      normalizeEvent({
        event: "review_requested",
        created_at: at(1),
        requested_team: { slug: "t" },
      }),
    ).toEqual({ kind: "review_requested", at: at(1), reviewer: null, team: true });
    expect(normalizeEvent({ event: "labeled", created_at: at(1) })).toBeNull();
    expect(normalizeEvent({ event: "closed" })).toBeNull();
  });
});
