import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gold } from "../../src/eval/case-schema.js";
import { generateKey, parseKey } from "../../src/eval/crypto.js";
import { cohenKappa, computeAgreement, weightedKappa } from "../../src/eval/kappa.js";
import {
  adjudicate,
  applyLabels,
  assignDouble,
  LABELING_GUIDE_VERSION,
  labelInteractive,
} from "../../src/eval/label.js";
import { type CaseSet, createSet, listCaseIds, readCase, writeCase } from "../../src/eval/store.js";
import {
  cardInputs,
  cf,
  cleanupTmpDirs,
  labelSet,
  linesIn,
  pilotCase,
  REPO_ROOT,
  sink,
  synCase,
  tmpDir,
} from "../helpers/eval-fixtures.js";

cleanupTmpDirs();
const NOW = new Date("2026-10-20T09:00:00Z");

async function setWith(n: number, mk?: (i: number) => Parameters<typeof pilotCase>[2]) {
  const root = await tmpDir();
  const set = await createSet(
    path.join(root, "pilot-a"),
    {
      setId: "pilot-a",
      kind: "pilot",
      description: "",
      encrypted: true,
      consentRef: "x",
      defaultFloorConfig: { extraSensitiveGlobs: [] },
    },
    { key: parseKey(generateKey()), now: NOW },
  );
  for (let i = 1; i <= n; i++) {
    const inputs = cardInputs([cf("src/a.ts"), cf("src/b.ts")], {
      pr: { number: i, title: `Title ${i}`, body: "", additions: 4, deletions: 2, changedFiles: 2 },
    });
    await writeCase(set, pilotCase("pilot-a", i, mk?.(i) ?? {}, inputs));
  }
  return set;
}

const labelsOf = async (set: CaseSet, id: string) => (await readCase(set, id)).labels;

describe("eval labeling", () => {
  it("U-LBL-1 --apply writes a label set with the labeler, the clock time and lg-1, and replaces a set by the same labeler", async () => {
    const set = await setWith(2);
    const entry = (risk: string, oos: string[]) => ({
      risk,
      outOfScope: oos,
      goal: "g",
      keyBehaviorChanges: ["k"],
      shouldFlag: false,
      confidence: "high",
      notes: "",
    });
    const id1 = "pilot-a--shop-1";
    await applyLabels(set, {
      as: "ada",
      json: JSON.stringify({ [id1]: entry("logic", ["src/b.ts", "src/a.ts"]) }),
      now: NOW,
    });
    const [l] = await labelsOf(set, id1);
    expect(l).toMatchObject({
      labeler: "ada",
      labeledAt: NOW.toISOString(),
      guideVersion: "lg-1",
      risk: "logic",
      outOfScope: ["src/a.ts", "src/b.ts"],
    });
    await applyLabels(set, {
      as: "bob",
      json: JSON.stringify({ [id1]: entry("trivial", []) }),
      now: NOW,
    });
    await applyLabels(set, {
      as: "ada",
      json: JSON.stringify({ [id1]: entry("sensitive", []) }),
      now: NOW,
    });
    const after = await labelsOf(set, id1);
    expect(after.map((x) => [x.labeler, x.risk])).toEqual([
      ["bob", "trivial"],
      ["ada", "sensitive"],
    ]);
    await expect(
      applyLabels(set, { as: "ada", json: JSON.stringify({ [id1]: { risk: "x" } }), now: NOW }),
    ).rejects.toThrow();
    await expect(
      applyLabels(set, {
        as: "ada",
        json: JSON.stringify({ "pilot-a--shop-99": entry("logic", []) }),
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it("U-LBL-2 the interactive session with scripted input writes the expected label set; the number maps to the path", async () => {
    const set = await setWith(1);
    const out = sink();
    const res = await labelInteractive(set, {
      as: "ada",
      doubleOnly: false,
      io: {
        input: linesIn([
          "l",
          "2",
          "Does the thing.",
          "First change",
          "Second change",
          "",
          "y",
          "h",
          "a note",
        ]),
        output: out,
      },
      now: () => NOW,
    });
    expect(res.labeled).toBe(1);
    const [l] = await labelsOf(set, "pilot-a--shop-1");
    expect(l).toEqual({
      labeler: "ada",
      labeledAt: NOW.toISOString(),
      guideVersion: "lg-1",
      risk: "logic",
      outOfScope: ["src/b.ts"],
      goal: "Does the thing.",
      keyBehaviorChanges: ["First change", "Second change"],
      shouldFlag: true,
      confidence: "high",
      notes: "a note",
    });
  });

  it("U-LBL-3 the interactive output shows no floor rule, no risk_class and no other labeler's label (blind)", async () => {
    const set = await setWith(1, () => ({
      labels: [labelSet({ labeler: "bob", risk: "sensitive", goal: "BOB_GOAL_TEXT" })],
    }));
    // package.json would trigger a floor rule; the output must still not name it
    const inputs = cardInputs([cf("package.json"), cf("src/a.ts")]);
    await writeCase(
      set,
      pilotCase(
        "pilot-a",
        1,
        { labels: [labelSet({ labeler: "bob", risk: "sensitive", goal: "BOB_GOAL_TEXT" })] },
        inputs,
      ),
    );
    const out = sink();
    await labelInteractive(set, {
      as: "ada",
      doubleOnly: false,
      io: { input: linesIn(["s", "", "g", "", "n", "h", ""]), output: out },
      now: () => NOW,
    });
    const text = out.text();
    expect(text.length).toBeGreaterThan(100);
    expect(text).not.toMatch(
      /dependency_manifest|risk_class|BOB_GOAL_TEXT|floor|sensitive\b.*bob/i,
    );
    expect(text).toContain("package.json");
  });

  it("U-LBL-4 q in the middle of a case writes nothing for that case", async () => {
    const set = await setWith(2);
    const out = sink();
    const res = await labelInteractive(set, {
      as: "ada",
      doubleOnly: false,
      io: { input: linesIn(["l", "", "Goal", "q"]), output: out },
      now: () => NOW,
    });
    expect(res.labeled).toBe(0);
    expect(await labelsOf(set, "pilot-a--shop-1")).toEqual([]);
    expect(await labelsOf(set, "pilot-a--shop-2")).toEqual([]);
    // end of input behaves like q
    const r2 = await labelInteractive(set, {
      as: "ada",
      doubleOnly: false,
      io: { input: linesIn(["t"]), output: sink() },
      now: () => NOW,
    });
    expect(r2.labeled).toBe(0);
  });

  it("U-LBL-4b the next unlabeled case is offered after the first; --double-only restricts to tagged cases", async () => {
    const set = await setWith(3, (i) => (i === 2 ? { tags: ["double-label"] } : {}));
    const one = ["t", "", "g", "", "n", "h", ""];
    await labelInteractive(set, {
      as: "ada",
      doubleOnly: true,
      io: { input: linesIn([...one, "n"]), output: sink() },
      now: () => NOW,
    });
    expect((await labelsOf(set, "pilot-a--shop-2")).length).toBe(1);
    expect((await labelsOf(set, "pilot-a--shop-1")).length).toBe(0);
    await labelInteractive(set, {
      as: "ada",
      doubleOnly: false,
      io: { input: linesIn([...one, "y", ...one, "y"]), output: sink() },
      now: () => NOW,
    });
    expect((await labelsOf(set, "pilot-a--shop-1")).length).toBe(1);
    expect((await labelsOf(set, "pilot-a--shop-3")).length).toBe(1);
  });

  it("U-LBL-5 assign-double tags max(min, ceil(fraction x n)) cases, and a second run changes nothing", async () => {
    const set = await setWith(10);
    const first = await assignDouble(set, { fraction: 0.2, min: 3, seed: 1 });
    expect(first.target).toBe(3);
    expect(first.tagged).toHaveLength(3);
    const tagged = async () => {
      const ids = await listCaseIds(set);
      const all = await Promise.all(ids.map((id) => readCase(set, id)));
      return all.filter((c) => c.tags.includes("double-label")).map((c) => c.id);
    };
    const t1 = await tagged();
    expect(t1).toHaveLength(3);
    const second = await assignDouble(set, { fraction: 0.2, min: 3, seed: 1 });
    expect(second.tagged).toEqual([]);
    expect(await tagged()).toEqual(t1);
  });

  it("U-LBL-6 LABELING_GUIDE_VERSION equals the version on the first line of the guide", async () => {
    const guide = await fs.readFile(path.join(REPO_ROOT, "docs/phase-0/labeling-guide.md"), "utf8");
    expect(guide.split("\n")[0]).toBe(`Labeling guide ${LABELING_GUIDE_VERSION}`);
  });

  it("U-LBL-7 adjudicate lists only disagreeing cases without an adjudication, and gold then returns it", async () => {
    const set = await setWith(3, (i) => ({
      labels:
        i === 1
          ? [
              labelSet({ labeler: "ada", risk: "logic" }),
              labelSet({ labeler: "bob", risk: "sensitive" }),
            ]
          : [
              labelSet({ labeler: "ada", risk: "logic" }),
              labelSet({ labeler: "bob", risk: "logic" }),
            ],
    }));
    const out = sink();
    const res = await adjudicate(set, {
      as: "judge",
      io: { input: linesIn(["s", "", "Final goal", "", "y", "h", "settled"]), output: out },
      now: () => NOW,
    });
    expect(res.adjudicated).toBe(1);
    const c = await readCase(set, "pilot-a--shop-1");
    expect(c.adjudicated).toMatchObject({ labeler: "judge", risk: "sensitive", shouldFlag: true });
    expect(gold(c)?.labeler).toBe("judge");
    expect((await readCase(set, "pilot-a--shop-2")).adjudicated).toBeNull();
    // nothing left to adjudicate
    const again = sink();
    expect(
      (
        await adjudicate(set, {
          as: "judge",
          io: { input: linesIn([]), output: again },
          now: () => NOW,
        })
      ).adjudicated,
    ).toBe(0);
    expect(again.text()).toContain("No cases need adjudication");
    // the screen showed the label sets but no model output
    expect(out.text()).toMatch(/ada: risk logic/);
    expect(out.text()).not.toMatch(/Graft result|floor/i);
  });
});

describe("eval kappa", () => {
  it("U-KAPPA-1 identical lists give kappa 1", () => {
    expect(cohenKappa(["a", "b", "a", "b"], ["a", "b", "a", "b"], ["a", "b"])).toBe(1);
  });

  it("U-KAPPA-2 the textbook example (20, 5, 10, 15) gives 0.4", () => {
    const a: string[] = [];
    const b: string[] = [];
    const add = (n: number, x: string, y: string) => {
      for (let i = 0; i < n; i++) {
        a.push(x);
        b.push(y);
      }
    };
    add(20, "yes", "yes");
    add(5, "yes", "no");
    add(10, "no", "yes");
    add(15, "no", "no");
    expect(Math.abs((cohenKappa(a, b, ["yes", "no"]) as number) - 0.4)).toBeLessThan(1e-9);
  });

  it("U-KAPPA-3 p_e = 1 with p_o = 1 gives 1; fully disjoint single categories give kappa <= 0", () => {
    expect(cohenKappa(["a", "a", "a"], ["a", "a", "a"], ["a", "b"])).toBe(1);
    expect(cohenKappa(["a", "a", "a"], ["b", "b", "b"], ["a", "b"]) as number).toBeLessThanOrEqual(
      0,
    );
    expect(cohenKappa([], [], ["a"])).toBeNull();
  });

  it("U-KAPPA-4 weighted kappa weighs trivial/sensitive disagreements twice trivial/logic ones", () => {
    // hand computation: A = T T L L S S, B differs in one item
    const a = ["trivial", "trivial", "logic", "logic", "sensitive", "sensitive"] as const;
    const near = ["trivial", "logic", "logic", "logic", "sensitive", "sensitive"] as const;
    const far = ["sensitive", "trivial", "logic", "logic", "sensitive", "sensitive"] as const;
    // near: o = 1/6 weight 0.5 -> 0.08333; e: pA = (2,2,2)/6, pB = (1,3,2)/6
    //   e = sum w pA(i) pB(j) = 0.5*(pA_T*pB_L + pA_L*pB_T + pA_L*pB_S + pA_S*pB_L) + 1*(pA_T*pB_S + pA_S*pB_T)
    const eNear = 0.5 * ((2 * 3 + 2 * 1 + 2 * 2 + 2 * 3) / 36) + (2 * 2 + 2 * 1) / 36;
    expect(weightedKappa([...a], [...near])).toBeCloseTo(1 - 0.5 / 6 / eNear, 9);
    // far: one disagreement with weight 1 (trivial vs sensitive): twice the observed weight of near
    const eFar = (0.5 * (2 * 2 + 2 * 1 + 2 * 3 + 2 * 2) + (2 * 3 + 2 * 1)) / 36;
    expect(weightedKappa([...a], [...far])).toBeCloseTo(1 - 1 / 6 / eFar, 9);
    expect(weightedKappa([...a], [...a])).toBe(1);
  });

  it("U-KAPPA-5 agreement skips pairs with fewer than 5 shared cases, scores out-of-scope per file and lists disagreeing ids", () => {
    const files = [cf("src/a.ts"), cf("src/b.ts")];
    const mk = (
      n: number,
      ada: Partial<ReturnType<typeof labelSet>>,
      bob?: Partial<ReturnType<typeof labelSet>>,
    ) =>
      synCase(`syn-${String(n).padStart(3, "0")}-x`, {
        inputs: cardInputs(files),
        labels: [
          labelSet({ labeler: "ada", ...ada }),
          ...(bob ? [labelSet({ labeler: "bob", ...bob })] : []),
        ],
      });
    const four = [1, 2, 3, 4].map((n) => mk(n, {}, {}));
    expect(computeAgreement(four)).toEqual([]);
    const cases = [
      ...four,
      mk(5, { risk: "logic", outOfScope: ["src/a.ts"] }, { risk: "sensitive", outOfScope: [] }),
      mk(6, { risk: "logic" }),
    ];
    const [pair] = computeAgreement(cases);
    expect(pair).toMatchObject({ a: "ada", b: "bob", n: 5 });
    expect(pair?.disagreeing).toEqual(["syn-005-x"]);
    expect(pair?.outOfScope.decisions).toBe(10);
    expect(pair?.outOfScope.agreement).toBe(0.9);
    expect(pair?.risk.agreement).toBe(0.8);
  });
});
