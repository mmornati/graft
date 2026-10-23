/**
 * The fixed text of a revert (Phase 1 step 5, §8, §10, D11, D12). Pure.
 *
 * Built only from SHAs, PR numbers, check names (code spans), validated logins, validated
 * provenance, counts and fixed words: never a PR title, a PR body, a commit message or a file path
 * of the culprit. The one exception is the guard comment's list of conflicting paths (§10), which
 * are code spans. Mentions appear only in the revert PR body (D12).
 */
import { codeSpan } from "../core/markdown.js";
import type { RiskClass } from "../policy/schema.js";
import type { AutoMergeReason, NeedsHumanReason } from "./revert-plan.js";

export const MAX_REVERT_BODY_CHARS = 4_000;
export const TRAILER = "Graft-Agent: graft-guard";
const MAX_NAMES = 5;
const NAME_CHARS = 80;
const MAX_PATHS_LISTED = 20;
const PATH_CHARS = 200;

/** D11: a GitHub login that may be mentioned. */
export const MENTION_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const short = (sha: string): string => `\`${sha.slice(0, 7)}\``;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 hours", "1 hour", "90 minutes", "45 seconds". */
export function duration(seconds: number): string {
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

export type Confirmation =
  | { reason: "next_commit"; nextSha: string }
  | { reason: "window"; windowSeconds: number };

export type AutoMergeView =
  | { on: true; risk?: RiskClass | undefined }
  | { on: false; reason: AutoMergeReason | "unavailable" };

/** Why auto-merge is off, one fixed phrase per reason. */
export function autoMergeOffText(reason: AutoMergeReason | "unavailable"): string {
  switch (reason) {
    case "opened":
      return "the revert pull request was not opened";
    case "not_configured":
      return "`guard.auto_merge_reverts` is not set in graft.yaml at the last green commit";
    case "policy_invalid":
      return "graft.yaml at the last green commit is invalid";
    case "card_missing":
      return "the merged pull request has no intent card for its final head";
    case "risk_not_listed":
      return "its risk class is not listed in `guard.auto_merge_reverts`";
    case "sensitive":
      return "reverts of sensitive changes are never auto-merged";
    case "break_glass":
      return "the culprit was merged under break-glass";
    case "policy_file":
      return "the revert changes graft.yaml";
    case "repo_setting_off":
      return "the repository does not allow auto-merge";
    case "unavailable":
      return "GitHub did not enable it";
  }
}

// ---------------------------------------------------------------------------------------------
// The revert commit and pull request (§8)
// ---------------------------------------------------------------------------------------------

/** A branch name kept as it is in the commit message only when it is plain. */
const plainBranch = (b: string): string =>
  /^[A-Za-z0-9._/-]{1,100}$/.test(b) ? b : "the default branch";

export function revertTitle(prNumber: number): string {
  return `Revert #${prNumber} (Graft guard)`;
}

export function revertCommitMessage(i: {
  prNumber: number;
  branch: string;
  failingSha: string;
  restoredTo: string;
  paths: number;
}): string {
  return [
    revertTitle(i.prNumber),
    "",
    `CI went red on ${plainBranch(i.branch)} at ${i.failingSha.slice(0, 7)} after pull request #${i.prNumber} was merged.`,
    `This restores the ${plural(i.paths, "path")} #${i.prNumber} changed to their state at ${i.restoredTo.slice(0, 7)}.`,
    "",
    TRAILER,
  ].join("\n");
}

export interface Person {
  login: string;
  type: string;
}

/** `@login` for a valid login, else a code span (never an `@` outside one). */
export function mention(login: string): string {
  return MENTION_RE.test(login) ? `@${login}` : codeSpan(login, 60);
}

/** D11: the culprit's author, or for a bot author the user who merged it. */
export function authorText(author: Person | null, mergedBy: Person | null): string {
  if (author === null) return "unknown";
  if (author.type === "User") return mention(author.login);
  const who = codeSpan(author.login, 60);
  if (mergedBy !== null && mergedBy.type === "User")
    return `${who}, merged by ${mention(mergedBy.login)}`;
  return who;
}

/** D11: `#N` for a same-repository reference, any other task value as a code span. */
export function taskText(task: string): string {
  return /^#\d{1,9}$/.test(task) ? task : codeSpan(task, 128);
}

/** A session URL Graft may render as a link (step 2 validated it; this re-checks the shape). */
export function safeSessionUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length > 500) return null;
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~:/?#!$&'+,;=%-]*)?$/.test(url)) {
    return null;
  }
  return url;
}

export interface RevertBodyInput {
  prNumber: number;
  branch: string;
  failingSha: string;
  lastGreenSha: string;
  lastGreenIsParent: boolean;
  restoredTo: string;
  paths: number;
  /** In event order; `htmlUrl` already passed the guard's `safeHtmlUrl`. */
  checks: readonly { name: string; htmlUrl: string | null }[];
  confirmation: Confirmation;
  author: Person | null;
  mergedBy: Person | null;
  task: string | null;
  sessionUrl: string | null;
  autoMerge: AutoMergeView;
}

function failingLine(checks: RevertBodyInput["checks"]): string {
  const names = checks.slice(0, MAX_NAMES).map((c) => codeSpan(c.name, NAME_CHARS));
  const more = checks.length - MAX_NAMES;
  const link = checks.find((c) => c.htmlUrl !== null)?.htmlUrl ?? null;
  return `- Failing: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}${
    link === null ? "" : ` ([details](${link}))`
  }`;
}

function confirmedText(c: Confirmation): string {
  return c.reason === "next_commit"
    ? `the next commit ${short(c.nextSha)} is also red`
    : `still red after ${duration(c.windowSeconds)}`;
}

export function revertBody(i: RevertBodyInput): string {
  const first = i.checks[0]?.name ?? "unknown";
  const green = i.lastGreenIsParent
    ? `It was green at ${short(i.lastGreenSha)}, the commit before,`
    : `It was last green at ${short(i.lastGreenSha)},`;
  const who = [`Author: ${authorText(i.author, i.mergedBy)}`];
  if (i.task !== null) who.push(`Task: ${taskText(i.task)}`);
  const session = safeSessionUrl(i.sessionUrl);
  if (session !== null) who.push(`[agent session](${session})`);
  const autoMerge = i.autoMerge.on
    ? i.autoMerge.risk === undefined
      ? "on (allowed by `guard.auto_merge_reverts`)"
      : `on (risk \`${i.autoMerge.risk}\`, allowed by \`guard.auto_merge_reverts\`)`
    : `off: ${autoMergeOffText(i.autoMerge.reason)}`;
  const body = [
    `Graft's post-merge guard opened this pull request to revert #${i.prNumber}.`,
    "",
    `CI check ${codeSpan(first, NAME_CHARS)} went red on ${codeSpan(i.branch, 100)} at ${short(i.failingSha)} after #${i.prNumber} was merged. ${green} and the failure was confirmed (${confirmedText(i.confirmation)}).`,
    "",
    failingLine(i.checks),
    `- Reverts: ${plural(i.paths, "path")}, restored to ${short(i.restoredTo)}`,
    `- ${who.join(" · ")}`,
    `- Auto-merge: ${autoMerge}`,
    "",
    `Branch protection and required checks decide whether this merges. Close it to keep #${i.prNumber}; fix forward instead.`,
    "",
    TRAILER,
  ].join("\n");
  if (body.length > MAX_REVERT_BODY_CHARS) {
    throw new Error("revert body would exceed 4,000 characters");
  }
  return body;
}

// ---------------------------------------------------------------------------------------------
// The guard comment's revert section (§10)
// ---------------------------------------------------------------------------------------------

export const STEP4_PARAGRAPH =
  "Graft would open a pull request reverting this merge. Fix forward or revert to clear it.";
export const REPORT_LINE = "Graft mode: report. Graft opens nothing; this is what it would do.";
export const ENFORCE_LINE = "Graft mode: enforce.";

export type SkipReason =
  | "confirmation_off"
  | "revert_of_revert"
  | "already_reverted"
  | "already_green"
  | "already_opened"
  | "cap_reached"
  | "filtered_at_baseline"
  | "revert_off";

export type RevertSection =
  /** D19 (`GRAFT_GUARD_REVERT=off`): the step 4 comment, report wording. */
  | { kind: "step4" }
  | { kind: "planned"; paths: number; restoredTo: string; autoMerge: AutoMergeView }
  | { kind: "opened"; prNumber: number; autoMerge: AutoMergeView }
  | {
      kind: "needs_human";
      reason: NeedsHumanReason;
      branch: string;
      /** The conflicting paths when known; otherwise only their number is shown. */
      conflicts: readonly string[] | null;
      conflictCount: number;
    }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "error"; errorClass: string; prNumber: number | null };

export interface ModeView {
  effective: "report" | "enforce";
  requested: "report" | "enforce";
  reason: string;
  missing?: string | undefined;
}

/** §10's mode line. */
export function revertModeLine(m: ModeView): string {
  if (m.effective === "enforce") return ENFORCE_LINE;
  if (m.requested === "enforce") {
    const why = m.missing === undefined ? m.reason : `${m.reason} ${m.missing}`;
    return `Graft mode: report (enforce requested; ${why}). Graft opens nothing; this is what it would do.`;
  }
  return REPORT_LINE;
}

const NEEDS_HUMAN: Record<Exclude<NeedsHumanReason, "touched_later">, string> = {
  workflow_files: "it changed files under `.github/workflows/`, which Graft does not write",
  submodule: "it changed a submodule",
  type_change: "it turned a file into a directory, or a directory into a file",
  too_large: "the change is too large to revert automatically",
  history_incomplete: "Graft does not have this merge's full history on the default branch",
};

const SKIPPED: Record<SkipReason, string> = {
  confirmation_off:
    "confirmation is off on this Graft server (`GRAFT_GUARD_CONFIRM=off`), and an unconfirmed failure is never reverted",
  revert_of_revert: "this pull request is a Graft revert, and Graft never reverts a revert",
  already_reverted: "every path this merge changed is already back to its state before it",
  already_green: "the failing checks are green again on a later commit",
  already_opened: "a revert of this pull request was already opened",
  cap_reached: "the limit of open revert pull requests for this repository is reached",
  filtered_at_baseline: "the failing checks are not in `guard.checks` at the last green commit",
  revert_off: "revert pull requests are switched off on this Graft server",
};

function pathList(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_PATHS_LISTED).map((p) => codeSpan(p, PATH_CHARS));
  const more = paths.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.join(", ");
}

/** §10: the paragraph that replaces step 4's "Graft would open a pull request…". */
export function revertParagraph(s: RevertSection, mode: "report" | "enforce"): string {
  const not = mode === "enforce" ? "Graft did not open a revert" : "Graft would not open a revert";
  switch (s.kind) {
    case "step4":
      return STEP4_PARAGRAPH;
    case "planned": {
      const am = s.autoMerge.on
        ? "would enable auto-merge on it"
        : `would not enable auto-merge: ${autoMergeOffText(s.autoMerge.reason)}`;
      return `Graft would open a pull request reverting this merge (${plural(s.paths, "path")} restored to ${short(s.restoredTo)}) and ${am}.`;
    }
    case "opened":
      return `Graft opened #${s.prNumber} to revert this merge. Auto-merge: ${
        s.autoMerge.on ? "on" : `off: ${autoMergeOffText(s.autoMerge.reason)}`
      }.`;
    case "needs_human":
      if (s.reason === "touched_later") {
        const what =
          s.conflicts !== null && s.conflicts.length > 0
            ? `these paths changed again on ${codeSpan(s.branch, 100)} after this merge: ${pathList(s.conflicts)}`
            : `${plural(s.conflictCount, "path")} changed again on ${codeSpan(s.branch, 100)} after this merge`;
        return `${not}: ${what}. Revert by hand or fix forward.`;
      }
      return `${not}: ${NEEDS_HUMAN[s.reason]}. Revert by hand or fix forward.`;
    case "skipped":
      return `${not}: ${SKIPPED[s.reason]}.`;
    case "error":
      return s.prNumber === null
        ? `Graft could not open the revert (${s.errorClass}). An operator can see the event with \`graft guard list\`.`
        : `Graft opened #${s.prNumber} to revert this merge but could not finish (${s.errorClass}). An operator can see the event with \`graft guard list\`.`;
  }
}
