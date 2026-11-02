/**
 * The `summary` section of the managed comment: the verdict at the top, three answers (does the
 * change match the intent, is it safe to merge, what human review the policy asks for) and at
 * most three points for the reviewer to look at. Pure and deterministic.
 *
 * It reads every module's results: the intent card on screen, the policy verdict, the provenance
 * and the head's CI and AI review checks. The policy job renders it, since it already gathers all
 * of them and re-runs when any of them changes.
 *
 * Graft never calls a change safe because of what it did not find. "Safe to merge" is said only
 * for a `trivial` change with CI green; a `logic` change is at most "low risk", and only with CI
 * green and an independent AI review that reports no issues. A `sensitive` change always needs a
 * human. Model-written text goes through `escapeProse` and only into list items.
 */
import { codeSpan, escapeProse } from "../../github/markdown.js";
import {
  claimIndex,
  describeFloorReason,
  disagrees,
  failingClaims,
  type IntentView,
  LABEL_FOR_KIND,
} from "../intent/render.js";
import type { FloorRuleId } from "../intent/risk-floor.js";
import type { PolicyView } from "./render.js";
import { type AiReviewSignal, type HeadSignals, sameFamily } from "./signals.js";

export interface SummaryInput {
  headSha: string;
  /** The card on screen, whatever its head; a card of another head counts as pending. */
  card: IntentView | null;
  policy: PolicyView;
  /** null when the checks were not read. */
  signals: HeadSignals | null;
  /**
   * From provenance of this head. `model` and `agent` are what the author declared (trailers), so
   * they can only make a review less independent; `modelDisputed`: the commits disagree on it.
   */
  author: {
    kind: "agent" | "human" | null;
    model: string | null;
    agent?: string | null;
    modelDisputed?: boolean;
  };
}

export type Level = "pending" | "red" | "orange" | "yellow" | "green";

export const MAX_POINTS = 3;

const SENSITIVE_RULES: ReadonlySet<FloorRuleId> = new Set([
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
]);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sha7 = (s: string) => s.slice(0, 7);
const RANK: Record<Level, number> = { pending: 0, green: 1, yellow: 2, orange: 3, red: 4 };
const worst = (a: Level, b: Level): Level => (RANK[b] > RANK[a] ? b : a);

function cardForHead(i: SummaryInput): IntentView | null {
  return i.card !== null && i.card.headSha === i.headSha ? i.card : null;
}

function riskOf(i: SummaryInput): "trivial" | "logic" | "sensitive" | null {
  return i.policy.verdict?.effectiveRisk.value ?? cardForHead(i)?.risk.final ?? null;
}

/**
 * Whether a review is by another model family than the author: null when it cannot be shown (no
 * declared model, or commits that disagree on it). The family is also looked for in the agent name.
 */
function independent(r: AiReviewSignal, author: SummaryInput["author"]): boolean | null {
  if (author.kind === "human") return true;
  if (author.model === null || author.modelDisputed === true) return null;
  return !sameFamily(r, author.model, author.agent ?? null);
}

/** Why a review's conclusion is not read as its verdict; null when it is. */
function distrust(r: AiReviewSignal, card: IntentView | null): string | null {
  if (!r.trustConclusion) return "its check does not say whether it found issues";
  if (r.app === null)
    return "no publishing app is set for it in graft.yaml, so anyone could post it";
  // A PR that changes CI could change the workflow that runs the review.
  if (r.app === "github-actions" && card?.risk.floorReasons.some((f) => f.rule === "ci_config")) {
    return "this pull request changes CI configuration, which could change the review itself";
  }
  return null;
}

function cleanIndependentReview(i: SummaryInput): boolean {
  const card = cardForHead(i);
  return (i.signals?.aiReviews ?? []).some(
    (r) => distrust(r, card) === null && r.state === "passed" && independent(r, i.author) === true,
  );
}

function reviewFoundIssues(r: AiReviewSignal): boolean {
  return r.state === "failed";
}

// ---------------------------------------------------------------------------------------------
// Matches the intent?
// ---------------------------------------------------------------------------------------------

function intentRow(i: SummaryInput): { level: Level; text: string } {
  const card = cardForHead(i);
  if (card === null) return { level: "pending", text: "⏳ **Waiting for the intent card.**" };
  if (card.status === "unavailable" || card.card === null) {
    return { level: "orange", text: "❔ **Unknown.** The intent card is unavailable." };
  }
  if (disagrees(card)) {
    return {
      level: "red",
      text: "❌ **The card does not match the diff.** Read the diff instead of the card.",
    };
  }
  const c = card.card;
  const asked =
    card.inputs.linkedIssueNumber !== null
      ? `issue #${card.inputs.linkedIssueNumber}`
      : "the description";
  const oos = c.outOfScopeEdits.length + card.verifier.unexplained.length;
  const extra = card.verifier.status === "error" ? 0 : card.verifier.missing.length;
  const deferred = c.requested.filter((r) => r.status === "deferred").length;
  const notes: string[] = [];
  if (oos > 0) notes.push(`${plural(oos, "file", "files")} out of scope.`);
  if (extra > 0) notes.push(`${plural(extra, "change", "changes")} not in the description.`);
  if (deferred > 0) notes.push(`${plural(deferred, "item", "items")} left for later on purpose.`);
  const tail = notes.length > 0 ? ` ${notes.join(" ")}` : "";
  let level: Level = oos > 0 ? "orange" : "green";
  let head: string;
  switch (c.intentMatch) {
    case null:
      head = "➖ **Not checked.** This card was written before Graft compared intent and diff.";
      break;
    case "unknown":
      head = "❔ **Unknown.** Neither a linked issue nor the description says what was wanted.";
      break;
    case "matches":
      head = `✅ **Yes.** Does what ${asked} asks.`;
      break;
    case "partial": {
      const wanted = c.requested.filter((r) => r.status !== "deferred");
      const done = wanted.filter((r) => r.status === "done").length;
      head = `⚠️ **Partly.** ${done} of ${wanted.length} requested items done.`;
      level = "orange";
      break;
    }
    case "differs":
      head = `❌ **No.** The change does something other than what ${asked} asks.`;
      level = "red";
      break;
  }
  return { level, text: `${head}${tail}` };
}

// ---------------------------------------------------------------------------------------------
// Safe to merge?
// ---------------------------------------------------------------------------------------------

function ciText(s: HeadSignals): string {
  const { passed, failed, pending, failing, incomplete } = s.ci;
  const total = passed + failed + pending;
  const partial = incomplete ? " (not every check could be read)" : "";
  if (total === 0) return `**CI:** no checks on this head${partial}.`;
  if (failed > 0) {
    return `**CI:** ${failed} of ${total} failing (${failing.map((n) => codeSpan(n, 80)).join(", ")})${partial}.`;
  }
  if (pending > 0)
    return `**CI:** ${passed} of ${total} passed, ${pending} still running${partial}.`;
  return `**CI:** all ${total} passed${partial}.`;
}

function reviewText(r: AiReviewSignal, i: SummaryInput): string {
  let state: string;
  const why = distrust(r, cardForHead(i));
  if (r.state === "pending") state = "still running";
  else if (why === null) {
    state =
      r.state === "passed"
        ? "no issues"
        : r.state === "failed"
          ? "found issues"
          : "finished without a verdict";
  } else {
    state = r.state === "failed" ? "failed" : `ran (${why})`;
  }
  const ind = independent(r, i.author);
  const note =
    ind === false
      ? "; same model family as the author"
      : ind === null
        ? "; the author's model is unknown"
        : "";
  return `**AI review ${codeSpan(r.check, 80)}** on ${codeSpan(sha7(i.headSha))}: ${state}${note}.`;
}

function graftText(card: IntentView): string | null {
  if (card.status !== "ok") return null;
  const claims = card.verifier.claims;
  const verified =
    card.verifier.status === "error"
      ? "the card was not verified"
      : `${claims.filter((c) => c.verdict === "supported").length} of ${claims.length} claims supported`;
  const unread = card.inputs.filesPartial + card.inputs.filesOmitted;
  return `**Graft:** ${verified}${unread > 0 ? `, ${plural(unread, "file", "files")} not read in full` : ""}.`;
}

function riskReason(i: SummaryInput, card: IntentView | null): string {
  const risk = riskOf(i);
  if (risk === null) return "";
  const why =
    card?.risk.writerReason && card.risk.final === risk
      ? escapeProse(card.risk.writerReason, 200)
      : (card?.risk.floorReasons
          .filter((r) => r.floor === risk)
          .slice(0, 1)
          .map((r) => describeFloorReason(r, card, 3))[0] ?? "");
  return why === "" ? `Risk ${codeSpan(risk)}.` : `Risk ${codeSpan(risk)}: ${why}`;
}

export function assess(i: SummaryInput): Level {
  const card = cardForHead(i);
  if (card === null) return "pending";
  let level = intentRow(i).level;
  const risk = riskOf(i);
  const s = i.signals;
  const reviews = s?.aiReviews ?? [];
  if (
    card.instructionsInData ||
    (s !== null && s.ci.failed > 0) ||
    reviews.some(reviewFoundIssues) ||
    i.policy.verdict?.outcome === "would_block"
  ) {
    return "red";
  }
  if (risk === "sensitive" || card.status !== "ok" || card.verifier.status === "error") {
    level = worst(level, "orange");
  }
  const ciSettled = s !== null && s.ci.pending === 0 && !s.ci.incomplete;
  if (!ciSettled || reviews.some((r) => r.state === "pending")) level = worst(level, "yellow");
  if (risk === "logic" && !cleanIndependentReview(i)) level = worst(level, "yellow");
  if (risk === null) level = worst(level, "yellow");
  return level;
}

function safeRow(i: SummaryInput, level: Level): string {
  const card = cardForHead(i);
  if (level === "pending" || card === null) {
    return "⏳ **Not known yet.** Graft is waiting for the intent card of this head.";
  }
  const risk = riskOf(i);
  let head: string;
  switch (level) {
    case "red":
      head = "❌ **Don't merge yet.**";
      break;
    case "orange":
      head = "⚠️ **Not without a human review.**";
      break;
    case "yellow":
      head = "🟡 **Needs a normal review.**";
      break;
    default:
      head = risk === "trivial" ? "🟢 **Safe to merge.**" : "🟢 **Low risk.**";
  }
  const parts = [head, riskReason(i, card)];
  if (i.signals !== null) {
    parts.push(ciText(i.signals));
    for (const r of i.signals.aiReviews) parts.push(reviewText(r, i));
  }
  const g = graftText(card);
  if (g !== null) parts.push(g);
  return parts.filter((p) => p !== "").join(" ");
}

// ---------------------------------------------------------------------------------------------
// Human review
// ---------------------------------------------------------------------------------------------

function humanRow(v: PolicyView): string {
  const report = v.mode.effective === "enforce" ? "" : " · *report mode: Graft blocks nothing*";
  if (v.state === "missing") {
    return `No ${codeSpan("graft.yaml")} on ${codeSpan(v.baseRef, 100)}: Graft does not ask for approvals.`;
  }
  const verdict = v.verdict;
  if (v.state === "invalid" || verdict === null) {
    return `${codeSpan("graft.yaml")} on ${codeSpan(v.baseRef, 100)} is invalid: no decision.`;
  }
  if (v.enforced?.reason === "break_glass" && v.breakGlass?.state === "applied") {
    return `**Bypassed by break-glass** (${codeSpan(v.breakGlass.login)}) for this commit${report}`;
  }
  if (verdict.outcome === "would_block") {
    return `**Blocked** by ${verdict.blockedBy.length === 1 ? `rule ${verdict.blockedBy[0]}` : `rules ${verdict.blockedBy.join(", ")}`} of the policy${report}`;
  }
  if (verdict.outcome === "would_approve") return `**None required** by the policy${report}`;
  const counted = v.approvers?.counted.length ?? v.approvals?.current ?? 0;
  if (v.enforced?.reason === "requirements_met") {
    return `✅ **Required approvals present** (${counted} of ${verdict.humans})${report}`;
  }
  const teams = verdict.constraints
    .filter((c) => c.teams.length > 0)
    .map(
      (c) => `${c.humans} from ${c.teams.map((t) => codeSpan(`@${v.owner}/${t}`)).join(" or ")}`,
    );
  const from = teams.length > 0 ? ` (${teams.join("; ")})` : "";
  const requested = v.approvers?.changesRequestedBy ?? [];
  const changes =
    requested.length > 0
      ? ` · changes requested by ${requested
          .slice(0, 3)
          .map((l) => codeSpan(l))
          .join(", ")}`
      : "";
  return `**${plural(verdict.humans, "approval", "approvals")} needed**${from} · ${counted} so far${changes}${report}`;
}

// ---------------------------------------------------------------------------------------------
// Before you merge
// ---------------------------------------------------------------------------------------------

function points(i: SummaryInput): string[] {
  const card = cardForHead(i);
  const out: string[] = [];
  if (card !== null && disagrees(card)) {
    const idx = new Map(card.verifier.claims.map((c) => [c.id, claimIndex(c.id)] as const));
    const failing = failingClaims(card);
    const first = failing[0];
    if (first !== undefined) {
      const more = failing.length > 1 ? ` (and ${failing.length - 1} more)` : "";
      out.push(
        `❌ **The card is wrong** · ${LABEL_FOR_KIND(first, idx)} is ${first.verdict}: ${escapeProse(first.reason, 200)}${more}`,
      );
    }
  }
  if (card?.instructionsInData) {
    out.push(
      "⚠️ **Text addressed to AI reviewers** · Graft ignored it. Read the description and the diff yourself.",
    );
  }
  const s = i.signals;
  if (s !== null && s.ci.failed > 0) {
    out.push(
      `🧪 **CI fails** · ${s.ci.failing.map((n) => codeSpan(n, 80)).join(", ")}: fix it before merging.`,
    );
  }
  for (const r of s?.aiReviews ?? []) {
    if (r.state === "failed") {
      out.push(
        distrust(r, card) === null
          ? `🤖 **AI review found issues** · ${codeSpan(r.check, 80)}: read its comments.`
          : `🤖 **AI review failed** · ${codeSpan(r.check, 80)}: see its check run.`,
      );
    }
  }
  if (card?.card) {
    for (const r of card.card.requested) {
      if (r.status === "missing") out.push(`🎯 **Asked, not done** · ${escapeProse(r.item, 150)}`);
      if (r.status === "partial")
        out.push(`🎯 **Asked, partly done** · ${escapeProse(r.item, 150)}`);
    }
    const unread = card.risk.floorReasons.find((r) => r.rule === "partial_view");
    if (unread !== undefined && unread.paths.length > 0) {
      const shown = unread.paths.slice(0, 3).map((p) => codeSpan(p));
      const more = unread.count - shown.length;
      out.push(
        `👀 **Not read in full by Graft** · ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}: check ${unread.count === 1 ? "this file" : "these files"} yourself.`,
      );
    }
    for (const e of card.card.outOfScopeEdits) {
      out.push(`📦 **Out of scope** · ${codeSpan(e.path)}: ${escapeProse(e.reason, 200)}`);
    }
    for (const p of card.verifier.unexplained) {
      out.push(`📦 **Out of scope** · ${codeSpan(p)}: flagged by the verifier`);
    }
    if (card.verifier.status !== "error") {
      for (const m of card.verifier.missing) {
        out.push(`➕ **Also changed, not in the description** · ${escapeProse(m, 200)}`);
      }
    }
    const sensitive = card.risk.floorReasons.filter((r) => SENSITIVE_RULES.has(r.rule));
    if (sensitive.length > 0) {
      out.push(
        `🛡️ **Sensitive files** · ${sensitive
          .slice(0, 2)
          .map((r) => describeFloorReason(r, card, 3))
          .join("; ")}`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Gates: the five statuses the table and the card show
// ---------------------------------------------------------------------------------------------

export type GateStatus = "ok" | "warn" | "bad" | "neutral" | "running";
export type GateKey = "intent" | "risk" | "ci" | "review" | "approvals";

/** A gate's label and value are written by Graft, never by a model: they go into table cells. */
export interface Gate {
  key: GateKey;
  label: string;
  value: string;
  status: GateStatus;
}

export interface SummaryModel {
  level: Level;
  title: string;
  subtitle: string;
  gates: Gate[];
  headSha: string;
  report: boolean;
}

const GATE_LABEL: Record<GateKey, string> = {
  intent: "Intent",
  risk: "Risk",
  ci: "CI",
  review: "AI review",
  approvals: "Approvals",
};

const LEVEL_STATUS: Record<Level, GateStatus> = {
  pending: "running",
  green: "ok",
  yellow: "neutral",
  orange: "warn",
  red: "bad",
};

function intentGate(i: SummaryInput): [string, GateStatus] {
  const card = cardForHead(i);
  if (card === null) return ["Waiting", "running"];
  if (card.status === "unavailable" || card.card === null) return ["Unknown", "warn"];
  if (disagrees(card)) return ["Card wrong", "bad"];
  const status = LEVEL_STATUS[intentRow(i).level];
  switch (card.card.intentMatch) {
    case null:
      return ["Not checked", "neutral"];
    case "unknown":
      return ["Unknown", "neutral"];
    case "matches":
      return ["Matches", status];
    case "partial":
      return ["Partly", "warn"];
    case "differs":
      return ["No", "bad"];
  }
}

function riskGate(i: SummaryInput): [string, GateStatus] {
  switch (riskOf(i)) {
    case "trivial":
      return ["Trivial", "ok"];
    case "logic":
      return ["Logic", "neutral"];
    case "sensitive":
      return ["Sensitive", "warn"];
    default:
      return ["Pending", "running"];
  }
}

function ciGate(i: SummaryInput): [string, GateStatus] {
  const s = i.signals;
  if (s === null) return ["Not read", "neutral"];
  const { passed, failed, pending } = s.ci;
  const total = passed + failed + pending;
  if (total === 0) return ["None", "neutral"];
  if (failed > 0) return [`${failed} failing`, "bad"];
  if (pending > 0) return [`${passed}/${total} running`, "running"];
  return [`${total}/${total} passed`, s.ci.incomplete ? "neutral" : "ok"];
}

function reviewGate(i: SummaryInput): [string, GateStatus] {
  const reviews = i.signals?.aiReviews ?? [];
  if (reviews.length === 0) return ["None", "neutral"];
  const card = cardForHead(i);
  if (reviews.some((r) => r.state === "failed")) {
    return reviews.some((r) => r.state === "failed" && distrust(r, card) === null)
      ? ["Found issues", "bad"]
      : ["Failed", "bad"];
  }
  if (reviews.some((r) => r.state === "pending")) return ["Running", "running"];
  if (cleanIndependentReview(i)) return ["No issues", "ok"];
  const trusted = reviews.some((r) => r.state === "passed" && distrust(r, card) === null);
  return trusted ? ["Same model", "warn"] : ["Ran", "neutral"];
}

function approvalsGate(v: PolicyView): [string, GateStatus] {
  if (v.state === "missing") return ["No policy", "neutral"];
  const verdict = v.verdict;
  if (v.state === "invalid" || verdict === null) return ["Invalid policy", "warn"];
  if (v.enforced?.reason === "break_glass") return ["Break-glass", "warn"];
  if (verdict.outcome === "would_block") return ["Blocked", "bad"];
  if (verdict.outcome === "would_approve") return ["None needed", "ok"];
  const counted = v.approvers?.counted.length ?? v.approvals?.current ?? 0;
  const met = v.enforced?.reason === "requirements_met";
  return [`${Math.min(counted, verdict.humans)}/${verdict.humans}`, met ? "ok" : "warn"];
}

/** Short words for the verdict's subtitle. */
function approvalsShort(v: PolicyView): string | null {
  const verdict = v.verdict;
  if (v.state !== "ok" || verdict === null) return null;
  if (verdict.outcome === "would_block") return "blocked by the policy";
  if (verdict.outcome === "would_approve") return "no approval needed";
  if (v.enforced?.reason === "requirements_met") return "approvals in";
  const counted = v.approvers?.counted.length ?? v.approvals?.current ?? 0;
  const missing = Math.max(0, verdict.humans - counted);
  return missing === 0 ? "approvals in" : `${plural(missing, "approval", "approvals")} needed`;
}

const TITLE: Record<Exclude<Level, "green">, string> = {
  pending: "Graft is still reviewing",
  red: "Don't merge yet",
  orange: "Needs human review",
  yellow: "Needs a normal review",
};

export function summaryModel(i: SummaryInput): SummaryModel {
  const level = assess(i);
  const nPoints = points(i).length;
  const title =
    level === "green" ? (riskOf(i) === "trivial" ? "Safe to merge" : "Low risk") : TITLE[level];
  const parts: string[] = [];
  if (level !== "pending" && nPoints > 0)
    parts.push(`${plural(nPoints, "thing", "things")} to check`);
  const approvals = approvalsShort(i.policy);
  if (approvals !== null) parts.push(approvals);
  const gate = (key: GateKey, [value, status]: [string, GateStatus]): Gate => ({
    key,
    label: GATE_LABEL[key],
    value,
    status,
  });
  return {
    level,
    title,
    subtitle: parts.join(" · "),
    gates: [
      gate("intent", intentGate(i)),
      gate("risk", riskGate(i)),
      gate("ci", ciGate(i)),
      gate("review", reviewGate(i)),
      gate("approvals", approvalsGate(i.policy)),
    ],
    headSha: i.headSha,
    report: i.policy.mode.effective !== "enforce",
  };
}

/** The sentence a screen reader, or an email without images, gets for the card. */
export function modelText(m: SummaryModel): string {
  const head = m.subtitle === "" ? m.title : `${m.title}: ${m.subtitle}`;
  return `${head}. ${m.gates.map((g) => `${g.label}: ${g.value}`).join(". ")}.`;
}

// ---------------------------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------------------------

const CALLOUT: Record<Level, string> = {
  pending: "NOTE",
  red: "CAUTION",
  orange: "WARNING",
  yellow: "NOTE",
  green: "TIP",
};

const GATE_ICON: Record<GateKey, string> = {
  intent: "🎯",
  risk: "🛡️",
  ci: "🧪",
  review: "🤖",
  approvals: "👥",
};

const STATUS_ICON: Record<GateStatus, string> = {
  ok: "✅",
  warn: "🟠",
  bad: "❌",
  neutral: "➖",
  running: "⏳",
};

function gateTable(m: SummaryModel): string[] {
  return [
    `| ${m.gates.map((g) => `${GATE_ICON[g.key]} ${g.label}`).join(" | ")} |`,
    `| ${m.gates.map(() => ":---:").join(" | ")} |`,
    `| ${m.gates.map((g) => `${STATUS_ICON[g.status]} **${g.value}**`).join(" | ")} |`,
  ];
}

export interface SummaryRenderOptions {
  /**
   * Markdown for the status card image of this model (a `<picture>`), or null for none. With a
   * card, the card replaces the gate table; its alt text carries the same words.
   */
  cardImage?: (m: SummaryModel) => string | null;
}

export function renderSummarySection(i: SummaryInput, o: SummaryRenderOptions = {}): string {
  const m = summaryModel(i);
  const all = points(i);
  const shown = all.slice(0, MAX_POINTS);
  const lines = [
    `> [!${CALLOUT[m.level]}]`,
    `> **${m.title}**${m.subtitle === "" ? "" : ` · ${m.subtitle}`}`,
    "",
  ];
  const image = o.cardImage?.(m) ?? null;
  lines.push(...(image === null ? gateTable(m) : [image]));
  if (shown.length > 0) {
    lines.push("", "**Before you merge**", "", ...shown.map((p) => `- ${p}`));
    if (all.length > shown.length) {
      lines.push(`- …and ${all.length - shown.length} more in the details below`);
    }
  }
  lines.push(
    "",
    "<details><summary>Why this verdict</summary>",
    "",
    `- **Matches the intent?** ${intentRow(i).text}`,
    `- **Safe to merge?** ${safeRow(i, m.level)}`,
    `- **Human review:** ${humanRow(i.policy)}`,
    "",
    "</details>",
    "",
    "---",
  );
  return lines.join("\n");
}
