import { readdirSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import picomatch from "picomatch";
import { describe, expect, it, vi } from "vitest";
import { Document, isScalar, parseDocument, visit } from "yaml";
import {
  EVALUATION_FUEL,
  GlobBudget,
  globMatcher,
  MATCH_FUEL,
  MEMO_TOTAL,
  matcherScratchClean,
  memoEntries,
  normalizeGlob,
  PATH_LIMITS,
} from "../../src/core/glob.js";
import { mulberry32 } from "../../src/eval/sample.js";
import type { ChangedFile } from "../../src/modules/intent/inputs.js";
import {
  computeRiskFloor,
  type FloorInput,
  globMatcher as floorGlobMatcher,
} from "../../src/modules/intent/risk-floor.js";
import {
  formatPolicyError,
  GLOB_REASONS,
  POLICY_ERROR_CODES,
  type PolicyError,
} from "../../src/policy/errors.js";
import { evaluatePolicy, type PolicyFacts } from "../../src/policy/evaluate.js";
import { validateGlob } from "../../src/policy/globs.js";
import { policyJsonSchema } from "../../src/policy/json-schema.js";
import { parsePolicyText } from "../../src/policy/parse.js";
import { expectDuration } from "../helpers/perf.js";

const enc = (s: string) => new TextEncoder().encode(s);
const parse = (s: string) => parsePolicyText(enc(s));
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/policy/${name}`, import.meta.url));
const EXAMPLE = readFileSync(new URL("../../docs/examples/graft.yaml", import.meta.url));

function errorsOf(s: string | Uint8Array): PolicyError[] {
  const res = parsePolicyText(typeof s === "string" ? enc(s) : s);
  if (res.ok) throw new Error("expected errors");
  return res.errors;
}
const codesOf = (s: string) => errorsOf(s).map((e) => e.code);
const rule = (body: string) => `version: 1\nrules:\n  - ${body}\n`;

describe("policy parsing", () => {
  it("U-PY-1 the example parses to a pinned policy; the hash ignores key order and whitespace", () => {
    const res = parsePolicyText(EXAMPLE);
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.policy.version).toBe(1);
    expect(res.policy.sensitivePaths).toEqual(["services/billing/**", "**/payments/**"]);
    expect(res.policy.default).toEqual({ humans: 1, teams: [] });
    expect(res.policy.rules).toHaveLength(8);
    expect(res.policy.rules[0]).toEqual({
      index: 1,
      name: "docs-only",
      match: { risk: ["trivial"], onlyPaths: ["docs/**", "*.md"] },
      action: { kind: "approve" },
    });
    expect(res.policy.rules[2]).toEqual({
      index: 3,
      name: "infra-and-auth",
      match: { paths: ["infra/**", "**/auth/**"] },
      action: { kind: "require", humans: 1, teams: ["security"] },
    });
    expect(res.policy.rules[4]?.action).toEqual({ kind: "block" });
    expect(res.policy.rules[5]?.match).toEqual({ size: { minLines: 1000 } });
    expect(res.policy.rules[6]).toMatchObject({
      match: { agents: ["codex-preview"] },
      action: { kind: "require", humans: 1, teams: ["platform", "security"] },
    });
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);

    const a = rule(
      "name: a\n    match: { risk: [trivial], paths: [x/**] }\n    require: { team: sec }",
    );
    const b =
      "# reordered, different whitespace\nrules:\n -   require:   { team:   [sec] }\n     match:\n       paths:\n         - x/**\n       risk:   trivial\n     name:   a\nversion:   1\n";
    const ra = parse(a);
    const rb = parse(b);
    if (!ra.ok || !rb.ok) throw new Error("parse failed");
    expect(rb.policy).toEqual(ra.policy);
    expect(rb.hash).toBe(ra.hash);
    const c = parse(
      rule("name: a\n    match: { risk: [trivial], paths: [x/**] }\n    require: { team: other }"),
    );
    if (!c.ok) throw new Error("parse failed");
    expect(c.hash).not.toBe(ra.hash);
  });

  it("U-PY-2 the size limit is 32,768 bytes", () => {
    const base = "version: 1\n# ";
    const ok = base + "x".repeat(32_768 - base.length);
    expect(enc(ok).byteLength).toBe(32_768);
    expect(parse(ok).ok).toBe(true);
    const big = errorsOf(`${ok}y`);
    expect(big).toHaveLength(1);
    expect(big[0]).toMatchObject({ code: "file_too_large", detail: 32_769 });
    expect(formatPolicyError(big[0] as PolicyError)).toContain("32769 bytes");
  });

  it("U-PY-3 a billion-laughs document is rejected as an alias in under 50 ms, without toJS", () => {
    const spy = vi.spyOn(Document.prototype, "toJS");
    try {
      const started = performance.now();
      const errors = errorsOf(fixture("alias-bomb.yaml"));
      const took = performance.now() - started;
      expectDuration(took, 50, "alias bomb");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.code === "yaml_alias" || e.code === "too_many_errors")).toBe(
        true,
      );
      expect(errors[0]?.code).toBe("yaml_alias");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("U-PY-4 a lone anchor and a merge key are yaml_alias", () => {
    const anchor = errorsOf(fixture("anchor-only.yaml"));
    expect(anchor.map((e) => e.code)).toEqual(["yaml_alias"]);
    expect(anchor[0]?.line).toBe(3);
    const merge = errorsOf(fixture("merge-key.yaml"));
    expect(merge.every((e) => e.code === "yaml_alias")).toBe(true);
    expect(merge.length).toBeGreaterThanOrEqual(2);
  });

  it("U-PY-5 explicit tags are yaml_tag, with lines", () => {
    const errors = errorsOf(fixture("tags.yaml"));
    expect(errors.map((e) => [e.code, e.line])).toEqual([
      ["yaml_tag", 3],
      ["yaml_tag", 4],
      ["yaml_tag", 5],
    ]);
  });

  it("U-PY-6 duplicate keys, two documents and syntax errors", () => {
    const dup = errorsOf(fixture("duplicate-key.yaml"));
    expect(dup.map((e) => e.code)).toEqual(["yaml_duplicate_key"]);
    expect(dup[0]?.line).toBe(2);
    expect(errorsOf(fixture("two-documents.yaml")).map((e) => e.code)).toEqual([
      "yaml_multiple_documents",
    ]);
    const syntax = errorsOf(fixture("syntax-error.yaml"));
    expect(syntax[0]?.code).toBe("yaml_syntax");
    expect(syntax[0]?.line).toBeGreaterThanOrEqual(2);
    expect(syntax[0]?.column).toBeGreaterThanOrEqual(1);
  });

  it("U-PY-7 invalid UTF-8 is rejected; a BOM is accepted", () => {
    expect(errorsOf(new Uint8Array([0x76, 0x3a, 0xff, 0xfe, 0x0a])).map((e) => e.code)).toEqual([
      "file_not_utf8",
    ]);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("version: 1\n")]);
    expect(parsePolicyText(bom).ok).toBe(true);
  });

  it("U-PY-8 flow nesting above 16 is rejected; brackets in quotes and comments are not counted", () => {
    const deep = (n: number) => `version: 1\nx: ${"[".repeat(n)}${"]".repeat(n)}\n`;
    expect(codesOf(deep(17))).toEqual(["yaml_too_deep"]);
    expect(codesOf(deep(16))).not.toContain("yaml_too_deep");
    const hidden = `version: 1\n# ${"[".repeat(40)}\nx: "${"[".repeat(40)}"\ny: '${"{".repeat(40)}'\nz: a ${"[".repeat(40)}\n`;
    expect(codesOf(hidden)).not.toContain("yaml_too_deep");
    const err = errorsOf(deep(17))[0];
    expect(err?.line).toBe(2);
  });

  it("U-PY-9 top-level shape and version", () => {
    expect(codesOf("- a\n- b\n")).toEqual(["not_a_mapping"]);
    expect(codesOf("just a scalar\n")).toEqual(["not_a_mapping"]);
    expect(codesOf("")).toEqual(["not_a_mapping"]);
    expect(codesOf("rules: []\n")).toEqual(["version_missing"]);
    expect(codesOf("version: 2\n")).toEqual(["version_unsupported"]);
    expect(codesOf('version: "1"\n')).toEqual(["version_unsupported"]);
    expect(parse("version: 1\n").ok).toBe(true);
  });

  it("U-PY-10 fuzz: random bytes and mutations of the example never throw and stay within 50 errors", () => {
    const rnd = mulberry32(20261014);
    const check = (bytes: Uint8Array) => {
      const res = parsePolicyText(bytes);
      if (!res.ok) expect(res.errors.length).toBeLessThanOrEqual(50);
      return res;
    };
    for (let i = 0; i < 2_000; i++) {
      const len = Math.floor(rnd() * 300);
      check(Uint8Array.from({ length: len }, () => Math.floor(rnd() * 256)));
    }
    const alphabet = enc("[]{}:,-&*!#'\"|>? \n\t%@`\\xyz019");
    for (let i = 0; i < 2_000; i++) {
      const bytes = Array.from(EXAMPLE);
      const edits = 1 + Math.floor(rnd() * 6);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(rnd() * bytes.length);
        const pick = alphabet[Math.floor(rnd() * alphabet.length)] ?? 0x20;
        const kind = rnd();
        if (kind < 0.4) bytes[at] = pick;
        else if (kind < 0.7) bytes.splice(at, 0, pick);
        else bytes.splice(at, 1 + Math.floor(rnd() * 8));
      }
      check(Uint8Array.from(bytes));
    }
  });
});

describe("policy schema", () => {
  const at = (s: string) => errorsOf(s);

  it("U-PS-1 unknown keys at every level carry the key and a line", () => {
    const cases: [string, string, string, number][] = [
      ["top", "version: 1\nfoo: 1\n", "foo", 2],
      ["rule", rule("match: { risk: trivial }\n    approve: auto\n    aprove: x"), "aprove", 5],
      ["match", rule("match: { risk: trivial, wat: 1 }\n    approve: auto"), "wat", 3],
      ["size", rule("match: { size: { min_lines: 1, bad: 2 } }\n    block: true"), "bad", 3],
      [
        "require",
        rule("match: { risk: trivial }\n    require: { humans: 1, extra: 2 }"),
        "extra",
        4,
      ],
    ];
    for (const [label, src, key, line] of cases) {
      const errs = at(src).filter((e) => e.code === "unknown_key");
      expect(errs, label).toHaveLength(1);
      expect(errs[0]?.key, label).toBe(key);
      expect(errs[0]?.line, label).toBe(line);
    }
    expect(
      at(rule("match: { risk: trivial }\n    aprove: x\n    approve: auto"))[0]?.location,
    ).toBe("rules[1]");
    const long = at(`version: 1\n${"k".repeat(60)}: 1\n`)[0];
    expect(long?.key).toHaveLength(40);
  });

  it("U-PS-2 exactly one action", () => {
    expect(codesOf(rule("match: { risk: trivial }"))).toEqual(["action_missing"]);
    expect(codesOf(rule("match: { risk: trivial }\n    approve: auto\n    block: true"))).toEqual([
      "action_conflict",
    ]);
    expect(codesOf(rule("match: { risk: trivial }\n    approve: yes"))).toEqual([
      "approve_invalid",
    ]);
    expect(codesOf(rule("match: { risk: trivial }\n    block: false"))).toEqual(["block_invalid"]);
    expect(
      codesOf(rule("match: { risk: trivial }\n    approve: auto\n    require: { humans: 1 }")),
    ).toEqual(["action_conflict"]);
  });

  it("U-PS-3 approve: auto cannot use keys the PR author controls", () => {
    for (const key of ["author: agent", "agent: x", "labels: [a]"]) {
      const errs = at(rule(`match: { risk: trivial, ${key} }\n    approve: auto`));
      expect(
        errs.map((e) => e.code),
        key,
      ).toEqual(["approve_untrusted_key"]);
    }
    expect(codesOf(rule("match: { paths: [a/**] }\n    approve: auto"))).toEqual([
      "approve_any_path",
    ]);
    // The same keys are fine in require and block rules.
    for (const action of ["require: { humans: 1 }", "block: true"]) {
      expect(
        parse(rule(`match: { author: agent, agent: x, labels: [a], paths: [b] }\n    ${action}`))
          .ok,
      ).toBe(true);
    }
    expect(
      parse(
        rule(
          "match: { risk: trivial, only_paths: [docs/**], size: { max_lines: 10 } }\n    approve: auto",
        ),
      ).ok,
    ).toBe(true);
  });

  it("U-PS-4 humans", () => {
    for (const v of ["0", "11", "1.5", '"2"', "-1", "true"]) {
      expect(codesOf(rule(`match: { risk: trivial }\n    require: { humans: ${v} }`)), v).toEqual([
        "humans_invalid",
      ]);
    }
    expect(codesOf(rule("match: { risk: trivial }\n    require: {}"))).toEqual(["require_empty"]);
    expect(parse(rule("match: { risk: trivial }\n    require: { humans: 10 }")).ok).toBe(true);
  });

  it("U-PS-5 teams", () => {
    for (const v of ["'@acme/security'", "acme/security", "Security", "''", "[ok, '@bad']"]) {
      expect(codesOf(rule(`match: { risk: trivial }\n    require: { team: ${v} }`)), v).toEqual([
        "team_invalid",
      ]);
    }
    const eleven = Array.from({ length: 11 }, (_, i) => `t${i}`).join(", ");
    expect(codesOf(rule(`match: { risk: trivial }\n    require: { team: [${eleven}] }`))).toEqual([
      "too_many_items",
    ]);
    expect(
      parse(rule("match: { risk: trivial }\n    require: { team: [a, b_c, d-e, '1x'] }")).ok,
    ).toBe(true);
  });

  it("U-PS-6 risk, author, agent and label", () => {
    const one = (m: string) => codesOf(rule(`match: { ${m} }\n    block: true`));
    expect(one("risk: urgent")).toEqual(["risk_invalid"]);
    expect(one("risk: [trivial, nope]")).toEqual(["risk_invalid"]);
    expect(one("risk: []")).toEqual(["risk_invalid"]);
    expect(one("author: robot")).toEqual(["author_invalid"]);
    expect(one("agent: '!bad'")).toEqual(["agent_invalid"]);
    expect(one(`agent: ['${"a".repeat(101)}']`)).toEqual(["agent_invalid"]);
    expect(one("labels: ['']")).toEqual(["label_invalid"]);
    expect(one(`labels: ['${"a".repeat(51)}']`)).toEqual(["label_invalid"]);
    expect(one('labels: ["a\\nb"]')).toEqual(["label_invalid"]);
    const many = Array.from({ length: 21 }, (_, i) => `l${i}`).join(", ");
    expect(one(`labels: [${many}]`)).toEqual(["too_many_items"]);
    // Duplicates are folded before they are counted.
    expect(
      parse(rule("match: { risk: [trivial, trivial, trivial, trivial] }\n    block: true")).ok,
    ).toBe(true);
  });

  it("U-PS-7 size", () => {
    const one = (m: string) => codesOf(rule(`match: { size: ${m} }\n    block: true`));
    expect(one("{}")).toEqual(["size_invalid"]);
    expect(one("{ min_lines: -1 }")).toEqual(["size_invalid"]);
    expect(one("{ min_lines: 10, max_lines: 5 }")).toEqual(["size_invalid"]);
    expect(one("{ min_files: 3, max_files: 2 }")).toEqual(["size_invalid"]);
    expect(one("{ max_lines: 1000001 }")).toEqual(["size_invalid"]);
    expect(one("{ max_lines: 1.5 }")).toEqual(["size_invalid"]);
    expect(one("{ max_lines: '5' }")).toEqual(["size_invalid"]);
    expect(
      parse(
        rule(
          "match: { size: { min_lines: 5, max_lines: 5, max_files: 1000000 } }\n    block: true",
        ),
      ).ok,
    ).toBe(true);
  });

  it("U-PS-8 names", () => {
    const one = (n: string) =>
      codesOf(rule(`name: ${n}\n    match: { risk: trivial }\n    block: true`));
    for (const bad of [
      "''",
      "' lead'",
      "'-lead'",
      `'${"a".repeat(81)}'`,
      "'bad/slash'",
      "'bad@x'",
      "7x7y%",
    ]) {
      expect(one(bad), bad).toEqual(["name_invalid"]);
    }
    expect(
      parse(rule("name: 'Ok name_1.2:x-y'\n    match: { risk: trivial }\n    block: true")).ok,
    ).toBe(true);
    const dup = errorsOf(
      "version: 1\nrules:\n  - name: same\n    match: { risk: trivial }\n    block: true\n  - name: same\n    match: { risk: logic }\n    block: true\n",
    );
    expect(dup.map((e) => [e.code, e.location, e.line])).toEqual([
      ["name_duplicate", "rules[2].name", 6],
    ]);
  });

  it("U-PS-9 default is a require", () => {
    expect(codesOf("version: 1\ndefault: { approve: auto }\n")).toEqual(["default_invalid"]);
    expect(codesOf("version: 1\ndefault: { block: true }\n")).toEqual(["default_invalid"]);
    expect(codesOf("version: 1\ndefault: {}\n")).toEqual(["default_invalid"]);
    expect(codesOf("version: 1\ndefault: { require: {} }\n")).toEqual(["require_empty"]);
    const none = parse("version: 1\n");
    if (!none.ok) throw new Error("parse failed");
    expect(none.policy.default).toEqual({ humans: 1, teams: [] });
    const set = parse("version: 1\ndefault: { require: { humans: 2, team: [a, b] } }\n");
    if (!set.ok) throw new Error("parse failed");
    expect(set.policy.default).toEqual({ humans: 2, teams: ["a", "b"] });
  });

  it("U-PS-10 limits on rules, globs and errors", () => {
    const rules = (n: number) =>
      `version: 1\nrules:\n${Array.from({ length: n }, () => "  - match: { risk: trivial }\n    block: true\n").join("")}`;
    expect(parse(rules(200)).ok).toBe(true);
    expect(codesOf(rules(201))).toEqual(["too_many_rules"]);

    const globs = (n: number) => {
      const per = 50;
      const lists = [];
      for (let i = 0; i < n; i += per) {
        const items = Array.from({ length: Math.min(per, n - i) }, (_, j) => `d${i + j}/**`);
        lists.push(`  - match: { paths: [${items.join(", ")}] }\n    block: true\n`);
      }
      return `version: 1\nrules:\n${lists.join("")}`;
    };
    expect(parse(globs(500)).ok).toBe(true);
    expect(codesOf(globs(501))).toEqual(["too_many_globs"]);

    const bad = `version: 1\nrules:\n${Array.from({ length: 60 }, () => "  - match: { risk: trivial }\n").join("")}`;
    const errs = errorsOf(bad);
    expect(errs).toHaveLength(50);
    expect(errs[49]?.code).toBe("too_many_errors");
    expect(errs.slice(0, 49).every((e) => e.code === "action_missing")).toBe(true);
  });

  it("U-PS-11 normalisation: scalars become lists, deduplicated in file order, humans default 1", () => {
    const res = parse(
      rule(
        "match: { risk: sensitive, paths: [b/**, a/**, b/**], agent: [x, X, x], labels: [l, l], only_paths: ['*.md'] }\n    require: { team: sec }",
      ),
    );
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.policy.rules[0]).toEqual({
      index: 1,
      name: null,
      match: {
        risk: ["sensitive"],
        paths: ["b/**", "a/**"],
        onlyPaths: ["*.md"],
        agents: ["x", "X"],
        labels: ["l"],
      },
      action: { kind: "require", humans: 1, teams: ["sec"] },
    });
    const risks = parse(rule("match: { risk: [logic, trivial, logic] }\n    block: true"));
    if (!risks.ok) throw new Error("parse failed");
    expect(risks.policy.rules[0]?.match.risk).toEqual(["logic", "trivial"]);
  });

  it("U-PS-12 no message repeats a value from the file (except the unknown key)", () => {
    const names = readdirSync(new URL("../fixtures/policy/", import.meta.url)).filter((n) =>
      /^(invalid|alias|anchor|merge|tags|duplicate|two|syntax)/.test(n),
    );
    expect(names.length).toBeGreaterThanOrEqual(8);
    const catalogue = POLICY_ERROR_CODES.map((code) =>
      formatPolicyError({ code, location: null, line: null, column: null, key: "k", detail: 1 }),
    ).join("\n");
    let checkedValues = 0;
    for (const name of names) {
      const text = readFileSync(new URL(`../fixtures/policy/${name}`, import.meta.url), "utf8");
      const values = new Set<string>();
      const doc = parseDocument(text, { merge: false, uniqueKeys: false });
      visit(doc, {
        Pair(_k, pair) {
          if (isScalar(pair.value) && typeof pair.value.value === "string")
            values.add(pair.value.value);
        },
        Seq(_k, seq) {
          for (const item of seq.items)
            if (isScalar(item) && typeof item.value === "string") values.add(item.value);
        },
      });
      const res = parsePolicyText(enc(text));
      if (res.ok) continue;
      for (const e of res.errors) {
        const message = formatPolicyError({ ...e, key: undefined });
        const withoutKey = e.code === "unknown_key" ? message.replace("``", "") : message;
        for (const v of values) {
          if (v.length < 6 || catalogue.includes(v)) continue;
          checkedValues++;
          expect(withoutKey, `${name}: ${v}`).not.toContain(v);
        }
      }
    }
    expect(checkedValues).toBeGreaterThan(10);
  });

  it("U-PSCH-1 the committed JSON Schema is current; ajv validates and rejects as expected", () => {
    const committed = readFileSync(
      new URL("../../schema/graft.v1.schema.json", import.meta.url),
      "utf8",
    );
    expect(JSON.parse(committed)).toEqual(policyJsonSchema());
    expect(committed).toBe(`${JSON.stringify(policyJsonSchema(), null, 2)}\n`);
    expect(policyJsonSchema()).toMatchObject({
      $id: "https://raw.githubusercontent.com/mmornati/graft/main/schema/graft.v1.schema.json",
      title: "graft.yaml v1",
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(policyJsonSchema());
    const example = parseDocument(EXAMPLE.toString("utf8")).toJS();
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    const mutate = (f: (d: Record<string, unknown>) => void) => {
      const d = structuredClone(example) as Record<string, unknown>;
      f(d);
      return validate(d);
    };
    expect(mutate((d) => delete d.version)).toBe(false);
    expect(mutate((d) => (d.surprise = 1))).toBe(false);
    expect(
      mutate((d) => {
        const r = (d.rules as Record<string, unknown>[])[0] as Record<string, unknown>;
        r.block = true;
      }),
    ).toBe(false);
    expect(
      mutate((d) => {
        const r = (d.rules as Record<string, unknown>[])[0] as Record<string, unknown>;
        delete r.approve;
      }),
    ).toBe(false);
    expect(
      mutate((d) => {
        const r = (d.rules as Record<string, unknown>[])[0] as Record<string, unknown>;
        r.match = {};
      }),
    ).toBe(false);
  });
});

describe("policy globs", () => {
  it("U-PG-1 every glob_invalid reason has an example", () => {
    const cases: [number, string][] = [
      [1, ""],
      [1, "a".repeat(201)],
      [2, "!negated"],
      [2, "{a,b}"],
      [2, "a|b"],
      [2, "a\\b"],
      [2, "a^b"],
      [2, "a$b"],
      [2, "(a)"],
      [3, "a/../b"],
      [3, "a//b"],
      [3, "a/"],
      [3, "/"],
      [4, "**/**/**/**/**/x"],
      [5, "*a*b*c*d"],
      [6, "a[b"],
      [6, "a]b"],
      [6, "[[a]]"],
      [7, "[z-a]"],
    ];
    for (const [detail, glob] of cases) expect(validateGlob(glob), glob.slice(0, 20)).toBe(detail);
    for (const ok of [
      "a",
      "/a/b",
      "**/x/**",
      "*a*b*",
      "src/[abc]?.ts",
      "a b/c",
      "x@y+z=~#%,",
      "é/日本/**",
    ]) {
      expect(validateGlob(ok), ok).toBeNull();
    }
    // Each reason reaches the error list with its detail.
    const errs = errorsOf(rule("match: { paths: ['a/../b', '[z-a]', 'a|b'] }\n    block: true"));
    expect(errs.map((e) => [e.code, e.detail])).toEqual([
      ["glob_invalid", 3],
      ["glob_invalid", 7],
      ["glob_invalid", 2],
    ]);
  });

  it("U-PG-2 the floor's globMatcher is the shared one: 30 path/glob pairs behave the same", () => {
    const pairs: [string, string][] = [
      ["src/a.ts", "*.ts"],
      ["a.ts", "*.ts"],
      ["src/a.ts", "/*.ts"],
      ["a.ts", "/*.ts"],
      ["infra/main.tf", "infra/**"],
      ["deep/infra/main.tf", "infra/**"],
      ["Infra/Main.tf", "infra/**"],
      [".github/workflows/ci.yml", ".github/workflows/**"],
      ["a/.hidden", "a/*"],
      [".env", ".env"],
      ["x/.env", ".env"],
      ["docs/a/b.md", "docs/**"],
      ["docs", "docs/**"],
      ["README.md", "*.md"],
      ["a/b/c/README.md", "*.md"],
      ["src/auth/login.ts", "**/auth/**"],
      ["auth/login.ts", "**/auth/**"],
      ["src/Auth/x", "**/auth/**"],
      ["a.test.ts", "*.test.*"],
      ["src/a.test.ts", "*.test.*"],
      ["services/billing/pay.ts", "services/billing/**"],
      ["x/services/billing/pay.ts", "services/billing/**"],
      ["graft.yaml", "/graft.yaml"],
      ["sub/graft.yaml", "/graft.yaml"],
      ["a.ts", "?.ts"],
      ["ab.ts", "?.ts"],
      ["a/b", "a/[bc]"],
      ["a/d", "a/[bc]"],
      ["é.md", "*.md"],
      ["日本/a", "日本/**"],
    ];
    expect(pairs).toHaveLength(30);
    for (const nocase of [true, false]) {
      for (const [path, glob] of pairs) {
        expect(floorGlobMatcher([glob], { nocase })(path), `${glob} ~ ${path}`).toBe(
          globMatcher([glob], { nocase })(path),
        );
      }
    }
    expect(floorGlobMatcher).toBe(globMatcher);
    expect(globMatcher(["*.ts"])("a.ts")).toBe(true);
    expect(globMatcher([])("a")).toBe(false);
  });

  it("U-PG-3 nocase: false tells Docs/ from docs/; the default does not", () => {
    expect(globMatcher(["docs/**"])("Docs/A.md")).toBe(true);
    expect(globMatcher(["docs/**"], { nocase: true })("Docs/A.md")).toBe(true);
    expect(globMatcher(["docs/**"], { nocase: false })("Docs/A.md")).toBe(false);
    expect(globMatcher(["docs/**"], { nocase: false })("docs/A.md")).toBe(true);
  });

  it("U-PG-4 three stars against a 255-character non-matching segment stay fast", () => {
    const budget = new GlobBudget();
    const m = globMatcher(["*a*b*c"], { budget });
    const hay = "x".repeat(255);
    const started = performance.now();
    expect(m(hay)).toBe(false);
    expect(m(`${"a".repeat(120)}${"b".repeat(120)}x`)).toBe(false);
    expectDuration(performance.now() - started, 50);
    // Deterministic: the two calls cost about 500 work units in all (measured 512).
    expect(EVALUATION_FUEL - budget.fuel).toBeLessThan(2_000);
    expect(budget.limitHits).toBe(0);
  });

  it("U-PG-5 a leading slash anchors, no slash means any depth, dot files match", () => {
    expect(globMatcher(["/a.ts"])("a.ts")).toBe(true);
    expect(globMatcher(["/a.ts"])("x/a.ts")).toBe(false);
    expect(globMatcher(["a.ts"])("x/y/a.ts")).toBe(true);
    expect(globMatcher(["x/a.ts"])("y/x/a.ts")).toBe(false);
    expect(globMatcher(["*.yml"])(".github/ci.yml")).toBe(true);
    expect(globMatcher(["src/**"])("src/.hidden/a")).toBe(true);
  });

  it("U-PG-6 500 globs against 1,000 paths in under a second", () => {
    const globs = Array.from({ length: 500 }, (_, i) => `d${i}/**/*.ts`);
    const paths = Array.from({ length: 1_000 }, (_, i) => `src/m${i % 40}/f${i}.ts`);
    const started = performance.now();
    const budget = new GlobBudget();
    const m = globMatcher(globs, { budget });
    let hits = 0;
    for (const p of paths) if (m(p)) hits++;
    expect(hits).toBe(0);
    expectDuration(performance.now() - started, 1_000);
    // Deterministic: 500,000 pairs for about 4.7 M units (about 9 each), nowhere near the budget.
    expect(budget.pairsUsed).toBe(500_000);
    expect(EVALUATION_FUEL - budget.fuel).toBeLessThan(7_000_000);
    expect(budget.exhausted).toBe(false);
  });
});

describe("segment-wise glob matcher (no backtracking)", () => {
  // `.` and `..` segments cannot occur in git paths; picomatch treats them specially.
  function corpus() {
    let seed = 20_251_015;
    const rnd = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
    const pieces = [
      "a",
      "b",
      "A",
      "a",
      "*",
      "*",
      "?",
      "[ab]",
      "[a-c]",
      "[A-B]",
      "[-a]",
      "[a-]",
      "[*]",
      "[?]",
      "[ ]",
      "[Z-a]",
      "[é-ü]",
      ".",
      "-",
      "_",
      "é",
      "**",
      "@",
      "+",
      "=",
      "~",
      "#",
      "%",
      ",",
      " ",
      "ß",
      "\u212a",
      "ı",
      "É",
    ];
    const alpha = [
      "a",
      "b",
      "A",
      "B",
      ".",
      "-",
      "_",
      "é",
      "1",
      "@",
      "+",
      "=",
      "~",
      "#",
      "%",
      ",",
      " ",
      "ß",
      "\u212a",
      "ı",
      "É",
      "ü",
      "[",
      "]",
      "[ab]",
      "[a-c]",
      "[A-B]",
      "[é-ü]",
      "[ ]",
      "*",
      "?",
    ];
    const seg = () => {
      if (rnd() < 0.2) return "**";
      return Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(pieces)).join("");
    };
    const glob = () => {
      const g = Array.from({ length: 1 + Math.floor(rnd() * 4) }, seg).join("/");
      return rnd() < 0.2 ? `/${g}` : g;
    };
    const path = () =>
      Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
        const s = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(alpha)).join("");
        return s === "." || s === ".." ? "x" : s;
      }).join("/");
    return { glob, path, rnd, pick };
  }

  it("U-PG-7 agrees with picomatch on 3,000 generated globs x 30 paths, both case modes", () => {
    const { glob, path, rnd, pick } = corpus();
    const real = [
      "*.ts",
      "/*.ts",
      "infra/**",
      ".github/workflows/**",
      "**/auth/**",
      "*.test.*",
      "docs/**",
      "src/**/*.md",
      "**/migrations/**",
      "/graft.yaml",
      "/.graft/**",
      "*.lock",
      "package-lock.json",
      "a/*/c",
      "?.ts",
      "a/[bc]",
    ];
    const realPaths = [
      "src/a.ts",
      "a.ts",
      "infra/main.tf",
      "Infra/Main.tf",
      ".github/workflows/ci.yml",
      "src/auth/login.ts",
      "docs",
      "docs/a/b.md",
      "src/x/y/z.md",
      "db/migrations/001.sql",
      "graft.yaml",
      ".graft/x.yaml",
      "yarn.lock",
      "sub/package-lock.json",
      "a/b/c",
      "a/c",
      "a/x/c",
      "ab.ts",
      "é.md",
    ];
    let compared = 0;
    const check = (g: string, given: string[]) => {
      if (validateGlob(g) !== null) return;
      // Step 6 (U-PG-25): paths equal to the glob's text exercise picomatch's `input === glob` path.
      const paths = [...given, normalizeGlob(g)];
      for (const nocase of [true, false]) {
        const pm = picomatch(normalizeGlob(g), { dot: true, nocase });
        const mine = globMatcher([g], { nocase });
        for (const p of paths) {
          const expected = pm(p);
          const got = mine(p);
          // Case-insensitive folding of Kelvin, dotless i and sharp s against classes differs from
          // the RegExp engine in one direction only: the new matcher matches more (strict side).
          const folding = nocase && got && !expected && /[\u212aıß]/.test(g + p);
          if (!folding) expect(got, `${g} ~ ${p} nocase=${nocase}`).toBe(expected);
          compared++;
        }
      }
    };
    for (const g of real) check(g, realPaths);
    for (let i = 0; i < 3_000; i++) {
      check(glob(), Array.from({ length: 30 }, path));
    }
    // Deep paths (6 to 14 segments from a tiny alphabet, so that `**` has real work) against globs
    // with several `**` and stars: the forward matcher must equal picomatch here too.
    const deepSeg = () => pick(["a", "b", "ab", "ba", "A", "a.b", "b-a", "é", "[ab]", "a[ab]"]);
    const deepPath = () => Array.from({ length: 6 + Math.floor(rnd() * 9) }, deepSeg).join("/");
    const deepGlob = () => {
      const n = 1 + Math.floor(rnd() * 5);
      const segs = Array.from({ length: n }, () =>
        rnd() < 0.35
          ? "**"
          : pick([
              "a",
              "b",
              "*a",
              "a*",
              "*b*",
              "?",
              "[ab]",
              "*",
              "ab",
              "b*a",
              "a?",
              "*.b",
              "*[ab]",
              "[ab]*",
              "a[ab]",
            ]),
      );
      const g = segs.join("/");
      return rnd() < 0.15 ? `/${g}` : g;
    };
    for (let i = 0; i < 2_000; i++) {
      check(deepGlob(), Array.from({ length: 30 }, deepPath));
    }
    expect(compared).toBeGreaterThan(100_000);
  });

  it("U-PG-8 the worst accepted globs against 1,000 maximum-length paths finish in under a second", () => {
    const longSeg = (n: number, ch = "a") => ch.repeat(n);
    const segs = (n: number, len: number, ch = "a") => Array(n).fill(longSeg(len, ch)).join("/");
    // The reviewer's two pathological shapes, then the widest accepted variants.
    const reviewer1 = "**/*a*a*/**/*a*a*";
    const reviewer2 = "**/*a*/**/*a*/**/*a*/**/*a*";
    const four = "**/*a*a*a/**/*a*a*a/**/*a*a*a/**/*a*a*a";
    const wide = `*a*a*a${"?".repeat(40)}b`;
    const many = `${Array(4).fill("**").join("/a*a*a/")}/${"a?".repeat(20)}`;
    const longest = `${"a*".repeat(3)}${"[ab]".repeat(10)}z`;
    // Long literals between stars: the shape that cost 1.3 s per 1,000 paths before the cost cap.
    const literal = `*${"a".repeat(44)}b?x*`;
    const literal2 = `*a*a*${"a".repeat(40)}b`;
    const mixed = `${"?".repeat(20)}*${"a".repeat(24)}b*`;
    const cases: [string, string][] = [
      [reviewer1, segs(12, 50)],
      [reviewer1, `${segs(11, 50)}/b`],
      [reviewer2, segs(10, 20)],
      [reviewer2, `${segs(10, 20)}/b`],
      [four, segs(8, 30)],
      [four, `${segs(8, 30)}/b`],
      [four, segs(128, 7)],
      [four, `${longSeg(1_022)}/b`],
      [wide, longSeg(1_024)],
      [many, segs(100, 9)],
      [longest, longSeg(1_024)],
      [literal, longSeg(1_024)],
      [literal, `${longSeg(1_000)}/${longSeg(20)}`],
      [literal2, longSeg(1_024)],
      [mixed, longSeg(1_024)],
    ];
    let slowest = 0;
    for (const [glob, path] of cases) {
      expect(validateGlob(glob), glob).toBeNull();
      expect(path.length).toBeLessThanOrEqual(1_024);
      // A budget far above any real one, only to count the work units of 1,000 calls.
      const budget = new GlobBudget(1e15);
      const m = globMatcher([glob], { budget });
      const started = performance.now();
      for (let i = 0; i < 1_000; i++) m(path);
      const took = performance.now() - started;
      slowest = Math.max(slowest, took);
      expectDuration(took, 1_000, `${glob} x ${path.length} chars`);
      // Deterministic: every case costs under 9,000 units per call (measured at most 8,860), and
      // none runs into the per-call limit.
      expect((1e15 - budget.fuel) / 1_000, `${glob} x ${path.length} chars`).toBeLessThan(20_000);
      expect(budget.limitHits).toBe(0);
    }
    expectDuration(slowest, 1_000);
  }, 60_000);

  it("U-PG-9 over-long paths answer onLimit (strict side); a spent budget does too", () => {
    const longPath = `${"d/".repeat(600)}x`; // 1,201 characters
    expect(globMatcher(["*.never"], { onLimit: true })(longPath)).toBe(true);
    expect(globMatcher(["*.never"], { onLimit: false })(longPath)).toBe(false);
    expect(globMatcher(["*.never"])(longPath)).toBe(false);
    const manySegments = Array(PATH_LIMITS.segments + 1)
      .fill("a")
      .join("/");
    expect(globMatcher(["*.never"], { onLimit: true })(manySegments)).toBe(true);
    expect(globMatcher(["*.never"], { onLimit: false })(manySegments)).toBe(false);
    // At the caps the matcher still answers for real.
    const atCap = `${"a".repeat(PATH_LIMITS.chars - 2)}.x`;
    expect(globMatcher(["*.x"], { onLimit: false })(atCap)).toBe(true);
    expect(globMatcher(["*.y"], { onLimit: true })(atCap)).toBe(false);
    // A rule with nothing to match never matches, whatever onLimit says.
    expect(globMatcher([], { onLimit: true })(longPath)).toBe(false);
    // Many hostile globs on one maximum-length path spend the call's budget: onLimit, not a hang.
    const hostile = Array.from({ length: 20 }, (_, k) => `*a*a*a${"?".repeat(100 + k)}b?`);
    const aaa = "a".repeat(PATH_LIMITS.chars);
    const started = performance.now();
    const budget = new GlobBudget();
    expect(globMatcher(hostile, { onLimit: true, budget })(aaa)).toBe(true);
    expect(globMatcher(hostile, { onLimit: false })(aaa)).toBe(false);
    expectDuration(performance.now() - started, 100);
    // Deterministic: the call stopped at its own limit (200,000 units), once.
    expect(budget.limitHits).toBe(1);
    expect(EVALUATION_FUEL - budget.fuel).toBeLessThanOrEqual(MATCH_FUEL + 1_000);
  });

  it("U-PG-10 `***` and `]+` are not accepted (picomatch gives them regex meaning)", () => {
    expect(validateGlob("a/***")).toBe(7);
    expect(validateGlob("[a-c]+")).toBe(7);
    expect(validateGlob("**/*a*a*/**/*a*a*")).toBeNull();
  });
});

describe("glob cost caps and the evaluation budget (review 2)", () => {
  it("U-PG-11 the cost cap, `/` inside brackets and the new reasons", () => {
    expect(validateGlob(`*${"a".repeat(48)}*`)).toBeNull();
    expect(validateGlob(`*${"a".repeat(49)}*`)).toBe(8);
    expect(validateGlob(`${"a".repeat(40)}/${"b".repeat(40)}/${"c".repeat(40)}`)).toBe(8);
    expect(validateGlob(`${"a".repeat(48)}/${"b".repeat(48)}`)).toBeNull();
    // Stars and `**` segments do not count.
    expect(validateGlob(`${"**/".repeat(4)}${"a".repeat(48)}/*a*a*/${"b".repeat(40)}`)).toBeNull();
    expect(validateGlob("secrets/[a/b]")).toBe(6);
    expect(validateGlob("[a/b]")).toBe(6);
    expect(GLOB_REASONS[8]).toContain("too costly");
    const errs = errorsOf(
      `version: 1\nrules:\n  - match: { paths: ['${"a".repeat(60)}', 'x/[a/b]'] }\n    block: true\n`,
    );
    expect(errs.map((e) => [e.code, e.detail])).toEqual([
      ["glob_invalid", 8],
      ["glob_invalid", 6],
    ]);
  });

  /** The largest policy the validator accepts: 161 block rules of three long-literal globs. */
  function worstPolicyText(): string {
    const g = `*${"a".repeat(44)}b?x*`;
    let y =
      "version: 1\nsensitive_paths: [" +
      [g, g.replace("?x", "?y")].map((x) => `'${x}'`).join(", ") +
      "]\nrules:\n";
    for (let n = 0; n < 200; n++) {
      const rule = `  - match: { paths: ['${g}', '${g.replace("?x", "?y")}', '${g.replace("?x", "?z")}'] }\n    block: true\n`;
      if (y.length + rule.length > 32_000) break;
      y += rule;
    }
    return y;
  }
  const hostileFacts = (n: number, over: Partial<PolicyFacts> = {}): PolicyFacts => ({
    files: Array.from({ length: n }, (_, i) => ({
      path: `${"a".repeat(1_000)}b${String(i).padStart(23, "0")}`,
      previousPath: `${"a".repeat(1_000)}b${String(i).padStart(22, "0")}x`,
    })),
    listingComplete: true,
    size: { lines: 0, files: n },
    risk: { value: "trivial", final: true, source: "card" },
    author: { kind: "human", agent: null },
    labels: [],
    ...over,
  });

  it("U-PG-12 the worst accepted 32 KB policy against 1,000 maximum-length files stays under a second or two, and strict", () => {
    const text = worstPolicyText();
    expect(text.length).toBeLessThanOrEqual(32_768);
    const parsedPolicy = parsePolicyText(enc(text));
    if (!parsedPolicy.ok) throw new Error(JSON.stringify(parsedPolicy.errors.slice(0, 2)));
    expect(parsedPolicy.policy.rules.length).toBeGreaterThan(100);
    const started = performance.now();
    const v = evaluatePolicy(parsedPolicy.policy, hostileFacts(1_000));
    const took = performance.now() - started;
    expectDuration(took, 2_000);
    expect(v.limits).toContain("budget_exhausted");
    // Strict: nothing is approved, and the remaining block rules count as matching.
    expect(v.outcome).toBe("would_block");
    expect(v.effectiveRisk.value).toBe("sensitive");
    // The same policy with an approve-only rule set never approves either.
    const approving = parsePolicyText(
      enc(
        `${text}  - match: { only_paths: ['**'] }\n    approve: auto\n`.replace(
          "block: true",
          "block: true",
        ),
      ),
    );
    if (approving.ok) {
      const w = evaluatePolicy(approving.policy, hostileFacts(1_000));
      expect(w.outcome).not.toBe("would_approve");
    }
  });

  it("U-PG-13 the budget is deterministic work, not time: the same input gives the same verdict", () => {
    const parsedPolicy = parsePolicyText(enc(worstPolicyText()));
    if (!parsedPolicy.ok) throw new Error("invalid");
    const facts = hostileFacts(300);
    const a = evaluatePolicy(parsedPolicy.policy, facts);
    const b = evaluatePolicy(parsedPolicy.policy, facts);
    expect(b).toEqual(a);
    // Fuel alone decides: a tiny budget exhausts at once, on any machine.
    const budget = new GlobBudget(5);
    const m = globMatcher(["*.ts"], { budget, onLimit: true });
    expect(m("src/a.js")).toBe(true);
    expect(budget.exhausted).toBe(true);
    expect(globMatcher(["*.ts"], { budget, onLimit: false })("src/a.ts")).toBe(false);
  });

  // ---- review 3: class-heavy and mixed worst cases, policy and floor back to back ----
  const CLASS44 = "bcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR"; // 44 distinct characters
  function classPolicyText(shape: "class" | "mixed"): string {
    const cls = `*[${CLASS44}]x*`;
    const two = `**/*[${CLASS44.slice(0, 43)}]*/**/*[${CLASS44.slice(0, 43)}]x*`;
    const lit = `*${"a".repeat(44)}b?x*`;
    const pick = (i: number) =>
      shape === "class" ? cls : i % 3 === 0 ? cls : i % 3 === 1 ? two : lit;
    const sensitive = Array.from({ length: 20 }, (_, i) => `'${pick(i)}'`).join(", ");
    let y = `version: 1\nsensitive_paths: [${sensitive}]\nrules:\n`;
    for (let n = 0; n < 200; n++) {
      const rule = `  - match: { paths: ['${pick(n)}'] }\n    block: true\n`;
      if (y.length + rule.length > 32_700) break;
      y += rule;
    }
    return y;
  }
  const floorFiles = (n: number): ChangedFile[] =>
    hostileFacts(n).files.map((f) => ({
      path: f.path,
      previousPath: f.previousPath,
      status: "renamed" as const,
      additions: 0,
      deletions: 0,
      patch: null,
    }));
  const floorInput = (files: ChangedFile[]): FloorInput => ({
    files,
    pr: { additions: 0, deletions: 0, changedFiles: files.length },
    listingTruncated: false,
    tooLarge: false,
    partialPaths: [],
    untrustedTexts: [],
  });

  for (const shape of ["class", "mixed"] as const) {
    it(`U-PG-14 ${shape} worst case: 200 rules x 1,000 maximum-length files, policy then floor, under 2 s and strict`, () => {
      const text = classPolicyText(shape);
      expect(text.length).toBeLessThanOrEqual(32_768);
      const res = parsePolicyText(enc(text));
      if (!res.ok) throw new Error(JSON.stringify(res.errors.slice(0, 2)));
      expect(res.policy.rules.length).toBeGreaterThan(150);
      const files = floorFiles(1_000);
      const started = performance.now();
      const v = evaluatePolicy(res.policy, hostileFacts(1_000));
      const floor = computeRiskFloor(floorInput(files), {
        extraSensitiveGlobs: res.policy.sensitivePaths,
      });
      const took = performance.now() - started;
      expectDuration(took, 2_000, `${shape}: policy + floor`);
      expect(v.limits).toContain("budget_exhausted");
      expect(v.outcome).toBe("would_block");
      // The floor alone only sees the 20 `sensitive_paths`, which the budget covers; it must not
      // be slow either, and it never reports a spent budget it did not spend.
      expect(floor.reasons.map((r) => r.rule)).not.toContain("listing_truncated");
      // One budget for the whole job (floor first, then the policy) is no slower.
      const shared = new GlobBudget();
      const t2 = performance.now();
      computeRiskFloor(
        floorInput(files),
        { extraSensitiveGlobs: res.policy.sensitivePaths },
        shared,
      );
      const w = evaluatePolicy(res.policy, hostileFacts(1_000), { budget: shared });
      expectDuration(performance.now() - t2, 2_000);
      expect(w.limits).toContain("budget_exhausted");
      expect(shared.exhausted).toBe(true);
    });
  }

  it("U-PG-15 the verdict is the same whatever the wall clock allows, because fuel binds first", () => {
    const res = parsePolicyText(enc(classPolicyText("mixed")));
    if (!res.ok) throw new Error("invalid");
    const run = (wallMs: number) =>
      evaluatePolicy(res.policy, hostileFacts(1_000), {
        budget: new GlobBudget(undefined, wallMs),
      });
    const a = run(600_000);
    const b = run(5_000);
    const c = run(600_000);
    expect(a.limits).toContain("budget_exhausted");
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(c.matched.map((m) => [m.index, m.reasons.map((r) => r.uncertain)])).toEqual(
      a.matched.map((m) => [m.index, m.reasons.map((r) => r.uncertain)]),
    );
  });

  it("U-PG-16 a class costs the same as a literal: precomputed table, one unit per character", () => {
    const path = "a".repeat(1_000);
    const cost = (glob: string): number => {
      const budget = new GlobBudget();
      const m = globMatcher([glob], { budget });
      for (let i = 0; i < 20; i++) m(`${path}${String(i).padStart(10, "0")}`);
      return EVALUATION_FUEL - budget.fuel;
    };
    const lit = cost(`*${"a".repeat(30)}?y*`);
    const set = cost(`*[${CLASS44}]y*`);
    expect(set).toBeLessThan(lit * 2);
    expect(set).toBeGreaterThan(0);
    // Non-ASCII class members stay correct (memoised after the first miss).
    expect(globMatcher(["[é-ü]x"])("Éx")).toBe(true);
    expect(globMatcher(["[é-ü]x"], { nocase: false })("Éx")).toBe(false);
  });

  it("U-PG-17 the memo for code units above 255 is charged per miss and bounded globally", () => {
    // Two paths of the same shape: the first pays for the misses, the second finds them memoised.
    const budget = new GlobBudget();
    const m = globMatcher(["[\u0100-\u0101a-c]?"], { budget });
    const before = budget.fuel;
    m("\u0100x");
    const first = before - budget.fuel;
    const mid = budget.fuel;
    m("\u0100y");
    const second = mid - budget.fuel;
    // Same path length, fold and prepare costs; the class has 2 ranges, so a miss is 4 x 2 = 8.
    expect(first - second).toBe(8);
    // The global bound: filling many classes never exceeds MEMO_TOTAL entries.
    for (let k = 0; k < 40; k++) {
      const mk = globMatcher([`[\u0100-\u4e00z${k}]q`], { nocase: false });
      for (let c = 0x4e00; c < 0x4e00 + 4_000; c++) mk(`${String.fromCharCode(c)}q`);
    }
    expect(memoEntries()).toBeGreaterThan(1_000);
    expect(memoEntries()).toBeLessThanOrEqual(MEMO_TOTAL);
    // Correctness survives a clear.
    expect(globMatcher(["[\u0100-\u0101]"])("\u0101")).toBe(true);
  });

  it("U-PG-18 early exit: an anchored glob costs a small constant on a deep non-matching path", () => {
    const deepPath = `src/${Array.from({ length: 28 }, (_, k) => `seg${k}`).join("/")}/File.java`;
    const segs = deepPath.split("/").length;
    const prepare = deepPath.length + 1 + (segs + 1); // split once, fold once; the same for every glob
    const costOf = (glob: string, budget: GlobBudget, path = deepPath): number => {
      const m = globMatcher([glob], { budget });
      const before = budget.fuel;
      m(path);
      return before - budget.fuel;
    };
    const budget = new GlobBudget();
    // The anchored prefix dies at the first segment: the first call pays the prepare once, plus a
    // handful of units.
    const first = costOf("area3/part1/**", budget);
    expect(first - prepare).toBeLessThanOrEqual(10);
    // Same path, other globs: no prepare at all.
    expect(costOf("services/svc1/**", budget)).toBeLessThanOrEqual(10);
    expect(costOf("/lib/**/x.java", budget)).toBeLessThanOrEqual(10);
    // A required literal segment or a literal tail rejects without walking the segments.
    expect(costOf("**/secrets/**", budget)).toBeLessThanOrEqual(segs + 10); // builds the segment set once
    expect(costOf("**/other/**", budget)).toBeLessThanOrEqual(10);
    expect(costOf("**/*.md", budget)).toBeLessThanOrEqual(25); // joins the folded path once
    expect(costOf("**/*seg999*/**", budget)).toBeLessThanOrEqual(12); // required run `seg999`
    // The same globs when they do match still stay linear in the depth, not in depth x parts.
    expect(costOf("src/**/*.java", budget)).toBeLessThanOrEqual(10 * segs);
    // A trailing `**` accepts as soon as it is reached.
    expect(costOf("src/**", budget)).toBeLessThanOrEqual(10);
    expect(globMatcher(["src/**"])(deepPath)).toBe(true);
    expect(globMatcher(["area3/part1/**"])(deepPath)).toBe(false);
  });

  it("U-PG-19 no module counter can wrap: scratch flags are cleared after every call, also on a spent budget", () => {
    const paths: [string, string][] = [
      ["**/secrets/**", "a/secrets/b.env"],
      ["*.ts", "src/a.ts"],
      ["infra/**", "infra/main.tf"],
      ["docs/**", "docs"],
    ];
    const check = () => {
      for (const [g, p] of paths) expect(globMatcher([g])(p), `${g} ~ ${p}`).toBe(true);
    };
    check();
    const deep = Array(127).fill("a").join("/");
    for (let i = 0; i < 20_000; i++) {
      globMatcher(["**/*"])(deep);
      globMatcher(["**/a*/**/[ab]*/x"])(deep);
    }
    expect(matcherScratchClean()).toBe(true);
    check();
    // A call that stops half way on a spent budget leaves nothing behind either.
    for (const fuel of [1, 7, 40, 300]) {
      const budget = new GlobBudget(fuel);
      globMatcher(["**/a*/**/[ab]*/x", "**/*"], { budget, onLimit: true })(deep);
      expect(matcherScratchClean(), `fuel ${fuel}`).toBe(true);
    }
    check();
    // Structural guard: the matcher keeps no ever-growing counter in a fixed-width array (review
    // 6: an Int32 generation clock wrapped after 2^31 ticks and every glob stopped matching).
    const source = readFileSync(new URL("../../src/core/glob.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/stampClock|Stamp\b/);
    // A glob longer than the initial scratch grows it and still matches.
    const manyParts = `${Array.from({ length: 100 }, (_, i) => `d${i}`).join("/")}/**`;
    const fullPath = `${Array.from({ length: 100 }, (_, i) => `d${i}`).join("/")}/x`;
    expect(globMatcher([manyParts])(fullPath)).toBe(true);
    expect(globMatcher([manyParts])(`${fullPath}/y`)).toBe(true);
    expect(globMatcher([`${manyParts.replace("d99", "zz")}`])(fullPath)).toBe(false);
  });

  it("U-PG-20 `**` glued to other characters is rejected, and a class's literal text matches as in picomatch", () => {
    for (const g of ["/**.ts", "**.ts", "a**b", "x/**y/z", "**/a**"]) {
      expect(validateGlob(g), g).toBe(7);
    }
    expect(validateGlob("**/*.ts")).toBeNull();
    expect(validateGlob("a/**/b")).toBeNull();
    // picomatch: `[ab]` is also its own text; ranges and bodies with - * ? + . are not.
    expect(globMatcher(["*[ab]"])("x[Ab]")).toBe(true);
    expect(globMatcher(["*[ab]"], { nocase: false })("x[Ab]")).toBe(false);
    expect(globMatcher(["*[ab]"], { nocase: false })("x[ab]")).toBe(true);
    expect(globMatcher(["*[ab]"])("xa")).toBe(true);
    expect(globMatcher(["secret[ab]"])("secret[ab]")).toBe(true);
    expect(globMatcher(["[a-c]"])("[a-c]")).toBe(false);
    expect(globMatcher(["[a-c]"])("b")).toBe(true);
    expect(globMatcher(["[a.b]"])("[a.b]")).toBe(false);
  });
});

describe("step 6: lookalike globs, warnings and the exact-text shortcut", () => {
  it("U-PG-21 a segment that mixes writing systems is glob_invalid detail 9", () => {
    expect(validateGlob("s\u0435crets/**")).toBe(9); // Cyrillic е in Latin text
    expect(validateGlob("**/p\u0430yments/**")).toBe(9); // Cyrillic а
    expect(validateGlob("inf\u03BF/**")).toBe(9); // Greek omicron
    expect(validateGlob("secrets/**")).toBeNull();
    expect(GLOB_REASONS[9]).toContain("mixes writing systems");
    // The detail reaches the error list with its message.
    const err = errorsOf(
      rule("match: { paths: ['s\u0435crets/**'] }\n    block: true"),
    )[0] as PolicyError;
    expect(err).toMatchObject({ code: "glob_invalid", detail: 9 });
    expect(formatPolicyError(err)).toContain("mixes writing systems in one segment");
  });

  it("U-PG-21 (invisible and compatibility lookalikes) are rejected; honest accents and CJK stay valid", () => {
    // Invisible characters: detail 2 (character not allowed).
    for (const bad of [
      "sec\u034Frets/**", // combining grapheme joiner
      "secrets\uFE0F/**", // variation selector
      "secrets\u{E0100}/**", // variation selector supplement
      "secrets\u180B/**", // Mongolian free variation selector
      "sec\u200Brets/**", // zero-width space
      "sec\u200Drets/**", // zero-width joiner
      "sec\u2060rets/**", // word joiner
      "\uFEFFsecrets/**", // byte order mark
      "\u0301secrets/**", // a mark with no letter before it
      "se*\u0301crets/**", // a mark after a star
      "a/\u0301b/**", // a mark at the start of a segment
      "x1\u0301/**", // a mark after a digit
    ]) {
      expect(validateGlob(bad), JSON.stringify(bad)).toBe(2);
    }
    // Compatibility lookalikes: detail 9.
    // Compatibility characters: detail 10, checked one code point at a time.
    for (const bad of [
      "\uFF53ecrets/**", // fullwidth s
      "\u{1D42C}ecrets/**", // mathematical bold s
      "\u212Aeys/**", // Kelvin sign: its canonical decomposition is the Latin K
      "\u212Bngstrom/**", // Angstrom sign
      "\u2126/**", // Ohm sign
      "\uF900/**", // CJK compatibility ideograph
      "\u3131\u3131/**", // compatibility jamo
    ]) {
      expect(validateGlob(bad), JSON.stringify(bad)).toBe(10);
    }
    expect(GLOB_REASONS[10]).toContain("compatibility character");
    expect(GLOB_REASONS[10]).not.toContain("writing systems");
    expect(validateGlob("\uFF0A/x")).toBe(2); // a fullwidth asterisk is not in the character set
    // Legitimate: precomposed and decomposed accents, CJK, Hangul, Japanese.
    for (const ok of [
      "caf\u00e9/**",
      "cafe\u0301/**",
      "\u65e5\u672c\u8a9e/**",
      "\ud55c\uae00/**",
      "\u30c9\u30ad\u30e5\u30e1\u30f3\u30c8/**",
      "\u0440\u0443\u043a/**",
    ]) {
      expect(validateGlob(ok), ok).toBeNull();
    }
    // The same through a parsed file.
    expect(codesOf('version: 1\nsensitive_paths:\n  - "sec\u034Frets/**"\n')).toEqual([
      "glob_invalid",
    ]);
  });

  it("U-PG-22 legitimate non-ASCII paths stay valid", () => {
    for (const ok of [
      "docs/\u0440\u0443\u043a\u043e\u0432\u043e\u0434\u0441\u0442\u0432\u043e/**", // all Cyrillic
      "\u30c9\u30ad\u30e5\u30e1\u30f3\u30c8/\u8a2d\u5b9a/**", // Katakana, then Han
      "src/\ud55c\uae00v2/**", // Hangul + Latin
      "caf\u00e9/**", // precomposed accent
      "cafe\u0301/**", // combining accent
      "src/\u65e5\u672c\u8a9e_ja/*.md", // Han + Latin
      "\u3072\u3089\u304c\u306a\u30ab\u30bf\u30ab\u30ca\u6f22\u5b57-x/**", // Japanese mix
      "\u3105\u3106\u6f22x/**", // Bopomofo + Han + Latin
    ]) {
      expect(validateGlob(ok), ok).toBeNull();
    }
    // Digits and punctuation belong to no script; Greek and Cyrillic still do not mix.
    expect(validateGlob("a1_b-2/**")).toBeNull();
    expect(validateGlob("\u0440\u03bf/**")).toBe(9);
    // Hangul with Hiragana is not a permitted mix.
    expect(validateGlob("\ud55c\u3072/**")).toBe(9);
  });

  it("U-PG-23 mixing is judged per segment", () => {
    expect(
      validateGlob("\u0440\u0443\u043a\u043e\u0432\u043e\u0434\u0441\u0442\u0432\u043e/docs/**"),
    ).toBeNull();
    expect(
      validateGlob("docs/\u0440\u0443\u043a\u043e\u0432\u043e\u0434\u0441\u0442\u0432\u043e/**"),
    ).toBeNull();
    expect(validateGlob("docs/\u0440\u0443k/**")).toBe(9);
  });

  it("U-PG-24 a path equal to the glob text matches as in picomatch, and the comparison is charged", () => {
    for (const [glob, path] of [
      ["/[0-9]", "[0-9]"],
      ["[0-9]", "[0-9]"],
      ["[0-9]", "**/[0-9]"],
      ["/./a", "./a"],
      ["./a", "./a"],
      ["/a?", "a?"],
    ] as const) {
      if (validateGlob(glob) !== null) continue;
      for (const nocase of [true, false]) {
        const expected = picomatch(normalizeGlob(glob), { dot: true, nocase })(path);
        expect(globMatcher([glob], { nocase })(path), `${glob} ~ ${path} nocase=${nocase}`).toBe(
          expected,
        );
      }
    }
    // `./a` is the case where the shortcut matters: the compiled pattern drops the `./`.
    expect(globMatcher(["./a"])("./a")).toBe(true);
    expect(picomatch("**/./a", { dot: true })("**/./a")).toBe(true);

    // One unit per compared character when the lengths are equal (one unit otherwise).
    const glob = `/${"a".repeat(150)}`;
    const spent = (path: string) => {
      const budget = new GlobBudget();
      globMatcher([glob], { budget })(path);
      return EVALUATION_FUEL - budget.fuel;
    };
    const sameLength = spent("b".repeat(150));
    const otherLength = spent("b".repeat(149));
    // The compared characters (150 against 1) plus one more character prepared.
    expect(sameLength - otherLength).toBeGreaterThanOrEqual(149);
  });

  it("U-PG-25 the differential against picomatch still has no mismatch with text-equal paths", () => {
    const rnd = mulberry32(2026);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const pieces = ["a", "b", "ab", "*", "?", "[ab]", "\u00e9", ".", "-", "x1"];
    const seg = () =>
      rnd() < 0.2
        ? "**"
        : Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(pieces)).join("");
    const glob = () => {
      const g = Array.from({ length: 1 + Math.floor(rnd() * 3) }, seg).join("/");
      return rnd() < 0.2 ? `/${g}` : g;
    };
    let compared = 0;
    for (let i = 0; i < 2_000; i++) {
      const g = glob();
      if (validateGlob(g) !== null) continue;
      for (const nocase of [true, false]) {
        const pm = picomatch(normalizeGlob(g), { dot: true, nocase });
        const mine = globMatcher([g], { nocase });
        const n = normalizeGlob(g);
        // A glob starting with `./` (not a repository path form) is only tried on its own text.
        for (const p of n.startsWith("./") ? [n] : [n, `${n}/x`, `x/${n}`]) {
          expect(mine(p), `${g} ~ ${p} nocase=${nocase}`).toBe(pm(p));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(2_000);
  });

  it("U-PY-11 a non-ASCII glob is valid with one glob_non_ascii warning; the hash is unchanged", () => {
    const text =
      'version: 1\nrules:\n  - name: guide\n    match: { paths: ["docs/\u0440\u0443\u043a\u043e\u0432\u043e\u0434\u0441\u0442\u0432\u043e/**"] }\n    require: { humans: 1 }\n';
    const res = parse(text);
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.warnings).toEqual([
      {
        code: "glob_non_ascii",
        location: "rules[1].match.paths[1]",
        line: 4,
        column: 22,
        // Eight distinct non-ASCII letters, capped at five.
        codePoints: ["U+0440", "U+0443", "U+043A", "U+043E", "U+0432"],
      },
    ]);
    expect(JSON.stringify(res.warnings)).not.toContain("\u0440\u0443\u043a");
    // The hash is of the policy alone (this value was computed before step 6 too); a comment
    // changes nothing.
    expect(
      parse(`# a comment\n${text}`).ok && (parse(`# a comment\n${text}`) as { hash: string }).hash,
    ).toBe(res.hash);
    expect(res.hash).toBe("c876d2138c082a10ddbebe91891ce21d084087138d4e86cc89f38dcf72fb60b7");
    // sensitive_paths warn as well; an ASCII file has none.
    const sens = parse('version: 1\nsensitive_paths:\n  - "docs/\u0440\u0443/**"\n');
    expect(sens.ok && sens.warnings.map((w) => w.location)).toEqual(["sensitive_paths[1]"]);
    expect(
      parse(EXAMPLE.toString()).ok &&
        (parse(EXAMPLE.toString()) as { warnings: unknown[] }).warnings,
    ).toEqual([]);
  });

  it("U-PY-12 a lookalike glob in sensitive_paths is glob_invalid detail 9, with line and column", () => {
    const errs = errorsOf('version: 1\nsensitive_paths:\n  - "s\u0435crets/**"\n');
    expect(errs).toEqual([
      { code: "glob_invalid", location: "sensitive_paths[1]", line: 3, column: 5, detail: 9 },
    ]);
  });
});

describe("graft.yaml guard key (Phase 1 step 4)", () => {
  // Computed with the code before this step (origin/main at 6e5885b).
  const BEFORE: Record<string, string> = {
    "docs/examples/graft.yaml": "15b4511afd2fc506ff72ebece14e5ee93fb97e2f9132c5d4fcbb462f9193fe71",
    "minimal.yaml": "2eb972bc224ae0b92fddeb0637a3e45cc994530571651360f8b100fa96608ebf",
    "non-ascii-glob.yaml": "c876d2138c082a10ddbebe91891ce21d084087138d4e86cc89f38dcf72fb60b7",
  };

  it("U-PGD-1 guard.checks parses; a file without guard keeps the hash it had before this step", () => {
    const res = parse('version: 1\nguard:\n  checks: [test, "lint (node 24)", ci/jenkins, test]\n');
    if (!res.ok) throw new Error(JSON.stringify(res.errors));
    expect(res.policy.guard).toEqual({ checks: ["test", "lint (node 24)", "ci/jenkins"] });
    // Its presence is part of the canonical form; nothing else changes.
    const without = parse("version: 1\n");
    if (!without.ok) throw new Error("parse failed");
    expect(without.policy.guard).toBeUndefined();
    expect(res.hash).not.toBe(without.hash);
    const { guard: _guard, ...rest } = res.policy;
    expect(rest).toEqual(without.policy);
    // The evaluator ignores it: the same verdict with and without.
    const facts: PolicyFacts = {
      files: [{ path: "src/a.ts", previousPath: null }],
      listingComplete: true,
      size: { lines: 1, files: 1 },
      risk: { value: "logic", final: true, source: "card" },
      author: { kind: "human", agent: null },
      labels: [],
    };
    expect(evaluatePolicy(res.policy, facts)).toEqual(evaluatePolicy(without.policy, facts));

    const files: [string, Uint8Array][] = [
      ["docs/examples/graft.yaml", EXAMPLE],
      ...readdirSync(new URL("../fixtures/policy/", import.meta.url)).map(
        (f) => [f, fixture(f)] as [string, Uint8Array],
      ),
    ];
    let checked = 0;
    for (const [name, bytes] of files) {
      const r = parsePolicyText(bytes);
      if (!r.ok) {
        expect(BEFORE[name], name).toBeUndefined();
        continue;
      }
      expect(r.hash, name).toBe(BEFORE[name]);
      checked++;
    }
    expect(checked).toBe(Object.keys(BEFORE).length);
  });

  it("U-PGD-2 empty list, 51 items, a 201-character name, a control character and an unknown key", () => {
    const codes = (yaml: string) => codesOf(`version: 1\n${yaml}`);
    expect(codes("guard: { checks: [] }\n")).toEqual(["wrong_type"]);
    const many = Array.from({ length: 51 }, (_, i) => `c${i}`).join(", ");
    expect(codes(`guard: { checks: [${many}] }\n`)).toEqual(["too_many_items"]);
    expect(codes(`guard: { checks: [${"x".repeat(201)}] }\n`)).toEqual(["wrong_type"]);
    expect(parse(`version: 1\nguard: { checks: ["${"x".repeat(200)}"] }\n`).ok).toBe(true);
    expect(codes('guard: { checks: ["bad\\u0007name"] }\n')).toEqual(["wrong_type"]);
    expect(codes('guard: { checks: [""] }\n')).toEqual(["wrong_type"]);
    expect(codes("guard: { checks: test }\n")).toEqual(["wrong_type"]);
    expect(codes("guard: [test]\n")).toEqual(["wrong_type"]);
    const unknown = errorsOf("version: 1\nguard:\n  other: 1\n");
    expect(unknown.map((e) => [e.code, e.key, e.location])).toEqual([
      ["unknown_key", "other", "guard"],
    ]);
    // `auto_merge_reverts` is step 5: still an unknown key here.
    expect(codes("guard: { auto_merge_reverts: [trivial] }\n")).toEqual(["unknown_key"]);
  });
});
