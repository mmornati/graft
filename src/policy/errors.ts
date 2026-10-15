/** The fixed error catalogue of `graft.yaml` (spec §8). Messages never repeat file text. */

export const POLICY_ERROR_CODES = [
  "file_too_large",
  "file_not_regular",
  "file_not_utf8",
  "yaml_syntax",
  "yaml_alias",
  "yaml_tag",
  "yaml_duplicate_key",
  "yaml_multiple_documents",
  "yaml_too_deep",
  "not_a_mapping",
  "version_missing",
  "version_unsupported",
  "unknown_key",
  "wrong_type",
  "too_many_rules",
  "too_many_globs",
  "too_many_items",
  "match_missing",
  "action_missing",
  "action_conflict",
  "approve_invalid",
  "block_invalid",
  "require_empty",
  "humans_invalid",
  "team_invalid",
  "risk_invalid",
  "author_invalid",
  "agent_invalid",
  "label_invalid",
  "size_invalid",
  "name_invalid",
  "name_duplicate",
  "default_invalid",
  "glob_invalid",
  "approve_untrusted_key",
  "approve_any_path",
  "too_many_errors",
] as const;
export type PolicyErrorCode = (typeof POLICY_ERROR_CODES)[number];

export interface PolicyError {
  code: PolicyErrorCode;
  /** e.g. "rules[2].match.paths[1]"; rule numbers AND list items 1-based. */
  location: string | null;
  line: number | null;
  column: number | null;
  /** unknown_key only: the key, at most 40 characters. */
  key?: string;
  /** A number for the message (size in bytes, glob reason), never file text. */
  detail?: number;
}

export const MAX_KEY_CHARS = 40;

export const GLOB_REASONS: Record<number, string> = {
  1: "empty or longer than 200 characters",
  2: "character not allowed (no ! { } ( ) | \\ ^ $)",
  3: ".. or empty segment",
  4: "more than 4 ** segments",
  5: "more than 3 * in one segment",
  6: "unbalanced [ ], or a / inside [ ]",
  7: "does not compile (a run of ***, ]+ or ** glued to other characters is not supported)",
  8: "too costly (more than 48 characters other than * in one segment, or 96 in all)",
  9: "mixes writing systems in one segment (lookalike letters?)",
  10: "contains a compatibility character (it folds to another character under Unicode normalization, as a fullwidth or mathematical letter, the Kelvin sign or a CJK compatibility ideograph does)",
};

/** A non-fatal finding of a valid file (step 6). Never holds the glob text. */
export interface PolicyWarning {
  code: "glob_non_ascii";
  location: string;
  line: number | null;
  column: number | null;
  /** `U+0435`, at most 5. */
  codePoints: string[];
}

export function policyWarningMessage(w: PolicyWarning): string {
  return `non-ASCII characters ${w.codePoints.join(", ")}`;
}

const MESSAGES: Record<
  Exclude<PolicyErrorCode, "unknown_key" | "glob_invalid" | "file_too_large">,
  string
> = {
  file_not_regular: "graft.yaml must be a regular file, not a directory, submodule or symlink.",
  file_not_utf8: "graft.yaml is not valid UTF-8.",
  yaml_syntax: "YAML syntax error.",
  yaml_alias: "Anchors and aliases (& and *) are not allowed.",
  yaml_tag: "Tags (! and !!) are not allowed.",
  yaml_duplicate_key: "This key appears twice in the same mapping.",
  yaml_multiple_documents: "graft.yaml must contain exactly one YAML document.",
  yaml_too_deep: "Nesting is deeper than 16 levels.",
  not_a_mapping: "The top level must be a mapping with version and rules.",
  version_missing: "version is required; use version: 1.",
  version_unsupported: "Only version 1 is supported.",
  wrong_type: "Wrong type for this key; see the graft.yaml reference.",
  too_many_rules: "More than 200 rules.",
  too_many_globs: "More than 500 globs in the file.",
  too_many_items: "This list is longer than allowed.",
  match_missing: "Each rule needs a non-empty match.",
  action_missing: "Each rule needs one action: approve: auto, require or block: true.",
  action_conflict: "A rule can have only one of approve, require and block.",
  approve_invalid: "approve must be auto.",
  block_invalid: "block must be true.",
  require_empty: "require needs humans, team or both.",
  humans_invalid: "humans must be an integer from 1 to 10.",
  team_invalid: "A team is a slug such as security (no @ and no org/).",
  risk_invalid: "risk must be trivial, logic or sensitive.",
  author_invalid: "author must be agent or human.",
  agent_invalid: "An agent name must match the Graft-Agent trailer rule.",
  label_invalid: "A label must be 1 to 50 characters without control characters.",
  size_invalid:
    "size needs min_lines, max_lines, min_files or max_files (integers 0 to 1,000,000, min not above max).",
  name_invalid: "A rule name is 1 to 80 letters, digits, spaces, or _ . : - characters.",
  name_duplicate: "Two rules have the same name.",
  default_invalid: "default must be require: { humans, team }.",
  approve_untrusted_key:
    "approve: auto cannot use author, agent or labels: the pull request author controls them. Use them in require or block rules.",
  approve_any_path:
    "approve: auto cannot use paths, which matches when any file matches. Use only_paths.",
  too_many_errors: "More than 50 errors; fix these first.",
};

const KEY_PLACEHOLDER = "KEYPLACEHOLDERZZ";

/** The §8 message. `renderKey` formats the one piece of file text a message may hold. */
export function policyErrorMessage(
  e: PolicyError,
  renderKey: (key: string) => string = (k) => `\`${k}\``,
): string {
  switch (e.code) {
    case "file_too_large":
      return `graft.yaml is ${e.detail ?? 0} bytes; the limit is 32,768.`;
    case "unknown_key":
      return `Unknown key ${renderKey((e.key ?? "").slice(0, MAX_KEY_CHARS))}.`;
    case "glob_invalid":
      return `Invalid glob: ${GLOB_REASONS[e.detail ?? 7] ?? GLOB_REASONS[7]}.`;
    default:
      return MESSAGES[e.code];
  }
}

/** Plain text: `{location}: {message} ({code})`, prefixed with `line L, column C, ` when known. */
export function formatPolicyError(e: PolicyError): string {
  return formatWith(e, (k) => `\`${k}\``);
}

function formatWith(e: PolicyError, renderKey: (key: string) => string): string {
  const pos = e.line !== null ? `line ${e.line}, column ${e.column ?? 1}, ` : "";
  const loc = e.location !== null && e.location !== "" ? `${e.location}: ` : "";
  return `${pos}${loc}${policyErrorMessage(e, renderKey)} (${e.code})`;
}

/**
 * The plain text with a placeholder where the key goes, so a renderer can escape the rest as
 * prose and splice the key in through its own code-span helper.
 */
export function formatPolicyErrorParts(e: PolicyError): { text: string; placeholder: string } {
  return { text: formatWith(e, () => KEY_PLACEHOLDER), placeholder: KEY_PLACEHOLDER };
}
