import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVALUATION_FUEL, GlobBudget } from "../../src/core/glob.js";
import { computeRiskFloor } from "../../src/modules/intent/risk-floor.js";
import {
  countApprovals,
  type EffectiveRisk,
  evaluatePolicy,
  type MatchedRule,
  type MatchKey,
  type MatchReason,
  type PolicyFacts,
  type ReviewLike,
} from "../../src/policy/evaluate.js";
import { parsePolicyText } from "../../src/policy/parse.js";
import type { Policy, PolicyRule } from "../../src/policy/schema.js";

function parsed(src: string | Uint8Array): Policy {
  const res = parsePolicyText(typeof src === "string" ? new TextEncoder().encode(src) : src);
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.policy;
}
const EXAMPLE = parsed(readFileSync(new URL("../../docs/examples/graft.yaml", import.meta.url)));

const facts = (over: Partial<PolicyFacts> = {}): PolicyFacts => ({
  files: [{ path: "src/x.ts", previousPath: null }],
  listingComplete: true,
  size: { lines: 12, files: 1 },
  risk: { value: "trivial", final: true, source: "card" },
  author: { kind: "human", agent: null },
  labels: [],
  ...over,
});
const files = (...paths: string[]) => paths.map((path) => ({ path, previousPath: null }));
const card = (value: "trivial" | "logic" | "sensitive"): PolicyFacts["risk"] => ({
  value,
  final: true,
  source: "card",
});
const pending = (value: "trivial" | "logic" | "sensitive"): PolicyFacts["risk"] => ({
  value,
  final: false,
  source: "card_pending",
});
const agent = (name: string | null = "claude-code"): PolicyFacts["author"] => ({
  kind: "agent",
  agent: name,
});

const reason = (
  key: MatchKey,
  o: { uncertain?: boolean; paths?: string[]; count?: number } = {},
): MatchReason => ({
  key,
  uncertain: o.uncertain ?? false,
  paths: o.paths ?? [],
  count: o.count ?? o.paths?.length ?? 0,
});
const matchedRule = (
  index: number,
  action: MatchedRule["action"],
  reasons: MatchReason[],
  overridden = false,
): MatchedRule => ({ index, action, reasons, overridden });
const eff = (
  value: EffectiveRisk["value"],
  o: Partial<Omit<EffectiveRisk, "value">> = {},
): EffectiveRisk => ({ final: true, source: "card", raisedBy: [], ...o, value });

describe("policy evaluation (spec §9.3)", () => {
  it("U-PE-1 E1: a docs-only trivial change by a human is auto-approved by rules 1 and 2", () => {
    const v = evaluatePolicy(EXAMPLE, facts({ files: files("docs/a.md"), risk: card("trivial") }));
    expect(v).toEqual({
      outcome: "would_approve",
      matched: [
        matchedRule(1, "approve", [reason("risk"), reason("only_paths", { count: 1 })]),
        matchedRule(2, "approve", [reason("risk")]),
      ],
      effectiveRisk: eff("trivial"),
      policyFileChanged: false,
    });
  });

  it("U-PE-2 E2: a trivial change by an agent is auto-approved by rule 2", () => {
    const v = evaluatePolicy(EXAMPLE, facts({ author: agent(), risk: card("trivial") }));
    expect(v).toEqual({
      outcome: "would_approve",
      matched: [matchedRule(2, "approve", [reason("risk")])],
      effectiveRisk: eff("trivial"),
      policyFileChanged: false,
    });
  });

  it("U-PE-3 E3: infra by an agent needs a security approval and a second human", () => {
    const v = evaluatePolicy(
      EXAMPLE,
      facts({ files: files("infra/main.tf"), risk: card("sensitive"), author: agent() }),
    );
    expect(v).toEqual({
      outcome: "would_require",
      matched: [
        matchedRule(3, "require", [reason("paths", { paths: ["infra/main.tf"] })]),
        matchedRule(4, "require", [reason("risk"), reason("author")]),
      ],
      effectiveRisk: eff("sensitive"),
      policyFileChanged: false,
      humans: 2,
      constraints: [
        { humans: 1, teams: ["security"], rules: [3] },
        { humans: 2, teams: [], rules: [4] },
      ],
      usedDefault: false,
      builtIn: null,
    });
  });

  it("U-PE-4 E4: a block wins and overrides the rule it ran with", () => {
    const v = evaluatePolicy(
      EXAMPLE,
      facts({ files: files("secrets/prod.env"), risk: card("sensitive"), author: agent() }),
    );
    expect(v).toEqual({
      outcome: "would_block",
      matched: [
        matchedRule(4, "require", [reason("risk"), reason("author")], true),
        matchedRule(5, "block", [
          reason("paths", { paths: ["secrets/prod.env"] }),
          reason("author"),
        ]),
      ],
      effectiveRisk: eff("sensitive"),
      policyFileChanged: false,
      blockedBy: [5],
    });
  });

  it("U-PE-5 E5: a pending card raises the unknowns, and the rule that depends on risk is uncertain", () => {
    const v = evaluatePolicy(EXAMPLE, facts({ author: agent(), risk: pending("logic") }));
    expect(v).toEqual({
      outcome: "would_require",
      matched: [matchedRule(4, "require", [reason("risk", { uncertain: true }), reason("author")])],
      effectiveRisk: eff("logic", { final: false, source: "card_pending" }),
      policyFileChanged: false,
      humans: 2,
      constraints: [{ humans: 2, teams: [], rules: [4] }],
      usedDefault: false,
      builtIn: null,
    });
  });

  it("U-PE-6 E6: sensitive_paths raise the risk to sensitive", () => {
    const v = evaluatePolicy(
      EXAMPLE,
      facts({ files: files("services/billing/pay.ts"), risk: card("logic"), author: agent() }),
    );
    expect(v).toEqual({
      outcome: "would_require",
      matched: [matchedRule(4, "require", [reason("risk"), reason("author")])],
      effectiveRisk: eff("sensitive", { raisedBy: ["sensitive_paths"] }),
      policyFileChanged: false,
      humans: 2,
      constraints: [{ humans: 2, teams: [], rules: [4] }],
      usedDefault: false,
      builtIn: null,
    });
  });

  it("U-PE-7 E7: a PR that edits graft.yaml is never auto-approved and falls to the default", () => {
    const v = evaluatePolicy(EXAMPLE, facts({ files: files("graft.yaml"), risk: card("trivial") }));
    expect(v).toEqual({
      outcome: "would_require",
      matched: [],
      effectiveRisk: eff("sensitive", { raisedBy: ["policy_file"] }),
      policyFileChanged: true,
      humans: 1,
      constraints: [{ humans: 1, teams: [], rules: [] }],
      usedDefault: true,
      builtIn: "policy_file_changed",
    });
    // The same edit with a rule that would approve it: the built-in rule overrides.
    const trivialOnly = parsed(
      "version: 1\nrules:\n  - match: { only_paths: ['**'] }\n    approve: auto\n",
    );
    const w = evaluatePolicy(
      trivialOnly,
      facts({ files: files("graft.yaml"), risk: card("trivial") }),
    );
    expect(w).toMatchObject({
      outcome: "would_require",
      humans: 1,
      constraints: [{ humans: 1, teams: [], rules: [0] }],
      usedDefault: false,
      builtIn: "policy_file_changed",
      policyFileChanged: true,
    });
    expect(w.matched.every((m) => m.overridden)).toBe(true);
    // Moves and the other policy file locations count too.
    for (const f of [
      { path: "x.txt", previousPath: "graft.yaml" },
      { path: "graft.yml", previousPath: null },
      { path: ".graft/extra.yaml", previousPath: null },
    ]) {
      expect(evaluatePolicy(EXAMPLE, facts({ files: [f] })).policyFileChanged, f.path).toBe(true);
    }
    expect(
      evaluatePolicy(EXAMPLE, facts({ files: files("sub/graft.yaml") })).policyFileChanged,
    ).toBe(false);
  });

  it("U-PE-8 E8: an unknown author counts as matched in tightening rules, and the block still wins", () => {
    const v = evaluatePolicy(
      EXAMPLE,
      facts({
        files: files("secrets/x"),
        risk: card("sensitive"),
        author: { kind: "unknown", agent: null },
      }),
    );
    expect(v).toEqual({
      outcome: "would_block",
      matched: [
        matchedRule(4, "require", [reason("risk"), reason("author", { uncertain: true })], true),
        matchedRule(5, "block", [
          reason("paths", { paths: ["secrets/x"] }),
          reason("author", { uncertain: true }),
        ]),
        matchedRule(7, "require", [reason("agent", { uncertain: true })], true),
      ],
      effectiveRisk: eff("sensitive"),
      policyFileChanged: false,
      blockedBy: [5],
    });
  });

  it("U-PE-9 E9: a label beats an approve (labels are matched case-insensitively)", () => {
    const v = evaluatePolicy(EXAMPLE, facts({ labels: ["HotFix"] }));
    expect(v).toEqual({
      outcome: "would_require",
      matched: [
        matchedRule(2, "approve", [reason("risk")], true),
        matchedRule(8, "require", [reason("labels", { paths: ["HotFix"] })]),
      ],
      effectiveRisk: eff("trivial"),
      policyFileChanged: false,
      humans: 1,
      constraints: [{ humans: 1, teams: ["oncall"], rules: [8] }],
      usedDefault: false,
      builtIn: null,
    });
  });

  it("U-PE-10 E10: an agent without a name matches an agent rule as uncertain", () => {
    const v = evaluatePolicy(EXAMPLE, facts({ risk: card("logic"), author: agent(null) }));
    expect(v).toEqual({
      outcome: "would_require",
      matched: [matchedRule(7, "require", [reason("agent", { uncertain: true })])],
      effectiveRisk: eff("logic"),
      policyFileChanged: false,
      humans: 1,
      constraints: [{ humans: 1, teams: ["platform", "security"], rules: [7] }],
      usedDefault: false,
      builtIn: null,
    });
  });

  it("U-PE-11 E11: an incomplete file list makes paths uncertain and only_paths false", () => {
    const v = evaluatePolicy(EXAMPLE, facts({ files: files("docs/a.md"), listingComplete: false }));
    expect(v).toEqual({
      outcome: "would_require",
      matched: [
        matchedRule(2, "approve", [reason("risk")], true),
        matchedRule(3, "require", [reason("paths", { uncertain: true })]),
      ],
      effectiveRisk: eff("trivial"),
      policyFileChanged: false,
      humans: 1,
      constraints: [{ humans: 1, teams: ["security"], rules: [3] }],
      usedDefault: false,
      builtIn: null,
    });
  });

  it("U-PE-12 E12: only_paths is case-sensitive, so a different case falls to the next rule", () => {
    // `*.md` would match `A.md` at any case of the directory, so the extension carries the case.
    const v = evaluatePolicy(EXAMPLE, facts({ files: files("Docs/A.MD"), risk: card("trivial") }));
    expect(v).toEqual({
      outcome: "would_approve",
      matched: [matchedRule(2, "approve", [reason("risk")])],
      effectiveRisk: eff("trivial"),
      policyFileChanged: false,
    });
    const same = evaluatePolicy(
      EXAMPLE,
      facts({ files: files("docs/A.md"), risk: card("trivial") }),
    );
    expect(same.matched.map((m) => m.index)).toEqual([1, 2]);
  });

  it("U-PE-13 E13: a policy with only a version falls to the default", () => {
    const v = evaluatePolicy(parsed("version: 1\n"), facts());
    expect(v).toEqual({
      outcome: "would_require",
      matched: [],
      effectiveRisk: eff("trivial"),
      policyFileChanged: false,
      humans: 1,
      constraints: [{ humans: 1, teams: [], rules: [] }],
      usedDefault: true,
      builtIn: null,
    });
    const team = evaluatePolicy(
      parsed("version: 1\ndefault: { require: { humans: 2, team: [b, a] } }\n"),
      facts(),
    );
    expect(team).toMatchObject({
      humans: 2,
      constraints: [{ humans: 2, teams: ["a", "b"], rules: [] }],
      usedDefault: true,
    });
  });

  it("U-PE-14 E14: an approve rule for trivial and logic does not match while the card is pending", () => {
    const p = parsed(
      "version: 1\nrules:\n  - match: { risk: [trivial, logic] }\n    approve: auto\n",
    );
    const v = evaluatePolicy(p, facts({ risk: pending("logic") }));
    expect(v).toMatchObject({
      outcome: "would_require",
      matched: [],
      usedDefault: true,
      humans: 1,
    });
    // With a final card the same rule approves.
    expect(evaluatePolicy(p, facts({ risk: card("logic") })).outcome).toBe("would_approve");
  });
});

describe("policy evaluation properties", () => {
  const rule = (
    index: number,
    action: PolicyRule["action"],
    match: PolicyRule["match"],
  ): PolicyRule => ({
    index,
    name: null,
    match,
    action,
  });
  const policyOf = (rules: PolicyRule[]): Policy => ({
    version: 1,
    sensitivePaths: [],
    default: { humans: 1, teams: [] },
    rules: rules.map((r, i) => ({ ...r, index: i + 1 })),
  });

  it("U-PE-15 block wins whatever the rule order", () => {
    const rules = [
      rule(0, { kind: "approve" }, { risk: ["trivial"] }),
      rule(0, { kind: "require", humans: 2, teams: ["a"] }, { risk: ["trivial"] }),
      rule(0, { kind: "block" }, { risk: ["trivial"] }),
    ];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      const p = policyOf(order.map((i) => rules[i] as PolicyRule));
      const v = evaluatePolicy(p, facts());
      expect(v.outcome, order.join()).toBe("would_block");
      if (v.outcome !== "would_block") continue;
      const blockIndex = order.indexOf(2) + 1;
      expect(v.blockedBy).toEqual([blockIndex]);
      expect(v.matched.filter((m) => m.overridden)).toHaveLength(2);
    }
  });

  it("U-PE-16 requirements merge by team set; the total is the maximum", () => {
    const p = policyOf([
      rule(0, { kind: "require", humans: 1, teams: ["security"] }, { risk: ["trivial"] }),
      rule(0, { kind: "require", humans: 3, teams: ["security"] }, { risk: ["trivial"] }),
      rule(
        0,
        { kind: "require", humans: 2, teams: ["platform", "security"] },
        { risk: ["trivial"] },
      ),
      rule(0, { kind: "require", humans: 2, teams: [] }, { risk: ["trivial"] }),
      rule(
        0,
        { kind: "require", humans: 1, teams: ["security", "platform"] },
        { risk: ["trivial"] },
      ),
    ]);
    const v = evaluatePolicy(p, facts());
    expect(v).toMatchObject({
      outcome: "would_require",
      humans: 3,
      constraints: [
        { humans: 3, teams: ["security"], rules: [1, 2] },
        { humans: 2, teams: ["platform", "security"], rules: [3, 5] },
        { humans: 2, teams: [], rules: [4] },
      ],
    });
  });

  it("U-PE-17 an approve rule for trivial never matches while the risk is provisional", () => {
    const p = parsed("version: 1\nrules:\n  - match: { risk: trivial }\n    approve: auto\n");
    for (const floor of ["trivial", "logic", "sensitive"] as const) {
      const v = evaluatePolicy(p, facts({ risk: pending(floor) }));
      expect(v.matched, floor).toEqual([]);
      expect(v.outcome, floor).toBe("would_require");
    }
    expect(evaluatePolicy(p, facts({ risk: card("trivial") })).outcome).toBe("would_approve");
    const unavailable = evaluatePolicy(
      p,
      facts({ risk: { value: "logic", final: false, source: "card_unavailable" } }),
    );
    expect(unavailable.outcome).toBe("would_require");
  });

  it("U-PE-18 only_paths needs a complete, non-empty listing in which every old and new path matches", () => {
    const p = parsed(
      "version: 1\nrules:\n  - match: { only_paths: ['docs/**'] }\n    approve: auto\n",
    );
    const ok = evaluatePolicy(p, facts({ files: files("docs/a.md", "docs/b/c.md") }));
    expect(ok.outcome).toBe("would_approve");
    expect(evaluatePolicy(p, facts({ files: [] })).outcome).toBe("would_require");
    expect(
      evaluatePolicy(p, facts({ files: files("docs/a.md"), listingComplete: false })).outcome,
    ).toBe("would_require");
    expect(
      evaluatePolicy(p, facts({ files: [{ path: "docs/a.md", previousPath: "src/old.ts" }] }))
        .outcome,
    ).toBe("would_require");
    expect(
      evaluatePolicy(p, facts({ files: [{ path: "docs/a.md", previousPath: "docs/old.md" }] }))
        .outcome,
    ).toBe("would_approve");
  });

  it("U-PE-19 paths matches the previous path of a rename, into and out of a protected directory", () => {
    const p = parsed("version: 1\nrules:\n  - match: { paths: ['secrets/**'] }\n    block: true\n");
    for (const f of [
      { path: "src/a.ts", previousPath: "secrets/a.ts" },
      { path: "secrets/b.ts", previousPath: "src/b.ts" },
    ]) {
      const v = evaluatePolicy(p, facts({ files: [f] }));
      expect(v.outcome).toBe("would_block");
      expect(v.matched[0]?.reasons[0]).toMatchObject({ key: "paths", count: 1 });
    }
    expect(evaluatePolicy(p, facts({ files: files("src/a.ts") })).outcome).toBe("would_require");
  });

  it("U-PE-20 an agent rule: never for a known human, uncertain for an unknown author", () => {
    const p = parsed("version: 1\nrules:\n  - match: { agent: [Codex] }\n    block: true\n");
    expect(evaluatePolicy(p, facts({ author: { kind: "human", agent: null } })).matched).toEqual(
      [],
    );
    expect(evaluatePolicy(p, facts({ author: agent("claude-code") })).matched).toEqual([]);
    expect(evaluatePolicy(p, facts({ author: agent("codex") })).matched).toEqual([
      matchedRule(1, "block", [reason("agent")]),
    ]);
    expect(evaluatePolicy(p, facts({ author: { kind: "unknown", agent: null } })).matched).toEqual([
      matchedRule(1, "block", [reason("agent", { uncertain: true })]),
    ]);
  });

  it("U-PE-21 raises set raisedBy, and a sensitive floor makes the final flag irrelevant", () => {
    const p = parsed(
      "version: 1\nsensitive_paths: ['vault/**']\nrules:\n  - match: { risk: [trivial, logic] }\n    approve: auto\n  - match: { risk: sensitive }\n    require: { humans: 3 }\n",
    );
    const v = evaluatePolicy(p, facts({ files: files("vault/k.txt"), risk: pending("trivial") }));
    expect(v).toMatchObject({
      outcome: "would_require",
      humans: 3,
      effectiveRisk: { value: "sensitive", final: false, raisedBy: ["sensitive_paths"] },
      matched: [matchedRule(2, "require", [reason("risk")])],
    });
    const both = evaluatePolicy(
      p,
      facts({ files: files("vault/k.txt", "graft.yaml"), risk: card("logic") }),
    );
    expect(both.effectiveRisk.raisedBy).toEqual(["sensitive_paths", "policy_file"]);
    const already = evaluatePolicy(
      p,
      facts({ files: files("vault/k.txt"), risk: card("sensitive") }),
    );
    expect(already.effectiveRisk.raisedBy).toEqual([]);
    // sensitive_paths match case-insensitively (they only tighten).
    expect(evaluatePolicy(p, facts({ files: files("VAULT/K.txt") })).effectiveRisk.value).toBe(
      "sensitive",
    );
  });

  it("U-PE-22 the result is deterministic and the inputs are not mutated", () => {
    const f = facts({
      files: files("infra/main.tf", "b.ts", "a.ts"),
      labels: ["x", "hotfix"],
      author: agent(),
    });
    const p = structuredClone(EXAMPLE);
    const fBefore = structuredClone(f);
    const a = evaluatePolicy(p, f);
    const b = evaluatePolicy(p, f);
    expect(a).toEqual(b);
    expect(p).toEqual(EXAMPLE);
    expect(f).toEqual(fBefore);
    // Reasons list at most 5 paths in code-point order, with the total count.
    const many = parsed("version: 1\nrules:\n  - match: { paths: ['**'] }\n    block: true\n");
    const v = evaluatePolicy(many, facts({ files: files("z", "a", "m", "b", "y", "c", "x") }));
    expect(v.matched[0]?.reasons[0]).toEqual(
      reason("paths", { paths: ["a", "b", "c", "m", "x"], count: 7 }),
    );
  });
});

describe("approval counting", () => {
  const HEAD = "a".repeat(40);
  const OLD = "b".repeat(40);
  const review = (
    id: number,
    login: string,
    state: string,
    o: { commit?: string | null; at?: string; type?: string; nullUser?: boolean } = {},
  ): ReviewLike => ({
    user: o.nullUser ? null : { id, login, type: o.type ?? "User" },
    state,
    commit_id: o.commit === undefined ? HEAD : o.commit,
    submitted_at: o.at ?? `2026-10-14T10:0${id % 10}:00Z`,
  });
  const count = (
    reviews: ReviewLike[],
    over: Partial<{ author: string; truncated: boolean }> = {},
  ) =>
    countApprovals(reviews, {
      headSha: HEAD,
      prAuthorLogin: over.author ?? "author",
      truncated: over.truncated ?? false,
    });

  it("U-PA-1 the latest counted review of each user wins", () => {
    const reviews = [
      review(1, "alice", "APPROVED", { at: "2026-10-14T10:00:00Z" }),
      review(1, "alice", "CHANGES_REQUESTED", { at: "2026-10-14T10:05:00Z" }),
      review(2, "bob", "CHANGES_REQUESTED", { at: "2026-10-14T10:00:00Z" }),
      review(2, "bob", "APPROVED", { at: "2026-10-14T10:05:00Z" }),
    ];
    expect(count(reviews)).toMatchObject({ current: 1, stale: 0, users: ["bob"] });
    // List order decides when the timestamps are equal.
    const tie = [
      review(1, "alice", "CHANGES_REQUESTED", { at: "2026-10-14T10:00:00Z" }),
      review(1, "alice", "APPROVED", { at: "2026-10-14T10:00:00Z" }),
    ];
    expect(count(tie).current).toBe(1);
  });

  it("U-PA-2 a comment does not reset an approval; a dismissal does", () => {
    const base = review(1, "alice", "APPROVED", { at: "2026-10-14T10:00:00Z" });
    expect(
      count([base, review(1, "alice", "COMMENTED", { at: "2026-10-14T10:09:00Z" })]).current,
    ).toBe(1);
    expect(
      count([base, review(1, "alice", "PENDING", { at: "2026-10-14T10:09:00Z" })]).current,
    ).toBe(1);
    expect(
      count([base, review(1, "alice", "DISMISSED", { at: "2026-10-14T10:09:00Z" })]).current,
    ).toBe(0);
  });

  it("U-PA-3 the author, bots and deleted users are excluded", () => {
    const reviews = [
      review(1, "author", "APPROVED"),
      review(2, "Author", "APPROVED"),
      review(3, "ci[bot]", "APPROVED", { type: "Bot" }),
      review(4, "ghost", "APPROVED", { nullUser: true }),
      review(5, "carol", "APPROVED"),
    ];
    expect(count(reviews)).toMatchObject({ current: 1, users: ["carol"] });
  });

  it("U-PA-4 current and stale by commit; users sorted and capped at 10", () => {
    const reviews = [
      review(1, "zed", "APPROVED"),
      review(2, "amy", "APPROVED"),
      review(3, "old", "APPROVED", { commit: OLD }),
      review(4, "none", "APPROVED", { commit: null }),
    ];
    expect(count(reviews)).toEqual({
      current: 2,
      stale: 2,
      users: ["amy", "zed"],
      truncated: false,
    });
    const many = Array.from({ length: 12 }, (_, i) =>
      review(100 + i, `u${String(i).padStart(2, "0")}`, "APPROVED"),
    );
    const c = count(many);
    expect(c.current).toBe(12);
    expect(c.users).toHaveLength(10);
    expect(c.users[0]).toBe("u00");
  });

  it("U-PA-5 truncated is passed through", () => {
    expect(count([], { truncated: true }).truncated).toBe(true);
    expect(count([], { truncated: false }).truncated).toBe(false);
  });
});

describe("incomplete file listing (D5, D11)", () => {
  const sizeOnly = parsed(
    "version: 1\nrules:\n  - match: { size: { max_lines: 10 } }\n    approve: auto\n",
  );
  const renamed = (n: number, withPolicy: boolean): PolicyFacts["files"] =>
    Array.from({ length: n }, (_, i) => ({
      path: withPolicy && i === 0 ? "graft.yaml" : `new/f${i}.txt`,
      previousPath: `old/f${i}.txt`,
    }));

  it("U-PE-23 1,001 renames with graft.yaml among them: a size-only approve rule never approves", () => {
    // The listing stops at 1,000 files: `files` holds none of the policy-file renames.
    const v = evaluatePolicy(
      sizeOnly,
      facts({
        files: [],
        listingComplete: false,
        size: { lines: 0, files: 1_001 },
        risk: card("sensitive"),
      }),
    );
    expect(v.outcome).toBe("would_require");
    expect(v).toMatchObject({
      humans: 1,
      constraints: [{ humans: 1, teams: [], rules: [0] }],
      usedDefault: false,
      builtIn: "policy_file_changed",
      policyFileChanged: false,
    });
    expect(v.matched.every((m) => m.overridden)).toBe(true);
  });

  it("U-PE-24 the same listing without graft.yaml in the visible part is never would_approve either", () => {
    for (const files of [renamed(1_000, false), []]) {
      const v = evaluatePolicy(
        sizeOnly,
        facts({
          files,
          listingComplete: false,
          size: { lines: 0, files: 1_001 },
          risk: card("sensitive"),
        }),
      );
      expect(v.outcome, `${files.length} visible files`).toBe("would_require");
      expect(v).toMatchObject({ builtIn: "policy_file_changed", humans: 1 });
    }
    // A visible graft.yaml is reported as changed, as before.
    const seen = evaluatePolicy(
      sizeOnly,
      facts({ files: renamed(1_000, true), listingComplete: false, risk: card("sensitive") }),
    );
    expect(seen).toMatchObject({ outcome: "would_require", policyFileChanged: true });
    // The control: a complete listing of the same size-only rule still approves.
    expect(
      evaluatePolicy(
        sizeOnly,
        facts({ files: files("src/a.ts"), size: { lines: 5, files: 1 }, risk: card("sensitive") }),
      ).outcome,
    ).toBe("would_approve");
  });
});

describe("path limits and the work budget (review 2)", () => {
  const longPath = `${"d/".repeat(600)}x`; // over 1,024 characters
  const manySegments = Array(129).fill("d").join("/"); // over 128 segments
  const overs = [longPath, manySegments];

  it("U-PE-25 an over-long path matches tightening paths, sensitive_paths and block; never an approve rule", () => {
    const requireP = parsed(
      "version: 1\nrules:\n  - match: { paths: ['nothing/**'] }\n    require: { humans: 2 }\n",
    );
    const blockP = parsed(
      "version: 1\nrules:\n  - match: { paths: ['nothing/**'] }\n    block: true\n",
    );
    const sensitiveP = parsed(
      "version: 1\nsensitive_paths: ['nothing/**']\nrules:\n  - match: { risk: sensitive }\n    require: { humans: 3 }\n",
    );
    const onlyP = parsed(
      "version: 1\nrules:\n  - match: { only_paths: ['**/*.md', '**'] }\n    approve: auto\n",
    );
    for (const p of overs) {
      const f = facts({ files: files("src/a.ts", p), risk: card("trivial") });
      expect(evaluatePolicy(requireP, f), "require paths").toMatchObject({
        outcome: "would_require",
        humans: 2,
        limits: ["path_too_long"],
      });
      expect(evaluatePolicy(blockP, f).outcome, "block paths").toBe("would_block");
      const s = evaluatePolicy(sensitiveP, f);
      expect(s.effectiveRisk.raisedBy, "sensitive_paths").toEqual(["sensitive_paths"]);
      expect(s).toMatchObject({ outcome: "would_require", humans: 3 });
      // only_paths would match `**`, but a path over the limits is not matched: no approval,
      // and the built-in applies because the path may be graft.yaml's neighbour in the list.
      const o = evaluatePolicy(onlyP, f);
      expect(o.outcome, "only_paths").toBe("would_require");
      expect(o.matched, "only_paths").toEqual([]);
      // The same policy with only short paths approves.
      expect(
        evaluatePolicy(onlyP, facts({ files: files("a.md"), risk: card("trivial") })).outcome,
      ).toBe("would_approve");
    }
  });

  it("U-PE-26 an over-long path is reported as path_too_long, not as a change to graft.yaml", () => {
    const p = parsed("version: 1\nrules:\n  - match: { risk: trivial }\n    approve: auto\n");
    for (const path of overs) {
      const v = evaluatePolicy(p, facts({ files: files(path), risk: card("trivial") }));
      expect(v.outcome).toBe("would_require");
      expect(v).toMatchObject({
        policyFileChanged: false,
        builtIn: "policy_file_changed",
        limits: ["path_too_long"],
      });
      expect(v.effectiveRisk.raisedBy).not.toContain("policy_file");
    }
    // A real policy-file change still says so, and carries no limit.
    const real = evaluatePolicy(p, facts({ files: files("graft.yaml"), risk: card("trivial") }));
    expect(real).toMatchObject({ policyFileChanged: true });
    expect((real as { limits?: unknown }).limits).toBeUndefined();
  });

  it("U-PE-27 a spent work budget is recorded as budget_exhausted and answers the strict side", () => {
    const g = `*${"a".repeat(44)}b?x*`;
    const rules = Array.from(
      { length: 150 },
      (_, i) =>
        `  - match: { paths: ['${g}', '${g.replace("?x", "?y")}'] }\n    require: { humans: ${(i % 3) + 1} }\n`,
    ).join("");
    const p = parsed(
      `version: 1\nrules:\n${rules}  - match: { only_paths: ['**'] }\n    approve: auto\n`,
    );
    const hostile = Array.from({ length: 1_000 }, (_, i) => ({
      path: `${"a".repeat(1_000)}b${String(i).padStart(23, "0")}`,
      previousPath: null,
    }));
    const v = evaluatePolicy(p, facts({ files: hostile, risk: card("trivial") }));
    expect(v.limits).toEqual(["budget_exhausted"]);
    expect(v.outcome).toBe("would_require");
    // Spent budget: the unfinished tightening rules count as matching (uncertain), the approve
    // rule does not match, and the default does not apply.
    expect(v.matched.every((m) => m.action === "require")).toBe(true);
    expect(v.matched.some((m) => m.reasons.some((r) => r.uncertain))).toBe(true);
    expect(v).toMatchObject({ humans: 3, usedDefault: false });
    // A normal PR is not affected.
    expect(
      evaluatePolicy(p, facts({ files: files("a.md"), risk: card("trivial") })).limits,
    ).toBeUndefined();
  });
});

describe("budget terms of the approve override and reported limits (review 3)", () => {
  const approving = parsed("version: 1\nrules:\n  - match: { risk: trivial }\n    approve: auto\n");
  const spent = (): GlobBudget => {
    const b = new GlobBudget();
    b.exhausted = true;
    return b;
  };

  it("U-PE-28 a spent shared budget or a spent policy-file budget overrides an approve rule", () => {
    const f = facts({ files: files("src/a.ts"), risk: card("trivial") });
    expect(evaluatePolicy(approving, f).outcome).toBe("would_approve");
    const shared = evaluatePolicy(approving, f, { budget: spent() });
    expect(shared).toMatchObject({
      outcome: "would_require",
      builtIn: "policy_file_changed",
      limits: ["budget_exhausted"],
      policyFileChanged: false,
    });
    const own = evaluatePolicy(approving, f, { policyBudget: spent() });
    expect(own).toMatchObject({
      outcome: "would_require",
      builtIn: "policy_file_changed",
      policyFileChanged: false,
    });
  });

  it("U-PE-29 a hit that exists only because of a limit is reported as uncertain", () => {
    const requireP = parsed(
      "version: 1\nrules:\n  - match: { paths: ['nothing/**', 'src/**'] }\n    require: { humans: 2 }\n",
    );
    const real = evaluatePolicy(requireP, facts({ files: files("src/a.ts") }));
    expect(real.matched[0]?.reasons[0]).toMatchObject({ key: "paths", uncertain: false });
    for (const p of [`${"d/".repeat(600)}x`, Array(129).fill("d").join("/")]) {
      const v = evaluatePolicy(requireP, facts({ files: files(p) }));
      expect(v.matched[0]?.reasons[0], p.slice(0, 20)).toMatchObject({
        key: "paths",
        uncertain: true,
      });
    }
    // The assumed hit is listed like a real one: its path and the count are part of the reason
    // (it distinguishes "matched on the limit" from "dropped from the list").
    const mixed = evaluatePolicy(
      requireP,
      facts({ files: files("src/a.ts", `${"d/".repeat(600)}x`) }),
    );
    const reasonOf = mixed.matched[0]?.reasons[0];
    expect(reasonOf).toMatchObject({ uncertain: true, count: 2 });
    expect(reasonOf?.paths).toContain(`${"d/".repeat(600)}x`);
    expect(reasonOf?.paths).toContain("src/a.ts");
    // A spent budget does the same for every remaining tightening rule.
    const v = evaluatePolicy(requireP, facts({ files: files("src/a.ts") }), { budget: spent() });
    expect(v.matched[0]?.reasons[0]).toMatchObject({ uncertain: true });
  });
});

describe("the budget fits the legal maximum (review 4)", () => {
  /** 161 rules, 483 plain globs (`areaN/partM/**`), 7 `sensitive_paths`: 490 of the 500 allowed. */
  function largestOrdinaryPolicy(): Policy {
    const area = (i: number) => `area${i % 40}/part${i % 7}/**`;
    let y =
      "version: 1\nsensitive_paths: ['vault/**','**/secrets/**','infra/prod/**','**/*.pem','keys/**','.env*','**/credentials*']\nrules:\n";
    for (let i = 0; i < 161; i++) {
      y +=
        i === 0
          ? "  - match: { paths: ['secrets/**', 'payments/**', '**/billing/**'] }\n    block: true\n"
          : i === 1
            ? "  - match: { paths: ['src/module7/**', 'docs/x/**', 'lib/y/**'] }\n    require: { humans: 2, team: core }\n"
            : `  - match: { paths: ['${area(i * 3)}', '${area(i * 3 + 1)}', '${area(i * 3 + 2)}'] }\n    require: { humans: 1, team: t${i % 9} }\n`;
    }
    expect(y.length).toBeLessThanOrEqual(32_768);
    return parsed(y);
  }
  const renames = (n: number): PolicyFacts["files"] =>
    Array.from({ length: n }, (_, i) => ({
      path: `src/module${i % 50}/dir${i % 13}/file${i}.ts`,
      previousPath: `src/old${i % 50}/dir${i % 13}/file${i}.ts`,
    }));
  const pendingFacts = (n: number): PolicyFacts =>
    facts({
      files: renames(n),
      size: { lines: 0, files: n },
      risk: { value: "logic", final: false, source: "card_pending" },
      author: agent(),
    });
  const floorOf = (policy: Policy, n: number, budget: GlobBudget) =>
    computeRiskFloor(
      {
        files: renames(n).map((f) => ({
          ...f,
          status: "renamed" as const,
          additions: 0,
          deletions: 0,
          patch: null,
        })),
        pr: { additions: 0, deletions: 0, changedFiles: n },
        listingTruncated: false,
        tooLarge: false,
        partialPaths: [],
        untrustedTexts: [],
      },
      { extraSensitiveGlobs: policy.sensitivePaths },
      budget,
    );

  it("U-PE-30 the largest ordinary policy against 1,000 renames with a pending card has no limit hit and the true verdict", () => {
    const policy = largestOrdinaryPolicy();
    expect(policy.rules).toHaveLength(161);
    const budget = new GlobBudget();
    const floor = floorOf(policy, 1_000, budget);
    expect(floor.reasons.map((r) => r.rule)).not.toContain("glob_budget");
    const v = evaluatePolicy(policy, pendingFacts(1_000), { budget });
    expect(v.limits).toBeUndefined();
    expect(budget.exhausted).toBe(false);
    expect(budget.limitHits).toBe(0);
    // Only rule 2 matches (src/module7/** has files); the unrelated rules do not.
    expect(v.outcome).toBe("would_require");
    expect(v.matched.map((m) => m.index)).toEqual([2]);
    expect(v.matched[0]?.reasons[0]).toMatchObject({ key: "paths", uncertain: false });
    expect(v).toMatchObject({ humans: 2, usedDefault: false });
    // Pins the sizing: this job needs about a million pairs, far above the 250,000 that review 4
    // showed to be too small, and uses well under two thirds of the fuel (margin of at least 1.5).
    expect(budget.pairsUsed).toBeGreaterThan(1_000_000);
    expect(EVALUATION_FUEL - budget.fuel).toBeLessThan(EVALUATION_FUEL / 1.5);
  });

  it("U-PE-31 the shipped example policy against 1,000 renamed agent files is not would_block", () => {
    const budget = new GlobBudget();
    floorOf(EXAMPLE, 1_000, budget);
    const v = evaluatePolicy(EXAMPLE, pendingFacts(1_000), { budget });
    expect(v.limits).toBeUndefined();
    expect(v.outcome).not.toBe("would_block");
    expect(budget.exhausted).toBe(false);
  });

  const deepRenames = (n: number, depth: number): PolicyFacts["files"] => {
    const mid = Array.from({ length: Math.max(0, depth - 3) }, (_, k) => `d${k}x`).join("/");
    const mk = (root: string, i: number) =>
      `src/${root}${i % 50}/${mid ? `${mid}/` : ""}File${i}.java`;
    return Array.from({ length: n }, (_, i) => ({
      path: mk("module", i),
      previousPath: mk("old", i),
    }));
  };
  const deepFloor = (policy: Policy, files: PolicyFacts["files"], budget: GlobBudget) =>
    computeRiskFloor(
      {
        files: files.map((f) => ({
          ...f,
          status: "renamed" as const,
          additions: 0,
          deletions: 0,
          patch: null,
        })),
        pr: { additions: 0, deletions: 0, changedFiles: files.length },
        listingTruncated: false,
        tooLarge: false,
        partialPaths: [],
        untrustedTexts: [],
      },
      { extraSensitiveGlobs: policy.sensitivePaths },
      budget,
    );

  it("U-PE-32 depth is part of the sizing: 4, 15 and 30 segments, pending and final cards, ordinary globs, no limit hit", () => {
    const base = largestOrdinaryPolicy();
    // Unanchored, extension and mixed ordinary shapes too.
    const shapes: [string, (k: number) => string][] = [
      ["anchored", (k) => `area${k % 40}/part${k % 7}/**`],
      ["floating", (k) => `**/x${k}/**`],
      ["extension", (k) => `**/*.e${k}`],
      ["dir then ext", (k) => `**/m${k % 50}/**/*.e${k}`],
      ["name part", (k) => `**/*part${k}*/**`],
    ];
    for (const [label, g] of shapes) {
      let y =
        "version: 1\nsensitive_paths: ['vault/**','**/secrets/**','infra/prod/**','**/*.pem','keys/**','.env*','**/credentials*']\nrules:\n";
      y += "  - match: { paths: ['src/module7/**'] }\n    require: { humans: 2, team: core }\n";
      for (let i = 0; i < 160; i++) {
        y += `  - match: { paths: ['${g(i * 3)}', '${g(i * 3 + 1)}', '${g(i * 3 + 2)}'] }\n    require: { humans: 1, team: t${i % 9} }\n`;
      }
      const policy = parsed(y);
      for (const depth of [4, 15, 30]) {
        for (const pending of [true, false]) {
          const files = deepRenames(1_000, depth);
          const budget = new GlobBudget();
          if (pending) {
            expect(
              deepFloor(policy, files, budget).reasons.map((r) => r.rule),
              `${label} d${depth} floor`,
            ).not.toContain("glob_budget");
          }
          const v = evaluatePolicy(
            policy,
            facts({
              files,
              size: { lines: 0, files: 1_000 },
              risk: pending
                ? { value: "logic", final: false, source: "card_pending" }
                : { value: "logic", final: true, source: "card" },
              author: agent(),
            }),
            { budget },
          );
          const where = `${label} depth ${depth} ${pending ? "pending" : "final"}`;
          expect(v.limits, where).toBeUndefined();
          expect(budget.exhausted, where).toBe(false);
          expect(
            v.matched.map((m) => m.index),
            where,
          ).toEqual([1]);
          expect(v, where).toMatchObject({ outcome: "would_require", humans: 2 });
          // Sized with the depth: at least 1.5x of margin on the measured maximum.
          expect(EVALUATION_FUEL - budget.fuel, where).toBeLessThan(EVALUATION_FUEL / 1.5);
        }
      }
    }
    expect(base.rules).toHaveLength(161);
  });

  it("U-PE-33 regression (review 5): a deep Java-layout PR with 160 plain 3-glob rules is not blocked and gets no unrelated team requirements", () => {
    let y = "version: 1\nrules:\n";
    for (let i = 0; i < 160; i++) {
      y += `  - match: { paths: ['services/svc${i}/**', '**/legacy${i}/**', 'libs/l${i}/**'] }\n    require: { humans: 1, team: t${i % 9} }\n`;
    }
    y +=
      "  - name: no-agent-secrets\n    match: { paths: ['**/secrets/**'], author: agent }\n    block: true\n";
    const policy = parsed(y);
    const java = (root: string, i: number) =>
      `core/src/main/java/com/acmecorp/platform/${root}${i % 50}/internal/service/impl/handlers/v2/Handler${i}Implementation.java`;
    expect(java("module", 1).split("/")).toHaveLength(14);
    const files = Array.from({ length: 1_000 }, (_, i) => ({
      path: java("module", i),
      previousPath: java("old", i),
    }));
    const v = evaluatePolicy(
      policy,
      facts({
        files,
        size: { lines: 0, files: 1_000 },
        risk: { value: "logic", final: true, source: "card" },
        author: agent(),
      }),
    );
    expect(v.limits).toBeUndefined();
    expect(v.outcome).toBe("would_require");
    expect(v.matched).toEqual([]);
    expect(v).toMatchObject({ usedDefault: true, humans: 1 });
  });
});
