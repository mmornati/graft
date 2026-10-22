# Phase 1, Step 4: Post-merge guard, detection and culprit

Spec for the developer agent. Implement exactly this. Where it is silent, choose the simplest option and record it in [docs/decisions.md](../decisions.md) under a new heading "Phase 1 step 4: guard detection". The [Phase 0 constraints](../phase-0/README.md#constraints-for-every-step) are binding: offline build and test, Postgres from `docker compose`, **no stored code, diffs, logs or file contents**, pnpm, Node 24, strict TypeScript. The code as it is after step 2 is described in [docs/architecture.md](../architecture.md) (including the modes contract of steps 1 and 2) and [docs/decisions.md](../decisions.md). Where this spec and those documents disagree on an existing interface, they win and you record the difference. The plan for the whole phase is [phase-1/README.md](README.md).

This step depends only on step 1 (step 2 is merged and changes nothing it relies on). It can be built at the same time as step 3, which works in `src/modules/policy` (see §12, "Parallel work").

Binding rules from earlier steps:
- **Payloads are triggers** ([architecture.md](../architecture.md#webhook-replay)). CI results, commit history and the PR behind a commit are read from the API inside jobs, never from a webhook payload. A payload field may only decide *whether* to enqueue.
- **Lock discipline**: no slow work inside `withChangeLock`.
- **Spec fix 3** (development plan): the culprit comes from CI results that already exist. Graft never re-runs a check, never bisects, and never creates a commit, branch or PR in this step.
- **Report mode stays inert.** The guard's only GitHub write is one comment per guard event on the culprit PR. That uses a `phase0` route Graft already uses (decided 2026-10-21, README §6). Nothing in this step uses the `guard` feature client or any `phase1` route. That is step 5.

## 1. Goal

Watch the default branch, find the PR that turned a check red, and say so:

- **History.** Track the first-parent chain of each repository's default branch from `push` events, read through the API. Map each commit to the merged PR that produced it (§5).
- **CI results.** For each default-branch commit, store the latest result of every check run and commit status as `green`, `red` or `ignored`, keyed by check. Only the name, source and conclusion are stored, never logs or output (§6).
- **Detection.** When a check is red on a commit and was green on the nearest earlier commit that has a result for it, open a guard event. If the commits in between belong to exactly one PR, that PR is the **culprit**. If they belong to several, the event is **ambiguous**. If no PR is behind them, the event is **no_culprit** (§7).
- **Confirmation.** On by default. A culprit is confirmed only when the failure persists: the next commit is red on the same check, or the confirmation window elapses with the commit still red. A check that turns green again first (re-run or next commit) makes the event **flaky** and nothing else happens (§7).
- **Report.** A confirmed culprit gets one comment on its PR: "CI check `test` went red on `main` at `abc1234` after this merge; Graft would open a revert." Ambiguous, flaky and no-culprit events are only visible in the ops CLI (`graft guard list`) and the database (§8).
- **Same behaviour in every mode.** `guard_mode: enforce` changes nothing in this step except the comment wording (§8). The revert path does not exist yet.

## 2. Out of scope

Do not create stub code for any of these.

- Revert trees, branches, commits, PRs, labels, auto-merge, `contents: write` (step 5). Do not call `forInstallation(id, { feature: "guard" })`.
- `guard.auto_merge_reverts` and any other `graft.yaml` guard key except `guard.checks` (§9).
- Break-glass marking (step 3). When step 3 lands, it adds "merged under break-glass" to the guard event. Nothing here waits for it.
- Re-running checks or bisecting (spec fix 3).
- Guard metrics in `gate report` (step 7). This step stores what step 7 needs.
- Branches other than the repository's default branch.
- Merge queues (`merge_group`). A `gh-readonly-queue/…` commit is not on the default branch, so it is never tracked.
- Reading check run output, annotations or logs, or workflow run logs.
- A web UI.

## 3. Decisions

| # | Area | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | Which results | Check runs from every app (`GET /repos/{o}/{r}/commits/{sha}/check-runs`, `filter=latest`, `checks: read`, which Graft already has through `checks: write`) and commit statuses (`GET /repos/{o}/{r}/commits/{sha}/status`, `statuses: read`). Graft's own checks (`app.id === GITHUB_APP_ID`) are skipped. | GitHub Actions jobs are check runs, so the checks API covers them without `actions: read`. Statuses cover older CI systems. |
| D2 | Permissions | Add `statuses: read` and the `status` and `check_suite` events to both manifests. **Do not add `actions: read`** or `workflow_run`. This deviates from README §4. Record it. Without `statuses: read` (missing in the stored permissions, or never read), statuses are not read and the guard works on check runs alone. `graft mode show` and `pilot doctor` say so. | Least privilege. `check_run` is already subscribed. `check_suite.completed` is one more trigger for the same API read. |
| D3 | Result classes | Check run `conclusion`: `success` → `green`; `failure`, `timed_out`, `startup_failure` → `red`; `neutral`, `skipped`, `cancelled`, `action_required`, `stale`, null (not completed) → `ignored`. Status `state`: `success` → `green`; `failure`, `error` → `red`; `pending` → `ignored`. | `cancelled` is how `cancel-in-progress` supersedes runs on a busy `main`. Counting it as red would blame innocent merges. |
| D4 | Check key | Check run: `run:<app_id>:<name>`. Status: `status:<context>`. Name and context are truncated to 200 characters and stored. Two check runs with the same name and app on one commit (matrix jobs share names only if misconfigured): the latest `completed_at` wins, as with `filter=latest`. | A check from another app with the same name is a different check. The name is CI configuration text, not code or PR text. |
| D5 | History source | A `push` to `refs/heads/<default_branch>` enqueues `guard.track`. The job reads `GET /repos/{o}/{r}/commits?sha=<after>&per_page=100` (no file lists) and walks first parents until it reaches a SHA it already stores, the push's `before`, or 300 commits. Each new commit is stored with its first parent and a per-repository increasing `seq`. A forced push, an unknown `before`, or the 300-commit cap stores the oldest new commit with `chain_break = true`. Detection never looks past a break. | Payloads are triggers. First parents are the merge history of the default branch. A break is honest about what Graft did not see. |
| D6 | Commit → PR | First from `changes` (`state = 'merged'`, `merge_commit_sha = sha`, same repository). Otherwise `GET /repos/{o}/{r}/commits/{sha}/pulls`: the merged PRs whose base is the default branch. Exactly one → that PR (and `upsertChangeFromPull` after `pulls.get`, so a `changes` row exists). None → direct push. Several → `multiple`. At most 20 API lookups per `guard.track` job; past that, commits are stored with `pr_source = 'unresolved'`. | Rebase merges produce several commits whose `merge_commit_sha` is only the last one. The commit-pulls API maps all of them. |
| D7 | Culprit rule | For a red key on commit N, take the nearest earlier commit on the chain (no break crossed) with a non-ignored result for that key. It must be `green`; otherwise main was already red and nothing happens. The **candidates** are the commits after that green one, up to and including N. If they all map to one and the same PR → `culprit_found` (pending confirmation). If any is `multiple`, or they map to two or more PRs → `ambiguous`. If any is `unresolved` → `ambiguous`. If none maps to a PR → `no_culprit`. No green commit before a break, or none at all → nothing (`no_baseline`, logged at debug). | Spec fix 3, generalised to rebase merges and to commits where CI did not run. |
| D8 | One event per failing commit | `guard_events` keeps `UNIQUE (repository_id, failing_sha)`. Several keys going red on the same commit are one event with several `failing_checks`. A key that goes red on a later commit while an event is open for the same culprit adds to that event's checks. It does not open a new event. | One PR, one story, one comment. |
| D9 | Confirmation | `GRAFT_GUARD_CONFIRM` (`on`/`off`, default `on`). When on, a new event starts as `confirming`. It becomes `culprit_found` / `ambiguous` / `no_culprit` when (a) the next commit on the chain has a `red` result for at least one of the event's keys, or (b) `GRAFT_GUARD_CONFIRM_SECONDS` (default 7200) have passed since detection and N's latest result for at least one key is still red. It becomes `flaky` when, before that, every failing key of N is green again on N (re-run) or green on the next commit. A `guard.confirm` job is scheduled at the deadline. When off, the outcome is final at detection. | Decided 2026-10-21. A next-commit-only rule never confirms on a quiet repository, so the time bound keeps it useful. |
| D10 | Report-mode write | For `culprit_found` only, one new comment on the culprit PR, through the default (non-feature) installation client: `POST /repos/{o}/{r}/issues/{n}/comments`, which is already `phase0`. The first line is a hidden marker `<!-- graft:guard-event <event id> -->`. The job first lists the PR's comments (at most 10 pages, App-authored only, like the managed comment's rule 3) and does nothing if the marker is already there. The comment id is stored on the event. The comment mentions no user or team: logins and team names are code spans. | A new comment notifies the PR's participants, which is the point. A section in the managed comment would be a silent edit on a closed PR. The marker makes retries idempotent. |
| D11 | Locks | The comment is written under `withChangeLock(culpritChangeId)`, with the event row updated in the same transaction. Detection itself takes a per-repository advisory lock (`pg_advisory_xact_lock(hashtext('guard:' \|\| repository_id))`) around reading results and writing events, with no GitHub calls inside. | Two `guard.observe` jobs for neighbouring commits must not both open an event for the same transition. |
| D12 | Observe timing | Every trigger enqueues `guard.observe { installationId, repositoryId, owner, repo, sha }` with `startAfterSeconds: GRAFT_GUARD_OBSERVE_DELAY_SECONDS` (default 30) and singleton `guard:observe:<repositoryId>:<sha>:<floor(now/30 s)>`. | A suite of 20 checks completing within a minute costs a few API reads, not 20. |
| D13 | Trigger filter | `check_run.completed`, `check_suite.completed` and `status` enqueue only when the payload's branch hint names the default branch: `check_suite.head_branch`, `check_run.check_suite.head_branch`, or for `status`, `branches[].name`. They also skip when the check's app id is Graft's own (check runs only). If the job finds that the SHA is not a tracked default-branch commit, it calls `guard.track` inline for the default branch tip once. If the SHA is still unknown, it stops (`not_on_default_branch`). | PR checks are most of the `check_run` volume. Dropping them in the handler keeps the queue quiet. The job still verifies, so a lying payload can only cause a no-op. |
| D14 | Kill switch | `GRAFT_GUARD_DETECTION` (`on`/`off`, default `on`). Off: the handlers drop everything and the crons do nothing. | An operator can stop the guard without touching modes. |
| D15 | Retention | `main_commits` and `ci_results` rows older than `GRAFT_GUARD_RETENTION_DAYS` (default 30) are deleted by the daily cron `guard.prune`, except commits referenced by an open event (`confirming`). Both tables join the pilot purge map through `repositories`. | Detection needs a few days of history, not all of it. Bounded storage. |
| D16 | Mode wording | The comment ends with one line. Report: `Graft mode: report. Graft opens nothing; this is what it would do.` Enforce: `Graft mode: enforce. Revert PRs are not available in this version; nothing was opened.` (Step 5 replaces the enforce line.) The mode is read with `getEffectiveModes` when the comment is written and stored on the event. | Reviewers know which mode applies. Behaviour does not depend on it. |
| D17 | Repository config | `graft.yaml` at N gains an optional `guard.checks`: a list of 1–50 exact check names or status contexts, at most 200 characters each, matched case-sensitively. When present, only those keys can open an event. When absent, every key can. `guard` with any other key is `unknown_key`, like everywhere else. The policy is read with the existing loader at commit N (cached per commit). A missing or invalid policy means "every key". | Teams with known-flaky optional checks can scope the guard. It is read from the default branch only, as with the rest of `graft.yaml`. |

## 4. Files

New:

| File | What |
| --- | --- |
| `src/guard/detect.ts` | Pure: result classification (D3), keys (D4), `detectTransitions()`, `classifyCandidates()`, `confirmationStep()` (§7). No `db`, `github` or `modules` imports. |
| `src/modules/guard/store.ts` | `main_commits`, `ci_results`, `guard_events` reads and writes; advisory lock helper. |
| `src/modules/guard/track.ts` | `guard.track` job (D5, D6). |
| `src/modules/guard/observe.ts` | `guard.observe` and `guard.confirm` jobs (§7). |
| `src/modules/guard/comment.ts` | `renderGuardComment()`, `publishGuardComment()` (D10). |
| `src/modules/guard/handlers.ts` | `push`, `check_run.completed`, `check_suite.completed`, `status` handlers (D13). |
| `src/modules/guard/cli.ts` | `graft guard list` (§10). |
| `src/modules/guard/index.ts` | Module exports: `jobs`, `handlers`, `crons`. |
| `src/db/migrations/00NN_guard.ts` | §11. `NN` is the next free number at merge time (§12). |
| `test/unit/guard-detect.test.ts`, `test/unit/guard-comment.test.ts` | §13. |
| `test/integration/guard.test.ts` | §13. |
| `test/fixtures/webhooks/check_run.completed.json`, `check_suite.completed.json`, `status.json`, `push.default.json` | Trigger fixtures. |
| `docs/features/guard.md` | User-facing page (T11). |

Changed: `src/config/index.ts`, `src/db/schema.ts`, `src/db/migrations/index.ts`, `src/app/registry.ts`, `src/app/crons.ts`, `src/bin/graft-ops.ts` and `src/bin/graft.ts` (the `guard` group), `src/policy/schema.ts` and `parse.ts` (`guard.checks`), `src/policy/json-schema.ts`, `src/modules/modes/cli.ts` (`show` note), `src/pilot/purge.ts`, `src/pilot/doctor.ts`, `github/app-manifest.json`, `github/app-manifest.report.json`, `test/unit/manifest.test.ts`, `test/integration/neutral.test.ts`, the GitHub fakes, and the docs in T11.

## 5. History (`guard.track`)

Job data: `{ installationId, repositoryId, owner, repo, after: sha, before: sha | null, forced: boolean, deliveryId? }`. IDs and SHAs only.

1. Skip if the installation or repository is inactive, or if `GRAFT_GUARD_DETECTION=off`.
2. Read the repository's default branch from the API (`repos.get`; it is not taken from the payload). If the push's ref is not that branch, stop (`not_default_branch`).
3. Walk per D5. Store new commits oldest first with increasing `seq` (the next value after the repository's max). `chain_break` is set per D5.
4. Map each new commit per D6.
5. Enqueue `guard.observe` for `after` (a push to `main` is also when the previous commits' results become comparable).

`seq` is assigned under the per-repository advisory lock (D11). A commit that is already stored is never rewritten. A force push that moves the branch back to an old SHA stores nothing new and is logged (`rewound`).

## 6. CI results (`guard.observe`, read part)

1. Same skips as `guard.track`. If the SHA is not a tracked default-branch commit, follow D13.
2. Read check runs (`filter=all` since step 4 review 2, `per_page=100`, at most 5 pages; a truncated read makes every result of the commit `ignored`) and, when `statuses: read` is present, the combined status (`per_page=100`, at most 3 pages). Skip Graft's own check runs. Apply `guard.checks` (D17) at classification time: a key outside the list is stored as `ignored` with `filtered = true`.
3. Upsert one `ci_results` row per (repository, sha, key): `name`, `source`, `class`, `completed_at`, `html_url` (only if it starts with the configured GitHub web base URL; otherwise NULL), `observed_at`. A newer `completed_at` replaces an older one. An older one never overwrites.
4. Run detection (§7) for the keys whose class changed in this upsert, and for every open (`confirming`) event of the repository.

## 7. Detection (`src/guard/detect.ts`, pure)

```ts
export type ResultClass = "green" | "red" | "ignored";
export interface ChainCommit { sha: string; seq: number; chainBreak: boolean; pr: { kind: "pr"; number: number } | { kind: "direct" } | { kind: "multiple" } | { kind: "unresolved" } }
export interface KeyResult { key: string; sha: string; class: ResultClass }

export type Transition =
  | { kind: "none"; why: "not_red" | "already_red" | "no_baseline" | "filtered" }
  | { kind: "new"; key: string; failingSha: string; lastGreenSha: string; candidates: ChainCommit[] };

export function detectTransition(chain: readonly ChainCommit[], results: readonly KeyResult[], key: string, sha: string): Transition;

export type Classification =
  | { status: "culprit_found"; prNumber: number }
  | { status: "ambiguous"; prNumbers: number[]; unresolved: number }
  | { status: "no_culprit" };
export function classifyCandidates(candidates: readonly ChainCommit[]): Classification;

export type ConfirmInput = {
  failingKeys: string[]; failingSha: string; nextSha: string | null;
  resultsOnFailing: Record<string, ResultClass>; resultsOnNext: Record<string, ResultClass>;
  detectedAt: Date; now: Date; windowSeconds: number;
};
export function confirmationStep(i: ConfirmInput): "confirmed" | "flaky" | "wait";
```

`chain` is the repository's commits ordered by `seq`, newest last, cut at the nearest `chainBreak` at or before the failing commit (the break commit itself is included, and nothing before it). `classifyCandidates` implements D7. `confirmationStep` implements D9, checked in this order:

1. Any failing key red on the next commit → `confirmed`.
2. Every failing key green on the failing commit, or green on the next commit → `flaky`.
3. Window elapsed and any failing key still red on the failing commit → `confirmed`.
4. Otherwise `wait`.

**Event lifecycle** (`guard_events.status`):

```
                 ┌── confirm off ──► culprit_found | ambiguous | no_culprit
new transition ──┤
                 └── confirm on ───► confirming ──► culprit_found | ambiguous | no_culprit   (confirmed)
                                                └─► flaky                                     (flaky)
```

`dismissed` is set only by a human through a later CLI (not in this step). The other existing statuses (`revert_opened`, `reverted`, `error`) belong to step 5. Writes happen under the per-repository lock. The job re-reads the event inside it, so two observes cannot both confirm. When an event reaches `culprit_found`, the job publishes the comment (D10) after the repository lock is released, under the change lock.

`guard.confirm { eventId }` is scheduled at `detected_at + window` (singleton per event) and runs `confirmationStep` with the current results.

## 8. Comment

```md
<!-- graft:guard-event 3f0c…-uuid -->
### Graft guard

CI check `test` went red on `main` at `abc1234` after this pull request was merged. It was green at `9f8e7d6`, the commit before.

- Failing: `test`, `lint (node 24)` ([details](https://github.com/acme/app/runs/123))
- Confirmed by: the next commit `def5678` is also red | still red after 2 hours

Graft would open a pull request reverting this merge. Fix forward or revert to clear it.

Graft mode: report. Graft opens nothing; this is what it would do.
```

Rules: SHAs are 7 characters in code spans. Check names go through `codeSpan` (max 80 characters, at most 5 listed, then `and N more`). The details link appears only for the first failing check with an `html_url`. The branch name goes through `codeSpan`. There is no `@` outside code spans. The text is at most 4,000 characters. The "Confirmed by" line is omitted when confirmation is off. `ambiguous`, `no_culprit` and `flaky` events produce no comment.

## 9. `graft.yaml`: `guard.checks`

```yaml
version: 1
guard:
  checks: [test, "lint (node 24)", ci/jenkins]
```

Schema: `guard` is an optional object with one optional key `checks`, a list of 1–50 non-empty strings of at most 200 characters with no control characters. Errors use the existing codes (`wrong_type`, `too_many_items`, `unknown_key`, plus whatever the string rule already uses). `docs/graft-yaml.md`, the JSON schema (`pnpm graft policy schema`) and `docs/examples/graft.yaml` (commented out) are updated. The policy engine ignores `guard`. It changes no verdict and no policy hash term other than its own presence in the canonical form. Record whether adding it changes existing policy hashes (it must not for files without `guard`).

## 10. Operator CLI

Added to `src/bin/graft-ops.ts` as the group `guard`, with the same conventions as the `mode` group (exit codes 0 ok / 1 failed / 2 usage or config, pending migrations exit 2, terminal-safe output).

```
graft guard list --repo <owner/repo> [--status <status>] [--limit <1..200, default 20>] [--json]
```

One line per event, newest first: `detected_at  status  failing_sha(7)  checks(first 3)  culprit #123 | candidates #120 #121 | no PR`. `--json` prints `{ events: [{ id, status, failingSha, lastGreenSha, failingChecks, culpritPr, candidatePrs, unresolvedCommits, detectedAt, confirmedAt, commentId, guardMode }] }`.

`graft mode show` adds a line when guard detection lacks `statuses: read`: `note: guard reads check runs only (no statuses:read)`. With `GRAFT_GUARD_DETECTION=off` in the shell's config, it adds `note: guard detection is off on this shell's config`.

## 11. Schema (migration `00NN_guard`)

```sql
CREATE TABLE main_commits (
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha           text   NOT NULL CHECK (sha ~ '^[0-9a-f]{40}$'),
  parent_sha    text            CHECK (parent_sha ~ '^[0-9a-f]{40}$'),
  seq           bigint NOT NULL,
  chain_break   boolean NOT NULL DEFAULT false,
  pr_source     text NOT NULL CHECK (pr_source IN ('change','api','direct','multiple','unresolved')),
  change_id     uuid REFERENCES changes(id) ON DELETE SET NULL,
  pr_number     integer,
  committed_at  timestamptz,
  tracked_at    timestamptz NOT NULL,
  PRIMARY KEY (repository_id, sha),
  UNIQUE (repository_id, seq),
  CHECK ((pr_source IN ('change','api')) = (pr_number IS NOT NULL))
);

CREATE TABLE ci_results (
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha           text   NOT NULL CHECK (sha ~ '^[0-9a-f]{40}$'),
  key           text   NOT NULL CHECK (char_length(key) <= 240),
  name          text   NOT NULL CHECK (char_length(name) <= 200),
  source        text   NOT NULL CHECK (source IN ('check_run','status')),
  class         text   NOT NULL CHECK (class IN ('green','red','ignored')),
  filtered      boolean NOT NULL DEFAULT false,
  html_url      text   CHECK (char_length(html_url) <= 500),
  completed_at  timestamptz,
  observed_at   timestamptz NOT NULL,
  PRIMARY KEY (repository_id, sha, key)
);

ALTER TABLE guard_events
  DROP CONSTRAINT guard_events_status_check,
  ADD CONSTRAINT guard_events_status_check CHECK (status IN (
    'detected','confirming','culprit_found','ambiguous','no_culprit','flaky',
    'revert_opened','reverted','dismissed','error')),
  ADD COLUMN last_green_sha   text CHECK (last_green_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN failing_checks   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ key, name, source }], at most 20
  ADD COLUMN candidates       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ sha, prNumber | null, kind }], at most 50
  ADD COLUMN detected_at      timestamptz,
  ADD COLUMN confirmed_at     timestamptz,
  ADD COLUMN confirm_reason   text CHECK (confirm_reason IN ('next_commit','window','off','flaky_rerun','flaky_next')),
  ADD COLUMN comment_id       bigint,
  ADD COLUMN guard_mode       text CHECK (guard_mode IN ('report','enforce'));
CREATE INDEX guard_events_open_idx ON guard_events (repository_id) WHERE status = 'confirming';
```

Check the actual name of the 0001 inline status CHECK (expected `guard_events_status_check`) and assert it in the migration. `down` drops exactly what `up` adds and restores the old CHECK. It fails if a row uses a new status, and the rollback test runs on an empty table. The existing `ci_run_url` column stays and is filled with the first failing check's `html_url`. `branch` is the default branch name at detection. `culprit_change_id` is set for `culprit_found`.

## 12. Tasks

### T1. API verification

Record in decisions.md, from GitHub's REST and webhook docs, and make the fakes match: (a) which apps' `check_run.completed` and `check_suite.completed` events a GitHub App with `checks: write` receives (all apps, or only its own). If only its own, `status` and `push` are the remaining triggers, and `guard.observe` must also be scheduled from `guard.track` with a re-check at `+5 min` and `+30 min` (singletons). Implement whichever the docs say, and record it. (b) The shape and pagination of `commits/{sha}/check-runs` (`filter=latest`) and `commits/{sha}/status`. (c) `commits/{sha}/pulls` for squash, merge and rebase merges. (d) The `branches` field of the `status` payload and `head_branch` on check suites.

### T2. Config

`GRAFT_GUARD_DETECTION` (`on`/`off`, default `on`), `GRAFT_GUARD_CONFIRM` (`on`/`off`, default `on`), `GRAFT_GUARD_CONFIRM_SECONDS` (300–86400, default 7200), `GRAFT_GUARD_OBSERVE_DELAY_SECONDS` (0–600, default 30), `GRAFT_GUARD_RETENTION_DAYS` (7–365, default 30), `GRAFT_GUARD_PRUNE_CRON` (cron or `off`, default `45 3 * * *`). `.env.example` and `docs/configuration.md`.

### T3. Migration and schema types

§11, `src/db/schema.ts` types and `TABLE_NAMES`. Rollback test as in earlier steps. I-DB table counts step up by two.

### T4. Pure detection

`src/guard/detect.ts` per §7 and D3, D4, D7, D9. No I/O.

### T5. Track

§5, with D5 and D6.

### T6. Observe, confirm, prune

§6 and §7, the `guard.confirm` scheduling, and the `guard.prune` cron (D15) registered in `src/app/crons.ts` with the usual `off` handling.

### T7. Comment

§8 and D10, D11, D16.

### T8. Handlers and manifests

D13 handlers registered in `src/app/registry.ts`. Both manifests gain `statuses: read` and the events `check_suite` and `status` (`check_run` and `push` are already there). U-MAN-2 and U-MAN-3 still hold. **U-MAN-5:** `statuses` is never above `read`, and neither manifest has `actions`.

### T9. `graft.yaml` key

§9.

### T10. CLI, purge, doctor

§10. `src/pilot/purge.ts`: `main_commits` and `ci_results` through `repositories` (`guard_events` is already covered; check). `pilot doctor`: two `warn` checks: "installations without statuses:read (guard reads check runs only)" and "guard events stuck in confirming past twice the window". Doctor still reads only the database.

### T11. Docs

- `docs/features/guard.md`: what the guard watches, the result classes, the culprit rule with a diagram of the three cases, confirmation, what report mode writes, `guard.checks`, `graft guard list`, and what step 5 will add. Linked from `docs/README.md`, `mkdocs.yml` (Features) and the Phase 1 plan.
- `docs/architecture.md`: a "Guard contract (Phase 1 step 4)" section: triggers vs API reads, the tables, the lock order (repository advisory lock, then the change lock, never both at once), and the D10 write.
- `docs/configuration.md`, `docs/github-app.md` (new permission and events), `docs/graft-yaml.md` (§9).
- `docs/decisions.md`: "Phase 1 step 4: guard detection" with the T1 answers, the D2 deviation and any other.
- `docs/phase-1/HUMAN-TODO.md`: §14.

### T12. Neutral suite

`test/integration/neutral.test.ts` adds a guard scenario to both profiles. It covers a push to `main` merging the PR, CI green on the parent, red on the merge commit, red on the next commit, and an observe and confirm run. Assertions:
- **N-1** still holds. The only new write is one `POST …/issues/{n}/comments` on the culprit PR.
- **N-8:** no request in the log uses a `phase1` route or a `guard` feature client, in either profile.
- **N-9:** a second observe after confirmation, and a replayed `check_run.completed`, add no write.

**Parallel work.** Step 3 may be in flight. This step must not edit `src/modules/policy/**`, `src/policy/evaluate.ts`, `src/github/mutation-guard.ts` or `src/github/collaborator.ts`. Shared files are additive only: registry, crons, config, schema types, manifests, purge, doctor, the neutral suite and the migration index. The migration takes the next free number when the branch is merged. If another step's migration lands first, renumber this one before merging, because the migrator refuses migrations out of order.

## 13. Test plan

Unit (`test/unit/guard-detect.test.ts`):

| ID | Case |
| --- | --- |
| U-DET-1 | D3: every check run conclusion and status state maps to its class |
| U-DET-2 | D4 keys: same name from two apps → two keys; name over 200 characters truncated; status context key |
| U-DET-3 | Single culprit: green on N−1, red on N, N is PR #7's squash commit → `new`, `culprit_found #7` |
| U-DET-4 | Two merges between green and red → `ambiguous` with both PR numbers |
| U-DET-5 | Rebase merge: three commits of PR #9 between green and red → `culprit_found #9` |
| U-DET-6 | Red before merge: N−1 already red → `none already_red` |
| U-DET-7 | CI skipped on N−1 (ignored), green on N−2, red on N, N−1 and N from different PRs → `ambiguous` |
| U-DET-8 | Direct push red → `no_culprit`. Mixed direct push and PR → `ambiguous` (counts as two origins) |
| U-DET-9 | Chain break between the green and the red → `none no_baseline` |
| U-DET-10 | `unresolved` candidate → `ambiguous` with `unresolved: 1` |
| U-DET-11 | `cancelled` on N with green before → `none not_red` |
| U-DET-12 | Filtered key (D17) → `none filtered` |
| U-DET-13 | `confirmationStep`: next red → `confirmed`; re-run green → `flaky`; next green → `flaky`; window elapsed still red → `confirmed`; window not elapsed and no next → `wait`; several keys, one still red on next → `confirmed` |
| U-DET-14 | Property test: a culprit is never returned when the candidates map to more than one PR or include a non-PR commit |

Unit (`test/unit/guard-comment.test.ts`):

| ID | Case |
| --- | --- |
| U-GCM-1 | The §8 sample, literally, for report mode. Enforce mode changes only the last line |
| U-GCM-2 | A check name containing backticks, `@team`, `<!--` and newlines is rendered safely; no `@` outside code spans; the marker appears exactly once |
| U-GCM-3 | Six failing checks → five listed and `and 1 more`; no `html_url` → no details link; a non-GitHub `html_url` was never stored |
| U-GCM-4 | Confirmation off → no "Confirmed by" line |

Unit (`test/unit/policy-parse.test.ts`, additions):

| ID | Case |
| --- | --- |
| U-PGD-1 | `guard.checks` valid list parses. Absent `guard` → same policy hash as before this step for every existing fixture |
| U-PGD-2 | `guard: { checks: [] }`, 51 items, a 201-character name, a control character, `guard.other: 1` → the expected error codes |

Integration (`test/integration/guard.test.ts`, fake GitHub world):

| ID | Case |
| --- | --- |
| I-GRD-1 | Migration up/down/up |
| I-GRD-2 | Push to the default branch → commits stored with first parents and `seq`. A push to another branch → nothing. Forced push → `chain_break` |
| I-GRD-3 | Commit → PR: from `changes`; from the API for a rebase merge; direct push; two PRs → `multiple`; 21 unknown commits → 20 lookups and 1 `unresolved` |
| I-GRD-4 | `check_run.completed` on a PR branch → nothing enqueued. On the default branch → one `guard.observe` after the delay. 20 completions within 30 s → one job |
| I-GRD-5 | Results read from the API, not the payload: the payload says `failure`, the API says `success` → stored `green` |
| I-GRD-6 | Single culprit, confirmation on: `confirming`, then next commit red → `culprit_found`, one comment on the culprit PR with the marker. Replay → no second comment |
| I-GRD-7 | Flaky: re-run on N turns green → `flaky`, no comment. Next commit green → `flaky` |
| I-GRD-8 | Quiet repository: no next commit, `guard.confirm` at the deadline with N still red → `culprit_found` and the comment |
| I-GRD-9 | Ambiguous (two merges) and no-culprit (direct push) → event rows, no comment, `guard list` shows them |
| I-GRD-10 | Two observes for neighbouring commits racing → exactly one event (advisory lock) |
| I-GRD-11 | Without `statuses: read` → no status request in the fake's log; check runs still drive detection |
| I-GRD-12 | `guard.checks: [test]` at N → a red `lint` opens nothing; a red `test` does |
| I-GRD-13 | `guard_mode: enforce` with the ceiling at `enforce` and `contents: write` → same event, same single comment with the enforce line; no other write |
| I-GRD-14 | `GRAFT_GUARD_DETECTION=off` → handlers enqueue nothing; crons idle |
| I-GRD-15 | `guard.prune` deletes old rows and keeps commits of `confirming` events; `pilot purge` removes the new tables; I-PURGE-2 passes |
| I-GRD-16 | `guard list` output and `--json` shape; `mode show` statuses note; doctor warnings with exit 0 |

Neutral suite: N-1, N-8, N-9 (T12). Manifest: U-MAN-5.

## 14. HUMAN-TODO (add a section "Step 4: guard detection" to `docs/phase-1/HUMAN-TODO.md`)

- [ ] **Accept `statuses: read` and the `check_suite` and `status` events** on every installation, then `pnpm graft mode refresh-permissions --installation <id>`. Who: org owner, then operator.
- [ ] **On a sandbox repository**, merge a PR that breaks a check on `main`, then push one more commit. Check that a guard comment appears on the culprit PR and that `pnpm graft guard list --repo …` shows `culprit_found`. Then re-run a failing check until it passes on a fresh break, and check that the event is `flaky` with no comment. Who: repo owner.
- [ ] **Tell pilot teams** that the guard comments on merged PRs that broke `main`, and that nothing is reverted until they opt in to `guard_mode: enforce` (step 5). Who: product owner.

## 15. Definition of done

From a clean clone with Docker running, and no network beyond install and the image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test                                  # every ID in §13 present and passing; all earlier IDs still passing
pnpm build
pnpm eval:ci                               # exit 0, baseline unchanged
pnpm db:migrate && pnpm db:status          # every migration up to 00NN applied
pnpm db:rollback && pnpm db:status && pnpm db:migrate   # only 00NN rolled back, then re-applied
grep -rnE "@ts-(ignore|expect-error)" src/ && exit 1 || true
grep -rnE "from \"\.\./(db|github|modules)" src/guard/ && exit 1 || true
grep -rn "feature: \"guard\"" src/ && exit 1 || true          # step 5 adds the first one
grep -rnE "rest\.(git|pulls)\.(create|update)|rerequest|reRun" src/modules/guard/ && exit 1 || true
grep -rn "U-DET-\|U-GCM-\|U-PGD-\|I-GRD-\|N-[89]\|U-MAN-5" test/ | wc -l   # non-zero
```

**Manual smoke test** (record it in the PR description): with `pnpm dev:server` and `pnpm dev:worker`, send `push.default.json` and then `check_run.completed.json` (default branch, failure) with `pnpm webhook:send`. The worker logs `guard.track`, then one `guard.observe` about 30 s later. Offline, the API reads fail and are classified: no crash, no event.

**Mutation checks** (the reviewer reverts each one; the named tests must fail):

| Mutation | Caught by |
| --- | --- |
| `cancelled` counted as red | U-DET-1, U-DET-11 |
| Already-red main opens an event | U-DET-6 |
| Two PRs between green and red blamed on the last one | U-DET-4, U-DET-14 |
| Search crosses a chain break | U-DET-9 |
| Confirmation skipped (event final at detection with confirm on) | U-DET-13, I-GRD-7 |
| Result class taken from the webhook payload | I-GRD-5 |
| Handler enqueues for PR-branch check runs | I-GRD-4 |
| No marker check before commenting | I-GRD-6 (replay), N-9 |
| No advisory lock around detection | I-GRD-10 |
| `guard.checks` ignored | I-GRD-12 |
| Comment posted for `ambiguous` | I-GRD-9 |

**Also required:**
- No log line, job payload, column or error message holds a token, check output, a log, a commit message, PR text or YAML. Check names and contexts are stored and logged only at debug.
- No request in any test log uses a `phase1` route (N-8).
- The live e2e runner's INV-1 still holds with the default sandbox (no runner change in this step).
