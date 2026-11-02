import { describe, expect, it } from "vitest";
import { renderManagedComment } from "../../src/github/managed-comment.js";
import type { IntentView } from "../../src/modules/intent/render.js";
import { foldPolicySection, type PolicyView } from "../../src/modules/policy/render.js";
import { type HeadSignals, summarizeSignals } from "../../src/modules/policy/signals.js";
import {
  assess,
  renderSummarySection,
  type SummaryInput,
  summaryModel,
} from "../../src/modules/policy/summary.js";
import { enforcedConclusion } from "../../src/policy/enforce.js";
import { evaluatePolicy, type PolicyFacts } from "../../src/policy/evaluate.js";
import { parsePolicyText } from "../../src/policy/parse.js";
import type { AiReviewCheck } from "../../src/policy/schema.js";

const HEAD = "34290fb5d437cf42a36260e1705b6d341a7376cb";

const policy = (() => {
  const res = parsePolicyText(
    Buffer.from(
      [
        "version: 1",
        "default:",
        "  require: { humans: 1 }",
        "rules:",
        "  - name: agent-sensitive",
        "    match: { risk: sensitive, author: agent }",
        "    require: { humans: 2 }",
        "  - name: docs",
        "    match: { only_paths: ['docs/**'] }",
        "    approve: auto",
        "report:",
        "  ai_reviews:",
        "    - check: claude-review",
        "      model: claude",
      ].join("\n"),
    ),
  );
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.policy;
})();

/** A card like the one Graft wrote for an upload feature: sensitive, verified, 3 files cut. */
function card(over: Partial<IntentView> = {}): IntentView {
  return {
    id: "ef3cedc6-0000-4000-8000-000000000000",
    headSha: HEAD,
    promptVersion: "intent-v6",
    inputHash: "a".repeat(64),
    status: "ok",
    failureReason: null,
    retryable: false,
    card: {
      goal: "Lets users attach GPX, TCX, FIT files and photos in the web chat.",
      behaviorChanges: ["A new upload route accepts raw bytes up to 20 MB."],
      outOfScopeEdits: [],
      requested: [
        { item: "Attach GPX, TCX and FIT files in the web chat.", status: "done" },
        { item: "Attach shoe photos.", status: "done" },
        { item: "Telegram attachments.", status: "deferred" },
      ],
      intentMatch: "matches",
    },
    risk: {
      final: "sensitive",
      floor: "sensitive",
      floorReasons: [
        {
          rule: "configured_path",
          floor: "sensitive",
          paths: ["scripts/arc_chat.py", "scripts/arc_serve.py"],
          count: 2,
        },
        {
          rule: "partial_view",
          floor: "sensitive",
          paths: [
            "scripts/arc_chat.py",
            "scripts/arc_chat_upload.py",
            "tests/install/test_chat_attachments.py",
          ],
          count: 3,
        },
      ],
      writer: "sensitive",
      writerReason: "Adds a public upload endpoint that writes files to disk.",
      firstPass: null,
      verifier: "sensitive",
      raisedBy: [],
    },
    verifier: {
      status: "agree",
      claims: [
        { id: "goal", kind: "goal", verdict: "supported", reason: "ok" },
        { id: "b1", kind: "behavior_change", verdict: "supported", reason: "ok" },
      ],
      missing: ["Uploaded files are never purged and there is no total disk quota."],
      unexplained: [],
      failure: null,
    },
    instructionsInData: false,
    models: { writer: "claude-sonnet-5-5", firstPass: null, verifier: "claude-sonnet-5-5" },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2 },
    inputs: {
      filesTotal: 33,
      filesListed: 33,
      filesFull: 30,
      filesPartial: 3,
      filesOmitted: 0,
      omitted: [],
      linesAdded: 1780,
      linesDeleted: 31,
      truncated: false,
      linkedIssueNumber: 342,
    },
    ...over,
  };
}

const facts = (over: Partial<PolicyFacts> = {}): PolicyFacts => ({
  files: [{ path: "scripts/arc_chat_upload.py", previousPath: null }],
  listingComplete: true,
  size: { lines: 1811, files: 33 },
  risk: { value: "sensitive", final: true, source: "card" },
  author: { kind: "agent", agent: "claude-code" },
  labels: [],
  ...over,
});

function policyView(f: PolicyFacts = facts(), over: Partial<PolicyView> = {}): PolicyView {
  const verdict = evaluatePolicy(policy, f);
  const approvers = {
    counted: [],
    notCounted: [],
    changesRequestedBy: [],
    teams: {},
    reviewsTruncated: false,
  };
  return {
    state: "ok",
    owner: "acme",
    baseRef: "main",
    commitSha: "0c68dfa".padEnd(40, "0"),
    headSha: HEAD,
    fileSha: "f".repeat(40),
    hash: "0".repeat(64),
    policy,
    verdict,
    facts: f,
    approvals: null,
    errors: [],
    addsPolicyFile: false,
    mode: { effective: "report" },
    approvers,
    enforced: enforcedConclusion({
      state: "ok",
      verdict,
      approvers,
      cardWait: false,
      breakGlass: null,
    }),
    ...over,
  };
}

const REVIEWS: AiReviewCheck[] = [
  { check: "claude-review", model: "claude", app: "github-actions", trustConclusion: false },
];

function signals(
  results: { name: string; state: "passed" | "failed" | "pending" | "other" }[],
  reviews: AiReviewCheck[] = REVIEWS,
): HeadSignals {
  return summarizeSignals(
    HEAD,
    results.map((r) => ({ ...r, app: "github-actions" })),
    reviews,
    false,
  );
}

const ci = (passed: number, extra: { name: string; state: "failed" | "pending" }[] = []) => [
  ...Array.from({ length: passed }, (_, i) => ({ name: `job ${i + 1}`, state: "passed" as const })),
  ...extra,
];

function input(over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    headSha: HEAD,
    card: card(),
    policy: policyView(),
    signals: signals([
      ...ci(15, [{ name: "macos-latest · A 1/2", state: "pending" }]),
      { name: "claude-review", state: "passed" },
    ]),
    author: { kind: "agent", model: "claude-sonnet-5-5" },
    ...over,
  };
}

describe("review summary", () => {
  it("U-SUM-1 the upload example renders byte for byte", () => {
    expect(renderSummarySection(input())).toBe(
      [
        "> [!WARNING]",
        "> **Needs human review** · 3 things to check · 2 approvals needed",
        "",
        "| 🎯 Intent | 🛡️ Risk | 🧪 CI | 🤖 AI review | 👥 Approvals |",
        "| :---: | :---: | :---: | :---: | :---: |",
        "| ✅ **Matches** | 🟠 **Sensitive** | ⏳ **15/16 running** | ➖ **Ran** | 🟠 **0/2** |",
        "",
        "**Before you merge**",
        "",
        "- 👀 **Not read in full by Graft** · `scripts/arc_chat.py`, `scripts/arc_chat_upload.py`, `tests/install/test_chat_attachments.py`: check these files yourself.",
        "- ➕ **Also changed, not in the description** · Uploaded files are never purged and there is no total disk quota.",
        "- 🛡️ **Sensitive files** · configured sensitive path (`scripts/arc_chat.py`, `scripts/arc_serve.py`)",
        "",
        "<details><summary>Why this verdict</summary>",
        "",
        "- **Matches the intent?** ✅ **Yes.** Does what issue #342 asks. 1 change not in the description. 1 item left for later on purpose.",
        "- **Safe to merge?** ⚠️ **Not without a human review.** Risk `sensitive`: Adds a public upload endpoint that writes files to disk. **CI:** 15 of 16 passed, 1 still running. **AI review `claude-review`** on `34290fb`: ran (its check does not say whether it found issues); same model family as the author. **Graft:** 2 of 2 claims supported, 3 files not read in full.",
        "- **Human review:** **2 approvals needed** · 0 so far · *report mode: Graft blocks nothing*",
        "",
        "</details>",
        "",
        "---",
      ].join("\n"),
    );
  });

  it("U-SUM-1b with a card image, the card replaces the gate table", () => {
    const out = renderSummarySection(input(), {
      cardImage: (m) => `<picture>${m.gates.map((g) => g.value).join("|")}</picture>`,
    });
    expect(out).toContain("<picture>Matches|Sensitive|15/16 running|Ran|0/2</picture>");
    expect(out).not.toContain("| 🎯 Intent |");
    expect(summaryModel(input()).gates.map((g) => g.status)).toEqual([
      "ok",
      "warn",
      "running",
      "neutral",
      "warn",
    ]);
  });

  it("U-SUM-2 a sensitive change is never safe, whatever CI and AI reviews say", () => {
    const trusted: AiReviewCheck[] = [
      { check: "review", model: "gpt", app: "github-actions", trustConclusion: true },
    ];
    const i = input({
      signals: signals([...ci(3), { name: "review", state: "passed" }], trusted),
    });
    expect(assess(i)).toBe("orange");
    expect(renderSummarySection(i)).toContain("⚠️ **Not without a human review.**");
  });

  it("U-SUM-3 logic: low risk only with green CI and an independent review that reports no issues", () => {
    const logic = (r: Partial<SummaryInput>) =>
      input({
        card: card({ risk: { ...card().risk, final: "logic", floor: "logic", floorReasons: [] } }),
        policy: policyView(facts({ risk: { value: "logic", final: true, source: "card" } })),
        ...r,
      });
    const gpt: AiReviewCheck[] = [
      { check: "review", model: "gpt", app: "github-actions", trustConclusion: true },
    ];
    const claude: AiReviewCheck[] = [
      { check: "review", model: "claude", app: "github-actions", trustConclusion: true },
    ];
    const untrusted: AiReviewCheck[] = [
      { check: "review", model: "gpt", app: "github-actions", trustConclusion: false },
    ];
    const clean = [...ci(4), { name: "review", state: "passed" as const }];
    expect(assess(logic({ signals: signals(clean, gpt) }))).toBe("green");
    expect(renderSummarySection(logic({ signals: signals(clean, gpt) }))).toMatch(
      /^> \[!TIP\]\n> \*\*Low risk\*\*/,
    );
    // Same family as the author, no verdict in the conclusion, or no review: a normal review.
    expect(assess(logic({ signals: signals(clean, claude) }))).toBe("yellow");
    expect(assess(logic({ signals: signals(clean, untrusted) }))).toBe("yellow");
    expect(assess(logic({ signals: signals(ci(4), []) }))).toBe("yellow");
    // The author's model is unknown: independence cannot be shown.
    expect(
      assess(logic({ signals: signals(clean, gpt), author: { kind: "agent", model: null } })),
    ).toBe("yellow");
    // A human author: any review is independent.
    expect(
      assess(logic({ signals: signals(clean, claude), author: { kind: "human", model: null } })),
    ).toBe("green");
    // CI still running holds it at yellow.
    const running = [
      ...ci(3, [{ name: "e2e", state: "pending" }]),
      { name: "review", state: "passed" as const },
    ];
    expect(assess(logic({ signals: signals(running, gpt) }))).toBe("yellow");
    // Checks not read: never green.
    expect(assess(logic({ signals: null }))).toBe("yellow");
  });

  it("U-SUM-4 trivial with green CI is safe to merge", () => {
    const i = input({
      card: card({
        risk: { ...card().risk, final: "trivial", floor: "trivial", floorReasons: [] },
        verifier: { ...card().verifier, missing: [] },
        inputs: { ...card().inputs, filesPartial: 0 },
      }),
      policy: policyView(
        facts({
          files: [{ path: "docs/a.md", previousPath: null }],
          risk: { value: "trivial", final: true, source: "card" },
        }),
      ),
      signals: signals(ci(2), []),
    });
    expect(assess(i)).toBe("green");
    const out = renderSummarySection(i);
    expect(out).toMatch(/^> \[!TIP\]\n> \*\*Safe to merge\*\* · no approval needed\n/);
    expect(out).toContain("- **Human review:** **None required** by the policy");
    expect(out).not.toContain("Where to look");
  });

  it("U-SUM-5 red: failing CI, an AI review that found issues, a contradicted card, injected text", () => {
    const failing = input({
      signals: signals(ci(2, [{ name: "unit @octocat", state: "failed" }])),
    });
    expect(assess(failing)).toBe("red");
    const out = renderSummarySection(failing);
    expect(out).toMatch(/^> \[!CAUTION\]\n> \*\*Don't merge yet\*\*/);
    expect(out).toContain("- 🧪 **CI fails** · `unit @octocat`: fix it before merging.");
    expect(out).toContain("**CI:** 1 of 3 failing (`unit @octocat`).");

    const trusted: AiReviewCheck[] = [
      { check: "review", model: "gpt", app: "github-actions", trustConclusion: true },
    ];
    const issues = input({
      signals: signals([...ci(2), { name: "review", state: "failed" }], trusted),
    });
    expect(assess(issues)).toBe("red");
    expect(renderSummarySection(issues)).toContain(
      "- 🤖 **AI review found issues** · `review`: read its comments.",
    );

    const wrong = input({
      card: card({
        verifier: {
          ...card().verifier,
          status: "disagree",
          claims: [
            { id: "goal", kind: "goal", verdict: "supported", reason: "ok" },
            {
              id: "b1",
              kind: "behavior_change",
              verdict: "contradicted",
              reason: "Caps at 10 MB.",
            },
          ],
        },
      }),
    });
    expect(assess(wrong)).toBe("red");
    const w = renderSummarySection(wrong);
    expect(w).toContain(
      "- **Matches the intent?** ❌ **The card does not match the diff.** Read the diff instead of the card.",
    );
    expect(w).toContain(
      "- ❌ **The card is wrong** · Behavior change 1 is contradicted: Caps at 10 MB.",
    );

    const injected = input({ card: card({ instructionsInData: true }) });
    expect(assess(injected)).toBe("red");
    expect(renderSummarySection(injected)).toContain("**Text addressed to AI reviewers**");
  });

  it("U-SUM-6 intent: partial, differs, unknown, an older card, and a card for another head", () => {
    const withMatch = (
      intentMatch: NonNullable<IntentView["card"]>["intentMatch"],
      requested = card().card?.requested ?? [],
    ) =>
      input({
        card: card({
          card: { ...(card().card as NonNullable<IntentView["card"]>), intentMatch, requested },
        }),
      });
    const partial = withMatch("partial", [
      { item: "Attach files.", status: "done" },
      { item: "Attach photos.", status: "missing" },
      { item: "Telegram.", status: "deferred" },
    ]);
    const p = renderSummarySection(partial);
    expect(p).toContain("⚠️ **Partly.** 1 of 2 requested items done.");
    expect(p).toContain("- 🎯 **Asked, not done** · Attach photos.");
    expect(assess(withMatch("differs"))).toBe("red");
    expect(renderSummarySection(withMatch("differs"))).toContain(
      "❌ **No.** The change does something other than what issue #342 asks.",
    );
    expect(renderSummarySection(withMatch("unknown", []))).toContain(
      "❔ **Unknown.** Neither a linked issue nor the description says what was wanted.",
    );
    expect(renderSummarySection(withMatch(null, []))).toContain(
      "➖ **Not checked.** This card was written before Graft compared intent and diff.",
    );
    const old = input({ card: card({ headSha: "0".repeat(40) }) });
    expect(assess(old)).toBe("pending");
    expect(renderSummarySection(old)).toMatch(
      /^> \[!NOTE\]\n> \*\*Graft is still reviewing\*\* · 2 approvals needed\n/,
    );
  });

  it("U-SUM-7 human review: no policy, met approvals, teams in code spans, blocked", () => {
    const missing = input({ policy: { ...policyView(), state: "missing", verdict: null } });
    expect(renderSummarySection(missing)).toContain(
      "- **Human review:** No `graft.yaml` on `main`: Graft does not ask for approvals.",
    );
    const met = input({
      policy: policyView(facts(), {
        enforced: { conclusion: "success", reason: "requirements_met", constraints: [] },
        approvers: {
          counted: [
            { id: 1, login: "alice" },
            { id: 2, login: "bob" },
          ],
          notCounted: [],
          changesRequestedBy: [],
          teams: {},
          reviewsTruncated: false,
        },
      }),
    });
    const m = renderSummarySection(met);
    expect(m).toContain("✅ **Required approvals present** (2 of 2)");
    expect(m).toMatch(
      /^> \[!WARNING\]\n> \*\*Needs human review\*\* · 3 things to check · approvals in\n/,
    );
    const team = parsePolicyText(
      Buffer.from(
        "version: 1\nrules:\n  - match: { risk: sensitive }\n    require: { humans: 1, team: security }\n",
      ),
    );
    if (!team.ok) throw new Error(JSON.stringify(team.errors));
    const f = facts();
    const tv = input({
      policy: { ...policyView(f), policy: team.policy, verdict: evaluatePolicy(team.policy, f) },
    });
    expect(renderSummarySection(tv)).toContain("**1 approval needed** (1 from `@acme/security`)");
    expect(renderSummarySection(tv)).not.toMatch(/(^|[^`])@acme/);
  });

  it("U-SUM-8 model text is escaped and the summary never holds a graft marker", () => {
    const evil = card({
      risk: { ...card().risk, writerReason: "<!-- graft:section:x:start --> @octocat <img>" },
      verifier: { ...card().verifier, missing: ["@octocat <script>"] },
    });
    const out = renderSummarySection(input({ card: evil }));
    expect(out).not.toContain("<!--");
    expect(out).not.toMatch(/@octocat/);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img>");
  });
});

describe("review summary: what is trusted", () => {
  const gpt = (over: Partial<AiReviewCheck> = {}): AiReviewCheck[] => [
    { check: "review", model: "gpt", app: "github-actions", trustConclusion: true, ...over },
  ];
  const logic = (r: Partial<SummaryInput>, c: IntentView = card()) =>
    input({
      card: {
        ...c,
        risk: {
          ...c.risk,
          final: "logic",
          floor: "logic",
          floorReasons: c.risk.floorReasons.filter((f) => f.rule === "ci_config"),
        },
      },
      policy: policyView(facts({ risk: { value: "logic", final: true, source: "card" } })),
      ...r,
    });
  const clean = [...ci(4), { name: "review", state: "passed" as const }];

  it("U-SUM-9 a review bound to an app ignores a same-named result from anything else", () => {
    const s = summarizeSignals(
      HEAD,
      [
        { name: "review", state: "passed", app: "evil-app" },
        { name: "review", state: "passed", app: null },
        { name: "build", state: "passed", app: "github-actions" },
      ],
      gpt({ app: "coderabbitai" }),
      false,
    );
    expect(s.aiReviews).toEqual([]);
    expect(s.ci.passed).toBe(1);
  });

  it("U-SUM-10 no app in graft.yaml, or a PR that changes CI: the conclusion is not a verdict", () => {
    expect(assess(logic({ signals: signals(clean, gpt()) }))).toBe("green");
    const noApp = logic({ signals: signals(clean, gpt({ app: null })) });
    expect(assess(noApp)).toBe("yellow");
    expect(renderSummarySection(noApp)).toContain(
      "ran (no publishing app is set for it in graft.yaml, so anyone could post it)",
    );
    const ciCard = card({
      risk: {
        ...card().risk,
        floorReasons: [
          { rule: "ci_config", floor: "sensitive", paths: [".github/workflows/r.yml"], count: 1 },
        ],
      },
    });
    const ciChanged = logic({ signals: signals(clean, gpt()) }, ciCard);
    expect(assess(ciChanged)).toBe("yellow");
    expect(renderSummarySection(ciChanged)).toContain(
      "this pull request changes CI configuration, which could change the review itself",
    );
  });

  it("U-SUM-11 the family in the agent name, or a disputed model, is not independent", () => {
    const claude = gpt({ model: "claude" });
    expect(
      assess(
        logic({
          signals: signals(clean, claude),
          author: { kind: "agent", model: "gpt-9", agent: "claude-code" },
        }),
      ),
    ).toBe("yellow");
    expect(
      assess(
        logic({
          signals: signals(clean, gpt()),
          author: { kind: "agent", model: "o5", modelDisputed: true },
        }),
      ),
    ).toBe("yellow");
    expect(
      assess(
        logic({
          signals: signals(clean, gpt()),
          author: { kind: "agent", model: "claude-opus-5-5", agent: "claude-code" },
        }),
      ),
    ).toBe("green");
  });
});

describe("head signals", () => {
  it("U-SIG-1 AI review checks are split from CI; failures and pending win for one name", () => {
    const s = summarizeSignals(
      HEAD,
      [
        { name: "build", state: "passed", app: "github-actions" },
        { name: "lint", state: "failed", app: "github-actions" },
        { name: "e2e", state: "pending", app: "github-actions" },
        { name: "skipped", state: "other", app: "github-actions" },
        { name: "claude-review", state: "passed", app: "github-actions" },
        { name: "claude-review", state: "pending", app: "github-actions" },
      ],
      [
        { check: "claude-review", model: "claude", app: "github-actions", trustConclusion: true },
        { check: "absent", model: "gpt", app: "github-actions", trustConclusion: true },
      ],
      false,
    );
    expect(s.ci).toEqual({
      passed: 1,
      failed: 1,
      pending: 1,
      failing: ["lint"],
      incomplete: false,
    });
    expect(s.aiReviews).toEqual([
      {
        check: "claude-review",
        model: "claude",
        app: "github-actions",
        trustConclusion: true,
        state: "pending",
      },
    ]);
  });
});

describe("policy fold", () => {
  it("U-FOLD-1 the comment folds the policy section under a plain summary; the check keeps it", () => {
    const section = "### Policy\n\n**Would require 2 humans** · report only\n\nfooter";
    expect(foldPolicySection(policyView(), section)).toBe(
      "<details><summary>👥 Policy · why 2 humans (report only)</summary>\n\n**Would require 2 humans** · report only\n\nfooter\n\n</details>",
    );
    expect(
      foldPolicySection({ ...policyView(), state: "missing", verdict: null }, section),
    ).toContain("<summary>👥 Policy · no graft.yaml</summary>");
  });

  it("U-FOLD-2 the summary comes first in the managed comment", () => {
    const body = renderManagedComment(
      new Map([
        ["policy", "P"],
        ["intent", "I"],
        ["summary", "S"],
        ["provenance", "V"],
      ]),
    );
    const order = ["summary", "intent", "provenance", "policy"].map((n) =>
      body.indexOf(`<!-- graft:section:${n}:start -->`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
