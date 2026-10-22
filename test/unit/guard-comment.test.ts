import { describe, expect, it } from "vitest";
import {
  ENFORCE_LINE,
  type GuardCommentInput,
  githubWebBase,
  guardMarker,
  isOurGuardComment,
  REPORT_LINE,
  renderGuardComment,
  safeHtmlUrl,
} from "../../src/modules/guard/comment.js";

const ABC = `abc1234${"0".repeat(33)}`;
const GREEN = `9f8e7d6${"0".repeat(33)}`;
const NEXT = `def5678${"0".repeat(33)}`;

const SAMPLE: GuardCommentInput = {
  eventId: "3f0c…-uuid",
  branch: "main",
  failingSha: ABC,
  lastGreenSha: GREEN,
  lastGreenIsParent: true,
  checks: [
    { name: "test", htmlUrl: "https://github.com/acme/app/runs/123" },
    { name: "lint (node 24)", htmlUrl: null },
  ],
  confirmation: { reason: "next_commit", nextSha: NEXT },
  mode: "report",
};

/** The §8 sample, with the "Confirmed by" alternative of the input. */
const expected = (confirmed: string | null, modeLine: string) =>
  [
    "<!-- graft:guard-event 3f0c…-uuid -->",
    "### Graft guard",
    "",
    "CI check `test` went red on `main` at `abc1234` after this pull request was merged. It was green at `9f8e7d6`, the commit before.",
    "",
    "- Failing: `test`, `lint (node 24)` ([details](https://github.com/acme/app/runs/123))",
    ...(confirmed === null ? [] : [`- Confirmed by: ${confirmed}`]),
    "",
    "Graft would open a pull request reverting this merge. Fix forward or revert to clear it.",
    "",
    modeLine,
  ].join("\n");

/** Every `@` that is not inside a code span (CommonMark: a run of n backticks closes on n). */
function atsOutsideCode(md: string): number {
  let n = 0;
  for (const line of md.split("\n")) {
    let i = 0;
    while (i < line.length) {
      if (line[i] === "`") {
        let run = 0;
        while (line[i + run] === "`") run++;
        let close = -1;
        for (let j = i + run; j < line.length; ) {
          if (line[j] !== "`") {
            j++;
            continue;
          }
          let r = 0;
          while (line[j + r] === "`") r++;
          if (r === run) {
            close = j;
            break;
          }
          j += r;
        }
        if (close < 0) {
          i += run;
          continue;
        }
        i = close + run;
        continue;
      }
      if (line[i] === "@") n++;
      i++;
    }
  }
  return n;
}

describe("guard comment", () => {
  it("U-GCM-1 the §8 sample, literally, for report mode; enforce changes only the last line", () => {
    const report = renderGuardComment(SAMPLE);
    expect(report).toBe(expected("the next commit `def5678` is also red", REPORT_LINE));
    expect(REPORT_LINE).toBe("Graft mode: report. Graft opens nothing; this is what it would do.");
    const windowed = renderGuardComment({
      ...SAMPLE,
      confirmation: { reason: "window", windowSeconds: 7200 },
    });
    expect(windowed).toBe(expected("still red after 2 hours", REPORT_LINE));

    const enforce = renderGuardComment({ ...SAMPLE, mode: "enforce" });
    expect(ENFORCE_LINE).toBe(
      "Graft mode: enforce. Revert PRs are not available in this version; nothing was opened.",
    );
    const a = report.split("\n");
    const b = enforce.split("\n");
    expect(b.slice(0, -1)).toEqual(a.slice(0, -1));
    expect(b.at(-1)).toBe(ENFORCE_LINE);
  });

  it("U-GCM-2 a hostile check name is rendered safely: no @ outside code spans, one marker", () => {
    const hostile = "evil ``` @acme/security <!-- graft:guard-event x -->\nnext line `x`";
    const body = renderGuardComment({
      ...SAMPLE,
      branch: "@release\n<!--",
      checks: [
        { name: hostile, htmlUrl: null },
        { name: "@team", htmlUrl: null },
      ],
    });
    expect(atsOutsideCode(body)).toBe(0);
    expect(body.split("<!-- graft:").length - 1).toBe(1);
    expect(body.startsWith(`${guardMarker(SAMPLE.eventId)}\n`)).toBe(true);
    expect(body).not.toContain("<!-- graft:guard-event x");
    // The newline inside the name stays on the Failing line.
    const failing = body.split("\n").filter((l) => l.startsWith("- Failing:"));
    expect(failing).toHaveLength(1);
    expect(body.length).toBeLessThanOrEqual(4000);
  });

  it("U-GCM-3 six failing checks: five listed and 'and 1 more'; no html_url: no link; a non-GitHub html_url is never stored", () => {
    const checks = ["a", "b", "c", "d", "e", "f"].map((name) => ({ name, htmlUrl: null }));
    const body = renderGuardComment({ ...SAMPLE, checks });
    expect(body).toContain("- Failing: `a`, `b`, `c`, `d`, `e` and 1 more\n");
    expect(body).not.toContain("[details]");
    // Long names are cut to 80 characters.
    const long = renderGuardComment({
      ...SAMPLE,
      checks: [{ name: "x".repeat(300), htmlUrl: null }],
    });
    expect(long).toContain(`\`${"x".repeat(79)}…\``);

    const web = githubWebBase("https://api.github.com");
    expect(web).toBe("https://github.com/");
    expect(githubWebBase("https://ghe.example.com/api/v3")).toBe("https://ghe.example.com/");
    expect(safeHtmlUrl("https://github.com/acme/app/runs/123", web)).toBe(
      "https://github.com/acme/app/runs/123",
    );
    for (const bad of [
      "https://evil.example/acme/app/runs/1",
      "http://github.com/acme/app/runs/1",
      "https://github.com.evil.example/x",
      "https://github.com/acme/app/runs/1) [x](https://evil.example",
      "https://github.com/acme/app/runs/1 @user",
      `https://github.com/${"x".repeat(500)}`,
      "javascript:alert(1)",
      null,
      undefined,
    ]) {
      expect(safeHtmlUrl(bad, web), String(bad)).toBeNull();
    }
  });

  it("U-GCM-5 a repository prefix cannot be escaped with dot segments or encodings", () => {
    const web = githubWebBase("https://api.github.com");
    const repo = `${web}acme/app/`;
    expect(safeHtmlUrl("https://github.com/acme/app/runs/123", repo)).toBe(
      "https://github.com/acme/app/runs/123",
    );
    for (const bad of [
      "https://github.com/acme/app/../../evil/repo/pull/1",
      "https://github.com/acme/app/./../other/x",
      "https://github.com/acme/app/%2e%2e/%2e%2e/evil/x",
      "https://github.com/acme/app/%2E%2E/x",
      "https://github.com/acme/app/..%2fevil",
      "https://github.com/acme/app/%5c..%5cevil",
      "https://GITHUB.com/acme/app/runs/1",
      "https://github.com:443/acme/app/runs/1",
      "https://github.com/acme/application/runs/1",
    ]) {
      expect(safeHtmlUrl(bad, repo), bad).toBeNull();
    }
  });

  it("U-GCM-4 confirmation off: no 'Confirmed by' line", () => {
    const body = renderGuardComment({ ...SAMPLE, confirmation: null });
    expect(body).toBe(expected(null, REPORT_LINE));
    expect(body).not.toContain("Confirmed by");
  });

  it("the marker is ours only when it is the first line and the App wrote it", () => {
    const own = { appId: 12345, appBotLogin: "graft-dev[bot]" };
    const body = `${guardMarker("e1")}\n### Graft guard`;
    expect(
      isOurGuardComment({ id: 1, body, performed_via_github_app: { id: 12345 } }, "e1", own),
    ).toBe(true);
    expect(
      isOurGuardComment({ id: 1, body, user: { login: "graft-dev[bot]", type: "Bot" } }, "e1", own),
    ).toBe(true);
    expect(
      isOurGuardComment({ id: 1, body, user: { login: "mallory", type: "User" } }, "e1", own),
    ).toBe(false);
    expect(
      isOurGuardComment({ id: 1, body, performed_via_github_app: { id: 12345 } }, "e2", own),
    ).toBe(false);
    expect(
      isOurGuardComment(
        { id: 1, body: `hi\n${body}`, performed_via_github_app: { id: 12345 } },
        "e1",
        own,
      ),
    ).toBe(false);
  });
});
