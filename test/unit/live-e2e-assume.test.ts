import { describe, expect, it } from "vitest";
import {
  ANCHORS,
  ASSUMPTIONS,
  addTimelineKinds,
  capEvidence,
  type EvalInput,
  emptyTimelineKinds,
  evaluateAssumptions,
  humanTodoStatus,
} from "../../src/e2e/assumptions.js";
import { SecretRegistry } from "../../src/e2e/secrets.js";

const ok = { pass: "pass", fail: "fail", skipped: "skipped" } as const;
const allRan: EvalInput["scenarios"] = Object.fromEntries(
  ["s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08", "s09", "s10", "b1"].map((s) => [
    s,
    ok.pass,
  ]),
);

const goodEvidence = (): EvalInput["evidence"] => ({
  A01: { probe: 12345, actor: 12345 },
  A02: { login: "graft-dev[bot]", type: "Bot" },
  A03: { status: 200, count: 2, actorListed: true },
  A04: { cronExercised: true, rowPresent: true },
  A05: { answer: "y" },
  A06: { answer: "y", delivered: true, recorded: true },
  A07: { outcome: "clicked", recorded: "check_action", droppedByGate: true },
  A08: { status: 200, permission: "admin", s08: { verified: true, denials: 0 } },
  A09: {
    status: 200,
    permissions: {
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "write",
      checks: "write",
    },
    events: ["check_run", "pull_request", "pull_request_review", "push"],
    repositorySelection: "selected",
  },
  A10: { count: 2 },
  A11: { want: ["refs/heads/a", "refs/heads/main"], refs: ["refs/heads/a", "refs/heads/main"] },
  A12: { listsGraftYaml: true },
  A13: {
    status: 200,
    kinds: {
      review_requested: { seen: true, normalized: true },
      reviewed: { seen: true, normalized: true },
      ready_for_review: { seen: true, normalized: true },
    },
  },
  A14: { status: 200, policyStatus: "ok" },
  A15: { s05: true, s03: null },
  A16: { s02Clean: true, s04Clean: true, control: true },
  A17: { listStatus: 200, sameGuid: true },
  A18: { deletionSeconds: 3600, afterRetention: true, remaining: 0 },
  A19: {
    writerModel: "claude-sonnet-5-5",
    firstPassModel: "claude-haiku-5-5",
    verifierModel: "claude-haiku-5-5",
    costNull: false,
  },
  A20: { installation: true, repository: true },
  A21: { limit: true, remaining: true, reset: true },
});

const input = (over: Partial<EvalInput> = {}): EvalInput => ({
  evidence: goodEvidence(),
  scenarios: allRan,
  interactive: true,
  waitCron: true,
  llmMode: "live",
  appId: 12345,
  slug: "graft-dev",
  models: { fast: "claude-haiku-5-5", strong: "claude-sonnet-5-5" },
  manifest: {
    permissions: {
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "write",
      checks: "write",
    },
    events: ["check_run", "pull_request", "pull_request_review", "push"],
  },
  ...over,
});

const status = (i: EvalInput, id: string) =>
  evaluateAssumptions(i).find((a) => a.id === id)?.status;
const withEvidence = (id: string, e: Record<string, unknown>, over: Partial<EvalInput> = {}) =>
  input({ evidence: { ...goodEvidence(), [id]: e }, ...over });

describe("assumption evaluators", () => {
  it("U-LIVE-ASSUME-1 every assumption passes on good evidence, and each table row exists", () => {
    const res = evaluateAssumptions(input());
    expect(res.map((r) => `${r.id}:${r.status}`)).toEqual(ASSUMPTIONS.map((a) => `${a.id}:pass`));
    expect(ASSUMPTIONS).toHaveLength(21);
    expect([...ANCHORS].sort()).toEqual(
      [
        "s1-install",
        "s2-performed-via",
        "s3-model-access",
        "s3-outputs",
        "s5-check-github",
        "s5-events",
        "s6-backfill",
        "s6-baseline-github",
        "s6-redelivery",
        "s6-retention",
      ].sort(),
    );
  });

  it("U-LIVE-ASSUME-1 failures: a 403 or 404, a missing field, a slug mismatch, a new redelivery guid", () => {
    // M6: the app id is compared as a number, not as a string.
    expect(status(withEvidence("A01", { probe: "12345", actor: 12345 }), "A01")).toBe("fail");
    expect(status(withEvidence("A01", { probe: null, actor: null }), "A01")).toBe("fail");
    expect(status(withEvidence("A01", { probe: 404, actor: 12345 }), "A01")).toBe("fail");
    expect(status(withEvidence("A02", { login: "other[bot]", type: "Bot" }), "A02")).toBe("fail");
    expect(status(withEvidence("A02", { login: "graft-dev[bot]", type: "User" }), "A02")).toBe(
      "fail",
    );
    expect(
      status(
        withEvidence("A02", { login: "graft-dev[bot]", type: "Bot" }, { slug: undefined }),
        "A02",
      ),
    ).toBe("unverified");
    expect(status(withEvidence("A03", { status: 403, count: 0, actorListed: false }), "A03")).toBe(
      "fail",
    );
    expect(status(withEvidence("A03", { status: 200, count: 1, actorListed: false }), "A03")).toBe(
      "fail",
    );
    expect(status(withEvidence("A08", { status: 403, permission: null }), "A08")).toBe("fail");
    expect(status(withEvidence("A08", { status: 404, permission: null }), "A08")).toBe("fail");
    expect(
      status(
        withEvidence("A08", {
          status: 200,
          permission: "admin",
          s08: { verified: false, denials: 1 },
        }),
        "A08",
      ),
    ).toBe("fail");
    expect(
      status(
        withEvidence("A09", {
          status: 200,
          permissions: { metadata: "read" },
          events: ["push"],
          repositorySelection: "all",
        }),
        "A09",
      ),
    ).toBe("fail");
    expect(status(withEvidence("A14", { status: 404, policyStatus: "ok" }), "A14")).toBe("fail");
    expect(status(withEvidence("A15", { s05: false, s03: null }), "A15")).toBe("fail");
    expect(status(withEvidence("A15", { s05: true, s03: false }), "A15")).toBe("fail");
    expect(
      status(withEvidence("A16", { s02Clean: true, s04Clean: true, control: false }), "A16"),
    ).toBe("fail");
    expect(status(withEvidence("A21", { limit: true, remaining: false, reset: true }), "A21")).toBe(
      "fail",
    );
    expect(status(withEvidence("A20", { installation: true, repository: false }), "A20")).toBe(
      "fail",
    );
    // A17: a redelivery with a new guid fails even though Graft converged, with that evidence.
    const newGuid = evaluateAssumptions(
      withEvidence("A17", { listStatus: 200, sameGuid: false }),
    ).find((a) => a.id === "A17");
    expect(newGuid?.status).toBe("fail");
    expect(JSON.stringify(newGuid?.evidence)).toContain(
      "redelivery uses a new guid; Graft converged",
    );
    expect(status(withEvidence("A17", { listStatus: 403, sameGuid: true }), "A17")).toBe("fail");
    expect(
      status(
        withEvidence(
          "A17",
          { listStatus: 200, sameGuid: true },
          { scenarios: { ...allRan, s10: "fail" } },
        ),
        "A17",
      ),
    ).toBe("fail");
    // A19: an unknown model or a null cost.
    expect(
      status(
        withEvidence("A19", {
          writerModel: "gpt-x",
          firstPassModel: null,
          verifierModel: null,
          costNull: false,
        }),
        "A19",
      ),
    ).toBe("fail");
    expect(
      status(
        withEvidence("A19", {
          writerModel: "claude-sonnet-5-5",
          firstPassModel: null,
          verifierModel: null,
          costNull: true,
        }),
        "A19",
      ),
    ).toBe("fail");
  });

  it("U-LIVE-ASSUME-1 unverified without --interactive or --wait-cron, before the retention window, and when a kind was not seen; skipped when the scenario was skipped", () => {
    const quiet = { interactive: false, waitCron: false };
    for (const id of ["A04", "A05", "A06", "A07"])
      expect(status(input(quiet), id), id).toBe("unverified");
    expect(
      status(input({ ...quiet, evidence: { ...goodEvidence(), A05: undefined as never } }), "A05"),
    ).toBe("unverified");
    expect(
      status(
        withEvidence("A18", { deletionSeconds: 3600, afterRetention: false, remaining: 4 }),
        "A18",
      ),
    ).toBe("unverified");
    expect(
      status(
        withEvidence("A18", { deletionSeconds: 3600, afterRetention: true, remaining: 2 }),
        "A18",
      ),
    ).toBe("fail");
    expect(
      status(
        withEvidence("A18", { deletionSeconds: 604800, afterRetention: true, remaining: 0 }),
        "A18",
      ),
    ).toBe("fail");
    expect(
      status(withEvidence("A06", { answer: "n", delivered: false, recorded: false }), "A06"),
    ).toBe("unverified");
    expect(status(withEvidence("A05", { answer: "n" }), "A05")).toBe("fail");
    expect(
      status(
        withEvidence("A13", {
          status: 200,
          kinds: {
            review_requested: { seen: false, normalized: false },
            reviewed: { seen: true, normalized: true },
            ready_for_review: { seen: true, normalized: true },
          },
        }),
        "A13",
      ),
    ).toBe("unverified");
    expect(
      status(
        withEvidence("A13", {
          status: 200,
          kinds: {
            review_requested: { seen: true, normalized: false },
            reviewed: { seen: true, normalized: true },
            ready_for_review: { seen: true, normalized: true },
          },
        }),
        "A13",
      ),
    ).toBe("fail");
    expect(status(withEvidence("A13", { status: 403, kinds: {} }), "A13")).toBe("fail");

    const noS08 = input({ scenarios: { ...allRan, s08: "skipped" } });
    for (const id of ["A03", "A04", "A05", "A06", "A07"])
      expect(status(noS08, id), id).toBe("skipped");
    expect(status(input({ scenarios: { ...allRan, s05: undefined } }), "A15")).toBe("skipped");
    expect(status(input({ llmMode: "none" }), "A19")).toBe("skipped");
    expect(status(withEvidence("A11", { want: [] }), "A11")).toBe("skipped");
    // Evidence is capped at 2 KB after redaction.
    const capped = capEvidence({ big: "x".repeat(5000) }, new SecretRegistry());
    expect(capped).toEqual({ truncated: true, bytes: expect.any(Number) });
    expect(JSON.stringify(capEvidence({ ok: 1 }, new SecretRegistry()))).toBe('{"ok":1}');
  });

  it("U-LIVE-ASSUME-1 A13 runs the real normalizeEvent on timeline shapes from GitHub's documentation", () => {
    const kinds = emptyTimelineKinds();
    addTimelineKinds(kinds, [
      {
        id: 1,
        node_id: "MDEx",
        event: "review_requested",
        actor: { login: "octocat", id: 1, type: "User" },
        created_at: "2011-04-14T16:00:49Z",
        review_requester: { login: "octocat", id: 1, type: "User" },
        requested_reviewer: { login: "hubot", id: 2, type: "User" },
      },
      {
        id: 2,
        event: "reviewed",
        user: { login: "octocat", id: 1, type: "User" },
        body: "Looks good",
        commit_id: "ecdd80bb57125d7ba9641ffaa4d7d2c19d3f3091",
        submitted_at: "2011-04-14T16:00:49Z",
        state: "approved",
        author_association: "COLLABORATOR",
      },
      {
        id: 3,
        event: "ready_for_review",
        actor: { login: "octocat", id: 1, type: "User" },
        created_at: "2011-04-14T16:00:50Z",
      },
      { id: 4, event: "labeled", created_at: "2011-04-14T16:00:51Z" },
    ]);
    expect(kinds).toEqual({
      review_requested: { seen: true, normalized: true },
      reviewed: { seen: true, normalized: true },
      ready_for_review: { seen: true, normalized: true },
    });
    // A shape that drifted (no timestamp) is seen but not normalized.
    const drift = emptyTimelineKinds();
    addTimelineKinds(drift, [{ event: "reviewed", user: { login: "x" } }]);
    expect(drift.reviewed).toEqual({ seen: true, normalized: false });
    expect(status(withEvidence("A13", { status: 200, kinds: drift }), "A13")).toBe("fail");
  });

  it("an anchor is resolvable only when every assumption mapped to it passed (and its extra scenarios passed)", () => {
    const results = evaluateAssumptions(withEvidence("A15", { s05: false, s03: null }));
    const todo = humanTodoStatus(results, allRan);
    expect(todo.find((t) => t.anchor === "s5-check-github")).toMatchObject({ resolvable: false });
    expect(todo.find((t) => t.anchor === "s2-performed-via")).toMatchObject({
      resolvable: true,
      assumptions: ["A01", "A02"],
    });
    // s6-baseline-github also needs b1 to have passed.
    expect(
      humanTodoStatus(evaluateAssumptions(input()), { ...allRan, b1: "fail" }).find(
        (t) => t.anchor === "s6-baseline-github",
      )?.resolvable,
    ).toBe(false);
    expect(
      humanTodoStatus(evaluateAssumptions(input()), allRan).find(
        (t) => t.anchor === "s6-baseline-github",
      )?.resolvable,
    ).toBe(true);
    // unverified is not passed.
    const quiet = humanTodoStatus(
      evaluateAssumptions(input({ interactive: false, waitCron: false })),
      allRan,
    );
    expect(quiet.find((t) => t.anchor === "s3-outputs")?.resolvable).toBe(false);
  });
});
