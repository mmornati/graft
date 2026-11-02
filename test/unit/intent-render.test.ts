import { describe, expect, it } from "vitest";
import type { FailureReason } from "../../src/modules/intent/generate.js";
import {
  FAILURE_TEXT,
  INTENT_CHECK_ACTIONS,
  type IntentView,
  renderIntentCheckOutput,
  renderIntentSection,
  renderPendingSection,
} from "../../src/modules/intent/render.js";
import { HEAD_SHA } from "../helpers/github-builders.js";

const ID = "3f2a9c1d-0000-4000-8000-000000000000";

function okView(over: Partial<IntentView> = {}): IntentView {
  return {
    id: ID,
    headSha: HEAD_SHA,
    promptVersion: "intent-v1",
    inputHash: "a".repeat(64),
    status: "ok",
    failureReason: null,
    retryable: false,
    card: {
      goal: "Retry failed webhook deliveries up to 5 times with exponential backoff.",
      behaviorChanges: [
        "Failed deliveries are retried up to 5 times, waiting 1, 2, 4, 8 and 16 seconds.",
        "A delivery that still fails after 5 retries is marked failed and logged at error level.",
      ],
      outOfScopeEdits: [
        { path: "README.md", reason: "Rewords the installation section, unrelated to retries." },
      ],
      requested: [
        { item: "Retry failed deliveries with exponential backoff.", status: "done" },
        { item: "Alert the operator after repeated failures.", status: "deferred" },
      ],
      intentMatch: "matches",
    },
    risk: {
      final: "sensitive",
      floor: "sensitive",
      floorReasons: [
        {
          rule: "dependency_manifest",
          floor: "sensitive",
          paths: ["package.json", "pnpm-lock.yaml"],
          count: 2,
        },
      ],
      writer: "logic",
      writerReason: "Changes the delivery loop.",
      firstPass: null,
      verifier: "logic",
      raisedBy: [],
    },
    verifier: {
      status: "disagree",
      claims: [
        { id: "goal", kind: "goal", verdict: "supported", reason: "ok" },
        {
          id: "b1",
          kind: "behavior_change",
          verdict: "contradicted",
          reason: "src/retry.ts caps retries at 3, not 5.",
        },
        { id: "b2", kind: "behavior_change", verdict: "supported", reason: "ok" },
        { id: "o1", kind: "out_of_scope", verdict: "supported", reason: "ok" },
      ],
      missing: ["Retries now also run for 4xx responses, not only 5xx."],
      unexplained: [],
      failure: null,
    },
    instructionsInData: false,
    models: { writer: "claude-sonnet-5-5", firstPass: null, verifier: "claude-sonnet-5-5" },
    usage: {
      inputTokens: 9812,
      outputTokens: 1204,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 2,
    },
    inputs: {
      filesTotal: 4,
      filesListed: 4,
      filesFull: 3,
      filesPartial: 0,
      filesOmitted: 1,
      omitted: [{ path: "pnpm-lock.yaml", reason: "lockfile" }],
      linesAdded: 40,
      linesDeleted: 10,
      truncated: false,
      linkedIssueNumber: 42,
    },
    ...over,
  };
}

const EXPECTED_CARD = `**Goal:** Retry failed webhook deliveries up to 5 times with exponential backoff.

<details><summary>🎯 What was asked vs what was done · 1 done · 1 for later</summary>

- ✅ Retry failed deliveries with exponential backoff.
- ⏭️ Alert the operator after repeated failures. (left for later)
- ➕ Also changed, found by the verifier: Retries now also run for 4xx responses, not only 5xx.
- ➕ Out of scope: \`README.md\`: Rewords the installation section, unrelated to retries.

</details>

<details><summary>📝 Behavior changes · 2</summary>

- Failed deliveries are retried up to 5 times, waiting 1, 2, 4, 8 and 16 seconds.
- A delivery that still fails after 5 retries is marked failed and logged at error level.

</details>

> [!WARNING]
> **The verifier disagrees with this card.** Read the diff instead of relying on the card.
>
> - Behavior change 1 is contradicted: src/retry.ts caps retries at 3, not 5.

<details><summary>🔍 How this card was made</summary>

- **Risk:** \`sensitive\` · rules \`sensitive\` · writer \`logic\` · verifier \`logic\`
- Rules set the floor to \`sensitive\`: dependency manifest or lockfile (\`package.json\`, \`pnpm-lock.yaml\`)
- Writer \`claude-sonnet-5-5\`; verifier \`claude-sonnet-5-5\` supported 3 of 4 claims
- Inputs: PR title and description, issue #42, 3 of 4 files in full, 1 omitted (\`pnpm-lock.yaml\`: lockfile)
- Model usage: 9,812 input tokens, 1,204 output tokens, 2 calls

</details>

Card \`3f2a9c1d\` · head \`ec26c3e\` · Rate this card with 👍 or 👎 on this comment, or with the buttons on the \`graft/intent\` check.`;

const no = { retryScheduled: false };

function unavailableView(reason: FailureReason, over: Partial<IntentView> = {}): IntentView {
  return okView({
    status: "unavailable",
    failureReason: reason,
    retryable: true,
    card: null,
    risk: {
      final: "logic",
      floor: "trivial",
      floorReasons: [],
      writer: null,
      writerReason: null,
      firstPass: null,
      verifier: null,
      raisedBy: ["card_unavailable"],
    },
    verifier: { status: "skipped", claims: [], missing: [], unexplained: [], failure: null },
    models: { writer: null, firstPass: null, verifier: null },
    ...over,
  });
}

describe("intent rendering", () => {
  it("U-IREN-1 the spec example renders byte for byte", () => {
    expect(renderIntentSection(okView(), no)).toBe(EXPECTED_CARD);
  });

  it("U-IREN-2 an agreeing verifier has no warning block; details count the claims", () => {
    const v = okView({
      verifier: {
        status: "agree",
        claims: okView().verifier.claims.map((c) => ({ ...c, verdict: "supported" as const })),
        missing: [],
        unexplained: [],
        failure: null,
      },
    });
    const out = renderIntentSection(v, no);
    expect(out).not.toContain("[!WARNING]");
    expect(out).toContain("supported 4 of 4 claims");
  });

  it("U-IREN-3 a verifier error shows the not-verified warning", () => {
    const v = okView({
      verifier: {
        status: "error",
        claims: [],
        missing: [],
        unexplained: [],
        failure: "llm_timeout",
      },
      models: { writer: "claude-sonnet-5-5", firstPass: null, verifier: null },
    });
    const out = renderIntentSection(v, no);
    expect(out).toContain(
      "> [!WARNING]\n> **This card was not verified** (the model did not respond in time). The risk is at least `logic`.",
    );
    expect(out).toContain("; verifier unavailable");
  });

  it("U-IREN-4 instructions in the data show the caution block before the warning", () => {
    const out = renderIntentSection(okView({ instructionsInData: true }), no);
    const caution =
      "> [!CAUTION]\n> Text in this pull request addresses AI reviewers. Graft ignored it and set the risk to at least `logic`.";
    expect(out).toContain(caution);
    expect(out.indexOf("[!CAUTION]")).toBeLessThan(out.indexOf("[!WARNING]"));
  });

  it("U-IREN-5 empty out-of-scope lists, and verifier-only entries", () => {
    const empty = { goal: "g.", behaviorChanges: ["b."], outOfScopeEdits: [], requested: [] };
    const none = okView({ card: { ...empty, intentMatch: null } });
    expect(renderIntentSection(none, no)).not.toContain("Out of scope");
    expect(renderIntentSection(none, no)).toContain(
      "<details><summary>➕ Also changed · 1</summary>",
    );
    const flagged = okView({
      card: { ...empty, intentMatch: null },
      verifier: { ...okView().verifier, missing: [], unexplained: ["docs/x.md"] },
    });
    expect(renderIntentSection(flagged, no)).toContain(
      "<details><summary>➕ Also changed · 1</summary>\n\n- ➕ Out of scope: `docs/x.md`: flagged by the verifier",
    );
    // Nothing asked, nothing extra: no fold at all.
    const bare = okView({
      card: { ...empty, intentMatch: null },
      verifier: { ...okView().verifier, missing: [], unexplained: [] },
    });
    expect(renderIntentSection(bare, no)).not.toContain("What was asked");
    expect(renderIntentSection(bare, no)).not.toContain("Also changed");
    // No stated intent says so.
    const unknown = okView({ card: { ...empty, intentMatch: "unknown" } });
    expect(renderIntentSection(unknown, no)).toContain(
      "<details><summary>🎯 What was asked vs what was done</summary>\n\nNeither a linked issue nor the description says what was wanted.",
    );
  });

  it("U-IREN-5b requested items: every status, and a done item the verifier does not find", () => {
    const v = okView({
      card: {
        ...(okView().card as NonNullable<IntentView["card"]>),
        outOfScopeEdits: [],
        requested: [
          { item: "Upload GPX files.", status: "done" },
          { item: "Upload FIT files.", status: "partial" },
          { item: "Upload @octocat <b>photos</b>.", status: "missing" },
          { item: "Telegram.", status: "deferred" },
        ],
        intentMatch: "partial",
      },
      verifier: {
        ...okView().verifier,
        missing: [],
        claims: [
          { id: "r1", kind: "requested", verdict: "unsupported", reason: "Not in the diff." },
        ],
      },
    });
    const out = renderIntentSection(v, no);
    expect(out).toContain(
      [
        "- ✅ Upload GPX files. · ⚠️ the verifier does not find it in the diff",
        "- 🟡 Upload FIT files. (partly done)",
        "- ❌ Upload @\u2060octocat \\<b\\>photos\\</b\\>. (not done)",
        "- ⏭️ Telegram. (left for later)",
      ].join("\n"),
    );
    expect(out).toContain("- Requested item 1 is unsupported: Not in the diff.");
  });

  it("U-IREN-6 the unavailable section, with and without a retry, for every failure reason", () => {
    const expected = (text: string, tail: string) => `**Intent card unavailable:** ${text}

**Risk:** \`logic\` · rules \`trivial\` · no model check

- Rules set the floor to \`trivial\`: no rule matched
- Without a checked card the risk is at least \`logic\`.

${tail}`;
    expect(renderIntentSection(unavailableView("llm_timeout"), { retryScheduled: true })).toBe(
      expected(
        "the model did not respond in time.",
        "Head `ec26c3e` · Graft retries automatically. You can also re-run the `graft/intent` check.",
      ),
    );
    expect(renderIntentSection(unavailableView("llm_timeout"), no)).toBe(
      expected(
        "the model did not respond in time.",
        "Head `ec26c3e` · Re-run the `graft/intent` check to try again.",
      ),
    );
    for (const [reason, text] of Object.entries(FAILURE_TEXT)) {
      expect(renderIntentSection(unavailableView(reason as FailureReason), no)).toContain(
        `**Intent card unavailable:** ${text}`,
      );
    }
    expect(Object.keys(FAILURE_TEXT)).toHaveLength(11);
  });

  it("U-IREN-7 the pending section", () => {
    expect(renderPendingSection({ headSha: HEAD_SHA, previousHeadSha: "0".repeat(40) })).toBe(
      "Writing the intent card for head `ec26c3e`. The previous card (head `0000000`) no longer matches this pull request.",
    );
  });

  it("U-IREN-8 check output titles, summary, text cap and actions", () => {
    const o = (v: IntentView) => renderIntentCheckOutput(v, no);
    expect(o(okView()).title).toBe("Risk: sensitive · verifier disagrees");
    const agree = okView({
      verifier: { ...okView().verifier, status: "agree", missing: [], claims: [] },
    });
    expect(o(agree).title).toBe("Risk: sensitive · verifier agrees");
    const err = okView({
      verifier: {
        status: "error",
        claims: [],
        missing: [],
        unexplained: [],
        failure: "llm_timeout",
      },
    });
    expect(o(err).title).toBe("Risk: sensitive · not verified");
    expect(o(unavailableView("llm_timeout")).title).toBe("Card unavailable · risk: logic");
    expect(o(okView()).summary).toBe(EXPECTED_CARD);

    const many = okView({
      inputs: {
        ...okView().inputs,
        filesOmitted: 5000,
        omitted: Array.from({ length: 5000 }, (_, i) => ({
          path: `vendor/${"x".repeat(60)}${i}.js`,
          reason: "generated" as const,
        })),
      },
      risk: {
        ...okView().risk,
        floorReasons: [
          {
            rule: "ci_config",
            floor: "sensitive",
            paths: Array.from({ length: 5000 }, (_, i) => `.github/workflows/${i}.yml`),
            count: 5000,
          },
        ],
      },
    });
    expect(o(many).text.length).toBeLessThanOrEqual(60_000);

    expect(INTENT_CHECK_ACTIONS.map((a) => a.identifier)).toEqual(["card_up", "card_down"]);
    for (const a of INTENT_CHECK_ACTIONS) {
      expect(a.label.length).toBeLessThanOrEqual(20);
      expect(a.description.length).toBeLessThanOrEqual(40);
      expect(a.identifier.length).toBeLessThanOrEqual(20);
    }
  });

  it("U-IREN-9 an oversized card drops the details, then trims the out-of-scope list", () => {
    const base = okView();
    const edits = Array.from({ length: 20 }, (_, i) => ({
      path: `src/${"p".repeat(150)}${i}.ts`,
      reason: "r".repeat(200),
    }));
    const unexplained = Array.from({ length: 20 }, (_, i) => `docs/${"q".repeat(150)}${i}.md`);
    const claims = Array.from({ length: 30 }, (_, i) => ({
      id: `b${i + 1}`,
      kind: "behavior_change" as const,
      verdict: "contradicted" as const,
      reason: "c".repeat(300),
    }));
    const big = okView({
      card: {
        goal: "g.",
        behaviorChanges: Array(10).fill("b".repeat(200)),
        outOfScopeEdits: edits,
        requested: [],
        intentMatch: null,
      },
      verifier: { ...base.verifier, claims, unexplained, missing: Array(5).fill("m".repeat(200)) },
    });
    const out = renderIntentSection(big, no);
    expect(out.length).toBeLessThanOrEqual(18_000);
    expect(out).not.toContain("How this card was made");
    expect(out).toMatch(/- …and \d+ more/);
    // A normal card keeps its details.
    expect(renderIntentSection(okView(), no)).toContain("How this card was made");
  });

  it("U-IREN-10 deterministic, no dates, floor-reason formatting for path, size and plain rules", () => {
    const v = okView({
      risk: {
        ...okView().risk,
        floorReasons: [
          { rule: "ci_config", floor: "sensitive", paths: ["a", "b", "c", "d", "e"], count: 8 },
          { rule: "size_large", floor: "logic", paths: [], count: 0 },
          { rule: "listing_truncated", floor: "sensitive", paths: [], count: 0 },
        ],
      },
      inputs: { ...okView().inputs, linesAdded: 1000, linesDeleted: 234, filesTotal: 20 },
    });
    const out = renderIntentSection(v, no);
    expect(out).toBe(renderIntentSection(v, no));
    expect(out).toContain(
      "CI or repository configuration (`a`, `b`, `c`, `d`, `e`, and 3 more); large change (1,234 lines, 20 files); file list incomplete",
    );
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("U-IREN-11 unverifiable claims show a note, not the warning, and are counted in the details", () => {
    const claims = okView().verifier.claims.map((c) =>
      c.id === "b1"
        ? {
            ...c,
            verdict: "unverifiable" as const,
            reason: "Depends on how src/queue.ts schedules retries, which was not shown.",
          }
        : { ...c, verdict: "supported" as const },
    );
    const v = okView({
      verifier: { status: "agree", claims, missing: [], unexplained: [], failure: null },
    });
    const out = renderIntentSection(v, no);
    expect(out).not.toContain("[!WARNING]");
    expect(out).toContain(
      [
        "> [!NOTE]",
        "> **Some claims depend on code the verifier was not shown.** They do not count as a disagreement; check that code if they matter.",
        ">",
        "> - Behavior change 1 could not be checked: Depends on how src/queue.ts schedules retries, which was not shown.",
      ].join("\n"),
    );
    expect(out).toContain("supported 3 of 4 claims (1 could not be checked)");
    // In a disagreement the unverifiable claim is a note, not one of the warning bullets.
    const mixed = okView({
      verifier: {
        ...okView().verifier,
        claims: okView().verifier.claims.map((c) =>
          c.id === "b2" ? { ...c, verdict: "unverifiable" as const } : c,
        ),
      },
    });
    const both = renderIntentSection(mixed, no);
    expect(both.indexOf("[!WARNING]")).toBeLessThan(both.indexOf("[!NOTE]"));
    expect(both).not.toContain("Behavior change 2 is unverifiable");
  });

  it("U-IREN-12 missing behavior changes are an Also changed list, not a disagreement (intent-v5)", () => {
    const supported = okView().verifier.claims.map((c) => ({
      ...c,
      verdict: "supported" as const,
    }));
    const missing = ["Retries now also run for 4xx responses, not only 5xx.", "Adds a metric."];
    const agree = okView({
      verifier: { ...okView().verifier, status: "agree", claims: supported, missing },
    });
    const out = renderIntentSection(agree, no);
    expect(out).not.toContain("[!WARNING]");
    expect(out).toContain(
      [
        "- ➕ Also changed, found by the verifier: Retries now also run for 4xx responses, not only 5xx.",
        "- ➕ Also changed, found by the verifier: Adds a metric.",
        "- ➕ Out of scope: `README.md`: Rewords the installation section, unrelated to retries.",
      ].join("\n"),
    );
    expect(renderIntentCheckOutput(agree, no).title).toBe(
      "Risk: sensitive · verifier agrees · 2 more changes",
    );
    // A card stored before intent-v5 says "disagree" for missing changes alone: no warning either.
    const legacy = okView({
      verifier: {
        ...okView().verifier,
        status: "disagree",
        claims: supported,
        missing: missing.slice(0, 1),
      },
    });
    expect(renderIntentSection(legacy, no)).not.toContain("[!WARNING]");
    expect(renderIntentCheckOutput(legacy, no).title).toBe(
      "Risk: sensitive · verifier agrees · 1 more change",
    );
    // A failed verifier lists nothing.
    const err = okView({
      verifier: { status: "error", claims: [], missing, unexplained: [], failure: "llm_timeout" },
    });
    expect(renderIntentSection(err, no)).not.toContain("Also changed");
  });
});
