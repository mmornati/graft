# Review 3: live e2e scenario runner

Verdict: APPROVED

Scope: the uncommitted diff on `main` after the fixes to [review 2](review-2.md). Nothing was run against GitHub and no network call was made.

Every finding of review 2 is fixed and tested. The one finding below is minor: tests are missing for three branches of the new timeline check. It does not block committing.

## What I ran

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | pass |
| `pnpm test` | 85 files, 881 tests, all pass, 168 s |
| `pnpm graft policy check` on the three fixtures | exit 0 each |
| `pnpm graft e2e run --only-offline` | exit 0; live report, 12 of 12 scenarios pass |
| `pnpm graft e2e run --only-offline --llm none` | exit 0; 10 pass, s08 skipped |
| `pnpm graft e2e frobnicate` | exit 2 |
| `git check-ignore -q e2e-runs/x` | exit 0 |
| `GRAFT_E2E_` grep outside `src/e2e` and `src/bin/graft.ts` | no output |
| `docs/e2e/mutations.py`, the full list, run in a scratch copy with its own test database | **all 32 caught**: M1 to M13, N1 to N18, N20. The developer's list has no N19. |

The four mutations that survived review 2 are now in the developer's list, and each is caught by a dedicated test:

| Review 2 mutation | Developer's id | Caught by |
| --- | --- | --- |
| N8: git isolation | N10, N20 | U-LIVE-SEC-3 now asserts literal values |
| N11: renamed repository | N14 | U-LIVE-CLI-3 `sandbox_renamed` |
| N12: `provenance_published` sync | N13 | I-REV-REQ-5 |
| N14: setup's created-name check | N15 | the "created repository that is not the sandbox" test |
| N15: child environment | N16, N17 | U-LIVE-SEC-4 |

`src/bin/graft.ts:196` now uses `childEnv`, so the tested function is the one that runs.

## The timeline confirmation (`src/modules/pilot/reviewers.ts:104-134`, `:180-193`)

**No spoofing is possible.**
- **Requester and reviewer are not confused.** The check matches `event === "review_requested"` and `requested_reviewer.id`. It never looks at `actor`, the user who made the request. A mutation that matches `actor.id` instead is caught by I-REV-REQ-1 and I-REV-REQ-3.
- **A confirmed request still needs standing.** The claimed user then goes through the permission check, with the login-to-id consistency check.
- **Data source.** Everything comes from API data. The webhook only names whom to look for, so the step-2 rule now holds, and the README matches the code.

**Team requests.**
- A team request carries `requested_team` and no `requested_reviewer`, so it can never confirm a user.
- The webhook for a team request has no `requested_reviewer` either, so no claim is enqueued.
- Teams stay out of scope, as before (`members: read`).

**Removed requests.**
- A `review_request_removed` event carries `requested_reviewer` too, but its event name does not match, so it is ignored.
- A request that was made and later withdrawn still confirms. That matches the table's union-over-time rule ("nothing is deleted when a request is withdrawn"): the request did happen.

**Pagination.**
- `paginate.iterator` reads up to 3 pages of 100, and the fake API pages timelines.
- A request beyond 300 timeline events fails closed (not confirmed). If the user is still requested, `listRequestedReviewers` records them anyway, and a requested user's own review still counts.
- This is acceptable.
- A 404 on the timeline fails closed. Other errors are retried through `toJobError`.

## The `onChangeSignal` rename

- `src/modules/pilot/index.ts` registers `onChangeSignal`, and no reference to the old name remains.
- The `feedback_recorded` branch is unchanged: it still enqueues one sync per change per hour. I-REV-3 still covers that path, and the pilot-ops leak test calls the listener with `feedback_recorded`.
- `provenance_published` enqueues one `rev-sync-open` job per change (I-REV-REQ-5), and `intent_published` enqueues nothing.

## Findings

### 1. minor: three branches of the timeline check have no test

`src/modules/pilot/reviewers.ts:121-127`, `test/integration/pilot-module.test.ts:296-319`.

The code is correct, but I applied three extra mutations to it in a scratch copy and none of them fails a test:

| Mutation | Result |
| --- | --- |
| X1: read only 1 timeline page | survives |
| X3: drop the `event === "review_requested"` condition, so a `review_request_removed` event alone would confirm | survives |
| X4: treat any event with a `requested_team` as a confirmation | survives |
| X2: match `actor.id` instead of `requested_reviewer.id` | caught |

Fix: extend I-REV-REQ-3 with three cases:
- a timeline holding only a `review_request_removed` event for the user, which must not confirm;
- a `review_requested` event with `requested_team` and an `actor` equal to the claimed user, which must not confirm;
- the user's `review_requested` event on page 2 (set the fake's page size to 1, or fill page 1), which must confirm.

## Review 2 findings: status

| # | Status |
| --- | --- |
| 1 `ensureRepository` in reviewer sync | fixed; a removed repository is skipped, an unknown repository gets its row first (I-REV-REQ-4) |
| 2 `provenance_published` sync untested; listener name | fixed: I-REV-REQ-5, renamed to `onChangeSignal` |
| 3 Untested safety lines; `GIT_ISOLATION` test that could not fail | fixed: `sandbox_renamed` check with the right message, setup created-name check, `childEnv` (U-LIVE-SEC-4), literal values asserted |
| 4 Payload written as "requested" | fixed: confirmed through `review_requested` timeline events plus the permission check (I-REV-REQ-3); one test gap in finding 1 |
| 5 `GIT_*` variables inherited | fixed: a `git` child starts without any `GIT_*` variable |
| 6 Token minting before the installation is known | fixed: minting needs a known installation id |
