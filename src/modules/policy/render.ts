/**
 * Rendering of the policy verdict (spec §10): the check title, the `policy` section of the
 * managed comment and the check run details. Pure.
 *
 * Every string that comes from the file or the PR goes through `escapeProse` or `codeSpan`, never
 * into a table cell. Team names are ALWAYS code spans, so the comment never notifies a team (D19).
 */
import { MAX_SECTION_CHARS } from "../../github/managed-comment.js";
import { codeSpan, escapeProse } from "../../github/markdown.js";
import type { Mode } from "../../modes/index.js";
import type {
  ApproverFacts,
  ConstraintStatus,
  Enforced,
  Unverified,
} from "../../policy/enforce.js";
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

/**
 * What a break-glass label means for this head (Phase 1 step 3, §7); null when there is nothing to
 * say (no label, feature off, or the label was removed). Logins are always code spans.
 */
export type BreakGlassView =
  | {
      state: "applied";
      login: string;
      role: string;
      headSha: string;
      self: boolean;
      labelEventAt: Date | null;
    }
  | {
      state: "ignored";
      reason: "role_too_low" | "bot" | "role_unverified" | "actor_unknown";
      login: string | null;
      role: string | null;
      self: boolean;
      labelEventAt: Date | null;
    }
  | { state: "stale" };

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
  /** The effective `policy_mode` (Phase 1 step 1): which wording is shown (step 2, §9). */
  mode: { effective: Mode };
  /**
   * What enforce mode concludes (Phase 1 step 2), computed in every mode. Report mode shows it
   * as the would-be line; enforce mode titles the check with it. Absent: nothing is said.
   */
  enforced?: Enforced | null;
  /** Who counted (Phase 1 step 2); null when the policy is not valid. */
  approvers?: ApproverFacts | null;
  /** Phase 1 step 3: the break-glass state of this head. Absent or null: nothing to say. */
  breakGlass?: BreakGlassView | null;
  /**
   * Phase 1 step 7 (D8): who an MCP-opened PR's approvals exclude. `commit_authors`: the commit
   * authors and committers; the other values: everyone, with a line saying why. Absent or null:
   * not an MCP-opened PR.
   */
  mcpExclusion?: McpExclusion | null;
}

export type McpExclusion = "commit_authors" | "too_many" | "no_author" | "unverified";

/** D8 (§11): the line for each exclusion that makes every approval not count. */
export const MCP_EXCLUSION_TEXT: Record<Exclude<McpExclusion, "commit_authors">, string> = {
  unverified:
    "Approvals do not count: this PR was opened through MCP and has commits that GitHub has not verified.",
  too_many: "Approvals do not count: this PR was opened through MCP and has more than 250 commits.",
  no_author:
    "Approvals do not count: this PR was opened through MCP and has commits that GitHub cannot link to an account.",
};

function mcpExclusionLine(v: PolicyView): string | null {
  const e = v.mcpExclusion;
  return e === undefined || e === null || e === "commit_authors" ? null : MCP_EXCLUSION_TEXT[e];
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

/** In enforce mode, the conclusion is what the title says (§9). */
const enforcing = (v: PolicyView): Enforced | null =>
  v.mode.effective === "enforce" && v.enforced ? v.enforced : null;

function whoText(v: PolicyView, c: ConstraintStatus, wrap: (s: string) => string): string {
  return c.teams.length > 0 ? teamsText(v.owner, c.teams, wrap) : "anyone";
}

/**
 * The enforce conclusion in words, one source for the enforce title and the would-be line.
 * `sentence` is capitalised (a title); otherwise it continues a sentence.
 */
function enforcedText(
  v: PolicyView,
  e: Enforced,
  wrap: (s: string) => string,
  sentence: boolean,
): string {
  const cap = (s: string) => (sentence ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  switch (e.reason) {
    case "break_glass": {
      const bg = v.breakGlass?.state === "applied" ? v.breakGlass : null;
      const who = bg === null ? "a maintainer" : wrap(bg.login);
      return sentence ? `Bypassed by break-glass (${who})` : `break-glass by ${who}`;
    }
    case "approved_by_policy":
      return sentence ? "Policy satisfied: no review required" : "no review required";
    case "requirements_met":
      return sentence
        ? "Policy satisfied: required approvals present"
        : "required approvals present";
    case "card_pending":
      return cap("waiting for the intent card");
    case "no_policy":
    case "policy_invalid":
      return cap(`no valid graft.yaml on ${wrap(cutChars(v.baseRef, 100))}`);
    case "reviews_truncated":
      return cap("too many reviews to count (over 300)");
    case "blocked": {
      const by = v.verdict?.outcome === "would_block" ? v.verdict.blockedBy : [];
      return cap(
        by.length === 1 ? `blocked by rule ${by[0]}` : `blocked by rules ${by.join(", ")}`,
      );
    }
    case "changes_requested": {
      const who = v.approvers?.changesRequestedBy ?? [];
      const more = who.length > 1 ? ` and ${who.length - 1} more` : "";
      return cap(
        `changes requested by ${who[0] === undefined ? "a reviewer" : wrap(who[0])}${more}`,
      );
    }
    case "approvals_missing": {
      const unmet = e.constraints.filter((c) => !c.met);
      const missing = (c: ConstraintStatus) => Math.max(0, c.humans - c.approvedCount);
      const only = unmet.length === 1 ? unmet[0] : undefined;
      if (only) {
        const n = missing(only);
        return cap(
          `needs ${n} more ${n === 1 ? "approval" : "approvals"} from ${whoText(v, only, wrap)}`,
        );
      }
      if (unmet.length === 0) return cap("needs approvals");
      return cap(
        `needs approvals: ${unmet
          .map(
            (c) => `${missing(c)}${c.approvedCount > 0 ? " more" : ""} from ${whoText(v, c, wrap)}`,
          )
          .join(", ")}`,
      );
    }
  }
}

/** The check run title, plain text, at most 200 characters. */
export function policyTitle(v: PolicyView): string {
  const e = enforcing(v);
  const t = e ? enforcedText(v, e, (s) => s, true) : titleWith(v, (s) => s);
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

/** The section footer (the Phase 0 `PHASE0` sentence, reworded in Phase 1 step 2). */
function footer(v: PolicyView): string {
  return v.mode.effective === "enforce"
    ? "Graft mode: enforce. This check is required only if branch protection says so."
    : "Graft mode: report. Graft approves and blocks nothing here.";
}

/** The headline: the report title with ` · report only`, or the enforce title alone. */
function headlineOf(v: PolicyView, reportTitle: string): string {
  const e = enforcing(v);
  return e
    ? `**${enforcedText(v, e, (s) => codeSpan(s), true)}**`
    : `**${reportTitle}**${REPORT_ONLY}`;
}

/** Report mode only, right after the headline: what enforce mode would conclude (§9). */
export function wouldBeLine(v: PolicyView): string | null {
  const e = v.enforced;
  if (!e || v.mode.effective === "enforce") return null;
  const text = enforcedText(v, e, (s) => codeSpan(s), false);
  const head = "**In enforce mode this check would be:**";
  return e.conclusion === "failure"
    ? `${head} \`failure\`, ${text}.`
    : `${head} \`${e.conclusion}\` (${text}).`;
}

const optional = (s: string | null): string[] => (s === null ? [] : [s]);

const IGNORED_TEXT: Record<Extract<BreakGlassView, { state: "ignored" }>["reason"], string> = {
  role_too_low: "",
  bot: "a bot",
  role_unverified: "role could not be verified",
  actor_unknown: "who applied it could not be determined",
};

/** Step 3, §7: the break-glass line, right after the headline; null when there is none. */
export function breakGlassLine(v: PolicyView): string | null {
  const bg = v.breakGlass;
  if (!bg) return null;
  if (bg.state === "stale") {
    return "**Break-glass not applied:** the pull request changed after the label was added. Remove and re-apply the label.";
  }
  if (bg.state === "ignored") {
    const paren = bg.reason === "role_too_low" ? (bg.role ?? "none") : IGNORED_TEXT[bg.reason];
    const by = bg.login === null ? "someone" : codeSpan(bg.login);
    return `**Break-glass label ignored:** applied by ${by} (${paren}). Only maintain or admin can bypass the policy.`;
  }
  const self = bg.self ? " (on their own pull request)" : "";
  const effect =
    v.mode.effective === "enforce"
      ? "this check passes for this commit only"
      : "Graft would bypass the policy for this commit (report mode)";
  return `**Break-glass** by ${codeSpan(bg.login)} (${bg.role}) on \`${short(bg.headSha)}\`${self}: ${effect}. A new push needs the label again.`;
}

/** Step 3, §7: the details block; the normal verdict and approvals follow it. */
function breakGlassDetails(v: PolicyView): string[] {
  const bg = v.breakGlass;
  if (!bg) return [];
  const at = (d: Date | null) => (d === null ? "unknown" : d.toISOString());
  let lines: string[];
  if (bg.state === "applied") {
    lines = [
      `- Applied by ${codeSpan(bg.login)} (${bg.role})${bg.self ? ", on their own pull request" : ""}`,
      `- Commit ${codeSpan(short(bg.headSha))} only; a new push ends it`,
      `- Label added at ${at(bg.labelEventAt)}`,
      v.mode.effective === "enforce"
        ? "- This check passes for this commit whatever the policy says below"
        : "- Report mode: Graft would bypass the policy for this commit; the check stays neutral",
    ];
  } else if (bg.state === "ignored") {
    const who = bg.login === null ? "unknown" : codeSpan(bg.login);
    const why =
      bg.reason === "role_too_low"
        ? `role ${bg.role ?? "none"}, below maintain`
        : IGNORED_TEXT[bg.reason];
    lines = [
      `- Label ignored: applied by ${who} (${why})${bg.self ? ", on their own pull request" : ""}`,
      `- Label added at ${at(bg.labelEventAt)}`,
    ];
  } else {
    lines = ["- Not applied: the pull request changed after the label was added"];
  }
  return ["**Break-glass**", "", ...lines, ""];
}

function importantBlock(text: string): string {
  return `> [!IMPORTANT]\n> ${text}`;
}

function approvalsLine(a: ApprovalCount, approvers: ApproverFacts | null | undefined): string {
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
  const n = approvers?.counted.length;
  const counts = n === undefined ? "" : `; ${n} ${n === 1 ? "counts" : "count"} (write access)`;
  let line = `**Approvals so far:** ${parts.join(", ")}${cap}${counts}.`;
  const req = approvers?.changesRequestedBy ?? [];
  if (req.length > 0) {
    const shown = req.slice(0, 3).map((l) => codeSpan(l));
    const more = req.length > shown.length ? ` and ${req.length - shown.length} more` : "";
    line += ` Changes requested by ${shown.join(", ")}${more}.`;
  }
  return line;
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
      headlineOf(v, "No policy"),
      ...optional(breakGlassLine(v)),
      ...optional(wouldBeLine(v)),
      `There is no \`graft.yaml\` on ${base} at \`${short(v.commitSha)}\`. Add one to report what Graft would require; see the graft.yaml reference in the Graft docs.`,
    ];
    if (v.addsPolicyFile) {
      parts.push(
        importantBlock(
          "This pull request adds `graft.yaml`. It takes effect after merge; until then there is no policy.",
        ),
      );
    }
    parts.push(`Head \`${head}\` · ${footer(v)}`);
    return parts.join("\n\n");
  }

  if (outcome === "policy_invalid" || v.verdict === null || v.facts === null) {
    const title = titleWith(v, (s) => codeSpan(s));
    const parts = [
      "### Policy",
      headlineOf(v, title),
      ...optional(breakGlassLine(v)),
      ...optional(wouldBeLine(v)),
      `\`graft.yaml\` on ${base} at \`${short(v.commitSha)}\` cannot be used, so Graft would not auto-approve anything:`,
      listedErrors(v.errors).join("\n"),
      "Fix the file on " +
        `${base}, and check it locally with \`pnpm graft policy check graft.yaml\`.`,
      `Head \`${head}\` · ${footer(v)}`,
    ];
    return parts.join("\n\n");
  }

  const { verdict, facts } = v;
  const headline = [
    headlineOf(
      v,
      titleWith(v, (s) => codeSpan(s)),
    ),
    ...optional(breakGlassLine(v)),
    ...optional(wouldBeLine(v)),
  ].join("\n\n");
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
  const requested = v.approvers?.changesRequestedBy.length ?? 0;
  if (a && !(verdict.outcome === "would_approve" && a.current + a.stale + requested === 0)) {
    tail.push(approvalsLine(a, v.approvers));
  }
  const exclusion = mcpExclusionLine(v);
  if (exclusion !== null) tail.push(exclusion);
  tail.push(
    `Policy \`graft.yaml\` on ${base} at \`${short(v.commitSha)}\` · head \`${head}\` · ${footer(v)}`,
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

/** The first line of `output.text`. */
function modeLine(mode: Mode): string {
  return mode === "report"
    ? "Graft mode: report. This check never blocks a merge."
    : "Graft mode: enforce. This check passes or fails on this policy; a passing check is not a review approval.";
}

const UNVERIFIED_TEXT: Record<Unverified, string> = {
  no_permission: "the App has no members: read permission",
  owner_not_org: "the repository owner is not an organization",
  team_not_found: "no such team, or the App cannot see it",
  team_unreadable: "the App cannot read this team",
  check_limit: "too many checks in one evaluation",
};

const NOT_COUNTED_TEXT: Record<ApproverFacts["notCounted"][number]["why"], string> = {
  no_write_access: "no write access",
  permission_denied: "permission check refused",
  check_limit: "too many approvers to check",
};

const loginList = (logins: readonly string[], max = MAX_SHOWN_LOGINS): string => {
  const shown = logins.slice(0, max).map((l) => codeSpan(l));
  const more = logins.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
};
const MAX_SHOWN_LOGINS = 10;

/** The "Approvals counted" block of the details (§9), or nothing. */
function approvalsCounted(v: PolicyView): string[] {
  const a = v.approvers;
  const constraints = v.enforced?.constraints ?? [];
  if (!a || (constraints.length === 0 && a.notCounted.length === 0)) return [];
  const lines: string[] = [];
  for (const c of constraints) {
    const who = c.teams.length > 0 ? teamsText(v.owner, c.teams, (s) => codeSpan(s)) : "anyone";
    const parts: string[] = [];
    if (c.approvedBy.length > 0) {
      const more = c.approvedCount - c.approvedBy.length;
      parts.push(`${loginList(c.approvedBy)}${more > 0 ? ` and ${more} more` : ""}`);
    }
    for (const u of c.unverified) {
      parts.push(`cannot verify ${codeSpan(`@${v.owner}/${u.team}`)} (${UNVERIFIED_TEXT[u.why]})`);
    }
    lines.push(
      `- ${Math.min(c.approvedCount, c.humans)} of ${c.humans} from ${who}${parts.length > 0 ? `: ${parts.join("; ")}` : ""}`,
    );
  }
  const groups = new Map<string, string[]>();
  for (const n of a.notCounted) {
    const list = groups.get(n.why) ?? [];
    list.push(n.login);
    groups.set(n.why, list);
  }
  for (const [why, logins] of groups) {
    lines.push(
      `- not counted: ${loginList(logins)} (${NOT_COUNTED_TEXT[why as keyof typeof NOT_COUNTED_TEXT]})`,
    );
  }
  return ["", "**Approvals counted**", "", ...lines];
}

/** `output.text` of the check run: the mode line, then the details when there are any. */
export function renderPolicyDetails(v: PolicyView): string {
  const details = renderDetails(v);
  const line = modeLine(v.mode.effective);
  const bg = breakGlassDetails(v);
  const head = bg.length === 0 ? line : `${line}\n\n${bg.join("\n").trimEnd()}`;
  return details === null ? head : `${head}\n\n${details}`;
}

function renderDetails(v: PolicyView): string | null {
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
    ...approvalsCounted(v),
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
