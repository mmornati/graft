/**
 * Phase 1 step 3: break-glass, the pure parts (spec §10, U-BG-3 and U-BG-4). U-BG-1 and U-BG-2
 * are in policy-enforce.test.ts, next to the U-ENF cases they extend.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { type BreakGlassFacts, isBreakGlassLabel } from "../../src/modules/policy/break-glass.js";
import { breakGlassHashTerm, policyFactsHash } from "../../src/modules/policy/job.js";
import {
  type BreakGlassView,
  type PolicyView,
  policyTitle,
  renderPolicyDetails,
  renderPolicySection,
} from "../../src/modules/policy/render.js";
import { type ApproverFacts, enforcedConclusion } from "../../src/policy/enforce.js";
import { evaluatePolicy, type PolicyFacts } from "../../src/policy/evaluate.js";
import { parsePolicyText } from "../../src/policy/parse.js";
import { TEST_PRIVATE_KEY, TEST_WEBHOOK_SECRET } from "../helpers/config.js";

const env = (label?: string) => ({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://x:y@localhost:5432/z",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
  GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  ...(label === undefined ? {} : { GRAFT_BREAK_GLASS_LABEL: label }),
});

const policy = (() => {
  const res = parsePolicyText(
    readFileSync(new URL("../../docs/examples/graft.yaml", import.meta.url)),
  );
  if (!res.ok) throw new Error("example invalid");
  return res.policy;
})();

const HEAD = "ec26c3e57ca3a959ca5aad62de7213c562f8c821";
const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const NO_APPROVERS: ApproverFacts = {
  counted: [],
  notCounted: [],
  changesRequestedBy: [],
  teams: {},
  reviewsTruncated: false,
};
/** E3 of Phase 0 step 5: would_require, here with no approval (normally `failure`). */
const facts: PolicyFacts = {
  files: [{ path: "infra/main.tf", previousPath: null }],
  listingComplete: true,
  size: { lines: 12, files: 1 },
  risk: { value: "sensitive", final: true, source: "card" },
  author: { kind: "agent", agent: "claude-code" },
  labels: ["graft:break-glass"],
};

function view(
  mode: "report" | "enforce",
  breakGlass: BreakGlassView | null,
  state: PolicyView["state"] = "ok",
): PolicyView {
  const verdict = state === "ok" ? evaluatePolicy(policy, facts) : null;
  const enforced = enforcedConclusion({
    state,
    verdict,
    approvers: state === "ok" ? NO_APPROVERS : null,
    cardWait: false,
    breakGlass: breakGlass?.state === "applied" ? { applied: true } : null,
  });
  return {
    state,
    owner: "acme",
    baseRef: "main",
    commitSha: COMMIT,
    headSha: HEAD,
    fileSha: state === "ok" ? "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432" : null,
    hash: state === "ok" ? "3c1a0b2e".padEnd(64, "0") : null,
    policy: state === "ok" ? policy : null,
    verdict,
    facts: state === "ok" ? facts : null,
    approvals:
      state === "ok"
        ? {
            current: 0,
            stale: 0,
            users: [],
            truncated: false,
            currentApprovers: [],
            changesRequested: [],
          }
        : null,
    errors: [],
    addsPolicyFile: false,
    mode: { effective: mode },
    enforced,
    approvers: state === "ok" ? NO_APPROVERS : null,
    breakGlass,
  };
}

const applied = (over: Partial<Extract<BreakGlassView, { state: "applied" }>> = {}) =>
  ({
    state: "applied",
    login: "alice",
    role: "maintain",
    headSha: HEAD,
    self: false,
    labelEventAt: new Date("2026-10-14T11:05:00Z"),
    ...over,
  }) as const;
const ignored = (
  reason: Extract<BreakGlassView, { state: "ignored" }>["reason"],
  login: string | null = "bob",
  role: string | null = null,
): BreakGlassView => ({
  state: "ignored",
  reason,
  login,
  role,
  self: false,
  labelEventAt: new Date("2026-10-14T11:05:00Z"),
});

/** The section's paragraphs: heading, headline, then the break-glass line (when there is one). */
const paragraphs = (s: string): string[] => s.split("\n\n");

/** Every `@` that is not inside a code span. */
function strayAts(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/`[^`]*`/g, ""))
    .filter((line) => line.includes("@"));
}

describe("break-glass label (D1, U-BG-3)", () => {
  it("U-BG-3 matched case-insensitively; off disables; a 51-character name is rejected by config", () => {
    expect(loadConfig(env()).breakGlassLabel).toBe("graft:break-glass");
    expect(isBreakGlassLabel("graft:break-glass", "graft:break-glass")).toBe(true);
    expect(isBreakGlassLabel("graft:break-glass", "Graft:Break-Glass")).toBe(true);
    expect(isBreakGlassLabel("Emergency", "EMERGENCY")).toBe(true);
    expect(isBreakGlassLabel("graft:break-glass", "graft:break-glass ")).toBe(false);
    expect(isBreakGlassLabel("graft:break-glass", "break-glass")).toBe(false);

    // off (any case) disables the feature: the label is an ordinary label.
    for (const off of ["off", "OFF", "Off"]) {
      const label = loadConfig(env(off)).breakGlassLabel;
      expect(label, off).toBeNull();
      expect(isBreakGlassLabel(label, "graft:break-glass")).toBe(false);
      expect(isBreakGlassLabel(label, "off")).toBe(false);
    }

    expect(loadConfig(env("x".repeat(50))).breakGlassLabel).toBe("x".repeat(50));
    expect(loadConfig(env("urgence ⚠️")).breakGlassLabel).toBe("urgence ⚠️");
    for (const bad of ["x".repeat(51), " padded", "tab\there", "line\nbreak"]) {
      expect(() => loadConfig(env(bad)), JSON.stringify(bad)).toThrow(/GRAFT_BREAK_GLASS_LABEL/);
    }
    // Empty means unset: the default.
    expect(loadConfig(env("")).breakGlassLabel).toBe("graft:break-glass");
  });
});

describe("break-glass rendering (§7, U-BG-4)", () => {
  it("U-BG-4 each §7 line; logins are code spans; no @ outside code spans; enforce title; report would-be line", () => {
    // applied, enforce
    const enforce = view("enforce", applied());
    const section = renderPolicySection(enforce);
    expect(paragraphs(section)[1]).toBe("**Bypassed by break-glass (`alice`)**");
    expect(paragraphs(section)[2]).toBe(
      "**Break-glass** by `alice` (maintain) on `ec26c3e`: this check passes for this commit only. A new push needs the label again.",
    );
    expect(policyTitle(enforce)).toBe("Bypassed by break-glass (alice)");
    expect(section).not.toContain("In enforce mode this check would be");

    // applied, report: the title does not change, the line says "would bypass".
    const report = view("report", applied());
    const reportSection = renderPolicySection(report);
    expect(policyTitle(report)).toBe(policyTitle(view("report", null)));
    expect(paragraphs(reportSection)[1]).toMatch(/ · report only\*?$/);
    expect(paragraphs(reportSection)[2]).toBe(
      "**Break-glass** by `alice` (maintain) on `ec26c3e`: Graft would bypass the policy for this commit (report mode). A new push needs the label again.",
    );
    expect(paragraphs(reportSection)[3]).toBe(
      "**In enforce mode this check would be:** `success` (break-glass by `alice`).",
    );

    // self-use
    expect(paragraphs(renderPolicySection(view("enforce", applied({ self: true }))))[2]).toBe(
      "**Break-glass** by `alice` (maintain) on `ec26c3e` (on their own pull request): this check passes for this commit only. A new push needs the label again.",
    );

    // ignored, for each reason
    const ignoredLines: [BreakGlassView, string][] = [
      [
        ignored("role_too_low", "bob", "triage"),
        "**Break-glass label ignored:** applied by `bob` (triage). Only maintain or admin can bypass the policy.",
      ],
      [
        ignored("bot", "deploy-bot[bot]"),
        "**Break-glass label ignored:** applied by `deploy-bot[bot]` (a bot). Only maintain or admin can bypass the policy.",
      ],
      [
        ignored("role_unverified", "bob"),
        "**Break-glass label ignored:** applied by `bob` (role could not be verified). Only maintain or admin can bypass the policy.",
      ],
      [
        ignored("actor_unknown", null),
        "**Break-glass label ignored:** applied by someone (who applied it could not be determined). Only maintain or admin can bypass the policy.",
      ],
    ];
    for (const [bg, line] of ignoredLines) {
      for (const mode of ["report", "enforce"] as const) {
        const v = view(mode, bg);
        expect(paragraphs(renderPolicySection(v))[2], `${mode} ${line}`).toBe(line);
        // Not applied: the normal conclusion stands.
        expect(v.enforced?.reason).toBe("approvals_missing");
      }
    }

    // stale
    expect(paragraphs(renderPolicySection(view("enforce", { state: "stale" })))[2]).toBe(
      "**Break-glass not applied:** the pull request changed after the label was added. Remove and re-apply the label.",
    );

    // removed (or none): no line, the section is the normal one.
    expect(renderPolicySection(view("enforce", null))).not.toContain("Break-glass");
    expect(renderPolicyDetails(view("enforce", null))).not.toContain("Break-glass");

    // A missing or invalid policy is bypassed too, and the line is in those sections as well.
    for (const state of ["missing", "invalid"] as const) {
      const v = view("enforce", applied(), state);
      expect(v.enforced?.reason).toBe("break_glass");
      expect(policyTitle(v)).toBe("Bypassed by break-glass (alice)");
      expect(paragraphs(renderPolicySection(v))[2]).toMatch(/^\*\*Break-glass\*\* by `alice`/);
      expect(renderPolicyDetails(v)).toContain("**Break-glass**");
    }

    // Details: the block first, then the normal verdict and approvals that were bypassed.
    const details = renderPolicyDetails(enforce);
    expect(details).toContain("**Break-glass**");
    expect(details).toContain("- Applied by `alice` (maintain)");
    expect(details).toContain("- Commit `ec26c3e` only; a new push ends it");
    expect(details).toContain("- Label added at 2026-10-14T11:05:00.000Z");
    expect(details.indexOf("**Break-glass**")).toBeLessThan(details.indexOf("**Matched rules**"));
    expect(details).toContain("**Facts used**");
    expect(renderPolicyDetails(view("enforce", applied({ self: true })))).toContain(
      "- Applied by `alice` (maintain), on their own pull request",
    );

    // Logins are always code spans: no mention anywhere, even with an @-looking login.
    const sneaky = applied({ login: "@acme/security" });
    for (const v of [
      view("enforce", sneaky),
      view("report", sneaky),
      view("report", ignored("role_too_low", "@acme/security", "triage")),
    ]) {
      expect(strayAts(renderPolicySection(v)), "section").toEqual([]);
      expect(strayAts(renderPolicyDetails(v)), "details").toEqual([]);
    }
  });

  it("U-BG-4b the facts hash changes with the break-glass term alone (D10)", () => {
    const base = {
      verdict: null,
      approvals: null,
      policyStatus: "ok",
      policyFileSha: null,
      policyHash: null,
      errors: [],
      headSha: HEAD,
      baseRef: "main",
      commitSha: COMMIT,
      policyMode: "enforce",
      enforced: { conclusion: "success" as const, reason: "break_glass" as const, constraints: [] },
      published: {
        status: "completed" as const,
        conclusion: "success" as const,
        stored: "success" as const,
      },
      rendered: { title: "t", summary: "s", details: "d" },
    };
    const terms = [
      breakGlassHashTerm({ state: "none" }, HEAD),
      breakGlassHashTerm({ state: "stale", record: true }, HEAD),
      breakGlassHashTerm(
        {
          state: "applied",
          record: true,
          actor: { id: 1, login: "alice" },
          role: "maintain",
          self: false,
          headSha: HEAD,
          labelEventAt: null,
          labelEventId: 9,
        },
        HEAD,
      ),
      breakGlassHashTerm(
        {
          state: "ignored",
          record: true,
          reason: "role_too_low",
          actor: { id: 2, login: "bob" },
          role: "triage",
          self: false,
          labelEventAt: null,
        },
        HEAD,
      ),
    ];
    const hashes = new Set(terms.map((breakGlass) => policyFactsHash({ ...base, breakGlass })));
    expect(hashes.size).toBe(terms.length);
    // A bypass that ended (a `removed` row, review 1) is the same as no break-glass at all.
    const ended: BreakGlassFacts = {
      state: "none",
      revoke: { headSha: HEAD, actor: null, labelEventAt: null },
    };
    expect(breakGlassHashTerm(ended, HEAD)).toEqual(terms[0]);
  });
});
