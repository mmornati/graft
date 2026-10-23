# Step 5 review 2: Revert PRs and optional auto-merge

**Verdict: APPROVED** (post-merge, with two follow-up fixes)

Reviewer: senior engineer (Opus). Scope: commit `9291088` ("Phase 1 step 5: review 1 fixes"), merged into `main` through PR mmornati/graft#37 (merge `713d244`): 21 files, +963/−86. I reviewed it on `main` at `d0734f6`, which differs from `9291088` only in the step 6 spec (docs). I judged the commit against review 1 (`docs/phase-1/reviews/step-5-review-1.md`), the "Phase 1 step 5: revert PRs" → "Review 1 fixes" section of `docs/decisions.md`, and `docs/phase-1/step-5-revert-prs.md` (binding).

**This review ran after the merge.** PR #37 merged without a review 2, and nothing here can block it. Where this review asks for a change, it is a **follow-up fix** on `main`. The two follow-ups below are not safety holes in report mode. Both should land before a pilot repository runs the guard in enforce mode, together with the T1 (b) HUMAN-TODO check that review 1 already required.

## Summary

Both required findings are resolved:
- **The `#` bypass is closed.** I re-ran review 1's probe verbatim with a `guard` client and an allow-all gate. All three calls (`POST …/git/refs#` with `refs/heads/main2`, `POST …/pulls#` with `head: main`, and `POST …/issues/3/labels#` with `bug`) are now refused with `unknown_route`, and nothing reaches the fake API. One `normalisedPath` serves `classifyWrite`, `checkRunWrite` and `guardBodyAllowed`. A `#` anywhere makes the path null, and `guardBodyAllowed` fails closed. Each of these three ways of reopening the hole fails U-MG-2 or U-MG-20: the fragment stripped as before, the review 1 code restored, or the final `return true` restored.
- **The D9 tree check has a test, and it checks more than before.** `treeMatchesPlan` keeps the plan-path check and adds a diff from the tip to the written tree, which must give exactly the plan's paths with the expected entries. I-REV-5b uses two fake quirks: a directory that `sha: null` does not delete, and an extra path that the request did not name. Each one ends `error` / `tree_mismatch` with one `POST …/git/trees`, no commit, no ref and no PR. Mutation X1 (the check removed) fails I-REV-5b, and so does X1b (plan paths only, no diff).

The two recommended findings and the four minors are resolved. Each fix has a test, and each test kills the mutation that breaks its main rule. Two secondary rules have no test (findings B and C). Of the four nits, three are fixed with tests. The fourth (nit 10) is fixed with no test, because its code cannot be reached today, which I accept. I re-applied 33 mutations, each alone. 27 are killed. Of the 6 survivors, 4 are equivalent or benign, and 2 are gaps (findings B and C).

Report mode is still inert. The only new GitHub call in report mode is finding 6's lookup by head, a GET with the default client. The default client has no `guard` feature, so it cannot write a Phase 1 route.

I found two minors and two nits:
- **A (minor, follow-up):** a run that fails after its writes began is settled `error` without the lookup by head that finding 6 added for report mode. A Graft revert PR can then be left open, with the event never pointing at it. The docs say such a run "is finished whatever its age", and it is not.
- **B (minor, follow-up):** the `stale` age runs from the confirmation time, which is the point of the design. No test pins it, so measuring the age from detection survives. With a long confirmation window, that regression would make every revert `stale`.
- **C and D (nits):** the conditional `revert_closed` update has no test, and the guard's body rules ignore a query string.

## Review 1 findings

| # | Finding (review 1) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | required: a `#` in the route string skips the §12 body rules | **Resolved** | See "Finding 1 in detail". `normalisedPath` is at `src/github/mutation-guard.ts:168`, `guardBodyAllowed` at `:285`, and its fail-closed end (`GUARD_BODILESS`) at `:312`. Review 1's probe is refused (`unknown_route`). F1a, F1b and F1c are killed by U-MG-2 and U-MG-20. |
| 2 | required: the D9 tree check has no test | **Resolved** | See "Finding 2 in detail". `treeMatchesPlan` is at `src/modules/guard/revert.ts:494`, and its call at `:572`. The fake's `quirks` and `writeTree` are in `test/helpers/git-trees.ts`. I-REV-5b is at `test/integration/guard-revert.test.ts:582`. X1 and X1b are killed. |
| 3 | recommended: D15's response check and "already enabled" have no test | **Resolved** | The fake has a `graphqlAnswer` switch (`fake-github-api.ts`). I-REV-13b (`guard-revert.test.ts:1071`) covers another number, another repository (`error auto_merge_mismatch`, one GraphQL request, the "could not finish" comment) and "already enabled" (`auto_merge_state = enabled`). X4 and X5 are killed by I-REV-13b. |
| 4 | recommended: a failed `guard.revert` cannot run again for 7 days, and a stuck claim holds a cap slot | **Resolved** (with new finding A) | `handle` catches an error on the last attempt or a permanent one, and calls `settleFailedRun` (`revert.ts:1159`, `:1213`). Job rows are kept one hour (`:1207`). `queue.ts` runs `updateQueue` and tightens existing job rows, so the shorter retention also applies to a deployed queue. The `stale` skip is at `:898`, configured by `GRAFT_GUARD_REVERT_MAX_AGE_HOURS` (1–168, default 24). The doctor check `guard_revert_claims` is at `doctor.ts:368`. Mutations: no settle (F4a), 7-day rows (F4b), no stale skip (F4c) and stale even after writes began (F4d) fail I-REV-10b, and F4b also fails U-Q-6. X17 fails I-REV-12b, and a silent doctor check (F4f) fails I-REV-22. Measuring the age from detection (F4e) survives (finding B). |
| 5 | minor: every refusal is recorded as `mode_changed` | **Resolved** | `refusalClass` (`revert.ts:134`): `mode_report` and `mode_off` give `mode_changed`, and any other refusal gives `refused_<reason>`, cut to 40 characters. I-REV-17b's last case (the repository removed mid-job) gives `refused_repository_unknown`. F5 is killed. |
| 6 | minor: a run resumed in report mode after a write began does not look for the PR | **Resolved** | `revert.ts:990`: the run looks the PR up by head (a GET with the default client), adopts it, and records `error mode_changed` either way. I-REV-17b covers a PR opened but not stored, a commit with no PR, and an opened revert with its label left. F6 (records `planned`) and F6b (no adoption) are killed. The recorded residual is acceptable: a resumed run whose plan becomes `needs_human` or `skipped` because the tip moved. It needs a crash plus a moved tip, and it is written down. |
| 7 | minor: the GraphQL rule gates the repository in `clientMutationId`, not the PR's | **Resolved** (review 1's option 1) | An `after` hook on `guard` clients only (`mutation-guard.ts:438`) records the node id, number, owner and repository from the client's own `…/pulls` responses, at most 200. The GraphQL rule requires `pullRequestId` to be one of them, with the same repository and number, before the gate is asked (`:484`). U-MG-19 covers a PR that was never read, the wrong number, the wrong repository and a second client. Removing the binding (F7a), ignoring the number (F7b) and ignoring the repository (F7c) are all killed by U-MG-19. My probes: a `pulls.list` by head that did not include #501 still leaves the write refused, and `POST /graphql#` and `POST /graphql?x=1` are `unknown_route`. The recorded limit (a guard client that lists every PR could target any of them in that repository) is acceptable: the job lists by `head` only, and the gate now runs for the PR's own repository. |
| 8 | minor: five rules have no test | **Resolved** | X22 fails I-REV-14, X25 fails I-REV-10, X28 fails I-REV-18 ("settled", no API read), and X20 fails U-RVP-8. `revert-closed.ts:82` is now conditional. Removing only that condition (X28b) survives (nit C). The reopened-PR decision ("stays `revert_closed`, `pull_request.reopened` not handled") is recorded, and I agree. |
| 9 | nit: two guard routes are wider than they need to be | **Fixed** | `base` must match `PLAIN_BRANCH_RE` (`mutation-guard.ts:303`). The `DELETE` route and the bodiless list both take only `graft-revert/[0-9a-f-]{36}` (`:142`, `:274`). N9a fails U-MG-20 and N9b fails U-MG-3. My probes: `DELETE` with an upper-case uuid, `DELETE …/heads/main` and `PATCH …/heads/graft-revert/<uuid>` are all `unknown_route`. |
| 10 | nit: the baseline falls back to the failing commit | **Fixed**, no test (accepted) | `revert.ts:359`: with no `last_green_sha`, the baseline is `{ checks: null, autoMerge: "not_configured" }`. It cannot be reached while `detect.ts` types the field `string`. |
| 11 | nit: a comment written after a mode change mixes the two modes | **Fixed** | `modeFor` (`revert.ts:157`) renders a `planned` outcome with the report line. N11 fails I-REV-2b. |
| 12 | nit: U-RVT-2's bot case cannot tell a code span from a mention | **Fixed** | U-RVT-2 now uses a `Bot` author `ci-helper` (a valid mention). X11 (bot authors mentioned) fails U-RVT-2. |

### Finding 1 in detail

**Review 1's probe, re-run.** I used a scratch unit test with the fake API, an allow-all gate and a `guard` client. It was deleted afterwards and is not in this PR.

| Probe | Result |
| --- | --- |
| `POST …/git/refs#`, `ref: refs/heads/main2` | refused, `unknown_route` |
| `POST …/pulls#`, `head: main` | refused, `unknown_route` |
| `POST …/issues/{n}/labels#`, `labels: ["bug"]` | refused, `unknown_route` |
| `POST …/git/refs?#`, `POST …/pulls` with `owner: "<owner>#"` (Octokit sends `%23`) | refused, `unknown_route` |
| `POST …/pulls?` and `POST …/pulls/` with `head: main` | refused, `feature_not_allowed`: the path normalises to the route, and its body rule refuses the body |
| `POST …/git/refs?x=1` and `POST …/git/refs//`, `ref: refs/heads/main` | refused, `feature_not_allowed` |
| `POST …/pulls?head=main&base=release` with a valid body | **sent** (nit D) |

**Why the hole cannot come back through one function.** `classifyWrite` and `guardBodyAllowed` now share the normalisation, so they cannot see two different paths. `guardBodyAllowed` is also fail-closed on its own: a route it does not know is `false`, and the three bodiless routes are listed by name. Either change alone closes review 1's bypass. Mutation F1d gives `guardBodyAllowed` its old raw-path parsing but keeps the fail-closed end, and it **survives**. That is benign. `classifyWrite` refuses the `#` first, and with a `#` the raw path matches no body rule and no bodiless route, so the function still returns `false`.

**Mutations**, each applied alone:

| # | Mutation | Result |
| --- | --- | --- |
| F1a | One normalisation that strips the fragment instead of refusing it | Killed: U-MG-2, U-MG-20 |
| F1b | Review 1's code restored: `classifyWrite` strips `#`, the body rule reads the raw path and falls through to `true` | Killed: U-MG-2, U-MG-20 |
| F1c | `guardBodyAllowed` ends in `return true` | Killed: U-MG-20 |
| F1d | `guardBodyAllowed` reads the raw path, fail-closed end kept | Survives, benign (see above) |

### Finding 2 in detail

**What the check proves now.** After `POST …/git/trees`, the written tree must meet two conditions:
1. every plan path holds its `before` entry;
2. `diffTrees(tip.tree, written)` gives exactly the plan's paths, each with the tip's entry (equal to `after`, by D7) before and the plan's `before` after.

The diff is capped at `w.changes.length` paths and runs on the job's API reader. A tree it cannot read within that reader's ceiling does not match. So the check fails closed in both directions: a path GitHub did not change, and a path GitHub changed that the plan did not name.

**The test exercises the case the T1 (b) deviation relies on.** In I-REV-5b the culprit adds a whole directory, `new/` with two files, so the plan has one `type: tree` entry with `sha: null`. With `keepNullTrees` the directory survives the write, and the run ends `tree_mismatch` before any commit. The `extra` quirk writes `keep/k.ts` with another blob, which only the diff can see. The test then resets, so the two quirks never combine. That is why X1b (no diff) is killed: the `extra` case passes the plan-path loop.

**Mutations**, each applied alone:

| # | Mutation | Result |
| --- | --- | --- |
| X1 | D9 check removed (`if (false && …)` at `revert.ts:572`) | Killed: I-REV-5b |
| X1b | Plan paths only (`return true` before the diff) | Killed: I-REV-5b |
| X1c | Diff only (the plan-path loop removed) | Survives, equivalent |
| X1d | Diff with the count and path set only (no entry comparison) | Survives, equivalent |

The two halves overlap, so X1c and X1d are equivalent:
- A plan path that is not restored either equals the tip, so it is missing from the diff and the count fails, or holds a third entry, so the diff's entry comparison fails.
- Given the loop and D7, the entry comparison is implied by the path set.

No action is needed. The overlap costs at most one extra read per plan path, and it keeps the check correct if D7 ever changes.

**Still open from review 1 (not graded here):** the HUMAN-TODO check of `sha: null` on a `type: tree` entry on real GitHub. The fix makes a "no" answer fail safely (`error`, no commit). It does not make it work: if GitHub keeps the directory, every revert of an added directory in the pilot ends `error`, and the T1 (b) expansion becomes the follow-up.

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK ("Already up to date") |
| `pnpm db:up` | Not run. I reused the shared `scionhub-postgres-1` on `localhost:55432` and started or stopped no container. |
| `pnpm lint` | OK (351 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm test` (`TEST_DATABASE_URL=…/graft_s5r2`, a fresh database) | OK: 101 files, **1184** tests passed (the developer's count) |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0; every threshold passes, `matchBaseline: 1` |
| `pnpm graft policy schema --check` | OK ("schema is up to date") |
| `pnpm graft e2e run --only-offline` | exit 0; 12 of 12 scenarios pass (s01–s10, b1, b2); INV-4 counts 19 doctor checks |
| `db:migrate && db:status` (scratch DB `graft_s5r2_dod`) | `0001`..`0013` applied |
| `db:rollback && db:status && db:migrate` | Only `0013_guard_revert` rolled back (`pending`), then re-applied; database dropped |
| The six §18 greps, verbatim | All five "must be empty" greps are clean. The test ID grep counts **76** lines, as the developer reports. The only `feature: "guard"` is `revert.ts:1069`. |
| CI on PR #37 (`gh pr checks 37`) | `check` pass (5m49s), `build` pass; `deploy` and the Graft checks skipped |

I did not run the manual smoke test (a dev server, a worker and `pnpm webhook:send`; it is in HUMAN-TODO).

### Mutation checks

I applied each mutation alone with a script, ran the named test files against a scratch database (`graft_s5r2m`), then ran `git checkout --` on the file. `git status` was clean after the run. F1a–F1d and X1–X1d are listed above.

| # | Mutation | Result |
| --- | --- | --- |
| X4 | D15 response check removed | Killed: I-REV-13b |
| X5 | "Already enabled" counted as `unavailable` | Killed: I-REV-13b |
| X11 | Bot author mentioned | Killed: U-RVT-2 |
| X17 | The cap does not count claimed runs without an outcome | Killed: I-REV-12b |
| X20 | `truncated` ignored in the plan's tree reads | Killed: U-RVP-8 |
| X22 | Card of any head | Killed: I-REV-14 |
| X24 | An opened revert resumed in report mode not marked `mode_changed` (the branch that predates the fixes) | Survives, equivalent, as the developer recorded: finding 6's check settles the same `error mode_changed` after one GET |
| X25 | `storePr` ignores an adopted PR's state | Killed: I-REV-10 |
| X28 | `guard.revert_closed` without its `revert_opened` gate | Killed: I-REV-18 |
| X28b | The update in `revert-closed.ts` not conditional (gate kept) | **Survives** (nit C) |
| F4a | No settle on the last attempt | Killed: I-REV-10b |
| F4b | `guard.revert` rows kept 7 days | Killed: I-REV-10b, U-Q-6 |
| F4c | No `stale` skip | Killed: I-REV-10b |
| F4d | `stale` even when the writes began | Killed: I-REV-10b |
| F4e | `stale` measured from detection, not confirmation | **Survives** (finding B) |
| F4f | Doctor `guard_revert_claims` never warns | Killed: I-REV-22 |
| F5 | Every refusal `mode_changed` | Killed: I-REV-17b |
| F6 | Report-mode resume after a write began records `planned` | Killed: I-REV-17b |
| F6b | Report-mode resume does not adopt the PR | Killed: I-REV-17b |
| F7a | GraphQL binding removed | Killed: U-MG-19 |
| F7b | GraphQL binding ignores the number | Killed: U-MG-19 |
| F7c | GraphQL binding ignores the repository | Killed: U-MG-19 |
| N9a | PR `base` not checked | Killed: U-MG-20 |
| N9b | `DELETE` of any `graft-revert/` name (route and bodiless list) | Killed: U-MG-3 |
| N11 | A `planned` comment rendered with the run's mode | Killed: I-REV-2b |

Review 1 had 11 surviving extra mutations. Nine are now killed: X1, X4, X5, X11, X17, X20, X22, X25 and X28. The other two, X19 (not re-run) and X24, are equivalent.

### Regressions

- **Report mode is still inert.** `forInstallation(…, { feature: "guard" })` is still only at `revert.ts:1069`, after the report-mode return. The new report-mode path (finding 6) uses the default client's `pulls.list`. `settleFailedRun` comments through `publishGuardComment` with the default client. The GraphQL `after` hook is installed only on `guard` clients. I-REV-2, I-REV-4 and N-8 pass in the full run.
- **Exactly once still holds without the job row.** A job row now lasts one hour, so a second `guard.revert` for the same event can be sent after that. Such a run finds a stored outcome and only comments. Or it finds the claim and resumes from the stored steps (D17 b–d) under the repository lock. While a job is queued, active or retrying, its row exists and deduplicates.
- **Retention on a deployed queue.** `start()` calls `updateQueue` and tightens the `deletion_seconds` of existing jobs for any queue below 7 days. The one-hour retention therefore applies at the first deploy, not only to new jobs.
- **Steps 1–4 are still green** in the full suite. The doctor count change (19 checks) is reflected in I-DOC-1, I-DOC-3, I-GRD-16 and INV-4.

## New findings

### A. minor (follow-up fix): a run whose writes began is settled `error` without looking up its PR

`settleFailedRun` (`revert.ts:1159`) sets `error` on any event with no outcome (`:1175`). It does not check whether the writes began (`revert_branch` or `revert_commit_sha`). `failed()` does the same for a write error on the last attempt. That part predates the fixes, and review 1 did not flag it. Once the outcome is set, a later `guard.revert` only comments, because only an `opened` outcome counts as unfinished. So there are two cases:
- **A resumed run that fails before its writes.** Run 1 creates the ref and opens the PR, and the worker dies before `storePr`. On the retry, the installation token fails three times. `settleFailedRun` stores `error github_5xx`. The PR is open on GitHub, but the event does not name it. The cap does not count it, D17 e does not block another revert of the culprit, `guard.revert_closed` finds no event, and `guard.track` never marks it `reverted`.
- **A write error after GitHub applied it.** `POST …/pulls` answers 502 on the last attempt, but GitHub created the PR. `failed()` stores `error` with the same result.

**Impact.** The orphan PR is still an ordinary revert PR that a human sees, and auto-merge is never enabled on it, so the effect fails toward safety. The cap undercounts by one, and the event's story is wrong. It also contradicts what the fixes document. `docs/features/guard.md` and `docs/configuration.md` say "a revert whose writes already began is finished whatever its age", and decisions.md says an event whose writes began "is resumed whatever its age". That holds for the `stale` rule but not after a last-attempt failure.

**Fix (follow-up):** in `settleFailedRun`, when `revert_branch` or `revert_commit_sha` is set, either:
- leave the outcome null, so the next observe re-sends the job after an hour (the `stale` rule already exempts the event) and it resumes, while the doctor's `guard_revert_claims` warning shows the wait; or
- do finding 6's lookup by head (a GET with the default client) and adopt the PR before settling `error`.

Apply the same lookup in `failed()` on its last attempt, when the failing step is `POST …/git/refs` or `POST …/pulls`. Add an I-REV-10b case: a crash after `POST …/pulls`, then a token failure on the last attempt. The event must end with the PR stored (`revert_opened`, counted by the cap), or with no outcome and the job re-sendable.

### B. minor (follow-up fix): the `stale` age from confirmation has no test

`isStale` (`revert.ts:144`) measures from `confirmed_at`, falling back to `detected_at` and then `created_at`. decisions.md gives the reason: `GRAFT_GUARD_CONFIRM_SECONDS` can be 86,400, and the third confirm attempt runs about three windows plus 60 s after detection. I-REV-10b's events are confirmed right after detection, so F4e (detection first) survives. With that regression and `GRAFT_GUARD_CONFIRM_SECONDS=86400`, or simply a `GRAFT_GUARD_REVERT_MAX_AGE_HOURS` shorter than the window, every event confirmed by the window would be `stale`, and enforce mode would never open a revert.

**Fix (follow-up):** add a case to I-REV-10b. Detect an event, advance past the max age, then confirm it (`confirmed_at` now). It must plan and open, not `stale`. Consider also checking at startup, or in `pilot doctor`, that `GRAFT_GUARD_REVERT_MAX_AGE_HOURS × 3600` exceeds `GRAFT_GUARD_CONFIRM_SECONDS`. As long as `isStale` reads `confirmed_at`, that pairing is safe. But an operator who sets both to 24 hours should know the margin is the confirmation time.

### C. nit: the conditional `revert_closed` update has no test

The early return (`event.status !== "revert_opened"`) handles every sequential case, so X28b (the `where status = 'revert_opened'` removed) survives. The condition only matters when `guard.track` marks the event `reverted` between the job's read and its update. **Fix:** a unit-level case that changes the row to `reverted` after `eventByRevertPr` (for example in a fake `pulls.get` hook) and expects `settled`, with `reverted_at` unchanged. Alternatively, accept and record it, since `markReverted` is conditional too and the race window is one API call.

### D. nit: the guard's body rules ignore the query string

`normalisedPath` drops the query, so `POST …/pulls?head=main&base=release` with a valid body is sent (probe above). GitHub reads a JSON POST's parameters from the body, and Octokit never puts body parameters in the query for these routes, so I know of no way to exploit this. It is still the one part of a guard write that no rule looks at. **Fix:** refuse a `?` on the guard's `phase1` routes (`unknown_route`), as `#` now is. None of the job's writes carries a query.

## Recommendation

**No revert of PR #37 is needed.** Its two required fixes are correct, and their tests kill review 1's bypass and mutation X1. The recommended and minor fixes hold, and report mode is unchanged.

Before a pilot repository runs the guard in enforce mode:
- land findings A and B as one follow-up fix PR on `main`, with the I-REV-10b cases above;
- do the T1 (b) HUMAN-TODO check of `sha: null` on a directory on real GitHub, still open from review 1.

Nits C and D can go in the same PR or be recorded in decisions.md.
