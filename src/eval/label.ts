/**
 * Labeling (T10, E25): blind interactive labeling, `--apply`, double-label assignment and
 * adjudication. The labeler never sees the floor, a card or another labeler's labels; the
 * adjudicator sees the label sets, not model output.
 */
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import {
  type EvalCase,
  gold,
  type LabelSet,
  labelSetSchema,
  type RiskClass,
} from "./case-schema.js";
import { pathStratum, sample, sizeStratum } from "./sample.js";
import { type CaseSet, EvalStoreError, listCaseIds, readCase, writeCase } from "./store.js";
import { renderCase, toTerminalSafe } from "./terminal.js";

/** Must equal the version on the first line of docs/phase-0/labeling-guide.md (U-LBL-6). */
export const LABELING_GUIDE_VERSION = "lg-1";
export const DOUBLE_LABEL_TAG = "double-label";
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export function checkHandle(handle: string): string {
  if (!HANDLE.test(handle)) throw new EvalStoreError("--as must be a handle like ada or bob.k");
  return handle;
}

const sortedPaths = (paths: readonly string[]): string[] => [...new Set(paths)].sort();

const applyEntrySchema = labelSetSchema.omit({
  labeler: true,
  labeledAt: true,
  guideVersion: true,
});

/** `--apply labels.json`: `{ "<caseId>": { risk, outOfScope, goal, ... } }`. */
export async function applyLabels(
  set: CaseSet,
  o: { as: string; json: string; now: Date },
): Promise<{ labeled: number }> {
  checkHandle(o.as);
  let raw: unknown;
  try {
    raw = JSON.parse(o.json);
  } catch {
    throw new EvalStoreError("the labels file is not valid JSON");
  }
  const parsed = z.record(z.string(), applyEntrySchema).safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new EvalStoreError(`the labels file is not valid: ${where}`);
  }
  const updated: EvalCase[] = [];
  for (const [id, entry] of Object.entries(parsed.data)) {
    const c = await readCase(set, id);
    const label: LabelSet = {
      ...entry,
      outOfScope: sortedPaths(entry.outOfScope),
      labeler: o.as,
      labeledAt: o.now.toISOString(),
      guideVersion: LABELING_GUIDE_VERSION,
    };
    updated.push({ ...c, labels: [...c.labels.filter((l) => l.labeler !== o.as), label] });
  }
  // Validate everything (schema refinements run in writeCase) before the first write is final.
  for (const c of updated) await writeCase(set, c);
  return { labeled: updated.length };
}

// ---------------------------------------------------------------------------------------------
// Interactive questions
// ---------------------------------------------------------------------------------------------

export interface LabelIo {
  input: Readable;
  output: Writable;
}

class Lines {
  private readonly rl;
  private readonly it: AsyncIterator<string>;
  constructor(input: Readable) {
    this.rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    this.it = this.rl[Symbol.asyncIterator]();
  }
  /** null at end of input. */
  async next(): Promise<string | null> {
    const r = await this.it.next();
    return r.done ? null : r.value;
  }
  close(): void {
    this.rl.close();
  }
}

const QUIT = Symbol("quit");

/** Asks the questions of §7 in order. `q` (or end of input) at any prompt quits. */
async function askLabelSet(
  c: EvalCase,
  lines: Lines,
  out: Writable,
  o: { labeler: string; now: Date; showCase: boolean },
): Promise<LabelSet | typeof QUIT> {
  if (o.showCase) out.write(`${renderCase(c)}\n`);
  const ask = async (prompt: string): Promise<string | typeof QUIT> => {
    out.write(prompt);
    const line = await lines.next();
    if (line === null || line.trim() === "q") return QUIT;
    return line.trim();
  };

  let risk: RiskClass | undefined;
  while (!risk) {
    const a = await ask("Risk class [t/l/s] (q quits): ");
    if (a === QUIT) return QUIT;
    const m = { t: "trivial", l: "logic", s: "sensitive" } as const;
    if (Object.hasOwn(m, a)) risk = m[a as keyof typeof m];
    else if (a === "trivial" || a === "logic" || a === "sensitive") risk = a;
    else out.write("Answer t, l or s.\n");
  }

  let outOfScope: string[] | undefined;
  while (!outOfScope) {
    const a = await ask("Out-of-scope files (numbers from the list, e.g. 1,4; empty for none): ");
    if (a === QUIT) return QUIT;
    if (a === "") {
      outOfScope = [];
      break;
    }
    const nums = a.split(",").map((x) => Number(x.trim()));
    if (nums.every((n) => Number.isInteger(n) && n >= 1 && n <= c.inputs.files.length)) {
      outOfScope = sortedPaths(nums.map((n) => (c.inputs.files[n - 1] as { path: string }).path));
    } else {
      out.write(`Use numbers between 1 and ${c.inputs.files.length}.\n`);
    }
  }

  let goal: string | undefined;
  while (goal === undefined) {
    const a = await ask("Goal (one sentence, at most 300 characters): ");
    if (a === QUIT) return QUIT;
    if (a.length <= 300) goal = a;
    else out.write("Too long.\n");
  }

  const changes: string[] = [];
  out.write("Key behavior changes (one per line, at most 10, empty line to finish):\n");
  for (;;) {
    const a = await ask("> ");
    if (a === QUIT) return QUIT;
    if (a === "") break;
    if (a.length > 300) {
      out.write("Too long.\n");
      continue;
    }
    changes.push(a);
    if (changes.length >= 10) break;
  }

  let shouldFlag: boolean | undefined;
  while (shouldFlag === undefined) {
    const a = await ask(
      "Should the reviewer be warned about a mismatch or an unmentioned change? [y/n]: ",
    );
    if (a === QUIT) return QUIT;
    if (a === "y" || a === "n") shouldFlag = a === "y";
    else out.write("Answer y or n.\n");
  }

  let confidence: LabelSet["confidence"] | undefined;
  while (!confidence) {
    const a = await ask("Confidence [h/m/l]: ");
    if (a === QUIT) return QUIT;
    const m = { h: "high", m: "medium", l: "low" } as const;
    if (Object.hasOwn(m, a)) confidence = m[a as keyof typeof m];
    else out.write("Answer h, m or l.\n");
  }

  let notes: string | undefined;
  while (notes === undefined) {
    const a = await ask("Notes (one line, empty for none): ");
    if (a === QUIT) return QUIT;
    if (a.length <= 2000) notes = a;
    else out.write("Too long.\n");
  }

  return {
    labeler: o.labeler,
    labeledAt: o.now.toISOString(),
    guideVersion: LABELING_GUIDE_VERSION,
    risk,
    outOfScope,
    goal,
    keyBehaviorChanges: changes,
    shouldFlag,
    confidence,
    notes,
  };
}

async function loadAll(set: CaseSet): Promise<EvalCase[]> {
  const cases: EvalCase[] = [];
  for (const id of await listCaseIds(set)) cases.push(await readCase(set, id));
  return cases;
}

export async function labelInteractive(
  set: CaseSet,
  o: { as: string; caseId?: string; doubleOnly: boolean; io: LabelIo; now: () => Date },
): Promise<{ labeled: number }> {
  checkHandle(o.as);
  const lines = new Lines(o.io.input);
  const out = o.io.output;
  let labeled = 0;
  try {
    if (o.caseId) {
      const c = await readCase(set, o.caseId);
      const res = await askLabelSet(c, lines, out, { labeler: o.as, now: o.now(), showCase: true });
      if (res === QUIT) return { labeled };
      await writeCase(set, {
        ...c,
        labels: [...c.labels.filter((l) => l.labeler !== o.as), res],
      });
      return { labeled: 1 };
    }
    for (;;) {
      const pending = (await loadAll(set)).filter(
        (c) =>
          !c.labels.some((l) => l.labeler === o.as) &&
          (!o.doubleOnly || c.tags.includes(DOUBLE_LABEL_TAG)),
      );
      const c = pending[0];
      if (!c) {
        out.write("No more cases to label.\n");
        return { labeled };
      }
      const res = await askLabelSet(c, lines, out, { labeler: o.as, now: o.now(), showCase: true });
      if (res === QUIT) {
        out.write("Stopped; the current case was not saved.\n");
        return { labeled };
      }
      await writeCase(set, { ...c, labels: [...c.labels, res] });
      labeled += 1;
      out.write(
        `Saved ${toTerminalSafe(c.id)} (${labeled} this session, ${pending.length - 1} left).\n`,
      );
      out.write("Next case? [Y/n]: ");
      const again = await lines.next();
      if (again === null || /^\s*(n|q)/i.test(again)) return { labeled };
    }
  } finally {
    lines.close();
  }
}

// ---------------------------------------------------------------------------------------------
// assign-double
// ---------------------------------------------------------------------------------------------

/** Tags `max(min, ceil(fraction * n))` cases for a second label; idempotent. */
export async function assignDouble(
  set: CaseSet,
  o: { fraction: number; min: number; seed: number },
): Promise<{ target: number; tagged: string[] }> {
  const cases = await loadAll(set);
  const target = Math.min(cases.length, Math.max(o.min, Math.ceil(o.fraction * cases.length)));
  const already = cases.filter((c) => c.tags.includes(DOUBLE_LABEL_TAG));
  const need = target - already.length;
  const tagged: string[] = [];
  if (need > 0) {
    const pool = cases.filter((c) => !c.tags.includes(DOUBLE_LABEL_TAG));
    const byKey = new Map<string, EvalCase>();
    const candidates = pool.map((c, i) => {
      const key = `${c.inputs.repositoryFullName}#${c.inputs.pr.number}#${i}`;
      byKey.set(key, c);
      return {
        repository: key,
        prNumber: i,
        size: sizeStratum(c.inputs.pr.additions + c.inputs.pr.deletions),
        path: pathStratum(c.inputs.files, c.floorConfig),
      };
    });
    const { picked } = sample(candidates, { n: need, minPerStratum: 1, seed: o.seed });
    for (const p of picked) {
      const c = byKey.get(p.repository) as EvalCase;
      await writeCase(set, { ...c, tags: [...c.tags, DOUBLE_LABEL_TAG].slice(0, 20) });
      tagged.push(c.id);
    }
  }
  return { target, tagged: tagged.sort() };
}

// ---------------------------------------------------------------------------------------------
// adjudicate
// ---------------------------------------------------------------------------------------------

export const needsAdjudication = (c: EvalCase): boolean =>
  c.adjudicated === null && c.labels.length > 0 && gold(c) === null;

function renderLabelSets(c: EvalCase): string {
  const lines = ["", "=== Label sets ==="];
  for (const l of c.labels) {
    lines.push(
      `${toTerminalSafe(l.labeler)}: risk ${l.risk}; flag ${l.shouldFlag ? "yes" : "no"}; confidence ${l.confidence}`,
      `  out of scope: ${l.outOfScope.map(toTerminalSafe).join(", ") || "-"}`,
      `  goal: ${toTerminalSafe(l.goal)}`,
    );
    for (const b of l.keyBehaviorChanges) lines.push(`  - ${toTerminalSafe(b)}`);
    if (l.notes) lines.push(`  notes: ${toTerminalSafe(l.notes)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function adjudicate(
  set: CaseSet,
  o: { as: string; caseId?: string; io: LabelIo; now: () => Date },
): Promise<{ adjudicated: number }> {
  checkHandle(o.as);
  const lines = new Lines(o.io.input);
  const out = o.io.output;
  let done = 0;
  try {
    const cases = (await loadAll(set)).filter(
      (c) => needsAdjudication(c) && (!o.caseId || c.id === o.caseId),
    );
    if (cases.length === 0) out.write("No cases need adjudication.\n");
    for (const c of cases) {
      out.write(`${renderCase(c)}${renderLabelSets(c)}\n`);
      const res = await askLabelSet(c, lines, out, {
        labeler: o.as,
        now: o.now(),
        showCase: false,
      });
      if (res === QUIT) {
        out.write("Stopped; the current case was not saved.\n");
        break;
      }
      await writeCase(set, { ...c, adjudicated: res });
      done += 1;
    }
  } finally {
    lines.close();
  }
  return { adjudicated: done };
}
