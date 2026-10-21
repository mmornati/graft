# Step 2 review 2: Approvals Graft can enforce

**Verdict: APPROVED**

Reviewer: senior engineer (Opus). Scope: the review 1 fix commits `dafad40..80ae658` (9 commits, `c5d2fe2..80ae658`): 21 files, +403/−57. I judged them against review 1 (`docs/phase-1/reviews/step-2-review-1.md`), the "Phase 1 step 2: approvals" → "Review 1 fixes" record in `docs/decisions.md`, and `docs/phase-1/step-2-approvals.md` (binding).

## Summary

The major finding is resolved. The team fan-out is now a trailing-edge debounce: every `membership` and `team` event is followed by a fan-out that starts after it. I-ENF-11b fails on the old code at exactly the defect review 1 described.

Findings 2, 3, 4, 5, 6 and nit 9 are fixed. Each test catches a mutation that breaks the rule it guards.

The transfer-race fix (finding 6) differs from my predecessor's suggestion. I think it is better: it cannot publish non-neutral for the previous owner, and it never leaves the PR without a check.

I agree with deferring finding 7 to step 7 and with accepting nit 8. Both are documented where an operator will see them.

Report mode is still inert. The step 1 and review 1 safety mutations (M7, M9) are still killed.

No blocker, major or minor remains. Two nits are listed below. Neither one blocks the merge.

## Review 1 findings

| # | Finding (review 1) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | major: the team fan-out's debounce drops changes that arrive after it ran in the same window | **Resolved** | See "Finding 1 in detail". Reverting `team-fanout.ts` to `dafad40` fails I-ENF-11b at `policy-enforce.test.ts:641` (`expected [] to have a length of 1`): the second event's fan-out is swallowed. Putting back a 60 s leading edge alone fails I-ENF-11 and I-ENF-11b. |
| 2 | minor: a status-less check-run POST passes the guard as neutral | **Resolved** | `checkRunBodyKind(body, method)` (`src/github/mutation-guard.ts:204,215`): a POST is neutral only with `completed` + `neutral`. Applying the PATCH rule to POSTs fails U-MG-13. Every production create (intent `job.ts:304-311`, provenance `job.ts:58-65`, policy in report mode) sends `completed` + `neutral`, so nothing that worked before is refused. A POST with *no body at all* treated as neutral survives. That is harmless: GitHub refuses a create without `name` and `head_sha` (422). |
| 3 | minor: team slugs and logins in error routes | **Resolved** | `NAME_AFTER` (`src/queue/errors.ts:46,64`) templates the segment after `teams`, `memberships`, `members`, `collaborators` and `users`. Removing it fails U-GHE-5, which also checks the `toJobError` path with `inspect`. It over-redacts a repository named `teams` (`/repos/o/teams/pulls/:n` → `…/teams/:name/…`), which is harmless. |
| 4 | minor: outsiders can push real approvers past the D17 bound | **Resolved**, with a residual **Accepted** | `checkOrder` (`src/modules/policy/approvals.ts:52,88,107`) orders the checks by `author_association`, then by login. The association only orders the checks and never replaces one. Removing the sort fails I-ENF-12b. On the residual, see "Finding 4 residual". |
| 5 | minor: two fail-closed rules have no test | **Resolved** | X5 (a `pending` membership counts) fails I-ENF-6b. X3 in both forms (a requester answered 403 does not block; a requester past the bound does not block) fails I-ENF-7b. |
| 6 | minor: a transfer race reads the previous owner's modes | **Resolved** (a different fix from the one suggested, see "Finding 6 in detail") | `ensureRepository` returns `other_installation` (`src/modules/installations/store.ts:243,271`). The job evaluates under a `report` ceiling (`src/modules/policy/job.ts:169-183`). Removing the ceiling override, or making `ensureRepository` never report `other_installation`, fails I-ENF-15. |
| 7 | minor: the gate trusts the process's own ceiling (rolling restart) | **Deferred**, and I agree | The `docs/features/modes.md` paragraph and the HUMAN-TODO item both say to stop every worker before lowering the ceiling. The real fix changes step 1's ceiling model (`service_state`, `publishModeCeiling`), which is out of this step's scope. Nothing enforces before step 7. Step 7's runbook must either keep the full-stop rule or make the gate read the stored ceiling. |
| 8 | nit: a non-neutral PATCH can rename another run | **Accepted**, and I agree | A comment at `mutation-guard.ts:329-332` records why. Only the policy job holds a `policy` client, and it PATCHes only a stored or listed `graft/policy` run id. |
| 9 | nit: the recycled-login check passes with no `user` | **Resolved** | `src/github/collaborator.ts:66`. Restoring `res.data.user &&` fails U-COL-3 (the new `noUser` case). |

### Finding 1 in detail

`scheduleTeamFanout` (`src/modules/policy/team-fanout.ts:70-80`) keeps the key `policy:team:<inst>:<w>`, with `w = floor(now / 300 s)`. It sets `startAfterSeconds = ceil((w + 1)·300 − now) + 60`, which is between 61 and 360 seconds. The payload carries `w`, and each per-PR re-evaluation is keyed `policy:team:<repo>:<pr>:<data.window>` (`:120`).

**Every event is followed by a fan-out that starts after it.**
- An event at time `t` in window `w` either creates the window's job or finds it already queued. That job starts at `(w + 1)·300 + 60 > t`.
- `singletonJobId` deduplicates against a job in any state. A job that has already **run** has a start time of at least `(w + 1)·300 + 60`, so any event processed after it falls into window `w + 1` or later, with its own new key. A completed job therefore never swallows a later event.

**Window boundaries.**
- The last millisecond of a window (`now = (w + 1)·300 − 0.001`) gives `ceil(0.001) + 60 = 61` seconds. The job starts at `(w + 1)·300 + 60.999`.
- An event exactly on the boundary belongs to `w + 1` and waits 360 seconds.
- An event processed while window `w`'s fan-out runs is at least 60 seconds into `w + 1`. It schedules `w + 1`'s fan-out, which runs after it.

**The per-PR keys.**
- Only fan-out `w` (and its own retries) sends keys that end in `:w`, so fan-outs of different windows cannot collide.
- A retry of fan-out `w` re-sends the same keys. Any evaluation that is deduplicated was enqueued after window `w` closed, so it reads facts from after every event of that window.
- `fanoutTeamChange` now counts only the jobs actually enqueued (`id !== null`).

**One assumption.** The clocks of the processes that run the webhook handlers must agree within the 60 s margin. With two handlers whose clocks differ by more than 60 s, an event could be put in a window whose fan-out has already run. The relative `startAfter` makes app-to-database skew irrelevant. Only skew between app processes matters, and NTP covers it. This is not a finding.

**The old behaviour is really gone.**
- With the whole `dafad40` version of `team-fanout.ts` restored, I-ENF-11 fails on its payload check, and I-ENF-11b fails where the second fan-out is missing.
- Because `FIXED_NOW` is on a window boundary, the removal at `ranAt + 1 s` falls in the same window as the first event under the old key. So the test exercises the exact scenario review 1 described.

### Finding 6 in detail

With `other_installation`, the job reads the row's modes through `modesOf(row, "report")`, and the step 1 ceiling clamp makes every effective mode `report` (that clamp is still covered by the step 1 mutation M1). So:

- **It can never publish non-neutral for the previous owner.**
  - `publishedCheck("report", …)` is `completed` + `neutral`, so the job sends a Phase 0 body that never asks the gate.
  - If a regression made it try a non-neutral write anyway, the gate would refuse it with `repository_unknown`: it looks the row up by the job's installation, and the row still belongs to the old one.
  - That makes two independent barriers. The test checks the first: with the override removed, I-ENF-15 sees a refusal.
- **It always publishes neutral when it should.** The job runs the normal report path: verdict, check, comment, and the would-be line computed with the new installation's token and permissions. Skipping, as review 1 suggested, would leave the PR with no check for this event whenever the old modes were already `report`. In that case D13 writes no `mode_changes` row and nothing republishes. The developer's argument is right.
- **Reverse cases.**
  - A job for the *old* installation after the move also gets `other_installation`. It fails earlier, on `pulls.get` with a token that has lost access, as before.
  - A move that commits between `ensureRepository` and the mode read still ends in `report`.
- The other callers of `ensureRepository` (intent, provenance, pilot) compare with `"removed"` only and publish Phase 0 writes only, so `other_installation` behaves like `active` for them, as before.

### Finding 4 residual

After the fix, 21 or more outsider change requests still block, because a requester past the bound blocks (deviation 3). I agree with accepting this for now:
- It fails closed.
- An attacker needs 21 accounts and gains only a stuck check, not a false approval.
- It costs at most 40 role GETs per evaluation.
- It is in HUMAN-TODO with a step 7 decision point.

One way to close it at step 7: past the bound, let only requesters whose association is `OWNER`, `MEMBER` or `COLLABORATOR` block, since GitHub normally reports an account with write access as one of those three. That uses the association as evidence of *no* access, which is a policy choice for the step 7 security review, not for this fix round.

## What I ran

| Command | Result |
| --- | --- |
| `pnpm lint` | OK (317 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0. Every threshold passes, `matchBaseline: 1`. |
| `pnpm test` (`TEST_DATABASE_URL=…/graft_test_review2b`), 4 full runs | 93 files, 1013 tests. Runs 2 and 3 were fully green. Runs 1 and 4 each had one failure: I-E2E-1, with `installationCalls: 3` (nit 2). |
| `pnpm db:up` | Not run. I reused the shared Postgres on 127.0.0.1:55432 and started or stopped no container. |
| DoD greps: non-neutral `conclusion:` literal and `as const` in `src/modules/`, `new Octokit\|Octokit.defaults`, `@ts-ignore\|@ts-expect-error` | All clean |

### Mutation checks

I applied each mutation alone, ran the named files, then ran `git checkout -- src`. `git status` was clean after each one.

| # | Mutation | Result |
| --- | --- | --- |
| F1 | `team-fanout.ts` restored from `dafad40` | Killed: I-ENF-11, I-ENF-11b (`:641`) |
| F1a | Leading edge: `startAfterSeconds = 60` (payload keeps `window`) | Killed: I-ENF-11, I-ENF-11b |
| F1b | Per-PR key from the run time, not `data.window` | **Survives** (nit 1) |
| F2 | The POST rule replaced by the PATCH rule | Killed: U-MG-13 |
| F2b | A POST with a null body treated as neutral | Survives. Harmless: GitHub refuses a create without `name`/`head_sha`. |
| F3 | `NAME_AFTER` templating removed | Killed: U-GHE-5 |
| F4 | Association order removed | Killed: I-ENF-12b |
| X5 | A `pending` membership counts as active | Killed: I-ENF-6b |
| X3a | A requester answered 403 does not block | Killed: I-ENF-7b |
| X3b | A requester past the bound does not block | Killed: I-ENF-7b |
| F6a | `report` ceiling override removed in the job | Killed: I-ENF-15 |
| F6b | `ensureRepository` never returns `other_installation` | Killed: I-ENF-15 |
| N9 | A response with no `user` accepted | Killed: U-COL-3 |
| M9 (review 1) | `publishedCheck` ignores the mode | Killed: N-1, N-2, N-3, N-4, N-6, and 7 I-ENF tests, I-ENF-15 included |
| M7 (review 1) | The guard ignores the body | Killed: U-MG-13..17, N-7 [default], N-7 [max], N-2b [max] |

### Regressions

- **Report mode is still inert.** N-1, N-2, N-3 and N-6 pass in both profiles, and so do N-2b, N-4, N-5 and N-7. The neutral suite now runs the queued fan-out's own payload.
- **The step 1 safety core still holds.** The guard, the host check and the gate are unchanged apart from the POST rule, which only refuses more. M7 and M9 are still killed.
- The new `author_association` field is not part of `policyFactsHash`, so it causes no republication.
- The new `window` field is required in the fan-out schema. No fan-out job from the old payload can be queued anywhere: the deployed build is `main`, which has no team fan-out.

## New findings

### 1. nit: the per-PR key's use of the payload window has no test

F1b survives. If the per-PR key used the run time instead of `data.window` (`team-fanout.ts:120`), every test would still pass, because each test runs a fan-out inside the window after its own. The design is right: with a fan-out that is delayed (backlog or retries), two fan-outs of different windows could run in the same run-time window, and the second one's evaluations would be dropped. The decisions record names this property.

**Fix (optional):** in I-ENF-11, call `fanoutTeamChange({ installationId, window }, ctx)` with a clock two windows later, and assert that the evaluation's `singleton_key` still ends in `:${window}`.

### 2. nit: I-E2E-1 is flaky in a full run

Two of my four full runs failed I-E2E-1 with `installationCalls: 3`. The file runs alone without a failure. The cause:
- `e2e.test.ts:10-19` starts a supervising worker in `beforeAll`, and truncates (deletes the `pgboss.job` rows) only in `beforeEach`.
- The previous integration file can leave jobs that are already due. After a run I found `policy.evaluate`, `pilot.reviewers.sync`, `intent.feedback.poll` and `installations.refresh_permissions` in the scratch database.
- The worker can fetch those jobs in the gap between `beforeAll` and `beforeEach`. Running them takes installation clients.

The mechanism predates these commits, and I cannot attribute the flake to them. But it will fail CI from time to time.

**Fix:** call `truncateAll(t.db)` in `beforeAll` before `startWorker`, or have each integration file delete its `pgboss.job` rows in `afterAll`.

## Recommendation

Approve and merge PR #17. The two nits can go in a follow-up commit. Before any repository enforces, at the step 7 rollout at the latest, three things are still open:
- the manual smoke test (HUMAN-TODO);
- the rolling-restart rule for lowering the ceiling, or a gate that reads the stored ceiling (finding 7);
- a decision on enforcing on public repositories (finding 4 residual).
