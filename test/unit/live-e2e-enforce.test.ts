/** Phase 1 step 7 (D21): the enforce sandbox of the live e2e runner, offline parts. */
import { describe, expect, it } from "vitest";
import { checkRequest, type GuardContext, sandboxEntrySchema } from "../../src/e2e/guard.js";
import { allowedDoctorWarns, evaluateInv1E } from "../../src/e2e/invariants.js";
import type { CheckObs } from "../../src/e2e/observe.js";
import { modeProblem, starterFixture } from "../../src/e2e/preflight.js";
import { E01_STEPS, e01 } from "../../src/e2e/scenarios/e01.js";
import { ScenarioModeError, selectScenarios } from "../../src/e2e/scenarios/index.js";

const check = (name: string, status: string, conclusion: string | null): CheckObs => ({
  id: 1,
  name,
  status,
  conclusion,
  title: null,
  completedAt: null,
  hasActions: false,
});
const checks = (policy: string | null, intent = "neutral"): CheckObs[] => [
  check("graft/provenance", "completed", "neutral"),
  check("graft/intent", "completed", intent),
  check("graft/policy", "completed", policy),
];

describe("live e2e: the enforce sandbox (Phase 1 step 7, D21)", () => {
  it("U-LIVE-ENF-1 sandboxEntrySchema defaults mode to report; enforce parses; an unknown mode is refused", () => {
    const base = {
      repo: "o/sandbox",
      source: "o/source",
      visibility: "private",
      defaultBranch: "main",
    };
    expect(sandboxEntrySchema.parse(base).mode).toBe("report");
    expect(sandboxEntrySchema.parse({ ...base, mode: "enforce" }).mode).toBe("enforce");
    expect(sandboxEntrySchema.safeParse({ ...base, mode: "audit" }).success).toBe(false);
    expect(starterFixture({ mode: "report" })).toBe("graft.yaml");
    expect(starterFixture({ mode: "enforce" })).toBe("graft.enforce.yaml");
  });

  it("U-LIVE-ENF-2 INV-1E: the expected policy conclusion passes; neutral policy, the other conclusion, a non-neutral intent or a check in progress fail", () => {
    const pr = (c: CheckObs[], expected: string | undefined) => [
      { number: 7, checks: c, expected },
    ];
    expect(evaluateInv1E(pr(checks("failure"), "failure")).status).toBe("pass");
    expect(evaluateInv1E(pr(checks("success"), "success")).status).toBe("pass");
    const neutral = evaluateInv1E(pr(checks("neutral"), "failure"));
    expect(neutral.status).toBe("fail");
    expect(neutral.detail).toContain("graft/policy is neutral");
    const other = evaluateInv1E(pr(checks("success"), "failure"));
    expect(other.status).toBe("fail");
    expect(other.detail).toContain("expected failure");
    expect(evaluateInv1E(pr(checks("failure", "success"), "failure")).status).toBe("fail");
    expect(evaluateInv1E(pr(checks("failure"), undefined)).status).toBe("fail");
    const running = [check("graft/policy", "in_progress", null), ...checks("failure").slice(0, 2)];
    expect(evaluateInv1E(pr(running, "failure")).status).toBe("fail");
    expect(evaluateInv1E(pr(checks("failure").slice(1), "failure")).detail).toContain("missing");
    // e01 applies a break-glass on purpose: the doctor's WARN is allowed on an enforce sandbox only.
    expect(allowedDoctorWarns("live", "enforce").has("break_glass")).toBe(true);
    expect(allowedDoctorWarns("live").has("break_glass")).toBe(false);
  });

  it("U-LIVE-ENF-3 scenario selection: e01 alone by default on an enforce sandbox; s01 against an enforce sandbox and e01 against a report one are refused", () => {
    expect(selectScenarios([], false, "enforce").map((s) => s.id)).toEqual(["e01"]);
    expect(selectScenarios([], false, "report").map((s) => s.id)).not.toContain("e01");
    expect(selectScenarios(["e01"], false, "enforce").map((s) => s.id)).toEqual(["e01"]);
    expect(() => selectScenarios(["s01"], false, "enforce")).toThrow(ScenarioModeError);
    expect(() => selectScenarios(["e01"], false, "report")).toThrow(ScenarioModeError);
    for (const id of [
      "s01",
      "s02",
      "s03",
      "s04",
      "s05",
      "s06",
      "s07",
      "s08",
      "s09",
      "s10",
      "b1",
      "b2",
    ]) {
      expect(() => selectScenarios([id], false, "enforce"), id).toThrow(ScenarioModeError);
    }
    // e01's expectations, §12 (a) to (e), and it needs the outsider.
    expect(E01_STEPS.map((s) => [s.id, s.expect])).toEqual([
      ["a", "failure"],
      ["b", "success"],
      ["c", "failure"],
      ["d", "success"],
      ["e", "failure"],
    ]);
    expect(e01.requiresOutsider).toBe(true);
  });

  it("the preflight's mode rule: a report sandbox requests report everywhere; an enforce sandbox needs the worker's ceiling and policy enforce only", () => {
    const view = (o: {
      ceiling?: string;
      source?: string;
      policy?: [string, string];
      guard?: string;
      mcp?: string;
    }) => ({
      ceiling: o.ceiling ?? "report",
      ceilingSource: o.source ?? "worker",
      policy: { requested: o.policy?.[0] ?? "report", effective: o.policy?.[1] ?? "report" },
      guard: { requested: o.guard ?? "report", effective: "report" },
      mcpWrite: { requested: o.mcp ?? "off", effective: "off" },
    });
    const rep = { repo: "o/s", mode: "report" as const };
    const enf = { repo: "o/s", mode: "enforce" as const };
    expect(modeProblem(rep, view({}))).toBeNull();
    expect(modeProblem(rep, view({ policy: ["enforce", "report"] }))).toContain("mode set");
    expect(modeProblem(rep, null)).toContain("cannot read");
    const ok = view({ ceiling: "enforce", policy: ["enforce", "enforce"] });
    expect(modeProblem(enf, ok)).toBeNull();
    expect(modeProblem(enf, { ...ok, ceilingSource: "shell" })).toContain("GRAFT_MODE_CEILING");
    expect(modeProblem(enf, view({ ceiling: "enforce", policy: ["enforce", "report"] }))).toContain(
      "--policy enforce",
    );
    expect(
      modeProblem(
        enf,
        view({ ceiling: "enforce", policy: ["enforce", "enforce"], guard: "enforce" }),
      ),
    ).toContain("--guard report");
  });

  it("the outsider may approve a run PR in private mode and send no other review event", () => {
    const ctx: GuardContext = {
      sandbox: "o/s",
      visibility: "private",
      canDeleteRef: () => false,
      config: {
        version: 1,
        sandboxes: [
          {
            repo: "o/s",
            source: "o/src",
            visibility: "private",
            defaultBranch: "main",
            mode: "enforce",
          },
        ],
      },
      isRunPullRequestId: () => false,
      allowCreateRepo: () => false,
      forkVerified: () => false,
    };
    expect(() =>
      checkRequest(
        "outsider",
        { method: "POST", path: "/repos/o/s/pulls/7/reviews", body: { event: "APPROVE" } },
        ctx,
      ),
    ).not.toThrow();
    expect(() =>
      checkRequest(
        "outsider",
        { method: "POST", path: "/repos/o/s/pulls/7/reviews", body: { event: "REQUEST_CHANGES" } },
        ctx,
      ),
    ).toThrow();
    expect(() =>
      checkRequest(
        "outsider",
        { method: "POST", path: "/repos/o/s/issues/7/labels", body: { labels: ["x"] } },
        ctx,
      ),
    ).toThrow();
  });
});
