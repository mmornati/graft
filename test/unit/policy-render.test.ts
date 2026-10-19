import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_SECTION_CHARS, renderManagedComment } from "../../src/github/managed-comment.js";
import {
  type PolicyView,
  policyTitle,
  renderPolicyDetails,
  renderPolicySection,
  viewOutcome,
} from "../../src/modules/policy/render.js";
import type { PolicyError } from "../../src/policy/errors.js";
import {
  type ApprovalCount,
  evaluatePolicy,
  type PolicyFacts,
  type PolicyVerdict,
} from "../../src/policy/evaluate.js";
import { parsePolicyText } from "../../src/policy/parse.js";
import type { Policy } from "../../src/policy/schema.js";

const policy = (() => {
  const res = parsePolicyText(
    readFileSync(new URL("../../docs/examples/graft.yaml", import.meta.url)),
  );
  if (!res.ok) throw new Error("example invalid");
  return res.policy;
})();

const MODE_REPORT = "Graft mode: report. This check never blocks a merge.";
const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const HEAD = "ec26c3e57ca3a959ca5aad62de7213c562f8c821";
const facts = (over: Partial<PolicyFacts> = {}): PolicyFacts => ({
  files: [{ path: "src/x.ts", previousPath: null }],
  listingComplete: true,
  size: { lines: 12, files: 1 },
  risk: { value: "trivial", final: true, source: "card" },
  author: { kind: "human", agent: null },
  labels: [],
  ...over,
});
const view = (over: Partial<PolicyView> = {}): PolicyView => ({
  state: "ok",
  owner: "acme",
  baseRef: "main",
  commitSha: COMMIT,
  headSha: HEAD,
  fileSha: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
  hash: "3c1a0b2e".padEnd(64, "0"),
  policy,
  verdict: null,
  facts: null,
  approvals: null,
  errors: [],
  addsPolicyFile: false,
  mode: { effective: "report" },
  ...over,
});
const evaluated = (
  f: PolicyFacts,
  p: Policy = policy,
  approvals: ApprovalCount | null = null,
): PolicyView => view({ policy: p, facts: f, verdict: evaluatePolicy(p, f), approvals });

const E3 = () =>
  evaluated(
    facts({
      files: [{ path: "infra/main.tf", previousPath: null }],
      risk: { value: "sensitive", final: true, source: "card" },
      author: { kind: "agent", agent: "claude-code" },
    }),
    policy,
    { current: 1, stale: 1, users: ["alice"], truncated: false },
  );
const E4 = () =>
  evaluated(
    facts({
      files: [{ path: "secrets/prod.env", previousPath: null }],
      risk: { value: "sensitive", final: true, source: "card" },
      author: { kind: "agent", agent: "claude-code" },
    }),
  );
const E1 = () => evaluated(facts({ files: [{ path: "docs/a.md", previousPath: null }] }));

const FOOTER = "Graft only reports in Phase 0; it approves and blocks nothing.";

describe("policy rendering", () => {
  it("U-PR-1 a would_require section, byte for byte", () => {
    expect(renderPolicySection(E3())).toBe(
      [
        "### Policy",
        "",
        "**Would require 2 humans (1 from `@acme/security`)** · report only",
        "",
        "- Rule 3 infra-and-auth: paths match `infra/main.tf`",
        "- Rule 4 agent-sensitive: risk `sensitive` (card), author agent `claude-code`",
        "",
        "**Approvals so far:** 1 on this head (`alice`), 1 on an older commit. Team membership is not checked in Phase 0.",
        "",
        `Policy \`graft.yaml\` on \`main\` at \`a1b2c3d\` · head \`ec26c3e\` · ${FOOTER}`,
      ].join("\n"),
    );
    expect(renderPolicyDetails(E3())).toBe(
      [
        MODE_REPORT,
        "",
        "**Matched rules**",
        "",
        "- Rule 3 infra-and-auth → require 1 from `@acme/security`: paths match `infra/main.tf`",
        "- Rule 4 agent-sensitive → require 2: risk `sensitive` (card), author agent `claude-code`",
        "",
        "**Facts used**",
        "",
        "- Risk `sensitive` from the card (final)",
        "- Author agent `claude-code` (provenance for head `ec26c3e`)",
        "- 1 file changed, 12 lines; file list complete",
        "- Labels: none",
        "- Policy file SHA `9f8e7d6`, policy hash `3c1a0b2e`",
        "",
        "6 other rules did not match.",
      ].join("\n"),
    );
  });

  it("U-PR-2 would_block, would_approve, policy_invalid, no_policy and the adds-graft.yaml note", () => {
    expect(renderPolicySection(E4())).toBe(
      [
        "### Policy",
        "",
        "**Would block: rule 5** · report only",
        "",
        "- Rule 4 agent-sensitive: risk `sensitive` (card), author agent `claude-code` (overridden)",
        "- Rule 5 no-agent-secrets: paths match `secrets/prod.env`, author agent `claude-code`",
        "",
        `Policy \`graft.yaml\` on \`main\` at \`a1b2c3d\` · head \`ec26c3e\` · ${FOOTER}`,
      ].join("\n"),
    );

    expect(renderPolicySection(E1())).toBe(
      [
        "### Policy",
        "",
        "**Would auto-approve** · report only",
        "",
        "- Rule 1 docs-only: risk `trivial` (card), all 1 paths match",
        "- Rule 2 trivial: risk `trivial` (card)",
        "",
        `Policy \`graft.yaml\` on \`main\` at \`a1b2c3d\` · head \`ec26c3e\` · ${FOOTER}`,
      ].join("\n"),
    );
    // With approvals the line appears for would_approve too.
    const withApproval = {
      ...E1(),
      approvals: { current: 2, stale: 0, users: ["a", "b"], truncated: true },
    };
    expect(renderPolicySection(withApproval)).toContain(
      "**Approvals so far:** 2 on this head (`a` and `b`) (first 300 reviews). Team membership is not checked in Phase 0.",
    );

    const errors: PolicyError[] = [
      { code: "glob_invalid", location: "rules[2].match.paths[1]", line: 12, column: 9, detail: 3 },
      { code: "unknown_key", location: "rules[3]", line: 20, column: 3, key: "aprove" },
    ];
    const invalid = view({ state: "invalid", policy: null, errors });
    expect(renderPolicySection(invalid)).toBe(
      [
        "### Policy",
        "",
        "**Policy invalid: no decision (2 errors)** · report only",
        "",
        "`graft.yaml` on `main` at `a1b2c3d` cannot be used, so Graft would not auto-approve anything:",
        "",
        "- line 12, column 9, rules\\[2\\].match.paths\\[1\\]: Invalid glob: .. or empty segment. (glob\\_invalid)",
        "- line 20, column 3, rules\\[3\\]: Unknown key `aprove`. (unknown\\_key)",
        "",
        "Fix the file on `main`, and check it locally with `pnpm graft policy check graft.yaml`.",
        "",
        `Head \`ec26c3e\` · ${FOOTER}`,
      ].join("\n"),
    );

    const missing = view({ state: "missing", policy: null, fileSha: null, hash: null });
    const noPolicy = [
      "### Policy",
      "",
      "**No policy** · report only",
      "",
      "There is no `graft.yaml` on `main` at `a1b2c3d`. Add one to report what Graft would require; see the graft.yaml reference in the Graft docs.",
      "",
    ];
    expect(renderPolicySection(missing)).toBe(
      [...noPolicy, `Head \`ec26c3e\` · ${FOOTER}`].join("\n"),
    );
    expect(renderPolicySection({ ...missing, addsPolicyFile: true })).toBe(
      [
        ...noPolicy,
        "> [!IMPORTANT]",
        "> This pull request adds `graft.yaml`. It takes effect after merge; until then there is no policy.",
        "",
        `Head \`ec26c3e\` · ${FOOTER}`,
      ].join("\n"),
    );
    // Without details the text is the mode line alone.
    expect(renderPolicyDetails(missing)).toBe(MODE_REPORT);
    expect(renderPolicyDetails(invalid)).toBe(MODE_REPORT);
  });

  it("U-PR-3 titles, every form", () => {
    expect(policyTitle(E1())).toBe("Would auto-approve");
    expect(policyTitle(E3())).toBe("Would require 2 humans (1 from @acme/security)");
    expect(policyTitle(E4())).toBe("Would block: rule 5");
    const oneTeam = evaluated(
      facts({
        files: [{ path: "infra/main.tf", previousPath: null }],
        risk: { value: "logic", final: true, source: "card" },
      }),
    );
    expect(policyTitle(oneTeam)).toBe("Would require 1 human from @acme/security");
    const preview = evaluated(
      facts({
        author: { kind: "agent", agent: "codex-preview" },
        risk: { value: "logic", final: true, source: "card" },
      }),
    );
    expect(policyTitle(preview)).toBe(
      "Would require 1 human from @acme/platform or @acme/security",
    );
    const dflt = evaluated(facts({ risk: { value: "logic", final: true, source: "card" } }));
    expect(policyTitle(dflt)).toBe("Would require 1 human (default)");
    const provisional = evaluated(
      facts({ risk: { value: "logic", final: false, source: "card_pending" } }),
    );
    expect(policyTitle(provisional)).toBe("Would require 1 human (default) · risk provisional");
    // Not for a block, which does not depend on the card.
    const blockProvisional = evaluated(
      facts({
        files: [{ path: "secrets/x", previousPath: null }],
        risk: { value: "logic", final: false, source: "card_pending" },
        author: { kind: "agent", agent: "a" },
      }),
    );
    expect(policyTitle(blockProvisional)).toBe("Would block: rule 5");
    const twoBlocks = evaluated(
      facts({
        files: [{ path: "secrets/x", previousPath: null }],
        author: { kind: "agent", agent: "a" },
      }),
      {
        ...policy,
        rules: [
          ...policy.rules,
          { index: 9, name: null, match: { paths: ["secrets/**"] }, action: { kind: "block" } },
        ],
      },
    );
    expect(policyTitle(twoBlocks)).toBe("Would block: rules 5, 9");
    const mixed = evaluated(
      facts({
        files: [{ path: "docs/a.md", previousPath: null }],
        labels: ["hotfix"],
        risk: { value: "sensitive", final: true, source: "card" },
        author: { kind: "agent", agent: "x" },
      }),
    );
    expect(policyTitle(mixed)).toBe("Would require 2 humans (1 from @acme/oncall)");

    expect(
      policyTitle(
        view({
          state: "invalid",
          errors: [{ code: "yaml_syntax", location: null, line: 1, column: 1 }],
        }),
      ),
    ).toBe("Policy invalid: no decision (1 error)");
    expect(
      policyTitle(
        view({
          state: "invalid",
          errors: Array.from({ length: 3 }, () => ({
            code: "yaml_syntax" as const,
            location: null,
            line: 1,
            column: 1,
          })),
        }),
      ),
    ).toBe("Policy invalid: no decision (3 errors)");
    expect(policyTitle(view({ state: "missing" }))).toBe("No graft.yaml on main");
    expect(policyTitle(view({ state: "missing", baseRef: "b".repeat(150) }))).toBe(
      `No graft.yaml on ${"b".repeat(100)}`,
    );
    // The 200-character cut.
    const teams = Array.from({ length: 10 }, (_, i) => `team-with-a-long-name-${i}`);
    const long: Policy = {
      ...policy,
      rules: [
        {
          index: 1,
          name: null,
          match: { risk: ["trivial"] },
          action: { kind: "require", humans: 1, teams },
        },
        {
          index: 2,
          name: null,
          match: { risk: ["trivial"] },
          action: { kind: "require", humans: 2, teams: ["x"] },
        },
      ],
    };
    const t = policyTitle(evaluated(facts(), long));
    expect(Array.from(t)).toHaveLength(200);
    expect(t.endsWith("…")).toBe(true);
    expect(viewOutcome(view({ state: "missing" }))).toBe("no_policy");
    expect(viewOutcome(view({ state: "invalid" }))).toBe("policy_invalid");
  });

  it("U-PR-4 a team is always inside a code span: no @ outside backticks", () => {
    const views = [
      E3(),
      E4(),
      evaluated(
        facts({
          author: { kind: "agent", agent: "codex-preview" },
          risk: { value: "logic", final: false, source: "card_pending" },
        }),
      ),
      evaluated(facts({ labels: ["hotfix"] })),
    ];
    for (const v of views) {
      for (const text of [renderPolicySection(v), renderPolicyDetails(v)]) {
        const outside = text.replace(/`[^`]*`/g, "");
        expect(outside).not.toContain("@");
      }
    }
    expect(renderPolicySection(views[2] as PolicyView)).toContain(
      "`@acme/platform` or `@acme/security`",
    );
  });

  it("U-PR-5 a hostile rule name is escaped: no comment, no link, no mention", () => {
    const hostile = "**x** <!-- graft: @everyone [l](http://e)";
    const p: Policy = {
      ...policy,
      rules: [
        {
          index: 1,
          name: hostile,
          match: { risk: ["trivial"] },
          action: { kind: "require", humans: 1, teams: ["sec"] },
        },
      ],
    };
    const v = evaluated(facts(), p);
    for (const text of [renderPolicySection(v), renderPolicyDetails(v)]) {
      expect(text).not.toContain("<!--");
      expect(text).not.toContain("<!-- graft:");
      expect(text).not.toMatch(/\]\(http/);
      expect(text).not.toMatch(/@everyone/);
      expect(text).not.toMatch(/(^|[^\\])\*\*x/);
    }
    // The managed comment accepts the section.
    expect(() => renderManagedComment(new Map([["policy", renderPolicySection(v)]]))).not.toThrow();
  });

  it("U-PR-6 a path with a backtick and a comment opener goes through codeSpan", () => {
    const path = "src/`evil`<!--x.ts";
    const v = evaluated(facts({ files: [{ path, previousPath: null }] }), {
      ...policy,
      rules: [{ index: 1, name: null, match: { paths: ["src/**"] }, action: { kind: "block" } }],
    });
    const text = renderPolicySection(v);
    expect(text).not.toContain("<!--");
    expect(text).toContain("paths match `` src/`evil`<\u2060!--x.ts ``");
  });

  it("U-PR-7 a 200-rule match keeps the section within the limit with 'and K more rules'", () => {
    const rules: Policy["rules"] = Array.from({ length: 200 }, (_, i) => ({
      index: i + 1,
      name: `rule-${i}-${"n".repeat(70)}`,
      match: { paths: ["**"] },
      action: { kind: "require" as const, humans: 1, teams: [] },
    }));
    const p: Policy = { ...policy, rules };
    const manyPaths = Array.from(
      { length: 30 },
      (_, i) => `dir/some/long/path/segment/file-${i}.ts`,
    ).map((path) => ({ path, previousPath: null }));
    const v = evaluated(
      facts({
        files: manyPaths,
        risk: { value: "logic", final: false, source: "card_pending" },
        author: { kind: "agent", agent: "claude-code" },
      }),
      p,
      { current: 1, stale: 0, users: ["alice"], truncated: false },
    );
    const text = renderPolicySection(v);
    expect(text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    expect(text).toMatch(/- and \d+ more rules\n/);
    expect(text).toContain("[!NOTE]");
    expect(text).toContain("**Approvals so far:**");
    expect(text).toContain("· report only");
    expect(text).toContain("Policy `graft.yaml` on `main`");
    expect(() => renderManagedComment(new Map([["policy", text]]))).not.toThrow();
    // Few rules: nothing is cut.
    expect(renderPolicySection(E3())).not.toContain("more rules");
  });

  it("U-PR-8 the invalid list is capped at 20 errors; the unknown key is a code span", () => {
    const errors: PolicyError[] = Array.from({ length: 27 }, (_, i) => ({
      code: "unknown_key" as const,
      location: `rules[${i + 1}]`,
      line: i + 1,
      column: 3,
      key: i === 0 ? "bad`key" : `k${i}`,
    }));
    const text = renderPolicySection(view({ state: "invalid", policy: null, errors }));
    const listed = text.split("\n").filter((l) => l.startsWith("- "));
    expect(listed).toHaveLength(21);
    expect(listed[20]).toBe("- and 7 more");
    expect(listed[0]).toBe(
      "- line 1, column 3, rules\\[1\\]: Unknown key `` bad`key ``. (unknown\\_key)",
    );
    expect(listed[1]).toContain("Unknown key `k1`.");
    expect(text).toContain("(27 errors)");
  });

  it("U-PR-9 the IMPORTANT and NOTE blocks appear exactly when expected", () => {
    const important =
      "> [!IMPORTANT]\n> This pull request changes `graft.yaml`. Its version is ignored: the policy on `main` applies, and the change needs at least 1 human.";
    const note =
      "> [!NOTE]\n> The intent card for this head is not ready, so the risk used is at least `logic` and rules that depend on it are applied conservatively. Graft re-evaluates when the card is published.";
    const edit = evaluated(facts({ files: [{ path: "graft.yaml", previousPath: null }] }));
    expect(renderPolicySection(edit)).toContain(important);
    expect(renderPolicySection(edit)).not.toContain("[!NOTE]");
    expect(renderPolicySection(E3())).not.toContain("[!IMPORTANT]");
    expect(renderPolicySection(E3())).not.toContain("[!NOTE]");
    const provisional = evaluated(
      facts({ risk: { value: "logic", final: false, source: "card_pending" } }),
    );
    expect(renderPolicySection(provisional)).toContain(note);
    expect(renderPolicySection(provisional)).not.toContain("[!IMPORTANT]");
    const both = evaluated(
      facts({
        files: [{ path: "graft.yaml", previousPath: null }],
        risk: { value: "logic", final: false, source: "card_pending" },
      }),
    );
    const text = renderPolicySection(both);
    expect(text.indexOf(important)).toBeGreaterThan(-1);
    expect(text.indexOf(note)).toBeGreaterThan(text.indexOf(important));
    // The blocks sit between the bullets and the footer, each in its own paragraph.
    expect(text).toContain(`${important}\n\n${note}\n\nPolicy \`graft.yaml\``);
    // A block is "report only" too: the headline is unchanged.
    const blockEdit = evaluated(
      facts({
        files: [{ path: "secrets/x", previousPath: "graft.yaml" }],
        author: { kind: "agent", agent: "a" },
      }),
    );
    expect(renderPolicySection(blockEdit)).toContain(important);
    expect((blockEdit.verdict as PolicyVerdict).outcome).toBe("would_block");
  });

  it("U-PR-10 path_too_long and budget_exhausted are rendered, and path_too_long is not a graft.yaml change", () => {
    const longPath = `${"d/".repeat(600)}x`;
    const tooLong = renderPolicySection(
      evaluated(facts({ files: [{ path: longPath, previousPath: null }] })),
    );
    expect(tooLong).toContain("`path_too_long`");
    expect(tooLong).not.toContain("changes `graft.yaml`");
    const g = `*${"a".repeat(44)}b?x*`;
    const hostile = parsePolicyText(
      new TextEncoder().encode(
        `version: 1\nrules:\n${Array.from({ length: 150 }, () => `  - match: { paths: ['${g}', '${g.replace("?x", "?y")}'] }\n    require: { humans: 1 }\n`).join("")}`,
      ),
    );
    if (!hostile.ok) throw new Error("invalid");
    const files = Array.from({ length: 1_000 }, (_, i) => ({
      path: `${"a".repeat(1_000)}b${String(i).padStart(23, "0")}`,
      previousPath: null,
    }));
    const spent = renderPolicySection(evaluated(facts({ files }), hostile.policy));
    expect(spent).toContain("`budget_exhausted`");
    expect(renderPolicySection(E1())).not.toContain("budget_exhausted");
  });
});
