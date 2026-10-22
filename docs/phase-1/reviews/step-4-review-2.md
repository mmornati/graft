# Step 4 review 2: Post-merge guard, detection and culprit

**Verdict: APPROVED**

Reviewer: senior engineer (Opus). Scope: `origin/main..345a869` on `claude/phase-1-step-4-review-fixes` (PR mmornati/graft#28), reviewed on the local branch `claude/phase-1-step-4-review-2`: 7 commits, 14 files, +910/−117. The commits are the review 1 file (`d7647a2`), the developer's five fix commits and one docs commit (`569bf97..3b5302c`), and the coordinator's `345a869`, which hardens `safeHtmlUrl` after an automated security review. I judged them against review 1 (`docs/phase-1/reviews/step-4-review-1.md`), the "Phase 1 step 4: guard detection" section of `docs/decisions.md` with its "Review 1 fixes", and `docs/phase-1/step-4-guard-detection.md` (binding).

## Summary

The major finding is resolved:
- The guard scenario merges its own PR 3, PR 2 stays open, and the reopen block is gone.
- `NEXT_SHA` serves the team `graft.yaml`.
- `breakGlassScenario` now asserts its precondition: `policy_status = ok`, `policy_commit_sha = NEXT_SHA`, `would_require` and the team constraint.
- Breaking break-glass so that it no longer bypasses a real `would_require` fails N-10 and N-11. So does removing the policy from `NEXT_SHA`.

The seven minors are fixed. Each fix has a test, and each test kills the mutation that breaks its rule. Of the four nits, two are fixed and two are accepted or forwarded with reasons. I agree with both.

`345a869` holds. I could not escape the repository prefix with dot segments, any-case percent-encodings, backslashes, userinfo, IDN or punycode hosts, ports, or query and fragment tricks. GitHub and GHE check-run and status URLs still pass.

Report mode is still inert. The only guard write is the comment, through the default client. The step 1–3 suites are green. PR #27 merges into this branch without a conflict, and the merged tree is green, including the precondition and the break-glass mutations.

No blocker or major remains. I found two minors and four nits, listed below. Neither minor is a safety problem in report mode, and neither blocks the merge. Both should land before step 5 turns a `culprit_found` event into a revert:
- Finding 7's "red wins across suites" hardening may never see the red run against real GitHub, because of how `filter=latest` works.
- The narrowing rule of finding 2 has a safety condition with no test. A plausible regression of it gives a false culprit.

## Review 1 findings

| # | Finding (review 1) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | major: the neutral suite's break-glass scenarios ran with no `graft.yaml` on `main` | **Resolved** | See "Finding 1 in detail". `GUARD_PR = 3` (`neutral.test.ts:73`, `:389-404`), and `putContent(api, NEXT_SHA, …)` is at `:434`. The precondition check is at `:827-846`. Mutations B1, B2 and T1 each fail N-10 and N-11. |
| 2 | minor: a late green on the parent does not narrow an open event | **Resolved** (with new finding A) | `narrowEvent` (`src/modules/guard/observe.ts:399-432`) runs first in `confirmOpenEvents` (`:440`). I-GRD-10c (`guard.test.ts:667`) is review 1's P1: `ambiguous` before the fix, `culprit_found #8` now. Removing the call fails I-GRD-10c. Three of narrowing's guard conditions have no test (finding A). |
| 3 | minor: the `status` handler drops a default-branch status when `main` is not listed | **Resolved** | `handlers.ts:147`: the handler enqueues when the list names the default branch or has 10 entries. I-GRD-4 covers it: 10 branches enqueue, 9 do not. Removing the cap check fails I-GRD-4, and so does an off-by-one (`<=`). The corrected T1 (d) (`decisions.md:487`) matches GitHub's webhook reference: the branches *contain* the SHA, which may or may not be their head, and there are at most 10. A full list therefore always enqueues, so no default-branch status can be dropped. A false positive costs at most one inline track per 30-second window, and the job stops at `not_on_default_branch`, which X9 now pins. |
| 4 | minor: an event still undecided at its deadline is never examined again | **Resolved** | See "Finding 4 in detail". The margin is `CONFIRM_MARGIN_SECONDS = 60` (`observe.ts:69`, `:384`). The re-send is at `:687`, its key `confirmKey` is at `schemas.ts:28`, and the final settle is at `observe.ts:457-461`. Removing the margin fails I-GRD-8. Removing the re-send fails I-GRD-8b and 8c. One key for every attempt fails I-GRD-8b and 8c. Removing the final settle fails I-GRD-8c, and so does settling undecided events as culprits. |
| 5 | minor: a transient error inside the D17 attempt loop loses the event | **Resolved** | `throw new BaselinesMissing` (`observe.ts:626`) rolls back the pass: its results, its events and the jobs it queued. The baselines are read outside the lock. I-GRD-12c (`:817`) is review 1's P4. A mutation that commits the pass and then reads the files fails I-GRD-12c. |
| 6 | minor: retention prunes a quiet repository's tip | **Resolved** | `store.ts:463`: the newest commit of each repository (`distinct on … seq desc`) and its results are kept. Removing that union fails I-GRD-15 and I-GRD-15b (`:1008`, review 1's P6). |
| 7 | minor: the candidate controls the CI, so D17's principle is narrower than the docs say | **Resolved** for the docs. The hardening's effect is unverified (finding B). | The "trust boundary" section of `docs/features/guard.md:93` and the decisions entry state the boundary correctly. They match the code: `guard.checks` is read at the baseline, red wins across check suites, and token-written results are left to step 5. Mutations: dropping "red wins" fails I-GRD-17, and so does ignoring the suite. Finding B is about whether real GitHub ever returns the red run. |
| 8 | minor: five rules have no test | **Resolved** | X3 fails I-GRD-11, X4 fails I-GRD-5, X5 fails I-GRD-6, X9 fails I-GRD-4, and X11 fails I-GRD-3. I re-ran all five, each alone. |
| 9 | nit: a status `target_url` can link anywhere on github.com | **Resolved** | `observe.ts` passes `${webBase}${owner}/${repo}/` for statuses. Reverting to the web root fails I-GRD-11. `345a869` makes the check structural (see "`safeHtmlUrl`"). |
| 10 | nit: `filtered` in `detect.ts` is dead code | **Resolved** | `KeyResult.filtered` and `why: "filtered"` are gone. `allowedByGuardChecks` is pure and used by `observe.ts`, and U-DET-12 tests it. The `ci_results.filtered` column stays to avoid a migration, as recorded. |
| 11 | nit: a fork PR from a branch named `main` costs an inline track | **Accepted**, and I agree | The cost is bounded per SHA and window, and the fix is not cheap. It is recorded with a metric trigger. |
| 12 | nit: the guard's `changes` rows and step 3 | **Deferred** to step 5, and I agree | Step 4 has no code that reads a culprit's break-glass verdict. The step 5 spec must read it by `change_id` and the merged head. |

### Finding 1 in detail

**The scenario.** PR 3 is created merged, as `MERGE_SHA`, with its own head (`neutral.test.ts:389-404`), and `commitPulls(MERGE_SHA)` maps to it. PR 2 is never touched by the guard scenario, so the step 3 scenario gets it open, as before step 4. `main` ends on `NEXT_SHA`, which serves the same `TEAM_POLICY + "# tightened"` as `B2` and `MERGE_SHA`, so the break-glass scenario evaluates the same policy it did before the rebase.

**The precondition.** It covers every verdict the scenario produced, both the `break_glass` rows and the next head's rows. It requires at least one of each, so an empty query cannot pass it silently.

**The mutations,** each applied alone:

| # | Mutation | Result |
| --- | --- | --- |
| B1 | Break-glass applies only over an unusable policy (`&& i.state !== "ok"`, `src/policy/enforce.ts:131`) | Killed: N-10, N-11 |
| B2 | Break-glass stops bypassing a real `would_require` (`&& i.verdict?.outcome !== "would_require"`) | Killed: N-10, N-11 |
| T1 | `NEXT_SHA` without `graft.yaml` (the `57c1bae` state) | Killed: N-10, N-11, on the precondition |

**The guard's own assertions still test what they claim.**
- N-1g expects exactly one guard comment, on PR 3, with the marker and the mode line.
- With no marker check (review 1's M8), N-1g and N-9 fail in both profiles, and so does I-GRD-6.
- N-8 is unchanged, and N-1 still checks every non-GET request against the route table, including the guard's `POST …/issues/3/comments`.

The developer notes that a `would_block`-only variant of B1 is caught by U-BG-1 and the I-BG tests, not by N-10 or N-11. I agree with leaving step 3's scenario alone while PR #27 edits it.

### Finding 4 in detail

**Can the 7-day `singletonJobId` swallow a needed confirm?** No.
- Attempt 0 keeps `guard:confirm:<id>`, and attempts 1 and 2 use `:<n>`. Each event id is a fresh UUID, and an event gets at most three keys over its lifetime.
- **Re-entering `confirming`.** Nothing sets a settled event back to `confirming`. `insertEvent` creates events as `confirming`, and only `confirmOpenEvents` changes the status. `recordTransition` adds keys only to `confirming` events, and moves only events listed by `openEvents`.
- **A move to an earlier commit (I-GRD-10b), and narrowing.** Both keep the id and `detected_at`, so the deadline of the job already queued still applies, and no new confirm is needed. A second `send` with attempt 0's key would be deduplicated, but nothing sends one.
- **The re-send itself.** It happens after `observeCommit` returns, outside the transaction. A pg-boss retry after a crash re-sends the same key, and that duplicate is deduplicated, which is harmless.

**Is the margin enough?** The start time comes from the database clock. The elapsed check compares the confirming worker's clock with the detecting worker's `now`. With 60 s, a confirm runs early only if the confirming worker's clock is more than a minute behind the detecting worker's. NTP covers that. If it does happen anyway, the run sees `wait` and re-sends, and attempt 1 runs a whole window later. The margin plus the re-sends therefore make the deadline self-correcting (I-GRD-8b).

**The product choice.**
- A culprit that is still red at any attempt, the last one included, becomes `culprit_found`, as D9 (b) requires. Rule 3 of `confirmationDetail` runs before the final-attempt branch (`observe.ts:457-461`).
- Only a `wait`, meaning no key is red on N and not every key is green, settles as `flaky` with a null reason, at the third attempt, about 3 windows plus 60 s after detection.
- I accept this. It fails toward silence. It needs no migration, so it leaves `0012` to PR #27. And "the failure did not persist" is a fair reading of a cancelled re-run.
- It does stretch D9's meaning of `flaky`, though, and the null reason is invisible to operators (nit D). The D9 (b) path at the final attempt has no test (nit C).

**Residuals, not graded.** In two cases the event stays `confirming`, and `pilot doctor` warns:
- a confirm job that exhausts its three pg-boss retries (a persistent API error), because the re-send needs a successful observe;
- an installation that becomes inactive.

Review 1's other suggestion, a sweep in the daily prune cron, would cover both if that ever matters.

## `safeHtmlUrl` (`345a869`)

The check has four layers (`src/modules/guard/comment.ts:71-89`):
1. the character class, with no `@()` and no backslash, space or `<>`;
2. no `%2e`, `%2f` or `%5c` in any case;
3. `new URL(url).href === url`, so nothing the parser would rewrite;
4. the parsed origin must equal the base's, and the parsed path must start with the base's path.

I ran over 40 inputs through a scratch script against both the web root and the repository prefix (`https://github.com/acme/app/`).

**Refused:**
- dot segments: `/..`, `/.`, `/./../`;
- percent-encodings: `%2e%2e`, `.%2E`, `%2F..%2F`, `%5c..%5c`, and `%2e` in the query;
- backslashes, raw or after the host;
- userinfo: `user:pw@` and `github.com@evil.com`;
- hosts: `GitHub.com` (the parser lowercases it, so the `href` check refuses it), `github.com.`, a punycode host and a Cyrillic `і`;
- ports: `:443` (the parser drops it) and `:8443`;
- `http:` and `https:/`;
- tabs and spaces;
- a prefix that appears only in the query or the fragment (`/acme/app?x=/acme/app/`, `#/acme/app/`);
- a sibling repository (`acme/application`);
- the repository root without a trailing slash.

**Passed, and harmless:**
- `..;/evil`: not a dot segment for WHATWG URL parsing or for GitHub's router;
- `%252e%252e`: a literal `%2e` after one decode;
- `//evil.com/x` inside the path: still a path on github.com;
- `[`, `]` and `'`: the link is rendered inside `(…)`, and `)` is refused.

**Still accepted:**
- github.com: `…/runs/1`, `…/actions/runs/1/job/2`, `?check_suite_focus=true`, `#step:4:10`, and UTF-8 percent-encodings in either case;
- GHE: `https://ghe.example.com/acme/app/runs/1` against `githubWebBase("https://ghe.example.com/api/v3")`;
- GHE with a port: `:8443`, kept as long as the base has the same port.

A base written with an uppercase host or `:443` is normalised by `githubWebBase` and still matches.

**Mutations:**
- No `href` check: U-GCM-5 fails (`GITHUB.com` and `:443` pass otherwise).
- No percent-encoding check: U-GCM-5 fails (`..%2fevil`).
- The parsed origin and path check replaced by the old raw prefix: survives. That is benign, because with the `href` check in place the two are equivalent. It is defence in depth.

Two observations, not findings, because both fail closed:
- `githubWebBase` keeps only the origin of a GHE API URL, so a GHE behind a path prefix would accept the whole host. GHE does not support path-prefixed installs.
- `api.<tenant>.ghe.com` (GHE.com data residency) gives `https://api.<tenant>.ghe.com/`, so its links would all be dropped. If GHE.com is ever targeted, map `api.X` to `X`.

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK |
| `pnpm lint` | OK (338 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0. Every threshold passes, `matchBaseline: 1`. |
| `pnpm test` (`TEST_DATABASE_URL=…/graft_test_r4b`) | 98 files, **1098** tests passed |
| PR #27 merged into this branch on a throwaway local branch: `pnpm typecheck`, `pnpm lint`, `pnpm test` | No conflict (`docs/decisions.md`, `fake-github-api.ts`, `guard.test.ts` and `neutral.test.ts` auto-merge). 98 files, **1110** tests passed. B2 and T1 still fail N-10 and N-11 there. Branch deleted afterwards. |
| `pnpm db:up` | Not run. I reused the shared Postgres on 127.0.0.1:55432 and started or stopped no container. |
| Greps: `feature: "guard"`; `rest.(git\|pulls\|repos).(create\|update\|delete\|merge)`, `rerequest`, `reRun`, `.request(` in `src/modules/guard/`; `@ts-ignore\|@ts-expect-error` | Clean. The only write in `src/modules/guard/` is `issues.createComment` (`comment.ts:262`). |

### Mutation checks

I applied each mutation alone with a script, ran `guard.test.ts`, `guard-detect.test.ts` and `guard-comment.test.ts` (or `neutral.test.ts` for B1, B2, T1 and M8), then ran `git checkout --` on the file. `git status` was clean after each one.

| # | Mutation | Result |
| --- | --- | --- |
| B1, B2, T1 | See "Finding 1 in detail" | Killed: N-10, N-11 |
| M8 | No marker check before commenting | Killed: I-GRD-6, N-1g and N-9 in both profiles |
| F2a | No narrowing | Killed: I-GRD-10c |
| F2b | Narrowing to a last green that is not a candidate (widening allowed) | **Survives** (finding A) |
| F2c | Narrowing to the *narrowest* key's last green | **Survives** (finding A; a probe shows a false culprit) |
| F2d | A key with no transition at the failing commit is skipped, not a veto | **Survives** (finding A) |
| F3a | Branch cap ignored | Killed: I-GRD-4 |
| F3b | Cap off by one (`<=`) | Killed: I-GRD-4 |
| F4a | No 60 s margin | Killed: I-GRD-8 |
| F4b | No re-send | Killed: I-GRD-8b, I-GRD-8c |
| F4c | No final settle | Killed: I-GRD-8c |
| F4d | One key for every attempt | Killed: I-GRD-8b, I-GRD-8c |
| F4e | An undecided final attempt settles as a culprit | Killed: I-GRD-8c |
| F4f | The final attempt is always `flaky`, even when still red | **Survives** (nit C) |
| F5 | The D17 pass commits, then reads the baselines | Killed: I-GRD-12c |
| F6 | Newest commit not kept by the prune | Killed: I-GRD-15, I-GRD-15b |
| F7a | No "red wins" across suites | Killed: I-GRD-17 |
| F7b | Check suite ignored | Killed: I-GRD-17 |
| N9 | Status links checked against the web root | Killed: I-GRD-11 |
| G1 | No `href` round-trip check | Killed: U-GCM-5 |
| G2 | No `%2e`/`%2f`/`%5c` check | Killed: U-GCM-5 |
| G3 | Parsed comparison replaced by the raw prefix | Survives. Benign: equivalent with G1's check in place. |
| X3, X4, X5, X9, X11 | Review 1's survivors | Killed: I-GRD-11, I-GRD-5, I-GRD-6, I-GRD-4, I-GRD-3 |

### Regressions

- **Report mode is still inert.**
  - The fixes add no GitHub write. The re-send is a queue job.
  - There is no `guard` feature client and no `phase1` route: N-8 passes in both profiles.
  - The only guard write is one comment (N-1g, I-GRD-13).
- **Steps 1–3 are still green**, and the full suite passes. The break-glass scenarios now run over the team policy, and the precondition asserts it.
- **PR #27 (step 3 fixes, migration `0012_audit_label_event`).** It merges cleanly with this branch, and the merged tree passes every test.
  - Its neutral-suite change adds the `sender` and the `removed` audit row. It applies to the scenario without the reopen block, and the precondition still holds there.
  - Its I-GRD-1 change steps down through `0012` before `0011`. This branch does not touch I-GRD-1, and no migration was added here, so there is no ordering question.
  - `decisions.md` §"Review 1 fixes", item 1, mentions "the reopen block of `57c1bae`" as gone. That stays true after the merge.
  - Nothing loses a guarantee. Whichever PR merges second should re-run `neutral.test.ts` and `guard.test.ts`, as I did.

## New findings

### A. minor: narrowing's safety conditions have no test, and one regression gives a false culprit

`narrowEvent` (`src/modules/guard/observe.ts:399-432`) narrows only under three conditions:
- every failing key still has a transition at the failing commit (`:415`);
- it narrows to the **widest** key's last green (`:416`);
- that commit must be one of the event's candidates (`:420`).

The first two are what keep narrowing from blaming a later PR for a key whose breakage may have come from an earlier one. I-GRD-10c has one key, so none of the three is pinned. F2b, F2c and F2d all survive.

**Probe.** History C1..C4, with PRs 7, 8 and 9 on C2, C3 and C4:
1. `test` and `lint` are green on C1 and running on C2.
2. Both are red on C3, so the event is [C2, C3], last green C1.
3. Then only `test` turns green on C2. `lint` on C2 has no result yet.

The current code correctly keeps [C2, C3], because `lint`'s last green is still C1. With F2c (narrowest), the event narrows to [C3] and `culprit_change_id` is set to PR 8, although `lint` may have broken at C2 (PR 7). Step 5 turns that into a revert of the wrong PR.

**Fix:** add I-GRD-10d with the probe above (two keys, only one parent turns green late), asserting no narrowing. Add one case where a key joined by D8 on a later commit vetoes narrowing (F2d), and one where the result at the last green is replaced, for example by a cancelled re-run, so that the widest green is older than `last_green_sha` (F2b). Then re-run F2b, F2c and F2d.

### B. minor: "red wins across check suites" depends on `filter=latest`, which the decision record says hides the red run

`readCheckRuns` still asks for `filter: "latest"` (`observe.ts:95`). The record of GitHub's API (`decisions.md:485`, T1 (b)) says that `filter=latest` "returns the most recent run per name and app". If that is right, a later green decoy run with the same name in another suite **replaces** the red one in the API answer. `readCheckRuns` then never sees both runs, and the hardening is dead code against real GitHub.

I-GRD-17 passes only because the fake ignores `filter` and returns every run (`test/helpers/fake-github-api.ts:427-450`). If GitHub's "latest" is per check suite instead, the hardening works, but then the record is wrong. The two documents cannot both be right, and no test or HUMAN-TODO item settles it.

The same rule also depends on a second unchecked fact: re-runs stay in their check suite. There is a trade-off to record as well. A fresh workflow run on the same SHA, for example a `workflow_dispatch` after a flaky failure, is now a different suite. Its green no longer makes the event `flaky`, so on a quiet repository the window confirms the culprit.

**Fix:**
- Request `filter: "all"`. The code already reduces to the latest run per suite (D4) and then lets red win across suites, so the result is right under either reading of `latest`. The 5 pages of 100 bound the extra re-runs.
- Make the fake honour `filter=latest` as recorded, so that a regression to `latest` fails I-GRD-17.
- Add to the step 4 sandbox item in HUMAN-TODO: two workflows with the same job name, one red and one green later; and a "Re-run failed jobs" that ends green and gives `flaky`.
- Record the `workflow_dispatch` trade-off in the trust-boundary section.

### C. nit: no test for D9 (b) at the final confirm attempt

The final attempt settles a still-red event as `culprit_found`, because rule 3 runs before the final branch (`observe.ts:457-461`). However, F4f (the final attempt is always `flaky`) survives: I-GRD-8b settles at attempt 1, and I-GRD-8c only ever ends undecided. **Fix:** extend I-GRD-8c. After the second re-send, a fresh re-run on N ends red again (newer `completed_at`), and attempt 2 must settle as `culprit_found` / `window` with one comment.

### D. nit: the "unconfirmed" `flaky` cannot be seen

`flaky` with `confirm_reason` null means "undecided at the last attempt", not "green again" (D9's `flaky`). Neither `graft guard list` nor `--json` (`src/modules/guard/cli.ts:58-90`) shows `confirm_reason`, so an operator cannot tell the two apart. Step 7's "post-merge breakages caught" metric would count these events as flaky, not as breakages. **Fix:** add `confirmReason` to the JSON, and print `flaky (unconfirmed)` in the text when the reason is null. Note in the step 7 spec that these events are neither caught breakages nor flakes.

### E. nit: a narrowed event keeps the older baseline's `guard.checks`

This is a recorded choice ("the key already passed it at the older baseline"), and it is the safer one, because the newer baseline is a candidate's own commit. However, it means the outcome depends on when CI finishes. If C2 (PR 7) removes `lint` from `guard.checks`, and C2's green arrives before C3 is observed, nothing opens. If it arrives after, the event narrows and blames PR 8 for `lint`. **Fix:** none needed now. Mention it next to D17 in `docs/features/guard.md`, so that step 5 knows a narrowed culprit was filtered at an older list.

### F. nit: the T1 (b) wording about `filter=latest` should be corrected with finding B

Whichever way the sandbox check answers, `decisions.md:485` must match what `readCheckRuns` relies on.

## Recommendation

**Merge PR #28.** Its required fix (finding 1) and the recommended fixes (2, 4, 5) are in, with tests that kill their mutations. The other minors (3, 6, 7, 8) and nits 9 and 10 are fixed. Report mode is unchanged, and PR #27 composes with it.

Before step 5 builds on `culprit_found`:
- add the narrowing tests of finding A, which are cheap and guard against a false culprit;
- settle finding B: `filter: "all"`, a fake that honours `filter=latest`, and the sandbox items.

Nits C to F can go in the same follow-up or in step 5's first commit. Whichever of PR #27 and PR #28 merges second should re-run `neutral.test.ts` and `guard.test.ts` on the merged `main`.
