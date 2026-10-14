# Phase 0, Step 2: Provenance

Spec for the developer agent. Implement exactly this. Where this spec is silent, choose the simplest option and record it in README §7 ("Deviations and additions"). The [Phase 0 README](README.md) constraints are binding: offline build and test, Postgres from `docker compose`, no stored code, pnpm, Node 24, strict TypeScript. The code reality from step 1 is in the repo [README](../../README.md) §5 and §7. Where this spec and that README disagree on an existing interface, the README wins. Ask yourself "what does step 1 actually do?" before adding anything.

## 1. Goal

For every pull request in an installed repository, Graft works out **who wrote it**:

- which agent, which model, which task, and a link to the session;
- whether the PR counts as **agent-** or **human-authored**. Step 5 policies need this for `author: agent`.

It gets this from `Graft-*` git trailers in the PR's commits, with the PR description as a fallback. It stores the result per PR and per commit, and shows it on the PR in two places:

- a `graft/provenance` check run;
- the provenance section of the **single Graft-managed PR comment**. This step defines that comment's contract, and step 3 adds the intent card to the same comment.

All of this must be correct when deliveries are replayed, stale, out of order or concurrent. It must also stay correct under API errors and rate limits, and be fully testable offline.

## 2. Out of scope

Do not create stub code for any of these.

- The MCP `report_provenance` tool (Phase 1). The `source = 'mcp'` value stays in the schema, unused.
- Grouping and ranking PRs that share a task (phase 2). This step only links `changes.task_id`.
- Intent cards, LLM calls, `graft.yaml` and policy evaluation (steps 3–5). Per-repo agent-login config also waits for `graft.yaml` in step 5; this step uses env config only.
- Fetching or validating session URLs over the network. Graft never requests them.
- Octokit retry and throttling plugins. Retries come from pg-boss.
- Storing commit author names or emails, or any commit content other than parsed `Graft-*` values. **Commit messages are parsed in memory and never stored.**
- Pinning the comment through the API. "Pinned" means one comment that Graft creates once and then updates in place.
- Authenticating the `X-GitHub-Event` / `X-GitHub-Delivery` headers at the receiver. That is impossible, because GitHub's HMAC covers only the body. This step limits the damage instead (T9).

## 3. Decisions

| # | Area | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | Trigger | `pull_request` `opened`, `synchronize`, `reopened`, `edited`, `closed`, plus `check_run.rerequested` for our own check | These are every event that can change commits, the body, the base or the state. Re-run gives users a manual retry. |
| D2 | Handler vs job | The webhook handler validates the payload and only **enqueues** `provenance.refresh`. The job **re-fetches the PR** (`pulls.get`) and writes only from live API data | Handlers stay fast (README contract). A replayed, stale or relabeled payload can never write state (coordinator requirement, T9). |
| D3 | Job semantics | `provenance.refresh` = "make provenance match the PR as it is **now**". It always computes for the live head, whichever event triggered it | Removes "which event is newer" reasoning from the job. A stale job does at worst redundant, idempotent work. |
| D4 | Change-row ordering | `changes` gets `pr_updated_at`. The upsert applies only when the live `updated_at` is `>=` the stored value | A guard against out-of-order writes between concurrent jobs. `>=` keeps retries idempotent. |
| D5 | Publish serialization | Writing results and GitHub output happens inside `withChangeLock` (`pg_advisory_xact_lock` per change). Inside the lock the job re-reads `changes.head_sha` and skips the publish if it differs from the computed head | Concurrent jobs on one PR cannot overwrite newer output with older output. Step 3 uses the same lock for the shared comment. |
| D6 | Job dedup key | `prov:{repositoryId}:{prNumber}:{headSha}:{baseRef}:{sha256(body ?? "")[0..16]}:{pull_request.updated_at}`; re-run key `prov-rerun:{deliveryId}` | Within the 7-day window, title-only edits, redeliveries and **replays under a fresh delivery ID** are no-ops. A re-run always runs (README §7: a re-run needs a different key). |
| D7 | Trailer names | `Graft-Agent`, `Graft-Model`, `Graft-Task`, `Graft-Session` (session URL). Keys are case-insensitive | `Graft-Session` matches the MVP's "link to the session". |
| D8 | Trailer semantics | git `interpret-trailers` rules, simplified as in §6 | Agents write trailers with `git commit --trailer`, so parse them the way git does. |
| D9 | Precedence | Per field: newest commit carrying a valid value, then older commits, then the PR body | Commits are tied to SHAs and immutable. The body is editable and only a fallback. |
| D10 | Disagreement | The newest value wins. Every distinct value (commits and body, at most 5) is recorded as a conflict and shown | Mixed agents are legitimate; hiding the mix would mislead reviewers. |
| D11 | Agent vs human | Agent if **any** of these holds, checked in this order: resolved `Graft-Agent` → PR author `type === "Bot"` → author login in `GRAFT_AGENT_LOGINS` → a commit has `Co-authored-by` with an email in `GRAFT_AGENT_COAUTHOR_EMAILS` (default `noreply@anthropic.com`). Otherwise human. The first matching reason is stored | False "agent" only makes policy stricter, so the rule leans towards agent. The co-author signal catches Claude Code (the first harness) even without Graft trailers. Emails are compared, never stored. |
| D12 | Output | Both a `graft/provenance` check run (always `neutral`) and the `provenance` section of the managed comment | The comment is what reviewers read. The check is a per-SHA record with a Re-run button, matching steps 3 and 5. |
| D13 | Managed comment | One comment per PR, starting with `<!-- graft:managed-comment v1 -->`, with named sections. Its ID is stored on `changes.graft_comment_id`. A comment is ours only if `performed_via_github_app.id === GITHUB_APP_ID` | One place for the card, provenance and policy. A human cannot plant a fake Graft comment by pasting the marker. |
| D14 | Untrusted values | Strict per-field character sets, length caps, `https`-only session URLs with no credentials or IP hosts. Every value is rendered inside a code span or as a link with an encoded destination | Trailers and the body come from the agent being judged. This blocks markdown, HTML and mention injection and Trojan-source characters. |
| D15 | >250 commits | List PR commits (at most 250 from the API, at most 3 pages of 100). If `pull.commits` > the number fetched, also fetch the head commit with `git.getCommit`, set `truncated` and say so in the output | The API hard-caps at 250. The head commit matters most for precedence. `git.getCommit` returns no patch. |
| D16 | Errors | Classify Octokit errors. 404, 410, 422, 401 and non-rate-limit 403 are **permanent** (log and complete). 429, rate-limit 403 and 5xx/network errors are **retryable** (throw). Add `PermanentJobError`, which the worker completes instead of retrying | This settles the README §7 note that a "non-retryable error type is deferred". It stops a deleted PR or a lost permission from retrying 8 times. |
| D17 | Payload validation | Each handler parses its payload with a zod schema of the fields it reads, plus event-specific discriminators. A mismatch is logged at `warn` (`payload_shape_mismatch`) and the handler returns | Catches event-header relabeling (T9). Returning instead of throwing avoids pointless retries. |
| D18 | Module split | New `src/modules/changes/` (store only, no handlers) owns the `changes` row and the guarded upsert. `src/modules/provenance/` owns trailers. `src/github/managed-comment.ts`, `src/github/errors.ts` and `src/db/locks.ts` are shared | Step 3 needs the change upsert, the lock and the comment without importing provenance internals. |

## 4. Files

New and changed files (✚ new, ✎ changed):

```
src/config/index.ts                       ✎ GRAFT_AGENT_LOGINS, GRAFT_AGENT_COAUTHOR_EMAILS
src/core/logger.ts                        ✎ createLogger(config, destination?)        (review-3 nit 1)
src/db/schema.ts                          ✎ new columns/table; TABLE_NAMES gains change_provenance
src/db/migrations/0002_provenance.ts      ✚
src/db/migrations/index.ts                ✎
src/db/locks.ts                           ✚ withChangeLock
src/github/errors.ts                      ✚ classifyGitHubError
src/github/managed-comment.ts             ✚ marker, sections, upsertManagedSection
src/queue/errors.ts                       ✚ PermanentJobError
src/queue/worker.ts                       ✎ completes on PermanentJobError
src/webhooks/payload.ts                   ✚ parsePayload helper
src/modules/installations/handlers.ts     ✎ validates its payload with zod (T9)
src/modules/installations/index.ts        ✎ also exports ensureRepository
src/modules/installations/store.ts        ✎ ensureRepository
src/modules/changes/{index,store}.ts      ✚
src/modules/provenance/
  index.ts                                ✚ { webhookHandlers, jobs } + public types
  trailers.ts                             ✚ parseTrailerBlock (pure)
  fields.ts                               ✚ value validation, Graft field extraction (pure)
  compute.ts                              ✚ computeProvenance (pure)
  render.ts                               ✚ section markdown + check-run output (pure)
  fetch.ts                                ✚ fetchPrCommits
  store.ts                                ✚ persistProvenance
  handlers.ts                             ✚ provenance.schedule, provenance.rerequest
  job.ts                                  ✚ provenance.refresh
src/app/registry.ts                       ✎ + changes, + provenance
scripts/generate-fixtures.ts              ✎ reopened, edited, check_run tweaks
test/fixtures/webhooks/*.json             ✎/✚ regenerated
test/helpers/fake-github-api.ts           ✚ in-memory GitHub REST fake
test/helpers/github-builders.ts           ✚ makePull, makeCommit, commitMessage
test/helpers/app.ts                       ✎ createTestApp({ github? })
.env.example, README.md, docs/phase-0/HUMAN-TODO.md   ✎
```

## 5. Tasks

Each task has acceptance criteria (AC) that the reviewer will check.

### T1. Migration `0002_provenance` and schema types

Write the SQL in §7 with a working `down`, update `Database`, add `change_provenance` to `TABLE_NAMES`, and register the migration.

AC:
- `pnpm db:migrate` applies `0002`; `pnpm db:rollback` reverts only `0002`; `up` works again.
- `Database` types match the columns exactly. `field_sources`, `conflicts` and `warnings` use the existing `Json<T>` helper with the TypeScript types from T5.
- No new column name matches I-DB-4's regex.

### T2. Shared infrastructure

1. **`src/queue/errors.ts`**: `export class PermanentJobError extends Error { constructor(message: string, readonly reason: string, options?: ErrorOptions) }`.
2. **`src/queue/worker.ts`**: if `handle` throws a `PermanentJobError`, log at `error` with `{ err, permanent: true, reason }` and **return normally**, so pg-boss completes the job. Any other error is rethrown as today.
3. **`src/github/errors.ts`**: `classifyGitHubError(err: unknown): "not_found" | "rate_limited" | "forbidden" | "invalid" | "transient"`. Use duck typing on `{ status: number; response?: { headers?: Record<string,string> }; message: string }`. Do not add a dependency on `@octokit/request-error`. Rules:
   - `404`/`410` → `not_found`.
   - `429`, or `403` with `x-ratelimit-remaining: "0"`, a `retry-after` header, or a message matching `/secondary rate limit/i` → `rate_limited`.
   - Other `401`/`403` → `forbidden`.
   - `422` → `invalid`.
   - `>= 500`, a missing status or a non-HTTP error → `transient`.
4. **`src/github/errors.ts`**: `toJobError(err, what: string): Error`. It returns a `PermanentJobError(reason = class)` for `not_found`, `forbidden` and `invalid`. Otherwise it returns `err` unchanged, which stays retryable. Logs include the status and `what`, never request headers.
5. **`src/db/locks.ts`**: `withChangeLock<T>(db: Db, changeId: string, fn: (tx: Transaction<Database>) => Promise<T>): Promise<T>`. It opens a transaction, runs `select pg_advisory_xact_lock(hashtextextended('graft:change:' || ${changeId}, 0))` and then `fn(tx)`. The doc comment states that **every writer of the managed comment or of per-change GitHub output must hold this lock**.
6. **`src/webhooks/payload.ts`**: `parsePayload<T>(schema: z.ZodType<T>, event: { name: string; deliveryId: string; payload: unknown }, log): T | undefined`. On failure it logs `warn` with `{ outcome: "payload_shape_mismatch", event, deliveryId, issues: <paths only> }` and returns `undefined`. It never logs payload values.

AC: U-GHE-1..4, I-LOCK-1, I-Q-4.

### T3. Config

Add two variables to `loadConfig`, `Config` and `.env.example`:

| Variable | Rule | Default | Config key |
| --- | --- | --- | --- |
| `GRAFT_AGENT_LOGINS` | comma-separated GitHub logins, each `^[A-Za-z0-9-]+(\[bot\])?$`. Trimmed, lowercased, empties dropped | `""` | `agentLogins: readonly string[]` |
| `GRAFT_AGENT_COAUTHOR_EMAILS` | comma-separated emails, each containing exactly one `@`. Trimmed, lowercased | `noreply@anthropic.com` | `agentCoauthorEmails: readonly string[]` |

AC: U-CFG-7. The arrays are frozen. Error messages follow the step 1 rule: names only, never values.

### T4. Trailer parser (`trailers.ts`, pure)

`parseTrailerBlock(text: string, opts: { hasTitle: boolean }): { trailers: { key: string; value: string }[]; truncated: boolean }` implements §6.1. Use `hasTitle: true` for commit messages and `false` for PR bodies.

AC: U-TRL-1..18.

### T5. Field extraction and validation (`fields.ts`, pure)

```ts
export type GraftField = "agent" | "model" | "task" | "session";
export const TRAILER_KEYS: Record<GraftField, string> =
  { agent: "Graft-Agent", model: "Graft-Model", task: "Graft-Task", session: "Graft-Session" };
export type WarningCode =
  | "invalid_value" | "value_too_long" | "empty_value" | "duplicate_key"
  | "unknown_graft_key" | "invalid_session_url" | "message_truncated" | "block_too_long";
export interface ProvenanceWarning { code: WarningCode; field?: GraftField; commitSha?: string; source: "commit" | "pr_body" }
export function extractGraftFields(
  trailers: { key: string; value: string }[],
  o: { agentCoauthorEmails: readonly string[] },
): { fields: Partial<Record<GraftField, string>>; warnings: Omit<ProvenanceWarning, "source" | "commitSha">[]; agentCoauthor: boolean };
export function validateSessionUrl(raw: string): string | null;    // normalized href or null
```

The rules are in §6.2 and §6.3.

AC: U-FLD-1..13.

### T6. Aggregation (`compute.ts`, pure)

```ts
export interface CommitInput { sha: string; message: string }   // API order (oldest first); head last
export interface ProvenanceInput {
  commits: readonly CommitInput[];
  commitsTotal: number;              // pull.commits
  truncated: boolean;
  prBody: string | null;
  prAuthor: { login: string; type: string };
  agentLogins: readonly string[];
  agentCoauthorEmails: readonly string[];
}
export interface ResolvedField { value: string; source: "commit" | "pr_body"; commitSha?: string }
export type AuthorKindReason = "trailer" | "bot_account" | "configured_login" | "agent_coauthor" | "none";
export interface ProvenanceResult {
  fields: Partial<Record<GraftField, ResolvedField>>;
  conflicts: Partial<Record<GraftField, string[]>>;       // distinct values, newest first, max 5
  perCommit: { sha: string; fields: Partial<Record<GraftField, string>> }[];  // only commits with ≥1 valid field
  prBodyFields: Partial<Record<GraftField, string>> | null;                  // null when the body has none
  authorKind: "agent" | "human";
  authorKindReason: AuthorKindReason;
  warnings: ProvenanceWarning[];                           // max 50, in commit order, then body
  counts: { total: number; scanned: number; withTrailers: number; agentCoauthor: number };
}
export function computeProvenance(input: ProvenanceInput): ProvenanceResult;
```

AC:
- Precedence D9: iterate `commits` from last to first, so the first valid value per field wins; the body only fills fields that are still empty.
- Conflicts D10: a field with one distinct value has no `conflicts` entry. Values are compared exactly, after normalization.
- Author kind D11 in the given order; `login` is compared case-insensitively.
- `counts.withTrailers` counts commits with at least one **valid** Graft field.
- U-PROV-1..12.

### T7. Rendering (`render.ts`, pure)

`renderProvenanceSection(r: ProvenanceResult, o: { headSha: string; authorLogin: string }): string` and `renderCheckRunOutput(...same) : { title: string; summary: string }`. The output is byte-exact as in §8. Rendering is deterministic: the same input gives the same string, and there are no timestamps.

AC: U-REN-1..7.

### T8. Managed comment (`src/github/managed-comment.ts`), the contract step 3 reuses

```ts
export const MANAGED_COMMENT_MARKER = "<!-- graft:managed-comment v1 -->";
export const SECTION_ORDER = ["intent", "provenance", "policy"] as const;   // display order
export type SectionName = (typeof SECTION_ORDER)[number];
export const MAX_SECTION_CHARS = 20_000;
export function renderManagedComment(sections: ReadonlyMap<string, string>): string;
export function parseManagedComment(body: string): Map<string, string> | null;   // null if marker is not the first line
export async function upsertManagedSection(octokit: GitHubClient, o: {
  owner: string; repo: string; issueNumber: number; appId: number;
  knownCommentId: number | null; section: SectionName; markdown: string;
}): Promise<{ commentId: number; action: "created" | "updated" | "unchanged" }>;
```

Contract (write it into the file's doc comment and into README §5):

1. **Shape.** The body is the marker line, a blank line, `## Graft`, a blank line, then each section as `<!-- graft:section:<name>:start -->\n<markdown>\n<!-- graft:section:<name>:end -->`, separated by blank lines, then a blank line and `<sub>Maintained by Graft; edits to this comment are overwritten.</sub>`. Known sections appear in `SECTION_ORDER`. Sections with unknown names (`[a-z][a-z0-9-]*`) that were found in an existing body are kept verbatim after the known ones, in their original order.
2. **Ownership.** Each module writes only its own section. `upsertManagedSection` replaces or inserts that one section and keeps every other section byte-for-byte.
3. **Finding the comment.**
   - (a) If `knownCommentId` is set: `GET /repos/{o}/{r}/issues/comments/{id}`. Use it if it returns 200, the marker is the first line, and `performed_via_github_app?.id === appId`. Otherwise fall through to (b).
   - (b) List the issue's comments (`per_page: 100`, at most 10 pages) and take the **first** one that passes the same two checks.
   - (c) If neither finds one, create a new comment.
4. **Update.** If the newly rendered body equals the current body, return `unchanged` without a PATCH. Otherwise PATCH it.
5. **Safety.** Throw if `markdown` contains `<!-- graft:` or is longer than `MAX_SECTION_CHARS`. The rendered body must be ≤ 65,536 characters.
6. **Locking.** Callers must hold `withChangeLock` for the change. They store the returned ID in `changes.graft_comment_id` inside the same lock transaction. Step 3 also mirrors it into `intent_cards.comment_id`.

AC: U-MC-1..8.

### T9. Webhook replay and relabel hardening (coordinator requirement)

Background: the HMAC covers only the body. Anyone who captures a signed body can replay it under a new `X-GitHub-Delivery`, which bypasses the `webhook_deliveries` dedup, or under a different `X-GitHub-Event`. The receiver cannot detect this. Mitigations:

1. **Payload is only a trigger.** No `pull_request` or `check_run` handler writes `changes`, `tasks`, `provenance` or `change_provenance`, or calls GitHub. The handler reads only IDs (and, for D6, the head SHA, base ref and body hash, used just to build the dedup key) and enqueues the job. The job re-fetches the PR (`pulls.get`) and the commits, and writes **only** values from those responses. It also checks that `pull.number === data.prNumber` and `pull.base.repo.id === data.repositoryId`; a mismatch is `PermanentJobError("repo_mismatch")`.
2. **Shape validation per handler.** Every handler parses its payload with `parsePayload` before doing anything:
   - `provenance.schedule` requires `action ∈ {opened, synchronize, reopened, edited, closed}`, `number` (int > 0), `pull_request.{number (=== number), head.sha (40-hex), base.ref (string), body (string|null)}`, `repository.{id, full_name}` and `installation.id`.
   - `provenance.rerequest` requires `action === "rerequested"`, `check_run.{name, head_sha, app.id, pull_requests[].number}`, `repository.{id, full_name}` and `installation.id`.
   - `installations.track` (changed) requires `installation.{id, account, repository_selection}`. When the event is `installation_repositories` it also requires both `repositories_added` and `repositories_removed` arrays. When the event is `installation` it requires `action` to be one of the actions the handler knows; for other actions it logs at debug and returns, as today.
   - Use `.passthrough()`-style objects (zod 4 `z.looseObject`) so that extra fields are allowed.
3. **Replays converge.** Replaying the same body under a fresh delivery ID produces the same D6 key, so no job is created inside the 7-day window. A replay after that window, or a stale payload, only triggers a refresh of the live state (D3). The result cannot be older than the PR.
4. **README.** Add a "Webhook replay" paragraph to §5 Contracts. It says the headers are unauthenticated, lists mitigations 1–3, and states the rule for later steps: *handlers treat payloads as triggers; jobs write only from API data or from data Graft computed.* It also names the residual risk: an attacker who captured a body can force extra API calls after 7 days, but cannot forge state.

AC: U-PAY-1..5, I-SEC-1..4.

### T10. `changes` module

`src/modules/changes/store.ts`, re-exported from `index.ts` (`webhookHandlers = []`, `jobs = []`):

```ts
export interface LivePull {   // the subset of pulls.get we read
  number: number; node_id: string; state: "open" | "closed"; merged: boolean;
  merge_commit_sha: string | null; created_at: string; updated_at: string;
  closed_at: string | null; merged_at: string | null; body: string | null; commits: number;
  user: { login: string; type: string } | null;
  head: { sha: string }; base: { ref: string; repo: { id: number; full_name: string; private: boolean; default_branch: string } };
}
export async function upsertChangeFromPull(ex: Executor, repositoryId: number, pull: LivePull, now: Date):
  Promise<{ change: Selectable<ChangesTable>; applied: boolean }>;
export async function getChange(ex: Executor, id: string): Promise<Selectable<ChangesTable> | undefined>;
export async function findChangeByHead(ex: Executor, repositoryId: number, headSha: string): Promise<Selectable<ChangesTable> | undefined>;
```

AC:
- `INSERT … ON CONFLICT (repository_id, pr_number) DO UPDATE … WHERE changes.pr_updated_at IS NULL OR changes.pr_updated_at <= EXCLUDED.pr_updated_at`. Return the row after the statement (re-select when no row was updated) together with `applied`.
- `state` is `merged` if `merged`, otherwise `pull.state`. `merge_commit_sha` is stored **only when merged**: GitHub fills it with a test-merge SHA on open PRs. A `null` user is stored as `author_login = "ghost"`. `author_is_bot = user.type === "Bot"`.
- `installations.store.ensureRepository(ex, installationId, repo, now): Promise<"active" | "removed">`. It inserts the row if missing (`removed_at NULL`). If the row is active it updates `full_name`, `private` and `default_branch`. If the row is removed it changes nothing and returns `"removed"`. Export it from `installations/index.ts`.

AC: I-CHG-1..4.

### T11. Commit fetching (`fetch.ts`)

`fetchPrCommits(octokit, { owner, repo, prNumber, headSha, commitsTotal }): Promise<{ commits: CommitInput[]; truncated: boolean }>`.

AC:
- Use `octokit.paginate.iterator(octokit.rest.pulls.listCommits, { per_page: 100 })` and stop after 3 pages. Map each item to `{ sha, message: commit.message }`; read nothing else.
- `truncated = commitsTotal > commits.length`. When it is true and `headSha` is not in the list, fetch `octokit.rest.git.getCommit({ commit_sha: headSha })` and append `{ sha, message }`.
- Errors propagate unchanged; the job classifies them.
- U-FETCH-1..3.

### T12. Persistence (`provenance/store.ts`)

`persistProvenance(tx, { change, repositoryId, headSha, result, now }): Promise<void>`. Everything happens in the caller's lock transaction:

1. `DELETE FROM provenance WHERE change_id = $1 AND source IN ('trailer','pr_body')`.
2. Insert one `trailer` row per `result.perCommit` entry (`commit_sha` set), and one `pr_body` row (`commit_sha NULL`) if `prBodyFields` is not null.
3. Task: if `fields.task` resolved, upsert `tasks (repository_id, external_id)`. When the value matches `^#(\d{1,9})$`, set `issue_number` and `issue_url = https://github.com/{full_name}/issues/{n}`. Set `changes.task_id` to the task ID. If no task resolved, set `changes.task_id = NULL`: the trailers are the only source in Phase 0.
4. Upsert `change_provenance` (PK `change_id`) with every column from the result. Keep `check_run_id` unless it is given.

AC: I-PROV-1, I-PROV-4.

### T13. Handlers (`provenance/handlers.ts`)

- **`provenance.schedule`** on `pull_request.opened|synchronize|reopened|edited|closed`. It validates the payload (T9). It skips (debug log) unless the installation row exists and is neither deleted nor suspended. It then sends `provenance.refresh` with data `{ installationId, repositoryId, owner, repo, prNumber, headSha, trigger: action, deliveryId }` and the D6 singleton key. `owner`/`repo` are split from `repository.full_name`. The repository row may be missing (for example a repo created after an `all` install), and the job creates it. The handler does no other DB writes.
- **`provenance.rerequest`** on `check_run.rerequested`. It validates the payload, then ignores the event unless `check_run.name === "graft/provenance"` and `check_run.app.id === config.githubAppId`. The PR number is `check_run.pull_requests[0]?.number`. If that is missing, use `findChangeByHead(repositoryId, check_run.head_sha)?.pr_number`, and if that is missing too, log and return. Send the job with `trigger: "rerequested"` and key `prov-rerun:{deliveryId}`.

AC: I-CHG-5..7, I-PROV-11.

### T14. Job `provenance.refresh` (`provenance/job.ts`)

Options: `retryLimit: 8`, `retryDelaySeconds: 30`, `retryBackoff: true`, `expireInSeconds: 120`. Schema (zod): `installationId`, `repositoryId` and `prNumber` are positive ints; `owner` and `repo` are `^[A-Za-z0-9_.-]{1,100}$`; `headSha` is 40-hex; `trigger` is an enum of the 5 actions plus `rerequested`; `deliveryId` is a string.

Steps:

1. Load the installation. If it is missing, deleted or suspended → log and return.
2. `octokit = ctx.github.forInstallation(installationId)`. If it fails, throw `toJobError(err, "installation token")`.
3. `pull = pulls.get`. Classify errors with `toJobError`. Check the number and repo ID (T9.1).
4. `ensureRepository(ctx.db, installationId, pull.base.repo)`. If it returns `"removed"` → log and return.
5. `{ change, applied } = upsertChangeFromPull(ctx.db, repositoryId, pull, now)`. If `trigger === "closed"` or `pull.state === "closed"` → return (state recorded; no recompute or publish for closed PRs).
6. `fetchPrCommits(...)` using `pull.commits` and `pull.head.sha`.
7. `result = computeProvenance({...})`, with `prAuthor` = `pull.user ?? { login: "ghost", type: "User" }`.
8. `withChangeLock(ctx.db, change.id, async (tx) => { ... })`:
   - Re-read `changes.head_sha`. If it is not `pull.head.sha`, log `stale: head moved` and return. This happens when a newer refresh already advanced the row.
   - `persistProvenance(tx, ...)`.
   - **Check run.** If `change_provenance.check_run_id` is stored and its `head_sha` equals `pull.head.sha`, PATCH that check run. Otherwise call `checks.listForRef({ ref: head, check_name: "graft/provenance", app_id: config.githubAppId, filter: "latest" })`: PATCH the first result if there is one, otherwise POST a new one. The body is `{ name: "graft/provenance", head_sha, status: "completed", conclusion: "neutral", external_id: change.id, completed_at: now, output: renderCheckRunOutput(...) }`. Store `check_run_id`.
   - **Comment.** `upsertManagedSection(octokit, { section: "provenance", markdown: renderProvenanceSection(...), knownCommentId: change.graft_comment_id, appId })`, then store `changes.graft_comment_id`.
   - GitHub errors inside the lock go through `toJobError`. Any error rolls back the transaction, so the retry repeats everything. Steps 3a/3b of T8 and the `listForRef` lookup make sure the retry creates no duplicates.
9. Log one `info` line: `{ changeId, headSha, authorKind, withTrailers, outcome: "published" | "stale" | "closed" | "skipped" }`.

AC: I-PROV-1..10, I-E2E-2.

### T15. Registry, fixtures and helpers

- `buildAppRegistry()` lists `installations`, `changes` and `provenance`, in that order.
- `scripts/generate-fixtures.ts` adds three things, and the outputs are regenerated and committed:
  - `pull_request.reopened` from upstream.
  - `pull_request.edited`, cloned from `opened` with `action: "edited"` and `changes: { body: { from: "Old description." } }`. The upstream examples have no `edited`.
  - `check_run.rerequested` rewritten so that `check_run.name = "graft/provenance"`, `check_run.app.id = 12345` (the test App ID), `repository` is sample-ts (`2000001`), `head_sha` is the PR fixture's head SHA, and `pull_requests = [{ number: 2, head: { sha }, base: {...}, ... }]`.
  - U-FIX-1 and U-FIX-2 still pass, and their lists include the new files.
- `test/helpers/github-builders.ts`: `makePull(overrides)`, `makeCommit(sha, message)` and `commitMessage(subject, body?, trailers?: [string, string][])`, all in the fictional world (repo `graft-sandbox/sample-ts`, ID 2000001, PR 2).
- `test/helpers/fake-github-api.ts`: `createFakeGitHubApi({ appId = 12345 })` returns `{ fetch, requests, state, failNext(method, pathRegex, status, headers?, body?), block(method, pathRegex): { release() } }`. `state` holds `pulls`, `commits` (per PR), `comments` and `checkRuns`. It serves access tokens and the endpoints in T11 and T14, plus comment GET/list/POST/PATCH. List endpoints honour `page`/`per_page` and emit `Link` headers. Comments created through the fake get `performed_via_github_app: { id: appId }` and `user: { login: "graft-dev[bot]", type: "Bot" }`. `requests` records the method, path, query and the JSON body.
- `createTestApp({ github? })` accepts a factory. The default stays `forbiddenGitHub()`.
- Change I-WH-4 to: `ping` → `ignored`; `pull_request` with `action: "labeled"` (built in the test from the `opened` fixture and posted with `postRaw`) → `ignored`; `pull_request.opened` → `enqueued`.

### T16. Review-3 nits

1. `createLogger(config, destination?: pino.DestinationStream)`. U-LOG-1 calls `createLogger` with a capturing stream, not `pino(...)` directly.
2. I-WH-6 asserts `expect(before).toBeTruthy()` before the `toBe(before)` comparison.

### T17. Docs

- README §5: the module list (`changes`, `provenance`), the managed-comment contract (T8, summarized with a link to the file), `withChangeLock`, `PermanentJobError`, and the webhook replay paragraph (T9.4).
- README §6: the `checks` row adds `graft/provenance` (step 2). The `pull_requests` row adds "list PR commits (step 2)". The `contents` row adds "`git.getCommit` for the head commit when a PR has more than 250 commits". The manifest itself is **unchanged**.
- README: a new section, "Provenance trailers for agents", with the four keys, an example (`git commit --trailer "Graft-Agent: claude-code" --trailer "Graft-Model: claude-sonnet-5-5" ...`), the value rules from §6.3, the precedence rules and the agent-vs-human rule.
- README §7: record every deviation.
- `.env.example`: both new variables, with comments.
- `HUMAN-TODO.md`, under "Step 2: Provenance":
  - [ ] Configure the first harness (Claude Code) to add `Graft-*` trailers: instruct it in the project's `CLAUDE.md`, or use a `prepare-commit-msg` hook. Who: repo owner.
  - [ ] Open a PR in `sample-ts` with trailers and check the comment and the `graft/provenance` check. Then force-push without trailers and check that the output flips to "Human" (or to "Agent (agent co-author)").
  - [ ] Confirm that comments created by the App carry `performed_via_github_app.id`. If they do not, report it, because D13 then needs the bot-login fallback.
  - [ ] Decide `GRAFT_AGENT_LOGINS` for the pilots. Who: product owner.

## 6. Parsing rules

### 6.1 Trailer block (`parseTrailerBlock`)

| # | Rule |
| --- | --- |
| P1 | Turn `\r\n` and `\r` into `\n`. Drop trailing lines that are empty or whitespace-only. |
| P2 | Size cap: if the text is longer than 16,384 characters, keep only the last 16,384 and drop the first (partial) line. Set `truncated: true`, which becomes a `message_truncated` warning. |
| P3 | Paragraphs are separated by one or more whitespace-only lines. The candidate block is the **last** paragraph. With `hasTitle: true`, a message with a single paragraph has no trailers, because the subject is never a trailer block. |
| P4 | Trailer line: `^([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*)$`. Continuation line: starts with a space or tab and follows a trailer or continuation line. Any other line is non-trailer. |
| P5 | The block counts as trailers if **every** line is a trailer or continuation line, **or** at least 25% of its lines are trailer lines and at least one key is `Graft-*`, `Signed-off-by` or `Co-authored-by` (case-insensitive). Otherwise the result is `[]`. Non-trailer lines in an accepted block are skipped. |
| P6 | Unfold: a continuation's trimmed text is appended to the previous value with one space. The value is trimmed. |
| P7 | If the candidate block has more than 100 lines → return `[]` with a `block_too_long` warning (surfaced by T5). |
| P8 | Keys keep their written case; matching (T5) is case-insensitive. Order is preserved. |

### 6.2 Graft fields (`extractGraftFields`)

| # | Rule |
| --- | --- |
| F1 | Match keys case-insensitively against `TRAILER_KEYS`. Any other key starting with `graft-` → `unknown_graft_key` warning (code only). |
| F2 | Raw value longer than 2,048 characters → `value_too_long`; empty after trim → `empty_value`. The value is ignored in both cases. |
| F3 | Validate per §6.3. Failure → `invalid_value` (`invalid_session_url` for `session`). |
| F4 | The same key appears twice with **different** valid values → the last one wins and a `duplicate_key` warning is added. Identical repeats produce no warning. |
| F5 | `Co-authored-by: Name <email>`: take the email from `<([^<>\s]+@[^<>\s]+)>\s*$`. If its lowercase form is in `agentCoauthorEmails`, `agentCoauthor = true`. The email itself is never returned. |
| F6 | Warnings never contain the rejected value. |

### 6.3 Values

| Field | Normalize | Valid when |
| --- | --- | --- |
| agent | trim; collapse runs of whitespace to one space | `^[A-Za-z0-9][A-Za-z0-9 ._:/@+()-]{0,99}$` |
| model | trim | `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$` |
| task | trim | `^[A-Za-z0-9#][A-Za-z0-9._:/#@+-]{0,127}$` |
| session | trim; `new URL()`; output `url.href` with `(`, `)`, `[`, `]` percent-encoded | ≤ 2,048 characters; parses; `protocol === "https:"`; empty `username` and `password`; `hostname` is not empty, not `localhost`, does not end in `.localhost`, is not an IPv4 dotted quad and is not a bracketed IPv6 address |

All character sets are ASCII, so bidi controls, zero-width characters, backticks, `<`, `>`, `|` and newlines are rejected by construction.

### 6.4 Examples (each one is a U-TRL or U-FLD case)

| Input (commit message; `⏎` = newline) | Result |
| --- | --- |
| `Fix bug⏎⏎Graft-Agent: claude-code⏎Graft-Model: claude-sonnet-5-5` | agent `claude-code`, model `claude-sonnet-5-5` |
| `Graft-Agent: claude-code` (one paragraph) | nothing (subject is not a trailer block) |
| `Fix⏎⏎graft-agent: x⏎GRAFT-MODEL: y` | agent `x`, model `y` |
| `Fix⏎⏎Graft-Agent : claude-code` | agent `claude-code` (spaces before `:`) |
| `Fix⏎⏎Graft-Task: ABC-1⏎Graft-Agent: claude⏎  code` | agent `claude code` (continuation unfolded) |
| `Fix⏎⏎Graft-Agent: a⏎⏎Some prose after` | nothing (last paragraph is prose) |
| `Fix⏎⏎Body text⏎Graft-Agent: a⏎Signed-off-by: X <x@y>⏎more⏎text` | agent `a` (2 of 5 lines = 40% ≥ 25% and a known key; prose lines skipped) |
| `Fix⏎⏎note: one⏎prose⏎prose⏎prose⏎prose` | nothing (20% < 25%) |
| `Fix⏎⏎Graft-Agent: a⏎Co-authored-by: Claude <noreply@anthropic.com>` | agent `a`, `agentCoauthor` true |
| `Fix⏎⏎Co-Authored-By: Claude <NoReply@Anthropic.com>` | no fields, `agentCoauthor` true |
| `Fix⏎⏎Graft-Agent: a⏎Graft-Agent: b` | agent `b`, `duplicate_key` |
| ``Fix⏎⏎Graft-Agent: `rm -rf` <img>`` | `invalid_value` |
| `Fix⏎⏎Graft-Agent: claude‮edoc` (U+202E) | `invalid_value` |
| `Fix⏎⏎Graft-Session: http://x.dev/s/1` | `invalid_session_url` |
| `Fix⏎⏎Graft-Session: https://u:p@x.dev/s` | `invalid_session_url` |
| `Fix⏎⏎Graft-Session: https://10.0.0.1/s` / `https://[::1]/s` / `https://localhost/s` | `invalid_session_url` |
| `Fix⏎⏎Graft-Session: https://claude.ai/code/s(1)` | session `https://claude.ai/code/s%281%29` |
| `Fix⏎⏎Graft-Agentx: a` / `Graft-Foo: a` | no field; `unknown_graft_key` |
| `Fix⏎⏎Graft-Agent:` | `empty_value` |
| `Fix\r\n\r\nGraft-Agent: a\r\n` | agent `a` |
| 20,000 × `x` then `⏎⏎Graft-Agent: a` | agent `a`, `message_truncated` |
| PR body `Graft-Agent: a` (`hasTitle: false`) | agent `a` |

Rows 1–10 and 20–22 are U-TRL cases; rows 11–19 are U-FLD cases.

## 7. Schema changes (migration `0002_provenance`)

```sql
ALTER TABLE changes
  ADD COLUMN pr_updated_at    timestamptz,                     -- GitHub pull.updated_at of the applied snapshot (D4)
  ADD COLUMN author_is_bot    boolean NOT NULL DEFAULT false,
  ADD COLUMN graft_comment_id bigint;                          -- the managed comment (T8)

ALTER TABLE provenance DROP CONSTRAINT provenance_source_check;  -- verify the name in 0001; use it exactly
ALTER TABLE provenance ADD CONSTRAINT provenance_source_check
  CHECK (source IN ('trailer','pr_body','mcp'));
-- UNIQUE NULLS NOT DISTINCT (change_id, source, commit_sha) from 0001 already gives one pr_body row per change.

CREATE TABLE change_provenance (                               -- one row per change; the resolved view
  change_id              uuid PRIMARY KEY REFERENCES changes(id) ON DELETE CASCADE,
  head_sha               text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  author_kind            text NOT NULL CHECK (author_kind IN ('agent','human')),
  author_kind_reason     text NOT NULL CHECK (author_kind_reason IN ('trailer','bot_account','configured_login','agent_coauthor','none')),
  agent                  text,
  model                  text,
  task_external_id       text,
  session_url            text,
  field_sources          jsonb NOT NULL DEFAULT '{}',   -- {"agent":{"source":"commit","commitSha":"…"}, …}
  conflicts              jsonb NOT NULL DEFAULT '{}',   -- {"model":["a","b"]}
  warnings               jsonb NOT NULL DEFAULT '[]',   -- ProvenanceWarning[] (codes only, no values)
  commits_total          integer NOT NULL,
  commits_scanned        integer NOT NULL,
  commits_with_trailers  integer NOT NULL,
  agent_coauthor_commits integer NOT NULL,
  commits_truncated      boolean NOT NULL DEFAULT false,
  check_run_id           bigint,
  computed_at            timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_provenance_author_kind_idx ON change_provenance (author_kind);
```

`down` drops `change_provenance`, restores the `('trailer','mcp')` check (after deleting any `pr_body` rows) and drops the three columns. There is still no column for code, diffs, messages or emails.

## 8. GitHub output (byte-exact; `⏎` omitted, lines shown literally)

`renderProvenanceSection` for an agent PR. Here the model has a conflict, the session comes from the body, and there is one warning:

```markdown
### Provenance

| | |
| --- | --- |
| **Authored by** | Agent (Graft trailers) |
| **Agent** | `claude-code` |
| **Model** | `claude-sonnet-5-5` · commits disagree: `claude-sonnet-5-5`, `claude-haiku-5-5` |
| **Task** | `#42` |
| **Session** | [claude.ai](https://claude.ai/code/session/abc) (from PR description) |
| **Opened by** | `graft-dev` |

Head `ec26c3e` · 3 commits, 2 with Graft trailers.

<details><summary>1 provenance warning</summary>

- `ab12cd3`: Graft-Session ignored (invalid_session_url)

</details>
```

Rules:

- **Authored by** text per reason: `trailer` → `Agent (Graft trailers)`; `bot_account` → `Agent (bot account)`; `configured_login` → `Agent (configured agent login)`; `agent_coauthor` → `Agent (agent co-author)`; `none` → `Human`.
- **Rows.** The Agent, Model and Task rows always appear. A missing value renders as `not reported`. The Session row appears only when a session is set; it is rendered as `[<hostname>](<href>)`.
- **Source and conflicts.** ` (from PR description)` is appended when `source === "pr_body"`. ` · commits disagree: ` is followed by the conflict values (newest first, each in a code span), joined by `, `.
- **Footer line.**
  - Format: ``Head `<sha7>` · <total> commit(s), <withTrailers> with Graft trailers.`` "commit" is singular when the total is 1.
  - When truncated, append ` Only the first 250 commits and the head commit were scanned.`
  - When `withTrailers === 0` and nothing came from the body, the line is instead: ``Head `<sha7>` · no `Graft-*` trailers found. Agents can declare provenance with `Graft-Agent`, `Graft-Model`, `Graft-Task` and `Graft-Session` git trailers.``
- **Warnings.** The `<details>` block appears only when there are warnings: "1 provenance warning", "N provenance warnings". At most 10 items are listed, plus `- …and K more` when there are more. Each item is `` `<sha7>` `` or `PR description`, then `: <Trailer-Key> ignored (<code>)`; `message_truncated` renders as `: message truncated before parsing`.
- **Login.** The opener's login is shown in a code span; a login with `[bot]` stays as it is.

The managed comment for this step (no intent or policy sections yet):

```markdown
<!-- graft:managed-comment v1 -->

## Graft

<!-- graft:section:provenance:start -->
### Provenance
…section above…
<!-- graft:section:provenance:end -->

<sub>Maintained by Graft; edits to this comment are overwritten.</sub>
```

Check run `graft/provenance`: `conclusion: "neutral"` always.

- `output.summary` = `renderProvenanceSection(...)`.
- `output.title`:
  - Agent: `Agent: <agent or "unknown"> · Model: <model or "unknown">`.
  - Human: `Human-authored (no agent provenance)`.
  - Truncated to 100 characters with `…`.

## 9. Test plan

Every test runs offline. Use the IDs as `it(...)` title prefixes. GitHub is reached only through `createFakeGitHubApi().fetch` injected into `createGitHubClientFactory`, or through a stub `GitHubClient` in unit tests. Fixed clock as in step 1.

**Unit** (`test/unit/`)

| ID | Case |
| --- | --- |
| U-TRL-1..18 | One per §6.4 row 1–10 and 20–22 (13 cases), plus: P7 block of 101 lines → `[]`; whitespace-only separator lines count as blank; continuation with tab; non-trailer line inside an accepted block is skipped; empty input → `[]`; `hasTitle:false` one-paragraph body parsed. |
| U-FLD-1..13 | backtick/`<img>`, U+202E, `http:`, userinfo, IPv4, IPv6, localhost, parens encoding, 2,049-char value, `empty_value`, `duplicate_key`, `unknown_graft_key`, and warnings contain no rejected value (assert `JSON.stringify(warnings)` lacks the input). |
| U-PROV-1 | Newest commit wins per field; an older commit fills a field the newest lacks. |
| U-PROV-2 | Body fills only missing fields; commit value beats a different body value; body value appears in `conflicts`. |
| U-PROV-3 | Two commits with different agents → `conflicts.agent` newest-first; single distinct value → no entry. |
| U-PROV-4 | No trailers, author `type: "User"` → `human`/`none`. |
| U-PROV-5 | No trailers, author `type: "Bot"` → `agent`/`bot_account`. |
| U-PROV-6 | Author login `Claude-Bot` with `agentLogins: ["claude-bot"]` → `configured_login`. |
| U-PROV-7 | Only `Co-authored-by` agent email → `agent_coauthor`; `counts.agentCoauthor` correct. |
| U-PROV-8 | Reason precedence: trailer + bot author → `trailer`. |
| U-PROV-9 | `perCommit` contains only commits with ≥1 valid field; `withTrailers` ignores commits with only invalid values. |
| U-PROV-10 | Warnings carry `commitSha`/`source`; capped at 50. |
| U-PROV-11 | Truncated input propagates to `counts.scanned` vs `total`. |
| U-PROV-12 | Pure: same input twice → deep-equal output; input arrays not mutated. |
| U-REN-1 | §8 example renders byte-exact. |
| U-REN-2 | Human PR with no trailers renders the "no `Graft-*` trailers found" line and `Human`. |
| U-REN-3 | Truncated footer sentence. |
| U-REN-4 | Warnings: singular/plural summary; >10 → `…and K more`. |
| U-REN-5 | Check-run title for agent, human and 150-char agent (truncated with `…`). |
| U-REN-6 | Deterministic: two renders equal; no date strings. |
| U-REN-7 | An agent value `@octo/bot` renders only inside a code span (no bare `@` mention); output never contains `<!-- graft:`. |
| U-MC-1 | `renderManagedComment` with only `provenance` matches §8 byte-exact. |
| U-MC-2 | Parse → render round-trip keeps `intent` and an unknown `zz-future` section byte-for-byte. |
| U-MC-3 | `parseManagedComment` returns `null` when the marker is not the first line. |
| U-MC-4 | `upsertManagedSection` with `knownCommentId` valid → PATCH only that comment; other sections preserved. |
| U-MC-5 | `knownCommentId` 404 → lists comments, finds ours by marker + app id, PATCHes it. |
| U-MC-6 | A comment with the marker but `performed_via_github_app.id` ≠ appId (or absent) is ignored → creates a new comment. |
| U-MC-7 | Rendered body equal to current → `unchanged`, no PATCH request. |
| U-MC-8 | Section containing `<!-- graft:` or > 20,000 chars throws before any request. |
| U-GHE-1 | 404/410 → `not_found`; 422 → `invalid`. |
| U-GHE-2 | 429; 403 + `x-ratelimit-remaining: 0`; 403 + `retry-after`; 403 "secondary rate limit" → `rate_limited`. |
| U-GHE-3 | Plain 403 and 401 → `forbidden`; 502 and a `TypeError("fetch failed")` → `transient`. |
| U-GHE-4 | `toJobError` returns `PermanentJobError` (with `reason`) for permanent classes and the original error otherwise. |
| U-FETCH-1 | 130 commits → 2 pages via `Link`, order preserved, `truncated: false`, no `git/commits` request. |
| U-FETCH-2 | `commitsTotal: 312`, fake serves 250 → stops after 3 pages, fetches head via `GET /repos/.../git/commits/{sha}`, appended last, `truncated: true`. |
| U-FETCH-3 | Truncated but head already in the list → no extra request. |
| U-PAY-1 | `provenance.schedule` with an `installation.created` body under event `pull_request` → `payload_shape_mismatch` warn, no `queue.send` (FakeJobQueue). |
| U-PAY-2 | `pull_request` body with `number` ≠ `pull_request.number` → rejected. |
| U-PAY-3 | `provenance.rerequest` with a `pull_request` body under event `check_run` → rejected. |
| U-PAY-4 | `installations.track` with a `pull_request.opened` body under event `installation_repositories` → rejected, untouchable DB never touched. |
| U-PAY-5 | The warn log carries issue paths only (assert the body's `title`/`body` strings absent from captured log). |
| U-CFG-7 | Defaults (`[]`, `["noreply@anthropic.com"]`); parsing/lowercasing/trimming; a login `bad login` and an email without `@` are rejected naming the variable only. |
| U-LOG-1 | (revised) Uses `createLogger(config, stream)`; same assertions as before. |

**Integration** (`test/integration/`, real Postgres and pg-boss; fake GitHub API)

| ID | Case |
| --- | --- |
| I-DB-1 | (updated) ten tables, including `change_provenance`. |
| I-DB-3 | (updated) one row inserted/selected in `change_provenance`; a `provenance` row with `source='pr_body'`. |
| I-DB-5 | (extended) rejects `provenance.source='foo'`, `change_provenance.author_kind='robot'`, `author_kind_reason='x'`. |
| I-DB-7 | `0002` down then up succeeds; after down, `pr_body` is rejected again and `change_provenance` is gone. |
| I-LOCK-1 | Two concurrent `withChangeLock` on the same change run strictly one after the other (timestamps); different changes overlap. |
| I-Q-4 | A registered test job throwing `PermanentJobError` ends `completed` with `retry_count = 0`; a plain `Error` is retried (state `retry`). |
| I-CHG-1 | `upsertChangeFromPull` inserts all fields; open PR with a `merge_commit_sha` stores NULL. |
| I-CHG-2 | Older `updated_at` after newer → `applied: false`, row unchanged; equal `updated_at` → `applied: true` (idempotent). |
| I-CHG-3 | Merged pull → `state='merged'`, `merge_commit_sha`, `merged_at` set. |
| I-CHG-4 | `ensureRepository`: missing → inserted; removed → `"removed"`, row unchanged; renamed → `full_name` updated. |
| I-CHG-5 | Handler on `pull_request.opened` → exactly one `provenance.refresh` job with the D6 key; **no** `changes` row written by the handler. |
| I-CHG-6 | `edited` with a new body → second job; title-only `edited` (same body) → `send` returns `null`. |
| I-CHG-7 | Handler skips when the installation is suspended or missing (no job). |
| I-PROV-1 | Job end-to-end: 3 commits (2 with trailers, model conflict), body with `Graft-Session` → `provenance` rows (2 `trailer`, 1 `pr_body`), `change_provenance` matches, `tasks` row with `issue_number = 42`, `changes.task_id` set, one check-run POST (body asserted: name, head_sha, neutral, external_id, title, summary = §8) and one comment POST equal to U-MC-1 output; `graft_comment_id` and `check_run_id` stored. |
| I-PROV-2 | Running the job again unchanged → check run PATCHed (no POST), comment `unchanged` (no PATCH, no POST); DB rows identical except `updated_at`. |
| I-PROV-3 | Stale: `changes` already holds a newer `pr_updated_at`/head than `pulls.get` returns → no `provenance`/`change_provenance` writes, no check or comment requests. |
| I-PROV-4 | Force-push: second run where trailers and task are gone → old `trailer` rows deleted, `changes.task_id` NULL, comment PATCHed to human output. |
| I-PROV-5 | `pull.commits = 312` → `commits_truncated`, `git/commits` fetched, output footer has the truncation sentence. |
| I-PROV-6 | `pulls.get` 403 + `x-ratelimit-remaining: 0` → job handler throws (retryable); nothing written. |
| I-PROV-7 | `pulls.get` 404 → handler throws `PermanentJobError`; nothing written. |
| I-PROV-8 | Comment created then check-run POST fails 500 → transaction rolled back (no `change_provenance` row); rerun finds the comment via the list and PATCHes it → exactly one Graft comment. |
| I-PROV-9 | A human comment containing the marker exists → ignored; Graft creates its own. |
| I-PROV-10 | Concurrency: job A (head A) is paused inside the comment PATCH via `fake.block` while holding the lock; the test sets the PR to head B (newer `updated_at`) in the fake; job B starts and waits on the lock; release A. Final comment and `change_provenance.head_sha` reflect B; B's run happened after A's (request order). |
| I-PROV-11 | `check_run.rerequested` fixture → job with key `prov-rerun:<deliveryId>`; a second rerequest with a new delivery → second job; `check_run.name = "other"` or other app id → no job; empty `pull_requests` → PR resolved via `findChangeByHead`. |
| I-PROV-12 | Closed trigger → `changes.state` updated from the live PR; no commits/check/comment requests. |
| I-SEC-1 | Replay: the same signed `pull_request.synchronize` body posted under two delivery IDs → two `webhook_deliveries` rows, **one** `provenance.refresh` job. |
| I-SEC-2 | Stale payload: webhook says head A, fake `pulls.get` says head B → after the job, `changes.head_sha = B`, provenance/check computed for B; no request or row mentions A. |
| I-SEC-3 | An `installation.created` body posted with `x-github-event: pull_request` → 202 (receiver cannot tell), dispatch job completes, no `provenance.refresh` job, no `changes` row, warn logged. |
| I-SEC-4 | A `pull_request.opened` body posted with `x-github-event: installation_repositories` → no `installations`/`repositories` writes. |
| I-WH-4 | (updated per T15) |
| I-WH-6 | (nit) asserts `before` is truthy. |
| I-E2E-2 | Server (`inject`) + running worker + fake GitHub: signed `pull_request.opened` (body rewritten to carry trailers, re-signed) → within 10 s a `change_provenance` row exists and the fake recorded one comment POST and one check-run POST. |

## 10. Definition of done

From a clean clone with Docker running, no network beyond install and image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test                         # every ID in §9 present and passing, step 1 IDs still passing
pnpm build
pnpm db:migrate && pnpm db:status # 0001 and 0002 applied
pnpm db:rollback && pnpm db:migrate
grep -rnE "@ts-(ignore|expect-error)" src/ && exit 1 || true
grep -rn "I-SEC-\|U-PAY-\|U-TRL-\|I-PROV-" test/ | wc -l   # non-zero
```

Manual smoke (record in the PR description): run `pnpm dev:server` and `pnpm dev:worker`, then `pnpm webhook:send pull_request.opened --delivery smoke-2` → `202 {"status":"enqueued"}`; repeat with `--delivery smoke-3` → `202 enqueued` but `select count(*) from pgboss.job where name='provenance.refresh'` stays 1 (replay dedup). The worker logs a GitHub token failure (throwaway key, offline) classified as permanent or transient — not a crash.

Also required:
- The reviewer can grep that no `pull_request`/`check_run` handler calls `ctx.db.insertInto`/`updateTable` or any Octokit method (T9.1).
- No column, log line or warning stores a commit message, body text, email or rejected trailer value.
- README §5/§6/§7, "Provenance trailers for agents", `.env.example` and `HUMAN-TODO.md` updated per T17. `github/app-manifest.json` and U-MAN-1 unchanged.
