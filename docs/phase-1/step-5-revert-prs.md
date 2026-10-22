# Phase 1, Step 5: Revert PRs and optional auto-merge

Spec for the developer agent. Implement exactly this. Where it is silent, choose the simplest option and record it in [docs/decisions.md](../decisions.md) under a new heading "Phase 1 step 5: revert PRs". The [Phase 0 constraints](../phase-0/README.md#constraints-for-every-step) are binding: offline build and test, Postgres from `docker compose`, **no stored code, diffs, logs or file contents**, pnpm, Node 24, strict TypeScript. The code as it is after step 4 is described in [docs/architecture.md](../architecture.md) (including the modes contract and the "Guard contract (Phase 1 step 4)" section) and [docs/decisions.md](../decisions.md) ("Phase 1 step 4: guard detection", with its review 1 and review 2 fixes). Where this spec and those documents disagree on an existing interface, they win and you record the difference. The plan for the whole phase is [phase-1/README.md](README.md). The previous step is [step-4-guard-detection.md](step-4-guard-detection.md).

This step depends on steps 1, 3 and 4, which are all merged.

Binding rules from earlier steps:
- **Payloads are triggers** ([architecture.md](../architecture.md#webhook-replay)). Trees, commits, refs, the culprit PR, its merged head and the repository settings are read from the API inside jobs. A payload field may only decide *whether* to enqueue.
- **Lock discipline**: no slow work inside `withChangeLock` or the repository advisory lock. The order is the step 4 one: the repository lock, then the change lock, never both at once.
- **Spec fix 3**: the culprit comes from CI results that already exist. Graft never re-runs a check and never bisects. A revert is a pull request, never a push to the default branch and never a merge by Graft.
- **Report mode stays inert.** With default modes, the guard's only GitHub write is still the one comment per guard event (step 4, D10). Every write this step adds goes through a `guard` feature client and the mutation guard, and is refused unless the effective `guard_mode` is `enforce`.
- **Missing permissions fall back to report, never to "allow"** (README §1). Without `contents: write`, `guard_mode` is effectively `report` and the guard comment says why.
- **Graft does not read code.** The revert is built from tree entries (path, mode, type, blob SHA) through the Git Data API. No blob, file content, patch or diff is fetched, logged or stored.

## 1. Goal

Turn a confirmed culprit into a revert pull request, and nothing more:

- **When.** A guard event reaches `culprit_found` with a real confirmation (`next_commit` or `window`). Nothing else ever leads to a revert: not `ambiguous`, not `no_culprit`, not `flaky` (with or without a reason, so never `flaky (unconfirmed)`), not `confirming`, not an event settled with confirmation off (D3).
- **Plan, in every mode.** Graft computes the revert plan from tree entries: the paths the culprit PR changed, the entry each had before it, and whether any of them changed again on the default branch since (D5–D8). Report mode shows the plan in the guard comment ("Graft would open a revert restoring 4 files"). It costs only GET requests.
- **Open, in enforce mode only.** With `guard_mode` effectively `enforce` (which needs `contents: write`), Graft creates one tree, one commit, one branch `graft-revert/<event id>` and one pull request against the default branch, then labels it `graft:revert` (D9–D13).
- **Needs a human.** If any changed path was touched again on the default branch, or the change is one Graft does not revert (workflow files, submodules, a file that became a directory, more than the size bounds), Graft opens nothing. The event becomes `needs_human` and the comment lists the conflicting paths (D7, D8).
- **Tell people.** The revert PR has a fixed title and body with `Graft-Agent: graft-guard` trailers. It mentions the culprit's author (or the user who merged it, for a bot author) and links the agent's task from provenance (D11). The guard comment on the culprit PR says what happened.
- **Auto-merge, opt-in.** If `graft.yaml` at the baseline lists the culprit's risk class in `guard.auto_merge_reverts`, Graft enables GitHub auto-merge on the revert PR, so branch protection and required checks still decide. Never for `sensitive`, never for a culprit merged under break-glass (D14–D16).
- **Exactly once.** One revert per guard event and at most one per culprit PR, whatever the redeliveries, retries and crashes (D17).

## 2. Out of scope

Do not create stub code for any of these.

- Merging anything directly (`PUT /pulls/{n}/merge`), pushing to the default branch, updating a ref (`PATCH /git/refs`), force-pushing, or closing a pull request. None of these routes is added to the mutation guard.
- Reverting an `ambiguous` event's candidates, or picking one of them (Phase 2 ranking, spec fix 2).
- Conflict resolution of any kind: no three-way merge, no rebase of the revert, no reading of file content to merge it.
- Reverting a revert. If a revert PR breaks the default branch, the event is reported, never reverted (D4).
- Deleting `graft-revert/*` branches after merge or close. GitHub's "Automatically delete head branches" setting does that. The one `DELETE` this step uses is the crash recovery of D17.
- Requesting reviewers, assigning, or commenting on the revert PR beyond its body.
- Break-glass for the guard (stopping a revert with a label). A human closes the revert PR.
- New GitHub permissions other than `contents: write` in the full manifest. In particular, **no `workflows` permission** (D8).
- Merge queues (`merge_group`), as in step 4.
- Guard metrics in `gate report` (step 7). This step stores what step 7 needs.

## 3. Decisions

| # | Area | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | Trigger | When `confirmOpenEvents` settles an event as `culprit_found`, the observe job no longer calls `publishGuardComment` for it. It enqueues `guard.revert { installationId, repositoryId, owner, repo, eventId }` (singleton `guard:revert:<eventId>`) after the repository lock is released. `guard.revert` publishes the guard comment as its last step, in every mode. Events awaiting a comment from before this step (`eventsAwaitingComment`) are handed to `guard.revert` too. | One path for every mode keeps "one comment per event". The plan is in the comment, so the comment must wait for it. |
| D2 | Mode gate | The job reads `getEffectiveModes` once at its start and stores `guard_mode` on the event (the step 4 column). `report` → plan, comment, stop. `enforce` → plan, open, comment. The mutation guard reads the mode again at every write (step 1, D12), so a rollback between the read and a write refuses that write (§7, step 9). When `guard_mode` is requested `enforce` but effective `report`, the comment's mode line gives the reason from the mode state (`ceiling`, `permission_missing contents:write`, `installation_inactive`, …). | README §1: "behaves as report and says why". The job's read is a fast path; the mutation guard is the proof. |
| D3 | Revertible event | The job does nothing but the comment unless, re-read inside the change lock at the start of the job: `status = 'culprit_found'`, `confirm_reason IN ('next_commit','window')`, `culprit_change_id IS NOT NULL` and `revert_outcome IS NULL`. `confirm_reason = 'off'` (`GRAFT_GUARD_CONFIRM=off`) gives outcome `skipped` / `confirmation_off`. Any other status gives no job work at all, and `flaky` with a null `confirm_reason` ("flaky (unconfirmed)", step 4 review 2, nit D) is explicitly one of them. | A single red result on a busy `main` must not revert a PR. Confirmation off is an operator's choice for detection, not for reverts. |
| D4 | Never revert a revert | If the culprit PR is the `revert_pr_number` of any guard event of the same repository, outcome `skipped` / `revert_of_revert`. The test is the database row, never the branch name, label or `Graft-Agent` trailer, which anyone can copy. | A revert that breaks `main` needs a human. Trailers are untrusted (step 2). |
| D5 | Culprit range | The culprit's commits are the `main_commits` rows with `change_id = culprit_change_id` (or `pr_number` = its number when `change_id` is null). They must be contiguous in `seq`, with no `chain_break` after the first of them up to the default branch tip. **base** = the first one's `parent_sha`; **head** = the last one. A squash or merge commit is one row; a rebase merge is several. Anything else → `needs_human` / `history_incomplete`. | Generalises "the merge commit's first parent" to rebase merges, with the same chain rules as detection (step 4, D5, D7). |
| D6 | Tree diff | Trees are read with `GET /repos/{o}/{r}/git/trees/{sha}` (non-recursive) and commits with `GET /repos/{o}/{r}/git/commits/{sha}` (for the tree SHA and parents). `diffTrees(base.tree, head.tree)` descends only into subtrees whose SHAs differ and returns one change per path: `{ path, before: Entry \| null, after: Entry \| null }`, with `Entry = { mode, type, sha }`. A whole added or deleted directory is one change on the directory entry. A response with `truncated: true` → `needs_human` / `too_large`. | Only the Git Data API's tree and commit objects. They hold names, modes and SHAs, never content. Equal SHAs prove equal subtrees, so the walk is bounded by what changed. |
| D7 | Touched later | The default branch tip is read from the API (`GET …/git/ref/heads/<default>`, then its commit's tree). For each change, the entry at the tip must equal `after` (same mode, type and SHA, or absent in both). Every path where it does not is a **conflict**. Any conflict → `needs_human` / `touched_later`, with the conflicting paths in the comment (at most 20, then `and N more`). If **every** change's tip entry equals `before` instead, outcome `skipped` / `already_reverted`. Entry equality, not "a later commit touched the path": a path changed and changed back is not a conflict. | The README's rule, made exact. Equal entries mean restoring `before` at the tip gives exactly the pre-culprit content of those paths, which is all a clean revert is. |
| D8 | Not reverted by Graft | Before any write, `needs_human` with a reason when: a change is under `.github/workflows/` (`workflow_files`: creating such a commit needs the `workflows` permission, which Graft does not request); a change's `before` or `after` has type `commit` (mode `160000`, `submodule`); a path is a blob on one side and a tree on the other (`type_change`); the diff has more than `GRAFT_GUARD_REVERT_MAX_PATHS` changes (default 300) or needed more than `GRAFT_GUARD_REVERT_MAX_TREE_READS` tree reads (default 200) (`too_large`). | Each is either impossible without a new permission or a case the tree API makes easy to get wrong. A human handles the rare case. |
| D9 | Revert tree | `POST …/git/trees` with `base_tree` = the tip's tree and one entry per change: `before` present → `{ path, mode: before.mode, type: before.type, sha: before.sha }`; `before` absent (the culprit added it) → `{ path, mode: after.mode, type: after.type, sha: null }`. Before the commit, the job verifies the new tree: for every change path, its entry in the new tree equals `before` (absent when `before` is null), reusing the tree reader's cache. A mismatch → outcome `error` / `tree_mismatch`, no commit. | Blob and tree SHAs pass through; no content moves. The check catches a misread of the tree API (for example how `sha: null` treats a directory, T1) before anything is visible. |
| D10 | Commit and branch | `POST …/git/commits` with the fixed message (§8), `tree` = the new tree and `parents` = [tip]. No `author` or `committer`: GitHub sets the App's bot identity. Then `POST …/git/refs` with `ref: refs/heads/graft-revert/<eventId>`. The branch name is a function of the event only. | Deterministic names are what make D17's recovery possible. |
| D11 | Revert PR | `POST …/pulls` with `head: graft-revert/<eventId>`, `base: <default branch>`, `draft: false`, `maintainer_can_modify: false`, and the fixed title and body of §8. Then `POST …/issues/{n}/labels` with `["graft:revert"]`. Mentions: the culprit's author as `@login` when the API's `user.type` is `User`. For a `Bot` author, the user in `merged_by` instead (when `User`). A login is mentioned only if it matches `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`. Task link: from `change_provenance` at the culprit's merged head. A `task_external_id` of the form `#<digits>` is written as `#N` (a same-repository reference GitHub links). Any other task value is a code span. A `session_url` (already validated by step 2) is a link named "agent session". | README step 5. The author is told on the PR that undoes their work. Provenance is untrusted text, so it is validated and quoted, and only `#N` becomes a live reference. |
| D12 | Who sees what | The guard comment on the culprit PR keeps step 4's rule: no `@` outside code spans. The only mentions are in the revert PR body (D11). | Notifications go to one place, once. |
| D13 | Open-revert cap | At most `GRAFT_GUARD_MAX_OPEN_REVERTS` (1–10, default 3) events per repository in `revert_opened`. At the cap → outcome `skipped` / `cap_reached`, comment says so. The count is read under the repository advisory lock, together with the claim of D17. | A runaway (a framing workflow, §4, or a guard bug) opens at most a few PRs, never one per commit. |
| D14 | Auto-merge eligibility | Enabled only when every one of these holds; the first that fails is stored as `auto_merge_reason`: the PR was opened in this run or an earlier one (`opened`); `guard.auto_merge_reverts` is present in `graft.yaml` at the event's `last_green_sha`, and that policy is valid (`not_configured`, `policy_invalid`); the culprit's card at its merged head has `status = 'ok'` (`card_missing`) and its `risk_class` is in the list (`risk_not_listed`); `risk_class` is not `sensitive` (`sensitive`, checked even though the parser refuses it); `mergedUnderBreakGlass(db, culpritChangeId, mergedHeadSha)` is false, with `mergedHeadSha` from `pulls.get` of the culprit (`break_glass`); no change path is the policy file (`policy_file`); the repository's `allow_auto_merge` from `repos.get` is true (`repo_setting_off`). | README step 5, plus the cases where an automatic merge would change who decides: a policy revert, a missing card, a setting GitHub would refuse anyway. |
| D15 | Auto-merge call | GraphQL `enablePullRequestAutoMerge` with the PR's `node_id` from the `pulls.create` response (or from `pulls.get` on recovery), `mergeMethod` the first of `SQUASH`, `MERGE`, `REBASE` that `repos.get` allows, and `clientMutationId: "graft-guard:<owner>/<repo>#<number>"`. The response's `pullRequest { number repository { nameWithOwner } }` must match, otherwise `error` / `auto_merge_mismatch`. GitHub errors (auto-merge not allowed, PR already in clean status, no required checks) → `auto_merge_state = 'unavailable'` with the GraphQL error type in the log, never a direct merge. "Already enabled" counts as `enabled`. | Auto-merge leaves the decision to branch protection. A PR GitHub would merge immediately is a reason to leave it to a human, not to merge it ourselves. |
| D16 | Policy source | `guard.auto_merge_reverts` and `guard.checks` for the revert are read with the existing loader (`guardChecksAt`, cached per commit) at the event's **current** `last_green_sha`. | The baseline is before the culprit, so the culprit cannot opt its own revert into auto-merge. After narrowing, the baseline is a commit of an earlier PR, still not the culprit's. |
| D17 | Idempotency | (a) **Claim.** Under the repository lock: re-read the event (D3), check the cap (D13), set `revert_claimed_at`. The singleton key plus pg-boss's one active job per key mean no two runs of the same event overlap. (b) **Resume.** Each step stores its result before the next: `revert_commit_sha`, then `revert_branch`, then `revert_pr_number`, then `labelled`, then `auto_merge_state`, then the comment. A retry starts at the first step not stored. (c) **Crash between ref and PR.** If `POST …/git/refs` answers 422 (exists), the job lists `GET …/pulls?head=<owner>:graft-revert/<eventId>&state=all`. A PR found → adopted. None → the job re-plans. If the existing branch's commit has the planned tree and the tip as parent, it is reused; otherwise the job deletes the branch (`DELETE …/git/refs/heads/graft-revert/<eventId>`, the only route that allows it) and recreates it. (d) **Crash after the PR.** `POST …/pulls` answering 422 ("already exists"), or a missing `revert_pr_number` with a branch present, → the same list and adopt. (e) **One per culprit.** A unique partial index on `(repository_id, culprit_change_id) WHERE revert_pr_number IS NOT NULL` makes a second revert of the same PR (a later event with the same culprit) fail to store. The job checks first and records `skipped` / `already_opened` instead. (f) **Redelivery.** A replayed `check_run`, `status` or `push` cannot enqueue `guard.revert`: only the transition to `culprit_found` does (D1), and a settled event never transitions again. | Every write has either a deterministic name or a lookup that finds the earlier attempt. Orphaned tree and commit objects from a crash are harmless and unreachable. |
| D18 | Revert lifecycle | New `pull_request.closed` handling: when the closed PR's head ref starts with `graft-revert/` (payload hint only), enqueue `guard.revert_closed { repositoryId, prNumber }`. The job finds the event by `revert_pr_number` (none → stop), reads the PR with `pulls.get`, and sets `reverted` if `merged`, otherwise `revert_closed`. `guard.track` does the same when it maps a new default-branch commit to a revert PR (D6 of step 4), so a missed webhook is caught by the next push. | The cap (D13) counts open reverts, so a closed one must release its slot. The API decides, never the payload. |
| D19 | Kill switch | `GRAFT_GUARD_REVERT` (`on`/`off`, default `on`). Off: `guard.revert` publishes the step 4 comment (no plan, report wording) and records outcome `skipped` / `revert_off`. Detection is unaffected. `GRAFT_GUARD_DETECTION=off` stops everything, as before. | An operator can stop reverts without touching modes or detection. |
| D20 | Narrowed events and `guard.checks` | Step 4 checks a narrowed event's keys against `guard.checks` at the **original** baseline only (step 4 review 2, finding E). Before a revert, the job checks the event's failing keys against `guard.checks` at the **current** `last_green_sha` too (D16), and drops keys that fail it. If none is left, outcome `skipped` / `filtered_at_baseline`. For an event that never narrowed, the two baselines are the same commit, so nothing changes. | A revert then needs the key to be in scope at both baselines, so the outcome no longer depends on whether the parent's CI finished before or after the child was observed. Neither baseline is the culprit's own commit. |
| D21 | Already green | Before opening (not before planning), if any tracked commit after the failing commit, up to the tip, has every remaining failing key `green`, outcome `skipped` / `already_green`. | Someone fixed forward. A revert would now undo a working state. |

## 4. Trust boundary

Step 4 left one question to this step (`docs/features/guard.md`, "The trust boundary"): a merged pull request controls the CI that judges it. A workflow on the default branch, running with the default token, can write check runs and statuses on other commits. In step 4 that can only hide a failure. Once a culprit becomes a revert, it could also **frame** a PR: post a red result on the commit after an innocent merge, a green one on the commit before, and the innocent PR gets a revert PR.

What bounds it in this step:
- **A revert is a pull request.** Nothing lands without branch protection, required checks and (for a sensitive culprit, a break-glass merge, a missing card or a policy file) a human merge. A framed revert is visible, labelled, mentions the author and can be closed.
- **Confirmation is required** (D3). One forged red is not enough: it must persist across the next commit or the window.
- **The cap** (D13) and **one revert per culprit** (D17 e) bound a repeated framing to a few PRs.
- **The baseline decides scope and auto-merge** (D16, D20). The culprit cannot widen `guard.checks`, nor opt its revert into auto-merge.
- **Auto-merge is opt-in per risk class** and off for `sensitive`, so a team that fears framing leaves `auto_merge_reverts` unset.

What it does not bound, recorded as residual risk in `docs/features/guard.md`: a framing workflow already merged on the default branch can get a `trivial` or `logic` PR's revert auto-merged where a team opted in, if the revert's own required checks pass. The fix is to revert the revert by hand. A workflow that can write results on `main` is already a merged, reviewed change, and the step 7 security review re-reads this section.

Two more limits, both inherent to reverts and not specific to Graft:
- A later commit that depends on the culprit (it calls a function the culprit added, in a file the culprit did not touch) is not a D7 conflict. The revert PR's own CI is what catches it.
- If the default branch moves between the tip read and the PR, GitHub's three-way merge decides. A conflict shows on the PR, and auto-merge waits for it.

## 5. Files

New:

| File | What |
| --- | --- |
| `src/guard/revert-plan.ts` | Pure: `diffTrees()`, `planRevert()`, `revertTreeEntries()`, `autoMergeEligibility()` (§6). It takes a `TreeReader` interface. No `db`, `github` or `modules` imports. |
| `src/guard/revert-text.ts` | Pure: the commit message, PR title and body (§8), and the comment's revert section (§10). |
| `src/modules/guard/revert.ts` | `guard.revert` job (§7): plan, claim, write, comment. |
| `src/modules/guard/revert-closed.ts` | `guard.revert_closed` job and its `pull_request.closed` handler (D18). |
| `src/modules/guard/trees.ts` | The API-backed `TreeReader`: `git.getTree` and `git.getCommit` only, with a per-job cache and the D8 read budget. |
| `src/db/migrations/0013_guard_revert.ts` | §14. |
| `test/unit/guard-revert-plan.test.ts`, `test/unit/guard-revert-text.test.ts` | §16. |
| `test/integration/guard-revert.test.ts` | §16. |
| `test/fixtures/webhooks/pull_request.closed.revert.json` | Trigger fixture for D18. |

Changed: `src/github/mutation-guard.ts` (§12), `src/modules/guard/observe.ts` (D1), `comment.ts` (§10), `track.ts` (D18), `handlers.ts`, `index.ts`, `cli.ts` (§13), `store.ts`, `src/config/index.ts`, `src/db/schema.ts`, `src/db/migrations/index.ts`, `src/app/registry.ts`, `src/policy/schema.ts`, `parse.ts` and `json-schema.ts` (§11), `src/pilot/doctor.ts`, `github/app-manifest.json` (`contents: write`), `test/unit/manifest.test.ts`, `test/unit/mutation-guard.test.ts`, `test/integration/neutral.test.ts`, the GitHub fakes (git trees, commits and refs, pull creation and listing by head, labels, the GraphQL mutation, `repos.get` merge settings), and the docs in T12.

## 6. The plan (`src/guard/revert-plan.ts`, pure)

```ts
export interface Entry { mode: string; type: "blob" | "tree" | "commit"; sha: string }
export interface TreeReader {
  commit(sha: string): Promise<{ tree: string; parents: string[] }>;
  tree(sha: string): Promise<{ entries: { name: string; entry: Entry }[]; truncated: boolean }>;
}
export interface Change { path: string; before: Entry | null; after: Entry | null }

export type Plan =
  | { kind: "revert"; changes: Change[]; touchesPolicyFile: boolean }
  | { kind: "needs_human"; reason: NeedsHumanReason; conflicts: string[] }
  | { kind: "skipped"; reason: "already_reverted" };
export type NeedsHumanReason =
  | "touched_later" | "workflow_files" | "submodule" | "type_change" | "too_large" | "history_incomplete";

export function diffTrees(r: TreeReader, baseTree: string, headTree: string, limits: Limits): Promise<Change[] | NeedsHuman>;
export function planRevert(r: TreeReader, i: { baseTree: string; headTree: string; tipTree: string; policyPaths: readonly string[] }, limits: Limits): Promise<Plan>;
export function revertTreeEntries(changes: readonly Change[]): { path: string; mode: string; type: string; sha: string | null }[];

export type AutoMergeInput = { opened: boolean; listed: RiskClass[] | "not_configured" | "policy_invalid"; card: { status: "ok" | "unavailable"; risk: RiskClass } | null; breakGlass: boolean; touchesPolicyFile: boolean; repoAllowsAutoMerge: boolean };
export function autoMergeEligibility(i: AutoMergeInput): { eligible: true } | { eligible: false; reason: AutoMergeReason };
```

`planRevert` checks, in order: D6 diff (and its `too_large`), D8 per change, then the tip lookups of D7 (path by path, through the cached directory trees of the tip), then `already_reverted`. Paths are joined with `/` and never normalised; a name containing `/`, or equal to `.` or `..`, from the tree API is `needs_human` / `too_large` (it cannot happen on real GitHub and must not reach a tree write). `policyPaths` are the policy loader's file locations (whatever the loader reads, recorded).

The reader is the only I/O, so every case of §16 runs against an in-memory tree store in unit tests.

## 7. The job (`guard.revert`)

Job data: `{ installationId, repositoryId, owner, repo, eventId }`. IDs only.

1. Skip if the installation or repository is inactive or `GRAFT_GUARD_DETECTION=off`.
2. Read the event. Not `culprit_found`, or a stored `revert_outcome`, and a comment already stored → stop. (A `culprit_found` event with a stored outcome but no comment goes to step 10.)
3. Read the effective modes (D2) and store `guard_mode`. `GRAFT_GUARD_REVERT=off` → outcome `revert_off`, go to step 10.
4. D3 and D4. A failure sets the outcome and goes to step 10.
5. **Plan** (default installation client, GETs only, outside every lock): D5 range from `main_commits`; `repos.get` (default branch, merge settings); the tip; `guardChecksAt` at `last_green_sha` (D16, D20); `pulls.get` of the culprit (author, `merged_by`, merged head); `planRevert`. Store `revert_plan_paths` (the number of changes) and `revert_conflicts` (the number of conflicts), never the paths.
6. **Report mode stops here**: outcome `planned` (or `needs_human` / `skipped` from the plan), auto-merge eligibility computed and stored as `would`, step 10.
7. **Claim** (D17 a) under the repository lock. D13 cap, D17 e, D21. A failure sets the outcome and goes to step 10.
8. **Write**, with `forInstallation(id, { feature: "guard" })`, resuming per D17 b: tree (D9) and its check, commit (D10), ref, PR (D11), label. After the PR, set `status = 'revert_opened'` and `revert_pr_number` under the change lock.
9. **Auto-merge** (D14, D15). A mutation guard refusal at any write (the mode was rolled back) sets outcome `error` / `mode_changed`, keeps whatever was stored, and goes to step 10. The job does not retry it, and leaves any branch it created.
10. **Comment.** `publishGuardComment` with the outcome (§10), under the change lock, D10 marker rules unchanged.

A retryable GitHub error in steps 5–9 retries the job (pg-boss retries). Each retry resumes from the stored state. A permanent error other than the mutation guard sets outcome `error` with the error class (`tree_mismatch`, `auto_merge_mismatch`, `github_<status>`), and the comment says "Graft could not open the revert" with no detail beyond the class.

## 8. Fixed text

Commit message:

```text
Revert #123 (Graft guard)

CI went red on main at abc1234 after pull request #123 was merged.
This restores the 4 paths #123 changed to their state at 9f8e7d6.

Graft-Agent: graft-guard
```

PR title: `Revert #123 (Graft guard)`.

PR body:

```md
Graft's post-merge guard opened this pull request to revert #123.

CI check `test` went red on `main` at `abc1234` after #123 was merged. It was green at `9f8e7d6`, the commit before, and the failure was confirmed (the next commit `def5678` is also red | still red after 2 hours).

- Failing: `test`, `lint (node 24)` ([details](https://github.com/acme/app/runs/123))
- Reverts: 4 paths, restored to `9f8e7d6`
- Author: @alice · Task: #42 · [agent session](https://…)
- Auto-merge: on (risk `logic`, allowed by `guard.auto_merge_reverts`) | off: the culprit was merged under break-glass | …

Branch protection and required checks decide whether this merges. Close it to keep #123; fix forward instead.

Graft-Agent: graft-guard
```

Rules: the title and body are built only from SHAs, PR numbers, check names (`codeSpan`, as in step 4 §8), validated logins (D11), validated provenance (D11), counts and fixed words. No PR title, PR body, commit message or file path from the culprit. The details link follows step 4's `safeHtmlUrl` rule. The body is at most 4,000 characters, and the trailer is its last paragraph.

## 9. Auto-merge

D14 decides, D15 calls. In report mode the comment shows the would-be decision ("would enable auto-merge" or "would not: …"). The stored values are `auto_merge_state` (`enabled`, `not_eligible`, `unavailable`, `would`) and `auto_merge_reason`. Graft never disables auto-merge once enabled. Rolling the repository back to report leaves an open revert PR and its auto-merge as they are, and `docs/features/guard.md` says so.

## 10. Guard comment

The comment keeps step 4's marker, layout and rules. The paragraph "Graft would open a pull request reverting this merge…" and the mode line are replaced by one of:

| Outcome | Text |
| --- | --- |
| report, `planned` | `Graft would open a pull request reverting this merge (4 paths restored to \`9f8e7d6\`) and would enable auto-merge on it \| would not enable auto-merge: <reason>.` |
| enforce, `opened` | `Graft opened #456 to revert this merge. Auto-merge: on \| off: <reason>.` |
| `needs_human` / `touched_later` | `Graft did not open a revert: these paths changed again on \`main\` after this merge: \`a.ts\`, \`b/c.ts\` and 3 more. Revert by hand or fix forward.` (report: "would not open") |
| `needs_human`, other reasons | One fixed sentence per reason (workflow files, submodule, type change, too large, history incomplete). |
| `skipped` | One fixed sentence per reason (`confirmation_off`, `revert_of_revert`, `already_reverted`, `already_green`, `already_opened`, `cap_reached`, `filtered_at_baseline`, `revert_off`). |
| `error` | `Graft could not open the revert (<class>). An operator can see the event with \`graft guard list\`.` |

Mode line: report, `Graft mode: report. Graft opens nothing; this is what it would do.`; report because enforce is not effective, `Graft mode: report (enforce requested; <reason>). Graft opens nothing; this is what it would do.`; enforce, `Graft mode: enforce.`. Paths are code spans of at most 200 characters, at most 20 listed. The D16 line of step 4 ("Revert PRs are not available in this version") is gone.

## 11. `graft.yaml`: `guard.auto_merge_reverts`

```yaml
version: 1
guard:
  checks: [test]
  auto_merge_reverts: [trivial, logic]
```

Schema: an optional list of 1–2 distinct risk classes from `trivial` and `logic`. `sensitive` is an error with a new code `auto_merge_sensitive` ("Reverts of sensitive changes are never auto-merged; remove sensitive."). A wrong item is `risk_invalid`. The policy engine ignores the key, and a file without it keeps its canonical form and hash (as step 4 §9). `docs/graft-yaml.md`, the JSON schema and `docs/examples/graft.yaml` (commented out) are updated.

## 12. Mutation guard

The step 1 table already lists `POST …/git/trees`, `…/git/commits`, `…/git/refs`, `DELETE …/git/refs/heads/graft-revert/…`, `POST …/issues/{n}/labels` and `POST …/pulls` as `phase1` for `guard`. This step adds:

- **GraphQL.** `POST /graphql` becomes `phase1` for `guard` **only** when the body's `query` is exactly the exported `ENABLE_AUTO_MERGE_MUTATION` constant and `variables.clientMutationId` matches `^graft-guard:<owner>/<repo>#\d+$`. The owner and repository for the gate come from that variable. Any other GraphQL body stays `unknown` and is refused in every mode.
- **Body rules for `guard`** (as D11 of step 2 reads check-run bodies). `POST …/git/refs`: `ref` must match `^refs/heads/graft-revert/[0-9a-f-]{36}$`. `POST …/pulls` from a `guard` client: `head` must match `^graft-revert/[0-9a-f-]{36}$`. `POST …/issues/{n}/labels` from a `guard` client: the body is exactly `{ labels: ["graft:revert"] }`. Anything else is refused (`feature_not_allowed`). The `mcp` feature's `POST …/pulls` is step 6's to constrain.
- No other route. `PUT …/pulls/{n}/merge`, `PATCH …/git/refs/…`, `PATCH …/pulls/{n}` and `POST …/git/blobs` stay unknown.

**What proves report mode inert.** In `report`, the job never makes a `guard` client (§7, step 6). If a bug made one and wrote, the gate refuses before the request is sent (`mode_report`), the fake's request log stays empty, and the job fails. I-REV-2 runs the job in report mode and asserts **no** request to `/git/` (other than GET), `/pulls` (other than GET), `/labels` or `/graphql`, and no refusal logged either. I-REV-3 calls the write step directly with a `guard` client in report mode and asserts a `MutationRefusedError` with `mode_report` and an empty log for those routes. Together they show that the job does not try, and that it could not.

## 13. Operator CLI

`graft guard list` (step 4 §10) gains a revert column: `revert #456 (auto-merge on)`, `needs human: touched later (3)`, `skipped: cap reached`, `would revert 4 paths`, or `error: tree_mismatch`. `--json` adds `revert: { outcome, reason, prNumber, branch, commitSha, planPaths, conflicts, autoMergeState, autoMergeReason }` to each event. The status filter accepts `needs_human`, `revert_opened`, `reverted` and `revert_closed`.

`graft mode show` adds `note: guard reverts are off on this shell's config` when `GRAFT_GUARD_REVERT=off`. `pilot doctor` gains two `warn` checks: "revert PRs open for more than 72 hours" and "guard events with revert outcome `error` in the last 7 days". Doctor still reads only the database.

## 14. Schema (migration `0013_guard_revert`)

`0013` is the next free number on `main` today; renumber if another migration lands first.

```sql
ALTER TABLE guard_events
  DROP CONSTRAINT guard_events_status_check,
  ADD CONSTRAINT guard_events_status_check CHECK (status IN (
    'detected','confirming','culprit_found','ambiguous','no_culprit','flaky','needs_human',
    'revert_opened','reverted','revert_closed','dismissed','error')),
  ADD COLUMN revert_outcome     text CHECK (revert_outcome IN ('planned','opened','needs_human','skipped','error')),
  ADD COLUMN revert_reason      text CHECK (char_length(revert_reason) <= 40),
  ADD COLUMN revert_claimed_at  timestamptz,
  ADD COLUMN revert_plan_paths  integer,
  ADD COLUMN revert_conflicts   integer,
  ADD COLUMN revert_commit_sha  text CHECK (revert_commit_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN revert_branch      text CHECK (revert_branch ~ '^graft-revert/[0-9a-f-]{36}$'),
  ADD COLUMN revert_labelled    boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_merge_state   text CHECK (auto_merge_state IN ('enabled','not_eligible','unavailable','would')),
  ADD COLUMN auto_merge_reason  text CHECK (char_length(auto_merge_reason) <= 40),
  ADD COLUMN reverted_at        timestamptz;
CREATE UNIQUE INDEX guard_events_one_revert_per_culprit
  ON guard_events (repository_id, culprit_change_id) WHERE revert_pr_number IS NOT NULL;
CREATE INDEX guard_events_revert_open_idx ON guard_events (repository_id) WHERE status = 'revert_opened';
```

`revert_pr_number` already exists (0001). `needs_human` is a status, because it ends the event's revert story. `skipped` and `error` keep `culprit_found` (the culprit is still known) and say why in `revert_outcome`/`revert_reason`. `down` drops exactly what `up` adds and restores step 4's CHECK. It fails if a row uses a new status, and the rollback test runs on an empty table. No path, title or body is stored.

## 15. Tasks

### T1. API verification

Record in decisions.md, from GitHub's REST, GraphQL and webhook docs, and make the fakes match:
- (a) `GET …/git/trees/{sha}` (non-recursive): entry fields, `truncated`, and the entry limit.
- (b) `POST …/git/trees` with `base_tree`: `sha: null` deletes a file. Does it delete a directory entry (`type: tree`)? If not, D9 expands an added directory into its files (bounded by D8) and the decision is recorded.
- (c) Commits that change `.github/workflows/*` need the `workflows` permission for an App's `POST …/git/refs` or `…/git/commits` (D8).
- (d) `POST …/issues/{n}/labels` on a pull request with `pull_requests: write`, and whether it creates a missing label.
- (e) `enablePullRequestAutoMerge`: the input, the errors for a repository without auto-merge and for a PR in clean status, the "already enabled" case, and whether `clientMutationId` is echoed.
- (f) A pull request opened with an installation token triggers `pull_request` workflows (so required checks run on the revert).
- (g) `GET …/pulls?head=<owner>:<branch>&state=all` finds a closed PR from a branch of the same repository.

### T2. Config

`GRAFT_GUARD_REVERT` (`on`/`off`, default `on`), `GRAFT_GUARD_MAX_OPEN_REVERTS` (1–10, default 3), `GRAFT_GUARD_REVERT_MAX_PATHS` (1–1000, default 300), `GRAFT_GUARD_REVERT_MAX_TREE_READS` (10–1000, default 200). `.env.example` and `docs/configuration.md`.

### T3. Migration and schema types

§14, `src/db/schema.ts`. Rollback test as in earlier steps. Step-down tests gain `0013`.

### T4. Pure plan and text

`src/guard/revert-plan.ts` (§6, D5–D9, D14) and `src/guard/revert-text.ts` (§8, §10).

### T5. Tree reader

`src/modules/guard/trees.ts`: `git.getTree` and `git.getCommit` only, cached per job, the D8 budget counted per request.

### T6. Revert job

§7 with D1–D4, D13, D16, D17, D20, D21, and the observe change of D1.

### T7. Auto-merge

D14, D15, §9.

### T8. Lifecycle

D18: the handler, `guard.revert_closed`, and the `guard.track` mapping.

### T9. Mutation guard

§12, with U-MG tests for every new rule and refusal.

### T10. `graft.yaml` key and manifests

§11. `github/app-manifest.json` gets `contents: write`. The report manifest keeps `contents: read`. **U-MAN-6:** the full manifest has `contents: write`, the report manifest has no permission above `read` except Phase 0's `pull_requests: write` and `checks: write`, and neither has `workflows`.

### T11. CLI and doctor

§13.

### T12. Docs

- `docs/features/guard.md`: replace "What step 5 adds" with a "Revert pull requests" section (when, the plan, needs-human cases, the revert PR, auto-merge and its rules, the cap, the kill switch, rollback behaviour). Extend "The trust boundary" with §4, including the residual risk. **Close step 4 review 2, finding E**: next to D17's paragraph, say that a narrowed event was filtered at the older baseline and that a revert also needs the newer one (D20). **Close finding B's open items**: the `workflow_dispatch` trade-off (a fresh workflow run on the same SHA is another check suite, so its green does not make the event `flaky`, and a quiet repository confirms by the window).
- `docs/architecture.md`: "Guard contract" gains the revert job, its writes and their order, the D17 resume points, and the §12 body rules.
- `docs/graft-yaml.md` (§11), `docs/configuration.md` (T2), `docs/github-app.md` (`contents: write`, why there is no `workflows`), `docs/features/modes.md` (what `guard_mode: enforce` now does).
- `docs/decisions.md`: "Phase 1 step 5: revert PRs" with the T1 answers and any deviation.
- `docs/phase-1/HUMAN-TODO.md`: §17.
- The step 7 spec, when written, must count `flaky` events with a null `confirm_reason` as neither caught breakages nor flakes (step 4 review 2, nit D). Add that sentence to README step 7's bullets.

### T13. Neutral suite

`test/integration/neutral.test.ts`. The guard scenario now runs through `guard.revert`.
- **N-1 / N-1g / N-8 under `default`:** unchanged. One comment on the culprit PR, now with the "would open" plan line. No `phase1` route and no `guard` client.
- **N-12 under `max`:** the guard scenario opens exactly one revert: one each of `POST …/git/trees`, `…/git/commits`, `…/git/refs`, `…/pulls`, `…/issues/{n}/labels`, all through the `guard` client, plus the one comment. No `PUT …/merge`, no `PATCH …/git/refs`. N-8 is restated for `max` as "every `phase1` request came from a `guard` client and was allowed".
- **N-13 under `max`:** a replayed `check_run.completed`, a second observe and a re-run of `guard.revert` for the same event add no write.

## 16. Test plan

Unit (`test/unit/guard-revert-plan.test.ts`, in-memory trees):

| ID | Case |
| --- | --- |
| U-RVP-1 | Squash merge modifying two files → two changes with `before`/`after`; tree entries restore `before` SHAs and modes |
| U-RVP-2 | Added file → entry with `sha: null`; deleted file → restored with its old mode; an executable bit flip (`100644` → `100755`) → restored mode |
| U-RVP-3 | Rename → one deletion and one restoration; a symlink (`120000`) is a blob change |
| U-RVP-4 | Whole directory added → one change on the directory entry; whole directory deleted → restored with its tree SHA |
| U-RVP-5 | Subtrees with equal SHAs are never read (reader call log) |
| U-RVP-6 | D7: a changed path modified again at the tip → `needs_human touched_later` with that path; a path changed and changed back at the tip → not a conflict |
| U-RVP-7 | D7: every tip entry equals `before` → `skipped already_reverted` |
| U-RVP-8 | D8: `.github/workflows/ci.yml` → `workflow_files`; gitlink → `submodule`; file → directory → `type_change`; 301 changes → `too_large`; read budget exceeded → `too_large`; `truncated: true` → `too_large` |
| U-RVP-9 | Rebase merge: three commits, `base` = the first one's parent, `head` = the last one |
| U-RVP-10 | `autoMergeEligibility`: one case per D14 reason, in the stated order; all satisfied → eligible |
| U-RVP-11 | Property test: applying `revertTreeEntries` to the tip (in memory) gives, for every change path, exactly `before`, and leaves every other path of the tip unchanged |

Unit (`test/unit/guard-revert-text.test.ts`):

| ID | Case |
| --- | --- |
| U-RVT-1 | The §8 samples, literally; the trailer is the last paragraph of the commit message and of the body |
| U-RVT-2 | Mentions: a `User` author → `@alice`; a `Bot` author → `merged_by` mentioned; an invalid login → code span, no `@`; no `@` anywhere else |
| U-RVT-3 | Task `#42` → `#42`; task `ABC-12` → code span; a task containing `@team` or backticks → safe code span; session URL only when validated |
| U-RVT-4 | Each §10 row; 25 conflicting paths → 20 listed and `and 5 more`; a path with backticks or `<!--` rendered safely; the marker appears once |

Unit (additions): **U-PGD-3** `guard.auto_merge_reverts` parsing (valid list, `sensitive` → `auto_merge_sensitive`, unknown item → `risk_invalid`, empty list, three items) and an unchanged hash without the key. **U-MG-*** per §12 (each new rule allowed with a `guard` client in enforce, refused in report, refused without a feature, refused with `policy` or `mcp`; a GraphQL query other than the constant; a wrong `clientMutationId`; a ref outside `graft-revert/`; a PR head outside `graft-revert/`; a label body other than `graft:revert`; `PUT …/merge` and `PATCH …/git/refs` unknown). **U-MAN-6** (T10).

Integration (`test/integration/guard-revert.test.ts`, fake GitHub world):

| ID | Case |
| --- | --- |
| I-REV-1 | Migration up/down/up |
| I-REV-2 | **Report mode inert:** a confirmed culprit with default modes → plan computed (GETs only), comment with the "would open" line, outcome `planned`; the request log has no non-GET to `/git/`, `/pulls`, `/labels` or `/graphql`, and no mutation guard refusal was logged |
| I-REV-3 | **Report mode refused:** the write step called directly with a `guard` client while `guard_mode` is report → `MutationRefusedError mode_report` before any request is logged |
| I-REV-4 | Enforce requested, no `contents: write` → effective report, comment says `enforce requested; permission_missing contents:write`, no write |
| I-REV-5 | Enforce, single squash culprit → tree, commit (parent = tip), ref `graft-revert/<id>`, PR with the §8 title and body, label; event `revert_opened`, `revert_pr_number` set; the fake's resulting tree equals the base tree on the changed paths and the tip elsewhere |
| I-REV-6 | Enforce, a changed path modified again on `main` → `needs_human`, comment lists the path, no write besides the comment |
| I-REV-7 | `flaky` (re-run green), `flaky` with a null `confirm_reason` (undecided at the last attempt), `ambiguous`, `no_culprit` and `confirming` events: `guard.revert` run directly for each → no write, no outcome change |
| I-REV-8 | `GRAFT_GUARD_CONFIRM=off` → `skipped confirmation_off`, no write |
| I-REV-9 | The culprit is a Graft revert PR → `skipped revert_of_revert`. A PR whose branch is named `graft-revert/…` and whose body has `Graft-Agent: graft-guard`, but which no event opened → reverted normally |
| I-REV-10 | **Crash after the ref:** the job fails after `POST …/git/refs`; the retry adopts the branch and opens one PR. **Crash after the PR:** the job fails after `POST …/pulls`; the retry finds the PR by head and stores it; no second PR. **Stale branch:** the tip moved between the crash and the retry → branch deleted and recreated, one PR |
| I-REV-11 | Redelivery: a replayed `check_run.completed`, a second observe and a second `guard.revert` for the same event → no write. A later event with the same culprit → `skipped already_opened` |
| I-REV-12 | Cap: three events in `revert_opened`, a fourth culprit → `skipped cap_reached`; one revert PR closed (D18) → a fifth opens |
| I-REV-13 | Auto-merge: `auto_merge_reverts: [logic]` at the baseline and a `logic` card → the GraphQL mutation with the constant document and the right `clientMutationId`, `auto_merge_state = enabled` |
| I-REV-14 | Auto-merge refused: the culprit's merged head has an `applied` break-glass row → `not_eligible break_glass`; a `sensitive` card → `not_eligible risk_not_listed`; no card → `card_missing`; the key only in the culprit's own `graft.yaml` (not at the baseline) → `not_configured`; repository without auto-merge → `repo_setting_off`; GraphQL "clean status" error → `unavailable`, no merge request |
| I-REV-15 | Narrowed event (finding E): `guard.checks` at the original baseline lists `lint`, at the narrowed baseline it does not → `skipped filtered_at_baseline` |
| I-REV-16 | Already green: a later commit is green on the failing keys before the job opens → `skipped already_green` |
| I-REV-17 | Rollback mid-job: `guard_mode` set to report after the PR is opened and before auto-merge → the GraphQL write is refused, outcome `error mode_changed`, the PR stays, no retry |
| I-REV-18 | D18: the revert PR merged → `reverted`; closed without merge → `revert_closed`; a `pull_request.closed` for a `graft-revert/…` PR unknown to the database → nothing; a missed webhook, then a push mapping a commit to the revert PR → `reverted` |
| I-REV-19 | Rebase merge culprit (three commits) → one revert restoring all three commits' changes; a non-contiguous PR (another commit in between) → `needs_human history_incomplete` |
| I-REV-20 | No code read: across I-REV-2 to I-REV-19, the fake's log has no request to `/contents/`, `/git/blobs`, `/compare/`, `…/commits/{sha}` (the REST commit with files) or a `.diff`/`.patch` media type |
| I-REV-21 | `GRAFT_GUARD_REVERT=off` → step 4 comment wording, `skipped revert_off`, no plan reads |
| I-REV-22 | `graft guard list` text and `--json` with each outcome; doctor warnings with exit 0; `mode show` note |

Neutral suite: N-1, N-1g, N-8 (default), N-12, N-13 (T13). Manifest: U-MAN-6.

## 17. HUMAN-TODO (add a section "Step 5: revert PRs" to `docs/phase-1/HUMAN-TODO.md`)

- [ ] **Decide which deployments get the full manifest** with `contents: write`. Evaluation-only deployments keep the report manifest and can never open a revert. Who: product owner.
- [ ] **Accept `contents: write`** on every installation that will enforce the guard, then `pnpm graft mode refresh-permissions --installation <id>`. Who: org owner, then operator.
- [ ] **Create the `graft:revert` label** in each pilot repository, with a description saying Graft's guard opened the PR. Who: repo admin.
- [ ] **If a team wants auto-merged reverts:** turn on "Allow auto-merge" and "Automatically delete head branches" in the repository settings, make sure the default branch has required checks, and add `guard.auto_merge_reverts` in a reviewed PR. Who: repo admin.
- [ ] **On a sandbox repository with the ceiling at `enforce` and `--guard enforce`:** merge a PR that breaks a check, push one more commit, and check that one revert PR opens with the label, the fixed title and body and the author mention; that `pnpm graft guard list` shows `revert_opened`; that merging it gives `reverted`. Then break `main` with a PR whose file is changed again by the next merge and check `needs_human` with the path listed. Then `mode set --guard report` and repeat the first case: a "would open" comment only. Who: repo owner.
- [ ] **Check the T1 answers on real GitHub** that the offline build could not: `sha: null` on a directory entry, the `workflows` permission rule, label creation, the auto-merge errors and the `clientMutationId` echo. Who: operator.
- [ ] **Step 4 review 2, finding B (still open):** on the sandbox, two workflows with the same job name, one red then one green later, must still give a red result; and a "Re-run failed jobs" that ends green must give `flaky`. Who: repo owner.
- [ ] **Run the step 5 manual smoke test** (§18) and record it in the PR description; the developer agent ran only the offline suite. Who: operator.

## 18. Definition of done

From a clean clone with Docker running, and no network beyond install and the image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test                                  # every ID in §16 present and passing; all earlier IDs still passing
pnpm build
pnpm eval:ci                               # exit 0, baseline unchanged
pnpm db:migrate && pnpm db:status          # every migration up to 0013 applied
pnpm db:rollback && pnpm db:status && pnpm db:migrate   # only 0013 rolled back, then re-applied
grep -rnE "@ts-(ignore|expect-error)" src/ && exit 1 || true
grep -rnE "from \"\.\./(db|github|modules)" src/guard/ && exit 1 || true
grep -rnE "getContent|getBlob|createBlob|compareCommits|repos\.getCommit|\.diff|\.patch|/contents/|/blobs" src/modules/guard/ src/guard/ && exit 1 || true
grep -rnE "pulls\.merge|updateRef|pulls\.update|/merge\b" src/modules/guard/ && exit 1 || true
grep -rn "feature: \"guard\"" src/ | grep -v "src/modules/guard/revert.ts" && exit 1 || true   # the only guard client
grep -rn "U-RVP-\|U-RVT-\|U-PGD-3\|I-REV-\|N-1[23]\|U-MAN-6" test/ | wc -l   # non-zero
```

**Manual smoke test** (record it in the PR description): with `pnpm dev:server` and `pnpm dev:worker`, seed a repository with `guard_mode` requested `enforce` and the ceiling at `report`, and an event in `culprit_found` (a SQL insert or the I-REV fixture seeder). Enqueue `guard.revert` for it. Offline, the plan's API reads fail and are classified, the job retries and ends in `error` with a `github_*` class: no crash, no write attempted, and `graft guard list` shows the event with its outcome. Then `pnpm webhook:send pull_request.closed.revert.json`: the worker logs `guard.revert_closed` and stops at "no event".

**Mutation checks** (the reviewer reverts each one; the named tests must fail):

| Mutation | Caught by |
| --- | --- |
| Revert opened for `flaky` with a null `confirm_reason` | I-REV-7 |
| `confirmation_off` ignored | I-REV-8 |
| D7 skipped (no tip comparison) | U-RVP-6, I-REV-6 |
| Added file restored instead of deleted (`sha: null` dropped) | U-RVP-2, U-RVP-11, I-REV-5 |
| Old mode not restored | U-RVP-2, U-RVP-11 |
| Workflow files reverted | U-RVP-8 |
| Report mode creates a `guard` client and writes | I-REV-2, N-8 |
| `GraphQL` body rule removed (any query allowed) | U-MG (GraphQL cases) |
| Ref body rule removed | U-MG (ref case) |
| No lookup by head on 422 | I-REV-10 |
| One-per-culprit index or check removed | I-REV-11 |
| Cap ignored | I-REV-12 |
| Break-glass not checked for auto-merge | I-REV-14 |
| `auto_merge_reverts` read at the failing commit instead of the baseline | I-REV-14 |
| Narrowed baseline's `guard.checks` not applied | I-REV-15 |
| Revert-of-revert detected by branch name or trailer | I-REV-9 |
| `reverted` taken from the webhook payload | I-REV-18 |

**Also required:**
- No log line, job payload, column or error message holds a token, file content, a diff, a commit message, PR text, a file path or YAML. File paths appear only in the guard comment and are never logged above debug.
- Every non-GET request in every test log is either a Phase 0 route or one of the §12 routes through a `guard` client in enforce mode.
- The live e2e runner's INV-1 still holds with the default sandbox (no runner change in this step).
