/**
 * Rendering of the policy verdict (spec §10): the check title, the `policy` section of the
 * managed comment and the check run details. Pure.
 *
 * Every string that comes from the file or the PR goes through `escapeProse` or `codeSpan`, never
 * into a table cell. Team names are ALWAYS code spans, so the comment never notifies a team (D19).
 */
import { MAX_SECTION_CHARS } from "../../github/managed-comment.js";
import { codeSpan, escapeProse } from "../../github/markdown.js";
import {
  formatPolicyErrorParts,
  type PolicyError,
  type PolicyWarning,
  policyWarningMessage,
} from "../../policy/errors.js";
import type {
  ApprovalCount,
  Constraint,
  MatchedRule,
  MatchReason,
  PolicyFacts,
  PolicyVerdict,
} from "../../policy/evaluate.js";
import type { Policy } from "../../policy/schema.js";

export type PolicyOutcome =
  | "would_approve"
  | "would_require"
  | "would_block"
  | "no_policy"
  | "policy_invalid";

export const POLICY_CHECK_NAME = "graft/policy";
export const MAX_TITLE_CHARS = 200;
const MAX_LISTED_ERRORS = 20;
const MAX_DETAIL_RULES = 50;

export interface PolicyView {
  state: "ok" | "missing" | "invalid";
  owner: string;
  baseRef: string;
  /** The policy (base branch) commit. */
  commitSha: string;
  headSha: string;
  fileSha: string | null;
  hash: string | null;
  policy: Policy | null;
  verdict: PolicyVerdict | null;
  facts: PolicyFacts | null;
  approvals: ApprovalCount | null;
  errors: PolicyError[];
  /** Non-fatal findings of a valid file (step 6): non-ASCII globs. Check run only. */
  warnings?: PolicyWarning[];
  /** The PR adds graft.yaml where the base has none. */
  addsPolicyFile: boolean;
}

export function viewOutcome(v: Pick<PolicyView, "state" | "verdict">): PolicyOutcome {
  if (v.state === "missing") return "no_policy";
  if (v.state === "invalid" || v.verdict === null) return "policy_invalid";
  return v.verdict.outcome;
}

const short = (sha: string): string => sha.slice(0, 7);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const cutChars = (s: string, max: number): string => Array.from(s).slice(0, max).join("");

// ---------------------------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------------------------

function teamsText(owner: string, teams: readonly string[], wrap: (s: string) => string): string {
  return teams.map((t) => wrap(`@${owner}/${t}`)).join(" or ");
}

function requireTitle(
  v: PolicyView,
  verdict: Extract<PolicyVerdict, { outcome: "would_require" }>,
  wrap: (s: string) => string,
): string {
  const h = verdict.humans;
  const head = `Would require ${plural(h, "human", "humans")}`;
  const teamConstraints: Constraint[] = verdict.constraints.filter((c) => c.teams.length > 0);
  const only = verdict.constraints.length === 1 ? verdict.constraints[0] : undefined;
  if (only && only.teams.length > 0 && only.humans === h) {
    return `${head} from ${teamsText(v.owner, only.teams, wrap)}`;
  }
  let out = head;
  if (teamConstraints.length > 0) {
    out += ` (${teamConstraints
      .map((c) => `${c.humans} from ${teamsText(v.owner, c.teams, wrap)}`)
      .join("; ")})`;
  } else if (verdict.usedDefault) {
    out += " (default)";
  }
  return out;
}

function titleWith(v: PolicyView, wrap: (s: string) => string): string {
  const outcome = viewOutcome(v);
  const verdict = v.verdict;
  let title: string;
  if (outcome === "no_policy") {
    title = `No graft.yaml on ${cutChars(v.baseRef, 100)}`;
  } else if (outcome === "policy_invalid") {
    title = `Policy invalid: no decision (${plural(v.errors.length, "error", "errors")})`;
  } else if (verdict?.outcome === "would_block") {
    title =
      verdict.blockedBy.length === 1
        ? `Would block: rule ${verdict.blockedBy[0]}`
        : `Would block: rules ${verdict.blockedBy.join(", ")}`;
  } else if (verdict?.outcome === "would_approve") {
    title = "Would auto-approve";
  } else if (verdict?.outcome === "would_require") {
    title = requireTitle(v, verdict, wrap);
  } else {
    title = "Policy invalid: no decision";
  }
  if (
    verdict &&
    v.state === "ok" &&
    !verdict.effectiveRisk.final &&
    verdict.outcome !== "would_block"
  ) {
    title += " · risk provisional";
  }
  return title;
}

/** The check run title, plain text, at most 200 characters. */
export function policyTitle(v: PolicyView): string {
  const t = titleWith(v, (s) => s);
  const chars = Array.from(t);
  return chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join("")}…` : t;
}

// ---------------------------------------------------------------------------------------------
// Reasons and bullets
// ---------------------------------------------------------------------------------------------

function riskSourceText(verdict: PolicyVerdict): string {
  const r = verdict.effectiveRisk;
  const base =
    r.source === "card"
      ? "card"
      : r.source === "card_unavailable"
        ? "card unavailable"
        : "rules; card pending";
  const raised = r.raisedBy.map((x) =>
    x === "sensitive_paths" ? "raised by sensitive_paths" : "raised by graft.yaml change",
  );
  return [base, ...raised].join(", ");
}

function unknownText(key: MatchReason["key"], facts: PolicyFacts): string {
  switch (key) {
    case "risk":
      return "card pending";
    case "paths":
      return "file list incomplete";
    default:
      return facts.author.kind === "agent" ? "agent not reported" : "provenance pending";
  }
}

function reasonText(r: MatchReason, verdict: PolicyVerdict, facts: PolicyFacts): string {
  let text: string;
  switch (r.key) {
    case "risk":
      text = `risk ${codeSpan(verdict.effectiveRisk.value)} (${riskSourceText(verdict)})`;
      break;
    case "paths": {
      const shown = r.paths.slice(0, 3).map((p) => codeSpan(p));
      const more = r.count - shown.length;
      text =
        shown.length === 0
          ? "paths match"
          : `paths match ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
      break;
    }
    case "only_paths":
      text = `all ${r.count} paths match`;
      break;
    case "author":
      text = `author ${facts.author.kind}${facts.author.agent !== null ? ` ${codeSpan(facts.author.agent)}` : ""}`;
      break;
    case "agent":
      text =
        facts.author.agent !== null ? `agent ${codeSpan(facts.author.agent)}` : "agent unknown";
      break;
    case "labels":
      text = `label ${r.paths
        .slice(0, 3)
        .map((l) => codeSpan(l))
        .join(", ")}`;
      break;
    case "size":
      text = `size ${facts.size.lines} lines, ${facts.size.files} files`;
      break;
  }
  return r.uncertain ? `${text} (unknown: ${unknownText(r.key, facts)})` : text;
}

function ruleLabel(policy: Policy | null, index: number): string {
  const name = policy?.rules.find((r) => r.index === index)?.name ?? null;
  return name === null ? `Rule ${index}` : `Rule ${index} ${escapeProse(name, 80)}`;
}

function bullet(m: MatchedRule, v: PolicyView, verdict: PolicyVerdict, facts: PolicyFacts): string {
  const reasons = m.reasons.map((r) => reasonText(r, verdict, facts)).join(", ");
  return `- ${ruleLabel(v.policy, m.index)}: ${reasons}${m.overridden ? " (overridden)" : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------------------------

const REPORT_ONLY = " · report only";
const PHASE0 = "Graft only reports in Phase 0; it approves and blocks nothing.";

function importantBlock(text: string): string {
  return `> [!IMPORTANT]\n> ${text}`;
}

function approvalsLine(a: ApprovalCount): string {
  const logins = a.users.map((u) => codeSpan(u));
  const rest = a.current - a.users.length;
  let who = "";
  if (logins.length > 0) {
    const shown =
      rest > 0
        ? `${logins.join(", ")} and ${rest} more`
        : logins.length > 1
          ? `${logins.slice(0, -1).join(", ")} and ${logins[logins.length - 1]}`
          : (logins[0] ?? "");
    who = ` (${shown})`;
  }
  const parts = [`${a.current} on this head${who}`];
  if (a.stale > 0) parts.push(`${a.stale} on an older commit`);
  const cap = a.truncated ? " (first 300 reviews)" : "";
  return `**Approvals so far:** ${parts.join(", ")}${cap}. Team membership is not checked in Phase 0.`;
}

function listedErrors(errors: readonly PolicyError[]): string[] {
  const lines = errors.slice(0, MAX_LISTED_ERRORS).map((e) => {
    const { text, placeholder } = formatPolicyErrorParts(e);
    // The message is prose; the closing "(code)" is ours, so its parentheses stay literal.
    const message = text.slice(0, text.length - ` (${e.code})`.length);
    const escaped = escapeProse(message, 300);
    const key = e.key === undefined ? "" : codeSpan(e.key, 40);
    return `- ${escaped.replace(placeholder, () => key)} (${escapeProse(e.code, 40)})`;
  });
  if (errors.length > MAX_LISTED_ERRORS) {
    lines.push(`- and ${errors.length - MAX_LISTED_ERRORS} more`);
  }
  return lines;
}

export function renderPolicySection(v: PolicyView): string {
  const outcome = viewOutcome(v);
  const base = codeSpan(v.baseRef, 100);
  const head = short(v.headSha);

  if (outcome === "no_policy") {
    const parts = [
      "### Policy",
      `**No policy**${REPORT_ONLY}`,
      `There is no \`graft.yaml\` on ${base} at \`${short(v.commitSha)}\`. Add one to report what Graft would require; see the graft.yaml reference in the Graft docs.`,
    ];
    if (v.addsPolicyFile) {
      parts.push(
        importantBlock(
          "This pull request adds `graft.yaml`. It takes effect after merge; until then there is no policy.",
        ),
      );
    }
    parts.push(`Head \`${head}\` · ${PHASE0}`);
    return parts.join("\n\n");
  }

  if (outcome === "policy_invalid" || v.verdict === null || v.facts === null) {
    const title = titleWith(v, (s) => codeSpan(s));
    const parts = [
      "### Policy",
      `**${title}**${REPORT_ONLY}`,
      `\`graft.yaml\` on ${base} at \`${short(v.commitSha)}\` cannot be used, so Graft would not auto-approve anything:`,
      listedErrors(v.errors).join("\n"),
      "Fix the file on " +
        `${base}, and check it locally with \`pnpm graft policy check graft.yaml\`.`,
      `Head \`${head}\` · ${PHASE0}`,
    ];
    return parts.join("\n\n");
  }

  const { verdict, facts } = v;
  const headline = `**${titleWith(v, (s) => codeSpan(s))}**${REPORT_ONLY}`;
  const notes: string[] = [];
  if (verdict.policyFileChanged) {
    notes.push(
      importantBlock(
        `This pull request changes \`graft.yaml\`. Its version is ignored: the policy on ${base} applies, and the change needs at least 1 human.`,
      ),
    );
  }
  if (
    !verdict.policyFileChanged &&
    !facts.listingComplete &&
    verdict.outcome === "would_require" &&
    verdict.builtIn === "policy_file_changed"
  ) {
    notes.push(
      "> [!NOTE]\n> The list of changed files is incomplete, so Graft cannot rule out a change to `graft.yaml`. Approve rules are not applied and at least 1 human is needed.",
    );
  }
  if (verdict.limits?.includes("path_too_long")) {
    notes.push(
      "> [!NOTE]\n> A changed path is longer than 1,024 characters or has more than 128 segments (`path_too_long`). Graft does not match such a path: it counts as matching every sensitive-path and tightening `paths` rule and no approve rule.",
    );
  }
  if (verdict.limits?.includes("budget_exhausted")) {
    notes.push(
      "> [!NOTE]\n> Glob matching stopped at its work limit (`budget_exhausted`). The remaining `paths` rules were applied on the strict side and approve rules did not match.",
    );
  }
  if (!verdict.effectiveRisk.final) {
    notes.push(
      "> [!NOTE]\n> The intent card for this head is not ready, so the risk used is at least `logic` and rules that depend on it are applied conservatively. Graft re-evaluates when the card is published.",
    );
  }
  const tail: string[] = [];
  const a = v.approvals;
  if (a && !(verdict.outcome === "would_approve" && a.current + a.stale === 0)) {
    tail.push(approvalsLine(a));
  }
  tail.push(
    `Policy \`graft.yaml\` on ${base} at \`${short(v.commitSha)}\` · head \`${head}\` · ${PHASE0}`,
  );

  const bullets =
    verdict.matched.length === 0
      ? ["- No rule matched; the default applies."]
      : verdict.matched.map((m) => bullet(m, v, verdict, facts));

  const build = (lines: string[]): string =>
    ["### Policy", headline, lines.join("\n"), ...notes, ...tail].join("\n\n");

  let out = build(bullets);
  if (out.length > MAX_SECTION_CHARS) {
    // Keep the headline, the notes and the footer; cut the rule bullets.
    let keep = bullets.length;
    for (;;) {
      keep = Math.max(0, keep - Math.max(1, Math.floor(keep / 10)));
      const lines = [...bullets.slice(0, keep), `- and ${bullets.length - keep} more rules`];
      out = build(lines);
      if (out.length <= MAX_SECTION_CHARS || keep === 0) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Check run details
// ---------------------------------------------------------------------------------------------

function actionText(m: MatchedRule, policy: Policy | null, owner: string): string {
  const action = policy?.rules.find((r) => r.index === m.index)?.action;
  if (!action) return m.action;
  if (action.kind === "approve") return "approve";
  if (action.kind === "block") return "block";
  const teams =
    action.teams.length > 0 ? ` from ${teamsText(owner, action.teams, (s) => codeSpan(s))}` : "";
  return `require ${action.humans}${teams}`;
}

/** `output.text` of the check run; null when there is nothing to detail. */
export function renderPolicyDetails(v: PolicyView): string | null {
  if (v.state !== "ok" || v.verdict === null || v.facts === null) return null;
  const { verdict, facts } = v;
  const lines: string[] = [];
  const shown = verdict.matched.slice(0, MAX_DETAIL_RULES);
  const matched = shown.map((m) => {
    const reasons = m.reasons.map((r) => reasonText(r, verdict, facts)).join(", ");
    return `- ${ruleLabel(v.policy, m.index)} → ${actionText(m, v.policy, v.owner)}: ${reasons}${m.overridden ? " (overridden)" : ""}`;
  });
  if (verdict.matched.length > shown.length) {
    matched.push(`- and ${verdict.matched.length - shown.length} more`);
  }
  lines.push("**Matched rules**", "", ...(matched.length > 0 ? matched : ["- None"]), "");

  const r = verdict.effectiveRisk;
  const from =
    r.source === "card"
      ? "the card"
      : r.source === "card_unavailable"
        ? "the card (unavailable)"
        : "rules; card pending";
  const author =
    facts.author.kind === "unknown"
      ? "Author unknown (provenance pending)"
      : `Author ${facts.author.kind}${facts.author.agent !== null ? ` ${codeSpan(facts.author.agent)}` : ""} (provenance for head ${codeSpan(short(v.headSha))})`;
  lines.push(
    "**Facts used**",
    "",
    `- Risk ${codeSpan(r.value)} from ${from} (${r.final ? "final" : "provisional"})`,
    `- ${author}`,
    `- ${plural(facts.size.files, "file", "files")} changed, ${facts.size.lines} lines; file list ${facts.listingComplete ? "complete" : "incomplete"}`,
    `- Labels: ${
      facts.labels.length === 0
        ? "none"
        : facts.labels
            .slice(0, 10)
            .map((l) => codeSpan(l, 50))
            .join(", ")
    }`,
    `- Policy file SHA ${codeSpan(short(v.fileSha ?? ""))}, policy hash ${codeSpan((v.hash ?? "").slice(0, 8))}`,
  );
  const total = v.policy?.rules.length ?? 0;
  const others = total - verdict.matched.length;
  if (others > 0) {
    lines.push("", `${others} other ${others === 1 ? "rule" : "rules"} did not match.`);
  }
  const warnings = v.warnings ?? [];
  if (warnings.length > 0) {
    lines.push(
      "",
      "**Warnings**",
      "",
      ...warnings.slice(0, MAX_LISTED_ERRORS).map((w) => {
        const where = w.line !== null ? ` (line ${w.line})` : "";
        return `- ${escapeProse(`${w.location}${where}: ${policyWarningMessage(w)}; check for lookalike letters`, 300)} (${escapeProse(w.code, 40)})`;
      }),
    );
    if (warnings.length > MAX_LISTED_ERRORS) {
      lines.push(`- and ${warnings.length - MAX_LISTED_ERRORS} more`);
    }
  }
  return lines.join("\n");
}
