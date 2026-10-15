import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  caseHash,
  caseSetHash,
  evalCaseJsonSchema,
  evalCaseSchema,
  gold,
} from "../../src/eval/case-schema.js";
import { evalReportJsonSchema, evalReportSchema } from "../../src/eval/report-schema.js";
import {
  cardInputs,
  cf,
  labelSet,
  pilotCase,
  REPO_ROOT,
  synCase,
} from "../helpers/eval-fixtures.js";

const syntheticDir = join(REPO_ROOT, "eval/synthetic/cases");
const synthetic = () =>
  readdirSync(syntheticDir)
    .filter((n) => n.endsWith(".case.json"))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(syntheticDir, n), "utf8")) as unknown);

const SPEC_EXAMPLE = {
  schemaVersion: 1,
  id: "syn-001-docs-typo",
  source: { kind: "synthetic", author: "graft-team", createdAt: "2026-10-15" },
  tags: ["docs", "trivial"],
  floorConfig: { extraSensitiveGlobs: [] },
  inputs: {
    repositoryFullName: "fictional-org/shop-demo",
    pr: {
      number: 101,
      title: "Fix typo in README",
      body: "Fixes #100.\n\nCorrects 'recieve' in the setup section.",
      additions: 1,
      deletions: 1,
      changedFiles: 1,
    },
    issue: {
      number: 100,
      title: "Typo in README setup section",
      body: "'recieve' should be 'receive'.",
    },
    files: [
      {
        path: "README.md",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch:
          "@@ -12,3 +12,3 @@\n ## Setup\n-You will recieve a token by e-mail.\n+You will receive a token by e-mail.\n ",
      },
    ],
    listingTruncated: false,
    tooLarge: false,
  },
  labels: [
    {
      labeler: "graft-synthetic",
      labeledAt: "2026-10-15T00:00:00Z",
      guideVersion: "lg-1",
      risk: "trivial",
      outOfScope: [],
      goal: "Fixes a spelling mistake in the README setup section.",
      keyBehaviorChanges: ["The README says 'receive' instead of 'recieve'."],
      shouldFlag: false,
      confidence: "high",
      notes: "",
    },
  ],
  adjudicated: null,
  fakeLlm: {
    writer: {
      json: {
        goal: "Fix a spelling mistake in the README setup section.",
        behavior_changes: ["The README setup section spells 'receive' correctly."],
        risk_class: "trivial",
        risk_reason: "Documentation only.",
        out_of_scope_edits: [],
        instructions_in_data: false,
      },
    },
    verifier: "agree",
  },
};

describe("eval case schema", () => {
  it("U-CASE-1 every synthetic case parses, and so does the spec example", () => {
    const cases = synthetic();
    expect(cases.length).toBeGreaterThanOrEqual(30);
    for (const c of cases)
      expect(evalCaseSchema.safeParse(c).success, JSON.stringify((c as { id: string }).id)).toBe(
        true,
      );
    expect(evalCaseSchema.safeParse(SPEC_EXAMPLE).success).toBe(true);
  });

  it("U-CASE-2 a pilot case with a fakeLlm, a synthetic id without syn- and a pilot id without <setId>-- are rejected", () => {
    expect(evalCaseSchema.safeParse(pilotCase("pilot-a", 1)).success).toBe(true);
    expect(evalCaseSchema.safeParse(pilotCase("pilot-a", 1, { fakeLlm: {} })).success).toBe(false);
    expect(evalCaseSchema.safeParse(synCase("case-1")).success).toBe(false);
    expect(evalCaseSchema.safeParse(pilotCase("pilot-a", 1, { id: "other--shop-1" })).success).toBe(
      false,
    );
  });

  it("U-CASE-3 an out-of-scope path that is not in the file list, or unsorted or duplicate paths, are rejected", () => {
    const inputs = cardInputs([cf("src/a.ts"), cf("src/b.ts")]);
    const ok = synCase("syn-901-a", {
      inputs,
      labels: [labelSet({ outOfScope: ["src/a.ts", "src/b.ts"] })],
    });
    expect(evalCaseSchema.safeParse(ok).success).toBe(true);
    for (const bad of [["src/zzz.ts"], ["src/b.ts", "src/a.ts"], ["src/a.ts", "src/a.ts"]]) {
      expect(
        evalCaseSchema.safeParse(
          synCase("syn-901-a", { inputs, labels: [labelSet({ outOfScope: bad })] }),
        ).success,
      ).toBe(false);
    }
    expect(
      evalCaseSchema.safeParse(
        synCase("syn-901-a", {
          inputs,
          labels: [],
          adjudicated: labelSet({ outOfScope: ["nope"] }),
        }),
      ).success,
    ).toBe(false);
  });

  it("U-CASE-3b a rejected out-of-scope path is not echoed in the issue message", () => {
    const inputs = cardInputs([cf("src/a.ts")]);
    const r = evalCaseSchema.safeParse(
      synCase("syn-901-a", { inputs, labels: [labelSet({ outOfScope: ["src/PILOT-PATH.ts"] })] }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      const text = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      expect(text).toContain("outOfScope path is not in inputs.files");
      expect(text).not.toContain("PILOT-PATH");
    }
  });

  it("U-CASE-4 two label sets by one labeler, and an e-mail as labeler, are rejected", () => {
    expect(
      evalCaseSchema.safeParse(
        synCase("syn-901-a", { labels: [labelSet(), labelSet({ risk: "logic" })] }),
      ).success,
    ).toBe(false);
    expect(
      evalCaseSchema.safeParse(synCase("syn-901-a", { labels: [labelSet({ labeler: "a@b.c" })] }))
        .success,
    ).toBe(false);
    expect(
      evalCaseSchema.safeParse(
        synCase("syn-901-a", { labels: [labelSet(), labelSet({ labeler: "bob" })] }),
      ).success,
    ).toBe(true);
  });

  it("U-CASE-5 a pilot source.repository that differs from inputs.repositoryFullName is rejected", () => {
    const c = pilotCase("pilot-a", 1);
    expect(evalCaseSchema.safeParse(c).success).toBe(true);
    const bad = { ...c, source: { ...c.source, repository: "other/repo" } };
    expect(evalCaseSchema.safeParse(bad).success).toBe(false);
    const badPr = { ...c, source: { ...c.source, prNumber: 999 } };
    expect(evalCaseSchema.safeParse(badPr).success).toBe(false);
  });

  it("U-CASE-6 the committed JSON Schemas equal the generated ones byte for byte", () => {
    for (const [file, gen] of [
      ["eval-case.v1.schema.json", evalCaseJsonSchema()],
      ["eval-report.v1.schema.json", evalReportJsonSchema()],
    ] as const) {
      const committed = readFileSync(join(REPO_ROOT, "eval/schema", file), "utf8");
      expect(committed).toBe(`${JSON.stringify(gen, null, 2)}\n`);
    }
  });

  it("U-CASE-7 gold: adjudicated wins; agreeing sets give the first; disagreement or no labels give null", () => {
    const a = labelSet({ labeler: "ada", goal: "one", risk: "logic" });
    const b = labelSet({ labeler: "bob", goal: "two words", risk: "logic" });
    expect(gold(synCase("syn-901-a", { labels: [a, b] }))).toEqual(a);
    expect(
      gold(synCase("syn-901-a", { labels: [a, labelSet({ labeler: "bob", risk: "sensitive" })] })),
    ).toBeNull();
    expect(
      gold(
        synCase("syn-901-a", {
          labels: [a, labelSet({ labeler: "bob", risk: "logic", shouldFlag: true })],
        }),
      ),
    ).toBeNull();
    const adj = labelSet({ labeler: "judge", risk: "sensitive" });
    expect(
      gold(
        synCase("syn-901-a", {
          labels: [a, labelSet({ labeler: "bob", risk: "trivial" })],
          adjudicated: adj,
        }),
      ),
    ).toEqual(adj);
    expect(gold(synCase("syn-901-a", { labels: [] }))).toBeNull();
    const inputs = cardInputs([cf("src/a.ts"), cf("src/b.ts")]);
    const oosA = labelSet({ labeler: "ada", outOfScope: ["src/a.ts"] });
    const oosB = labelSet({ labeler: "bob", outOfScope: ["src/b.ts"] });
    expect(gold(synCase("syn-901-a", { inputs, labels: [oosA, oosB] }))).toBeNull();
  });

  it("U-CASE-8 caseHash ignores labels and tags and changes with a patch character or a glob", () => {
    const base = synCase("syn-901-a");
    const h = caseHash(base);
    expect(caseHash({ ...base, tags: ["x"], labels: [] })).toBe(h);
    const patched = cardInputs([cf("src/a.ts", { patch: "@@ -1 +1 @@\n-a\n+b" })]);
    const patched2 = cardInputs([cf("src/a.ts", { patch: "@@ -1 +1 @@\n-a\n+c" })]);
    expect(caseHash({ ...base, inputs: patched })).not.toBe(
      caseHash({ ...base, inputs: patched2 }),
    );
    expect(caseHash({ ...base, floorConfig: { extraSensitiveGlobs: ["x/**"] } })).not.toBe(h);
    expect(caseSetHash([base])).toHaveLength(64);
  });

  it("U-CASE-9 ajv (2020-12) validates every synthetic case and a sample report against the committed schemas", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const caseSchema = JSON.parse(
      readFileSync(join(REPO_ROOT, "eval/schema/eval-case.v1.schema.json"), "utf8"),
    );
    const validate = ajv.compile(caseSchema);
    for (const c of synthetic()) {
      expect(validate(c), JSON.stringify(validate.errors)).toBe(true);
    }
    // a wrong shape is refused
    expect(validate({ ...(synthetic()[0] as object), schemaVersion: 2 })).toBe(false);

    const baseline = JSON.parse(
      readFileSync(join(REPO_ROOT, "eval/baselines/synthetic.json"), "utf8"),
    );
    expect(evalReportSchema.safeParse(baseline).success).toBe(true);
    const reportSchema = JSON.parse(
      readFileSync(join(REPO_ROOT, "eval/schema/eval-report.v1.schema.json"), "utf8"),
    );
    const validateReport = new Ajv2020({ strict: false, allErrors: true }).compile(reportSchema);
    expect(validateReport(baseline), JSON.stringify(validateReport.errors)).toBe(true);
  });
});
