/**
 * Everything the CLI prints from a case goes through `toTerminalSafe` (E24): PR text is
 * untrusted and may hold escape sequences that rewrite the terminal.
 */
import type { CardResult } from "../modules/intent/index.js";
import { type EvalCase, gold } from "./case-schema.js";

const hex = (cp: number): string => `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]`;

/** C0 and C1 controls except newline and tab, and Unicode format characters, become `[U+XXXX]`. */
export function toTerminalSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "\n" || ch === "\t") out += ch;
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || /^\p{Cf}$/u.test(ch)) out += hex(cp);
    else out += ch;
  }
  return out;
}

const SIGN = (n: number) => `${n}`;

export function renderCase(c: EvalCase, o: { withResult?: CardResult | null } = {}): string {
  const lines: string[] = [];
  const s = c.source;
  lines.push(`=== ${toTerminalSafe(c.id)} ===`);
  lines.push(
    s.kind === "pilot"
      ? `repository: ${toTerminalSafe(s.repository)}  PR: #${s.prNumber}  merged: ${s.mergedAt}  author kind: ${s.authorKind}`
      : `repository: ${toTerminalSafe(c.inputs.repositoryFullName)}  PR: #${c.inputs.pr.number}  (synthetic)`,
  );
  const i = c.inputs;
  lines.push(
    "",
    `Title: ${toTerminalSafe(i.pr.title)}`,
    "",
    "Description:",
    toTerminalSafe(i.pr.body),
  );
  if (i.issue) {
    lines.push(
      "",
      `Linked issue #${i.issue.number}: ${toTerminalSafe(i.issue.title)}`,
      toTerminalSafe(i.issue.body),
    );
  }
  lines.push(
    "",
    `Files (${i.files.length} listed of ${i.pr.changedFiles}; +${i.pr.additions} -${i.pr.deletions})${
      i.listingTruncated ? "  [listing truncated]" : ""
    }${i.tooLarge ? "  [too large: no diff]" : ""}`,
  );
  i.files.forEach((f, n) => {
    const from = f.previousPath ? ` (from ${toTerminalSafe(f.previousPath)})` : "";
    lines.push(
      `${n + 1}. ${f.status} ${toTerminalSafe(f.path)}${from} (+${SIGN(f.additions)} -${SIGN(f.deletions)})`,
    );
  });
  for (const f of i.files) {
    lines.push("", `--- ${toTerminalSafe(f.path)}`);
    lines.push(f.patch === null ? "(no patch)" : toTerminalSafe(f.patch));
  }
  const r = o.withResult;
  if (r) {
    lines.push("", "=== Graft result ===", `status: ${r.status}`);
    if (r.card) {
      lines.push(`goal: ${toTerminalSafe(r.card.goal)}`, "behavior changes:");
      for (const b of r.card.behaviorChanges) lines.push(`  - ${toTerminalSafe(b)}`);
      lines.push("out of scope:");
      for (const e of r.card.outOfScopeEdits) {
        lines.push(`  - ${toTerminalSafe(e.path)}: ${toTerminalSafe(e.reason)}`);
      }
    }
    lines.push(
      `risk: final ${r.risk.final} (floor ${r.risk.floor}, writer ${r.risk.writer ?? "-"}, verifier ${r.risk.verifier ?? "-"})`,
      `verifier: ${r.verifier.status}`,
    );
    const g = gold(c);
    if (g) {
      lines.push(
        `gold: risk ${g.risk}, should flag ${g.shouldFlag ? "yes" : "no"}, out of scope: ${
          g.outOfScope.map(toTerminalSafe).join(", ") || "-"
        }`,
        `reference goal: ${toTerminalSafe(g.goal)}`,
      );
      for (const b of g.keyBehaviorChanges) lines.push(`  - ${toTerminalSafe(b)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
