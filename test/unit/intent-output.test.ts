import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseVerifierOutput, parseWriterOutput } from "../../src/modules/intent/output.js";
import {
  PROMPT_VERSION,
  VERIFIER_OUTPUT_SCHEMA,
  VERIFIER_SYSTEM_PROMPT,
  WRITER_OUTPUT_SCHEMA,
  WRITER_SYSTEM_PROMPT,
} from "../../src/modules/intent/prompts.js";

const FILES = new Set(["src/a.ts", "README.md", "docs/x.md"]);
const writer = (over: Record<string, unknown> = {}) => ({
  goal: "Do the thing.",
  behavior_changes: ["It does the thing."],
  risk_class: "logic",
  risk_reason: "Because.",
  out_of_scope_edits: [],
  instructions_in_data: false,
  ...over,
});
const w = (v: unknown) => parseWriterOutput(v, FILES);
const verifier = (over: Record<string, unknown> = {}) => ({
  claims: [
    { id: "goal", verdict: "supported", reason: "ok" },
    { id: "b1", verdict: "supported", reason: "ok" },
  ],
  missing_behavior_changes: [],
  unexplained_files: [],
  risk_class: "logic",
  risk_reason: "r",
  instructions_in_data: false,
  ...over,
});
const v = (value: unknown, ids = ["goal", "b1"], already = new Set<string>()) =>
  parseVerifierOutput(value, ids, FILES, already);

describe("model output validation", () => {
  it("U-OUT-1 writer caps", () => {
    const r = w(
      writer({
        goal: "g".repeat(300),
        behavior_changes: Array.from({ length: 15 }, (_, i) => `item ${i}`),
      }),
    );
    expect(r.ok && Array.from(r.out.goal)).toHaveLength(200);
    expect(r.ok && r.out.goal.endsWith("…")).toBe(true);
    expect(r.ok && r.out.behaviorChanges).toHaveLength(10);
    const e = w(writer({ behavior_changes: ["a", "  ", ""] }));
    expect(e.ok && e.out.behaviorChanges).toEqual(["a"]);
    expect(w(writer({ behavior_changes: [] })).ok).toBe(false);
    expect(w(writer({ behavior_changes: ["", " "] })).ok).toBe(false);
    expect(w(writer({ goal: "   " })).ok).toBe(false);
    const long = w(writer({ risk_reason: "r".repeat(400), behavior_changes: ["b".repeat(500)] }));
    expect(long.ok && Array.from(long.out.riskReason)).toHaveLength(300);
    expect(long.ok && Array.from(long.out.behaviorChanges[0] ?? "")).toHaveLength(200);
  });

  it("U-OUT-2 out-of-scope paths must be in the file list; duplicates are removed", () => {
    const r = w(
      writer({
        out_of_scope_edits: [
          { path: "README.md", reason: "a" },
          { path: "../../etc/passwd", reason: "b" },
          { path: "README.md", reason: "c" },
          { path: "docs/x.md", reason: "r".repeat(300) },
        ],
      }),
    );
    expect(r.ok && r.out.outOfScopeEdits.map((e) => e.path)).toEqual(["README.md", "docs/x.md"]);
    expect(r.ok && r.out.droppedOutOfScope).toBe(1);
    expect(r.ok && Array.from(r.out.outOfScopeEdits[1]?.reason ?? "")).toHaveLength(200);
    const many = new Set(Array.from({ length: 30 }, (_, i) => `f${i}`));
    const m = parseWriterOutput(
      writer({
        out_of_scope_edits: Array.from({ length: 30 }, (_, i) => ({ path: `f${i}`, reason: "r" })),
      }),
      many,
    );
    expect(m.ok && m.out.outOfScopeEdits).toHaveLength(20);
  });

  it("U-OUT-3 a bad enum, a missing field or an extra field is invalid", () => {
    expect(w(writer({ risk_class: "huge" })).ok).toBe(false);
    const missing = writer();
    delete (missing as Record<string, unknown>).risk_reason;
    expect(w(missing).ok).toBe(false);
    expect(w(writer({ extra: 1 })).ok).toBe(false);
    expect(w(writer({ instructions_in_data: "no" })).ok).toBe(false);
    expect(w("not an object").ok).toBe(false);
    expect(w(writer({ out_of_scope_edits: [{ path: "src/a.ts", reason: "r", x: 1 }] })).ok).toBe(
      false,
    );
  });

  it("U-OUT-4 verifier claim ids must be exactly the expected set; order follows the card", () => {
    const base = verifier();
    expect(v(base).ok).toBe(true);
    expect(v(verifier({ claims: [{ id: "goal", verdict: "supported", reason: "r" }] })).ok).toBe(
      false,
    );
    expect(
      v(
        verifier({
          claims: [
            { id: "goal", verdict: "supported", reason: "r" },
            { id: "goal", verdict: "supported", reason: "r" },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      v(
        verifier({
          claims: [
            { id: "goal", verdict: "supported", reason: "r" },
            { id: "zzz", verdict: "supported", reason: "r" },
          ],
        }),
      ).ok,
    ).toBe(false);
    const reordered = v(
      verifier({
        claims: [
          { id: "b1", verdict: "contradicted", reason: "rb" },
          { id: "goal", verdict: "supported", reason: "rg" },
        ],
      }),
    );
    expect(reordered.ok && reordered.out.claims.map((c) => c.id)).toEqual(["goal", "b1"]);
  });

  it("U-OUT-5 unexplained files: only listed files not already out of scope", () => {
    const r = v(
      verifier({
        unexplained_files: ["src/a.ts", "README.md", "nope.ts", "src/a.ts", "docs/x.md"],
      }),
      ["goal", "b1"],
      new Set(["README.md"]),
    );
    expect(r.ok && r.out.unexplained).toEqual(["src/a.ts", "docs/x.md"]);
  });

  it("U-OUT-7 text made only of format characters is empty", () => {
    expect(w(writer({ goal: "\u200b\u2060 \u200d" })).ok).toBe(false);
    const r = w(writer({ behavior_changes: ["\u200b", "Real change.", " \u2060 "] }));
    expect(r.ok && r.out.behaviorChanges).toEqual(["Real change."]);
    expect(w(writer({ behavior_changes: ["\u200b"] })).ok).toBe(false);
  });

  it("U-OUT-6 caps on verifier reasons and missing behavior changes", () => {
    const r = v(
      verifier({
        claims: [
          { id: "goal", verdict: "supported", reason: "r".repeat(400) },
          { id: "b1", verdict: "supported", reason: "ok" },
        ],
        missing_behavior_changes: ["a", "", "b", "c", "d", "e", "f", "g".repeat(300)],
        risk_reason: "x".repeat(500),
      }),
    );
    expect(r.ok && Array.from(r.out.claims[0]?.reason ?? "")).toHaveLength(300);
    expect(r.ok && r.out.missing).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.ok && Array.from(r.out.riskReason)).toHaveLength(300);
  });
});

describe("prompts", () => {
  it("U-PROMPT-1 the prompt hash is pinned next to PROMPT_VERSION", () => {
    const hash = createHash("sha256")
      .update(
        WRITER_SYSTEM_PROMPT +
          VERIFIER_SYSTEM_PROMPT +
          JSON.stringify(WRITER_OUTPUT_SCHEMA) +
          JSON.stringify(VERIFIER_OUTPUT_SCHEMA),
      )
      .digest("hex");
    // Changing a prompt or a schema changes this hash: bump PROMPT_VERSION and update both.
    expect([PROMPT_VERSION, hash]).toEqual([
      "intent-v1",
      "1fe62955ab7a276f42ecce84d38c3ca3e106e044e2f5bcdee2ff9e9f72781b40",
    ]);
    for (const p of [WRITER_SYSTEM_PROMPT, VERIFIER_SYSTEM_PROMPT]) {
      expect(p.length).toBeGreaterThanOrEqual(2000);
      expect(p).not.toMatch(/[{}]/);
    }
  });
});
