# Review 2: live e2e scenario runner

Verdict: APPROVED

Scope: the uncommitted diff on `main` after the developer's fixes to [review 1](review-1.md). Nothing was run against GitHub and no network call was made.

All four majors of review 1 are fixed, and so are the minors. The remaining findings below are minor or nit. None blocks the first human run, but findings 1 to 3 should land before the work is committed.

## What I ran

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | pass |
| `pnpm test` | 85 files, 874 tests, all pass, **169 s** (338 s in review 1) |
| `pnpm graft policy check` on the three fixtures | exit 0 each |
| `pnpm graft e2e run --only-offline` | exit 0, 35 s; the report is the **live** variant: 12 scenarios pass, including s08 and b2 |
| `pnpm graft e2e run --only-offline --llm none` | exit 0, 33 s; none variant, s08 skipped |
| `pnpm graft e2e frobnicate` | exit 2 |
| `git check-ignore -q e2e-runs/x` | exit 0 |
| `GRAFT_E2E_` grep outside `src/e2e` and `src/bin/graft.ts` | no output |

### Mutations

I did not find the developer's N1 to N11 written down anywhere, so I re-applied M1 to M13 and wrote my own N series against the new fixes. Each mutation was applied alone in a scratch copy, with a separate test database.

**M1 to M13: all killed.** Each is caught by the test that spec §11 names.

**My N series: 11 of 15 killed.**

| # | Mutation | Result |
| --- | --- | --- |
| N1 | The intent job reads the task from `changes.task_id` again (the old behaviour) | killed by I-INT-TASK-1 and I-INT-TASK-2 |
| N2 | Reviewer sync skips when there is no change row | killed by I-REV-REQ-1 and I-REV-5 |
| N3 | The reviewer named by the webhook skips the permission check | killed by I-REV-REQ-2 |
| N4 | `scopeProblems` accepts "all repositories" | killed by U-LIVE-GUARD-4 and U-LIVE-CLI-3 |
| N5 | `findPrDelivery` ignores installation and repository | killed by U-LIVE-GUARD-4 |
| N6 | A write is sent without `redirect: "manual"` | killed by U-LIVE-GUARD-5 |
| N7 | The outsider may use any `/pulls` route | killed by U-LIVE-GUARD-5 |
| N8 | `GIT_CONFIG_GLOBAL` is removed from `GIT_ISOLATION` | **survived** (finding 3) |
| N9 | Deployment items get ticked | killed by U-LIVE-REP-2 |
| N10 | A token is minted for any installation | killed by U-LIVE-GUARD-5 |
| N11 | The preflight's renamed-repository (`full_name`) check is removed | **survived** (finding 3) |
| N12 | The `provenance_published` listener no longer enqueues a reviewer sync | **survived** (finding 2) |
| N13 | The actor may PATCH or transfer the repository itself | killed by U-LIVE-GUARD-5 |
| N14 | `setup` no longer checks the created repository's `full_name` | **survived** (finding 3) |
| N15 | `runSpawn` no longer hides `GRAFT_E2E_*` from children | **survived** (finding 3) |

## Answers to the brief

### (a) The product fixes

**The intent task: correct.**
- The task now comes from the head's own commits (`fetchPrCommits` and `computeProvenance`). That is the same parser and the same fields that provenance stores, so the card and the provenance check agree by construction.
- The fetch runs before the cache lookup and before any lock or `withChangeLock`, and spends no model tokens, so the lock and budget rules are untouched.
- Retries behave as before. A 404 leaves the card without a task. Any other error goes through `toJobError`: transient or rate-limited errors are retried, anything else is permanent. `data.trigger === "retry"` with a moved head is still rejected earlier.
- The replay hardening holds: every input comes from `pulls.get` and `pulls.listCommits`, never from the payload.
- The cost is one extra `listCommits` call per intent job, including cache hits and `edited` events. That is acceptable.

**More than 250 commits: the same behaviour as provenance.** `pulls.listCommits` returns at most 250 commits. `fetchPrCommits` then fetches the head commit on its own, and `truncated` is passed through. A `Graft-Task` that appears only in a commit beyond the first 250, and not in the head, is lost for the card exactly as it is for provenance. The fetch code documents this, and the two can no longer disagree.

**Reviewer sync upsert: consistent, with one gap (finding 1).**
- It calls the shared `upsertChangeFromPull` with `pulls.get` data and checks `base.repo.id`. The stale-snapshot guard is respected: the `pr_updated_at <=` condition holds, and when the update does not apply the function returns the existing row.
- The writers do not conflict: the other jobs use the same upsert, and the row is keyed on `(repository_id, pr_number)`.
- The gap: unlike the provenance and intent jobs, it does not call `ensureRepository` first.

**A forged requested reviewer cannot gain eligibility.**
- The user named in the webhook still goes through `checkTriagePermission`. Login and id must match the permission response, which also catches a recycled login, and the user needs triage or higher.
- A forged body cannot pass the HMAC check. A replayed genuine body only re-asserts a request that really happened, and the table is a union over time anyway.
- Bots are excluded, and `review_request_removed` is not in the action enum.
- But "was requested" is now a fact taken from the payload. That departs from the binding rule that jobs write only API data (finding 4).

**The I-REV-5 change is sound.**
- Before, a missing row was a silent `skipped` with no API call. Now it is a `pulls.get`, and a 404 there means the PR does not exist, so a `PermanentJobError` that stores nothing is the right outcome.
- The suspended-installation path still makes no GitHub call.
- The `sync-reviewers` CLI iterates existing change rows, so it never reaches the new path.

### (b) Safety

**Routes.**
- Writes are refused unless they target the sandbox's own routes. The repository itself and `/transfer` are refused too.
- The outsider is limited to what the plan does.
- Tokens are minted only by the `app` and `probe` clients, for the run's installation.
- Writes are sent with `redirect: "manual"`, and a 3xx answer is a `GuardRefusal`. I checked that `@octokit/request` 10.0.16 passes `request.redirect` to fetch and returns a 3xx to the after-hook. U-LIVE-GUARD-5 asserts the `redirect: "manual"` option.
- The preflight refuses a repository that answers under another name, and pins its id. `openPr` checks `base.repo.id`.
- The installation scope (selected, exactly the sandbox by id and name) is checked in the preflight of `run` and `verify`, and in `setup` step 6.
- s10 binds its delivery to the installation and repository, both in the delivery list and in the payload.

I found no remaining way for a runner client, or the runner's redelivery, to write outside the sandbox.

**What is still possible.** A repository added to the installation *during* a run is not detected: the scope is checked once, at preflight. Graft would then act on it, which is outside the runner's control. This is acceptable.

**Askpass.**
- The script is written inside the `mkdtemp` directory (mode 0700) with mode 0700, and U-LIVE-SEC-3 checks the mode.
- It holds no secret: it prints `$GRAFT_E2E_GIT_TOKEN` from the child's environment.
- It is removed in `finally`, with the whole temporary directory, even when the push fails. After a SIGKILL the directory remains, but it holds no token.

**The token in the environment.**
- The token is in the environment of the `git push` child, and of `git-remote-https` and the askpass shell under it, for the duration of the push.
- On Linux, `/proc/<pid>/environ` is mode 0400, readable by the owner and root only (and subject to ptrace access checks).
- On macOS, `ps -E` / `KERN_PROCARGS2` shows another process's environment only to the same user or root.
- So the token is exposed only inside the same trust boundary that already holds it: the user exported it in that shell, and `gh` keeps it on disk. This is acceptable.
- It never appears in argv, so `ps` without `-E` does not show it, nor does it appear in a URL or a git config file.

### (c) Lowered polling: test-only

- `startWorker` takes an optional `pollingIntervalSeconds` and applies it only when it is truthy.
- `src/bin/worker.ts` does not pass it, so production keeps pg-boss's default.
- The only caller that sets it is `test/helpers/live-e2e-env.ts:203` (0.5 s).

### (d) Runtime

Down from 338 s to 169 s, and `--only-offline` takes 35 s. That is no longer excessive.

## Findings

### 1. minor: reviewer sync creates a change without `ensureRepository`

`src/modules/pilot/reviewers.ts:114-131`.

Provenance and intent call `ensureRepository(...)` before `upsertChangeFromPull`, and return `skipped` ("repository removed") for a repository Graft considers removed. Reviewer sync does neither, which has two effects:
- On a removed repository of an active installation, it creates a `changes` row and `pr_reviewers` rows that the other writers deliberately refuse to create.
- On a repository Graft has no row for, the foreign key fails. That database error is wrapped as `toJobError(err, "pulls.get")`, so it is reported as a GitHub error and retried.

Fix:
- Call `ensureRepository(ctx.db, data.installationId, pull.base.repo, now)` and return `skipped` on `"removed"`, as the other jobs do.
- Keep the `toJobError` wrap around `pulls.get` only.
- Add the removed-repository case to I-REV-REQ-1.

### 2. minor: the `provenance_published` reviewer sync is untested

`src/modules/pilot/reviewers.ts:279-294`.

This is the second half of review 1's finding 3: a request made before the change existed is caught by a later sync. Mutation N12 removes it and nothing fails. Note also that the listener is still named `onFeedbackRecorded`.

Fix:
- Add a test: a `provenance_published` signal enqueues one `rev-sync-open:{repo}:{pr}` job, and a second signal for the same PR does not add another.
- Rename the listener (for example `onChangeSignal`).

### 3. minor: four safety lines have no test, and one test cannot fail

- **N11:** the preflight check that refuses a renamed repository (`src/e2e/preflight.ts:303-308`). The check also throws inside the `try` whose `catch` rewrites every error: for `setup`, a renamed repository is reported as "sandbox missing; rerun with --create --yes", which is the wrong advice. Move the check after the `try`.
- **N14:** the check of the created repository's `full_name` in `src/e2e/setup.ts:110-112`. On that failure path `s.guard.allowCreate` also stays `true`; reset it in a `finally`.
- **N15:** the `GRAFT_E2E_*` filter in `runSpawn`, `src/bin/graft.ts:194-199`. Extract it into a small exported function and unit-test it.
- **N8:** U-LIVE-SEC-3 asserts `toMatchObject(GIT_ISOLATION)`, the constant it is checking, so removing a key from that constant cannot fail it (`test/unit/live-e2e-secrets.test.ts:268`). Assert the literal values instead (`GIT_CONFIG_GLOBAL: "/dev/null"`, `GIT_CONFIG_NOSYSTEM: "1"`, `GIT_TERMINAL_PROMPT: "0"`).

Fix: one test per line above, and the two code corrections named.

### 4. minor: "was requested" is now written from the payload

`src/modules/pilot/reviewers.ts:144-152` and `:264-271`, and README §7 ("Product fixes found by the first review").

The README says the payload "is only a trigger". It is not quite: the payload's `requested_reviewer` becomes a `pr_reviewers` row with reason `requested`. The permission check verifies standing, not that the request happened. As argued under (a), this grants nothing that a genuine signed event did not already establish, so the risk is low. But it is the first exception to the step-2 rule that jobs write only API data, and the README presents it as following the rule.

Fix, either of:
- Confirm the request from the API: `issues.listEventsForTimeline` keeps the `review_requested` event (with `requested_reviewer.id`) after the review, and `issues: read` covers it (A13). Record the row only if such an event names the user.
- Or keep the current code, and record it in README §5 ("Webhook replay") as a named exception with its reasoning.

### 5. nit: git children still inherit `GIT_*` variables from the user's environment

`src/e2e/git-pusher.ts:24-28` and `:52`.

`GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM` do not stop `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` or `GIT_CONFIG_PARAMETERS` from injecting configuration such as `url.*.insteadOf`. They also do not stop an inherited `GIT_ASKPASS` (VS Code's integrated terminal sets one) from being used by the clone. `GIT_TRACE_CURL` would write the Authorization header to stderr; that output is captured and never echoed, so it does not leak.

Fix: start each git child from the environment without `GIT_*` variables, then add `GIT_ISOLATION` (and, for the push, the askpass variables).

### 6. nit: before step 6 of `setup`, any installation id may be minted

`src/e2e/guard.ts:190-193`.

`guard.installationId` is `undefined` in `setup` and `cleanup` (it is only set in the `run`/`verify` preflight), so the mint check allows any id there. The probe is only built with the id just read from `getRepoInstallation`, so in practice this is harmless.

Fix: set `guard.installationId` in setup step 6 before calling `clients.probe`, and refuse a mint while it is `undefined`.

## Review 1 findings: status

| # | Status |
| --- | --- |
| 1 Installation scope and s10 binding | fixed, tested (U-LIVE-GUARD-4, U-LIVE-CLI-3) |
| 2 Intent task race | fixed in the product, tested (I-INT-TASK-1, I-INT-TASK-2); s01 asserts `linked_issue_number`; s07 (d) carries `Graft-Task` again |
| 3 Reviewer request lost | fixed, tested (I-REV-REQ-1, I-REV-REQ-2); remaining work in findings 1, 2 and 4 above |
| 4 HUMAN-TODO ticking | fixed: check items are ticked, action items are annotated, `--wait-cron` documented, tested (U-LIVE-REP-2) |
| 5 Redirects and name-only guard | fixed (U-LIVE-GUARD-5); the rename refusal is untested (finding 3) |
| 6 Route allow-lists | fixed, tested |
| 7 git isolation | fixed (askpass, no helpers, push to the created `full_name`); remaining work in findings 3 and 5 |
| 8 Offline report | fixed: the live variant by default |
| 9 Offline output and child environment | fixed; the environment filter is untested (finding 3) |
| 10 s10 fingerprint | fixed |
| 11 Vacuous assertions | fixed |
| 12 Public mode | tested (I-LIVE-PUBLIC-1) |
| 13 Token-minting scope | fixed; small gap in finding 6 |
| 14 b2 request log | fixed |
| 15 INV-5 granularity | not addressed; still a nit, and acceptable |
