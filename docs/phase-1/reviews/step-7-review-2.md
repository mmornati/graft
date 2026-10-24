# Step 7 review 2: Security review, five pilots, gate

**Verdict: APPROVED** (two minor follow-ups and four nits, none blocking)

Reviewer: senior engineer (Opus). Scope: the eight fix commits `4f29d23..c1d365e` on `claude/phase-1-step-7-review-fixes` (PR mmornati/graft#47, stacked on #46 and #45). They run from `29b4b1e` ("settle a permanent error after the writes began") to `c1d365e` ("decisions"): 20 files, +325/−54. Of those, `src/` is 5 files with no new migration. I reviewed them on `claude/phase-1-step-7-review-2`, cut from `c1d365e`. I judged them against review 1 (`docs/phase-1/reviews/step-7-review-1.md`), the "Phase 1 step 7" → "Review 1 fixes" section of `docs/decisions.md`, and `docs/phase-1/step-7-security-pilots-gate.md` (binding).

PR #47 is open, and its CI is green (`check` pass, 7m13s; `build` pass; `deploy` and the Graft checks skipped). Like review 1, this review runs **before** the merge.

## Summary

The required finding is resolved. So are the three recommended findings, the three minors and nits 8 and 10. Nit 9 is accepted and recorded, as review 1 allowed. Every fix that changes behaviour has a test, and every test kills the mutation it was written for:
- **Finding 1.** `settleBegunWrites` now takes the error. For a permanent error with no PR found, it returns null, so `failed()` and `settleFailedRun` settle `error`, write the comment and release the cap slot. I-REV-10f (two cases) is review 1's probe P1 turned into a test. My ten mutations of the new split are killed, except one: R4, a permanent error that never adopts a PR it could find (finding B).
- **Finding 2.** A verified `web-flow` commit on an MCP-opened PR is now `unverified`. U-FCT-1 and I-MCP-14b pin it. Five of my six mutations are killed; the sixth is equivalent.
- **Findings 3, 4, 6.** The runbook's emergency path is split. The security review, `effectiveCeiling`'s comment and `modes.md` now state the rolling-restart residual. The proxy docs state the three conditions. I read every changed step.
- **Finding 5.** All six of review 1's surviving mutations are killed now (X6, X30, X37, X39, X40, X41). I re-applied each one alone. X37 needs a correction to review 1 (see the table).
- **Finding 7.** N-17 now also runs break-glass in both stored-ceiling profiles.

The definition of done is green when I run it: 113 files, **1,286** tests, plus lint, typecheck, build, eval:ci, and migrate/rollback/migrate.

New findings, none blocking:
- **A (minor, docs):** "the ref left behind is deleted by the stale-branch rule of a later run" is false. Review 1 said it first, and the fix copied it into the code comment and the security review. The branch is named after the event, and a settled event never runs again, so the ref stays. That is harmless, and it matches pre-step 7 behaviour, but the documents should say so.
- **B (minor, test):** a permanent error after a crash that had already created the PR must adopt that PR. No test pins this (R4 survives). Without it, an open revert PR is invisible to the cap, the same hazard step 5 review 2 finding A fixed.
- **C (nit, spec):** spec D8 and U-FCT-1 (and D4's "not found → resumable") now contradict the code. I draft the amendment below.
- **D to F (nits):** stale counts and scope lines in the security review; two wording gaps in the runbook's deployment-wide emergency path; the stage 6 `web-flow` check is now stricter than safety requires.

On the two explicit questions:
- **The security review still honestly supports "READY FOR PILOT ENFORCEMENT"**, once finding A's sentence is corrected (see "The security review's verdict").
- **The spec's U-FCT-1 wording does contradict the code.** It deserves a one-line amendment (finding C).

## Review 1 findings

| # | Finding (review 1) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | required: a permanent error after the revert's writes began is never settled | **Resolved** | `settleBegunWrites(ctx, data, octokit, cause)` (`src/modules/guard/revert.ts:494`). It still looks the PR up once and adopts it if found. Otherwise `if (!isRetryable(cause)) return null` (`:532`), so the caller settles `error` and writes the comment. `failed()` (`:914`) passes `err`. `settleFailedRun` (`:1222`) passes its `err` too. A retryable error on the last attempt is still `resumable`. I-REV-10f (`test/integration/guard-revert.test.ts:1857`): the ref is created, `POST …/pulls` answers 422 on a *non*-last attempt. The result is `commented`, outcome `error`, `revert_branch` kept, one comment, `countOpenReverts` 0, one `POST …/pulls` in total, and no `guard.revert` after the job row expires. The second I-REV-10f case (`:1881`): `settleFailedRun` with a plain error on the last attempt stays resumable, then with a `PermanentJobError` it settles `error` with a comment, and the slot is 0. Security review finding 10 and Q-RV-4 are corrected, new finding 13 is added, and `docs/features/guard.md` describes both paths. **Mutations R1–R3, R5–R11 killed. R4 survives (finding B).** The remark about the ref is wrong (finding A). |
| 2 | recommended: D8 trusts the author of any `web-flow` commit | **Resolved** (option 2, fail closed) | `src/modules/policy/facts.ts:212`: `if (committer === "web-flow") return { unknown: "unverified" }`, inside the `REQUIRE_VERIFIED_COMMITS` block, after the verification and null-committer checks. U-FCT-1 (`test/unit/policy-facts.test.ts:223`): all verified with real committers → `["alice","bob","carol","dave"]`, and the review 1 input (a `web-flow` commit by `Alice`) → `unverified`. The helper's default committer is now `dave`, so the other cases fail for their own reason, as review 1 asked. I-MCP-14b (`test/integration/mcp.test.ts:1501`): commits by `alice`, committed by `carol` (signed) → `bob` counts, `alice` and `carol` do not. Then one `web-flow` commit → `current: 0`, `mcpExclusion: "unverified"`, and the D8 line in the policy section. HUMAN-TODO, runbook stage 6 step 4, `mcp.md`, `architecture.md`, security review finding 7, Q-MCP-7 and new finding 14 are updated. **W1, W2, W3, W6 killed; W5 equivalent.** The spec text now differs from the code (finding C). |
| 3 | recommended: the emergency ceiling rollback can leave other repositories unprotected | **Resolved** | `docs/pilots/phase-1-runbook.md:124`. "For one repository (the fast path)" keeps the old two steps. "For every repository at once (… slower)" says why: `neutral` passes a required check. Then: (1) list every repository with `modes.policy.effective = enforce`; (2) the repo admin restores required reviewers on each one and checks it off in the stage record; (3) "only then" the operator lowers the ceiling, finishes the roll, and checks `mode show`. That is the order review 1 asked for. Two wording gaps remain (nit E). U-DOC-3 still parses the commands the runbook names (passes in the full run). |
| 4 | recommended: three statements in the security review are not accurate | **Resolved** | (a) Finding 10 now limits "fail closed, temporary" to a *retryable* error and points to finding 13. Q-RV-4 adds the permanent case. (b) Q-MD-1's second bullet now says a restarted old-config worker stores `enforce` again until the next new worker start, and the residuals list gains that line. The same correction is in `src/modes/index.ts:58` and `docs/features/modes.md`, which adds "Finish the roll, and check `mode show`". (c) Q-MCP-7 and finding 7 describe the `web-flow` rule. The summary names findings 13 and 14. The verdict line is unchanged and appears once. Only finding 13's ref sentence is wrong (finding A). |
| 5 | minor: six rules have no test | **Resolved** | X6: the I-REV-10d lookup-failure variant (`guard-revert.test.ts:1840`). X30: I-P1G-8 rolls back to report (applied) and expects `enforceSince: { policy: null, guard: null }`. X39, X40, X41: the new I-P1G-11 (`gate-phase1.test.ts:413`). X37: I-DB-16 now also asserts that the `phase1` run is kept. **All six killed** (table below). |
| 6 | minor: the trusted-proxy docs promise more than the setting gives | **Resolved** | `docs/configuration.md` (`GRAFT_TRUST_PROXY` and `GRAFT_MCP_AUTH_FAILURES_PER_MINUTE`, which still said "no `trustProxy` is configured") and `docs/features/mcp.md` state the three conditions: the proxy's own addresses only, an appending (`$proxy_add_x_forwarded_for`) or overwriting proxy, and Graft reachable only through it. `.env.example` uses `10.0.0.5`. U-CFG-40 keeps `fd00::/8` as a parser case, which is correct, because it tests syntax. One stale line is left in HUMAN-TODO (nit D). |
| 7 | minor: N-17 does not run every scenario | **Resolved** for break-glass | N-17 (`test/integration/neutral.test.ts:1221`) calls `breakGlassScenario()` before `mcpScenario()`. It asserts the three audit rows (`applied`/`ignored role_too_low`/`removed`, all `report`) and that no `graft/policy` run is `success`. The narrower reading for the guard scenarios, which their own `it`s drive, is recorded under N-17 in decisions.md. I agree: the world's guard event runs, and S1 is killed by I-CEIL-1 and N-17. |
| 8 | nit: `REQUIRE_VERIFIED_COMMITS` presented as a pending decision | **Fixed** | HUMAN-TODO strikes D8 out of the pending list ("decided by the spec … turning it off reopens step 6 residual risk 2 and needs a new security review"), and so does the `facts.ts` comment. The list's intro now says four decisions remain. |
| 9 | nit: the gate's per-repository modes use the worker's ceiling | **Accepted, recorded** | decisions.md, the "D14 to D19" bullet, next to the `mode show` choice. Agreed. |
| 10 | nit: `private` defaults to `true` | **Fixed**, no test (accepted) | `gate-phase1.ts:873`: `priv.get(id) ?? false`. The default cannot be reached (same query scope), so no test can pin it. |

### Finding 1 in detail

**What the code does now.** `failed(err)`:
1. Refusal → `error`, then the comment. Unchanged.
2. Retryable and the queue can retry → rethrow. Unchanged.
3. `settleBegunWrites(…, err)`. It returns null at once when writes have not begun. Otherwise it looks the PR up with the run's client. If found → `storePr` (`revert_opened`, `opened`) and `"adopted"`. If not found, or if the lookup throws (caught and logged by class) → `"resumable"` when `err` is retryable, else null.
4. Null → `settle("error", errorClass(err))` and `comment()`.

`handle` calls `settleFailedRun` only when `!isRetryable(err) || !canRetry(ctx)`, and `settleFailedRun` makes the same call with `octokit = null` (a fresh client).

**The cases, checked against the code and the tests:**

| Error | Writes began | PR on GitHub | Result | Pinned by |
| --- | --- | --- | --- | --- |
| retryable, not last attempt | any | any | rethrown, retried | I-REV-10c/d (first run) |
| retryable, last attempt | yes | yes | adopted, no comment, label and auto-merge on the next run | I-REV-10c |
| retryable, last attempt | yes | no / lookup fails | resumable (slot held until the next observe) | I-REV-10d, I-REV-10d lookup-failure, I-REV-10f (b) |
| permanent | yes | no / lookup fails | `error` + comment, slot released, never re-sent | I-REV-10f (a), (b) |
| permanent | yes | **yes** | adopted | **nothing** (R4, finding B) |
| any | no | — | `error` + comment, as before step 7 | the existing I-REV suites |

**Fail-closed check.** The one new way to settle `error` is a permanent error whose lookup fails. If a PR does exist, for example after a crash right after `POST …/pulls` followed by a permanent error and a transient lookup failure, the event is settled `error` while an open revert PR exists. That is the step 5 review 2 finding A outcome, for a double fault, and it is what happened for every error before step 7. I accept it. The alternative is to stay resumable on a permanent error, which is review 1's finding 1. With the 422 case specifically, the PR path already adopts inline: `createPr` looks the PR up on any 422 before it throws (`revert.ts:716-719`). So I-REV-10f (a) reaches `failed()` only when no PR exists, which is the common case.

**The cap slot.** `countOpenReverts` counts `culprit_found` with a claim and a null outcome. Both permanent paths write an outcome, so the slot is released, as both I-REV-10f cases assert. R7b and R11 (below) confirm that `settleFailedRun`'s settlement and its comment are each pinned.

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | OK ("Already up to date") |
| `pnpm db:up` | Not run. The shared `scionhub-postgres-1` (port 55432) was stopped, and I did not touch it. I ran my own `postgres:18-alpine` (`graft-s7r2-pg`) on `127.0.0.1:55473` and removed it at the end. |
| `pnpm lint` | OK (385 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm test` (`TEST_DATABASE_URL=…:55473/graft_s7r2`) | OK: 113 files, **1,286** tests passed (the developer's count: review 1's 1,282 plus I-REV-10f ×2, the I-REV-10d lookup-failure variant and I-P1G-11), 434 s |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0; every threshold passes, `matchBaseline: 1` (my run directory removed) |
| `db:migrate && db:status` (scratch `graft_s7r2_dod`) | `0001`..`0016` applied |
| `db:rollback && db:status && db:migrate` | Only `0016_phase1_gate` rolled back (CHECK back to `('baseline','shadow')`), then re-applied |
| `@ts-ignore` / `@ts-expect-error` grep (`src`, `test`) | Clean |
| `{ feature: "` grep | Exactly three: `policy/job.ts:194`, `guard/revert.ts:1132`, `mcp/tools/open-change.ts:178` |
| `metrics_daily\|rollup` in `gate-phase1.ts` | Clean |
| `^Verdict: READY FOR PILOT ENFORCEMENT` | One line |
| §15 test-ID grep | 70 lines (68 in review 1; the two I-REV-10d/I-P1G cases added lines) |
| CI on PR #47 (`gh pr checks 47`) | `check` pass (7m13s), `build` pass; `deploy` and the Graft checks skipped |

I did not run the manual smoke test of §15, the enforce sandbox against live GitHub, or the real-GitHub checks. They are HUMAN-TODO.

### Mutation checks

I applied each mutation alone with a script in this worktree: an exact-string replacement that must match once. The script ran the named test files against `graft_s7r2`, then restored the file with `git checkout --`. `git status --porcelain` was empty after the run, and the branch has no source change.

**Review 1's surviving mutations, re-applied:**

| # | Mutation | Result |
| --- | --- | --- |
| X6 | D4: a failed lookup settles `error` (`return null` in the lookup's `catch`) | Killed: I-REV-10d (lookup-failure variant) |
| X30 | `enforceSince` ignores "requested still enforce" | Killed: I-P1G-8 |
| X37a | `0016` down without the refusal | Killed: I-DB-16. Postgres's own CHECK error does not match `/phase1 review time runs exist/`. **Correction to review 1:** this form was already killed before the fix, as decisions.md says. Review 1's "survived" must have come from a different form in my script. |
| X37b | `0016` down deletes the `phase1` runs instead of refusing | Killed: I-DB-16 (the down no longer rejects) |
| X39 | M3 window on `created_at` | Killed: I-P1G-11 |
| X40 | M2 measured baseline takes every paired repository | Killed: I-P1G-11 |
| X41 | Retention ignores the 7-day delivery window | Killed: I-P1G-11 |

**Mine, on finding 1** (`guard-revert.test.ts`):

| # | Mutation | Result |
| --- | --- | --- |
| R1 | The `isRetryable(cause)` check removed (review 1's code) | Killed: I-REV-10f (both) |
| R2 | The check inverted (`if (isRetryable(cause)) return null`) | Killed: I-REV-10d, I-REV-10f |
| R3 | The check removed, leaving the log and `"resumable"` | Killed: I-REV-10f (both) |
| R4 | **The check moved before the lookup** (a permanent error never adopts a PR it could find) | **Survives** (finding B) |
| R5 | `failed()` passes a retryable stand-in (`new Error("x")`) instead of `err` | Killed: I-REV-10f (a) |
| R6 | `settleFailedRun` passes a retryable stand-in | Killed: I-REV-10f (b) |
| R7 | `settleFailedRun` skips the `error` settle when `revert_branch` is set | Survives, but **not a gap**: I-REV-10f (b) crashes in `createRef`'s hook, so only `revert_commit_sha` is stored. I rewrote it as R7b. |
| R7b | `settleFailedRun` skips the `error` settle when `revert_commit_sha` is set (the slot never released) | Killed: I-REV-10f (b) |
| R8 | `failed()` settles `error` but writes no comment | Killed: I-REV-10f, I-REV-13b, I-REV-5b |
| R9 | A permanent error retried while attempts remain (`if (canRetry(ctx)) throw err`) | Killed: I-REV-10f, I-REV-13b |
| R10 | `failed()` returns `"stopped"` for any permanent error without settling | Killed: I-REV-10f, I-REV-13b, I-REV-5b |
| R11 | `settleFailedRun` settles but skips the comment when writes began | Killed: I-REV-10f (b) |

**Mine, on the `web-flow` rule** (`policy-facts.test.ts`, `mcp.test.ts`):

| # | Mutation | Result |
| --- | --- | --- |
| W1 | The `web-flow` line removed (review 1's code) | Killed: U-FCT-1, I-MCP-14b |
| W2 | `web-flow` → `no_author` instead of `unverified` | Killed: U-FCT-1, I-MCP-14b |
| W3 | Only the first commit's `web-flow` committer checked | Killed: I-MCP-14b (its `web-flow` commit is the second) |
| W5 | `web-flow` no longer kept out of the committer logins (`committer !== "web-flow"` dropped at the `logins.add`) | Survives, **equivalent**: with `REQUIRE_VERIFIED_COMMITS = true`, a `web-flow` commit has already returned `unverified`, so the clause is dead. It matters only if someone sets the constant to `false`, and then it keeps step 6's rule. |
| W6 | A `web-flow` commit skipped (`continue`: neither excluded nor unverified) | Killed: U-FCT-1, I-MCP-14b |

### The fixed runbook steps, read as mutations

I read each changed step and asked what a wrong version would do, because no test executes the runbook (U-DOC-3 checks only its commands):
- **The order of the deployment-wide path.** If step 3 (lower the ceiling) came before step 2 (restore reviewers), we would be back at review 1's hazard. The text says "**only then**", gives the reason in the lead paragraph, and asks the repo admin to check each repository off in the stage record. That is correct.
- **Which repositories.** "`repositories[].modes.policy.effective` is `enforce`" covers every repository that could be past stage 3 step 5, because a repository without reviewers that is *not* enforcing is already unprotected by its own runbook state, not by the emergency. But the listing needs the database and one gate report per installation, and the step's own trigger is "Graft is down" (nit E).
- **The fast path.** One repository, unchanged: the admin restores reviewers *and* removes `graft/policy` from the required checks, then `mode set … report`. That is still correct whether or not Graft is up.
- **The restart.** It names the finding 4 residual (finish the roll) and ends with `mode show` per repository. That is correct.
- **Stage 6 step 4.** It requires the `web-flow` check before `mcp_write` goes on, and tells the team what a web-UI edit does. That is safe, and stricter than needed now (nit F).

## The security review's verdict

**Does "READY FOR PILOT ENFORCEMENT" still stand after findings 13 and 14? Yes.** My reasons:
- Both new findings are listed as **major**, with problem, fix, tests and status, and they are attributed to review 1. The summary paragraph names them. A person signing off the verdict sees them without reading this review.
- Both fixes fail closed. Finding 13 restores the pre-step 7 settlement for permanent errors, and a retryable error still gets D4's adoption or resumption. Finding 14 can only make fewer approvals count. My mutations of both are killed, except R4 (finding B) and the equivalent W5.
- The two residuals that the fixes leave are now stated where the signer reads them: the D4 quiet-repository slot (finding 10, retryable only) and the rolling-restart re-raise (Q-MD-1). The `web-flow` cost is in Q-MCP-7: approvals stop counting after a web-UI edit.
- Nothing in the fixes touches report mode. N-17 now includes break-glass, and the full neutral suite passes.

**What is not accurate** (finding A, nit D): finding 13's "the ref left behind is deleted by the stale-branch rule of a later run" is false. The opening paragraph still says "three minors and two nits remain". The scope and DoD lines describe only the build commits. None of these changes the verdict, but the first one is a statement of fact in a document a person is asked to sign, so it should be corrected before the sign-off.

## New findings

### A. minor (docs): the orphan `graft-revert/` ref is never deleted

`revertBranch(eventId)` is `graft-revert/<event id>`. The stale-branch rule (`revert.ts:657-690`) runs only inside the run *of the same event*, when `createRef` answers 422. Once a permanent error settles the event `error`, `runRevert` only writes the comment, and observe never re-sends it. So no later run ever touches that ref. It stays in the repository until a person deletes it.

That is harmless. It has no PR, so the cap, `revert_closed` and `guard.track` never see it. The guard client can only write `graft-revert/<uuid>` refs. And it is exactly what happened before step 7. But three places say otherwise:
- review 1's own fix text (`step-7-review-1.md:188`), where the error started;
- the `settleBegunWrites` comment (`revert.ts:491`);
- security review finding 13 (`step-7-security-review.md:33`).

**Fix** (docs only): replace the sentence with "The ref is left in place, as before step 7. It has no PR, and a person can delete it; `graft guard list` shows the event as `error`." Optionally, the error comment (`revert-text.ts:307`) can name the branch.

### B. minor (test): a permanent error that finds a PR must adopt it

R4 survives: a version of `settleBegunWrites` that returns null for a permanent error *before* the lookup passes every test. The lookup still matters for a permanent error. Take a run that crashed after `POST …/pulls` (the PR exists, its number is not stored), whose next attempt fails permanently before it reaches the PR step. For example, the installation token answers 404 or 403 because the installation was suspended and resumed, or a read before the ref step answers 404. Without the lookup, that event is settled `error` while its revert PR is open. The cap, D17 (e), `revert_closed` and `guard.track` never see it: the hazard of step 5 review 2 finding A, which D4 exists to close. The code is right today (adopt first, then decide). Only the pin is missing.

**Fix:** add a third I-REV-10f case. `api.afterNext("POST", /\/pulls$/, () => { throw new Error("worker crashed") })` on a retrying run. Then call `settleFailedRun(data, ctx(ENFORCE, RETRYING), new PermanentJobError("forbidden", "github_403"))`. Expect `revert_opened`, outcome `opened`, `revert_pr_number` set, no comment, and `countOpenReverts` 1. R4 must then fail.

### C. nit (spec): D8, U-FCT-1 and D4 no longer describe the code

The developer recorded the D8 difference in decisions.md ("This differs from spec D8 and U-FCT-1's text … as the review asks"). The spec is still binding, though, and it now says the opposite of the code in three places:
- the D8 row (§3, `step-7-security-pilots-gate.md:52`): "or when its `committer` has no login and is not `web-flow`", and the reason column "with verified commits every committer is genuine";
- the U-FCT-1 row (§13, `:404`): "all verified → logins (authors and committers, `web-flow` left out)";
- the D4 row (`:48`): "Not found, or the lookup fails → leave `revert_outcome` null". That now holds only for a retryable error.

A later reader, or a future review that checks the tests against §13, would take the code for a regression. **Yes, the spec should get an amendment.** It is small and changes no decision, so it can go in the next docs commit, with no new spec review. Drafts:

> **U-FCT-1** | `listCommitLogins`: all verified with real committers → logins (authors and committers); a verified commit committed by `web-flow` → `unverified` (review 1, finding 2); one commit `verification.verified: false` → `unverified`; `verification` absent → `unverified`; a null committer → `unverified`; 251 commits → `too_many`; a null author → `no_author`

And the matching clause in the D8 row: "… or when its `committer` has no login **or is `web-flow`** (a `web-flow` signature proves only that GitHub made the commit; step 7 review 1, finding 2)."

And in the D4 row: "Not found, or the lookup fails → **for a retryable error,** leave `revert_outcome` null …; **for a permanent error (422, 404, 403), settle `error` with the comment, as before step 7 (review 1, finding 1).**"

### D. nit: stale lines in the security review and HUMAN-TODO

- **The security review.**
  - "Three minors and two nits remain": only finding 10 (minor) and findings 11 and 12 (nits) are still open. Findings 2, 4, 8 and 9 are fixed. The count was already wrong in the first version.
  - The scope and "What was checked" lines name only the build commits, with the old test count. Add one line: "Re-checked after the review 1 fixes (`29b4b1e..c1d365e`): 1,286 tests; findings 13 and 14."
  - Q-MG-5 cites `guard/revert.ts:1123`; it is `:1132` now.
- **HUMAN-TODO, step 6 section.** "Graft configures no `trustProxy` … (a code change, see decisions.md)" (`HUMAN-TODO.md:53`) contradicts D6 and the step 7 item to set `GRAFT_TRUST_PROXY`. Point it at the step 7 item.

### E. nit: the deployment-wide emergency path depends on Graft and its database

The section's trigger is "Graft is down, or every check is stuck `in_progress`". The deployment-wide path, though, needs Graft running twice:
- **To list the repositories.** Step 1 lists them with `gate report` (one per installation, which the text leaves implicit) or with `mode show`. Both need the database.
- **To publish the `neutral`.** Step 3's ceiling drop helps only once a worker runs again.

**Fix:**
- In step 1, name the stage record as the first source: "every repository past stage 3 step 5, from the stage record; cross-check with `gate report --phase 1` for each installation when the database is up".
- Add one sentence: "If Graft cannot be brought back up, use the per-repository path on each repository: removing `graft/policy` from the required checks is the only thing that unblocks merges."

### F. nit: the stage 6 `web-flow` check is no longer a safety precondition

Review 1 asked that no repository enter stage 6 "until the fix or the check is done". The fix is in, and it fails closed whatever GitHub does. Runbook stage 6 step 4 and the HUMAN-TODO item still make the real-GitHub check a precondition. That is safe, and it records the facts early, which helps. But it blocks an optional stage on a check whose only use now is to *relax* the rule. Either keep it (and say "recommended" rather than required), or move it to "before relaxing the `web-flow` rule". No change is needed for pilots.

## Regressions

- **Report mode is still inert.** No fix adds a request or a client before the mode read. The guard changes run only after a guard client has written (enforce). The `web-flow` rule runs only for an MCP-opened PR. N-1..N-17 pass in all four profiles, and N-17 now runs break-glass too.
- **The three feature clients are unchanged** (the grep above; only the `revert.ts` line moved).
- **D4's retryable path is unchanged.** I-REV-10c, 10d and 10e pass, and R2 shows they still depend on the retryable branch.
- **Docs.** decisions.md records each fix, the N-17 reading, the nit 9 choice, the two new residuals and a mutation table that matches what I re-ran (mine adds X37b, R1–R11 and W1–W6). `guard.md`, `mcp.md`, `modes.md`, `configuration.md`, `architecture.md` and `.env.example` describe the new behaviour correctly, apart from finding A and nit D.

## Phase 1 status

**Phase 1 is complete as code**, once PRs #45, #46 and #47 merge (this review approves #47; findings A to F can go in a small follow-up). All seven steps are built and reviewed twice:
- modes;
- approvals;
- break-glass;
- guard detection;
- revert PRs;
- the MCP server;
- the security review, the runbook and the Phase 1 gate.

Every hardening item H1–H9 and both new security findings are fixed, with tests. The definition of done is green. No spec mutation survives except the three recorded as equivalent (S11, S22, X31). What remains is work only a person can do. The developer agent cannot tick any of it:

1. **HUMAN-TODO** (`docs/phase-1/HUMAN-TODO.md`). Broadly:
   - **The per-step manual smoke tests and sandbox checks**, steps 2–6 and the step 7 enforce sandbox.
   - **The real-GitHub and real-client T1 checks the offline build could not do.** These are:
     - the issue-events actor and its lag;
     - the tree, label and auto-merge behaviour;
     - `pulls?head=…&state=all`;
     - `commit.verification` for agent keys;
     - the `web-flow` contents-API check;
     - the 2025-era and 2026 MCP clients.
   - **The operator settings**: `GITHUB_APP_SLUG`, `GRAFT_TRUST_PROXY`, `/mcp` behind the proxy, the ceiling left at `report` until the runbook says otherwise, and the manifest per deployment.
   - **Per-installation work**: accepting the new permissions and events, then `refresh-permissions`.
   - **Repository work**: creating the `graft:break-glass` and `graft:revert` labels, and requiring `graft/policy` with the App as source.
   - **People**: recruiting three more pilot teams to reach five installations; agents signing their commits; running the runbook per repository; the weekly gate review.
2. **The pending product decisions.** The spec raised five. The first, D8 (verified commits), is now decided by the spec (nit 8), so four remain open in HUMAN-TODO:
   - the gate thresholds (`PHASE1` in `gate-phase1.ts`);
   - the runbook numbers (`RUNBOOK_STAGE2`, plus the matching runbook line);
   - pilot retention (`PHASE1.retention`);
   - the D21 e2e scenario (`E01_STEPS` in `src/e2e/scenarios/e01.ts`).

   Each is a small change in code. The build uses the spec's values. The product owner should still confirm the D8 strike-through, because the original list had five items.
3. **The sign-off.** A person (the product owner) must read `step-7-security-review.md`, ideally after finding A's correction, and sign off its READY FOR PILOT ENFORCEMENT verdict before any repository leaves runbook stage 2.

The Phase 1 *gate* itself (`pnpm graft gate report --phase 1`) can only pass on real pilot data from five installations. That is the outcome of the human work above, not more code.

## Recommendation

**Merge PR #47** (after #45 and #46). The required fix is correct. It restores the pre-step 7 settlement for permanent errors, keeps D4 for retryable ones, and releases the cap slot, and ten of my eleven mutations of it are killed. The `web-flow` rule fails closed and is pinned. All of review 1's surviving mutations are killed. Report mode is unchanged.

Follow-up, before the security review is signed off:
- finding A (correct the ref sentence in three places);
- finding B (one more I-REV-10f case);
- finding C (the spec amendment drafted above);
- nits D to F.

None of these needs to block the merge or the first pilot's stages 1 and 2.
