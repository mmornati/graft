/**
 * The fixed text of a revert (Phase 1 step 5, §8, §10, D11, D12).
 */
import { describe, expect, it } from "vitest";
import {
  type ModeView,
  type RevertBodyInput,
  revertBody,
  revertCommitMessage,
  revertModeLine,
  revertParagraph,
  revertTitle,
} from "../../src/guard/revert-text.js";
import { guardMarker, renderGuardComment } from "../../src/modules/guard/comment.js";

const ABC = `abc1234${"0".repeat(33)}`;
const GREEN = `9f8e7d6${"0".repeat(33)}`;
const NEXT = `def5678${"0".repeat(33)}`;

const BODY: RevertBodyInput = {
  prNumber: 123,
  branch: "main",
  failingSha: ABC,
  lastGreenSha: GREEN,
  lastGreenIsParent: true,
  restoredTo: GREEN,
  paths: 4,
  checks: [
    { name: "test", htmlUrl: "https://github.com/acme/app/runs/123" },
    { name: "lint (node 24)", htmlUrl: null },
  ],
  confirmation: { reason: "next_commit", nextSha: NEXT },
  author: { login: "alice", type: "User" },
  mergedBy: { login: "bob", type: "User" },
  task: "#42",
  sessionUrl: "https://claude.ai/code/session_01ABC",
  autoMerge: { on: true, risk: "logic" },
};

/** Every `@` that is not inside a code span (a run of n backticks closes on n). */
function atsOutsideCode(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    let i = 0;
    while (i < line.length) {
      if (line[i] === "`") {
        let run = 0;
        while (line[i + run] === "`") run++;
        const fence = "`".repeat(run);
        let close = -1;
        for (let j = i + run; j < line.length; j++) {
          if (line.startsWith(fence, j) && line[j + run] !== "`" && line[j - 1] !== "`") {
            close = j;
            break;
          }
        }
        if (close < 0) {
          i += run;
          continue;
        }
        i = close + run;
        continue;
      }
      if (line[i] === "@") out.push(line.slice(i, i + 20));
      i++;
    }
  }
  return out;
}

const lastParagraph = (text: string): string => text.trimEnd().split("\n\n").at(-1) as string;

describe("revert text: the commit and the pull request (§8)", () => {
  it("U-RVT-1 the §8 samples, literally; the trailer is the last paragraph of the message and the body", () => {
    const message = revertCommitMessage({
      prNumber: 123,
      branch: "main",
      failingSha: ABC,
      restoredTo: GREEN,
      paths: 4,
    });
    expect(message).toBe(
      [
        "Revert #123 (Graft guard)",
        "",
        "CI went red on main at abc1234 after pull request #123 was merged.",
        "This restores the 4 paths #123 changed to their state at 9f8e7d6.",
        "",
        "Graft-Agent: graft-guard",
      ].join("\n"),
    );
    expect(revertTitle(123)).toBe("Revert #123 (Graft guard)");
    const body = revertBody(BODY);
    expect(body).toBe(
      [
        "Graft's post-merge guard opened this pull request to revert #123.",
        "",
        "CI check `test` went red on `main` at `abc1234` after #123 was merged. It was green at `9f8e7d6`, the commit before, and the failure was confirmed (the next commit `def5678` is also red).",
        "",
        "- Failing: `test`, `lint (node 24)` ([details](https://github.com/acme/app/runs/123))",
        "- Reverts: 4 paths, restored to `9f8e7d6`",
        "- Author: @alice · Task: #42 · [agent session](https://claude.ai/code/session_01ABC)",
        "- Auto-merge: on (risk `logic`, allowed by `guard.auto_merge_reverts`)",
        "",
        "Branch protection and required checks decide whether this merges. Close it to keep #123; fix forward instead.",
        "",
        "Graft-Agent: graft-guard",
      ].join("\n"),
    );
    expect(lastParagraph(message)).toBe("Graft-Agent: graft-guard");
    expect(lastParagraph(body)).toBe("Graft-Agent: graft-guard");
    // The window alternative, a last green that is not the parent, auto-merge off.
    const windowed = revertBody({
      ...BODY,
      lastGreenIsParent: false,
      paths: 1,
      confirmation: { reason: "window", windowSeconds: 7200 },
      autoMerge: { on: false, reason: "break_glass" },
    });
    expect(windowed).toContain(
      "It was last green at `9f8e7d6`, and the failure was confirmed (still red after 2 hours).",
    );
    expect(windowed).toContain("- Reverts: 1 path, restored to `9f8e7d6`");
    expect(windowed).toContain("- Auto-merge: off: the culprit was merged under break-glass");
    expect(windowed.length).toBeLessThanOrEqual(4000);
    // A branch name that is not plain stays out of the commit message.
    expect(
      revertCommitMessage({
        prNumber: 1,
        branch: "x`\n@y",
        failingSha: ABC,
        restoredTo: GREEN,
        paths: 1,
      }),
    ).toContain("CI went red on the default branch at abc1234");
  });

  it("U-RVT-2 mentions: a User author, a Bot author (merged_by is mentioned), an invalid login; no @ anywhere else", () => {
    const user = revertBody(BODY);
    expect(atsOutsideCode(user).map((a) => a.split(" ")[0])).toEqual(["@alice"]);
    const bot = revertBody({ ...BODY, author: { login: "renovate[bot]", type: "Bot" } });
    expect(bot).toContain("- Author: `renovate[bot]`, merged by @bob · Task: #42");
    expect(atsOutsideCode(bot).map((a) => a.split(" ")[0])).toEqual(["@bob"]);
    const botNoMerger = revertBody({
      ...BODY,
      author: { login: "renovate[bot]", type: "Bot" },
      mergedBy: { login: "deploy-bot", type: "Bot" },
    });
    expect(atsOutsideCode(botNoMerger)).toEqual([]);
    // Step 5 review 1, nit 12: a Bot whose login is a valid mention is still a code span.
    const validBot = revertBody({ ...BODY, author: { login: "ci-helper", type: "Bot" } });
    expect(validBot).toContain("- Author: `ci-helper`, merged by @bob");
    expect(atsOutsideCode(validBot).map((a) => a.split(" ")[0])).toEqual(["@bob"]);
    const invalid = revertBody({ ...BODY, author: { login: "-not@valid--", type: "User" } });
    expect(invalid).toContain("- Author: `-not@valid--`");
    expect(atsOutsideCode(invalid)).toEqual([]);
    const tooLong = revertBody({ ...BODY, author: { login: "a".repeat(40), type: "User" } });
    expect(atsOutsideCode(tooLong)).toEqual([]);
    // A hostile check name stays a code span.
    const hostile = revertBody({
      ...BODY,
      checks: [{ name: "x @acme/security `y`", htmlUrl: null }],
    });
    expect(atsOutsideCode(hostile).map((a) => a.split(" ")[0])).toEqual(["@alice"]);
  });

  it("U-RVT-3 tasks and the session URL: #42 is a reference, other values are code spans, a session only when valid", () => {
    expect(revertBody({ ...BODY, task: "ABC-12" })).toContain("Task: `ABC-12`");
    const team = revertBody({ ...BODY, task: "@team/x" });
    expect(team).toContain("Task: `@team/x`");
    expect(atsOutsideCode(team).map((a) => a.split(" ")[0])).toEqual(["@alice"]);
    const ticks = revertBody({ ...BODY, task: "a`b`@c" });
    expect(ticks).toContain("Task: `` a`b`@c ``");
    expect(atsOutsideCode(ticks).map((a) => a.split(" ")[0])).toEqual(["@alice"]);
    expect(revertBody({ ...BODY, task: "#42 extra" })).toContain("Task: `#42 extra`");
    expect(revertBody({ ...BODY, task: null })).toContain("- Author: @alice · [agent session]");
    for (const bad of [
      "http://claude.ai/x",
      "https://claude.ai/x)](javascript:alert(1)",
      "https://claude.ai/x y",
      "javascript:alert(1)",
      "https://user@claude.ai/x",
      `https://claude.ai/${"x".repeat(600)}`,
    ]) {
      const b = revertBody({ ...BODY, sessionUrl: bad });
      expect(b, bad).not.toContain("agent session");
    }
    expect(revertBody({ ...BODY, sessionUrl: null })).toContain("- Author: @alice · Task: #42\n");
  });
});

describe("revert text: the guard comment (§10)", () => {
  const REPORT: ModeView = { effective: "report", requested: "report", reason: "repository" };
  const ENFORCE: ModeView = { effective: "enforce", requested: "enforce", reason: "repository" };

  it("U-RVT-4 each §10 row; 25 conflicting paths list 20 and 'and 5 more'; hostile paths are safe; one marker", () => {
    expect(
      revertParagraph(
        { kind: "planned", paths: 4, restoredTo: GREEN, autoMerge: { on: true, risk: "logic" } },
        "report",
      ),
    ).toBe(
      "Graft would open a pull request reverting this merge (4 paths restored to `9f8e7d6`) and would enable auto-merge on it.",
    );
    expect(
      revertParagraph(
        {
          kind: "planned",
          paths: 1,
          restoredTo: GREEN,
          autoMerge: { on: false, reason: "not_configured" },
        },
        "report",
      ),
    ).toBe(
      "Graft would open a pull request reverting this merge (1 path restored to `9f8e7d6`) and would not enable auto-merge: `guard.auto_merge_reverts` is not set in graft.yaml at the last green commit.",
    );
    expect(
      revertParagraph({ kind: "opened", prNumber: 456, autoMerge: { on: true } }, "enforce"),
    ).toBe("Graft opened #456 to revert this merge. Auto-merge: on.");
    expect(
      revertParagraph(
        { kind: "opened", prNumber: 456, autoMerge: { on: false, reason: "sensitive" } },
        "enforce",
      ),
    ).toBe(
      "Graft opened #456 to revert this merge. Auto-merge: off: reverts of sensitive changes are never auto-merged.",
    );
    const touched = (conflicts: string[] | null, mode: "report" | "enforce") =>
      revertParagraph(
        {
          kind: "needs_human",
          reason: "touched_later",
          branch: "main",
          conflicts,
          conflictCount: 5,
        },
        mode,
      );
    expect(touched(["a.ts", "b/c.ts", "d", "e", "f"], "enforce")).toBe(
      "Graft did not open a revert: these paths changed again on `main` after this merge: `a.ts`, `b/c.ts`, `d`, `e`, `f`. Revert by hand or fix forward.",
    );
    expect(touched(["a.ts"], "report")).toMatch(/^Graft would not open a revert: these paths/);
    expect(touched(null, "enforce")).toBe(
      "Graft did not open a revert: 5 paths changed again on `main` after this merge. Revert by hand or fix forward.",
    );
    const many = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`);
    const listed = touched(many, "enforce");
    expect(listed).toContain("`src/file19.ts` and 5 more.");
    expect(listed).not.toContain("file20");
    for (const reason of [
      "workflow_files",
      "submodule",
      "type_change",
      "too_large",
      "history_incomplete",
    ] as const) {
      const p = revertParagraph(
        { kind: "needs_human", reason, branch: "main", conflicts: ["x"], conflictCount: 1 },
        "enforce",
      );
      expect(p, reason).toMatch(
        /^Graft did not open a revert: .+\. Revert by hand or fix forward\.$/,
      );
      expect(p, reason).not.toContain("`x`");
    }
    for (const reason of [
      "confirmation_off",
      "revert_of_revert",
      "already_reverted",
      "already_green",
      "already_opened",
      "cap_reached",
      "filtered_at_baseline",
      "revert_off",
    ] as const) {
      expect(revertParagraph({ kind: "skipped", reason }, "enforce"), reason).toMatch(
        /^Graft did not open a revert: [^\n]+\.$/,
      );
      expect(revertParagraph({ kind: "skipped", reason }, "report"), reason).toMatch(
        /^Graft would not open a revert: /,
      );
    }
    expect(
      revertParagraph({ kind: "error", errorClass: "tree_mismatch", prNumber: null }, "enforce"),
    ).toBe(
      "Graft could not open the revert (tree_mismatch). An operator can see the event with `graft guard list`.",
    );
    expect(
      revertParagraph({ kind: "error", errorClass: "mode_changed", prNumber: 456 }, "enforce"),
    ).toBe(
      "Graft opened #456 to revert this merge but could not finish (mode_changed). An operator can see the event with `graft guard list`.",
    );
    expect(revertParagraph({ kind: "step4" }, "enforce")).toBe(
      "Graft would open a pull request reverting this merge. Fix forward or revert to clear it.",
    );

    // Mode lines.
    expect(revertModeLine(REPORT)).toBe(
      "Graft mode: report. Graft opens nothing; this is what it would do.",
    );
    expect(revertModeLine(ENFORCE)).toBe("Graft mode: enforce.");
    expect(
      revertModeLine({
        effective: "report",
        requested: "enforce",
        reason: "permission_missing",
        missing: "contents:write",
      }),
    ).toBe(
      "Graft mode: report (enforce requested; permission_missing contents:write). Graft opens nothing; this is what it would do.",
    );
    expect(revertModeLine({ effective: "report", requested: "enforce", reason: "ceiling" })).toBe(
      "Graft mode: report (enforce requested; ceiling). Graft opens nothing; this is what it would do.",
    );

    // Hostile paths in the full comment: code spans, no live HTML comment, one marker.
    const hostile = [
      "a`b.ts",
      "<!-- graft:guard-event x -->",
      `${guardMarker("evt")}`,
      "@acme/team.md",
      "x".repeat(300),
    ];
    const body = renderGuardComment({
      eventId: "evt",
      branch: "main",
      failingSha: ABC,
      lastGreenSha: GREEN,
      lastGreenIsParent: true,
      checks: [{ name: "test", htmlUrl: null }],
      confirmation: { reason: "next_commit", nextSha: NEXT },
      revert: {
        paragraph: touched(hostile, "enforce"),
        modeLine: revertModeLine(ENFORCE),
      },
    });
    expect(body.split(guardMarker("evt"))).toHaveLength(2);
    expect(body.startsWith(guardMarker("evt"))).toBe(true);
    expect(body.match(/<!--/g)).toHaveLength(1);
    expect(body).toContain("`` a`b.ts ``");
    expect(atsOutsideCode(body)).toEqual([]);
    expect(body).toContain(`\`${"x".repeat(199)}…\``);
  });
});
