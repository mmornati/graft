# Step 3 review 2: Break-glass and audit log

**Verdict: APPROVED**

Reviewer: senior engineer (Opus). Scope: `origin/main..c6bfeee` on `claude/phase-1-step-3-review-fixes` (PR mmornati/graft#27), 9 commits, 27 files, +1375/−203:
- the review 1 file;
- the developer's fix commits (`a38a1b5..f3b6038`);
- the coordinator's rebase commit `c6bfeee`, which stacks `0012` on `0011` in the step-down tests.

I judged them against review 1 (`docs/phase-1/reviews/step-3-review-1.md`), the "Phase 1 step 3: break-glass" section of `docs/decisions.md` with its "Review 1 fixes" record, and `docs/phase-1/step-3-break-glass.md` (binding).

## Summary

Both majors are resolved.

**Finding 1.** The actor is now tied to the label action that queued the run:
- The delivery's `sender.id` is only an equality filter. It can refuse a bypass but never grant one.
- The newest label event of either kind decides. An `unlabeled` newest event never falls back to an older `labeled` one.
- The retry is bounded by the queue's own retry budget. The last attempt fails closed.

**Finding 2.** A bypass is now bound to its issue event (`label_event_id`), and revocation is scoped to the change:
- An unlabel delivery ends the bypass even when the label is back.
- `mergedUnderBreakGlass` uses the same rule as the job.
- With the four source files of the fix reverted to `main`, all of R3-A1, R3-A2, R3-B1, R3-B2 and R3-B3 fail again (I-BG-16 to I-BG-20).

**The rest.** Findings 3, 4 and 5 and nits 6 and 7 are fixed. Nit 8 is deferred with a documented limit, and I agree with that. The two fail-closed side effects in the record are the right trade-off. Report mode is still inert. Steps 1, 2 and 4 are green. The coordinator's rebase commit is correct. The branch merges cleanly with PR #28, and the merged tree keeps #28's team-policy guarantee for the break-glass scenario.

No blocker, major or minor remains. Five nits are listed below: three are test gaps on refuse-only paths, one is about the retry budget, and one is a stale paragraph. None of them blocks the merge.

## Review 1 findings

| # | Finding (review 1) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | major: the actor is not bound to the label action that triggered the run | **Resolved** | See "Finding 1 in detail". Reverting the fix fails I-BG-16 and I-BG-17. Mutations F1a, F1b, F1d, F1e and F1f are killed. F1c survives (nit 1). |
| 2 | major: revocation drifts | **Resolved** | See "Finding 2 in detail". Reverting the fix fails I-BG-18, I-BG-18b and I-BG-19. Mutations F2a to F2e are killed. F2f and F2g survive, but both guards are redundant (nit 2). |
| 3 | minor: a push does not end the bypass for good | **Resolved** (the code was fixed, not the wording) | `break-glass.ts:258` ends an active row for another head, with no read. Removing that line fails I-BG-6, I-BG-19, I-BG-20, N-10 and N-11 (F3). The residual is documented in `docs/features/policy.md` "Known limits": a move away and back before any evaluation reads the new head. That is acceptable. |
| 4 | minor: a label-triggered verification can be dropped silently | **Resolved** | `resendLabelRun` (`job.ts:272-279`) is called from the early stale exit (`:282`) and when nothing was committed (`:666`). The singleton per delivery bounds it to one re-send. Removing `:282` fails I-BG-23 (F4a). Removing `:666` survives, because the lock-time and mode-rollback path has no test (nit 3). |
| 5 | minor: the lost-race path has no test | **Resolved** | I-BG-22. X5 (no `recordAudit` in that branch) fails it (F5). |
| 6 | nit: the fakes cannot express findings 1 and 2 | **Resolved** | The world has an unlabel route, the real actor `type` and `issueEventsLag`, and the fake API has `afterNext`. U-LIVE-WORLD-2 covers them. N-10 and N-11 still write events by hand, as the record says. That is fine. |
| 7 | nit: unknown-actor dedup in the database; the tie rule untested | **Resolved** | 0012 recreates `audit_log_ignored_once` with `NULLS NOT DISTINCT`. X4 (`>=` → `>`) fails I-BG-24 (N7a). The index without `NULLS NOT DISTINCT` fails I-BG-24 (N7b). |
| 8 | nit: the 1,000-event cap is a cost and a lever | **Deferred** to step 7, and I agree | Reading the newest page first depends on real pagination headers, which T1 could not check offline. The cap still fails closed, and on a label trigger it now also ends an active bypass (`:314-326` and `:352-355`). The limit is in `docs/features/policy.md` "Known limits", and HUMAN-TODO asks the operator to check `Link: rel="last"`. |

### Finding 1 in detail

**The sender id only refuses.** `handlers.ts` reads `sender.id` into `breakGlassActorId` only for a `labeled` delivery of the break-glass label. No login enters the job. In `resolveBreakGlass` the id is used in a single place: the comparison at `break-glass.ts:359-364`. The actor, the login, the bot flag and the role all come from `newest` (the events API) and from `collaboratorRole`:
- A match still goes through the bot check and the role read (`:377-388`).
- A mismatch returns `ignored actor_unknown` before any role read.
- `break-glass.ts` has no `sender`, so the §12 grep keeps its meaning.

**An `unlabeled` newest event fails closed.**
- `readLabelEvents` walks the list newest first by position, not by `created_at`.
- `newest` is the newest event of either kind (`:180`).
- `labeller` is null unless that event is a `labeled` one (`:357-358`).
- I-BG-16 checks both halves: tom's re-label is not listed yet, and maya's own older `labeled` event is not used either. Mutation F1a (`newest = ev.labeled`) fails it.

**The retry is bounded and ends safely.**
- `canRetry` is `retryCount < retryLimit` (`context.ts:28-30`). That is the same test pg-boss applies when it fails a job (`CASE WHEN retry_count < retry_limit THEN 'retry'`), so the last attempt is the one where it is false.
- `LabelEventsBehind` is thrown outside the lock, before anything is published or written, and it is retryable (I-BG-21 asserts it is not a `PermanentJobError`).
- On the last attempt, the run records `ignored actor_unknown` and ends any active bypass.
- F1d (never retry) and F1e (retry whatever the count) both fail I-BG-21.
- Outside the worker, `attempt` is absent and counts as the last attempt, which fails closed.
- A re-sent run (finding 4) starts a new retry budget. It is sent at most once per delivery, so the total stays bounded.

**Holes I looked for:**
- **A sender id missing from a job queued before this deploy.** `breakGlassActorId === undefined` is not retried and gives `actor_unknown`, which also ends an active bypass. That fails closed, and nothing enforces before step 7. That rule has no test of its own (nit 1).
- **A delivery for another label name.** The handler sets none of the three fields unless `isBreakGlassLabel` matches. The run then takes the other-trigger path, which verifies nothing.
- **Replays.**
  - A GitHub redelivery has the same `scheduleKey` and is deduplicated.
  - A late `labeled` job whose user is still the newest labeller binds to that user's newest event, which matches the current state of the PR.
  - A late `labeled` job whose user is no longer the newest labeller retries, then fails closed.
  - A late `unlabeled` job ends the bypass. That is side effect 2 below.

### Finding 2 in detail

**The binding.**
- `applied` rows store `label_event_id` (`job.ts` `auditRowFor`, `labelEventId`). Mutation F2d fails I-BG-11 and I-BG-24.
- On every label trigger, `bound` (`break-glass.ts:314-326`) requires a complete read, no newer unlabel, and the newest `labeled` event's id equal to the stored id. Otherwise the job writes `removed`, then judges the current labeller from scratch.
- A row written before 0012 has no event id, so it is re-verified on its next label trigger.
- F2a (binding disabled) fails I-BG-18 and I-BG-25.
- The new `applied` row is stamped 1 ms after the `removed` row of the same run. F2e fails I-BG-14, I-BG-18, I-BG-21 and I-BG-25.

**The unlabel flag.** `breakGlassUnlabeled` ends the active bypass whatever `pulls.get` shows now (`:261-264`). F2b fails I-BG-18b, and I-BG-18b also checks that the handler sets the flag.

**Change-scoped revocation.** `activeRows` (`store.ts`) drops the head match from the `removed` subquery. `activeBreakGlass`, `activeBreakGlassForChange` and `mergedUnderBreakGlass` all go through it, so the job and step 5's reader agree by construction. F2c (removal scoped to its head again) fails I-BG-13.

**Paths where an `applied` row could still grant a bypass after the label changed hands or was removed:**
- **Between the change and the label job.** Other triggers replay an active row with no read (D6, D12). The window lasts until the `unlabeled` job runs, or until the re-label's job ends (at most the retry budget). It is bounded and documented.
- **Both webhooks lost.** If the `unlabeled` and the `labeled` deliveries are both lost, the old row survives while the label is on, because no label trigger ever runs. That needs two lost deliveries, and an operator redelivery fixes it. I accept it as residual, on the same footing as finding 3's residual.
- **D4 mismatch with an active row** (`:330`). The row is replayed only when it is still bound, which is correct: an older delivery never ends a bypass that is still bound to the newest event.
- **The cap.** `bound` requires `ev.complete`, so a truncated read ends the bypass.

I found no other path.

### The two fail-closed side effects

1. **The last attempt ends any active bypass**, even one bound to a newer, verified label by someone else. That happens when a late `labeled` job of an earlier labeller runs out of retries. The labeled webhook carries no issue event id, so the job cannot tell "an older delivery" from "a newer delivery the API does not list yet". Ending the bypass is the only safe choice. A maintainer re-labels.
2. **A late `unlabeled` delivery ends a newer bypass.** Checking first whether an unlabel is listed after the bound event would bring back R3-B1 under lag, because the unlabel may not be listed yet. The flag has to stay unconditional.

Both are recorded in `docs/decisions.md`. I agree with both.

### Migration `0012_audit_label_event`

- **Up** adds `label_event_id bigint CHECK (> 0)` and recreates `audit_log_ignored_once` with `NULLS NOT DISTINCT WHERE kind = 'ignored'`.
- **Down** restores the 0010 index definition and drops the column.
- `NULLS NOT DISTINCT` needs Postgres 15 or later. The project assumes 17: the Phase 0 step 1 spec chose Postgres 17 for exactly this feature, and 0001, 0005 and 0006 already use it. The shared server I tested on is 17.11. CI and `docker-compose.yml` now run 18.
- **Order.** 0012 sorts after `0011_guard` in `migrations/index.ts`. On a scratch database, migrate applied 0001 to 0012. Rollback removed only `0012_audit_label_event` (`pending`), and migrate re-applied it.
- `up` would fail on duplicate unknown-actor rows. The store has always prevented them under the lock, so that is acceptable.

### `ctx.attempt`

- The worker passes `{ retryCount: j.retryCount, retryLimit }`. `retryCount` is in pg-boss 12's minimal job columns (`JOB_COLUMNS_MIN`), so no `includeMetadata` is needed. It is 0 on the first claim, and every later claim adds one, expiries included.
- `retryLimit` comes from `resolveJobOptions(job)`, which is also what `start()` writes to the queue.
- **Only `policy.evaluate` reads it** (`canRetry` at `job.ts:410`), and no job calls another job's handler with its context, so the field does not leak from one job into another. No other job's behaviour changes.
- I-Q-4 checks `{ retryCount: 0, retryLimit: 3 }`, and dropping the field fails it (Q4).
- One nit about where `retryLimit` comes from (nit 4).

### The coordinator's rebase commit

`c6bfeee` changes three tests. Each still tests what it claims:
- **I-BG-1** steps down through 0012 and 0011 to 0010, and then checks that 0010's own down refuses while a `break_glass` verdict exists.
- **I-GRD-1** steps down 0012 before it tests 0011's down. A `flaky` row still makes 0011's down fail, with 0012 already rolled back, and the `finally` puts 0012 back. The second round trip goes down and up through both migrations.
- **pilot-ops** "one migration behind": 0012 is the one rolled back.

`db.test.ts`, I-MODE-1 and I-ENF-1 were updated by the developer in the same way. All of them pass.

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK |
| `pnpm lint` | OK (339 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0. Every threshold passes, `matchBaseline: 1`. |
| `pnpm test` (`TEST_DATABASE_URL=…/graft_test_r3b`) | OK: 98 files, **1103** tests passed |
| `db:migrate`, `db:status`, `db:rollback`, `db:status`, `db:migrate` (scratch DB `graft_r3b_dod`) | 0001..0012 applied. Only `0012_audit_label_event` rolled back, then re-applied. |
| `pnpm db:up` | Not run. I reused the shared Postgres 17.11 on 127.0.0.1:55432 and started or stopped no container. |
| `git diff origin/main..HEAD -- src/github src/policy` | Empty (the mutation guard and `enforce.ts` are untouched) |
| `sender` in `break-glass.ts`; `@ts-ignore` / `@ts-expect-error` | Clean |
| Merge with PR #28 (`git merge-tree` of this branch and `origin/claude/phase-1-step-4-review-fixes`) | No conflict. On the merged tree (exported to a scratch folder, DB `graft_test_r3b_merged`): `tsc --noEmit` OK, and `neutral`, `guard`, `break-glass`, `db` and `pilot-ops` give 5 files and 102 tests passed. |

I dropped the three scratch databases afterwards and removed the exported tree. I did not run the manual smoke test or the live e2e runner, because both need a real or tunnelled App (HUMAN-TODO).

### Reverting the fix

I checked out `break-glass.ts`, `job.ts`, `handlers.ts` and `audit/store.ts` from `origin/main`, keeping 0012, the schema and the worker. I ran I-BG-16 to I-BG-20, then restored the files from `HEAD` (`git status` clean). All six failed:
- I-BG-16 and I-BG-17 saw `success`;
- I-BG-18, I-BG-19 and I-BG-20 saw `unchanged` where `published` was expected, because the old bypass was still being replayed;
- I-BG-18b failed on the missing handler flag.

### Mutation checks

I applied each mutation alone with a script that refuses unless the pattern matches exactly once. I ran the named files, then ran `git checkout -- <file>`. `git status` was clean after each one.

| # | Mutation | Result |
| --- | --- | --- |
| F1a | `newest = ev.labeled` (an older `labeled` event is used when an unlabel is newest) | Killed: I-BG-16 |
| F1b | The delivery actor comparison removed | Killed: I-BG-4, I-BG-17, I-BG-21 |
| F1c | A missing `breakGlassActorId` counts as a match | **Survives** (nit 1) |
| F1d | Never retry (`if (false) throw`) | Killed: I-BG-21 |
| F1e | `canRetry` ignores the count (unbounded retry) | Killed: I-BG-21 |
| F1f | The handler drops `sender.id` | Killed: I-BG-4, N-10, N-11 |
| F1g | The cap no longer ends an active row in the actor branch | Survives. Equivalent: `bound` already requires `ev.complete`, so `end` ran at `:323`. |
| F2a | The binding check disabled | Killed: I-BG-18, I-BG-25 |
| F2b | The unlabel flag ignored | Killed: I-BG-18b |
| F2c | `removed` scoped to its own head again | Killed: I-BG-13 |
| F2d | `label_event_id` not stored | Killed: I-BG-11, I-BG-24 |
| F2e | The new `applied` row not stamped 1 ms later | Killed: I-BG-14, I-BG-18, I-BG-21, I-BG-25 |
| F2f | `!ev.unlabeledLater` removed from `bound` | **Survives** (nit 2) |
| F2g | `insertAuditRow` refuses a second `applied` per head instead of per change | **Survives** (nit 2) |
| F3 | A push no longer ends the bypass (`:258` removed) | Killed: I-BG-6, I-BG-19, I-BG-20, N-10, N-11 |
| F4a | No re-send on the early stale exit | Killed: I-BG-23 |
| F4b | No re-send when nothing was committed (lock-time stale, mode rollback) | **Survives** (nit 3) |
| F5 (X5) | The lost-race branch writes no row | Killed: I-BG-22 |
| N7a (X4) | Tie rule `>=` → `>` | Killed: I-BG-24 |
| N7b | The index without `NULLS NOT DISTINCT` | Killed: I-BG-24 |
| Q4 | The worker passes no `attempt` | Killed: I-Q-4 |

### Regressions

- **Report mode is still inert.** N-1, N-2, N-3, N-6, N-10 and N-11 pass in both profiles. `publishedCheck`, the guard and the gate have no diff. N-10 and N-11 now also expect the `removed` row that the push writes (finding 3), in `report` and in `enforce` respectively.
- **Steps 1, 2 and 4 are still green** in the full run: I-MODE, I-ENF (I-ENF-15 and the catch-up tests I-POL-25 and I-POL-26 included), and I-GRD.
- **PR #28.** It reworks the neutral suite so that the guard scenario merges its own PR 3, and the break-glass scenario runs on the still-open PR 2 against the team policy. It adds a precondition: every `break_glass` verdict and every verdict of the next head has `policy_status: ok`, `policy_commit_sha: NEXT_SHA` and a team constraint.
  - This PR's neutral changes (the sender on the label deliveries, and the extra `removed` row) do not touch those lines, and the merge is textually clean.
  - On the merged tree, N-10 and N-11 pass with #28's precondition, so the guarantee survives in both merge orders.
  - Whichever PR merges second only needs a rebase.

## New findings

### 1. nit: "a delivery without a sender id never applies" has no test

F1c survives: if a missing `breakGlassActorId` counted as a match (`break-glass.ts:362-363`), no test would fail. The rule matters for jobs queued before this deploy, and for any payload without `sender`. The code is right. Only the test is missing.

**Fix:** in I-BG-17, run the label job with `breakGlassHeadSha` and no `breakGlassActorId`, with the events naming maya. Assert `ignored actor_unknown`, no role read, and no retry when `attempt` allows one.

### 2. nit: two defence-in-depth guards have no test of their own

- **F2f.** `!ev.unlabeledLater` in `bound` (`break-glass.ts:318`) is redundant on the main path, because a newer unlabel also fails the newest-event check (`:359`). Only the D4-mismatch replay (`:330`) depends on it: a re-label that lags, then a stale label delivery for the same head.
- **F2g.** `insertAuditRow` refuses an `applied` row while any row of the change is active (`store.ts`). The job always writes `removed` first, so nothing reaches that guard today.

Both fail closed. I would keep them.

**Fix (optional):** a store-level case for F2g (two `applied` rows for different heads in one transaction → the second is refused), and an I-BG case for F2f: events `labeled maya`, `unlabeled maya`, with tom's re-label lagging, and a label run whose D4 head is not the live head → not replayed.

### 3. nit: the late re-send (lock-time stale, mode rollback) has no test

F4b survives: removing `if (!auditCommitted) await resendLabelRun(headSha);` (`job.ts:666`) fails no test. I-BG-23 covers only the early exit at `:282`. Review 1 named the mode rollback (`ModeChangedDuringEvaluation`) as one of the two silent-drop paths. I read the branch and it is correct: `auditCommitted` is false only when `underFreshLock` returned `null` or the transaction rolled back, and `resendLabelRun` checks that the stored head is still the run's head.

**Fix:** an I-BG case that uses `api.afterNext` on the check-run write to set the repository's `policy_mode` to `report`, so the gate refuses with `mode_report`. Assert `stale`, no audit row, and one queued `policy:breakglass:<change>:<head>:<deliveryId>` job.

### 4. nit: `canRetry` reads the queue definition's `retryLimit`, not the job's

`worker.ts:13` takes `retryLimit` from `resolveJobOptions(job)`. pg-boss copies `retry_limit` onto each job when it is inserted. If a deploy changes `policy.evaluate`'s `retryLimit`, jobs queued before the change disagree with the worker:
- **Higher limit:** on the job's real last attempt, `canRetry` is true. The run throws `LabelEventsBehind`, pg-boss marks the job `failed`, and the label is dropped without a row. That is the silent drop of finding 4, though it fails closed.
- **Lower limit:** the run fails closed early.

The limit has not changed, so nothing is wrong today.

**Fix (optional):** pass `includeMetadata: true` to `work` and use `j.retryLimit`, or note in `context.ts` that the limit must not be lowered or raised while label jobs are queued.

### 5. nit: the "Migration number" paragraph of the review 1 record is out of date

`docs/decisions.md:482` still says that step 4 (PR #26) is "not merged yet" and that whichever merges second must check the order. #26 is on `main`, and `c6bfeee` did that check. Step 4's own record (`:564`) still says that the step-down tests "name `0011_guard` as the top migration".

**Fix:** one sentence in each place: "Merged after #26; 0012 sits on 0011, and the step-down tests (I-BG-1, I-GRD-1, I-DB-*, I-MODE-1, I-ENF-1, pilot-ops) step through both."

## Recommendation

**Approve and merge PR #27.** The five nits can go in a follow-up commit. Nits 1 and 3 are the most useful, because each pins a refuse-only rule that the record promises. Merge #27 and #28 in either order and rebase the second: there is no textual conflict, and the merged tree passes the neutral suite with #28's team-policy precondition.

Before any repository enforces (step 7 at the latest), these are still open:
- the manual smoke test;
- the two new HUMAN-TODO items: how late the events API lists a label change compared with the retry budget, and whether `Link: rel="last"` is served (nit 8 of review 1);
- step 5 should read `mergedUnderBreakGlass` as it is now, change-scoped.
