/**
 * Pure, deterministic markdown for the intent section and the check run (T13, §12). No
 * timestamps. Every model-written string goes through `escapeProse`, every path through
 * `codeSpan`; untrusted text is only ever rendered in lists, never in table cells.
 */
import { codeSpan, escapeProse } from "../../github/markdown.js";
import type { CardResult, FailureReason } from "./generate.js";
import type { FloorReason, FloorRuleId } from "./risk-floor.js";

export interface IntentView extends CardResult {
  id: string;
  headSha: string;
}

export const INTENT_CHECK_NAME = "graft/intent";
export const INTENT_CHECK_ACTIONS = [
  {
    label: "Card is accurate",
    identifier: "card_up",
    description: "The intent card matches the diff",
  },
  { label: "Card is wrong", identifier: "card_down", description: "The intent card is inaccurate" },
] as const;

export const MAX_SECTION_RENDER_CHARS = 18_000;
export const MAX_CHECK_TEXT_CHARS = 60_000;

export const FAILURE_TEXT: Record<FailureReason, string> = {
  not_configured: "no model API key is configured.",
  budget_exceeded: "this repository's daily model budget is used up.",
  too_large: "the pull request is too large for a card.",
  llm_timeout: "the model did not respond in time.",
  llm_rate_limited: "the model service is rate limiting Graft.",
  llm_unavailable: "the model service is unavailable.",
  llm_auth: "the model service rejected Graft's credentials.",
  llm_bad_request: "the model service rejected the request.",
  llm_refusal: "the model declined to describe this change.",
  invalid_output: "the model returned an invalid card twice.",
  deadline_exceeded: "writing the card took too long.",
};

const RULE_LABEL: Record<FloorRuleId, string> = {
  ci_config: "CI or repository configuration",
  policy_file: "Graft policy file",
  dependency_manifest: "dependency manifest or lockfile",
  infra: "infrastructure or deployment",
  auth_secrets: "authentication, security or secrets",
  migration: "database migration or schema",
  configured_path: "configured sensitive path",
  test_deleted: "test file deleted",
  test_shrunk: "test assertions reduced",
  binary: "binary file",
  size_large: "large change",
  size_huge: "very large change",
  partial_view: "part of the diff not shown to the model",
  listing_truncated: "file list incomplete",
  glob_budget: "path matching stopped at its work limit",
  injection_marker: "text addressed to AI reviewers",
};

const PATH_RULES: ReadonlySet<FloorRuleId> = new Set([
  "ci_config",
  "policy_file",
  "dependency_manifest",
  "infra",
  "auth_secrets",
  "migration",
  "configured_path",
  "test_deleted",
  "test_shrunk",
  "binary",
  "partial_view",
]);

const num = (n: number) => n.toLocaleString("en-US");
const sha7 = (s: string) => s.slice(0, 7);
const code = (v: string) => `\`${v}\``;
const calls = (n: number) => `${num(n)} ${n === 1 ? "call" : "calls"}`;

export function describeFloorReason(
  r: FloorReason,
  v: Pick<CardResult, "inputs">,
  maxPaths = 5,
): string {
  const label = RULE_LABEL[r.rule];
  if (r.rule === "size_large" || r.rule === "size_huge") {
    const lines = v.inputs.linesAdded + v.inputs.linesDeleted;
    const kind = r.rule === "size_large" ? "large change" : "very large change";
    return `${kind} (${num(lines)} lines, ${num(v.inputs.filesTotal)} files)`;
  }
  if (PATH_RULES.has(r.rule) && r.paths.length > 0) {
    const shown = r.paths.slice(0, maxPaths).map((p) => codeSpan(p));
    const more = r.count - shown.length;
    return `${label} (${shown.join(", ")}${more > 0 ? `, and ${num(more)} more` : ""})`;
  }
  return label;
}

function floorLine(v: CardResult): string {
  return v.risk.floorReasons.length === 0
    ? `Rules set the floor to ${code(v.risk.floor)}: no rule matched`
    : `Rules set the floor to ${code(v.risk.floor)}: ${v.risk.floorReasons.map((r) => describeFloorReason(r, v)).join("; ")}`;
}

function riskLine(v: CardResult): string {
  let line = `**Risk:** ${code(v.risk.final)} · rules ${code(v.risk.floor)}`;
  if (v.status === "unavailable") return `${line} · no model check`;
  if (v.risk.writer !== null) line += ` · writer ${code(v.risk.writer)}`;
  if (v.risk.firstPass !== null) line += ` (first pass ${code(v.risk.firstPass)})`;
  if (v.risk.verifier !== null) line += ` · verifier ${code(v.risk.verifier)}`;
  return line;
}

const LABEL_FOR_KIND = (c: CardResult["verifier"]["claims"][number], idx: Map<string, number>) =>
  c.kind === "goal"
    ? "The goal"
    : c.kind === "behavior_change"
      ? `Behavior change ${idx.get(c.id)}`
      : `Out-of-scope edit ${idx.get(c.id)}`;

function claimIndex(id: string): number {
  return Number(id.slice(1));
}

function warningBlock(v: CardResult, maxBullets: number): string[] {
  if (v.verifier.status === "disagree") {
    const idx = new Map(v.verifier.claims.map((c) => [c.id, claimIndex(c.id)] as const));
    const bullets: string[] = [];
    for (const c of v.verifier.claims) {
      if (c.verdict === "supported") continue;
      bullets.push(`- ${LABEL_FOR_KIND(c, idx)} is ${c.verdict}: ${escapeProse(c.reason, 300)}`);
    }
    for (const m of v.verifier.missing) {
      bullets.push(`- Missing from the card: ${escapeProse(m, 200)}`);
    }
    const shown = bullets.slice(0, maxBullets);
    if (bullets.length > shown.length) shown.push(`- …and ${bullets.length - shown.length} more`);
    return [
      "> [!WARNING]",
      "> **The verifier disagrees with this card.** Read the diff instead of relying on the card.",
      ">",
      ...shown.map((b) => `> ${b}`),
    ];
  }
  if (v.verifier.status === "error") {
    const reason = v.verifier.failure
      ? FAILURE_TEXT[v.verifier.failure].replace(/\.$/, "")
      : "verification failed";
    return [
      "> [!WARNING]",
      `> **This card was not verified** (${reason}). The risk is at least ${code("logic")}.`,
    ];
  }
  return [];
}

function inputsLine(v: CardResult): string {
  const i = v.inputs;
  let line = "Inputs: PR title and description";
  if (i.linkedIssueNumber !== null) line += `, issue #${i.linkedIssueNumber}`;
  line += `, ${num(i.filesFull)} of ${num(i.filesTotal)} files in full`;
  if (i.filesPartial > 0) line += `, ${num(i.filesPartial)} truncated`;
  if (i.filesOmitted > 0) {
    const first = i.omitted.slice(0, 3).map((o) => `${codeSpan(o.path)}: ${o.reason}`);
    const more = i.filesOmitted - first.length;
    line += `, ${num(i.filesOmitted)} omitted (${first.join(", ")}${more > 0 ? `, and ${num(more)} more` : ""})`;
  }
  return line;
}

function detailsBlock(v: CardResult): string[] {
  const claims = v.verifier.claims;
  const supported = claims.filter((c) => c.verdict === "supported").length;
  let writerLine = `Writer ${codeSpan(v.models.writer ?? "unknown")}`;
  if (v.models.firstPass !== null)
    writerLine += ` (after a first pass by ${codeSpan(v.models.firstPass)})`;
  writerLine +=
    v.verifier.status === "error"
      ? "; verifier unavailable"
      : `; verifier ${codeSpan(v.models.verifier ?? "unknown")} supported ${supported} of ${claims.length} claims`;
  return [
    "<details><summary>How this card was made</summary>",
    "",
    `- ${floorLine(v)}`,
    `- ${writerLine}`,
    `- ${inputsLine(v)}`,
    `- Model usage: ${num(v.usage.inputTokens)} input tokens, ${num(v.usage.outputTokens)} output tokens, ${calls(v.usage.calls)}`,
    "",
    "</details>",
  ];
}

function renderOk(
  v: IntentView,
  o: { details: boolean; maxOos: number; maxBullets: number },
): string {
  const card = v.card as NonNullable<CardResult["card"]>;
  const lines: string[] = [
    "### Intent",
    "",
    `**Goal:** ${escapeProse(card.goal, 200)}`,
    "",
    riskLine(v),
    "",
    "**Behavior changes**",
    "",
    ...card.behaviorChanges.map((b) => `- ${escapeProse(b, 200)}`),
    "",
  ];
  const oos: string[] = [
    ...card.outOfScopeEdits.map((e) => `- ${codeSpan(e.path)}: ${escapeProse(e.reason, 200)}`),
    ...v.verifier.unexplained.map((p) => `- ${codeSpan(p)}: flagged by the verifier`),
  ];
  if (oos.length === 0) {
    lines.push("**Out-of-scope edits:** none", "");
  } else {
    const shown = oos.slice(0, o.maxOos);
    if (oos.length > shown.length) shown.push(`- …and ${oos.length - shown.length} more`);
    lines.push("**Out-of-scope edits**", "", ...shown, "");
  }
  if (v.instructionsInData) {
    lines.push(
      "> [!CAUTION]",
      `> Text in this pull request addresses AI reviewers. Graft ignored it and set the risk to at least ${code("logic")}.`,
      "",
    );
  }
  const warning = warningBlock(v, o.maxBullets);
  if (warning.length > 0) lines.push(...warning, "");
  if (o.details) lines.push(...detailsBlock(v), "");
  lines.push(
    `Card ${code(v.id.slice(0, 8))} · head ${code(sha7(v.headSha))} · Rate this card with 👍 or 👎 on this comment, or with the buttons on the ${code(INTENT_CHECK_NAME)} check.`,
  );
  return lines.join("\n");
}

function renderUnavailable(v: IntentView, o: { retryScheduled: boolean }): string {
  const reason = FAILURE_TEXT[v.failureReason ?? "invalid_output"];
  const tail = o.retryScheduled
    ? `Head ${code(sha7(v.headSha))} · Graft retries automatically. You can also re-run the ${code(INTENT_CHECK_NAME)} check.`
    : `Head ${code(sha7(v.headSha))} · Re-run the ${code(INTENT_CHECK_NAME)} check to try again.`;
  return [
    "### Intent",
    "",
    `**Card unavailable:** ${reason}`,
    "",
    riskLine(v),
    "",
    `- ${floorLine(v)}`,
    `- Without a checked card the risk is at least ${code("logic")}.`,
    "",
    tail,
  ].join("\n");
}

export function renderIntentSection(v: IntentView, o: { retryScheduled: boolean }): string {
  if (v.status === "unavailable") return renderUnavailable(v, o);
  let out = renderOk(v, { details: true, maxOos: Infinity, maxBullets: Infinity });
  if (out.length <= MAX_SECTION_RENDER_CHARS) return out;
  out = renderOk(v, { details: false, maxOos: Infinity, maxBullets: Infinity });
  for (
    let k = 20;
    out.length > MAX_SECTION_RENDER_CHARS && k >= 0;
    k = k > 0 ? Math.floor(k / 2) : -1
  ) {
    out = renderOk(v, { details: false, maxOos: k, maxBullets: Infinity });
  }
  for (
    let k = 20;
    out.length > MAX_SECTION_RENDER_CHARS && k >= 0;
    k = k > 0 ? Math.floor(k / 2) : -1
  ) {
    out = renderOk(v, { details: false, maxOos: 0, maxBullets: k });
  }
  return out;
}

export function renderPendingSection(o: { headSha: string; previousHeadSha: string }): string {
  return [
    "### Intent",
    "",
    `Writing the card for head ${code(sha7(o.headSha))}. The previous card (head ${code(sha7(o.previousHeadSha))}) no longer matches this pull request.`,
  ].join("\n");
}

export function renderIntentCheckOutput(
  v: IntentView,
  o: { retryScheduled: boolean },
): { title: string; summary: string; text: string } {
  const title =
    v.status === "unavailable"
      ? `Card unavailable · risk: ${v.risk.final}`
      : v.verifier.status === "agree"
        ? `Risk: ${v.risk.final} · verifier agrees`
        : v.verifier.status === "disagree"
          ? `Risk: ${v.risk.final} · verifier disagrees`
          : `Risk: ${v.risk.final} · not verified`;

  const lines: string[] = ["Rules", ""];
  if (v.risk.floorReasons.length === 0)
    lines.push(`- Floor ${code(v.risk.floor)}: no rule matched`);
  for (const r of v.risk.floorReasons) {
    lines.push(`- ${describeFloorReason(r, v, 50)} → floor ${code(r.floor)}`);
  }
  lines.push("");
  if (v.inputs.omitted.length > 0 || v.inputs.filesOmitted > 0) {
    lines.push("Files not shown in full", "");
    const shown = v.inputs.omitted.slice(0, 200);
    for (const f of shown) lines.push(`- ${codeSpan(f.path)}: ${f.reason}`);
    const more = v.inputs.filesOmitted - shown.length;
    if (more > 0) lines.push(`- …and ${num(more)} more`);
    lines.push("");
  }
  if (v.verifier.claims.length > 0) {
    lines.push("Verifier claims", "");
    for (const c of v.verifier.claims) {
      lines.push(`- ${c.id} (${c.kind}): ${c.verdict}: ${escapeProse(c.reason, 300)}`);
    }
    lines.push("");
  }
  lines.push(
    "Models and usage",
    "",
    `- Writer ${codeSpan(v.models.writer ?? "none")}${v.models.firstPass ? `, first pass ${codeSpan(v.models.firstPass)}` : ""}, verifier ${codeSpan(v.models.verifier ?? "none")}`,
    `- ${num(v.usage.inputTokens)} input tokens, ${num(v.usage.outputTokens)} output tokens, ${num(v.usage.cacheReadTokens)} cache-read tokens, ${num(v.usage.cacheWriteTokens)} cache-write tokens, ${calls(v.usage.calls)}`,
  );
  let text = lines.join("\n");
  if (text.length > MAX_CHECK_TEXT_CHARS) {
    text = `${text.slice(0, MAX_CHECK_TEXT_CHARS - 40).replace(/\n[^\n]*$/, "")}\n\n…(truncated)`;
  }
  return { title, summary: renderIntentSection(v, o), text };
}
