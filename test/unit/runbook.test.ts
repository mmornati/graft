/** Phase 1 step 7 (D20, U-DOC-3): the pilot runbook names only what exists. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseOpsArgs } from "../../src/bin/graft-ops.js";
import { RUNBOOK_STAGE2 } from "../../src/pilot/gate-phase1.js";
import { phase1GateReportSchema } from "../../src/pilot/gate-phase1-render.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNBOOK = path.join(ROOT, "docs/pilots/phase-1-runbook.md");
const text = readFileSync(RUNBOOK, "utf8");

/** Splits a command line; `"…"` and `<…>` are one token each. */
function tokens(line: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|<[^>]*>|\S+/g;
  for (const m of line.matchAll(re)) out.push(m[0].replace(/^"(.*)"$/, "$1"));
  return out;
}

/** The schema of `repositories[]`'s element, walked by a dotted path. */
function hasField(dotted: string): boolean {
  let cur: z.ZodType = phase1GateReportSchema.shape.repositories.element;
  for (const part of dotted.split(".")) {
    const shape = (cur as unknown as { shape?: Record<string, z.ZodType> }).shape;
    if (!shape || !Object.hasOwn(shape, part)) return false;
    cur = shape[part] as z.ZodType;
  }
  return true;
}

describe("the Phase 1 runbook (U-DOC-3)", () => {
  it("U-DOC-3 every relative link resolves; every pnpm graft command parses; every repositories[] field exists; the stage 2 numbers are the code's", () => {
    const links = [...text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)]
      .map((m) => m[1] as string)
      .filter((l) => !/^[a-z]+:/.test(l));
    expect(links.length).toBeGreaterThan(5);
    for (const l of links) {
      expect(existsSync(path.resolve(path.dirname(RUNBOOK), l)), l).toBe(true);
    }

    const commands = [...text.matchAll(/pnpm graft ([^`\n]+)/g)].map((m) =>
      (m[1] as string).trim(),
    );
    expect(commands.length).toBeGreaterThan(10);
    for (const c of commands) {
      expect(() => parseOpsArgs(tokens(c)), c).not.toThrow();
    }
    // The parser is strict: an unknown flag or command is refused.
    expect(() => parseOpsArgs(["mode", "set", "--repo", "o/r", "--nope"])).toThrow();
    expect(() => parseOpsArgs(["mode", "explode"])).toThrow();

    const fields = [...text.matchAll(/repositories\[\]\.([A-Za-z0-9_.]+)/g)].map((m) =>
      (m[1] as string).replace(/\.$/, ""),
    );
    expect(fields.length).toBeGreaterThan(10);
    for (const f of fields) expect(hasField(f), f).toBe(true);
    expect(hasField("nope")).toBe(false);

    expect(text).toContain(`repositories[].merged.total ≥ ${RUNBOOK_STAGE2.minMerged}`);
    expect(text).toContain(`at least ${RUNBOOK_STAGE2.minDays} days`);
    expect(text).toContain(`≤ ${RUNBOOK_STAGE2.maxWouldFailShare.toFixed(2)}`);
    expect(text).toContain(
      `at least ${RUNBOOK_STAGE2.minDays} days and at least ${RUNBOOK_STAGE2.minMerged} merged PRs`,
    );

    // The onboarding guide's §8 and §9 link to the runbook (D20).
    const onboarding = readFileSync(path.join(ROOT, "docs/pilots/onboarding.md"), "utf8");
    const section = (n: number) =>
      onboarding.slice(onboarding.indexOf(`## ${n}.`), onboarding.indexOf(`## ${n + 1}.`));
    expect(section(8)).toContain("phase-1-runbook.md");
    expect(section(9)).toContain("phase-1-runbook.md");
  });
});
