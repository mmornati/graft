# Review 1: live e2e scenario runner

Verdict: CHANGES REQUESTED

Scope: the uncommitted diff on `main` (after `9e0bfe4`) against `docs/e2e/live-scenarios-spec.md`, the Phase 0 constraints and the README §7 "Live e2e runner deviations and additions". Nothing was run against GitHub and no network call was made: only the offline DoD commands, `--only-offline` and the test suite.

## What I ran

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | pass |
| `pnpm test` | 83 files, 857 tests, all pass, 338 s |
| `pnpm graft policy check` on the three fixtures | exit 0 each |
| `pnpm graft e2e run --only-offline` | exit 0, prints the report path (but see finding 8) |
| `pnpm graft e2e run --only-offline --llm none` | exit 0, s08 skipped (`needs_live_llm`) |
| `pnpm graft e2e frobnicate` | exit 2, usage |
| `git check-ignore -q e2e-runs/x` | exit 0 |
| `grep -rln GRAFT_E2E_ src` outside `src/e2e` and `src/bin/graft.ts` | no output |
| Mutations M1 to M13 (spec §11), each applied alone in a scratch copy | **all 13 killed**, each by the named test (M1 GUARD-2, M2 SEC-2, M3 SENT-1, M4 WAIT-1, M5 INV-2, M6 ASSUME-1, M7 SWEEP-1, M8 CLEAN-1, M9 COST-1, M10 PLAN-2, M11 REP-2, M12 SCEN-1, M13 GUARD-3) |

Every test ID of spec §10 exists, and the ones I read assert what the spec asks for. The runner is careful work: two-key sandbox guard, a write hook on every Octokit client (REST and GraphQL go through the same hook), a GET-only token client for b2, credential-helper pushes, settle waiters that handle an A to B to A head, a real sentinel scan over every table. No path I found lets a **runner client** write to `mmornati/ai-running-coach`. The changes requested are one safety gap around the App installation, two real product bugs, and the HUMAN-TODO ticking.

## Findings

### 1. major: the App installation's scope is never checked, and s10 redelivers by PR number only

`src/e2e/preflight.ts:307-316`, `src/e2e/setup.ts:239-258`, `src/e2e/hooks.ts:49-68`, `src/e2e/scenarios/s10.ts:147` and `:201`.

The runner checks that the App is installed on the sandbox, but not that it is installed **only** there. The personal App is owned by `mmornati`, who also owns `ai-running-coach`, and GitHub's install page defaults to "All repositories". Selecting that by mistake puts Graft on the protected repository: any event there (a Dependabot PR) makes the running Graft write comments and check runs to it. `setup` prints `repository_selection` and moves on; A09 only reports it at the end of the run.

The runner itself can then cause such a write. `findPrDelivery` picks the first `pull_request.opened` delivery whose payload has the same PR **number**. It does not check the repository or the installation, so in s10 it can redeliver another repository's webhook into Graft, and Graft then processes that PR.

Required fix:
- In the preflight of `run`, `verify` and `setup` (step 6), refuse with exit 3 unless `repository_selection === "selected"` and the probe's `GET /installation/repositories` lists exactly the sandbox (by id). Refuse if any protected repository or `source` appears in the list.
- In `findPrDelivery`, require `d.installationId === run.installationId` and `payload.repository.id === run.repositoryId`, as `collectPushEvidence` already does by name.
- Add a U-LIVE-GUARD test for each refusal.

### 2. major (product bug, affects pilots): the card's task issue is read from a row that another job writes for possibly another head

`src/modules/intent/job.ts:144-160`, `src/modules/provenance/store.ts:59-93`, `src/modules/intent/handlers.ts:102-139` (`intent.schedule`), `src/modules/intent/inputs.ts:90-123`.

The developer's diagnosis in README §7 (line 536) is not quite right. Provenance **does** unlink the task: `persistProvenance` sets `changes.task_id = null` when the head has no `Graft-Task`. The real defect is ordering. `pull_request.opened` and `synchronize` queue the provenance job and the intent job at the same time, and nothing orders them. The intent job reads `changes.task_id` (through `upsertChangeFromPull`, which does not touch it) as an input of the card and of `inputHash`. That value is whatever provenance last stored, which may belong to the previous head or may not be written yet. In s07 (e), intent read the `task_id` that the C2 provenance had stored, before the C1 provenance cleared it. So the input hash differed and the cache missed.

Impact on real pilots:
- The first card of an agent PR can miss its `Graft-Task` issue whenever intent wins the race (same `opened` event). The trailer is the main intent source when the body has no closing keyword (`findLinkedIssue`).
- After a rewritten history, the card can use a stale issue.
- The inputs are nondeterministic, so cards and cache hits vary from run to run, which costs extra model spend.

Severity: major. It degrades the card, which is the thing pilots vote on.

Required fix, in the product:
- Make the task input a function of the head. One way: the intent job derives the task from this head's commits, reusing `fetchPrCommits` and `computeProvenance` (already exported from `modules/provenance/index.ts`). Another way: read `change_provenance.task_external_id` only when `change_provenance.head_sha = pull.head.sha`, else throw a retryable error. A third way: schedule intent from the `provenance_published` signal.
- Add integration tests for (i) an agent PR whose card always gets `linked_issue_number = <task>`, whatever the job order, and (ii) a force-push to a trailer-less head after a `Graft-Task` head, which must give a card without the task and hit the cache for the original head.

Required fix, in the runner:
- Correct README §7 line 536.
- Once the product is fixed, put `Graft-Task` back in s07 (d), as the spec says.
- Add a system assertion to s01: `intent_cards.linked_issue_number = <run issue>`. That is what would have caught this.

### 3. major (product bug, affects pilots): a reviewer requested at PR open can be lost

`src/modules/pilot/reviewers.ts:99-100` (`if (!change) return "skipped"`) and `:206-229`.

Confirmed. `pull_request.review_requested` is sent within the same second as `opened` when a PR is opened with reviewers, the usual case in the GitHub UI and with CODEOWNERS. Its sync job can run before the provenance or intent job has created the `changes` row. It then returns `skipped`, the job completes, and nothing retries it. Once the reviewer submits any review, GitHub drops them from `requested_reviewers`. Later syncs (on `submitted`, on `feedback_recorded`, or the `sync-reviewers` backfill) cannot see the request any more.

How much eligibility this loses:
- An APPROVED or CHANGES_REQUESTED review still makes the user eligible as `reviewed`.
- A requested reviewer whose only review is COMMENTED loses eligibility, and so does one whose reaction the 15-minute poll records after they reviewed. The gate then drops their votes as `not_reviewer`.

The gate is the Phase 0 decision, so this is major. The runner's workaround (request after settle) also hides the real-world path from the e2e.

Required fix:
- In `syncReviewers`, when the change row is missing, either throw a retryable job error (bounded by `retryLimit`, with a delay) or create the row from `pulls.get` with `upsertChangeFromPull`, which is API data and so follows the payloads-are-triggers rule.
- Also enqueue a sync when a change row is first created, for example from `provenance_published`, so that requests made at creation are captured.
- Add an integration test: `review_requested` delivered before any `changes` row exists ends with a `requested` row.
- Then restore the spec order in s08 (request at open), keeping the wait before the approval.

### 4. major: `--update-human-todo` ticks operational items that the e2e cannot prove; one anchor can never be ticked as documented

`src/e2e/report.ts:258-280`, `src/e2e/assumptions.ts:26-114`, `docs/phase-0/HUMAN-TODO.md:88`, `docs/e2e/runbook.md:56` and `:71-72`.

Several anchored items are deployment or pilot actions, not assumptions. Ticking them `[x]` from a personal-account sandbox run marks undone work as done:
- `s1-install`: install on the org for `sample-ts` and `sample-py`, with two `repositories` rows.
- `s5-events`: update the **existing** App's events, and check whether the installations must accept the change. A freshly registered App has them from the manifest.
- `s6-backfill`: run the backfill after deploying migration 0007.
- `s6-retention`: "after the first deploy".
- `s6-baseline-github`: compare numbers by hand on the first pilot repository.

Separately, `s3-outputs` needs A04 to pass, which needs `--wait-cron`. But the HUMAN-TODO "Run the live e2e" item and the runbook run `run --interactive --capture` without it, so following the documented procedure never ticks that item.

Required fix:
- For items that contain a deployment or pilot action, append "assumption(s) A.. verified by live e2e run <id> (<date>)" under the item and leave the checkbox alone, or split each item into an assumption sub-item, which may be ticked, and the action, which may not. Keep U-LIVE-REP-2's byte-stability property.
- Add `--wait-cron` to the documented run, or document a second run for `s3-outputs`.
- Record the decision in README §7.

### 5. minor: redirects are followed and the guard is name-only

`src/github/client-factory.ts` (`forToken`, no `request.redirect`), `src/e2e/clients.ts:154-193`, `src/e2e/preflight.ts:288-290`.

GitHub answers non-GET requests on a renamed or transferred repository with 307, and the default fetch follows it with method and body. The hook only sees the original path. The marker check makes this hard to exploit, because the name must redirect to a repository whose marker names the sandbox. Still, the run never pins what it checked.

Required fix:
- Build the runner's clients with `request: { redirect: "manual" }` (or "error") and treat any 3xx on a non-GET as a `GuardRefusal`.
- In preflight, require `data.full_name` (case-insensitive) to equal the sandbox, so a redirect is refused.
- Pin `repositoryId` in the guard context and compare it with `pull.base.repo.id` in `openPr`.

### 6. minor: the actor and outsider route allow-lists are wider than the spec's

`src/e2e/guard.ts:233-246`.

- The actor may send `PATCH /repos/{sandbox}` (`rest === ""`: rename, visibility, default branch) and `POST /repos/{sandbox}/transfer`. The spec allows routes *under* `/repos/<sandbox>/`.
- In private mode the outsider may use any `/pulls` route, including `PUT .../merge` and `PATCH` (close), and any `/git/` route, including a force-update of `refs/heads/main`.

None of this reaches a non-sandbox repository, but the guard should only allow what the plan uses.

Required fix:
- Refuse non-GET on `rest === ""` and on `/transfer`.
- Restrict the outsider to: reactions; `POST /pulls`; `POST /pulls/{n}/requested_reviewers`; `POST /git/{blobs,trees,commits}`; `POST /git/refs` and `PATCH /git/refs/heads/graft-e2e/<runId>/...`.
- Test both.

### 7. minor: `git clone` is not anonymous, and the git children inherit the user's global git config

`src/e2e/git-pusher.ts:40-42` and `:70-82`.

The clone does not reset `credential.helper`, so `gh auth setup-git` or osxkeychain credentials are used, against D2's "anonymous HTTPS". Both the clone and the push read the user's `url.<x>.insteadOf` and `core.hooksPath`. The push target is `sandbox.repo` rather than the `full_name` that `createForAuthenticatedUser` returned. The error text names the first non-dash argument, which is `credential.helper=` for the push and `user.name=Graft E2E` for the commit, so it is misleading.

Required fix:
- Run every git child with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` (keep `GIT_TERMINAL_PROMPT=0`), and pass `-c credential.helper=` to the clone as well.
- Push to the created repository's `full_name`, after asserting that it equals the sandbox.
- Name the git subcommand in errors.

### 8. minor: `--only-offline` without `--llm` prints the `none` report, and the live report is lost

`test/integration/live-e2e.test.ts:66-160` and `:236-243`.

With `GRAFT_E2E_OFFLINE_LLM` unset, both I-LIVE-RUN-1 (live) and I-LIVE-RUN-2 (none) run, and both copy `report.{md,json}` into the same `GRAFT_E2E_OFFLINE_OUT`. The printed `e2e-runs/offline-*/report.md` is therefore the none-mode report, without s08 or b2. I checked the `report.json` of my run: `llm: none`, s08 skipped. The DoD step "prints the path of report.md" passes, but on the wrong report.

Required fix: publish to `<out>/live/` and `<out>/none/` and print both paths, or run only the live variant when `--llm` is not given (D17 maps `auto` to the live suite).

### 9. minor: the offline mode's output and environment are not sanitised

`src/e2e/run.ts:576-596`.

`runOffline` prints the last 40 lines of vitest's output through the raw `io`, with no `redact` and no `toTerminalSafe`, and the vitest child inherits `GRAFT_E2E_ACTOR_TOKEN` and `GRAFT_E2E_OUTSIDER_TOKEN` from the shell. The tests do not need either.

Required fix: wrap the output with `safeIo` over a registry that holds the env tokens, and drop `GRAFT_E2E_*` (other than the three offline variables) from the child environment.

### 10. minor: s10's stability fingerprint can change without a Graft bug

`src/e2e/scenarios/s10.ts:16-40` and `:157-171`.

`webhookJobs` counts every `github.webhook` job of the installation, and pg-boss deletes them one hour after completion. A run longer than an hour (`--wait-cron`, `--interactive`, `--timeout-scale`) sees the count drop inside the window. `deliveries` counts every delivery of the installation, including `check_run` and `check_suite` deliveries that still arrive late from s09's re-evaluations. The "quiet" precondition is a single 2 s sample.

Required fix:
- Count only the deliveries and jobs created after `since`, or only those carrying PR 1's guid or number.
- Make the quiet wait a real window (for example 15 s with no change).

### 11. minor: some assertions can pass vacuously

- s05 and s09 accept `h0 === null` (`src/e2e/scenarios/s05.ts:66-68`, `src/e2e/scenarios/s09.ts:115-118`). s01 records H0 only `if (policyHash)` and never asserts it.
- s07 hard-codes `deliveries: { readyForReview: true, reviewSubmitted: true }` (`src/e2e/scenarios/s07.ts:231`). The waiters enforce it, but the report can never show `false`.
- s02 checks `teamConstraints >= 1`, not that the team is `platform` (`src/e2e/scenarios/s02.ts:56-61`).
- I-LIVE-RUN-2 asserts `llmCalls() >= 0`, which is always true (`test/integration/live-e2e.test.ts:166`). Mode none should be `=== 0`.

Required fix:
- s01 asserts a non-null policy hash (S), and s05 and s09 fail when H0 is null.
- s07 sets the two booleans from the waiter results.
- s02 compares the team name.
- RUN-2 asserts zero LLM calls.

### 12. minor: the public (fork) mode is untested end to end, while the real `GitPusher` and spawn paths are acceptable as they are

`README.md:545`.

The real `GitPusher` is unit-tested against a fake `spawn`, including argv, child env, the no-token-in-argv rule and temp-dir removal. What remains untested is git's own behaviour, on a one-time, human-watched command. That is acceptable for a human-triggered tool once finding 7 is fixed. `runSpawn` in `src/bin/graft.ts` (argv array, no shell) is small and acceptable.

Public mode is a different write path: the fork, `mergeUpstream`, the `login:branch` head, and cleanup in the fork with the outsider client. Only the unit guard test covers it. The guard makes it fail closed, so the risk is functional, not safety.

Required fix: either add one I-LIVE test of s08 and cleanup in public mode (the world already supports forks), or make `parseSandboxConfig` reject `visibility: "public"` until it is tested.

### 13. nit: the `access_tokens` exception applies to every client and every installation

`src/e2e/guard.ts:188`.

Only the `app` and `probe` clients mint tokens, and only for the run's installation. Restrict the exception to those two clients and to `installationId`.

### 14. nit: b2's request log cannot see a refused write

`src/bin/graft.ts:243-252`, `src/bin/graft-ops.ts:393-395`.

`makeGetOnly` is registered after the logging hook, so it runs first and throws before the log records anything. `nonGetToSource` is therefore 0 by construction, and the b2 check rests on the exit code. The GET-only property itself holds: graft-ops wraps every token client with `makeGetOnly`, `runBaseline` asserts `dryRun`, and the only DB writes are after the `if (opts.dryRun) return result`.

Fix: register the logger last (outermost), or also log in `hook.error`.

### 15. nit: INV-5 checks per change, not per card

`src/e2e/invariants.ts:340-371`.

Two new `ok` cards on one change with one spend row pass the check. Match the spend rows to cards by time window, or count them.

## Notes on the README §7 deviations

| Deviation | Assessment |
| --- | --- |
| Gate `--until <run day + 2>` | Sound. The default `until` (the start of today) would make the window empty, and +2 covers a run that crosses midnight UTC. |
| s07 (d) drops `Graft-Task` | Acceptable as a temporary workaround, but the stated cause is wrong (finding 2). Revert it after the product fix. |
| s08 requests after settle | Acceptable as a temporary workaround for a real bug (finding 3). Revert it after the fix. |
| s02 team rendering | Sound. A code span suppresses the mention, and `body_html` is also checked for `team-mention`. Tighten the team-name check (finding 11). |
| Token minting exception | Sound in principle. Narrow it (finding 13). |
| Narrowed `(token\|bearer)` regex | Safe. The registry holds every token the runner knows, and the vendor patterns (`gh[pousr]_`, `github_pat_`, `sk-ant-`, JWT, PEM, smee) cover the rest. The 12-character floor only lets through very short `token xxx` strings, which are not credentials. |
| Preflight scope per command | Sound. `setup` checks the marker before its first write on an existing repository, and `cleanup` keeps the marker check and the lock. The `start_after <= now()` refinement is right. Add the installation-scope check (finding 1). |
| `baseline --auth token` GET-only | Proven. `makeGetOnly` is applied inside graft-ops itself, whatever `tokenClient` is injected, and the hook covers REST, `paginate` and GraphQL. `--auth token` without `--dry-run` exits 2, and `runBaseline` asserts `dryRun` again before any DB write. |

## Answers to the brief, in short

- **Safety.**
  - Two keys: the config entry and the marker, both compared case-insensitively.
  - Protected repositories and every `source` are refused for every non-GET, including GraphQL text.
  - Repository deletion is refused unconditionally, and ref deletion only for `heads/graft-e2e/<runId>/`.
  - `POST /user/repos` is allowed only inside `setup --create` with confirmation, for the sandbox name and visibility. `git push` happens only right after that create.
  - `cleanup` needs label, title prefix and head-ref prefix, deletes only its run's refs (the guard enforces it again), and never touches `main` or a repository.
  - `setup` needs `--create` plus `--yes` or a typed "y" on a TTY. Writes to an existing repository need `--yes`.
  - Dry runs send no non-GET (U-LIVE-PLAN-2, M10).
  - Gaps: findings 1, 5, 6 and 7.
- **Secrets.**
  - Tokens reach `git` only through the child environment and a credential helper that names `$GRAFT_E2E_GIT_TOKEN` literally. No token is in a URL or in argv.
  - Every sink is redacted: io, state, report, capture and errors (`describeError` keeps name, status, method and path).
  - Graft code never reads `GRAFT_E2E_*` (U-LIVE-BOUND-1), and `.env` is checked by key and by value. The runner cannot see the server's own environment, so the runbook should say to export the actor token only in the runner's terminal.
  - Gap: finding 9.
- **Expectations.**
  - The model-dependent properties are `model` or `soft`, as D12 and D13 ask.
  - The `system` properties rest on floors and deterministic code.
  - The settle waiter handles A to B to A correctly (newest display and verdict per head).
  - INV-1 to INV-5 are real checks: all pages, filtered by app id; the sentinel scan uses `to_jsonb` over every `public` and pg-boss table, including job `data`.
  - Gaps: findings 10, 11 and 15. Assumption evidence: finding 4.
- **Runtime (338 s for the whole suite).** I measured the integration project per file with the JSON reporter: 319 s in all, of which the live-e2e files take 264 s (83%).
  - `live-e2e.test.ts` takes 205 s: RUN-1 97 s, RUN-2 78 s, RUN-3 to RUN-5 30 s together.
  - `live-e2e-commands.test.ts` takes 50 s, and `live-e2e-verify.test.ts` 9 s.
  - Every other integration file is under 25 s.

  That is excessive for a default `pnpm test`.

  Ways to cut it:
  1. Lower pg-boss polling for the in-process worker in tests. `src/queue/worker.ts:15` uses the default of 2 s; add a test-only option to set `pollingIntervalSeconds: 0.5`, the minimum. Most waits are on the worker.
  2. Run RUN-2 on a subset (s01, s05, s07, s10, b1: the scenarios whose `none` expectations differ). The full suite is already covered by RUN-1.
  3. Give each integration file its own database cloned from a migrated template (`CREATE DATABASE ... TEMPLATE graft_test`) and turn `fileParallelism` back on.
  4. Under `pnpm test`, scale s10's stability window and s07's settle waits further with `--timeout-scale` (it is real time, not the fake sleep).
  5. If that is not enough, move RUN-1 and RUN-2 behind a separate script (`pnpm test:e2e-offline`, which is what `--only-offline` runs) and keep only RUN-3 to RUN-5 plus a short RUN-1 subset in the default `pnpm test`.

  1 and 3 alone should bring the suite near its pre-runner time.
