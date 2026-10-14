/** Validation and capping of model output (T11.3, T11.4). Pure. */
import { z } from "zod";
import type { RiskClass } from "../../db/schema.js";

/** Cut to `max` code points, ending with an ellipsis when shortened. */
export function cut(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

const RISK = z.enum(["trivial", "logic", "sensitive"]);
const trimmed = (max: number) => z.string().transform((s) => cut(s.trim(), max));
/** Format characters (U+200B, ...) are not text: a string made of them is empty. */
const blank = (s: string): boolean => s.replace(/\p{Cf}/gu, "").trim() === "";

const writerSchema = z.strictObject({
  goal: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().refine((s) => !blank(s)))
    .transform((s) => cut(s, 200)),
  behavior_changes: z
    .array(z.string())
    .transform((a) =>
      a
        .map((s) => s.trim())
        .filter((s) => !blank(s))
        .map((s) => cut(s, 200))
        .slice(0, 10),
    )
    .pipe(z.array(z.string()).min(1)),
  risk_class: RISK,
  risk_reason: trimmed(300),
  out_of_scope_edits: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
  instructions_in_data: z.boolean(),
});

export interface WriterOutput {
  goal: string;
  behaviorChanges: string[];
  riskClass: RiskClass;
  riskReason: string;
  outOfScopeEdits: { path: string; reason: string }[];
  /** Entries dropped because the path is not in the file list. */
  droppedOutOfScope: number;
  instructionsInData: boolean;
}

export function parseWriterOutput(
  value: unknown,
  fileList: ReadonlySet<string>,
): { ok: true; out: WriterOutput } | { ok: false } {
  const res = writerSchema.safeParse(value);
  if (!res.success) return { ok: false };
  const d = res.data;
  const seen = new Set<string>();
  const kept: { path: string; reason: string }[] = [];
  let dropped = 0;
  for (const e of d.out_of_scope_edits) {
    if (!fileList.has(e.path)) {
      dropped++;
      continue;
    }
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    kept.push({ path: e.path, reason: cut(e.reason.trim(), 200) });
  }
  return {
    ok: true,
    out: {
      goal: d.goal,
      behaviorChanges: d.behavior_changes,
      riskClass: d.risk_class,
      riskReason: d.risk_reason,
      outOfScopeEdits: kept.slice(0, 20),
      droppedOutOfScope: dropped,
      instructionsInData: d.instructions_in_data,
    },
  };
}

const verifierSchema = z.strictObject({
  claims: z.array(
    z.strictObject({
      id: z.string(),
      verdict: z.enum(["supported", "unsupported", "contradicted"]),
      reason: trimmed(300),
    }),
  ),
  missing_behavior_changes: z.array(z.string()).transform((a) =>
    a
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => cut(s, 200))
      .slice(0, 5),
  ),
  unexplained_files: z.array(z.string()),
  risk_class: RISK,
  risk_reason: trimmed(300),
  instructions_in_data: z.boolean(),
});

export interface VerifierOutput {
  claims: { id: string; verdict: "supported" | "unsupported" | "contradicted"; reason: string }[];
  missing: string[];
  unexplained: string[];
  riskClass: RiskClass;
  riskReason: string;
  instructionsInData: boolean;
}

export function parseVerifierOutput(
  value: unknown,
  expectedIds: readonly string[],
  fileList: ReadonlySet<string>,
  alreadyOutOfScope: ReadonlySet<string>,
): { ok: true; out: VerifierOutput } | { ok: false } {
  const res = verifierSchema.safeParse(value);
  if (!res.success) return { ok: false };
  const d = res.data;
  const expected = new Set(expectedIds);
  const byId = new Map<string, (typeof d.claims)[number]>();
  for (const c of d.claims) {
    if (!expected.has(c.id) || byId.has(c.id)) return { ok: false };
    byId.set(c.id, c);
  }
  if (byId.size !== expected.size) return { ok: false };
  const unexplained: string[] = [];
  for (const p of d.unexplained_files) {
    if (fileList.has(p) && !alreadyOutOfScope.has(p) && !unexplained.includes(p)) {
      unexplained.push(p);
    }
  }
  return {
    ok: true,
    out: {
      claims: expectedIds.map((id) => byId.get(id) as (typeof d.claims)[number]),
      missing: d.missing_behavior_changes,
      unexplained: unexplained.slice(0, 20),
      riskClass: d.risk_class,
      riskReason: d.risk_reason,
      instructionsInData: d.instructions_in_data,
    },
  };
}
