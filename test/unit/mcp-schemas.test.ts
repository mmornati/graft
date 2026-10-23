import { describe, expect, it } from "vitest";
import {
  buildPrBody,
  getPolicyInput,
  getStatusInput,
  openChangeInput,
  reportProvenanceInput,
  validBranchName,
} from "../../src/mcp/schemas.js";
import { normalizeField } from "../../src/modules/provenance/index.js";

const REPO = "graft-sandbox/sample-ts";
const SHA = "a".repeat(40);

describe("MCP tool schemas (Phase 1 step 6, §7)", () => {
  it("U-MCPS-1 each tool's input schema: valid input; missing repository; unknown key; PR number 0 and 2^31", () => {
    const cases = [
      { schema: getStatusInput, valid: { repository: REPO, pr: 2 }, pr: true },
      { schema: getPolicyInput, valid: { repository: REPO, base: "main" }, pr: false },
      {
        schema: reportProvenanceInput,
        valid: { repository: REPO, pr: 2, headSha: SHA, agent: "codex" },
        pr: true,
      },
      {
        schema: openChangeInput,
        valid: { repository: REPO, head: "feat/x", title: "Add x" },
        pr: false,
      },
    ];
    for (const { schema, valid, pr } of cases) {
      expect(schema.safeParse(valid).success, JSON.stringify(valid)).toBe(true);
      const { repository: _r, ...noRepo } = valid;
      expect(schema.safeParse(noRepo).success).toBe(false);
      expect(schema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
      expect(schema.safeParse({ ...valid, repository: "not a repo" }).success).toBe(false);
      if (pr) {
        expect(schema.safeParse({ ...valid, pr: 0 }).success).toBe(false);
        expect(schema.safeParse({ ...valid, pr: 2 ** 31 }).success).toBe(false);
        expect(schema.safeParse({ ...valid, pr: 2 ** 31 - 1 }).success).toBe(true);
        expect(schema.safeParse({ ...valid, pr: 1.5 }).success).toBe(false);
      }
    }
    expect(getPolicyInput.safeParse({ repository: REPO }).success).toBe(true);
    expect(
      reportProvenanceInput.safeParse({ repository: REPO, pr: 2, headSha: "ABC", agent: "x" })
        .success,
    ).toBe(false);
    expect(
      openChangeInput.safeParse({
        repository: REPO,
        head: "feat/x",
        title: "t",
        provenance: { agent: "codex", other: "x" },
      }).success,
    ).toBe(false);
  });

  it("U-MCPS-2 the D17 branch name rule", () => {
    for (const ok of ["feat/x", "a.b-c_d", "main", "release/1.2.3", "x"]) {
      expect(validBranchName(ok), ok).toBe(true);
    }
    for (const bad of [
      "../x",
      "a/../b",
      "a..b",
      "/x",
      "-x",
      "x/",
      "x.lock",
      "owner:x",
      "graft-revert/3f0c1a52-b6d8-4e0f-8a7d-2c4b1e5f6a30",
      "graft-revert/x",
      "a".repeat(201),
      "a b",
      "a\u0000b",
      "a\nb",
      "a\u0007",
      "",
      "a~b",
      "a^b",
      "é",
    ]) {
      expect(validBranchName(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(validBranchName("a".repeat(200))).toBe(true);
  });

  it("U-MCPS-3 D18: title and body bounds; the trailer block is the body's last paragraph; an invalid provenance value is dropped with a warning", () => {
    const parse = (title: string, body?: string) =>
      openChangeInput.safeParse({ repository: REPO, head: "feat/x", title, body }).success;
    expect(parse("t".repeat(256))).toBe(true);
    expect(parse("t".repeat(257))).toBe(false);
    expect(parse(`  ${"t".repeat(256)}  `)).toBe(true);
    expect(parse("   ")).toBe(false);
    expect(parse("two\nlines")).toBe(false);
    expect(parse("bell\u0007")).toBe(false);
    expect(parse("ok", "b".repeat(16_000))).toBe(true);
    expect(parse("ok", "b".repeat(16_001))).toBe(false);

    const validate = (key: "agent" | "model" | "task" | "sessionUrl", raw: string) =>
      normalizeField(key === "sessionUrl" ? "session" : key, raw);
    const built = buildPrBody(
      "Adds x.\n\nGraft-Agent: someone-else",
      {
        agent: "codex",
        model: "bad model with spaces",
        task: "#42",
        sessionUrl: "https://chat.example.com/s/1",
      },
      validate,
    );
    expect(built.warnings).toEqual(["provenance.model dropped: invalid value"]);
    const paragraphs = built.body.split("\n\n");
    expect(paragraphs.at(-1)).toBe(
      "Graft-Agent: codex\nGraft-Task: #42\nGraft-Session: https://chat.example.com/s/1",
    );
    expect(paragraphs.slice(0, -1).join("\n\n")).toBe("Adds x.\n\nGraft-Agent: someone-else");
    // No body: the block alone; no valid value: no block at all.
    expect(buildPrBody(undefined, { agent: "codex" }, validate).body).toBe("Graft-Agent: codex");
    expect(buildPrBody("Body", { sessionUrl: "http://x" }, validate)).toEqual({
      body: "Body",
      warnings: ["provenance.sessionUrl dropped: invalid value"],
    });
    expect(buildPrBody("Body", undefined, validate)).toEqual({ body: "Body", warnings: [] });
    // The warning never echoes the value.
    expect(JSON.stringify(built.warnings)).not.toContain("spaces");
  });
});
