/** Where the policy lives and the limits that bound parsing (spec §6.3). */
export const POLICY_PATH = "graft.yaml";

/** Files that make up "the policy" for the trust rule (D5): a PR that touches them is flagged. */
export const POLICY_FILE_GLOBS = ["/graft.yaml", "/graft.yml", "/.graft/**"];

export const LIMITS = {
  fileBytes: 32_768,
  flowDepth: 16,
  rules: 200,
  globs: 500,
  errors: 50,
  sensitivePaths: 50,
  matchGlobs: 50,
  agents: 20,
  labels: 20,
  teams: 10,
  /** Phase 1 step 4: `guard.checks`. */
  guardChecks: 50,
  globChars: 200,
  /** Characters other than `*` in one glob segment, and in the whole glob (cost cap, review 2). */
  globSegmentChars: 48,
  globTotalChars: 96,
  globRegexChars: 2_000,
  sizeMax: 1_000_000,
} as const;
