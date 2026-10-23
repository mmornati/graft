# Step 5 review 1: Revert PRs and optional auto-merge

**Verdict: CHANGES REQUESTED**

Reviewer: senior engineer (Opus). Scope: the 2 commits `fd6e275` and `a46e200` on `claude/phase-1-step-5-revert-prs` (PR mmornati/graft#35), on top of `main` at `adad9a8`, reviewed on the local branch `claude/phase-1-step-5-review-1`: 56 files, +6452/−210. I judged them against `docs/phase-1/step-5-revert-prs.md` (binding: D1–D21 and the §19 deviations), the Phase 1 README, the earlier Phase 1 reviews, the Phase 0 constraints, and the "Phase 1 step 5: revert PRs" section of `docs/decisions.md`.

This review ran before the merge. "Required before approval" means required before PR #35 merges.

## Summary

This is a careful step:
- All 12 tasks are implemented, and every §16 test ID exists.
- I ran the definition of done myself, and it is green. So is the CI `check` job on PR #35.
- All 17 spec mutations are killed. So are 17 of the 28 extra mutations I added.
- The §19 deviations are sound, and I agree with each one.

The safety core holds:
- **Report mode stays inert.** In report mode `guard.revert` never builds a `guard` client: the only `forInstallation(…, { feature: "guard" })` is after the step 6 return (`revert.ts:913`). I-REV-2 and N-8 [default] show no non-GET request to `/git/`, `/pulls`, `/labels` or `/graphql`, and no gate question. I-REV-3 shows that a `guard` client in report mode is refused (`mode_report`) before anything is sent. Mutation S7 fails I-REV-2, I-REV-4, N-1g, N-2, N-3 and N-8.
- **The revert tree is right.** The tree is built from tree entries only (`git.getTree`, `git.getCommit`; no blob, content, compare or REST commit). `diffTrees` reads only differing subtrees. D7 compares entries at the tip, so a path changed and changed back is not a conflict. `sha: null` is used for added paths, and the old mode is restored. The commit's only parent is the tip that the plan was checked against.
- **Crash recovery works.** It resumes from the stored step: the commit, then the branch, the PR, the label and auto-merge. A 422 on the ref or the PR leads to a lookup by head, and a stale branch is deleted and recreated. I-REV-10 covers the three crash points, and mutations S10, X2 and X26 are killed.
- **Exactly once holds.** The claim, the cap, one revert per culprit and D21 all run under the repository lock. The partial unique index backs the one-per-culprit rule.
- **Auto-merge is gated as specified.** The policy is read at the baseline, never at the culprit. `sensitive`, break-glass, a missing card and a policy-file revert are refused, and a GitHub refusal never becomes a merge.
- **The PR body is injection-safe.** It is built from SHAs, numbers, code spans, validated logins and `#N` tasks. No culprit title, body, message or path reaches it.

Two findings block approval:
- **Required:** a `#` in a route string gets a `guard` client past all three §12 body rules. I sent `POST /pulls` with `head: main` and a ref outside `graft-revert/`, and both reached GitHub. The mutation guard is the step's proof layer, so this hole must close.
- **Required:** the D9 tree check is the safety net the T1 (b) deviation relies on, and no test exercises it. Mutation X1 removes it, and every test still passes.

The rest are a recommended test gap in D15 and the cap, one recommended robustness issue (a failed `guard.revert` cannot run again for 7 days), and minors and nits, listed below.

## What was checked

### Definition of done (spec §18), run by me

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Not re-run; `node_modules` matches the lockfile (no `package.json` or lockfile change in the PR) |
| `pnpm db:up` | Not run. I reused the shared container on `localhost:55432` and started or stopped no container. |
| `pnpm lint` | OK |
| `pnpm typecheck` | OK |
| `pnpm test` (`TEST_DATABASE_URL=…/graft_s5r1`, a fresh database) | OK: 101 files, **1178** tests passed |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0; every threshold passes, `matchBaseline: 1` |
| `pnpm graft policy schema --check` | OK |
| `pnpm graft e2e run --only-offline` | exit 0; 12 of 12 scenarios pass (s01–s10, b1, b2) |
| `db:migrate && db:status` (scratch DB `graft_s5r1_dod`) | `0001`..`0013` applied |
| `db:rollback && db:status && db:migrate` | Only `0013_guard_revert` rolled back (`pending`), then re-applied |
| `@ts-ignore` / `@ts-expect-error` grep | Clean |
| `src/guard/` import grep | Clean |
| Content-read grep (`getContent`, `getBlob`, `compareCommits`, `/contents/`, …) in `src/modules/guard/`, `src/guard/` | Clean |
| Merge and ref-update grep (`pulls.merge`, `updateRef`, `pulls.update`, `/merge`) | Clean |
| `feature: "guard"` outside `revert.ts` | Clean |
| Test ID grep | 70 lines |
| CI on PR #35 (`gh pr checks 35`) | `check` **pass** (5m0s), `build` pass; `deploy` and the Graft checks skipped |

I did not run the manual smoke test. It needs a dev server, a worker and `pnpm webhook:send`, and it is in HUMAN-TODO.

### Mutation checks (spec §18)

I applied each mutation alone with a script, ran the named test files against a scratch database (`graft_s5r1m`), then restored the file. `git status` was clean after the run.

| # | Mutation (how I applied it) | Result |
| --- | --- | --- |
| S1 | Revert for `flaky` with a null `confirm_reason`: the step 2 status gate, the D3 status and reason gates and the claim's status test removed | Killed: I-REV-7 |
| S2 | `confirmation_off` ignored | Killed: I-REV-8 |
| S3 | D7 skipped (the `touched_later` return removed) | Killed: U-RVP-6, I-REV-6 |
| S4 | Added file restored (`sha: (after).sha` in place of `null`) | Killed: U-RVP-2/3/4/11, I-REV-5, and 9 more I-REV |
| S5 | Old mode not restored (`after.mode`) | Killed: U-RVP-2, U-RVP-11 |
| S6 | Workflow files reverted (the D8 rule removed) | Killed: U-RVP-8 |
| S7 | Report mode goes on to the claim and the guard client (`if (false)` at `revert.ts:913`) | Killed: I-REV-2, I-REV-4, N-1g, N-2, N-3, N-8 |
| S8 | GraphQL body rule removed (any query) | Killed: U-MG-19 |
| S9 | Ref body rule removed | Killed: U-MG-20 |
| S10 | No lookup by head (`findPr` never finds) | Killed: I-REV-10 |
| S11 | One-per-culprit check removed (the index stays) | Killed: I-REV-11 |
| S12 | Cap ignored | Killed: I-REV-12 |
| S13 | Break-glass not checked for auto-merge | Killed: I-REV-14 |
| S14 | `auto_merge_reverts` read at the failing commit | Killed: I-REV-13, I-REV-14, I-REV-15, I-REV-17 |
| S15 | Narrowed baseline's `guard.checks` not applied | Killed: I-REV-15 |
| S16 | Revert-of-revert check removed (the job reads no branch name or trailer, so "detected by name" has no code to mutate) | Killed: I-REV-9 |
| S17 | `reverted` without the API: the open-state test removed, `merged = true` | Killed: I-REV-12, I-REV-18 |

### Extra mutations (mine)

| # | Mutation | Result |
| --- | --- | --- |
| X1 | **D9 tree check removed** (`revert.ts:504`) | **Survived** (finding 2) |
| X2 | Stale branch always reused (no tree or parent check) | Killed: I-REV-10 |
| X3 | D21 removed | Killed: I-REV-16 |
| X4 | **D15 response check removed** (`revert.ts:669`) | **Survived** (finding 3) |
| X5 | **"Already enabled" counted as `unavailable`** (`revert.ts:657`) | **Survived** (finding 3) |
| X6 | `sensitive` rule removed from eligibility | Killed: U-RVP-10 |
| X7 | `policy_file` rule removed from eligibility | Killed: U-RVP-10 |
| X8 | `touchesPolicyFile` always false in the plan | Killed: U-RVP-8c |
| X9 | A directory holding `.github/workflows` not caught | Killed: U-RVP-8 |
| X10 | `guard.track` does not mark a merged revert | Killed: I-REV-18 |
| X11 | Bot author passed to `mention()` instead of a code span | Survived: equivalent for `name[bot]` logins, which fail `MENTION_RE` anyway (nit 12) |
| X12 | Any login mentioned | Killed: U-RVT-2 |
| X13 | Any task value written live | Killed: U-RVT-3 |
| X14 | Label body rule removed | Killed: U-MG-20 |
| X15 | PR head body rule removed | Killed: U-MG-20 |
| X16 | GraphQL allowed for any feature | Killed: U-MG-18, U-MG-19 |
| X17 | **The cap does not count claimed runs without an outcome** (`store.ts` `countOpenReverts`) | **Survived** (finding 4) |
| X18 | D5 contiguity check removed | Killed: U-RVP-9, I-REV-19 |
| X19 | `diffTrees` without the `a === b` short-cut | Survived: equivalent (the walk only descends into differing entries; only equal root trees reach it) |
| X20 | `truncated: true` ignored in the diff | Survived (finding 8): U-RVP-8 truncates the head tree, which is also the tip, so the tip lookup catches it |
| X21 | Bad entry names accepted | Killed: U-RVP-8b |
| X22 | Card of any head of the change (no `head_sha` filter) | Survived (finding 8) |
| X23 | Auto-merge enabled even when not eligible | Killed: I-REV-5, I-REV-14 |
| X24 | A run resumed in report mode with an opened revert not marked `error mode_changed` | Survived (finding 6) |
| X25 | `storePr` ignores an adopted PR's closed or merged state | Survived (finding 8) |
| X26 | Commit parent not the tip | Killed: I-REV-5, I-REV-10 |
| X27 | A mutation guard refusal retried instead of `mode_changed` | Killed: I-REV-17 |
| X28 | `guard.revert_closed` without its `revert_opened` gate | Survived (finding 8) |

### Safety review

- **Who can write.** The only `guard` client is in `revert.ts`. It is made after the report-mode return and after the claim. Every guard write runs through `installMutationGuard`, and the gate re-reads `guard_mode` per request (`mutationGate`, `effective.ts:47`). Enforce needs `contents: write` (I-REV-4). The manifests match U-MAN-6: the full manifest has `contents: write`, the report manifest has nothing above `read` except Phase 0's writes, and neither has `workflows`.
- **Routes.** The table matches §12. `PUT …/merge`, `PATCH …/git/refs`, `PATCH …/pulls` and `POST …/git/blobs` are unknown. The GHES GraphQL URL is handled. GraphQL is only the constant document with only `query` and `variables`. Two gaps: the body rules miss a fragment (finding 1), and the GraphQL rule cannot bind the PR to the gated repository (finding 7).
- **The tree.** `badName` keeps `/`, `.` and `..` names out of tree writes. A submodule, a type change, a workflow path and a directory containing `.github/workflows` are refused before any write. A whole added or deleted directory is one change. The read budget is enforced in the plan (`budgetedReader`) and in the API reader (twice the budget plus 10, for the D9 read-back).
- **Locks.** No GitHub call runs inside the repository lock (the claim is database only) or inside the change lock in the new code (`storePr`). The comment keeps step 4's lock pattern.
- **Text.** The PR body escapes every untrusted value: check names and the branch are code spans, mentions only `MENTION_RE` logins, a task is live only as `#\d{1,9}`, and the session URL is re-checked for shape. Conflict paths appear only in the guard comment, as code spans of at most 200 characters, and at most 20 of them. I tried backticks, `<!--`, newlines, `@team` and `[x](y)` through `codeSpan`: none escaped. The body is far below 4,000 characters in the worst case (5 names × 80, a 128-character task, a 500-character URL).
- **Storage and logs.** Only counts, SHAs, a branch name, PR numbers and reason codes are stored. Logs carry event ids, counts, outcomes, PR numbers and GraphQL error *types*, never paths, titles or bodies. `revert_reason` and `auto_merge_reason` are at most 40 characters (CHECK), and `errorClass` slices to 40.
- **Lifecycle.** The webhook is a hint only. `guard.revert_closed` reads `pulls.get`, and `guard.track` marks `reverted` from the API mapping. A closed revert releases its cap slot (I-REV-12).

### Developer-reported deviations (§19 and decisions.md)

- **I-REV-20 allows `GET …/contents/graft.yaml`.** Agreed: this is Graft's own policy file, read by the existing loader. Nothing else under `/contents/` appears in the log.
- **Markdown helpers in `src/core/markdown.ts`.** Agreed: no behaviour change, and the re-export keeps every import.
- **`autoMergeEligibility` returns the risk.** Agreed.
- **N-1, N-1g, N-2b and N-5 restated for `max`.** Agreed. N-8 [max] still proves that every `phase1` request was a gate-allowed guard request, and N-12 counts exactly one of each write.
- **T1 (b), no directory expansion.** Agreed *as a decision*, because the D9 check fails closed (`tree_mismatch`, no commit). The decision is only as good as that check, and nothing tests it (finding 2). Adding a new directory is the most common shape of an agent PR, so if GitHub does not apply `sha: null` to a tree, every such revert in the pilot ends as `error`. The HUMAN-TODO item must be done before a pilot repository enforces.
- **Choices where the spec is silent.** I checked each one against the code. "`already_reverted` before conflicts", "cap counts claimed runs", "an adopted closed PR gets its final state", "a run resumed in report mode records `mode_changed`" and "the branch deletion uses a literal path" all match. The last three have no test (findings 4, 6 and 8).

## Findings

### 1. required: a `#` in the route string skips the §12 body rules

`classifyWrite` strips a fragment before it matches a route (`mutation-guard.ts`, "`const hash = path.indexOf("#")`"). `guardBodyAllowed` strips only the query (`:261`). So `POST /repos/o/r/git/refs#` classifies as the guard's `POST …/git/refs` route, but its body rule's `…/git/refs$` regex does not match, and the function falls through to `return true`. Octokit keeps the `#` in the URL, and `fetch` drops the fragment, so GitHub receives the plain route with the unchecked body.

**Probe** (a scratch unit test with the fake API and an allow-all gate, `guard` client):

```ts
guard.request("POST /repos/{owner}/{repo}/git/refs#", { owner, repo, ref: "refs/heads/main2", sha });
guard.request("POST /repos/{owner}/{repo}/pulls#", { owner, repo, head: "main", base: "main", title: "t" });
guard.request("POST /repos/{owner}/{repo}/issues/{n}/labels#", { owner, repo, n: 3, labels: ["bug"] });
```

All three were **sent**. The fake logged `POST …/git/refs`, `POST …/pulls` (201, a PR from `main`) and `POST …/issues/3/labels`. The same ref call without the `#` is refused with `feature_not_allowed`. No Graft code sends a fragment today. But §12 says "Anything else is refused", and the mutation guard is what the spec calls the proof. A future call site (step 6's `mcp` pulls will reuse this function) or a templated value ending in `#` would pass silently.

**Fix:**
- Normalise the path once, with the same rules as `classifyWrite` (query, fragment, trailing slash), and pass the normalised path to `guardBodyAllowed` and `checkRunWrite`.
- Better, refuse any write whose URL contains `#` at all (`unknown_route`), as `%` and `\` already are.
- Make `guardBodyAllowed` fail closed: return `false` for a guard route it does not recognise, not `true`, and list the three bodiless routes (trees, commits, the ref deletion) explicitly.
- Add the `#` and `#x` variants of the three routes to U-MG-20, and a `#` case to U-MG-2.

### 2. required: the D9 tree check has no test, and the T1 (b) deviation relies on it

After `POST …/git/trees`, `openRevert` reads the new tree back and requires every change path to equal `before` (`revert.ts:504-514`). The §19 deviation keeps `sha: null` on a directory entry *because* this check "would catch a `sha: null` that GitHub does not apply to a directory". But the fake (`test/helpers/git-trees.ts:101`) deletes any entry, so the check never fails in a test.

**Probe:** mutation X1 (`if (false)` in place of the check) passes every test in `guard-revert.test.ts`, `guard-revert-plan.test.ts` and `neutral.test.ts`.

**Fix:**
- Give the fake tree writer a switch that ignores `sha: null` for `type: tree` entries, as GitHub might.
- Add a case to I-REV-5 (or a new I-REV-5b): a culprit that adds a whole directory, with the switch on. It must give `error` / `tree_mismatch`, no `POST …/git/commits`, no ref and no PR, and the comment must read "Graft could not open the revert (tree_mismatch)".
- Add a second case where the written tree changes a path that is not in the plan. The check must catch that too, or the docs must say that it only checks plan paths.
- X1 must then fail.

### 3. recommended: D15's response check and "already enabled" have no test

D15 says a GraphQL answer for another PR is `error` / `auto_merge_mismatch`, and "already enabled" counts as `enabled`. I-REV-13 covers success, and I-REV-14 covers one GraphQL error (`unavailable`).

**Probe:** X4 (the `nameWithOwner`/`number` comparison removed) and X5 ("already enabled" mapped to `unavailable`) both survive.

**Fix:** extend the fake's GraphQL handler so it can answer with another PR's number or another repository, and with an "already enabled" error. Add both cases to I-REV-13 or I-REV-14: the first gives `error auto_merge_mismatch`, the second `auto_merge_state = enabled`.

### 4. recommended: a `guard.revert` that fails outright cannot run again for 7 days, and a stuck claim holds a cap slot

`scheduleRevert` uses a singleton key, and `src/queue/queue.ts` turns it into a deterministic job id. While the job row exists (7 days after completion or failure), every later `send` returns `null`. The `failed()` path settles `error` for failures in steps 5–9. But a throw elsewhere fails the job with the event untouched:
- the installation token at step 3 (`toJobError`, `revert.ts:765`);
- `getEffectiveModes` or the first `updateEvent`;
- the claim transaction;
- `comment()` itself;
- a worker killed during the last attempt.

The retries span about 70 seconds (10 s with backoff). Then:
- **No comment for 7 days.** Before this step, `observeCommit` called `publishGuardComment` for every event awaiting a comment on every observe. Now it only re-sends a job that is deduplicated away.
- **A late revert.** After 7 days the row is deleted, and the next observe enqueues the event again. In enforce mode the job then plans a week-old culprit. D7 and D21 usually stop it, but not on a quiet repository.
- **A stuck slot.** If the failure comes after the claim, the event keeps `revert_claimed_at` with no outcome. `countOpenReverts` and `otherRevertOfCulprit` count it, so it holds a cap slot and blocks any other event of the same culprit. Doctor does not show it: `guard_reverts_open` counts only `revert_opened`.

The cap's "claimed, no outcome" branch, which is what makes concurrent claims safe at the last slot, also has no test (X17 survives).

**Probe:** run I-REV-10's first case with `retryLimit: 0` and a `forInstallation` that throws, then call `scheduleRevert` again. It returns `null`, and the event stays `culprit_found` with no outcome and no comment.

**Fix:**
- In `guardRevertJob.handle`, catch every error on the last attempt (`!canRetry(ctx)`). Settle `error` with its class when there is no outcome yet, and try the comment once. Alternatively, key the job so that a failed run can be sent again, for example with a short `singletonSeconds` window in place of the 7-day deterministic id.
- Add a `skipped` / `stale` outcome for events detected more than a bounded time ago (say 24 hours, configurable), so a revert never opens days late.
- Add a doctor `warn` for events claimed more than an hour ago with no outcome.
- Add a cap case to I-REV-12: two events at the last slot, the first claimed with no outcome. The second must give `cap_reached`, and X17 must then fail.

### 5. minor: every mutation guard refusal is recorded as `mode_changed`

`failed()` maps any `MutationRefusedError` to `error` / `mode_changed` with no retry (`revert.ts:796`). A refusal can also be `repository_unknown` (the repository was deactivated mid-job), `feature_not_allowed (body)` or `unknown_route`, and the last two mean a Graft bug. The operator then sees "the mode was rolled back" for a defect.

**Fix:** store `mode_changed` only for `mode_report` (and `mode_off`). Store any other refusal as `refused_<reason>`, cut to 40 characters. Add a case to U-RVT-4 or I-REV-17.

### 6. minor: a run resumed in report mode after a write began does not look for the PR

The case: run 1 in enforce stores `revert_branch` (or opens the PR and crashes before `storePr`), then the repository is rolled back to report, and the retry reads `report`. With `revert_outcome` null, the job records `planned` and the comment says "Graft would open a pull request". But a branch, and maybe an open PR, exist on GitHub, unknown to the cap, to D18 and to D17 e. The opposite case, an opened revert resumed in report mode (`error mode_changed`, `revert.ts:916`), has no test (X24 survives).

**Fix:** in report mode, when `revert_branch` or `revert_commit_sha` is set, look the PR up by head with the *default* client (a GET). Adopt it if found (`storePr`, then `error mode_changed`), else record `error mode_changed`, never `planned`. Add both cases to I-REV-17.

### 7. minor: the GraphQL rule gates the repository named in `clientMutationId`, not the PR's

`guardGraphqlTarget` takes the owner and repository for the gate from `clientMutationId`. `pullRequestId` is an opaque node id that the mutation guard cannot tie to a repository. A `guard` client could therefore enable auto-merge on any PR the installation can see, including a human PR in a report-mode repository, as long as the id names an enforce repository. The spec chose this rule, and the job only sends its own PR's node id. Still, for the one write that can make a merge happen without a human, the proof is weaker than for the REST routes.

**Fix (pick one, record it):**
- The guard client remembers the `node_id`s from its own `POST …/pulls` responses (an `after` hook), plus the ones read with `GET …/pulls` on recovery, and the GraphQL rule requires `variables.pullRequestId` to be one of them.
- Alternatively, keep the rule and say in `docs/features/guard.md` and decisions.md that the GraphQL gate trusts the job for the PR binding.

### 8. minor: five rules have no test

| Rule | Mutation | Test to add |
| --- | --- | --- |
| The card is the one at the merged head (`revert.ts:337`) | X22 survives | I-REV-14: a `logic` card at an earlier head and none at the merged head must give `card_missing` |
| An adopted PR that is already closed gets `reverted` / `revert_closed` (`revert.ts:392`) | X25 survives | I-REV-10: close the PR before the retry, so the event ends `revert_closed`, not `revert_opened` (and not counted by the cap) |
| `guard.revert_closed` changes only a `revert_opened` event | X28 survives | I-REV-18: a `reverted` event and a late `closed` webhook must stay `reverted` |
| `truncated: true` in the diff, not only at the tip | X20 survives | U-RVP-8: truncate the base tree with a tip that differs from the head |
| The update in `revert-closed.ts:67` is not conditional | – | Make it `… where status = 'revert_opened'`, as `markReverted` is, so a concurrent `guard.track` and the webhook job cannot overwrite each other. A reopened revert PR stays `revert_closed` and is never counted again; record that, or handle `pull_request.reopened`. |

### 9. nit: two guard routes are wider than they need to be

- `POST …/pulls` from a `guard` client checks `head` but not `base`, so a revert PR could target any branch. Require `base` to be a plain branch name (`[A-Za-z0-9._/-]{1,255}`, no `:`), or record that the job's `repos.get` default branch is trusted.
- The `DELETE` route accepts any `graft-revert/[A-Za-z0-9_./-]+` (`mutation-guard.ts:138`), so it could delete a branch that a human named `graft-revert/…`. Use the same `[0-9a-f-]{36}` as the ref rule.

### 10. nit: the baseline falls back to the failing commit

`baselineAt(octokit, data, event.last_green_sha ?? event.failing_sha)` (`revert.ts:319`). `last_green_sha` is always set on a `culprit_found` event today (`detect.ts` types it `string`), so the fallback is dead code. If it ever ran, it would read `auto_merge_reverts` at a commit that the culprit controls, which is exactly what D16 forbids. Fail closed instead: with no baseline, use `{ checks: null, autoMerge: "not_configured" }`.

### 11. nit: a comment written after a mode change mixes the two modes

`comment()` renders the stored outcome with the mode read by *this* run. A `planned` event whose comment failed is commented on later, after the repository moved to enforce. It reads "Graft would open a pull request…" followed by "Graft mode: enforce." Render the stored `guard_mode` of the run that decided the outcome, or the report line for `planned`.

### 12. nit: U-RVT-2's bot case cannot tell a code span from a mention

X11 survives, because `renovate[bot]` fails `MENTION_RE` either way. Add a `Bot` author whose login matches the regex (for example `ci-helper`, `type: "Bot"`), and expect a code span and no `@ci-helper`.

## Required before approval

1. Finding 1: one normalised path for every body rule, `#` refused, `guardBodyAllowed` fail-closed, and U-MG cases for `#`.
2. Finding 2: a fake mode where `sha: null` does not delete a directory, and an I-REV case that ends `error tree_mismatch` with no commit, ref or PR. X1 must fail.

Recommended in the same fix PR: findings 3 and 4. Findings 5–8 should land before a pilot repository runs the guard in enforce mode. The nits can go with them or be recorded.

## Recommendation

Do not merge PR #35 yet. Apply findings 1 and 2, preferably with 3 and 4, in a fix commit on `claude/phase-1-step-5-revert-prs`, re-run the definition of done, then run review 2. Report mode is inert, and every spec mutation is killed, so the risk of this PR as it stands is confined to enforce mode. Even there, finding 1 needs a Graft bug to be reached. But step 5 is the first step that creates branches, commits and PRs, and the mutation guard is the documented proof that only the §12 writes can happen. That proof must have no hole before the code merges. Before the first enforcing pilot repository, the T1 HUMAN-TODO checks (above all `sha: null` on a directory) must be done on real GitHub.
