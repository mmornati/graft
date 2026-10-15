# Phase 0, Step 5: Policy engine, report-only

Spec for the developer agent. Implement exactly this. Where this spec is silent, choose the simplest option and record it in README §7 ("Step 5 deviations and additions"). The [Phase 0 README](README.md) constraints are binding: offline build and test, Postgres from `docker compose`, **no stored code, diffs or file contents**, pnpm, Node 24, strict TypeScript. The code as it is after step 4 is described in the repo [README](../../README.md) §5 and §7; where this spec and the README disagree on an existing interface, the README wins. `src/modules/intent/job.ts` and `src/modules/provenance/job.ts` are the models for the job in this step.

Binding rules from earlier steps:
- **Safety rule** (development plan): the model can only raise a PR's risk class. Fixed rules set a minimum, and the policy's sensitive paths are one of those rules.
- **Payloads are triggers** (README §5, "Webhook replay"): handlers validate the payload and enqueue a job. Jobs write only from API data or from data Graft computed.
- **Lock discipline** (README §5): no slow work inside `withChangeLock`. Compute first, then lock, re-check freshness and publish.
- **Spec fix 1** (development plan): a passing `graft/policy` check is not a human approval. Pilots drop required reviewers from branch protection **in Phase 1 only**. In Phase 0 the check always concludes `neutral` and decides nothing.

## 1. Goal

For every open pull request in an installed repository, Graft reads the repository's `graft.yaml` **from the base branch**, evaluates it against what Graft knows about the PR, and reports what it **would** do:

- **Format.** `graft.yaml` version 1: a zod schema, a committed JSON Schema for editors, and a fixed error catalogue (§7, §8).
- **Trust.** The policy comes from the base branch, never from the PR head. A PR that edits `graft.yaml` is flagged, its edits are ignored, and it can never be would-approved. A missing, invalid, oversized, symlinked or alias-bombed file fails safe: Graft reports it and never would-approve anything (D3 to D6).
- **Evaluation.** A pure `evaluatePolicy(policy, facts)` returns `would_approve`, `would_require {humans, teams}` or `would_block`, with every matched rule and why (§9).
- **Output.** A `graft/policy` check run that **always concludes `neutral`**, and a `policy` section in the managed PR comment (§10).
- **Storage.** One `policy_verdicts` row per (change, head SHA, policy file SHA). It holds no file contents beyond the parsed policy's hash (§11).
- **Feeding step 3.** `sensitive_paths` from the base-branch `graft.yaml` raise the intent risk floor through the `intentRepoSettings` hook, cached by base SHA (T9).
- **Tooling.** `pnpm graft policy check <file>`, plus a GitHub Action snippet, so teams can lint `graft.yaml` in CI (T12).
- **Step 4 follow-ups.** The review 2 minors and the nit for `src/eval/redact.ts` (T14).

## 2. Out of scope

Do not create stub code for any of these.

- Enforcement: a `success`, `failure` or `action_required` conclusion, making `graft/policy` required, and changing branch protection (Phase 1).
- Checking team membership. It needs the `members: read` permission and comes in Phase 1. Phase 0 shows the required teams and counts approvals from anyone.
- Dismissing stale approvals, a break-glass label, and an audit log (Phase 1).
- MCP `get_policy` (Phase 1).
- Per-repository LLM budgets from `graft.yaml`. `dailyTokenBudget` stays the config value.
- Linting the PR's own `graft.yaml` in the check run. The CLI and the Action snippet cover that.
- Reading `graft.yml` or a `.graft/` directory. They are flagged as policy files (D5) but never read.
- A `policy explain` CLI that evaluates sample facts.
- Re-running intent cards when the base `graft.yaml` changes. The policy engine applies `sensitive_paths` itself (D12), and the card catches up on the next PR event.

## 3. Decisions

| # | Area | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | Layout | Three parts. **`src/policy/`** is a library with no imports from `src/modules`: schema, safe YAML parse, glob checks, the pure evaluator, the GitHub loader and its cache. **`src/modules/policy/`** holds the handlers, jobs, facts, rendering and store. **`src/bin/graft.ts`** is the CLI. | The intent hook (`modules/intent`), the policy module (which imports `modules/intent` and `modules/provenance`) and the CLI all need the parser. A library avoids an import cycle between modules. |
| D2 | Glob semantics | Move `normalizeGlob` and `globMatcher` from `risk-floor.ts` to `src/core/glob.ts` (unchanged behaviour; `risk-floor.ts` re-exports `globMatcher`) and add `{ nocase }`. A glob without `/` matches at any depth, and a leading `/` anchors it at the root. Matching uses `dot: true`. **Tightening matches are case-insensitive** (`paths`, `sensitive_paths`, as in the floor). **Loosening matches are case-sensitive** (`only_paths`). | One implementation for the floor, `GRAFT_INTENT_SENSITIVE_PATHS` and `graft.yaml`. A broad match may only make the verdict stricter. |
| D3 | Which commit | Policy commit = the commit `heads/<pull.base.ref>` points to when the job runs (`git.getRef`). Read `graft.yaml` at that SHA with `repos.getContent`. **Never** read the head ref, the head SHA, or `refs/pull/*`. The intent hook keeps the PR's `pull.base.sha` (T9). | GitHub does not advance `pull.base.sha` when the base branch moves, so a policy pushed to `main` would never reach open PRs. The tip and `base.sha` are both base-branch commits, so the trust level is the same. |
| D4 | Fail safe | A missing file gives the state `missing` and outcome `no_policy`. A file that cannot be used gives `invalid` and outcome `policy_invalid`. Neither state is ever `would_approve`, and both are published, not thrown. Only transient GitHub errors (429, 5xx, network) throw, through `toJobError`. | Reviewers must see that the policy is broken. A bad file can never widen auto-approval. |
| D5 | PR edits the policy | A PR whose changed paths (new or previous names) match `POLICY_FILE_GLOBS` (`/graft.yaml`, `/graft.yml`, `/.graft/**`, moved to `src/policy/constants.ts` and re-exported by `risk-floor.ts`) sets `policyFileChanged`. Its version is never read. The effective risk is `sensitive`, and the built-in rule `policy_file_changed` turns `would_approve` into `would_require 1 human`. | A PR must not loosen the policy that judges it. The floor already makes these paths `sensitive` (R2); this makes it explicit in the policy too. |
| D6 | YAML safety | `yaml` 2.x. The file is capped at 32,768 bytes, checked from the API's `size` before decoding and again after. Strict UTF-8 is required and a BOM is stripped. Flow nesting of more than 16 is rejected by a pre-scan. Parsing uses YAML 1.2 `core` schema, `uniqueKeys: true`, `merge: false` and `maxAliasCount: 0` as a backstop. **Any anchor or alias** is rejected (`yaml_alias`), and so is any tag outside the core set (`yaml_tag`), more than one document, and any parser error or warning. `toJS` runs only after these checks. | No legitimate policy needs anchors. Rejecting them outright removes billion-laughs bombs entirely, and the limits bound parse time and memory. |
| D7 | Symlinks and non-files | The `getContent` response must be an object with `type === "file"`, `path === "graft.yaml"` and `encoding === "base64"`. GitHub follows a symlink to an in-repo file and returns the target's `path`, so a different `path` means a symlink. An array (directory), `submodule` or `symlink` gives `file_not_regular`. The CLI applies the same rule with `lstat`. | The answer is the same whether or not GitHub follows the link. |
| D8 | Rule combination | **All** matching rules apply. **Block wins.** Otherwise any matching `require` wins over `approve`. `would_approve` needs at least one matching approve rule and no matching require or block rule. When nothing matches, `default` applies. | This is deterministic and order-independent, and adding a rule can only add constraints. First-match semantics would make rule order a security property. |
| D9 | Requirements | Each matching `require` rule is a constraint "at least *n* approvals from members of team set *T*", where *T* is any-of and empty means anyone. Constraints are **conjunctive**: all must hold, and one approval may satisfy several. Constraints with the same team set merge by `max(n)`. The displayed total is `humans = max(n)`, the lower bound when overlap is possible. | It matches how reviewers think ("2 people, one of them from security") without summing, which over-counts. |
| D10 | Author-controlled keys | `author`, `agent` and `labels` are controlled by whoever writes the PR (trailers can be forged, and anyone with triage access can add labels). They are **not allowed in `approve: auto` rules** (`approve_untrusted_key`). `approve: auto` may use only `risk`, `only_paths` and `size`, and may not use `paths` (`approve_any_path`), because `paths` is any-of. | A PR author must not be able to buy auto-approval with a trailer or a label. These keys can only tighten. |
| D11 | Unknown facts | **An unknown fact never loosens.** In a tightening rule (`require` or `block`), a condition on an unknown fact counts as matched and is marked `uncertain`. In an approve rule, a condition must hold for **every** possible value. The unknown facts are: risk while the card is pending or unavailable (possible set `{c ≥ lower bound}`), author while provenance is pending, an agent name that is absent, and paths when the file listing is incomplete. | It is conservative by construction, and it is easy to test because each key has two evaluation modes. |
| D12 | Effective risk | `risk.value` comes from the displayed intent card for the current head when its status is `ok` (final), from that card's `risk_class` when it is `unavailable` (not final), and otherwise from `max(computeRiskFloor(paths, sizes), logic)` (not final, `card_pending`). The evaluator then raises it to `sensitive` when a changed path matches `sensitive_paths` or the policy-file globs. | The card may predate a `sensitive_paths` change. Applying the globs again here keeps the verdict consistent with the policy it reports. |
| D13 | Approvals | `pulls.listReviews` (at most 3 pages of 100). Per user, the latest review in `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED` counts; `COMMENTED` and `PENDING` are ignored. Approvals are `current` when `commit_id === head`, otherwise `stale`. Bots, null users and the PR author are excluded. The count is **shown**, but it never changes the Phase 0 outcome. | Pilots can compare "would require" with what actually happened. Team checks come in Phase 1. |
| D14 | Events | **Add the `pull_request_review` and `push` events** to the manifest. There is no new permission: reviews are covered by `pull_requests` (already `write`) and push by `contents: read`. `pull_request.labeled` and `unlabeled` are already delivered by the subscribed `pull_request` event. | Without review events the approval count is stale until the next push. Without push events a `graft.yaml` change on `main` never reaches open PRs. Both are needed in Phase 1 anyway. |
| D15 | Cross-module triggers | New `src/core/signals.ts`. `JobContext.signals.emit(signal, ctx)` calls the listeners collected by the registry from module `signalListeners` exports. The intent job emits `intent_published` and the provenance job emits `provenance_published` after a successful publish (outside the lock). The policy module listens and enqueues `policy.evaluate`. | The policy module imports intent and provenance, so they cannot import it back. A listener list keeps the dependency one-way. |
| D16 | Ordering | `policy.evaluate` takes `factsReadAt = ctx.clock.now()` before it reads any fact. Inside the lock it publishes only if (a) the stored change head equals the live head, (b) the stored `pr_updated_at` is not newer than the live `updated_at`, and (c) no `policy_verdicts` row of the change has a `facts_read_at` later than this job's. It skips GitHub writes when the stored row for the same identity has the same `facts_hash` and was published. | Several triggers per push (the PR event, the card, provenance, reviews) race each other. The latest read wins, and repeats cost no writes. |
| D17 | Cache | An in-process LRU (256 entries) keyed by `${repositoryId}:${commitSha}` holds the `LoadedPolicy`: status, file SHA, parsed policy or error list, and hash. Commits are immutable, so entries never go stale. GitHub failures are not cached. `clearPolicyCache()` exists for tests. | The intent hook and every evaluation of a PR share one read per base commit. |
| D18 | Fan-out | `push` to a branch, where a commit's `added`, `modified` or `removed` lists `graft.yaml` (or the push is `forced`, or it lists 20 or more commits, where the payload may be truncated), enqueues `policy.fanout`. That job enqueues `policy.evaluate` for at most **100** open changes in the DB whose `base_ref` is that branch, newest `pr_updated_at` first, 10 every 5 s (`startAfterSeconds`). | The cost of a policy push stays bounded (about 800 API calls at worst). |
| D19 | Output safety | All file and PR strings go through `escapeProse` or `codeSpan` (`src/github/markdown.ts`), and never into table cells. **Team names are always rendered as code spans** (`` `@acme/security` ``), so the comment never notifies a team. | Untrusted text, and preventing accidental mass mentions. |
| D20 | Storage | Migration `0005_policy` replaces the unused `policy_verdicts` table from `0001` (§11). Rows hold rule **indices** and reason codes, PR paths (at most 5 per reason), counts, SHAs, logins and a `policy_hash`. They never hold globs, rule names, team slugs or YAML text. | "No file contents beyond the parsed policy hash". Everything else can be recomputed from the policy at `policy_file_sha`. Column names avoid I-DB-4's regex (no `blob`, no `code`). |

## 4. Files

New and changed files (✚ new, ✎ changed):

```
package.json, pnpm-lock.yaml              ✎ + yaml (2.x); script "graft": "tsx src/bin/graft.ts"
github/app-manifest.json                  ✎ default_events + pull_request_review, push (D14)
schema/graft.v1.schema.json               ✚ generated from the zod schema (T3)
docs/graft-yaml.md                        ✚ reference (T13)
docs/examples/graft.yaml                  ✚ the §6 example, valid
src/core/glob.ts                          ✚ normalizeGlob, globMatcher({ nocase }) (moved, D2)
src/core/signals.ts                       ✚ ChangeSignal, SignalListener, Signals, createSignals, noSignals
src/core/context.ts                       ✎ JobContext.signals
src/webhooks/registry.ts                  ✎ createRegistry({ signalListeners }); Registry.signalListeners
src/app/registry.ts                       ✎ + policy; collects signalListeners
src/bin/bootstrap.ts                      ✎ signals: createSignals(registry.signalListeners)
src/bin/graft.ts                          ✚ CLI (T12)
src/db/schema.ts                          ✎ PolicyVerdictsTable (new shape)
src/db/migrations/0005_policy.ts          ✚   + index.ts ✎
src/policy/
  constants.ts                            ✚ POLICY_PATH, POLICY_FILE_GLOBS, LIMITS
  errors.ts                               ✚ PolicyErrorCode, PolicyError, messages (§8)
  schema.ts                               ✚ zod schema, normalised Policy types
  globs.ts                                ✚ validateGlob (pure)
  parse.ts                                ✚ parsePolicyText(bytes) → ParseResult (pure)
  evaluate.ts                             ✚ evaluatePolicy, countApprovals (pure)
  json-schema.ts                          ✚ policyJsonSchema()
  load.ts                                 ✚ resolveBaseCommit, loadBasePolicy, cache
  index.ts                                ✚ re-exports
src/modules/intent/risk-floor.ts          ✎ import glob + POLICY_FILE_GLOBS from the new homes; re-export
src/modules/intent/settings.ts            ✎ the hook reads graft.yaml (T9)
src/modules/intent/job.ts                 ✎ passes octokit to the hook; emits intent_published
src/modules/intent/index.ts               ✎ + latestPublishedCard
src/modules/provenance/job.ts             ✎ emits provenance_published
src/modules/provenance/index.ts           ✎ + getChangeProvenance
src/modules/changes/store.ts              ✎ LivePull.labels
src/modules/policy/
  index.ts                                ✚ { webhookHandlers, jobs, signalListeners }
  handlers.ts                             ✚ policy.schedule, policy.review, policy.rerequest, policy.base-push
  facts.ts                                ✚ listChangedPaths, listReviews, buildFacts (pure part)
  job.ts                                  ✚ policy.evaluate, policy.fanout
  render.ts                               ✚ section + check output (pure)
  store.ts                                ✚ verdict rows
src/eval/redact.ts                        ✎ T14
scripts/generate-fixtures.ts              ✎ pull_request.labeled, pull_request_review.submitted/.dismissed, push
test/fixtures/webhooks/*.json             ✚ the four new fixtures
test/fixtures/policy/*.yaml               ✚ valid and invalid samples used by U-PY, U-PS and U-CLI
test/helpers/fake-github-api.ts           ✎ contents by ref, git ref, reviews, labels; request log has `ref`
test/helpers/github-builders.ts           ✎ makePull labels; makeReview; makeContent
test/helpers/app.ts, fake-queue.ts        ✎ signals in the test context
test/helpers/policy-scenario.ts           ✚ shared setup for I-POL
README.md, .env.example (unchanged unless needed), docs/phase-0/HUMAN-TODO.md   ✎
```

## 5. Interfaces

```ts
// src/core/signals.ts
export interface ChangeSignal {
  kind: "intent_published" | "provenance_published";
  installationId: number; repositoryId: number; owner: string; repo: string;
  prNumber: number; changeId: string; headSha: string;
  atMs: number;                                  // ctx.clock.now() at emit
}
export type SignalListener = (s: ChangeSignal, ctx: JobContext) => Promise<void>;
export interface Signals { emit(s: ChangeSignal, ctx: JobContext): Promise<void> }  // listeners in order; errors propagate
export function createSignals(listeners: readonly SignalListener[]): Signals;
export const noSignals: Signals;

// src/policy/schema.ts (normalised; YAML snake_case → camelCase)
export interface Policy {
  version: 1;
  sensitivePaths: string[];
  default: { humans: number; teams: string[] };   // from `default.require`; { humans: 1, teams: [] } when absent
  rules: PolicyRule[];
}
export interface PolicyRule {
  index: number;                                    // 1-based position in `rules`
  name: string | null;
  match: {
    risk?: RiskClass[]; paths?: string[]; onlyPaths?: string[];
    author?: "agent" | "human"; agents?: string[]; labels?: string[];
    size?: { minLines?: number; maxLines?: number; minFiles?: number; maxFiles?: number };
  };
  action: { kind: "approve" } | { kind: "require"; humans: number; teams: string[] } | { kind: "block" };
}

// src/policy/errors.ts
export interface PolicyError {
  code: PolicyErrorCode;
  location: string | null;   // e.g. "rules[2].match.paths[1]"; rule numbers AND list items 1-based
  line: number | null; column: number | null;
  key?: string;              // unknown_key only: the key, ≤ 40 chars
  detail?: number;           // a number for the message (size in bytes, count), never file text
}
export function formatPolicyError(e: PolicyError): string;    // the §8 message, plain text

// src/policy/parse.ts
export type ParseResult =
  | { ok: true; policy: Policy; hash: string }                 // sha256 hex of canonical JSON of `policy`
  | { ok: false; errors: PolicyError[] };                      // ≤ 50, sorted by line then column
export function parsePolicyText(bytes: Uint8Array): ParseResult;

// src/policy/load.ts
export type LoadedPolicy =
  | { status: "ok"; commitSha: string; fileSha: string; policy: Policy; hash: string }
  | { status: "missing"; commitSha: string; fileSha: null }
  | { status: "invalid"; commitSha: string; fileSha: string | null; errors: PolicyError[] };
export function resolveBaseCommit(octokit: GitHubClient, o: { owner: string; repo: string; baseRef: string }): Promise<string>;
export function loadBasePolicy(octokit: GitHubClient, o: { repositoryId: number; owner: string; repo: string; commitSha: string }): Promise<LoadedPolicy>;
export function clearPolicyCache(): void;

// src/policy/evaluate.ts
export interface PolicyFacts {
  files: { path: string; previousPath: string | null }[];
  listingComplete: boolean;
  size: { lines: number; files: number };                     // pull.additions + deletions; pull.changed_files
  risk: { value: RiskClass; final: boolean; source: "card" | "card_unavailable" | "card_pending" };
  author: { kind: "agent" | "human" | "unknown"; agent: string | null };
  labels: string[];
}
export type MatchKey = "risk" | "paths" | "only_paths" | "author" | "agent" | "labels" | "size";
export interface MatchReason { key: MatchKey; uncertain: boolean; paths: string[] /* ≤ 5, code-point order */; count: number }
export interface MatchedRule { index: number; action: "approve" | "require" | "block"; reasons: MatchReason[]; overridden: boolean }
export interface Constraint { humans: number; teams: string[]; rules: number[] }   // rules = indices, "default", or "policy_file_changed" as 0
export type PolicyVerdict =
  | { outcome: "would_approve"; matched: MatchedRule[]; effectiveRisk: EffectiveRisk; policyFileChanged: false }
  | { outcome: "would_require"; matched: MatchedRule[]; effectiveRisk: EffectiveRisk; policyFileChanged: boolean;
      humans: number; constraints: Constraint[]; usedDefault: boolean; builtIn: "policy_file_changed" | null }
  | { outcome: "would_block"; matched: MatchedRule[]; effectiveRisk: EffectiveRisk; policyFileChanged: boolean; blockedBy: number[] };
export interface EffectiveRisk { value: RiskClass; final: boolean; source: PolicyFacts["risk"]["source"]; raisedBy: ("sensitive_paths" | "policy_file")[] }
export function evaluatePolicy(policy: Policy, facts: PolicyFacts): PolicyVerdict;   // pure, total, deterministic

export interface ReviewLike { user: { id: number; login: string; type: string } | null; state: string; commit_id: string | null; submitted_at: string | null }
export interface ApprovalCount { current: number; stale: number; users: string[] /* current, ≤ 10, login order */; truncated: boolean }
export function countApprovals(reviews: ReviewLike[], o: { headSha: string; prAuthorLogin: string; truncated: boolean }): ApprovalCount;
```

`evaluatePolicy` does no I/O and never throws on valid input. It is the only place where the rule semantics live.

## 6. `graft.yaml` format (version 1)

The file is `graft.yaml` at the repository root, on the base branch. Full example (`docs/examples/graft.yaml`, which must pass `pnpm graft policy check`):

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/<org>/graft/main/schema/graft.v1.schema.json
version: 1

# Extra paths that set the intent risk floor to `sensitive` (step 3 rule R7).
sensitive_paths:
  - services/billing/**
  - "**/payments/**"

# Used when no rule matches. Must be a `require`. Defaults to 1 human.
default:
  require: { humans: 1 }

rules:
  - name: docs-only
    match: { risk: trivial, only_paths: ["docs/**", "*.md"] }
    approve: auto

  - name: trivial
    match: { risk: trivial }
    approve: auto

  - name: infra-and-auth
    match: { paths: ["infra/**", "**/auth/**"] }
    require: { humans: 1, team: security }

  - name: agent-sensitive
    match: { author: agent, risk: sensitive }
    require: { humans: 2 }

  - name: no-agent-secrets
    match: { paths: ["secrets/**"], author: agent }
    block: true

  - name: big-change
    match: { size: { min_lines: 1000 } }
    require: { humans: 2 }

  - name: preview-agent
    match: { agent: [codex-preview] }
    require: { humans: 1, team: [platform, security] }

  - name: hotfix
    match: { labels: [hotfix] }
    require: { humans: 1, team: oncall }
```

### 6.1 Keys

| Key | Type | Rule |
| --- | --- | --- |
| `version` | `1` | Required. Any other value: `version_unsupported`. |
| `sensitive_paths` | list of globs | Optional, at most 50. Tightening glob (case-insensitive). |
| `default` | `{ require: {...} }` | Optional. Only `require` is allowed (`default_invalid`). Default `{ humans: 1 }`. |
| `rules` | list of rules | Optional (default `[]`), at most 200. |
| rule `name` | string | Optional, `^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,79}$`. Unique within the file (`name_duplicate`). |
| rule `match` | mapping | Required and non-empty. Keys are combined with **AND**. |
| rule action | one of `approve: auto`, `require: {...}`, `block: true` | Exactly one (`action_missing`, `action_conflict`). |
| `match.risk` | class or list | `trivial`, `logic` or `sensitive`; a list is any-of; 1 to 3 distinct entries. |
| `match.paths` | list of globs | **Any-of**: true when at least one changed file (new or previous name) matches one glob. 1 to 50 entries. Tightening. Not allowed with `approve` (D10). |
| `match.only_paths` | list of globs | **All-of**: true when the listing is complete, there is at least one file, and every file's path **and** previous path match some glob. Case-sensitive. 1 to 50 entries. |
| `match.author` | `agent` or `human` | Provenance `author_kind`. Not allowed with `approve`. |
| `match.agent` | name or list | Case-insensitive exact match on the resolved `Graft-Agent`. The value rule is the step 2 agent rule `[A-Za-z0-9][A-Za-z0-9 ._:/@+()-]{0,99}`. At most 20. Implies `author: agent`. Not allowed with `approve`. |
| `match.labels` | list | Any-of, case-insensitive exact, 1 to 50 characters each with no control characters, at most 20. Not allowed with `approve`. |
| `match.size` | mapping | `min_lines`, `max_lines`, `min_files`, `max_files`: integers from 0 to 1,000,000, at least one of them, with min ≤ max. Inclusive bounds on `additions + deletions` and `changed_files`. |
| `require.humans` | integer | 1 to 10. Default 1. |
| `require.team` | slug or list | `^[a-z0-9][a-z0-9_-]{0,99}$` (a team slug in the repository owner's org, without `@` or `org/`). A list is any-of. At most 10. `require: {}` is invalid (`require_empty`). |
| `approve` | `auto` | Anything else: `approve_invalid`. |
| `block` | `true` | Anything else, `false` included: `block_invalid`. |

Unknown keys at any level give `unknown_key`.

### 6.2 Glob rules (`validateGlob`)

A glob is 1 to 200 characters made only of letters, digits (Unicode `\p{L}\p{N}`) and the characters `` _.-/*?[]@+=~#%, `` and space. That excludes:
- `!`, so no negation and no extglob;
- `{` and `}`, so no brace expansion or ranges;
- `(`, `)`, `|`, `\`, `^` and `$`.

There is no `..` segment and no empty segment except a single leading `/`. A glob has at most 4 `**` segments, at most 3 single `*` per segment, and balanced `[...]`. It must also compile with picomatch, and the regex source must be at most 2,000 characters. (Review 1: a run of three or more `*` and `]+` are rejected with detail 7, and matching is done by a non-backtracking segment matcher, not by picomatch regexes; paths over 1,024 characters or 128 segments answer the strict side. Review 6: `**` glued to other characters is rejected (detail 7); a class `[ab]` also matches its own text as picomatch does (unless its body holds - * ? + .). Review 2: a glob has at most 48 characters other than `*` per segment and 96 in all (detail 8), and no `/` inside `[...]` (detail 6); one `GlobBudget` per job (60,000,000 work units (35.0 M measured for the worst ordinary case, a 30-segment path matched by every glob, x 1.7; no pair cap; the matcher is a forward NFA with early exit and prefilters, so ordinary globs cost O(1) per path), shared by the risk floor and `evaluatePolicy`; every inner step costs 1 unit, classes are table lookups, paths are folded once; a 10 s wall clock is only a bug guard) covers the job, and the verdict carries `limits` (`path_too_long`, `budget_exhausted`) when it leaned on them. See README §7.) Each violation is `glob_invalid` with one `detail` reason (§8). Across the file there are at most 500 globs (`too_many_globs`).

### 6.3 Limits

| Limit | Value | Error |
| --- | --- | --- |
| File size | 32,768 bytes | `file_too_large` |
| Flow nesting (`[`, `{` outside quotes and comments) | 16 | `yaml_too_deep` |
| Rules | 200 | `too_many_rules` |
| Globs, whole file | 500 | `too_many_globs` |
| Errors reported | 50, then `too_many_errors` | |
| Aliases and anchors | 0 | `yaml_alias` |

## 7. Schema and JSON Schema

- **`src/policy/schema.ts`.** A zod 4 schema over the `toJS()` output. It uses `z.strictObject` everywhere, and `z.union([X, z.array(X)])` for "one or a list" (normalised to arrays). Every leaf sets `{ error: "<code>" }`, so each issue maps to a catalogue code; `unrecognized_keys` maps to `unknown_key`. The cross-field refinements are: exactly one action, approve-key restrictions (D10), size min ≤ max, unique names, glob validity, and limits. They run as a `superRefine` and emit the same codes.
- **Locations.** The parser maps a zod path to a 1-based `location` (`rules[2].match.paths[1]`). It maps that to a line and column through `doc.getIn(path, true).range` and a `LineCounter`. When there is no node, the location is that of the nearest existing parent.
- **`schema/graft.v1.schema.json`** is generated by `policyJsonSchema()` (`z.toJSONSchema`, draft 2020-12, the step 4 method), with `$id` `https://graft.dev/schema/graft.v1.schema.json` and `title` `graft.yaml v1`. The refinements that JSON Schema cannot express are listed in the top-level `description`. `pnpm graft policy schema --write` regenerates it, and U-PSCH-1 fails on drift.

## 8. Error catalogue

Messages are fixed text. They never repeat a value from the file, except the `key` of `unknown_key` (through `codeSpan`, at most 40 characters). The plain-text form is `{location}: {message} ({code})`, prefixed with `line L, column C, ` when known.

| Code | Message |
| --- | --- |
| `file_too_large` | `graft.yaml is {detail} bytes; the limit is 32,768.` |
| `file_not_regular` | `graft.yaml must be a regular file, not a directory, submodule or symlink.` |
| `file_not_utf8` | `graft.yaml is not valid UTF-8.` |
| `yaml_syntax` | `YAML syntax error.` |
| `yaml_alias` | `Anchors and aliases (& and *) are not allowed.` |
| `yaml_tag` | `Tags (! and !!) are not allowed.` |
| `yaml_duplicate_key` | `This key appears twice in the same mapping.` |
| `yaml_multiple_documents` | `graft.yaml must contain exactly one YAML document.` |
| `yaml_too_deep` | `Nesting is deeper than 16 levels.` |
| `not_a_mapping` | `The top level must be a mapping with version and rules.` |
| `version_missing` | `version is required; use version: 1.` |
| `version_unsupported` | `Only version 1 is supported.` |
| `unknown_key` | `Unknown key {key}.` |
| `wrong_type` | `Wrong type for this key; see the graft.yaml reference.` |
| `too_many_rules` | `More than 200 rules.` |
| `too_many_globs` | `More than 500 globs in the file.` |
| `too_many_items` | `This list is longer than allowed.` |
| `match_missing` | `Each rule needs a non-empty match.` |
| `action_missing` | `Each rule needs one action: approve: auto, require or block: true.` |
| `action_conflict` | `A rule can have only one of approve, require and block.` |
| `approve_invalid` | `approve must be auto.` |
| `block_invalid` | `block must be true.` |
| `require_empty` | `require needs humans, team or both.` |
| `humans_invalid` | `humans must be an integer from 1 to 10.` |
| `team_invalid` | `A team is a slug such as security (no @ and no org/).` |
| `risk_invalid` | `risk must be trivial, logic or sensitive.` |
| `author_invalid` | `author must be agent or human.` |
| `agent_invalid` | `An agent name must match the Graft-Agent trailer rule.` |
| `label_invalid` | `A label must be 1 to 50 characters without control characters.` |
| `size_invalid` | `size needs min_lines, max_lines, min_files or max_files (integers 0 to 1,000,000, min not above max).` |
| `name_invalid` | `A rule name is 1 to 80 letters, digits, spaces, or _ . : - characters.` |
| `name_duplicate` | `Two rules have the same name.` |
| `default_invalid` | `default must be require: { humans, team }.` |
| `glob_invalid` | `Invalid glob: {reason}.` where `detail` selects the reason: 1 `empty or longer than 200 characters`, 2 `character not allowed (no ! { } ( ) \| \\ ^ $)`, 3 `.. or empty segment`, 4 `more than 4 ** segments`, 5 `more than 3 * in one segment`, 6 `unbalanced [ ]`, 7 `does not compile` |
| `approve_untrusted_key` | `approve: auto cannot use author, agent or labels: the pull request author controls them. Use them in require or block rules.` |
| `approve_any_path` | `approve: auto cannot use paths, which matches when any file matches. Use only_paths.` |
| `too_many_errors` | `More than 50 errors; fix these first.` |

## 9. Semantics

### 9.1 Per-key evaluation

Let `L` be the effective risk lower bound: `max(facts.risk.value, sensitive if a changed path or previous path matches sensitive_paths (case-insensitive) or POLICY_FILE_GLOBS)`. The possible risk set is `P = {L}` when `facts.risk.final` or `L = sensitive`, and otherwise `P = {c : c ≥ L}`.

| Key | Tightening rule (`require`, `block`) | Approve rule |
| --- | --- | --- |
| `risk` | `rule.risk ∩ P ≠ ∅`; uncertain when `|P| > 1` | `P ⊆ rule.risk` |
| `paths` | Some file matches; when there is no match and `!listingComplete`, it matches as uncertain | not allowed |
| `only_paths` | Every file matches (case-sensitive), with at least one file and `listingComplete` | same |
| `author` | `kind === rule.author`; `unknown` matches as uncertain | not allowed |
| `agent` | `kind === "agent"` and the agent is in the list (case-insensitive); `kind` `unknown`, or `agent` null with `kind` `agent`, matches as uncertain; `human` does not match | not allowed |
| `labels` | Some PR label is in the list (case-insensitive) | not allowed |
| `size` | Inclusive bounds | same |

A rule matches when every key in its `match` matches. A rule is `uncertain` when any of its reasons is.

### 9.2 Combination (D8, D9)

1. Evaluate every rule in file order. `matched` lists every matching rule.
2. If any matched rule is `block`, the outcome is `would_block` and `blockedBy` lists those indices. The other matched rules are listed with `overridden: true`.
3. Else, if any matched rule is `require`, the outcome is `would_require`. The constraints are those rules' `{humans, teams}`, with equal team sets (sorted) merged by `max`, and `humans = max(n)`. Matched approve rules get `overridden: true`.
4. Else, if any matched rule is `approve`: when `policyFileChanged` **or the listing is incomplete (`!listingComplete`, review 1: the PR may change the policy file, D11)**, the outcome is `would_require` with the constraint `{humans: 1, teams: [], rules: [0]}` and `builtIn: "policy_file_changed"`, and the approve rules are overridden. Otherwise the outcome is `would_approve`.
5. Else the outcome is `would_require` with the `default` constraint (`rules: []`) and `usedDefault: true`. `builtIn` is `"policy_file_changed"` when that applies, so the note shows.
6. Constraints are ordered by team constraints in rule order, then the anyone constraint.

### 9.3 Worked examples (policy of §6; each one is a U-PE case)

| ID | Facts | Matched | Outcome |
| --- | --- | --- | --- |
| E1 | `docs/a.md`; card `ok` `trivial`; human | 1, 2 (approve) | `would_approve` |
| E2 | `src/x.ts`; card `ok` `trivial`; agent `claude-code` | 2 | `would_approve` |
| E3 | `infra/main.tf`; card `ok` `sensitive`; agent | 3 {1, security}, 4 {2} | `would_require`, humans 2, constraints `[{1,[security]},{2,[]}]` |
| E4 | `secrets/prod.env`; card `ok` `sensitive`; agent | 4, 5 | `would_block`, blockedBy `[5]`, 4 overridden |
| E5 | `src/x.ts`; card pending, floor `trivial` → value `logic`, not final; agent | 4 (risk uncertain: P = {logic, sensitive}); 2 does not match (P ⊄ {trivial}) | `would_require` 2, uncertain |
| E6 | `services/billing/pay.ts`; card `ok` `logic`; agent | `L` = sensitive (`sensitive_paths`) → 4 | `would_require` 2, `raisedBy: [sensitive_paths]` |
| E7 | `graft.yaml` (the PR deletes rule 5); card `ok` `trivial`; human | `L` = sensitive (`policy_file`); none match | `would_require` 1, `usedDefault`, `builtIn: policy_file_changed`, `policyFileChanged` |
| E8 | `secrets/x`; card `ok` `sensitive`; author `unknown` | 4, 5, 7 (all uncertain on author) | `would_block`, blockedBy `[5]`; 4 and 7 overridden |
| E9 | `src/x.ts`; card `ok` `trivial`; human; label `HotFix` | 2 (approve), 8 {1, oncall} | `would_require` 1 from oncall; 2 overridden |
| E10 | `src/x.ts`; card `ok` `logic`; agent with `agent: null` (bot account) | 7 (agent uncertain) | `would_require` 1 from platform or security |
| E11 | `docs/a.md`; card `ok` `trivial`; human; `listingComplete: false` | 2 (approve), 3 (paths uncertain: file list incomplete); 1 does not match | `would_require` 1 from security; 2 overridden |
| E12 | `Docs/A.md`; card `ok` `trivial`; human | 1 does not match (only_paths is case-sensitive); 2 matches | `would_approve` (via rule 2) |
| E13 | policy `{version: 1}` only; any facts | none | `would_require` 1, `usedDefault` |
| E14 | policy with only rule `{risk: [trivial, logic]} approve`; card pending, `L` = logic | 1 does not match (P = {logic, sensitive}) | `would_require` 1 (default) |

## 10. Output (lines shown literally)

### 10.1 Check run `graft/policy`

- `conclusion: "neutral"` **always**, for every outcome and every policy state. `status: "completed"`, `external_id: change.id`, no `actions`.
- `output.title` (at most 200 characters; longer titles are cut with `…`):
  - `would_approve` → `Would auto-approve`
  - `would_require` with one team constraint whose `n == humans` → `Would require {H} human{s} from {teams}`; otherwise `Would require {H} human{s}` plus ` ({n} from {teams}; …)` when there are team constraints. `{teams}` is `@{owner}/{slug}` joined with ` or `. A default with no team gets ` (default)`.
  - `would_block` → `Would block: rule {i}` or `Would block: rules {i}, {j}`
  - `policy_invalid` → `Policy invalid: no decision ({n} error{s})`
  - `no_policy` → `No graft.yaml on {baseRef}`, with `baseRef` cut to 100 characters
  - Append ` · risk provisional` when `!effectiveRisk.final` and the outcome is not `would_block`.
- `output.summary` = the section markdown (§10.2). `output.text` = the details list (§10.3).

Examples: `Would require 1 human from @acme/security`; `Would require 2 humans (1 from @acme/security)`; `Would require 1 human (default) · risk provisional`; `Would block: rule 5`.

### 10.2 Section `policy` (`renderPolicySection`)

`would_require` (E3, with one current approval and one stale):

```markdown
### Policy

**Would require 2 humans (1 from `@acme/security`)** · report only

- Rule 3 infra\-and\-auth: paths match `infra/main.tf`
- Rule 4 agent\-sensitive: risk `sensitive` (card), author agent `claude-code`

**Approvals so far:** 1 on this head (`alice`), 1 on an older commit. Team membership is not checked in Phase 0.

Policy `graft.yaml` on `main` at `a1b2c3d` · head `ec26c3e` · Graft only reports in Phase 0; it approves and blocks nothing.
```

Rules:
- The headline is the check title in bold, with team names as code spans (D19). Then ` · report only`.
- One bullet per matched rule, in index order: `- Rule {i}{ name}: {reasons joined ", "}`, with ` (overridden)` appended when overridden. The name goes through `escapeProse(…, 80)`. Reasons:
  - `risk `{v}` ({source text})`, where the source text is `card`, `card unavailable` or `rules; card pending`, plus `, raised by sensitive_paths` or `, raised by graft.yaml change`;
  - `paths match {first 3 codeSpan}{ and K more}`;
  - for `only_paths`: `all {n} paths match`;
  - `author {kind}`, plus `` `agent` `` when known;
  - `label {codeSpan}`;
  - `size {lines} lines, {files} files`.
  An uncertain reason is suffixed ` (unknown: {provenance pending | card pending | agent not reported | file list incomplete})`.
- When nothing matched: `- No rule matched; the default applies.`
- Blocks and notes go between the bullets and the approvals line, in this order:
  - When `policyFileChanged`:
    ```
    > [!IMPORTANT]
    > This pull request changes `graft.yaml`. Its version is ignored: the policy on `main` applies, and the change needs at least 1 human.
    ```
  - When `!effectiveRisk.final`:
    ```
    > [!NOTE]
    > The intent card for this head is not ready, so the risk used is at least `logic` and rules that depend on it are applied conservatively. Graft re-evaluates when the card is published.
    ```
- The approvals line is omitted for `would_approve` with zero approvals. Logins go through `codeSpan`. More than 10 logins gives `and K more`. `truncated` gives ` (first 300 reviews)`.
- Footer: `` Policy `graft.yaml` on `{baseRef}` at `{commit7}` · head `{head7}` · Graft only reports in Phase 0; it approves and blocks nothing. ``

`would_block` (E4): headline `**Would block: rule 5** · report only`. Bullets: rule 4 `(overridden)`, then rule 5.

`policy_invalid`:

```markdown
### Policy

**Policy invalid: no decision (2 errors)** · report only

`graft.yaml` on `main` at `a1b2c3d` cannot be used, so Graft would not auto-approve anything:

- line 12, column 9, rules\[2\].match.paths\[1\]: Invalid glob: .. or empty segment. (glob\_invalid)
- line 20, column 3, rules\[3\]: Unknown key `aprove`. (unknown\_key)

Fix the file on `main`, and check it locally with `pnpm graft policy check graft.yaml`.

Head `ec26c3e` · Graft only reports in Phase 0; it approves and blocks nothing.
```

At most 20 errors are listed, then `- and K more`. Each error line is `escapeProse(formatPolicyError(e), 300)`, except the unknown key, which is spliced in through `codeSpan`.

`no_policy`:

```markdown
### Policy

**No policy** · report only

There is no `graft.yaml` on `main` at `a1b2c3d`. Add one to report what Graft would require; see the graft.yaml reference in the Graft docs.

Head `ec26c3e` · Graft only reports in Phase 0; it approves and blocks nothing.
```

When the PR adds `graft.yaml`, `no_policy` also shows the `[!IMPORTANT]` block with the text `This pull request adds `graft.yaml`. It takes effect after merge; until then there is no policy.`

### 10.3 Check `output.text` (details)

```markdown
**Matched rules**

- Rule 3 infra\-and\-auth → require 1 from `@acme/security`: paths match `infra/main.tf`
- Rule 4 agent\-sensitive → require 2: risk `sensitive` (card), author agent `claude-code`

**Facts used**

- Risk `sensitive` from the card (final)
- Author agent `claude-code` (provenance for head `ec26c3e`)
- 1 file changed, 12 lines; file list complete
- Labels: none
- Policy file SHA `9f8e7d6`, policy hash `3c1a0b2e`

7 other rules did not match.
```

### 10.4 Managed comment

The step 2 shape is unchanged. `policy` renders after `intent` and `provenance` (`SECTION_ORDER`), and the other sections are preserved byte for byte.

## 11. Schema (migration `0005_policy`)

`up` drops the `0001` `policy_verdicts` (no code writes it) and creates:

```sql
CREATE TABLE policy_verdicts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id          uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  head_sha           text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  base_ref           text NOT NULL,
  policy_commit_sha  text NOT NULL CHECK (policy_commit_sha ~ '^[0-9a-f]{40}$'),
  policy_file_sha    text CHECK (policy_file_sha ~ '^[0-9a-f]{40}$'),      -- NULL: no file (missing, directory)
  policy_status      text NOT NULL CHECK (policy_status IN ('ok','missing','invalid')),
  policy_hash        text CHECK (policy_hash ~ '^[0-9a-f]{64}$'),           -- set iff policy_status = 'ok'
  mode               text NOT NULL DEFAULT 'report' CHECK (mode IN ('report','enforce')),
  outcome            text NOT NULL CHECK (outcome IN ('would_approve','would_require','would_block','no_policy','policy_invalid')),
  check_conclusion   text NOT NULL DEFAULT 'neutral' CHECK (check_conclusion IN ('neutral','success','failure','action_required')),
  risk_class         text CHECK (risk_class IN ('trivial','logic','sensitive')),
  risk_final         boolean NOT NULL DEFAULT false,
  risk_source        text CHECK (risk_source IN ('card','card_unavailable','card_pending')),
  author_kind        text CHECK (author_kind IN ('agent','human','unknown')),
  policy_file_changed boolean NOT NULL DEFAULT false,
  rules_matched      jsonb NOT NULL DEFAULT '[]',   -- MatchedRule[]: indices, actions, reason keys, PR paths ≤ 5
  required           jsonb NOT NULL DEFAULT '{}',   -- {humans, constraints:[{humans, teamCount, rules}], usedDefault, builtIn}
  approvals          jsonb NOT NULL DEFAULT '{}',   -- ApprovalCount
  errors             jsonb NOT NULL DEFAULT '[]',   -- PolicyError[] without `key`
  facts_hash         text NOT NULL CHECK (facts_hash ~ '^[0-9a-f]{64}$'),
  facts_read_at      timestamptz NOT NULL,
  check_run_id       bigint,
  published_at       timestamptz,
  evaluated_at       timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((policy_status = 'ok') = (policy_hash IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (change_id, head_sha, policy_file_sha)
);
CREATE INDEX policy_verdicts_change_idx ON policy_verdicts (change_id, facts_read_at DESC);
```

- `down` drops this table and restores the `0001` definition and index exactly.
- `facts_hash` = sha256 of canonical JSON of `{verdict, approvals, policyStatus, policyFileSha, policyHash, errors, headSha, baseRef, commitSha}`.
- `PolicyVerdictsTable` in `src/db/schema.ts` matches the table. `TABLE_NAMES` is unchanged (13).

## 12. Tasks

Each task has acceptance criteria (AC). Test IDs are in §13.

### T1. Dependencies and library verification

1. `pnpm add yaml` (2.x). Add the script `"graft": "tsx src/bin/graft.ts"`.
2. **Verify against `node_modules` before use, and record the version and every difference in README §7:**
   - in `yaml`: `parseDocument` and `parseAllDocuments`; `LineCounter`; the options `version`, `schema: "core"`, `uniqueKeys`, `merge`, `maxAliasCount`, `strict`, `prettyErrors`; `visit` with `isAlias` and `node.anchor`; how `!custom`, `!!binary` and `!!set` are reported (error, warning or tag); `doc.errors` and `doc.warnings` codes; `doc.getIn(path, true)` and `node.range`;
   - in Octokit: `git.getRef` (`ref: "heads/<branch>"`) and `repos.getContent` (object vs array response, `encoding: "none"` above 1 MB, symlink behaviour per the GitHub docs);
   - in `@octokit/webhooks`: the `pull_request_review` and `push` payload types.

AC: `pnpm install --frozen-lockfile` works. README §7 lists the `yaml` version and the findings.

### T2. Shared pieces: glob, constants, signals

1. Move `normalizeGlob` and `globMatcher` to `src/core/glob.ts` with an option `{ nocase?: boolean }` (default `true`). The cache key includes `nocase`. `risk-floor.ts` imports them and re-exports `globMatcher`; behaviour is unchanged.
2. Move `POLICY_FILE_GLOBS` to `src/policy/constants.ts`; `risk-floor.ts` imports and re-exports it.
3. `src/core/signals.ts` (§5). `JobContext.signals` is required. `createRegistry` takes `signalListeners` (default `[]`) and exposes them. `src/app/registry.ts` collects them from modules that export `signalListeners`. `bootstrap.ts` and `test/helpers/app.ts` build `createSignals(registry.signalListeners)`. Unit-test contexts may use `noSignals`.

AC: every existing test passes unchanged except for the added `signals` field. U-GLOB-1, U-SIG-1.

### T3. Schema, errors, JSON Schema (`src/policy/schema.ts`, `errors.ts`, `json-schema.ts`)

Implement §6, §7 and §8. Normalisation: lists are deduplicated (globs keep the first occurrence and file order); `team` and `agent` become arrays; a missing `default` becomes `{ humans: 1, teams: [] }`; and `require.humans` defaults to 1.

AC: U-PS-1 to U-PS-12, U-PSCH-1.

### T4. Safe parsing (`src/policy/parse.ts`, `globs.ts`)

Do these in order, and stop at the first failure of steps 1 to 4:
1. byte length ≤ 32,768;
2. strict UTF-8 decode (`new TextDecoder("utf-8", { fatal: true })`), then strip the BOM;
3. flow-depth pre-scan;
4. `parseAllDocuments`: exactly one document, with no `errors` and no `warnings`;
5. `visit`: any `Alias` node or `anchor` gives `yaml_alias`, and any explicit tag gives `yaml_tag` (all occurrences are reported, with lines);
6. `toJS({ maxAliasCount: 0 })`;
7. zod and the refinements;
8. hash.

The function is pure and never throws for any input bytes (U-PY-10 fuzz).

AC: U-PY-1 to U-PY-10, U-PG-1 to U-PG-6.

### T5. Evaluator (`src/policy/evaluate.ts`)

Implement §9 exactly, plus `countApprovals` (D13). Reasons hold at most 5 paths in code-point order, and `count` holds the total.

AC: U-PE-1 to U-PE-14 (= E1 to E14), U-PE-15 to U-PE-22, U-PA-1 to U-PA-5.

### T6. Loader and cache (`src/policy/load.ts`)

- `resolveBaseCommit`: `git.getRef({ ref: "heads/" + baseRef })` → `object.sha` (40-hex, or a programmer error). A 404 throws `PermanentJobError("base branch not found", "base_missing")`. Other errors go through `toJobError`.
- `loadBasePolicy`: check the cache, then call `getContent({ path: "graft.yaml", ref: commitSha })`.
  - A 404 gives `missing`.
  - An array gives `invalid`/`file_not_regular` with `fileSha: null`.
  - When `type` is not `"file"` or `path` is not `"graft.yaml"`, the result is `file_not_regular` with `fileSha: data.sha`.
  - `size > 32768`, or `encoding !== "base64"`, gives `file_too_large` (with `detail` = size).
  - Otherwise decode and call `parsePolicyText`.
  - Store the result in the cache (LRU of 256) and return it.
- Never log the content, the globs or the rule names. Log `{repositoryId, commitSha7, status, errors: n}`.

AC: U-LOAD-1 to U-LOAD-6.

### T7. Facts (`src/modules/policy/facts.ts`)

- `listChangedPaths(octokit, {owner, repo, prNumber, changedFiles})`: when `changedFiles > 1000`, return `{files: [], complete: false}` without a call. Otherwise call `pulls.listFiles` with 100 per page, at most 10 pages. Keep `filename`, `previous_filename`, `status`, `additions` and `deletions`, **and drop `patch` at once**. `complete` = `files.length === changedFiles`.
- `listReviews`: 100 per page, at most 3 pages, with `truncated`.
- `buildFacts` (pure):
  - **risk.** Use `latestPublishedCard(db, changeId)` (newly exported by intent) when its `head_sha` equals the live head: `ok` gives `{risk_class, final: true, "card"}`, and `unavailable` gives `{risk_class, final: false, "card_unavailable"}`. Otherwise use `{max(computeRiskFloor({files as ChangedFile with patch null, pr sizes, listingTruncated: !complete, tooLarge: changedFiles > 1000, partialPaths: [], untrustedTexts: []}, {extraSensitiveGlobs: config ∪ policy.sensitivePaths}).floor, "logic"), false, "card_pending"}`.
  - **author.** Use `getChangeProvenance` (newly exported by provenance) when its `head_sha` equals the live head: `{author_kind, agent}`. Otherwise `{unknown, null}`.
  - **labels.** `pull.labels[].name`. **size.** From `pull`.

AC: U-FACT-1 to U-FACT-4.

### T8. Rendering (`src/modules/policy/render.ts`, pure)

Implement §10 byte for byte. Every string from the file or the PR goes through `escapeProse` or `codeSpan`, and teams always through `codeSpan` (D19). Section ≤ `MAX_SECTION_CHARS`: when it is longer, keep the headline, the notes and the footer, cut the rule bullets, and add `- and K more rules`.

AC: U-PR-1 to U-PR-9.

### T9. The intent hook (`src/modules/intent/settings.ts`, `job.ts`)

- The signature becomes `intentRepoSettings(ctx: Pick<JobContext, "config" | "log">, target: IntentSettingsTarget, octokit: GitHubClient)`. `target.baseSha` must be a 40-hex SHA; the intent job passes `pull.base.sha`, or `await resolveBaseCommit(...)` when it is absent.
- `loadBasePolicy` at `baseSha`. On `ok`, `extraSensitiveGlobs = dedupe([...config.intentSensitivePaths, ...policy.sensitivePaths])`. On `missing` or `invalid`, use the config globs only, and log `policy_status` without throwing. Transient GitHub errors propagate, and the intent job maps them with `toJobError`.
- The cache is the D17 LRU, so the hook and the policy job share reads for the same commit.
- The intent job emits `intent_published` after `published` is true, with `atMs = ctx.clock.now().getTime()`. The provenance job emits `provenance_published` after the outcome `published`. Both emit outside the lock.

AC: I-POLH-1 to I-POLH-6. Existing I-INT tests pass (the fake API serves no `graft.yaml`, which gives `missing`).

### T10. Store (`src/modules/policy/store.ts`)

- `upsertVerdict(tx, row)` on `(change_id, head_sha, policy_file_sha)`.
- `maxFactsReadAt(tx, changeId)`.
- `findVerdict(tx, identity)`.
- `checkRunIdForHead(tx, changeId, headSha)`: any row of that head with a `check_run_id`.

### T11. Handlers and jobs (`handlers.ts`, `job.ts`, `index.ts`)

**Handlers** (payload = trigger; each parses with zod through `parsePayload`, checks `getActiveInstallation`, and enqueues):

| Handler | On | Job and `singletonKey` |
| --- | --- | --- |
| `policy.schedule` | `pull_request.opened, synchronize, reopened, edited, labeled, unlabeled` | `policy.evaluate`, `policy:pr:{repoId}:{pr}:{head}:{baseRef}:{updated_at}:{action}:{sha16(label?.name ?? "")}` |
| `policy.review` | `pull_request_review.submitted, dismissed` | `policy.evaluate`, `policy:review:{repoId}:{pr}:{review.id}:{action}` |
| `policy.rerequest` | `check_run.rerequested` with name `graft/policy` and our app id | `policy.evaluate`, `policy-rerun:{repoId}:{pr}:{floor(nowMs/60000)}` |
| `policy.base-push` | `push`: `ref` starts with `refs/heads/`, `deleted` false, `after` 40-hex non-zero, and (a commit lists `graft.yaml` in `added`/`modified`/`removed`, or `forced`, or `commits.length >= 20`) | `policy.fanout`, `policy-push:{repoId}:{ref}:{after}` |
| signal listener | `intent_published`, `provenance_published` | `policy.evaluate`, `policy:sig:{kind}:{changeId}:{headSha}:{atMs}` |

**`policy.evaluate`.** Data: `{installationId, repositoryId, owner, repo, prNumber, trigger: "pr" | "review" | "rerequested" | "intent" | "provenance" | "base_push", deliveryId?}`. Options: `retryLimit 5`, `retryDelaySeconds 30`, `retryBackoff true`, `expireInSeconds 120`. Steps:
1. Get the installation (or `skipped`), `octokit`, and `pulls.get`. Check for a repo mismatch (`PermanentJobError`), call `ensureRepository` (`skipped` if removed), then `upsertChangeFromPull` (`stale` when not applied). Stop with `closed` on a closed PR.
2. `factsReadAt = ctx.clock.now()`.
3. `commit = resolveBaseCommit(base.ref)`, then `loaded = loadBasePolicy(commit)`.
4. When `loaded.status === "ok"`: `listChangedPaths`, `listReviews`, `buildFacts`, `evaluatePolicy`, `countApprovals`. When it is `missing`: only `listChangedPaths`, to detect "this PR adds graft.yaml". When it is `invalid`: no listing.
5. Render, then compute `facts_hash`.
6. `withChangeLock`, with the D16 checks (a), (b) and (c); otherwise `stale`. When a row with the same identity has the same `facts_hash`, a `check_run_id` and `published_at`, the result is `unchanged` (no GitHub call). Otherwise:
   - check run (update `checkRunIdForHead`, or a `listForRef` hit, or create);
   - `upsertManagedSection("policy")`;
   - store `graft_comment_id`;
   - `upsertVerdict` with the ids, `published_at = now` and `facts_read_at`.

   Errors go through `toJobError("publish")`.
7. Log `{outcome, policyStatus, verdict outcome, matched: n, uncertain: bool}`, never names, globs or paths.

**`policy.fanout`.** Data: `{installationId, repositoryId, owner, repo, branch, afterSha, deliveryId}`.
1. Check that the installation and the repository are active.
2. Select open `changes` with `base_ref = branch`, ordered by `pr_updated_at DESC NULLS LAST`, limit 101. If 101 rows come back, log `fanout_truncated` and keep 100.
3. For each row *i*, send `policy.evaluate` (`trigger: "base_push"`) with the key `policy:base:{repoId}:{pr}:{afterSha}` and `startAfterSeconds = floor(i / 10) * 5`.

**`index.ts`** exports `webhookHandlers`, `jobs` (`policyEvaluateJob`, `policyFanoutJob`) and `signalListeners`. `src/app/registry.ts` adds `policy` last.

AC: I-POL-1 to I-POL-20, I-POLF-1 to I-POLF-5, U-PH-1 to U-PH-4.

### T12. CLI (`src/bin/graft.ts`)

- `pnpm graft policy check <file> [--json]`:
  - `lstat`: a symlink or non-file gives `file_not_regular`;
  - read the bytes and call `parsePolicyText`;
  - text output: `{file}: OK (version 1, {n} rules, {m} sensitive paths)` on success, or one line per error, `{file}:{line}:{col}: error {code} {location}: {message}`;
  - `--json` prints `{ok, errors}`;
  - exit 0 when valid, 1 when invalid, and 2 for usage errors and an unreadable or missing file.
- `pnpm graft policy schema [--write | --check]` prints, writes or compares `schema/graft.v1.schema.json`. A drift under `--check` exits 1.
- Any other command prints the usage and exits 2.
- The CLI imports only `src/policy/` and `node:*`. It needs no env, no DB and no config.

AC: U-CLI-1 to U-CLI-6.

### T13. Manifest, fixtures, docs

1. In `github/app-manifest.json`, `default_events` becomes `["check_run", "pull_request", "pull_request_review", "push"]`. Permissions are unchanged. Update U-MAN-1.
2. `scripts/generate-fixtures.ts` adds `pull_request.labeled`, `pull_request_review.submitted`, `pull_request_review.dismissed` and `push`, rewritten to the fixture world. U-FIX-1 covers them.
3. Extend the fake GitHub API:
   - `GET /repos/{o}/{r}/git/ref/heads/{branch}` from `state.branches`;
   - `GET /repos/{o}/{r}/contents/{path}?ref=` from `state.contents[ref][path]`, which supports file, dir, symlink, submodule, large (`encoding: "none"`) and 5xx;
   - `GET /pulls/{n}/reviews` (paged);
   - `labels` in `makePull`.

   The request log records `ref` for contents calls.
4. **`docs/graft-yaml.md`** (new):
   - where the file lives, and the trust model (base branch, PR edits ignored);
   - the §6 keys table and the glob rules;
   - the §9 semantics, with a short version of the worked examples (E1, E3, E4, E5, E7, E9);
   - the limits, the error catalogue, the editor setup (`yaml-language-server` comment with the schema URL);
   - the CLI and the Action snippet below;
   - "Phase 0 only reports", and "teams are not checked until Phase 1".
5. **The Action snippet** (copy into `docs/graft-yaml.md` and README):

```yaml
# .github/workflows/graft-yaml.yml
name: graft.yaml
on:
  pull_request:
    paths: ["graft.yaml"]
permissions:
  contents: read
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4                 # pin to a commit SHA per your org policy
      - uses: actions/checkout@v4
        with:
          repository: <org>/graft                 # HUMAN-TODO: final location
          ref: <pinned commit SHA>
          path: .graft-tool
          token: ${{ secrets.GRAFT_TOOL_TOKEN }}  # only while the Graft repo is private
      - uses: pnpm/action-setup@v4
        with: { package_json_file: .graft-tool/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm, cache-dependency-path: .graft-tool/pnpm-lock.yaml }
      - run: pnpm install --frozen-lockfile --dir .graft-tool
      - run: pnpm --dir .graft-tool graft policy check "$GITHUB_WORKSPACE/graft.yaml"
```

   It uses `pull_request`, never `pull_request_target`. The file is only parsed, never executed.
6. **README:**
   - §1 intro: step 5;
   - §5: layout (`src/policy`, `modules/policy`, `src/core/signals.ts`, `src/core/glob.ts`), and a "Policy contract" paragraph: base branch only; `src/policy` imports no module; payloads are triggers; nothing from the file is stored but the hash; teams are rendered as code spans;
   - a new "Policy (graft.yaml)" section linking `docs/graft-yaml.md`;
   - §6: the events table gains `pull_request_review` and `push`, `contents: read` is "now used", and `pull_request_review` comes off the deferred list;
   - §7: "Step 5 deviations and additions", and the step 4 redaction paragraph updated for T14;
   - the "Sensitive paths" paragraph says `graft.yaml` `sensitive_paths` now extend the list.
7. **HUMAN-TODO**: §14.

### T14. Step 4 review 2 follow-ups (`src/eval/redact.ts`)

1. **Linear-time scan (minor 1).**
   - `valueSpan` scans at most **512** characters for a quoted close or an unquoted end.
   - An unquoted run that is longer than 512 characters is redacted **as a whole**: one marker up to the run's real end, found by a single forward scan.
   - After **every** head, whether the value is accepted, rejected or empty, `ASSIGN_HEAD.lastIndex = max(lastIndex, end of the scanned span)`.
   - Every character is therefore scanned by `valueSpan` at most once per line.
   - The README sentence about adversarial lines covers this loop too.
2. **Value terminators (minor 2).** An unquoted value ends at whitespace, at a quote, or at `,`, `;`, `)`, `}`, `]` or `&`.
3. **Leak forms (minor 3).**
   - **Next-line values.** After a secret-named key whose value is empty, a YAML block indicator (`^[|>][+-]?[1-9]?$` or `^[|>][1-9][+-]$`), a line ending in `\`, or an unterminated quote, the following lines are redacted.
     - For a block indicator or an empty value: lines indented more than the key line, but for an empty value only lines that are not themselves `key:` lines.
     - For a `\` continuation: the next line, and the one after it again while each ends in `\`.
     - For a quote: lines up to and including the one with the closing quote.
     - At most 50 lines. The body becomes indentation + `[REDACTED:assignment]`, and the prefixes and line count are kept.
     - A hunk header or a `\ No newline` line ends the state, as for key blocks.
   - **CLI flags.** `--name value` and `-name value`, where the name passes `isSecretName` once the dashes are stripped and the value is 8 or more characters and not `NOT_A_VALUE`, give kind `cli_flag`. `-p<value>` (4 or more characters) only on a line that contains `\b(mysql|mysqldump|mysqladmin|mariadb)\b`. `-u` or `--user` with `user:pass` (optionally quoted) loses only the password.
   - **Redis-style URLs.** The user part of `URL_CREDENTIALS` becomes `{0,100}` (`redis://:pass@host`).
   - **Key names.** Add `(?:encryption|master|signing)_?key` to `KEY_SUBSTRING`.
   - **Internal capitals.** `isSecretName` tests `KEY_SUBSTRING` against the camel-split form **and** against the flat form (lower-cased, `_-.` removed), so `PassWord` is caught.
   - **Slack webhooks.** Add the secret pattern `slack_webhook`, `/\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_\/-]{10,200}/g`.
4. **Nit.** `BENIGN_FIRST = /^(?:max|min|limit|budget|num|total)_/` on the split name: `max_tokens = 100000000` stays readable.

AC: U-RED-12 (extended), U-RED-14 to U-RED-18. Every existing U-RED test passes. `pnpm eval:ci` is unchanged (redaction does not run on the synthetic set).

## 13. Test plan

Everything is offline: fake GitHub API, fake LLM, real Postgres and pg-boss for `I-`. Test names carry the IDs.

**Unit: parsing and schema**

| ID | Asserts |
| --- | --- |
| U-PY-1 | `docs/examples/graft.yaml` parses; the normalised `Policy` deep-equals a pinned object; the hash is stable across key order and whitespace changes |
| U-PY-2 | 32,769 bytes → `file_too_large` with `detail`; 32,768 valid bytes parse |
| U-PY-3 | A billion-laughs document (9 levels of `&a`/`*a`) → `yaml_alias` in under 50 ms, and `toJS` is never called (spy) |
| U-PY-4 | Any single anchor without an alias → `yaml_alias`; a merge key `<<: *x` → `yaml_alias` |
| U-PY-5 | `!custom`, `!!binary`, `!!python/object` → `yaml_tag` with lines |
| U-PY-6 | Duplicate key → `yaml_duplicate_key`; two documents → `yaml_multiple_documents`; a syntax error → `yaml_syntax` with line and column |
| U-PY-7 | Invalid UTF-8 → `file_not_utf8`; a BOM is accepted |
| U-PY-8 | 17 nested `[` → `yaml_too_deep`; `[` inside quotes and comments is not counted |
| U-PY-9 | A top-level list or scalar → `not_a_mapping`; no version → `version_missing`; `version: 2` → `version_unsupported` |
| U-PY-10 | Fuzz: 2,000 seeded random byte strings and 2,000 mutations of the example never throw, and each returns `ok` or ≤ 50 errors |
| U-PS-1 | Every `unknown_key` level (top, rule, match, size, require), with `key` set and line numbers |
| U-PS-2 | Action errors: none, two, `approve: yes`, `block: false` |
| U-PS-3 | `approve_untrusted_key` for each of `author`, `agent` and `labels`; `approve_any_path` for `paths`; `only_paths` + `risk` + `size` are allowed |
| U-PS-4 | `humans` 0, 11, 1.5 and `"2"` → `humans_invalid`; `require: {}` → `require_empty` |
| U-PS-5 | `team` `@acme/security`, `acme/security` and `Security` → `team_invalid`; a list of 11 → `too_many_items` |
| U-PS-6 | `risk`, `author`, `agent` and `label` invalid values |
| U-PS-7 | `size`: empty, negative, min > max, and over 1,000,000 |
| U-PS-8 | Names: invalid and duplicate |
| U-PS-9 | `default` with `approve` or `block` → `default_invalid`; an absent `default` → `{1, []}` |
| U-PS-10 | 201 rules → `too_many_rules`; 501 globs → `too_many_globs`; 60 errors → 50 + `too_many_errors` |
| U-PS-11 | Normalisation: scalars become lists, deduplicated in file order, `humans` defaults to 1 |
| U-PS-12 | No error message contains any value from the file (property test over the invalid fixtures: the message ∩ the file's scalar values = ∅, except `key`) |
| U-PSCH-1 | `policyJsonSchema()` equals `schema/graft.v1.schema.json`; ajv validates the example and rejects a missing `version`, an unknown key and two actions |
| U-PG-1 | Every `glob_invalid` detail 1 to 7, with one example each |
| U-PG-2 | The same globs behave identically under `globMatcher` from `src/core/glob.ts` and through the `risk-floor.ts` re-export (table of 30 path/glob pairs) |
| U-PG-3 | `nocase: false` (`only_paths`) distinguishes `Docs/` from `docs/`; the default does not |
| U-PG-4 | A pattern with 3 `*` in a segment, against a 255-character non-matching segment, takes under 50 ms |
| U-PG-5 | A leading `/` anchors; no `/` means any depth; `dot: true` |
| U-PG-6 | 500 globs × 1,000 paths are evaluated in under 1 s |

**Unit: evaluation, loader, facts, render, handlers, CLI**

| ID | Asserts |
| --- | --- |
| U-PE-1 … U-PE-14 | §9.3 E1 to E14: the exact verdict object, including the `uncertain` flags and `overridden` |
| U-PE-15 | Block wins regardless of rule order (rules permuted, same outcome) |
| U-PE-16 | Requirements merge: same team set → max; different sets → separate constraints; `humans = max` |
| U-PE-17 | An approve rule with `risk: trivial` never matches while `!final` (all 3 floors) |
| U-PE-18 | `only_paths` is false with zero files, with `listingComplete: false`, or with a renamed file whose old path is outside |
| U-PE-19 | `paths` matches the previous path of a rename (into and out of `secrets/`) |
| U-PE-20 | `agent` with a known `human` author never matches; with an unknown author it matches as uncertain |
| U-PE-21 | `sensitive_paths` and policy-file raises set `raisedBy`, and `P = {sensitive}` makes `final` irrelevant |
| U-PE-22 | Determinism: the same input gives a deep-equal output, and input arrays are not mutated |
| U-PA-1 | Latest-review-per-user wins (APPROVED then CHANGES_REQUESTED → 0) |
| U-PA-2 | COMMENTED does not reset an approval; DISMISSED does |
| U-PA-3 | Author, bots and null users are excluded |
| U-PA-4 | current vs stale by `commit_id`; `users` sorted and capped at 10 |
| U-PA-5 | `truncated` is passed through |
| U-LOAD-1 | 404 → `missing`; a file → `ok`, with the `ref` equal to the commit SHA given |
| U-LOAD-2 | Directory (array), `symlink`, `submodule`, and `path` ≠ `graft.yaml` (followed symlink) → `file_not_regular` |
| U-LOAD-3 | `size` 40,000 or `encoding: "none"` → `file_too_large`, with the content never decoded |
| U-LOAD-4 | Cache: two loads of the same commit make one request; a different commit makes a new one; a 5xx is not cached and throws a retryable error |
| U-LOAD-5 | `resolveBaseCommit` 404 → `PermanentJobError` `base_missing` |
| U-LOAD-6 | The log lines contain no glob, name or YAML text (log capture) |
| U-FACT-1 | `listChangedPaths` drops `patch` (the returned objects have no `patch` key); over 1,000 files makes no call and returns `complete: false` |
| U-FACT-2 | Risk source: card `ok` for the head; card `unavailable`; card for another head → pending floor with `max(…, logic)` |
| U-FACT-3 | Provenance for another head → `unknown` |
| U-FACT-4 | The pending floor uses the policy's `sensitive_paths` |
| U-PR-1 | §10.2 `would_require` byte for byte |
| U-PR-2 | `would_block`, `would_approve` (no approvals line), `policy_invalid`, `no_policy` and "adds graft.yaml": byte for byte |
| U-PR-3 | Titles: every §10.1 form, including cutting at 200 and ` · risk provisional` |
| U-PR-4 | A team is always inside a code span: no `@` outside backticks in the section (regex over the output) |
| U-PR-5 | A rule name `**x** <!-- graft: @everyone [l](http://e)` is escaped: no `<!--`, no live link, no mention |
| U-PR-6 | A path containing `` ` `` and `<!--` goes through `codeSpan` |
| U-PR-7 | A 200-rule match keeps the section ≤ 20,000 characters, with `and K more rules` |
| U-PR-8 | The invalid list is capped at 20 errors; the `unknown_key` key is in a code span |
| U-PR-9 | The `[!IMPORTANT]` and `[!NOTE]` blocks appear exactly when expected |
| U-PH-1 | `policy.schedule` keys: the same body gives the same key; labeled A, unlabeled A, then labeled B differ |
| U-PH-2 | `policy.base-push` filter: graft.yaml modified, added or removed → enqueue; other files → no enqueue; `forced` and 20 commits → enqueue; `deleted`, a tag ref or a zero `after` → no enqueue |
| U-PH-3 | `policy.rerequest` ignores other check names and other app ids |
| U-PH-4 | A payload shape mismatch → `payload_shape_mismatch` logged, nothing enqueued |
| U-CLI-1 | A valid file → exit 0, with the OK line |
| U-CLI-2 | An invalid file → exit 1, one `file:line:col: error code location: message` line per error |
| U-CLI-3 | `--json` output shape |
| U-CLI-4 | A missing file and a bad command → exit 2; a symlink → exit 1 `file_not_regular` |
| U-CLI-5 | `schema --check` exits 0 on the committed file and 1 on a modified copy (temp path option for the test) |
| U-CLI-6 | Runs with an empty env (no `DATABASE_URL`); a grep-style test asserts that `src/bin/graft.ts` and `src/policy/**` import nothing from `src/modules`, `src/db`, `src/config` or `src/queue` |
| U-GLOB-1 | `globMatcher` cache keys separate `nocase` |
| U-SIG-1 | `createSignals` calls the listeners in order and propagates errors; `noSignals` does nothing |
| U-MAN-1 | (updated) events `["check_run", "pull_request", "pull_request_review", "push"]`; permissions unchanged |
| U-RED-12 | (extended) `"password=${".repeat(20_000)`, `'password="'.repeat(20_000)`, `"token=$(".repeat(20_000)`, `"password=a(".repeat(20_000)` and `"password=process.env.".repeat(10_000)` each finish in under 300 ms |
| U-RED-14 | `var a={password:null,user:"bob"}` and `x={token:e.token,user:u.name,flags:[1,2,3]}` are unchanged; `q?password=hunter2hunter2&user=bob` keeps `&user=bob` |
| U-RED-15 | YAML `password: |`, `token: >-` and `password:` (empty) followed by indented values; `password = \` continuation; an unterminated quoted value over 3 lines. All are redacted with the line count and prefixes kept; `credentials:` followed by `username: bob` keeps `username: bob` |
| U-RED-16 | `--password hunter2hunter2`, `mysql -pS3cretPass`, `curl -u admin:hunter2hunter2` and `--user "admin:hunter2hunter2"` are redacted; `gcc -pthread` and `--password-file /x` are unchanged |
| U-RED-17 | `redis://:hunter2hunter2@cache`, `encryption_key`/`master_key`/`signing_key` assignments, `PassWord = …` and a Slack webhook URL are redacted |
| U-RED-18 | `max_tokens = 100000000`, `limit_secret_count = 12345678` and `num_tokens = 123456789` stay; the step 4 negatives stay |

**Integration** (`test/helpers/policy-scenario.ts`: an installed repo, a PR, a base branch `main` at `B1`, contents per ref, an optional card and provenance)

| ID | Asserts |
| --- | --- |
| I-DB-10 | `0005` applies; the rollback restores the `0001` `policy_verdicts` exactly (columns, checks, index); `up` again works. I-DB-2/7/8 roll back and re-apply `0005` too. The I-DB insert-all test uses the new columns. I-DB-4 passes |
| I-POL-1 | `pull_request.opened` → `policy.evaluate` with the §T11 key → a `graft/policy` check `neutral`, the section is published, and one verdict row has `published_at` |
| I-POL-2 | The same body under a new delivery id → no new job (deterministic id) |
| I-POL-3 | **Base only.** Base `B1` blocks `secrets/**` for agents; the PR head deletes that rule and touches `secrets/a`. The verdict is `would_block`, the `[!IMPORTANT]` note shows, and every contents request has `ref = B1` (never the head SHA or a `refs/pull` ref) |
| I-POL-4 | Missing file → `no_policy`, the `No graft.yaml on main` title, neutral |
| I-POL-5 | Alias bomb, symlink, directory and 40 KB file → `policy_invalid` with the right code; never `would_approve`; neutral |
| I-POL-6 | The base moves from `B1` to `B2` (the ref is updated in the fake): the next evaluation reads `B2` |
| I-POL-7 | Card pending → `risk provisional`; the intent job publishes a `trivial` card → the `intent_published` signal enqueues a re-evaluation → `would_approve`, final |
| I-POL-8 | Provenance pending → `author unknown`; provenance publishes → the signal → the author is known and the uncertain reason is gone |
| I-POL-9 | `pull_request_review.submitted` (APPROVED on the head) → the approvals line shows 1; `dismissed` → 0 |
| I-POL-10 | `labeled` hotfix → rule 8 applies (require overrides approve) |
| I-POL-11 | **Stale head.** The head moves between the fact read and the lock (gate as in I-INT-9) → no GitHub write, outcome `stale` |
| I-POL-12 | **Older facts.** Job A reads facts at t1 and job B at t2 > t1; B publishes; then A reaches the lock → `stale`; the stored row is B's |
| I-POL-13 | Same facts twice → the second run makes no check-run or comment request (`unchanged`) |
| I-POL-14 | `check_run.rerequested` for `graft/policy` twice in one minute → one job; next minute → another |
| I-POL-15 | Closed PR → no publish, no row |
| I-POL-16 | Across E1, E3, E4, invalid and missing, every check-run create or update body has `conclusion: "neutral"` |
| I-POL-17 | **No file contents stored.** After I-POL-1 and I-POL-5, no column of `policy_verdicts`, no `pgboss.job.data` and no log line contains any rule name, glob or team slug from the YAML, or a YAML line |
| I-POL-18 | The comment's intent and provenance sections are byte-identical before and after the policy publish; the policy section's team names are in code spans |
| I-POL-19 | A transient 502 on contents → the job retries (pg-boss `retry`) and publishes nothing; a 404 base branch → permanent, no retry |
| I-POL-20 | A PR that adds `graft.yaml` where the base has none → `no_policy` with the "adds" note |
| I-POLF-1 | A `push` to `main` that modifies `graft.yaml` → one `policy.fanout` → `policy.evaluate` for the open PRs with base `main` only (not closed PRs, not base `develop`), with keys `policy:base:…:{after}` |
| I-POLF-2 | A push that does not touch `graft.yaml` → no fan-out; a replay → deduplicated |
| I-POLF-3 | 101 open PRs → 100 evaluate jobs, `fanout_truncated` logged, `startAfter` staggered |
| I-POLF-4 | A removed repository or an inactive installation → no jobs |
| I-POLF-5 | End to end: after the fan-out, a PR's verdict flips from `would_approve` to `would_require` when the new base adds a require rule |
| I-POLH-1 | Base `graft.yaml` with `sensitive_paths: ["services/billing/**"]` → a PR touching `services/billing/a.ts` gets intent floor `sensitive`, with reason `configured_path` |
| I-POLH-2 | The head's `graft.yaml` has different `sensitive_paths` → ignored; contents are requested only at `pull.base.sha` |
| I-POLH-3 | Invalid or missing base `graft.yaml` → config globs only; the card is generated |
| I-POLH-4 | The intent hook and the policy job on the same base commit → one contents request (the shared cache) |
| I-POLH-5 | Contents 502 in the hook → the intent job retries; no card row, no spend |
| I-POLH-6 | `pull.base.sha` absent → `git/ref` is called and that SHA is used |

## 14. HUMAN-TODO additions (append a "Step 5: Policy engine (report-only)" section)

- [ ] **Update the App's events.** In the registered App's settings (Permissions & events), subscribe to **Pull request review** and **Push**. No permission changes. Check whether the installations must accept the change. Then confirm that one push and one review on `sample-ts` arrive (`select event, action from webhook_deliveries order by received_at desc limit 5`). Who: org owner.
- [ ] **Pilot teams write their `graft.yaml`** on the default branch through a normal reviewed PR, starting from `docs/examples/graft.yaml`. Each pilot runs `pnpm graft policy check graft.yaml` and adds the Action from `docs/graft-yaml.md`. Who: each pilot's tech lead with their security owner. Produces: one valid `graft.yaml` per pilot repo.
- [ ] **Move `GRAFT_INTENT_SENSITIVE_PATHS` into `graft.yaml`** (`sensitive_paths`) for each pilot, then clear the env value. Who: product owner.
- [ ] **Check team slugs exist** in each pilot org (`gh api orgs/<org>/teams --jq '.[].slug'`). Graft cannot check them until Phase 1 (`members: read`). Who: pilot tech lead.
- [ ] **Do not change branch protection in Phase 0.** Keep required reviewers. Do **not** make `graft/policy` a required check. Removing required reviewers and requiring `graft/policy` happens in Phase 1 (development plan, spec fix 1). Who: pilot repo admins.
- [ ] **Publish the JSON Schema URL.** Decide the final Graft repo location, replace `<org>` in `docs/examples/graft.yaml`, `docs/graft-yaml.md` and the Action snippet, and set `GRAFT_TOOL_TOKEN` in pilot repos while the Graft repo is private (a fine-grained, read-only token for that one repository). Who: repo owner.
- [ ] **Check on GitHub.** On a sandbox PR, check that:
  - the `graft/policy` check is `neutral` with a "Would …" title;
  - the comment's policy section renders, with no team notification;
  - a push to `main` that edits `graft.yaml` re-evaluates open PRs.

  Who: repo owner.
- [ ] **Plan Phase 1 permission.** Note that team approvals need `members: read` (org), which installations must accept. Who: product owner.

## 15. Definition of done

From a clean clone with Docker running, and no network beyond install and the image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test                                  # every ID in §13 present and passing; earlier steps' IDs still passing
pnpm build
pnpm eval:ci                               # exit 0, baseline unchanged
pnpm graft policy schema --check           # exit 0
pnpm graft policy check docs/examples/graft.yaml                       # exit 0
pnpm graft policy check test/fixtures/policy/alias-bomb.yaml; test $? -eq 1
pnpm db:migrate && pnpm db:status          # 0001..0005 applied
pnpm db:rollback && pnpm db:status && pnpm db:migrate   # only 0005 rolled back, then re-applied
grep -rnE "@ts-(ignore|expect-error)" src/ && exit 1 || true
grep -rn "modules/" src/db/ src/policy/ src/bin/graft.ts && exit 1 || true
grep -rnE "pull_request_target|refs/pull" src/ && exit 1 || true
grep -rn "U-PE-\|U-PY-\|U-PS-\|I-POL-\|I-POLF-\|I-POLH-\|U-RED-1[4-8]" test/ | wc -l    # non-zero
```

**Manual smoke test** (record it in the PR description):
1. Run `pnpm dev:server` and `pnpm dev:worker`.
2. Send `pnpm webhook:send installation.created --delivery s5-1`, then `pnpm webhook:send pull_request.opened --delivery s5-2` → `202`.
3. `select name, data from pgboss.job where name like 'policy.%'` shows `policy.evaluate` with IDs only.
4. `pnpm webhook:send push --delivery s5-3` (the fixture lists `graft.yaml`) → one `policy.fanout`.
5. The worker logs a classified GitHub token failure (offline), not a crash.

**Mutation checks** (the reviewer reverts each one; the named tests must fail):

| Mutation | Caught by |
| --- | --- |
| `loadBasePolicy` called with the head SHA instead of the base commit | I-POL-3, I-POLH-2 |
| Block no longer wins (first match decides) | U-PE-4, U-PE-15 |
| Approve no longer overridden by require | U-PE-9, I-POL-10 |
| Unknown facts treated as non-matching in tightening rules | U-PE-5, U-PE-8, U-PE-10 |
| A provisional risk treated as final in approve rules | U-PE-14, U-PE-17 |
| Alias and anchor rejection removed (only `maxAliasCount`) | U-PY-3, U-PY-4 |
| `approve_untrusted_key` refinement removed | U-PS-3 |
| `policy_file_changed` built-in removed | U-PE-7, I-POL-3 |
| `sensitive_paths` raise removed from `evaluatePolicy` | U-PE-6, U-PE-21 |
| The hook ignores `graft.yaml` | I-POLH-1 |
| `conclusion` set from the outcome (`success`/`failure`) | I-POL-16 |
| `codeSpan` on team names replaced by plain text | U-PR-4, I-POL-18 |
| In-lock head check removed in `policy/job.ts` | I-POL-11 |
| `facts_read_at` guard removed | I-POL-12 |
| `patch` kept in `listChangedPaths` | U-FACT-1 |
| `lastIndex` advance after a rejected value removed in `redact.ts` | U-RED-12 |

**Also required:**
- No column, job payload, log line or error message holds YAML text, globs, rule names, team slugs or diff content (I-POL-17, U-LOAD-6 and code reading).
- README §1, §5, §6 and §7, the new "Policy (graft.yaml)" section, `docs/graft-yaml.md`, `docs/examples/graft.yaml`, `schema/graft.v1.schema.json` and `HUMAN-TODO.md` are updated per T13. `github/app-manifest.json` changes only `default_events`, and U-MAN-1 matches it.
