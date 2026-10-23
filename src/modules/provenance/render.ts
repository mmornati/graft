/** Pure, deterministic markdown for the provenance section and the check run (§8). */
import type { ProvenanceResult } from "./compute.js";
import { type GraftField, TRAILER_KEYS } from "./fields.js";

export interface RenderOptions {
  headSha: string;
  authorLogin: string;
  /** Phase 1 step 6 (§8): an MCP report for this head, shown as unverified. */
  mcp?: { agent: string; model: string | null; task: string | null; agrees: boolean };
}

const AUTHORED_BY: Record<ProvenanceResult["authorKindReason"], string> = {
  trailer: "Agent (Graft trailers)",
  bot_account: "Agent (bot account)",
  configured_login: "Agent (configured agent login)",
  agent_coauthor: "Agent (agent co-author)",
  none: "Human",
};

const MAX_LISTED_WARNINGS = 10;
const NOT_REPORTED = "not reported";

const code = (v: string) => `\`${v}\``;
const sha7 = (sha: string) => sha.slice(0, 7);

function valueCell(r: ProvenanceResult, f: GraftField): string {
  const resolved = r.fields[f];
  if (!resolved) return NOT_REPORTED;
  let text: string;
  if (f === "session") {
    let host: string;
    try {
      host = new URL(resolved.value).hostname;
    } catch {
      host = "session";
    }
    text = `[${host}](${resolved.value})`;
  } else {
    text = code(resolved.value);
  }
  if (resolved.source === "pr_body") text += " (from PR description)";
  const conflict = r.conflicts[f];
  if (conflict && conflict.length > 1) {
    text += ` · commits disagree: ${conflict.map(code).join(", ")}`;
  }
  return text;
}

function footer(r: ProvenanceResult, o: RenderOptions): string {
  const head = `Head ${code(sha7(o.headSha))}`;
  const truncated = r.truncated
    ? " Only the first 250 commits and the head commit were scanned."
    : "";
  if (r.counts.withTrailers === 0 && r.prBodyFields === null) {
    return `${head} · no ${code("Graft-*")} trailers found. Agents can declare provenance with ${code("Graft-Agent")}, ${code("Graft-Model")}, ${code("Graft-Task")} and ${code("Graft-Session")} git trailers.${truncated}`;
  }
  const n = r.counts.total;
  return `${head} · ${n} ${n === 1 ? "commit" : "commits"}, ${r.counts.withTrailers} with Graft trailers.${truncated}`;
}

function warningItem(w: ProvenanceResult["warnings"][number]): string {
  const where = w.source === "pr_body" ? "PR description" : code(sha7(w.commitSha ?? ""));
  if (w.code === "message_truncated") return `- ${where}: message truncated before parsing`;
  const subject = w.field
    ? `${TRAILER_KEYS[w.field]} ignored`
    : w.code === "unknown_graft_key"
      ? "unknown Graft key ignored"
      : "trailer block ignored";
  return `- ${where}: ${subject} (${w.code})`;
}

/** Phase 1 step 6 (§8): the values are code spans, as for trailers (they passed the same rules). */
function mcpLine(m: NonNullable<RenderOptions["mcp"]>): string {
  const parts = [`agent ${code(m.agent)}`];
  if (m.model !== null) parts.push(`model ${code(m.model)}`);
  if (m.task !== null) parts.push(`task ${code(m.task)}`);
  const verdict = m.agrees
    ? "agrees with trailers"
    : "differs from trailers: the policy treats the author as unknown";
  return `Reported through MCP (unverified): ${parts.join(", ")} · ${verdict}`;
}

export function renderProvenanceSection(r: ProvenanceResult, o: RenderOptions): string {
  const lines = [
    "### Provenance",
    "",
    "| | |",
    "| --- | --- |",
    `| **Authored by** | ${AUTHORED_BY[r.authorKindReason]} |`,
    `| **Agent** | ${valueCell(r, "agent")} |`,
    `| **Model** | ${valueCell(r, "model")} |`,
    `| **Task** | ${valueCell(r, "task")} |`,
  ];
  if (r.fields.session) lines.push(`| **Session** | ${valueCell(r, "session")} |`);
  lines.push(`| **Opened by** | ${code(o.authorLogin)} |`, "", footer(r, o));
  if (o.mcp) lines.push("", mcpLine(o.mcp));

  if (r.warnings.length > 0) {
    const n = r.warnings.length;
    lines.push(
      "",
      `<details><summary>${n} provenance ${n === 1 ? "warning" : "warnings"}</summary>`,
      "",
    );
    for (const w of r.warnings.slice(0, MAX_LISTED_WARNINGS)) lines.push(warningItem(w));
    if (n > MAX_LISTED_WARNINGS) lines.push(`- …and ${n - MAX_LISTED_WARNINGS} more`);
    lines.push("", "</details>");
  }
  return lines.join("\n");
}

export function renderCheckRunOutput(
  r: ProvenanceResult,
  o: RenderOptions,
): { title: string; summary: string } {
  const title =
    r.authorKind === "agent"
      ? `Agent: ${r.fields.agent?.value ?? "unknown"} · Model: ${r.fields.model?.value ?? "unknown"}`
      : "Human-authored (no agent provenance)";
  return {
    title: title.length > 100 ? `${title.slice(0, 99)}…` : title,
    summary: renderProvenanceSection(r, o),
  };
}
