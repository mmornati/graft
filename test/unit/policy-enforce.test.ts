import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import {
  type ApproverFacts,
  type Enforced,
  enforcedConclusion,
  publishedCheck,
  satisfyConstraints,
  type Unverified,
} from "../../src/policy/enforce.js";
import {
  type Constraint,
  countApprovals,
  evaluatePolicy,
  type PolicyFacts,
  type PolicyVerdict,
} from "../../src/policy/evaluate.js";
import { parsePolicyText } from "../../src/policy/parse.js";
import type { Policy } from "../../src/policy/schema.js";
import { TEST_PRIVATE_KEY, TEST_WEBHOOK_SECRET } from "../helpers/config.js";

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

const user = (login: string, id = login.length * 1000 + login.charCodeAt(0)) => ({ id, login });

const NONE: ApproverFacts = {
  counted: [],
  notCounted: [],
  changesRequestedBy: [],
  teams: {},
  reviewsTruncated: false,
};

/** Two counted writers; alice is a verified member of every team named in the example. */
const SATISFYING: ApproverFacts = {
  counted: [user("alice"), user("bob")],
  notCounted: [],
  changesRequestedBy: [],
  teams: {
    security: { members: ["alice"] },
    oncall: { members: ["alice"] },
    platform: { members: [] },
  },
  reviewsTruncated: false,
};

const enforce = (
  verdict: PolicyVerdict,
  approvers: ApproverFacts,
  cardWait = false,
): Pick<Enforced, "conclusion" | "reason"> => {
  const e = enforcedConclusion({ state: "ok", verdict, approvers, cardWait });
  return { conclusion: e.conclusion, reason: e.reason };
};

const success = (reason: Enforced["reason"]) => ({ conclusion: "success", reason });
const failure = (reason: Enforced["reason"]) => ({ conclusion: "failure", reason });

describe("enforce conclusion (Phase 1 step 2, §7)", () => {
  // Phase 0 step 5 §9.3: E1 to E14, each with no approvals and with approvals that satisfy them.
  const EXAMPLES: [string, Policy, PolicyFacts, unknown, unknown][] = [
    [
      "E1",
      EXAMPLE,
      facts({ files: files("docs/a.md"), risk: card("trivial") }),
      success("approved_by_policy"),
      success("approved_by_policy"),
    ],
    [
      "E2",
      EXAMPLE,
      facts({ author: agent(), risk: card("trivial") }),
      success("approved_by_policy"),
      success("approved_by_policy"),
    ],
    [
      "E3",
      EXAMPLE,
      facts({ files: files("infra/main.tf"), risk: card("sensitive"), author: agent() }),
      failure("approvals_missing"),
      success("requirements_met"),
    ],
    [
      "E4",
      EXAMPLE,
      facts({ files: files("secrets/prod.env"), risk: card("sensitive"), author: agent() }),
      failure("blocked"),
      failure("blocked"),
    ],
    [
      "E5",
      EXAMPLE,
      facts({ author: agent(), risk: pending("logic") }),
      failure("approvals_missing"),
      success("requirements_met"),
    ],
    [
      "E6",
      EXAMPLE,
      facts({ files: files("services/billing/pay.ts"), risk: card("logic"), author: agent() }),
      failure("approvals_missing"),
      success("requirements_met"),
    ],
    [
      "E7",
      EXAMPLE,
      facts({ files: files("graft.yaml"), risk: card("trivial") }),
      failure("approvals_missing"),
      success("requirements_met"),
    ],
    [
      "E8",
      EXAMPLE,
      facts({
        files: files("secrets/x"),
        risk: card("sensitive"),
        author: { kind: "unknown", agent: null },
      }),
      failure("blocked"),
      failure("blocked"),
    ],
    [
      "E9",
      EXAMPLE,
      facts({ labels: ["HotFix"] }),
      failure("approvals_missing"),
      success("requirements_met"),
    ],
    [
      "E10",
      EXAMPLE,
      facts({ risk: card("logic"), author: agent(null) }),
      failure("approvals_missing"),
      success("requirements_met"),
    ],
    [
      "E11",
      EXAMPLE,
      facts({ files: files("docs/a.md"), listingComplete: false }),
      failure("approvals_missing"),
      success("requirements_met"),
    ],
    [
      "E12",
      EXAMPLE,
      facts({ files: files("Docs/A.MD"), risk: card("trivial") }),
      success("approved_by_policy"),
      success("approved_by_policy"),
    ],
    [
      "E13",
      parsed("version: 1\n"),
      facts(),
      failure("approvals_missing"),
      success("requirements_met"),
    ],
    [
      "E14",
      parsed("version: 1\nrules:\n  - match: { risk: [trivial, logic] }\n    approve: auto\n"),
      facts({ risk: pending("logic") }),
      failure("approvals_missing"),
      success("requirements_met"),
    ],
  ];

  it("U-ENF-1 E1 to E14: the expected conclusion with no approvals and with satisfying approvals", () => {
    for (const [id, policy, f, without, withApprovals] of EXAMPLES) {
      const v = evaluatePolicy(policy, f);
      expect(enforce(v, NONE), `${id} without approvals`).toEqual(without);
      expect(enforce(v, SATISFYING), `${id} with approvals`).toEqual(withApprovals);
      // The same approvers on an older commit: stale, so never current approvers, never counted.
      const count = countApprovals(
        ["alice", "bob"].map((login, i) => ({
          user: { id: i + 1, login, type: "User" },
          state: "APPROVED",
          commit_id: "b".repeat(40),
          submitted_at: "2026-10-14T10:00:00Z",
        })),
        { headSha: "a".repeat(40), prAuthorLogin: "author", truncated: false },
      );
      expect(count.stale).toBe(2);
      const stale: ApproverFacts = {
        ...SATISFYING,
        counted: count.currentApprovers,
      };
      expect(enforce(v, stale), `${id} with stale approvals only`).toEqual(without);
    }
  });

  it("U-ENF-2 missing and invalid policies fail whatever the approvals", () => {
    for (const approvers of [null, NONE, SATISFYING]) {
      for (const cardWait of [false, true]) {
        expect(
          enforcedConclusion({ state: "missing", verdict: null, approvers, cardWait }),
        ).toEqual({ conclusion: "failure", reason: "no_policy", constraints: [] });
        expect(
          enforcedConclusion({ state: "invalid", verdict: null, approvers, cardWait }),
        ).toEqual({ conclusion: "failure", reason: "policy_invalid", constraints: [] });
      }
    }
  });

  it("U-ENF-3 would_block wins over satisfying approvals and the card wait", () => {
    const v = evaluatePolicy(
      EXAMPLE,
      facts({ files: files("secrets/prod.env"), risk: card("sensitive"), author: agent() }),
    );
    expect(enforce(v, SATISFYING, true)).toEqual(failure("blocked"));
  });

  it("U-ENF-4 the card wait makes would_approve pending; without it, success", () => {
    const v = evaluatePolicy(EXAMPLE, facts({ files: files("docs/a.md"), risk: card("trivial") }));
    expect(enforce(v, NONE, true)).toEqual({ conclusion: "pending", reason: "card_pending" });
    expect(enforce(v, NONE, false)).toEqual(success("approved_by_policy"));
  });

  it("U-ENF-5 truncated reviews fail, even for would_approve", () => {
    const v = evaluatePolicy(EXAMPLE, facts({ files: files("docs/a.md"), risk: card("trivial") }));
    expect(enforce(v, { ...SATISFYING, reviewsTruncated: true })).toEqual(
      failure("reviews_truncated"),
    );
  });

  it("U-ENF-6 one change requester fails would_approve and a met would_require", () => {
    const approve = evaluatePolicy(
      EXAMPLE,
      facts({ files: files("docs/a.md"), risk: card("trivial") }),
    );
    const require = evaluatePolicy(
      EXAMPLE,
      facts({ files: files("infra/main.tf"), risk: card("sensitive"), author: agent() }),
    );
    expect(enforce(require, SATISFYING)).toEqual(success("requirements_met"));
    const requested = { ...SATISFYING, changesRequestedBy: ["carol"] };
    expect(enforce(approve, requested)).toEqual(failure("changes_requested"));
    expect(enforce(require, requested)).toEqual(failure("changes_requested"));
  });

  const C = (humans: number, teams: string[] = [], rules: number[] = [1]): Constraint => ({
    humans,
    teams,
    rules,
  });
  const requireVerdict = (constraints: Constraint[]): PolicyVerdict => ({
    outcome: "would_require",
    matched: [],
    effectiveRisk: { value: "logic", final: true, source: "card", raisedBy: [] },
    policyFileChanged: false,
    humans: Math.max(...constraints.map((c) => c.humans)),
    constraints,
    usedDefault: false,
    builtIn: null,
  });

  it("U-ENF-7 two constraints: one security member alone leaves anyone unmet; with a non-member both are met (D6)", () => {
    const constraints = [C(1, ["security"]), C(2)];
    const alone: ApproverFacts = {
      ...NONE,
      counted: [user("alice")],
      teams: { security: { members: ["alice"] } },
    };
    const s1 = satisfyConstraints(constraints, alone);
    expect(s1.map((s) => s.met)).toEqual([true, false]);
    expect(s1[1]?.approvedBy).toEqual(["alice"]);
    expect(enforce(requireVerdict(constraints), alone)).toEqual(failure("approvals_missing"));
    const both: ApproverFacts = { ...alone, counted: [user("alice"), user("zed")] };
    const s2 = satisfyConstraints(constraints, both);
    expect(s2.map((s) => s.met)).toEqual([true, true]);
    expect(s2[0]?.approvedBy).toEqual(["alice"]);
    expect(s2[1]?.approvedBy).toEqual(["alice", "zed"]);
    expect(enforce(requireVerdict(constraints), both)).toEqual(success("requirements_met"));
  });

  it("U-ENF-8 a team constraint whose only team is unverified is never met", () => {
    const reasons: Unverified[] = [
      "no_permission",
      "owner_not_org",
      "team_not_found",
      "team_unreadable",
      "check_limit",
    ];
    for (const why of reasons) {
      const a: ApproverFacts = {
        ...NONE,
        counted: Array.from({ length: 12 }, (_, i) => user(`u${i}`, i + 1)),
        teams: { infra: { unverified: why } },
      };
      const [s] = satisfyConstraints([C(1, ["infra"])], a);
      expect(s?.met, why).toBe(false);
      expect(s?.approvedCount, why).toBe(0);
      expect(s?.unverified, why).toEqual([{ team: "infra", why }]);
      expect(enforce(requireVerdict([C(1, ["infra"])]), a)).toEqual(failure("approvals_missing"));
    }
    // A team that was never looked up is unverified too.
    const [missing] = satisfyConstraints([C(1, ["infra"])], { ...NONE, counted: [user("a")] });
    expect(missing?.met).toBe(false);
  });

  it("U-ENF-9 a constraint with two teams is met by an approver in the second", () => {
    const a: ApproverFacts = {
      ...NONE,
      counted: [user("bob")],
      teams: { platform: { members: [] }, security: { members: ["Bob"] } },
    };
    const [s] = satisfyConstraints([C(1, ["platform", "security"])], a);
    expect(s).toMatchObject({ met: true, approvedBy: ["bob"], approvedCount: 1, unverified: [] });
  });

  it("U-ENF-9b approvedBy shows at most 10, met uses the full count", () => {
    const counted = Array.from({ length: 12 }, (_, i) =>
      user(`u${String(i).padStart(2, "0")}`, i + 1),
    );
    const [s] = satisfyConstraints([C(10)], { ...NONE, counted });
    expect(s?.approvedBy).toHaveLength(10);
    expect(s?.approvedCount).toBe(12);
    expect(s?.met).toBe(true);
  });

  it("U-ENF-10 property: more approvers never turn success into failure; a requester, a block or an unverified team never turn failure into success", () => {
    let seed = 0x2f6e2b1;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const POOL = ["a", "b", "c", "d", "e", "f"];
    const TEAMS = ["sec", "ops", "web"];
    const randomFacts = (): ApproverFacts => {
      const counted = POOL.filter(() => rnd(2) === 0).map((l, i) => user(l, i + 1));
      const teams: ApproverFacts["teams"] = {};
      for (const t of TEAMS) {
        teams[t] =
          rnd(5) === 0
            ? { unverified: "team_not_found" }
            : { members: POOL.filter(() => rnd(2) === 0) };
      }
      return { ...NONE, counted, teams };
    };
    const randomConstraints = (): Constraint[] =>
      Array.from({ length: 1 + rnd(3) }, () =>
        C(
          1 + rnd(3),
          TEAMS.filter(() => rnd(3) === 0),
        ),
      );
    const block: PolicyVerdict = {
      outcome: "would_block",
      matched: [],
      effectiveRisk: { value: "logic", final: true, source: "card", raisedBy: [] },
      policyFileChanged: false,
      blockedBy: [1],
    };
    for (let i = 0; i < 2000; i++) {
      const v = requireVerdict(randomConstraints());
      const a = randomFacts();
      const before = enforce(v, a).conclusion;
      // Add an approver (who may also join a team).
      const extra = POOL.find((l) => !a.counted.some((u) => u.login === l));
      if (extra !== undefined) {
        const teams = { ...a.teams };
        for (const t of TEAMS) {
          const e = teams[t];
          if (e && "members" in e && rnd(2) === 0) teams[t] = { members: [...e.members, extra] };
        }
        const more = { ...a, counted: [...a.counted, user(extra, 99)], teams };
        if (before === "success") expect(enforce(v, more).conclusion).toBe("success");
      }
      if (before === "failure") {
        expect(enforce(v, { ...a, changesRequestedBy: ["z"] }).conclusion).toBe("failure");
        expect(enforce(block, a).conclusion).toBe("failure");
        const t = TEAMS[rnd(TEAMS.length)] as string;
        const worse = { ...a, teams: { ...a.teams, [t]: { unverified: "check_limit" as const } } };
        expect(enforce(v, worse).conclusion).toBe("failure");
      }
    }
  });

  it("publishedCheck: report mode is always completed and neutral; enforce passes the conclusion through", () => {
    const all: Enforced[] = [
      { conclusion: "success", reason: "requirements_met", constraints: [] },
      { conclusion: "failure", reason: "blocked", constraints: [] },
      { conclusion: "pending", reason: "card_pending", constraints: [] },
    ];
    for (const e of all) {
      expect(publishedCheck("report", e)).toEqual({
        status: "completed",
        conclusion: "neutral",
        stored: "neutral",
      });
    }
    expect(publishedCheck("enforce", all[0] as Enforced)).toEqual({
      status: "completed",
      conclusion: "success",
      stored: "success",
    });
    expect(publishedCheck("enforce", all[1] as Enforced)).toMatchObject({ conclusion: "failure" });
    expect(publishedCheck("enforce", all[2] as Enforced)).toEqual({
      status: "in_progress",
      conclusion: null,
      stored: "pending",
    });
  });

  // Phase 1 step 3 (D5): a verified break-glass wins over every other rule.
  it("U-BG-1 breakGlass.applied: success break_glass for no_policy, policy_invalid, blocked, card wait, truncated reviews, change requests and missing approvals", () => {
    const BG = { applied: true } as const;
    const block = evaluatePolicy(
      EXAMPLE,
      facts({ files: files("secrets/prod.env"), risk: card("sensitive"), author: agent() }),
    );
    const approve = evaluatePolicy(
      EXAMPLE,
      facts({ files: files("docs/a.md"), risk: card("trivial") }),
    );
    const require = evaluatePolicy(
      EXAMPLE,
      facts({ files: files("infra/main.tf"), risk: card("sensitive"), author: agent() }),
    );
    const cases: [string, Parameters<typeof enforcedConclusion>[0]][] = [
      ["no_policy", { state: "missing", verdict: null, approvers: null, cardWait: false }],
      ["policy_invalid", { state: "invalid", verdict: null, approvers: null, cardWait: false }],
      ["blocked", { state: "ok", verdict: block, approvers: SATISFYING, cardWait: true }],
      ["card_pending", { state: "ok", verdict: approve, approvers: NONE, cardWait: true }],
      [
        "reviews_truncated",
        {
          state: "ok",
          verdict: approve,
          approvers: { ...SATISFYING, reviewsTruncated: true },
          cardWait: false,
        },
      ],
      [
        "changes_requested",
        {
          state: "ok",
          verdict: require,
          approvers: { ...SATISFYING, changesRequestedBy: ["carol"] },
          cardWait: false,
        },
      ],
      ["approvals_missing", { state: "ok", verdict: require, approvers: NONE, cardWait: false }],
    ];
    for (const [normal, input] of cases) {
      expect(enforcedConclusion(input).reason, normal).toBe(normal);
      const bypassed = enforcedConclusion({ ...input, breakGlass: BG });
      expect({ conclusion: bypassed.conclusion, reason: bypassed.reason }, normal).toEqual(
        success("break_glass"),
      );
    }
    // What was bypassed is still computed, so that the details can show it.
    const missing = enforcedConclusion({
      state: "ok",
      verdict: require,
      approvers: NONE,
      cardWait: false,
      breakGlass: BG,
    });
    expect(missing.constraints.length).toBeGreaterThan(0);
    expect(missing.constraints.every((c) => !c.met)).toBe(true);
  });

  it("U-BG-2 without break-glass (absent or null) every U-ENF case is unchanged", () => {
    const inputs: Parameters<typeof enforcedConclusion>[0][] = [];
    for (const [, policy, f] of EXAMPLES) {
      const verdict = evaluatePolicy(policy, f);
      for (const approvers of [NONE, SATISFYING, { ...SATISFYING, reviewsTruncated: true }]) {
        for (const cardWait of [false, true]) {
          inputs.push({ state: "ok", verdict, approvers, cardWait });
          inputs.push({
            state: "ok",
            verdict,
            approvers: { ...approvers, changesRequestedBy: ["carol"] },
            cardWait,
          });
        }
      }
    }
    for (const state of ["missing", "invalid"] as const) {
      inputs.push({ state, verdict: null, approvers: null, cardWait: false });
    }
    expect(inputs.length).toBeGreaterThan(100);
    for (const input of inputs) {
      const plain = enforcedConclusion(input);
      expect(plain.reason).not.toBe("break_glass");
      expect(enforcedConclusion({ ...input, breakGlass: null })).toEqual(plain);
      expect(enforcedConclusion({ ...input, breakGlass: undefined })).toEqual(plain);
    }
    // The U-ENF table itself, through the same helper as U-ENF-1.
    for (const [id, policy, f, without, withApprovals] of EXAMPLES) {
      const v = evaluatePolicy(policy, f);
      expect(enforce(v, NONE), id).toEqual(without);
      expect(enforce(v, SATISFYING), id).toEqual(withApprovals);
    }
  });

  it("T2 GRAFT_POLICY_CARD_WAIT_SECONDS: default 600, 0 to 3600, integers only", () => {
    const env = (v?: string) => ({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://x:y@localhost:5432/z",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
      GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
      ...(v === undefined ? {} : { GRAFT_POLICY_CARD_WAIT_SECONDS: v }),
    });
    expect(loadConfig(env()).policyCardWaitSeconds).toBe(600);
    expect(loadConfig(env("0")).policyCardWaitSeconds).toBe(0);
    expect(loadConfig(env("3600")).policyCardWaitSeconds).toBe(3600);
    for (const bad of ["3601", "-1", "1.5", "soon"]) {
      expect(() => loadConfig(env(bad)), bad).toThrow(/GRAFT_POLICY_CARD_WAIT_SECONDS/);
    }
  });
});
