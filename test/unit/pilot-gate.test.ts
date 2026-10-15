import { describe, expect, it } from "vitest";
import type { EffectiveVote } from "../../src/modules/intent/index.js";
import { pickEffectiveVotes } from "../../src/modules/intent/index.js";
import {
  AllowListError,
  AllowListResolveError,
  emptyAllowList,
  parseAllowList,
  resolveAllowList,
} from "../../src/pilot/allow-list.js";
import {
  decideGate,
  filterEligible,
  type GateInputs,
  isDominantVoter,
} from "../../src/pilot/gate.js";
import {
  type GateReport,
  gateReportSchema,
  renderGateMarkdown,
} from "../../src/pilot/gate-render.js";

let seq = 0;
function vote(over: Partial<EffectiveVote> = {}): EffectiveVote {
  seq++;
  return {
    cardId: `card-${seq}`,
    changeId: "change-1",
    repositoryId: 1,
    installationId: 1,
    userId: 100 + seq,
    userLogin: `voter-${seq}`,
    verdict: "up",
    source: "reaction",
    reactedAt: new Date("2026-11-05T10:00:00Z"),
    isPrAuthor: false,
    cardStatus: "ok",
    ...over,
  };
}

describe("eligibility and effective votes", () => {
  it("U-GATE-2 drops the author, bots and agents, and non-reviewers; keeps requested, reviewed and allow-listed", () => {
    const author = vote({ isPrAuthor: true, userLogin: "the-author" });
    const bot = vote({ userLogin: "helper[bot]" });
    const agent = vote({ userLogin: "Agent-One" });
    const stranger = vote({ userLogin: "stranger", userId: 1 });
    const requested = vote({ userLogin: "requested", userId: 2 });
    const reviewed = vote({ userLogin: "reviewed", userId: 3 });
    const allowed = vote({ userLogin: "Allowed-Person", userId: 4 });
    const res = filterEligible([author, bot, agent, stranger, requested, reviewed, allowed], {
      agentLogins: ["agent-one"],
      reviewers: new Set([`change-1:2`, `change-1:3`]),
      allow: new Set([4]),
    });
    expect(res.dropped).toEqual({ author: 1, bot_or_agent: 2, not_reviewer: 1 });
    expect(res.kept.map((v) => v.userLogin)).toEqual(["requested", "reviewed", "Allowed-Person"]);
    // The author is dropped even when the author is also a listed reviewer.
    const both = filterEligible([vote({ isPrAuthor: true, userId: 9 })], {
      agentLogins: [],
      reviewers: new Set(["change-1:9"]),
      allow: new Set(),
    });
    expect(both.kept).toHaveLength(0);
    expect(both.dropped.author).toBe(1);
  });

  it("U-GATE-13 a recycled login does not inherit an allow-listed vote; the renamed owner of the id still counts", () => {
    // The allow-list holds user 1 as `alice`. A vote from user 1 who renamed to `alice2` counts; a
    // vote from user 2 who registered the freed login `alice` does not.
    const allow = parseAllowList("alice:1\n");
    const renamed = filterEligible(
      [vote({ userLogin: "alice2", userId: 1 }), vote({ userLogin: "alice", userId: 2 })],
      { agentLogins: [], reviewers: new Set(), allow: allow.ids },
    );
    expect(renamed.kept.map((v) => [v.userId, v.userLogin])).toEqual([[1, "alice2"]]);
    expect(renamed.dropped.not_reviewer).toBe(1);
  });

  it("U-GATE-16 the author is excluded by user id: a rename (the vote's flag was computed from the old login) does not hide them", () => {
    const renamedAuthor = vote({ userLogin: "new-author-name", userId: 31, isPrAuthor: false });
    const other = vote({ userLogin: "other", userId: 32, changeId: "change-1" });
    const elsewhere = vote({ userLogin: "p", userId: 31, changeId: "change-2" });
    const res = filterEligible([renamedAuthor, other, elsewhere], {
      agentLogins: [],
      reviewers: new Set(["change-1:31", "change-1:32", "change-2:31"]),
      allow: new Set([31]),
      authorIds: new Map([["change-1", 31]]),
    });
    expect(res.dropped.author).toBe(1);
    // User 31 is the author of change-1 only: their vote on another PR is an ordinary one.
    expect(res.kept.map((v) => [v.changeId, v.userId])).toEqual([
      ["change-1", 32],
      ["change-2", 31],
    ]);
  });

  it("U-GATE-3 one effective vote per (card, user): the latest across sources; two cards are two votes", () => {
    const card = "card-x";
    const reaction = vote({
      cardId: card,
      userId: 7,
      verdict: "up",
      source: "reaction",
      reactedAt: new Date("2026-11-05T10:00:00Z"),
    });
    const button = vote({
      cardId: card,
      userId: 7,
      verdict: "down",
      source: "check_action",
      reactedAt: new Date("2026-11-05T11:00:00Z"),
    });
    const other = vote({ cardId: "card-y", userId: 7, verdict: "up" });
    const picked = pickEffectiveVotes([reaction, button, other]);
    expect(picked).toHaveLength(2);
    expect(picked.find((v) => v.cardId === card)?.verdict).toBe("down");
    expect(picked.find((v) => v.cardId === "card-y")?.verdict).toBe("up");
    // A tie goes to the button.
    const t = new Date("2026-11-05T12:00:00Z");
    const tie = pickEffectiveVotes([
      vote({ cardId: "c", userId: 1, source: "reaction", verdict: "up", reactedAt: t }),
      vote({ cardId: "c", userId: 1, source: "check_action", verdict: "down", reactedAt: t }),
    ]);
    expect(tie.map((v) => v.verdict)).toEqual(["down"]);
  });

  it("U-GATE-4 votes on unavailable cards are not counted", () => {
    const res = filterEligible(
      [vote({ cardStatus: "unavailable", userId: 5 }), vote({ userId: 6 })],
      { agentLogins: [], reviewers: new Set(["change-1:5", "change-1:6"]), allow: new Set() },
    );
    expect(res.kept).toHaveLength(1);
    expect(res.dropped).toEqual({ author: 0, bot_or_agent: 0, not_reviewer: 0 });
  });
});

/** A set of inputs that decides PASS. */
const good = (over: Partial<GateInputs> = {}): GateInputs => ({
  up: 141,
  down: 9,
  prs: 60,
  voters: 8,
  installations: [
    { id: 1, votes: 80 },
    { id: 2, votes: 70 },
  ],
  windowDays: 28,
  coverage: { cards: { count: 99, total: 100 }, provenance: { count: 100, total: 100 } },
  ...over,
});
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe("decideGate", () => {
  it("the good inputs pass", () => {
    const r = decideGate(good());
    expect(r.verdict).toBe("PASS");
    // The verdict says why it passed.
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatchObject({ code: "pass", n: 150 });
    expect(r.reasons[0]).toMatchObject({ accuracy: 0.94 });
  });

  it("U-GATE-5 each N_min condition has its own reason", () => {
    const short = decideGate(good({ up: 140, down: 9 }));
    expect(short.verdict).toBe("INSUFFICIENT_DATA");
    expect(codes(short)).toEqual(["below_min_votes"]);
    expect(short.reasons[0]).toMatchObject({ n: 149, required: 150 });

    expect(codes(decideGate(good({ prs: 49 })))).toEqual(["below_min_prs"]);
    expect(codes(decideGate(good({ voters: 5 })))).toEqual(["below_min_voters"]);
    const one = decideGate(good({ installations: [{ id: 1, votes: 150 }] }));
    expect(one.verdict).toBe("INSUFFICIENT_DATA");
    expect(codes(one)).toEqual(["fewer_than_two_pilots"]);
    const thin = decideGate(
      good({
        installations: [
          { id: 1, votes: 119 },
          { id: 2, votes: 31 },
        ],
      }),
    );
    expect(thin.reasons).toEqual([
      { code: "pilot_below_min", installationId: 2, votes: 31, required: 40 },
    ]);
    // The span is exact (not floored) and the first day counts as a full day: 14 days of voting
    // are a span of 13 days.
    expect(codes(decideGate(good({ windowDays: 12.99 })))).toEqual(["window_too_short"]);
    expect(decideGate(good({ windowDays: 13 })).verdict).toBe("PASS");
    expect(decideGate(good({ windowDays: 14 })).verdict).toBe("PASS");
    // Several failures are all listed.
    expect(codes(decideGate(good({ up: 10, down: 0, prs: 3, voters: 1, windowDays: 2 })))).toEqual([
      "below_min_votes",
      "below_min_prs",
      "below_min_voters",
      "window_too_short",
    ]);
  });

  it("U-GATE-6 an upper bound below 0.90 fails even when the sample is otherwise too small, if voters and pilots are enough", () => {
    const thin = {
      up: 40,
      down: 10,
      prs: 5,
      voters: 6,
      installations: [
        { id: 1, votes: 25 },
        { id: 2, votes: 25 },
      ],
      windowDays: 3,
    };
    const r = decideGate(good(thin));
    expect(r.verdict).toBe("FAIL");
    expect(codes(r)).toEqual(["upper_below_target"]);
    // 49 votes are too few for a FAIL.
    expect(decideGate(good({ ...thin, up: 39, down: 10 })).verdict).toBe("INSUFFICIENT_DATA");
    // One voter or one pilot does not make an early FAIL: the evidence is still collected.
    expect(decideGate(good({ ...thin, voters: 5 })).verdict).toBe("INSUFFICIENT_DATA");
    const onePilot = decideGate(good({ ...thin, installations: [{ id: 1, votes: 50 }] }));
    expect(onePilot.verdict).toBe("INSUFFICIENT_DATA");
    expect(codes(onePilot)).toContain("fewer_than_two_pilots");
  });

  it("U-GATE-6 (dominant voter) PASS must also hold without the top voter (leave-one-out), with both figures shown", () => {
    // 141 up of 150. A top voter who cast 60 votes, all up: without them 81 of 90 = 0.90 with a
    // lower bound below 0.85, so the PASS rests on one person.
    const r = decideGate(good({ topVoter: { votes: 60, up: 60 } }));
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatchObject({ code: "dominant_voter", share: 0.4, accuracy: 0.94 });
    const reason = r.reasons[0] as { accuracyWithoutTop: number; lowerWithoutTop: number };
    expect(reason.accuracyWithoutTop).toBeCloseTo(0.9, 12);
    expect(reason.lowerWithoutTop).toBeLessThan(0.85);
    // A busy reviewer whose removal changes nothing is fine, even at 30% or more: 46 votes
    // (44 up) leave 97 of 104 = 0.933 with a lower bound above 0.85.
    expect(decideGate(good({ topVoter: { votes: 46, up: 44 } })).verdict).toBe("PASS");
    expect(decideGate(good({ topVoter: { votes: 75, up: 70 } })).verdict).toBe("PASS");
    // The same rule on the n >= 400 point estimate: 232 of 270 = 0.859 without the top voter.
    const big = { up: 362, down: 38, prs: 120, voters: 12 };
    const blocked = decideGate(good({ ...big, topVoter: { votes: 130, up: 130 } }));
    expect(blocked.verdict).toBe("INSUFFICIENT_DATA");
    expect(codes(blocked)).toEqual(["dominant_voter"]);
    expect(decideGate(good({ ...big, topVoter: { votes: 100, up: 90 } })).verdict).toBe("PASS");
    // It never turns a FAIL or an INSUFFICIENT DATA into anything else.
    expect(
      decideGate(
        good({ up: 358, down: 42, prs: 120, voters: 12, topVoter: { votes: 100, up: 90 } }),
      ).verdict,
    ).toBe("FAIL");
    // Nobody left once the top voter is removed: blocked.
    expect(decideGate(good({ topVoter: { votes: 150, up: 141 } })).verdict).toBe(
      "INSUFFICIENT_DATA",
    );
  });

  it("U-GATE-6 (breadth) the early FAIL counts the pilots that actually voted", () => {
    const base = { up: 40, down: 10, prs: 5, voters: 6, windowDays: 3 };
    // Two pilots asked for, but only one has an eligible vote: no early FAIL.
    const oneVoice = decideGate(
      good({
        ...base,
        installations: [
          { id: 1, votes: 50 },
          { id: 2, votes: 0 },
        ],
      }),
    );
    expect(oneVoice.verdict).toBe("INSUFFICIENT_DATA");
    expect(codes(oneVoice)).toContain("pilot_below_min");
    expect(
      decideGate(
        good({
          ...base,
          installations: [
            { id: 1, votes: 30 },
            { id: 2, votes: 20 },
          ],
        }),
      ).verdict,
    ).toBe("FAIL");
  });

  it("U-GATE-7 150 votes at 0.94 pass; 0.90 with a lower bound below 0.85 is inconclusive", () => {
    expect(decideGate(good({ up: 141, down: 9 })).verdict).toBe("PASS");
    const r = decideGate(good({ up: 135, down: 15 }));
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(codes(r)).toEqual(["inconclusive"]);
  });

  it("U-GATE-8 at 400 votes the point estimate decides", () => {
    const pass = decideGate(good({ up: 362, down: 38, prs: 120, voters: 12 }));
    expect(pass.verdict).toBe("PASS");
    expect(codes(pass)).toEqual(["point_estimate_decides"]);
    const fail = decideGate(good({ up: 358, down: 42, prs: 120, voters: 12 }));
    expect(fail.verdict).toBe("FAIL");
    expect(codes(fail)).toEqual(["point_estimate_decides"]);
  });

  it("U-GATE-9 coverage below 98% fails with good accuracy", () => {
    const cards = decideGate(
      good({
        coverage: { cards: { count: 97, total: 100 }, provenance: { count: 100, total: 100 } },
      }),
    );
    expect(cards.verdict).toBe("FAIL");
    expect(codes(cards)).toEqual(["coverage_cards"]);
    const prov = decideGate(
      good({
        coverage: { cards: { count: 100, total: 100 }, provenance: { count: 97, total: 100 } },
      }),
    );
    expect(prov.verdict).toBe("FAIL");
    expect(codes(prov)).toEqual(["coverage_provenance"]);
    expect(
      decideGate(
        good({
          coverage: { cards: { count: 98, total: 100 }, provenance: { count: 98, total: 100 } },
        }),
      ).verdict,
    ).toBe("PASS");
  });

  it("U-GATE-10 dominant_voter at 41% but not at 40%", () => {
    expect(isDominantVoter(41, 100)).toBe(true);
    expect(isDominantVoter(40, 100)).toBe(false);
    expect(isDominantVoter(0, 0)).toBe(false);
  });
});

const REPORT: GateReport = {
  schemaVersion: 1,
  window: { since: "2026-11-01", until: "2026-11-29", days: 28, dataSpanDays: 20 },
  installations: [
    { id: 123, account: "acme", repositories: 2 },
    { id: 456, account: "globex", repositories: 1 },
  ],
  allowList: { count: 3, sha256: "1a2b3c4d5e6f".padEnd(64, "0") },
  verdict: "INSUFFICIENT_DATA",
  reasons: [
    { code: "below_min_votes", n: 128, required: 150 },
    { code: "pilot_below_min", installationId: 456, votes: 31, required: 40 },
  ],
  accuracy: {
    up: 118,
    down: 10,
    n: 128,
    accuracy: 118 / 128,
    wilson: { lower: 0.8621530676193262, upper: 0.9570126251483656 },
    prs: 61,
    voters: 9,
    cards: { rated: 59, accurate: 52, inaccurate: 7 },
    bySource: { reaction: 100, check_action: 28 },
    perInstallation: [
      {
        installationId: 123,
        up: 90,
        down: 7,
        n: 97,
        accuracy: 90 / 97,
        wilson: { lower: 0.8, upper: 0.97 },
        prs: 40,
        voters: 6,
      },
      {
        installationId: 456,
        up: 28,
        down: 3,
        n: 31,
        accuracy: 28 / 31,
        wilson: null,
        prs: 21,
        voters: 3,
      },
    ],
    dropped: { author: 14, bot_or_agent: 0, not_reviewer: 22 },
    votesWithoutReviewerSync: 0,
  },
  coverage: {
    cards: { count: 991, total: 1000, ratio: 0.991 },
    provenance: { count: 1000, total: 1000, ratio: 1 },
  },
  warnings: ["dominant_voter"],
  policy: {
    merged: 100,
    wouldApprove: 34,
    wouldRequire: 58,
    wouldBlock: 2,
    noPolicy: 6,
    policyInvalid: 0,
    noVerdict: 0,
    wouldApproveAgent: 30,
    mergedAgent: 80,
    mergedTrivial: 40,
  },
  cards: {
    created: 200,
    ok: 190,
    unavailable: 10,
    verifier: { agree: 175, disagree: 15, error: 5, skipped: 5 },
    unavailableByReason: [
      { reason: "budget_exceeded", count: 3 },
      { reason: "llm_timeout", count: 1 },
    ],
    prsWithDisplay: 100,
    prsLastUnavailable: 2,
    costUsd: "4.2",
    pricedPrs: 100,
    tokens: 1500000,
    unpricedRuns: 0,
    unpricedTokens: 0,
  },
  reviewTimeScope: { pairedRepositories: 2, baselineOnly: 1, shadowOnly: 0 },
  reviewTime: [
    {
      group: "all",
      baseline: {
        firstApproval: { n: 50, p50: 300, p75: 400, p90: 500 },
        merge: { n: 50, p50: 400, p75: 500, p90: 600 },
        prs: 30,
        open: 2,
      },
      shadow: {
        firstApproval: { n: 40, p50: 270, p75: 350, p90: 450 },
        merge: { n: 40, p50: 360, p75: 450, p90: 550 },
        prs: 30,
        open: 2,
      },
      deltaFirstApprovalPct: -0.1,
      deltaMergePct: -0.1,
    },
    {
      group: "agent",
      baseline: {
        firstApproval: { n: 30, p50: 312, p75: 400, p90: 500 },
        merge: { n: 30, p50: 400, p75: 500, p90: 600 },
        prs: 30,
        open: 2,
      },
      shadow: {
        firstApproval: { n: 25, p50: 240, p75: 350, p90: 450 },
        merge: { n: 25, p50: 300, p75: 450, p90: 550 },
        prs: 30,
        open: 2,
      },
      deltaFirstApprovalPct: -0.2308,
      deltaMergePct: -0.25,
    },
    {
      group: "human",
      baseline: {
        firstApproval: { n: 20, p50: 200, p75: 300, p90: 400 },
        merge: { n: 20, p50: 250, p75: 350, p90: 450 },
        prs: 30,
        open: 2,
      },
      shadow: {
        firstApproval: { n: 0, p50: null, p75: null, p90: null },
        merge: { n: 0, p50: null, p75: null, p90: null },
        prs: 30,
        open: 2,
      },
      deltaFirstApprovalPct: null,
      deltaMergePct: null,
    },
  ],
  escapedDefects: {
    incidents: 1,
    merged: 100,
    per100: 1,
    agentIncidents: 1,
    agentMerged: 80,
    humanIncidents: 0,
    humanMerged: 20,
    onWouldApproveIncidents: 0,
    onWouldApproveMerged: 34,
    bySource: { cli: 1, label: 2 },
    baselineIncidents: 4,
    baselineMerged: 500,
    baselinePer100: 0.8,
  },
};

const EXPECTED_MD = `# Graft Phase 0 gate — 2026-11-01 to 2026-11-29

**Verdict: INSUFFICIENT DATA** — below_min_votes (128 of 150), pilot_below_min (inst 456: 31 of 40)

Installations: 123 (acme, 2 repos), 456 (globex, 1 repo). Data through 2026-11-28. Allow-list: 3 user IDs (sha256 1a2b3c4d…).

## Card accuracy (eligible reviewer votes)
| Scope | 👍 | 👎 | n | Accuracy | Wilson 95% | PRs | Voters |
| --- | --- | --- | --- | --- | --- | --- | --- |
| All | 118 | 10 | 128 | 92.2% | 86.2–95.7% | 61 | 9 |
| 123 | 90 | 7 | 97 | 92.8% | 80.0–97.0% | 40 | 6 |
| 456 | 28 | 3 | 31 | 90.3% | n/a | 21 | 3 |
Dropped votes: author 14, bot/agent 0, not a reviewer 22. Card-level accuracy: 88.1% (52 of 59 cards). Votes by source: reaction 100, button 28.
Coverage: cards 99.1% (≥ 98%), provenance 100.0% (≥ 98%).
Warnings: dominant_voter.
Data span 20 days (first to last eligible vote). The interval treats votes as independent; votes are clustered by PR and reviewer, so it is optimistic and a pass near the thresholds deserves a look at the votes.

## Policy (merged PRs)
Would approve 34% (target ≥ 30%; agent PRs 38%) | require 58% | block 2% | no policy 6% | invalid 0% | no verdict 0% | trivial 40% (of 100 merged)

## Cards
verifier disagrees 7.9% (error 5, skipped 5) | unavailable 5.0% (budget_exceeded 3, llm_timeout 1); PRs whose last card is unavailable 2.0% | cost/PR $0.042 (1500000 tokens; unpriced runs 0, unpriced tokens 0)

## Review time (indicative: shadow mode, Graft blocks nothing)
| Group | First approval p50 baseline → shadow | Δ | Merge p50 baseline → shadow | Δ |
| --- | --- | --- | --- | --- |
| all | 300 → 270 min | −10% | 400 → 360 min | −10% |
| agent | 312 → 240 min | −23% (Phase 1 target ≤ −50%) | 400 → 300 min | −25% |
| human | 200 → n/a min | n/a | 250 → n/a min | n/a |

Repositories with both a baseline and a shadow run: 2; left out: 1 with a baseline only, 0 with a shadow run only.
Unfinished PRs (right-censored, left out of the percentiles, so a short shadow window biases its p50 low): all baseline 2 of 30, shadow 2 of 30; agent baseline 2 of 30, shadow 2 of 30; human baseline 2 of 30, shadow 2 of 30.

## Escaped defects
1.0 incidents per 100 merged PRs (1 of 100; baseline 0.8) | agent 1 of 80, human 0 of 20 | on would-approve PRs: 0 of 34 | recorded incidents by source: cli 1, label 2 (review label incidents with incident list)
`;

describe("gate report rendering", () => {
  it("U-GATE-11 the markdown is byte-for-byte stable and the JSON parses with gateReportSchema", () => {
    expect(renderGateMarkdown(REPORT)).toBe(EXPECTED_MD);
    const json = JSON.stringify(REPORT, null, 2);
    expect(gateReportSchema.safeParse(JSON.parse(json)).success).toBe(true);
    // Strict about shape: a wrong schema version or verdict does not parse.
    expect(gateReportSchema.safeParse({ ...REPORT, schemaVersion: 2 }).success).toBe(false);
    expect(gateReportSchema.safeParse({ ...REPORT, verdict: "MAYBE" }).success).toBe(false);
  });
});

describe("allow-list", () => {
  it("U-GATE-12 reads ids and login:id lines, skips comments and blanks, and counts distinct ids", () => {
    const text =
      "# pilot reviewers\n\n12345\nAlice-Dev:678  # a trailing comment\n   \nbob:9\r\ncarol[bot]:10\n678\n";
    const list = parseAllowList(text);
    expect([...list.ids].sort((a, b) => a - b)).toEqual([9, 10, 678, 12345]);
    expect(list.count).toBe(4);
    expect(list.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseAllowList(text).sha256).toBe(list.sha256);
    // The login is informational: it is never matched.
    expect(parseAllowList("alice:1\n").ids.has(1)).toBe(true);
    expect(emptyAllowList().count).toBe(0);
  });

  it("U-GATE-14 a login-only line is rejected naming the line number only; so is any malformed line", () => {
    const secret = "sentinel-login";
    for (const [text, line, kind] of [
      [`1\n${secret}\n2\n`, 2, "login_only"],
      [`# c\n${secret} # note\n`, 2, "login_only"],
      ["1\n2\nnot a login!:5\n", 3, "invalid"],
      ["alice:abc\n", 1, "invalid"],
      ["alice:0\n", 1, "invalid"],
      ["alice:-3\n", 1, "invalid"],
      ["alice:12:13\n", 1, "invalid"],
      ["99999999999999999999\n", 1, "invalid"],
    ] as const) {
      let thrown: unknown;
      try {
        parseAllowList(text);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, text).toBeInstanceOf(AllowListError);
      const err = thrown as AllowListError;
      expect(err.line).toBe(line);
      expect(err.kind).toBe(kind);
      expect(err.message).toContain(`line ${line}`);
      expect(err.message).not.toContain(secret);
      expect(err.message).not.toContain("not a login");
      if (kind === "login_only") expect(err.message).toContain("allow-list resolve");
    }
  });

  it("U-GATE-15 resolve rewrites login-only lines as login:id, keeps comments and line endings, and is all-or-nothing", async () => {
    const ids: Record<string, number> = { alice: 11, bob: 22 };
    const lookup = async (login: string) => ids[login.toLowerCase()];
    const out = await resolveAllowList("# x\r\nalice # lead\r\n5\r\nbob:3\nBob\n", lookup);
    expect(out).toEqual({ text: "# x\r\nalice:11 # lead\r\n5\r\nbob:3\nBob:22\n", resolved: 2 });
    expect(parseAllowList(out.text).ids).toEqual(new Set([11, 5, 3, 22]));

    // A numeric login cannot be told from an ID by shape: `@1234` says it is a login.
    const numeric = await resolveAllowList("@1234 # lead\n1234\n", async (l) =>
      l === "1234" ? 98765 : undefined,
    );
    expect(numeric.text).toBe("1234:98765 # lead\n1234\n");
    expect([...parseAllowList(numeric.text).ids].sort()).toEqual([1234, 98765]);
    expect(() => parseAllowList("@1234\n")).toThrow(/line 1 has a login/);
    expect(() => parseAllowList("@not a login\n")).toThrow(/line 1 is not/);

    const err = await resolveAllowList("alice\nghost-1\nghost-2\n", lookup).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AllowListResolveError);
    expect((err as AllowListResolveError).lines).toEqual([2, 3]);
    expect((err as AllowListResolveError).message).not.toContain("ghost");
  });
});
