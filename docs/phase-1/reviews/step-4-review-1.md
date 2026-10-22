# Step 4 review 1: Post-merge guard, detection and culprit

**Verdict: CHANGES REQUESTED**

Reviewer: senior engineer (Opus). Scope: the 13 commits `de2d9fc..57c1bae` on `claude/phase-1-step-4-guard-detection` (PR mmornati/graft#26), reviewed on the local branch `claude/phase-1-step-4-review`: 58 files, +5459/−50. The last commit, `57c1bae`, is the coordinator's integration fix after the rebase onto step 3, and I reviewed it like the others. I judged them against `docs/phase-1/step-4-guard-detection.md` (binding), the Phase 1 plan, the earlier Phase 1 specs and reviews, the Phase 0 constraints, and the "Phase 1 step 4: guard detection" section of `docs/decisions.md`.

PR #26 was merged into `main` (`56f7bc5`, same tree as `57c1bae`) while this review ran. The findings below are therefore follow-ups on `main`, and "Required before approval" means "required before step 5 builds on the guard".

## Summary

This is a solid step:
- All 12 tasks are implemented, and every §13 test ID exists. I ran the definition of done myself, and it is green.
- All 11 spec mutations are killed. So is the developer's extra D17 mutation, and 9 of the 14 extra mutations I added.
- The D17 deviation (`guard.checks` read from the last green commit, not from the failing one) is correct and better than the spec.

The safety core holds:
- **Report mode stays inert.** The only new write is one `POST …/issues/{n}/comments` through the default client. There is no `guard` feature client, and no `phase1` route is used (N-1g, N-8).
- **No GitHub call inside the repository lock.** Every API read happens before `withRepositoryGuardLock`. The comment is written afterwards under the change lock, as D11 says.
- **Payloads only trigger.** Classes, history and PR mappings come from the API. I-GRD-5 and the M6 mutation prove it.
- **Bounded storage.** The tables store names, SHAs and classes, never output or logs, and the purge map is complete.

The D12 claim that "the window equals the delay" holds at both boundaries, so no needed observe is swallowed.

One major finding blocks approval, and it is in the integration commit. The guard scenario of the neutral suite moves `main` to a commit with no `graft.yaml`, so the step 3 break-glass scenarios that run after it (N-10, N-11) now test break-glass over `no_policy`, not over a real policy. They still pass, so nothing shows the change.

The minors are detection gaps. Each one fails toward silence (no false blame), but each one loses a true culprit:
- a late green on the parent does not narrow an open event, which then settles `ambiguous`;
- the `status` branch hint can omit the default branch;
- an event that is still undecided at the deadline is never examined again;
- a transient error in the D17 attempt loop loses the event for good;
- retention prunes the tip of a quiet repository, so the next merge has no baseline;
- the trust boundary of D17 is narrower than its docs say;
- five rules have no test.

## What was checked

### Definition of done (spec §15), run by me

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK ("Already up to date") |
| `pnpm db:up` | Not run. I reused the shared container on 127.0.0.1:55432 and started or stopped no container. |
| `pnpm lint` | OK (338 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm test` (`TEST_DATABASE_URL=…/graft_test_review4`) | OK: 98 files, **1091** tests passed (the step 3 break-glass suite included) |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0; every threshold passes, `matchBaseline: 1` |
| `db:migrate && db:status` (scratch DB `graft_review_s4`) | 0001..0011 applied |
| `db:rollback && db:status && db:migrate` | Only `0011_guard` rolled back (`pending`), then re-applied. Scratch DBs dropped afterwards. |
| `@ts-ignore` / `@ts-expect-error` grep | Clean |
| `src/guard/` import grep | Clean (`detect.ts` imports nothing) |
| `feature: "guard"` grep | Clean |
| `rest.(git\|pulls).(create\|update)\|rerequest\|reRun` in `src/modules/guard/` | Clean |
| Test ID grep | 52 lines. I also checked each §13 ID one by one (U-DET-1..14, U-GCM-1..4, U-PGD-1..2, I-GRD-1..16, N-8, N-9, U-MAN-5): none is missing. |

I did not run the manual smoke test. It needs a dev server, a worker and `pnpm webhook:send`, and the developer listed it in HUMAN-TODO.

### Mutation checks (spec §15)

I applied each mutation alone with a script, ran the named test files, then restored the files. `git status` was clean after each one.

| # | Mutation (how I applied it) | Result |
| --- | --- | --- |
| M1 | `cancelled` counted as red (`case "cancelled"` added to the red cases) | Killed: U-DET-1, U-DET-11 |
| M2 | Already-red main opens an event (the `already_red` return removed) | Killed: U-DET-6 |
| M3 | Two PRs blamed on the last one (`prs.size >= 1`, last PR returned) | Killed: U-DET-4, U-DET-7, U-DET-14 |
| M4 | Search crosses a chain break (`chainUpTo` ignores `chainBreak`) | Killed: U-DET-9 |
| M5a | Confirmation skipped: event final at detection with confirm on (`observe.ts`) | Killed: I-GRD-6, I-GRD-7 (both), I-GRD-8, I-GRD-10b |
| M5b | Confirmation skipped: `confirmationDetail` always confirms (pure) | Killed: U-DET-13, I-GRD-6, I-GRD-7 (both), I-GRD-8, I-GRD-10, I-GRD-10b |
| M6 | Result class from the payload (the handler carries `conclusion` into the job, which overrides every check-run class) | Killed: I-GRD-5 (I-GRD-4 also fails) |
| M7 | Handler enqueues for PR-branch check runs (`head_branch` test removed) | Killed: I-GRD-4 |
| M8 | No marker check before commenting | Killed: I-GRD-6, N-1g [default/max], N-9 [default/max] |
| M9 | No advisory lock (`pg_advisory_xact_lock` removed) | Killed: I-GRD-10, three runs out of three |
| M10 | `guard.checks` ignored | Killed: I-GRD-12 |
| M11 | Comment posted for `ambiguous` (status, change id and publish rules widened) | Killed: I-GRD-9 |

Extra mutations (mine), run against `guard.test.ts`, `guard-detect.test.ts` and `guard-comment.test.ts`:

| # | Mutation | Result |
| --- | --- | --- |
| X1 | `lineTo` follows parents across a chain break | Survives. Benign: `chainUpTo` cuts at the break as well (M4), so there are two layers. |
| X2 | `run.head_sha !== o.sha` filter removed | Survives. Benign: `listForRef` is per SHA. |
| X3 | Graft's own check runs counted (`appId === githubAppId` removed in `readCheckRuns`) | **Survives** (finding 8) |
| X4 | An older `completed_at` overwrites a newer result (§6.3) | **Survives** (finding 8) |
| X5 | D8: a second key never joins an open event | **Survives** (finding 8) |
| X6 | Comment ownership: any author's marker adopted | Killed: guard-comment "the marker is ours only when…" |
| X7 | `safeHtmlUrl` host check removed | Killed: U-GCM-3 |
| X8 | Prune no longer keeps the candidates of `confirming` events | Killed: I-GRD-15 |
| X9 | Observe continues after the inline track when the SHA is still unknown (`not_on_default_branch` removed) | **Survives** (finding 8) |
| X10 | A forced push is not a chain break | Killed: I-GRD-2 |
| X11 | D6: `base.ref === defaultBranch` filter removed | **Survives** (finding 8) |
| X12 | D6: two merged PRs no longer give `multiple` | Killed: I-GRD-3 |
| X13 | Statuses read without `statuses: read` | Killed: I-GRD-11 |
| X14 | The handler accepts Graft's own check runs | Killed: I-GRD-4 |

### Extra probes

I ran each one as a throwaway test file against the fake world and deleted it afterwards.
- **P1, a late green on N−1.** C1 green, C2 = PR 7 still running, C3 = PR 8 red, so the event opens with candidates [C2, C3]. C2 then turns green, and C4 is red. Result: `ambiguous`, `last_green_sha = C1`, 2 candidates. The right answer is `culprit_found #8` (finding 2).
- **P2, a confirm that runs 1 s early.** `confirming()`, then `advance(7199)`, `confirmEvent`, then a day passes. The event is still `confirming`, and the one `guard.confirm` job is the only one there is (finding 4).
- **P4, a transient error in the D17 attempt loop.** I blocked the dry run's `graft.yaml` read for C1, let `observe(C2)` (green) commit, then failed the in-loop read for C2 with a 502. The first job throws. Its retry returns `observed` with **0 events**, although C3 is red after a green C2 (finding 5).
- **P6, a quiet month.** History C1..C2 is green. I advanced 31 days, ran `guard.prune`, then pushed C3 (PR 8) red. C3 is stored with `chain_break = true`, and no event opens (finding 6).
- **P7, a decoy run.** On C2, `test` fails and a second `test` run from the same app succeeds 4 s later. No event opens (finding 7).
- **P8.** `safeHtmlUrl("https://github.com/someone-else/phish#x", "https://github.com/")` returns the URL (nit 9).
- **P9.** Observe on a SHA that is not on `main`: `not_on_default_branch`, and no `ci_results` row. The code is right, but X9 shows that no test pins it.
- **Neutral suite, after `57c1bae`.** I temporarily made N-11 print the break-glass verdict on the next head: `policy_status missing`, `outcome no_policy`, `policy_commit_sha = NEXT_SHA` (finding 1).
- **D12 boundaries, by hand.** `observeKey` with a delay `d` gives window `W = floor(t/d)`. The first trigger at `t1 ≥ W·d` creates a job that starts at `t1 + d ≥ (W+1)·d`, and every later trigger of that window is `< (W+1)·d`. At `t1 = W·d` exactly, the job starts at `(W+1)·d` and the last possible trigger is strictly before it. The key comes from the sender's clock and `start_after` from the database clock, but the offset cancels because it shifts both sides equally. The one exception is a key and a start time taken on two hosts whose clocks disagree in the same window. So the claim holds.

### Safety review

- **Singleton keys** (the step 2 review 1, finding 1 class of bug). Each key was checked for a later, needed run being swallowed:
  - **`guard:observe:<repo>:<sha>:<window>`.** Safe (see D12 above). A failed observe also leaves its row for 7 days, but later triggers fall into new windows.
  - **`guard:track:<repo>:<before>:<after>`.** The only collision is a rewind followed by a re-push of the same pair, or a redelivery of a push whose job failed. In both cases the commits are either already stored, or recovered by D13's inline track on the next observe. Benign.
  - **The fan-out from track.** It is a single `scheduleObserve(after)` with the observe key. Benign.
  - **`guard:confirm:<eventId>`.** One job per event, by construction. It cannot be swallowed, but it is also never re-sent, so a `wait` at the deadline is final (finding 4).
  - **`guard.prune`.** A cron with no key.
- **Locks.**
  - `withRepositoryGuardLock` bodies (`observe.ts:500-545`, `track.ts:245-266`) call only the database and `queue.send({ tx })`.
  - The baseline `graft.yaml` reads happen before the lock (`observe.ts:474-495`) or between passes (`:550-552`).
  - The comment's `listComments` and `createComment` run inside `withChangeLock` (`comment.ts:220-266`), which is D11 as written and the Phase 0 managed-comment pattern.
  - The two locks are never held at once.
  - Confirmation races are serialised: `confirmOpenEvents` re-reads the open events inside the lock, and the publish re-reads the event `FOR UPDATE`, searches for the marker, and stores the id in one transaction.
- **Detection.**
  - First parents are followed by `parent_sha` (`store.ts:153-173`), so a rewound branch's abandoned commits never count. A forced push, an unknown parent, a root and the walk bounds all give a break.
  - Rebase merges map through `commits/{sha}/pulls` (I-GRD-3, U-DET-5).
  - I-GRD-10b's move to an earlier failing commit is correct. The symmetric case, a late green on the parent, is missing (finding 2).
- **Trust.**
  - The handlers decide only whether to enqueue (`handlers.ts:80-144`).
  - The job re-reads the default branch (`repos.get`), checks the repository id, and stops on a SHA that is not on the default branch.
  - A replayed or forged delivery can at most cost API reads.
  - Only the default branch's own history and results drive a verdict.
  - However, the candidate PR controls the CI that produces those results (finding 7).
  - `html_url` and `target_url` are kept only under the GitHub web root and without `@()<>` or spaces (nit 9).
- **The comment.**
  - The marker is the first line, and "ours" means `performed_via_github_app.id` or the App's bot login (X6 is killed).
  - Check names and the branch go through `codeSpan`. SHAs are 7-character code spans, and the link cannot contain `@`.
  - With 5 names of 80 characters, a 100-character branch and a 500-character link, the body cannot reach 4,000 characters, and `renderGuardComment` refuses beyond that.
  - `ambiguous`, `no_culprit` and `flaky` events never reach `publishGuardComment` (M11 is killed).
- **Report-mode inertness.**
  - N-1, N-1g, N-8 and N-9 pass in both profiles, and I-GRD-13 shows that enforce changes only the last line.
  - The step 1–3 suites are green. The break-glass scenarios still pass, but over a weaker precondition (finding 1).
- **Storage and privacy.**
  - `main_commits` holds SHAs, the first parent, `seq`, PR numbers and times. `ci_results` holds the key, name, source, class, a vetted link and times. `guard_events` holds keys, names, SHAs and PR numbers.
  - Job payloads hold ids, SHAs and the branch name.
  - Names are logged only at debug (`observe.ts:462`, `:527`, `:537`), and error routes go through `toJobError`.
  - Retention is daily and bounded. `confirming` events pin their commits (X8 is killed).
  - The purge map has `main_commits` and `ci_results`, `guard_events` was already covered, and I-GRD-15 and I-PURGE-1/2 pass.
  - The doctor still reads only the database.

### Developer-reported deviations

| Deviation | Judgement |
| --- | --- |
| T1 (a): Apps with `checks` receive other apps' `check_run`/`check_suite` `completed`; the +5/+30 min fallback is not built | **Accepted.** That matches GitHub's documentation, and HUMAN-TODO checks it live. If it were wrong, `push`, `status` and `guard.confirm` would still trigger observes. |
| T1 (d): `status.branches` are "the branches whose tip is that commit (up to 10)" | **Not accurate** (finding 3). GitHub documents them as branches that *contain* the SHA, up to 10, so the default branch can be missing from the list. |
| D2: no `actions: read`, no `workflow_run` | Accepted (least privilege; U-MAN-5). |
| D12: the observe window equals the delay | **Accepted and verified** at both boundaries (extra probes). |
| `guard.track` key, `branch` in the job data | Accepted (see the singleton review: the only collision is benign). |
| The chain is followed by parents, not `seq` | Accepted, better than the spec. |
| D6 newest first; a 404 counts as `unresolved` | Accepted (fails toward `ambiguous`). |
| Upsert rule (null never replaces a completed result; equal times do nothing) | Accepted. Untested: X4 survives (finding 8). |
| The event moves to the earlier failing commit (I-GRD-10b) | Accepted. The symmetric narrowing is missing (finding 2). |
| D8 "open" means `confirming` | Accepted. Untested: X5 survives (finding 8). |
| More than 50 candidates are stored as 49 plus one `truncated` entry | Accepted (a cut list never reads back as a culprit). |
| `culprit_change_id` is set at detection | Accepted. |
| An event still undecided at the deadline is not rescheduled | **Not accepted** (finding 4). "Later triggers settle it" does not hold on a quiet repository, which is the case D9's time bound exists for. |
| The comment is retried by every observe (at most 20 per repository) | Accepted. With the marker search, a crash between the POST and the commit is harmless (I-GRD-6 and N-9 cover it). |
| Comment wording, links | Accepted; one nit on links (nit 9). |
| `guard.checks` error codes; hashes unchanged without `guard` | Accepted. U-PGD-1 pins the earlier hashes. |
| `mode show` notes, doctor checks, `guard list` format | Accepted. |
| Neutral suite: delay 0, `guard.confirm` run directly, the guard scenario last, N-2 limited to app 12345 | Accepted for step 4 alone. After the rebase, the scenario's end state leaks into step 3's scenario (finding 1). |
| **D17: `guard.checks` read from the baseline, not from N (security review)** | **Accepted, better than the spec.** Reading it at N let the culprit drop its own failing check, and I-GRD-12b catches that. Two caveats: the attempt loop that makes it lock-safe has a loss path (finding 5), and the stated principle "a candidate must not be able to filter its own failure" holds for `guard.checks` only, not for the CI the candidate controls (finding 7). `KeyResult.filtered` is now dead code in production (nit 10). |
| Migration `0011_guard` | Accepted. The order with `0010_audit_log` is right, and the up/down/up was run on a scratch DB. |
| **`57c1bae`, I-BG-1** | **Correct.** It steps down through `0011_guard` before `0010_audit_log`, and restores both in `finally`. |
| **`57c1bae`, `graft-ops` `mode show` note** | **Correct**, and covered: I-GRD-16 (`guard.test.ts:815-819`) asserts both the presence and the absence of the note through `graft-ops`, so a lost merge hunk fails a test. |
| **`57c1bae`, the neutral suite reopens PR 2** | **Not accepted as is** (finding 1). It reopens a merged PR, which GitHub cannot do, and it leaves `main` on a commit without `graft.yaml`. |

## Findings

### 1. major: after `57c1bae`, the neutral suite's break-glass scenarios run with no `graft.yaml` on `main`

The step 4 guard scenario moves `main` twice:
- to `MERGE_SHA`, with `graft.yaml` (`test/integration/neutral.test.ts:417-418`);
- then to `NEXT_SHA`, **without** any `graft.yaml` (`:421`).

It never moves it back. The policy job reads the policy at the base branch's tip (`src/modules/policy/job.ts:265-279`). The step 3 break-glass scenario runs later in the same suite, and `57c1bae` reopens PR 2 for it (`neutral.test.ts:769-775`). From that point every evaluation reads `NEXT_SHA`.

My probe in N-11 printed `policy_status missing`, `outcome no_policy` for the next head. On `main` before step 4, the same scenario evaluated the team policy at `B2`. So both N-10 and N-11 now prove that break-glass bypasses a `no_policy` failure, not an approvals failure. They still pass, because N-11 asserts only `not.toBe("success")` for the next head.

The suite is the safety net for report-mode inertness and break-glass. A silent change of its precondition in an integration commit is the kind of step 3 × step 4 interaction the rebase should have surfaced.

The reopen also models something GitHub cannot do: a merged PR cannot be reopened. It drives the `changes` row from `merged` back to `open`, with `merge_commit_sha` null, under a guard event that names it as the culprit.

**Fix:**
- Give the guard scenario its own PR (for example PR 3, merged as `MERGE_SHA`), so that PR 2 stays open and the reopen block goes away.
- Put the same `graft.yaml` at `NEXT_SHA`, or set `branches.main` back to `B2` at the end of the guard scenario.
- In `breakGlassScenario`, assert that the scenario's verdicts have `policy_status = "ok"` and the expected base commit, so that a future scenario cannot change the precondition silently again.

### 2. minor: a late green on the parent does not narrow an open event, which then settles `ambiguous`

Detection runs only for the keys whose class changed **on the observed commit** (`src/modules/guard/observe.ts:503-505, 514-541`). When N is observed red before N−1 has a result, the event opens with candidates [N−1, N] and `last_green_sha` N−2. If N−1 is then observed **red**, the event moves to it (I-GRD-10b, `:293-316`). If N−1 is observed **green**, nothing revisits the event. `confirmOpenEvents` settles it from the stored candidates (`:387`), so two squash merges give `ambiguous`.

Probe P1 shows exactly this: `ambiguous` with 2 candidates where the answer is `culprit_found #8`. It happens whenever the parent's CI finishes after the child's observe (queueing, a slower matrix, a manual re-run). This fails safe, with no wrong blame, but it loses a true culprit in a common merge pattern. Spec §6.4 has the same gap, so the developer followed it.

**Fix:** in `confirmOpenEvents`, before `confirmationDetail`, re-run `detectTransition` at `e.failing_sha` for the event's keys against the current line. If the nearest result before the failing commit is now a later green, narrow `last_green_sha`, `candidates` and `culprit_change_id`, as the move does. Do this only while the event is `confirming`. Add P1 as I-GRD-10c and record it in decisions.md next to I-GRD-10b.

### 3. minor: the `status` handler drops a default-branch status when `main` is not among the listed branches

`guardStatus` enqueues only if `branches[].name` includes the default branch (`src/modules/guard/handlers.ts:141`). decisions.md (T1 (d), line 487) records `branches` as "the branches whose tip is that commit (up to 10)". GitHub's webhook reference describes them differently: the branches that **contain** the SHA, which may or may not be their head, at most 10. On an active repository, many branches contain a recent `main` commit, so `main` can be cut from the 10. A status-only CI (Jenkins and other older systems) then never triggers an observe for that commit.

The other triggers do not cover this. `push` only observes `after`, so the failing commit's own status result is read only if some trigger names that SHA. In practice, statuses on non-tip commits are missed.

**Fix:** enqueue when the list names the default branch **or** has 10 entries (it may have been cut). The job already verifies that the SHA is a tracked default-branch commit, so a false positive costs one `getMainCommit`. Correct T1 (d) in decisions.md, and add a case to I-GRD-4 with 10 branches that do not include `main`.

### 4. minor: an event still undecided at its deadline is never examined again

`guard.confirm` is sent once per event, at exactly `detected_at + window`, with a per-event singleton (`observe.ts:351-361`). If that one run returns `wait` (`:386`), nothing reschedules it, and decisions.md line 503 relies on "later triggers". On a quiet repository, which is the case the time bound of D9 exists for, there are none. The event stays `confirming` for good. It also pins its commits against pruning forever (`store.ts:452-460`).

Two ways to get there:
- **The failing result became `ignored`.** A re-run that ends `cancelled` has a newer `completed_at`, so it replaces the red one, and then neither rule 2 nor rule 3 of D9 applies.
- **The confirm job sees the window as not yet elapsed.** The start time comes from the database clock at send time (the transaction's `now()`), and the elapsed check uses the confirming worker's clock against the detecting worker's `now`, with zero margin. If those two clocks differ by more than the queue's pickup latency, the job runs "early". Probe P2 shows that a run 1 s before the deadline leaves the event `confirming` with no job left.

The doctor warns after twice the window, but nothing settles the event, and `guard list` shows it as open indefinitely.

**Fix:**
- Schedule the confirm at `window + 60 s`.
- On `wait`, re-send it once or twice with a new key (`guard:confirm:<id>:<n>`) and a later start.
- Alternatively, have the daily `guard.prune` cron settle overdue `confirming` events, for example as `flaky` with a new reason, or by a last re-observe.

Record the choice and add a test: a run before the deadline, then a later one that settles.

### 5. minor: a transient error inside the D17 attempt loop loses the event for good

When a transition's baseline file was not loaded before the lock, pass 0 **commits** its upsert and returns `null` (`observe.ts:543`). The loop then reads the file between passes (`:550-552`). If that read throws a transient error (rate limit, 5xx), the job fails and is retried. On the retry, `upsertResults` finds the classes unchanged, so `redKeys` is empty (`:503-505`) and no transition is evaluated. The red commit never opens an event.

Probe P4 reproduces it: I blocked the dry run's read, let the parent's green observe commit, then failed the in-loop read with a 502. The retry ends `observed` with 0 events. A worker crash between the passes has the same effect. The window is narrow (it needs a concurrent observe of an ancestor), but the loss is silent and permanent.

**Fix:** do not commit the pass that sets transitions aside. Throw a private sentinel from the lock callback when `missing.size > 0`, so that pass rolls back, and catch it outside. Alternatively, compute the keys to judge as "red on this commit and not yet in an event at or after it", not "changed in this upsert". Either way, a retry sees the transition again. Turn P4 into a test.

### 6. minor: retention prunes the tip of a quiet repository, so the next merge has no baseline

`pruneOlderThan` deletes by `tracked_at` and `observed_at` alone and keeps only what `confirming` events reference (`store.ts:447-470`). On a repository with no push for `GRAFT_GUARD_RETENTION_DAYS` (30 by default, 7 at minimum), the whole history goes, including the tip and its green results. The next push then stores its commit with `chain_break = true`, because the parent is unknown (`track.ts:255-261`), and that commit can never be blamed. Probe P6: after 31 days and a prune, a red merge on top of a green tip opens nothing. Low-traffic repositories are where a broken `main` stays unnoticed longest.

**Fix:** never prune each repository's newest commits. For example, keep the newest commit, and its results, of every repository; or keep the newest 50 commits whatever their age. Add a case to I-GRD-15.

### 7. minor: the candidate controls the CI, so D17's principle is narrower than the docs say

decisions.md (line 515) and `docs/features/guard.md:85` present the D17 fix as "a candidate must not be able to filter its own failure". That is true for `guard.checks`. The candidate still controls the workflows that produce the results, and some routes to its own verdict are subtler than editing the test:
- **A decoy run.** A second workflow with a job of the same name (same app, so same key) that succeeds a little later wins under D4's "latest `completed_at`" (`observe.ts:112-120`). Probe P7: no event opens, while GitHub still shows the real `test` as red.
- **Writes from the workflow token.** A workflow running on `push` to `main` with the default token can post check runs (as the Actions app, so with the same key) or statuses on **other** commits. A red `test` on N−1 makes `main` "already red". A green one on N, completed later, makes the event `flaky`.

None of this lets anyone blame an innocent PR, so it is not a safety issue for report mode. It does matter for step 5, where a confirmed culprit becomes a revert, and for how the feature is described to pilot teams.

**Fix:**
- State the trust boundary in `docs/features/guard.md` and decisions.md. The guard detects breakage; it is not a control against a hostile merge, which can always change its own CI.
- Cheap hardening: in `readCheckRuns`, when two runs share a key but belong to different check suites, let red win. GitHub Actions re-runs stay in their check suite, so genuine re-runs keep D4's "latest wins".

Revisit this with step 5's threat model.

### 8. minor: five rules have no test

The code is correct for each of these, but nothing stops a regression:
- **X3:** Graft's own check runs counted. This matters in enforce mode: a `graft/policy` `failure` on a commit that reaches `main` unchanged (a fast-forward or a direct push of a PR head) would turn red and blame that PR for Graft's own verdict.
- **X4:** an older result overwriting a newer one (§6.3).
- **X5:** D8, a second key joining an open event (several keys on one commit, or a later key with the same culprit).
- **X9:** observe stopping with `not_on_default_branch` after the inline track (P9 shows that it does stop).
- **X11:** D6's `base.ref === default branch` filter, which matters for a commit that was also merged into a release branch.

**Fix:**
- Add a run from app `GITHUB_APP_ID` with `failure` to I-GRD-6 or I-GRD-11, and assert that it opens nothing.
- Add an out-of-order observe to I-GRD-5.
- Add a second red key to I-GRD-6, and assert both keys in `failing_checks` and in the comment.
- Add a non-main SHA to I-GRD-4, and assert no `ci_results` row.
- Add a merged PR with `base.ref: "release"` to I-GRD-3.
- Re-run X3, X4, X5, X9 and X11.

### 9. nit: a status `target_url` can link anywhere on github.com

`safeHtmlUrl` accepts any URL under the web root (`src/modules/guard/comment.ts:71-76`). A status's `target_url` is chosen by whoever posts it, so the comment's details link can point to `https://github.com/someone-else/…` (P8). For statuses, require the prefix `<webBase><owner>/<repo>/`, or do not link statuses at all. Check-run `html_url` values come from GitHub and are fine.

### 10. nit: `filtered` in `detect.ts` is dead code in production

After the D17 change, `ci_results.filtered` is always false, and the allow-list is applied in `observe.ts:535-539`. `KeyResult.filtered` and `why: "filtered"` (`src/guard/detect.ts:32-33, 136`) are reachable only from U-DET-12. Either remove them and point U-DET-12 at a pure helper that applies the baseline allow-list, or document that they are kept for step 7's metrics.

### 11. nit: a fork PR from a branch with the default branch's name costs an inline track per SHA

The `check_suite.head_branch` hint is the head branch's name, so a fork PR from a branch called `main` passes `guardCheckRun` and `guardCheckSuite`. Each new SHA then costs `repos.get` twice (`observe.ts:428` and `track.ts:198`), `git.getRef` and `listCommits` before `not_on_default_branch`, once per 30-second window. This is bounded, but avoidable. Skip the inline track when `check_suite.pull_requests` is non-empty or the head repository differs, or keep a short negative cache per SHA. Also pass the branch already read to `trackDefaultBranch`, so `repos.get` is not called twice.

### 12. nit: the guard's `changes` rows and step 3

`guard.track` creates `changes` rows for merged PRs it maps through the API (`track.ts:176`). That is what D6 asks. Step 3's "merged under break-glass" note (spec §2) will need the break-glass verdict of exactly that change. Make sure the step 5 spec reads it by `change_id` and the merged head, not by PR number, because finding 1's fixture shows how easily one PR ends up playing both roles.

## Required before approval

Finding 1, with the precondition assertion in `breakGlassScenario`, because the neutral suite has to test what its names say. I recommend findings 2, 4 and 5 as well. Each one is small, and each one loses a true culprit in a realistic case: a slower parent, a quiet repository, a transient error. They should be fixed before step 5 turns a confirmed culprit into a revert PR. Findings 3, 6 and 8 should land in the same follow-up. Finding 7 needs a documentation change now and a design answer in step 5. Nits 9 to 12 are optional.
