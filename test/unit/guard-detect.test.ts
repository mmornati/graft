import { describe, expect, it } from "vitest";
import {
  type ChainCommit,
  type CommitPr,
  checkRunKey,
  classifyCandidates,
  classifyConclusion,
  classifyStatusState,
  confirmationStep,
  detectTransition,
  type KeyResult,
  type ResultClass,
  statusKey,
} from "../../src/guard/detect.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const pr = (number: number): CommitPr => ({ kind: "pr", number });
const DIRECT: CommitPr = { kind: "direct" };

/** Commits 1..n, oldest first; `prs[i]` is the PR of commit i+1. */
function chain(prs: CommitPr[], breaks: number[] = []): ChainCommit[] {
  return prs.map((p, i) => ({
    sha: sha(i + 1),
    seq: i + 1,
    chainBreak: breaks.includes(i + 1),
    pr: p,
  }));
}
const results = (key: string, classes: (ResultClass | null)[]): KeyResult[] =>
  classes.flatMap((c, i) => (c === null ? [] : [{ key, sha: sha(i + 1), class: c }]));

const KEY = checkRunKey(15368, "test");

describe("guard detection (pure)", () => {
  it("U-DET-1 every check run conclusion and status state maps to its class", () => {
    expect(classifyConclusion("success")).toBe("green");
    for (const c of ["failure", "timed_out", "startup_failure"]) {
      expect(classifyConclusion(c), c).toBe("red");
    }
    for (const c of [
      "neutral",
      "skipped",
      "cancelled",
      "action_required",
      "stale",
      null,
      undefined,
      "something_new",
    ]) {
      expect(classifyConclusion(c), String(c)).toBe("ignored");
    }
    expect(classifyStatusState("success")).toBe("green");
    expect(classifyStatusState("failure")).toBe("red");
    expect(classifyStatusState("error")).toBe("red");
    expect(classifyStatusState("pending")).toBe("ignored");
  });

  it("U-DET-2 keys: the same name from two apps is two keys; a long name is truncated; status contexts", () => {
    expect(checkRunKey(1, "test")).toBe("run:1:test");
    expect(checkRunKey(2, "test")).toBe("run:2:test");
    expect(checkRunKey(1, "test")).not.toBe(checkRunKey(2, "test"));
    const long = "x".repeat(250);
    expect(checkRunKey(7, long)).toBe(`run:7:${"x".repeat(200)}`);
    expect(statusKey("ci/jenkins")).toBe("status:ci/jenkins");
    expect(statusKey(long)).toBe(`status:${"x".repeat(200)}`);
    expect(statusKey(long).length).toBeLessThanOrEqual(240);
  });

  it("U-DET-3 single culprit: green on N-1, red on N, N is PR #7's squash commit", () => {
    const c = chain([DIRECT, DIRECT, pr(7)]);
    const t = detectTransition(c, results(KEY, [null, "green", "red"]), KEY, sha(3));
    expect(t).toMatchObject({ kind: "new", key: KEY, failingSha: sha(3), lastGreenSha: sha(2) });
    if (t.kind !== "new") throw new Error("no transition");
    expect(t.candidates.map((x) => x.sha)).toEqual([sha(3)]);
    expect(classifyCandidates(t.candidates)).toEqual({ status: "culprit_found", prNumber: 7 });
  });

  it("U-DET-4 two merges between green and red: ambiguous with both PR numbers", () => {
    const c = chain([DIRECT, pr(5), pr(6)]);
    const t = detectTransition(c, results(KEY, ["green", null, "red"]), KEY, sha(3));
    if (t.kind !== "new") throw new Error("no transition");
    expect(t.candidates.map((x) => x.sha)).toEqual([sha(2), sha(3)]);
    expect(classifyCandidates(t.candidates)).toEqual({
      status: "ambiguous",
      prNumbers: [5, 6],
      unresolved: 0,
    });
  });

  it("U-DET-5 rebase merge: three commits of PR #9 between green and red", () => {
    const c = chain([DIRECT, pr(9), pr(9), pr(9)]);
    const t = detectTransition(c, results(KEY, ["green", null, null, "red"]), KEY, sha(4));
    if (t.kind !== "new") throw new Error("no transition");
    expect(t.candidates).toHaveLength(3);
    expect(classifyCandidates(t.candidates)).toEqual({ status: "culprit_found", prNumber: 9 });
  });

  it("U-DET-6 red before the merge: N-1 already red", () => {
    const c = chain([DIRECT, pr(3), pr(4)]);
    expect(detectTransition(c, results(KEY, ["green", "red", "red"]), KEY, sha(3))).toEqual({
      kind: "none",
      why: "already_red",
    });
  });

  it("U-DET-7 CI skipped on N-1, green on N-2, red on N, N-1 and N from different PRs: ambiguous", () => {
    const c = chain([pr(1), pr(2), pr(3)]);
    const t = detectTransition(c, results(KEY, ["green", "ignored", "red"]), KEY, sha(3));
    if (t.kind !== "new") throw new Error("no transition");
    expect(t.lastGreenSha).toBe(sha(1));
    expect(classifyCandidates(t.candidates)).toEqual({
      status: "ambiguous",
      prNumbers: [2, 3],
      unresolved: 0,
    });
  });

  it("U-DET-8 a direct push red: no_culprit; a direct push next to a PR: ambiguous (two origins)", () => {
    const direct = chain([pr(1), DIRECT]);
    const t = detectTransition(direct, results(KEY, ["green", "red"]), KEY, sha(2));
    if (t.kind !== "new") throw new Error("no transition");
    expect(classifyCandidates(t.candidates)).toEqual({ status: "no_culprit" });

    const mixed = chain([pr(1), DIRECT, pr(4)]);
    const m = detectTransition(mixed, results(KEY, ["green", null, "red"]), KEY, sha(3));
    if (m.kind !== "new") throw new Error("no transition");
    expect(classifyCandidates(m.candidates)).toEqual({
      status: "ambiguous",
      prNumbers: [4],
      unresolved: 0,
    });
  });

  it("U-DET-9 a chain break between the green and the red: no_baseline", () => {
    const c = chain([DIRECT, pr(2), pr(3)], [2]);
    expect(detectTransition(c, results(KEY, ["green", null, "red"]), KEY, sha(3))).toEqual({
      kind: "none",
      why: "no_baseline",
    });
    // The break commit itself may be the baseline.
    const own = chain([DIRECT, pr(2), pr(3)], [2]);
    const t = detectTransition(own, results(KEY, ["green", "green", "red"]), KEY, sha(3));
    expect(t).toMatchObject({ kind: "new", lastGreenSha: sha(2) });
    // No result at all before the red one.
    expect(detectTransition(chain([pr(1)]), results(KEY, ["red"]), KEY, sha(1))).toEqual({
      kind: "none",
      why: "no_baseline",
    });
  });

  it("U-DET-10 an unresolved candidate: ambiguous with unresolved 1", () => {
    const c = chain([DIRECT, { kind: "unresolved" }, pr(8)]);
    const t = detectTransition(c, results(KEY, ["green", null, "red"]), KEY, sha(3));
    if (t.kind !== "new") throw new Error("no transition");
    expect(classifyCandidates(t.candidates)).toEqual({
      status: "ambiguous",
      prNumbers: [8],
      unresolved: 1,
    });
    // `multiple` is ambiguous too.
    expect(classifyCandidates(chain([{ kind: "multiple" }]))).toMatchObject({
      status: "ambiguous",
    });
  });

  it("U-DET-11 cancelled on N with green before: not_red", () => {
    const c = chain([DIRECT, pr(2)]);
    const cancelled = classifyConclusion("cancelled");
    expect(detectTransition(c, results(KEY, ["green", cancelled]), KEY, sha(2))).toEqual({
      kind: "none",
      why: "not_red",
    });
  });

  it("U-DET-12 a filtered key (guard.checks) opens nothing", () => {
    const c = chain([DIRECT, pr(2)]);
    const rs: KeyResult[] = [
      { key: KEY, sha: sha(1), class: "green" },
      { key: KEY, sha: sha(2), class: "ignored", filtered: true },
    ];
    expect(detectTransition(c, rs, KEY, sha(2))).toEqual({ kind: "none", why: "filtered" });
  });

  it("U-DET-13 confirmationStep", () => {
    const at = new Date("2026-10-14T12:00:00Z");
    const base = {
      failingKeys: ["a"],
      failingSha: sha(2),
      nextSha: sha(3) as string | null,
      resultsOnFailing: { a: "red" } as Record<string, ResultClass>,
      resultsOnNext: {} as Record<string, ResultClass>,
      detectedAt: at,
      now: new Date(at.getTime() + 60_000),
      windowSeconds: 7200,
    };
    // next red
    expect(confirmationStep({ ...base, resultsOnNext: { a: "red" } })).toBe("confirmed");
    // re-run green
    expect(confirmationStep({ ...base, resultsOnFailing: { a: "green" } })).toBe("flaky");
    // next green
    expect(confirmationStep({ ...base, resultsOnNext: { a: "green" } })).toBe("flaky");
    // window elapsed, still red
    expect(
      confirmationStep({
        ...base,
        nextSha: null,
        now: new Date(at.getTime() + 7200_000),
      }),
    ).toBe("confirmed");
    // window not elapsed, no next commit
    expect(confirmationStep({ ...base, nextSha: null })).toBe("wait");
    // next commit without a result yet
    expect(confirmationStep(base)).toBe("wait");
    // several keys, one still red on next
    expect(
      confirmationStep({
        ...base,
        failingKeys: ["a", "b"],
        resultsOnFailing: { a: "red", b: "red" },
        resultsOnNext: { a: "green", b: "red" },
      }),
    ).toBe("confirmed");
    // several keys, one green again and the other still red: wait, then the window confirms
    const half = {
      ...base,
      nextSha: null,
      failingKeys: ["a", "b"],
      resultsOnFailing: { a: "green", b: "red" } as Record<string, ResultClass>,
    };
    expect(confirmationStep(half)).toBe("wait");
    expect(confirmationStep({ ...half, now: new Date(at.getTime() + 7200_000) })).toBe("confirmed");
    // a result on a next commit that does not exist is ignored
    expect(confirmationStep({ ...base, nextSha: null, resultsOnNext: { a: "red" } })).toBe("wait");
  });

  it("U-DET-14 property: a culprit is never returned when the candidates map to more than one PR or include a non-PR commit", () => {
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const kinds = (): CommitPr => {
      const k = rand(6);
      if (k === 0) return DIRECT;
      if (k === 1) return { kind: "multiple" };
      if (k === 2) return { kind: "unresolved" };
      return pr(1 + rand(3));
    };
    for (let i = 0; i < 2000; i++) {
      const list = chain(Array.from({ length: 1 + rand(8) }, kinds));
      const got = classifyCandidates(list);
      const prs = new Set(list.flatMap((c) => (c.pr.kind === "pr" ? [c.pr.number] : [])));
      const nonPr = list.some((c) => c.pr.kind !== "pr");
      if (prs.size !== 1 || nonPr) {
        expect(got.status, JSON.stringify(list.map((c) => c.pr))).not.toBe("culprit_found");
      } else {
        expect(got).toEqual({ status: "culprit_found", prNumber: [...prs][0] });
      }
      // And through detection: a culprit's candidates are exactly the commits after the green one.
      const classes = list.map((_, j) =>
        j === 0 ? "green" : j === list.length - 1 ? "red" : null,
      );
      const t = detectTransition(list, results(KEY, classes), KEY, sha(list.length));
      if (list.length > 1 && t.kind === "new") {
        const c = classifyCandidates(t.candidates);
        if (c.status === "culprit_found") {
          expect(t.candidates.every((x) => x.pr.kind === "pr" && x.pr.number === c.prNumber)).toBe(
            true,
          );
        }
      }
    }
  });
});
