/**
 * The deterministic risk floor (D15, §9). Pure.
 *
 * Safety rule: the model can only RAISE a PR's risk class, never lower it. Fixed rules set a
 * minimum; `combineRisk` takes the maximum of every source.
 */
import { GlobBudget, globMatcher, type PathMatcher } from "../../core/glob.js";
import type { RiskClass } from "../../db/schema.js";
import { POLICY_FILE_GLOBS } from "../../policy/constants.js";
import type { ChangedFile } from "./inputs.js";

export type { PathMatcher, RiskClass };
export { globMatcher, POLICY_FILE_GLOBS };

export type FloorRuleId =
  | "ci_config"
  | "policy_file"
  | "dependency_manifest"
  | "infra"
  | "auth_secrets"
  | "migration"
  | "configured_path"
  | "test_deleted"
  | "test_shrunk"
  | "binary"
  | "size_large"
  | "size_huge"
  | "partial_view"
  | "listing_truncated"
  | "glob_budget"
  | "injection_marker";

export interface FloorReason {
  rule: FloorRuleId;
  floor: RiskClass;
  /** At most 5, in code-point order. */
  paths: string[];
  count: number;
}

export interface FloorConfig {
  extraSensitiveGlobs: readonly string[];
}

export type RaiseReason =
  | "writer"
  | "first_pass"
  | "verifier"
  | "verifier_disagrees"
  | "verifier_error"
  | "instructions_in_data"
  | "card_unavailable";

export const RISK_ORDER: Record<RiskClass, number> = { trivial: 0, logic: 1, sensitive: 2 };
export const maxRisk = (...classes: (RiskClass | null | undefined)[]): RiskClass => {
  let best: RiskClass = "trivial";
  for (const c of classes) if (c && RISK_ORDER[c] > RISK_ORDER[best]) best = c;
  return best;
};

/** Code-point order (not UTF-16 order). */
export function compareCodePoints(a: string, b: string): number {
  // No allocation (paths are sorted by this, up to 1,000 of them per rule): walk both strings.
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(j) as number;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  const rest = (s: string, k: number): number => {
    let n = 0;
    while (k < s.length) {
      k += (s.codePointAt(k) as number) > 0xffff ? 2 : 1;
      n++;
    }
    return n;
  };
  return rest(a, i) - rest(b, j);
}

// ---------------------------------------------------------------------------------------------
// Glob tables (§9)
// ---------------------------------------------------------------------------------------------

export const CI_CONFIG_GLOBS = [
  ".github/workflows/**",
  ".github/actions/**",
  ".github/CODEOWNERS",
  "CODEOWNERS",
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
  ".gitlab-ci.yml",
  ".circleci/**",
  "Jenkinsfile",
  "azure-pipelines.yml",
  ".buildkite/**",
  ".travis.yml",
  "bitbucket-pipelines.yml",
  ".pre-commit-config.yaml",
];
export const DEPENDENCY_MANIFEST_GLOBS = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".npmrc",
  ".yarnrc.yml",
  "bun.lock",
  "bun.lockb",
  "requirements*.txt",
  "constraints*.txt",
  "pyproject.toml",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "uv.lock",
  "setup.py",
  "setup.cfg",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
  "*.gemspec",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.lockfile",
  "composer.json",
  "composer.lock",
  "*.csproj",
  "packages.lock.json",
  "Directory.Packages.props",
  "mix.exs",
  "mix.lock",
  "Package.swift",
  "Package.resolved",
  "Podfile",
  "Podfile.lock",
  ".gitmodules",
];
export const INFRA_GLOBS = [
  "infra/**",
  "infrastructure/**",
  "terraform/**",
  "*.tf",
  "*.tfvars",
  "*.hcl",
  "k8s/**",
  "kubernetes/**",
  "helm/**",
  "charts/**",
  "deploy/**",
  "deployment/**",
  "ansible/**",
  "Dockerfile",
  "Dockerfile.*",
  "*.dockerfile",
  "docker-compose*.yml",
  "docker-compose*.yaml",
  "compose.yml",
  "compose.yaml",
  "Procfile",
  "fly.toml",
  "render.yaml",
  "vercel.json",
  "netlify.toml",
  "serverless.yml",
  "cdk.json",
];
export const AUTH_SECRETS_GLOBS = [
  "**/auth/**",
  "**/authn/**",
  "**/authz/**",
  "**/authentication/**",
  "**/authorization/**",
  "**/oauth/**",
  "**/security/**",
  "**/crypto/**",
  "**/iam/**",
  "**/permissions/**",
  "**/secrets/**",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*secret*",
  "*credential*",
  "*password*",
];
export const MIGRATION_GLOBS = [
  "**/migrations/**",
  "**/migrate/**",
  "**/alembic/**",
  "**/flyway/**",
  "**/liquibase/**",
  "*.sql",
  "schema.prisma",
  "schema.rb",
  "structure.sql",
];
export const TEST_GLOBS = [
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/spec/**",
  "*.test.*",
  "*.spec.*",
  "*_test.go",
  "test_*.py",
  "*_test.py",
  "*Test.java",
  "*Tests.java",
  "*Test.kt",
  "*Tests.cs",
  "*_spec.rb",
];
export const DOCS_GLOBS = [
  "*.md",
  "*.mdx",
  "*.rst",
  "*.adoc",
  "*.txt",
  "docs/**",
  "LICENSE*",
  "CHANGELOG*",
];
export const LOCKFILE_GLOBS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "gradle.lockfile",
  "packages.lock.json",
  "mix.lock",
  "Package.resolved",
  "Podfile.lock",
];
export const GENERATED_GLOBS = [
  "dist/**",
  "build/**",
  "out/**",
  "vendor/**",
  "node_modules/**",
  "third_party/**",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.pb.go",
  "*_pb2.py",
  "*.generated.*",
  "*.g.dart",
  "__snapshots__/**",
  "*.snap",
];
export const BINARY_EXTENSIONS = new Set(
  "png jpg jpeg gif webp ico bmp tif tiff psd pdf zip gz tgz bz2 xz 7z rar jar war ear class so dylib dll exe bin wasm woff woff2 ttf otf eot mp3 mp4 mov avi webm wav flac sqlite db pyc o a lib".split(
    " ",
  ),
);

export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)/i,
  /(ai|llm|model|automated|bot)\s+(reviewer|review|assistant|classifier)/i,
  /(classify|mark|rate|label)\s+(this|the)\s+(pr|pull\s+request|change|diff)\s+as/i,
  /risk[_\s]?class/i,
  /<\/?untrusted_data/i,
  /<\|?(system|im_start|im_end)\|?>/i,
  /you\s+are\s+(now\s+)?(an?\s+)?(ai|assistant|claude|chatgpt)/i,
  /instructions_in_data/i,
];

/** A file matches when its path OR its previous path matches. */
export function fileMatches(match: PathMatcher, f: Pick<ChangedFile, "path" | "previousPath">) {
  return match(f.path) || (f.previousPath !== null && match(f.previousPath));
}

export const isTestPath = (p: string): boolean => globMatcher(TEST_GLOBS)(p);

export type FileClass = "lockfile" | "binary" | "generated" | "no_patch_from_api" | "candidate";

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** T9.2 classification, in this order. */
export function classifyFile(f: ChangedFile): FileClass {
  if (globMatcher(LOCKFILE_GLOBS)(f.path)) return "lockfile";
  const dot = basename(f.path).lastIndexOf(".");
  const ext =
    dot >= 0
      ? basename(f.path)
          .slice(dot + 1)
          .toLowerCase()
      : "";
  if (
    BINARY_EXTENSIONS.has(ext) ||
    (f.patch === null &&
      f.additions === 0 &&
      f.deletions === 0 &&
      (f.status === "added" || f.status === "modified"))
  ) {
    return "binary";
  }
  if (globMatcher(GENERATED_GLOBS)(f.path)) return "generated";
  if (f.patch === null) return "no_patch_from_api";
  return "candidate";
}

const PATH_RULES: { rule: FloorRuleId; globs: readonly string[] }[] = [
  { rule: "ci_config", globs: CI_CONFIG_GLOBS },
  { rule: "policy_file", globs: POLICY_FILE_GLOBS },
  { rule: "dependency_manifest", globs: DEPENDENCY_MANIFEST_GLOBS },
  { rule: "infra", globs: INFRA_GLOBS },
  { rule: "auth_secrets", globs: AUTH_SECRETS_GLOBS },
  { rule: "migration", globs: MIGRATION_GLOBS },
];

/** True when any of R1-R7 matches the file (priority group 0 in T9). */
export function matchesPathRule(f: ChangedFile, config: FloorConfig, budget?: GlobBudget): boolean {
  const opts = { onLimit: true, ...(budget ? { budget } : {}) };
  for (const r of PATH_RULES) if (fileMatches(globMatcher(r.globs, opts), f)) return true;
  return fileMatches(globMatcher(config.extraSensitiveGlobs, opts), f);
}

// ---------------------------------------------------------------------------------------------
// computeRiskFloor
// ---------------------------------------------------------------------------------------------

export interface FloorInput {
  files: ChangedFile[];
  pr: { additions: number; deletions: number; changedFiles: number };
  listingTruncated: boolean;
  tooLarge: boolean;
  /** Files whose view is `truncated`, or `omitted` for a reason other than lockfile/binary. */
  partialPaths: string[];
  /** Title, body, issue title/body and the ADDED lines of the patches shown. */
  untrustedTexts: string[];
}

/** Format characters, and their visible `[U+XXXX]` form from `neutralizeUntrusted`, split words. */
const stripFormatChars = (t: string): string =>
  t.replace(/\p{Cf}/gu, "").replace(/\[U\+[0-9A-F]{4,6}\]/g, "");

export function computeRiskFloor(
  input: FloorInput,
  config: FloorConfig,
  /** Share one glob work budget with the policy evaluation of the same job. */
  sharedBudget?: GlobBudget,
): { floor: RiskClass; reasons: FloorReason[] } {
  const reasons: FloorReason[] = [];
  const add = (rule: FloorRuleId, floor: RiskClass, paths: string[]) => {
    const sorted = [...new Set(paths)].sort(compareCodePoints);
    reasons.push({ rule, floor, paths: sorted.slice(0, 5), count: sorted.length });
  };
  const pathsWhere = (pred: (f: ChangedFile) => boolean) =>
    input.files.filter(pred).map((f) => f.path);

  // One deterministic work budget for the whole floor (`configured_path` globs are author-controlled).
  const budget = sharedBudget ?? new GlobBudget();
  // R1-R6
  for (const { rule, globs } of PATH_RULES) {
    const m = globMatcher(globs, { onLimit: true, budget });
    const hit = pathsWhere((f) => fileMatches(m, f));
    if (hit.length > 0) add(rule, "sensitive", hit);
  }
  // R7
  {
    const m = globMatcher(config.extraSensitiveGlobs, { onLimit: true, budget });
    const hit = pathsWhere((f) => fileMatches(m, f));
    if (hit.length > 0) add("configured_path", "sensitive", hit);
  }
  // R8
  {
    // `test` assumes a path over the limits is a test file (a deletion tightens); `notTest` is the
    // opposite side, for the "no longer a test" term.
    const test = globMatcher(TEST_GLOBS, { onLimit: true, budget });
    const notTest = globMatcher(TEST_GLOBS, { budget });
    const hit = pathsWhere(
      (f) =>
        (f.status === "removed" && test(f.path)) ||
        (f.status === "renamed" &&
          f.previousPath !== null &&
          test(f.previousPath) &&
          !notTest(f.path)),
    );
    if (hit.length > 0) add("test_deleted", "sensitive", hit);
    // R9
    const shrunk = pathsWhere(
      (f) =>
        f.status === "modified" && test(f.path) && f.deletions > f.additions && f.deletions >= 10,
    );
    if (shrunk.length > 0) add("test_shrunk", "logic", shrunk);
  }
  // R10
  {
    const bin = pathsWhere(
      (f) =>
        classifyFile(f) === "binary" &&
        (f.status === "added" ||
          f.status === "modified" ||
          f.status === "renamed" ||
          f.status === "copied"),
    );
    if (bin.length > 0) add("binary", "logic", bin);
  }
  const lines = input.pr.additions + input.pr.deletions;
  // R11 / R12
  if (lines > 300 || input.pr.changedFiles > 15) add("size_large", "logic", []);
  if (lines > 1500 || input.pr.changedFiles > 50 || input.tooLarge)
    add("size_huge", "sensitive", []);
  // R13
  if (input.partialPaths.length > 0) add("partial_view", "logic", input.partialPaths);
  // R14
  if (input.listingTruncated) add("listing_truncated", "sensitive", []);
  // A spent glob budget means paths were not fully checked: the same strict answer, its own reason.
  if (budget.exhausted) add("glob_budget", "sensitive", []);
  // R15
  {
    const hits = input.untrustedTexts.filter((t) => {
      const clean = stripFormatChars(t);
      return INJECTION_PATTERNS.some((re) => re.test(clean));
    }).length;
    if (hits > 0)
      reasons.push({ rule: "injection_marker", floor: "logic", paths: [], count: hits });
  }

  return { floor: maxRisk(...reasons.map((r) => r.floor)), reasons };
}

// ---------------------------------------------------------------------------------------------
// combineRisk
// ---------------------------------------------------------------------------------------------

export interface CombineInput {
  floor: RiskClass;
  writer: RiskClass | null;
  firstPass: RiskClass | null;
  verifier: RiskClass | null;
  verifierStatus: "agree" | "disagree" | "error" | "skipped";
  instructionsInData: boolean;
  unavailable: boolean;
}

/** final = max(floor, writer, first pass, verifier, logic if disagree/error/injection/unavailable). */
export function combineRisk(o: CombineInput): { final: RiskClass; raisedBy: RaiseReason[] } {
  const sources: [RaiseReason, RiskClass | null][] = [
    ["writer", o.writer],
    ["first_pass", o.firstPass],
    ["verifier", o.verifier],
    ["verifier_disagrees", o.verifierStatus === "disagree" ? "logic" : null],
    ["verifier_error", o.verifierStatus === "error" ? "logic" : null],
    ["instructions_in_data", o.instructionsInData ? "logic" : null],
    ["card_unavailable", o.unavailable ? "logic" : null],
  ];
  const final = maxRisk(o.floor, ...sources.map(([, c]) => c));
  const raisedBy = sources
    .filter(([, c]) => c !== null && RISK_ORDER[c] > RISK_ORDER[o.floor])
    .map(([r]) => r);
  return { final, raisedBy };
}
