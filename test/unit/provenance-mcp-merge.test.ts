/**
 * Phase 1 step 6, §8 and D13: an MCP provenance report can only make a verdict stricter. D19: the
 * commit authors of a PR opened through MCP cannot approve it.
 */
import { describe, expect, it } from "vitest";
import { buildFacts } from "../../src/modules/policy/facts.js";
import { mcpAgreement } from "../../src/modules/provenance/index.js";
import {
  countApprovals,
  evaluatePolicy,
  evaluateWithReport,
  type PolicyFacts,
  type PolicyVerdict,
} from "../../src/policy/evaluate.js";
import { parsePolicyText } from "../../src/policy/parse.js";
import type { Policy } from "../../src/policy/schema.js";
import { makeReview } from "../helpers/github-builders.js";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("mcpAgreement (§8)", () => {
  it("U-PMM-1 no report → none; same agent (case differs) → agrees; other agent, human trailers, another head, no trailers → disagrees", () => {
    const trailers = { headSha: HEAD, authorKind: "agent" as const, agent: "Claude-Code" };
    expect(mcpAgreement(trailers, null)).toBe("none");
    expect(mcpAgreement(null, null)).toBe("none");
    expect(mcpAgreement(trailers, { headSha: HEAD, agent: "claude-code" })).toBe("agrees");
    expect(mcpAgreement(trailers, { headSha: HEAD, agent: "codex" })).toBe("disagrees");
    expect(
      mcpAgreement(
        { headSha: HEAD, authorKind: "human", agent: null },
        { headSha: HEAD, agent: "claude-code" },
      ),
    ).toBe("disagrees");
    // An agent author with no agent name (a bot account) cannot agree on a name.
    expect(
      mcpAgreement(
        { headSha: HEAD, authorKind: "agent", agent: null },
        { headSha: HEAD, agent: "claude-code" },
      ),
    ).toBe("disagrees");
    expect(mcpAgreement(trailers, { headSha: OTHER, agent: "claude-code" })).toBe("disagrees");
    expect(mcpAgreement(null, { headSha: HEAD, agent: "claude-code" })).toBe("disagrees");
  });
});

describe("buildFacts with an MCP report (D13)", () => {
  const base = {
    pull: {
      additions: 1,
      deletions: 1,
      changed_files: 1,
      labels: [],
      head: { sha: HEAD },
    } as unknown as Parameters<typeof buildFacts>[0]["pull"],
    files: [
      {
        path: "src/a.ts",
        previousPath: null,
        status: "modified" as const,
        additions: 1,
        deletions: 1,
      },
    ],
    complete: true,
    card: { head_sha: HEAD, status: "ok" as const, risk_class: "trivial" as const },
    configSensitivePaths: [],
    policySensitivePaths: [],
  };
  const prov = (mcp_report: "none" | "agrees" | "disagrees") => ({
    head_sha: HEAD,
    author_kind: "agent" as const,
    agent: "claude-code",
    mcp_report,
  });

  it("U-PMM-2 disagrees → { kind: unknown, agent: null }; agrees or none → the trailer facts", () => {
    expect(buildFacts({ ...base, provenance: prov("disagrees") }).author).toEqual({
      kind: "unknown",
      agent: null,
    });
    for (const r of ["agrees", "none"] as const) {
      expect(buildFacts({ ...base, provenance: prov(r) }).author).toEqual({
        kind: "agent",
        agent: "claude-code",
      });
    }
    // A row from before 0014 has no column: the trailer facts.
    const { mcp_report: _m, ...old } = prov("none");
    expect(buildFacts({ ...base, provenance: old }).author.kind).toBe("agent");
  });
});

// ---------------------------------------------------------------------------------------------
// U-PMM-3: the property, over generated policies and facts
// ---------------------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function policyFrom(yaml: string): Policy {
  const res = parsePolicyText(new TextEncoder().encode(yaml));
  if (!res.ok) throw new Error(`${JSON.stringify(res.errors)}\n${yaml}`);
  return res.policy;
}

function generatePolicy(r: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const team = () => (r() < 0.4 ? `, team: ${pick(["security", "platform"])}` : "");
  const lines = [
    "version: 1",
    `default:\n  require: { humans: ${1 + Math.floor(r() * 2)}${team()} }`,
    "rules:",
  ];
  const n = 1 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const action = pick(["approve", "require", "require", "block"] as const);
    const keys: string[] = [];
    // Approve rules may not use author or agent (step 5 D10, D11): the parser refuses them.
    if (action !== "approve" && r() < 0.6) keys.push(`author: ${pick(["agent", "human"])}`);
    if (action !== "approve" && r() < 0.5) {
      keys.push(`agents: [${pick(["codex", "claude-code", "codex, aider"])}]`);
    }
    if (r() < 0.5)
      keys.push(`risk: [${pick(["trivial", "logic", "sensitive", "trivial, logic"])}]`);
    // `paths` is a tightening key too: an approve rule must not use it (approve_any_path).
    if (action !== "approve" && r() < 0.4) {
      keys.push(`paths: ["${pick(["src/**", "infra/**"])}"]`);
    }
    if (keys.length === 0) keys.push(`risk: [${pick(["trivial", "logic"])}]`);
    const body =
      action === "approve"
        ? "approve: auto"
        : action === "block"
          ? "block: true"
          : `require: { humans: ${1 + Math.floor(r() * 3)}${team()} }`;
    lines.push(`  - match: { ${keys.join(", ").replace("agents:", "agent:")} }\n    ${body}`);
  }
  return `${lines.join("\n")}\n`;
}

function generateFacts(r: () => number): PolicyFacts {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const author = pick<PolicyFacts["author"]>([
    { kind: "agent", agent: "claude-code" },
    { kind: "agent", agent: "codex" },
    { kind: "agent", agent: null },
    { kind: "human", agent: null },
  ]);
  const risk = pick(["trivial", "logic", "sensitive"] as const);
  return {
    files: [{ path: pick(["src/a.ts", "infra/main.tf", "docs/x.md"]), previousPath: null }],
    listingComplete: r() < 0.9,
    size: { lines: 10, files: 1 },
    risk:
      r() < 0.7
        ? { value: risk, final: true, source: "card" }
        : { value: risk, final: false, source: "card_pending" },
    author,
    labels: [],
  };
}

const RANK = { would_approve: 0, would_require: 1, would_block: 2 } as const;

/** `a` is at least as strict as `b` (§8): a higher outcome, or the same and requires ⊇. */
function atLeastAsStrict(a: PolicyVerdict, b: PolicyVerdict): boolean {
  if (RANK[a.outcome] !== RANK[b.outcome]) return RANK[a.outcome] > RANK[b.outcome];
  if (a.outcome !== "would_require" || b.outcome !== "would_require") return true;
  return b.constraints.every((c) =>
    a.constraints.some(
      (d) => d.teams.join("\u0000") === c.teams.join("\u0000") && d.humans >= c.humans,
    ),
  );
}

describe("the merge never loosens (§8)", () => {
  it("U-PMM-3 property: for generated policies and trailer facts, the verdict with a disagreeing report is never less strict, and its required set contains the other's", () => {
    const r = rng(0x5eed6);
    let unknownAloneLooser = 0;
    for (let i = 0; i < 3000; i++) {
      const yaml = generatePolicy(r);
      const policy = policyFrom(yaml);
      const trailers = generateFacts(r);
      const withMcp: PolicyFacts = { ...trailers, author: { kind: "unknown", agent: null } };
      const without = evaluatePolicy(policy, trailers);
      const merged = evaluateWithReport(policy, withMcp, trailers.author);
      expect(atLeastAsStrict(merged, without), `${yaml}\n${JSON.stringify(trailers)}`).toBe(true);
      // Never stricter than needed either: with an unknown author it is at least that verdict.
      expect(atLeastAsStrict(merged, evaluatePolicy(policy, withMcp))).toBe(true);
      if (!atLeastAsStrict(evaluatePolicy(policy, withMcp), without)) unknownAloneLooser++;
    }
    // Why the merge exists (decisions.md): an unknown author alone can trade the policy's default
    // for a looser require rule. The generator does reach such cases.
    expect(unknownAloneLooser).toBeGreaterThan(0);
  });

  it("U-PMM-3b the counterexample: a default with a team and a looser rule on agent: [codex]", () => {
    const policy = policyFrom(
      "version: 1\ndefault:\n  require: { humans: 1, team: security }\nrules:\n  - match: { agent: [codex] }\n    require: { humans: 1 }\n",
    );
    const trailers: PolicyFacts = {
      files: [{ path: "src/a.ts", previousPath: null }],
      listingComplete: true,
      size: { lines: 1, files: 1 },
      risk: { value: "logic", final: true, source: "card" },
      author: { kind: "agent", agent: "claude-code" },
      labels: [],
    };
    const unknown: PolicyFacts = { ...trailers, author: { kind: "unknown", agent: null } };
    const alone = evaluatePolicy(policy, unknown);
    expect(alone.outcome === "would_require" && alone.constraints).toEqual([
      { humans: 1, teams: [], rules: [1] },
    ]);
    const merged = evaluateWithReport(policy, unknown, trailers.author);
    expect(merged.outcome === "would_require" && merged.constraints).toEqual([
      { humans: 1, teams: ["security"], rules: [] },
      { humans: 1, teams: [], rules: [1] },
    ]);
    expect(merged.outcome === "would_require" && merged.usedDefault).toBe(true);
  });
});

describe("approvals of an MCP-opened PR (D19)", () => {
  it("U-APP-MCP-1 countApprovals with excludedLogins: an excluded approver is skipped like the PR author, case-insensitively; others still count; everyone → none and truncated", () => {
    const reviews = [
      makeReview({ id: 1, login: "Alice", userId: 11, commitId: HEAD }),
      makeReview({ id: 2, login: "bob", userId: 12, commitId: HEAD }),
      makeReview({ id: 3, login: "carol", userId: 13, commitId: OTHER }),
    ];
    const plain = countApprovals(reviews, {
      headSha: HEAD,
      prAuthorLogin: "graft-dev[bot]",
      truncated: false,
    });
    expect([plain.current, plain.stale, plain.users]).toEqual([2, 1, ["Alice", "bob"]]);
    const excluded = countApprovals(reviews, {
      headSha: HEAD,
      prAuthorLogin: "graft-dev[bot]",
      truncated: false,
      excludedLogins: ["alice", "CAROL"],
    });
    expect([excluded.current, excluded.stale, excluded.users, excluded.truncated]).toEqual([
      1,
      0,
      ["bob"],
      false,
    ]);
    const everyone = countApprovals(reviews, {
      headSha: HEAD,
      prAuthorLogin: "graft-dev[bot]",
      truncated: false,
      excludedLogins: "everyone",
    });
    expect([everyone.current, everyone.stale, everyone.truncated]).toEqual([0, 0, true]);
    // An empty list excludes nobody.
    expect(
      countApprovals(reviews, {
        headSha: HEAD,
        prAuthorLogin: "x",
        truncated: false,
        excludedLogins: [],
      }).current,
    ).toBe(2);
  });
});
