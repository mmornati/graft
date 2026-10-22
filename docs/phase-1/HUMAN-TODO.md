# Phase 1: human to-do

Things only a person can do. The developer agent never ticks these. Each item names who does it.

## Step 1: modes

- [ ] **Leave `GRAFT_MODE_CEILING` unset (report)** on every deployment until the Phase 1 rollout runbook says otherwise. Who: operator.
- [ ] **Decide which manifest each deployment uses.** Evaluation-only deployments register `github/app-manifest.report.json`. Who: product owner.
- [ ] **Run `pnpm graft mode refresh-permissions --installation <id>`** once per existing installation after deploying step 1, then `pnpm graft mode show --installation <id>` and check the permissions line. Who: operator.
- [ ] **On a sandbox PR**, check that the `graft/policy` check details start with the "Graft mode: report" line and the check is still `neutral`; then `mode set --policy enforce` with the ceiling at `report` and confirm `show` reports `effective report  ceiling`. Who: repo owner.

## Step 2: approvals

- [ ] **Accept the new `members: read` permission and the `membership` and `team` events** on every installation, then run `pnpm graft mode refresh-permissions --installation <id>` and check the permissions line. Who: org owner, then operator.
- [ ] **Before any repository enforces:** make `graft/policy` required with the Graft App as the expected source (branch protection "required status checks", source app set). With "any source", a commit status or check named `graft/policy` from another app or a workflow could satisfy it. Who: repo admin.
- [ ] **Do not enforce on a repository that uses a merge queue.** `merge_group` is not handled in Phase 1. Who: operator.
- [ ] **On a sandbox repository with the ceiling at `enforce`:** set `--policy enforce` and check, on one PR, a `failure` with no approval, a `success` after a team member approves, a `failure` after a push (stale), and a `neutral` within about a minute of `mode set --policy report`. Who: repo owner.
- [ ] **To lower `GRAFT_MODE_CEILING`, stop every worker before starting the new one.** A rolling restart lets an old worker with `enforce` publish after the rollback (step 2 review 1, finding 7, deferred to step 7). Who: operator.
- [ ] **Think twice before enforcing on a public repository.** Approval role checks now go to owners, members and collaborators first, but 21 or more change requests from outsiders still block the check (fail closed, step 2 review 1, finding 4). Decide in the step 7 runbook. Who: operator.
- [ ] **Run the step 2 manual smoke test** (spec §15: report-mode would-be line, enforce with the ceiling, rollback) against a real or tunnelled App and record it in the PR description; the developer agent ran only the offline suite. Who: operator.

## Step 3: break-glass

- [ ] **Create the `graft:break-glass` label** in each pilot repository, with a description saying it bypasses the Graft policy for one commit and is audited. Who: repo admin.
- [ ] **Tell the team who can use it** (maintain or admin) and that every use appears in the PR comment and in `pnpm graft audit list`. Who: product owner.
- [ ] **On a sandbox PR in enforce mode:** label as a maintainer → `success`; push → back to the normal conclusion; label as a triage user → ignored. Then run `pnpm graft audit list --repo …` and check all three rows. Who: repo owner.
- [ ] **Check the issue events API on a real PR** (T1 could not, offline): the `labeled` event's `actor` is the person who added the label, events are listed oldest first, and the installation token can read them with `issues: read` / `pull_requests: read`. Who: operator.
- [ ] **Run the step 3 manual smoke test** against a real or tunnelled App (not run by the developer agent). Who: operator.
- [ ] **Measure how late the issue events API lists a label change** (step 3 review 1, finding 1): add and remove the label a few times and note how long after each webhook the `labeled` / `unlabeled` event appears in `GET /issues/{n}/events`. Graft retries a label run for about 15 minutes (5 retries, backoff from 30 s); if the lag is longer, the label is ignored as `actor_unknown`. Also check whether the response carries `Link: rel="last"` (review 1, nit 8: reading the newest page first). Who: operator.
- [ ] **On the sandbox PR, check the review 1 cases:** a maintainer labels (success), a triage user removes and re-adds the label (normal conclusion, a `removed` row for the removal and an `ignored` row for the triage user); push and push the labelled commit back (normal conclusion). Who: repo owner.

## Step 4: guard detection

- [ ] **Accept `statuses: read` and the `check_suite` and `status` events** on every installation, then `pnpm graft mode refresh-permissions --installation <id>`. Who: org owner, then operator.
- [ ] **On a sandbox repository**, merge a PR that breaks a check on `main`, then push one more commit. Check that a guard comment appears on the culprit PR and that `pnpm graft guard list --repo …` shows `culprit_found`. Then re-run a failing check until it passes on a fresh break, and check that the event is `flaky` with no comment. This also checks the T1 (a) answer: the guard must see other apps' `check_run.completed` deliveries. Who: repo owner.
- [ ] **Tell pilot teams** that the guard comments on merged PRs that broke `main`, and that nothing is reverted until they opt in to `guard_mode: enforce` (step 5). Who: product owner.
- [ ] **Run the step 4 manual smoke test** (spec §15: `push.default.json`, then `check_run.completed.json`, through `pnpm webhook:send` with a dev server and worker) and record it in the PR description; the developer agent ran only the offline suite. Who: operator.

## Step 5: revert PRs

- [ ] **Decide which deployments get the full manifest** with `contents: write`. Evaluation-only deployments keep the report manifest and can never open a revert. Who: product owner.
- [ ] **Accept `contents: write`** on every installation that will enforce the guard, then `pnpm graft mode refresh-permissions --installation <id>`. Who: org owner, then operator.
- [ ] **Create the `graft:revert` label** in each pilot repository, with a description saying Graft's guard opened the PR. Who: repo admin.
- [ ] **If a team wants auto-merged reverts:** turn on "Allow auto-merge" and "Automatically delete head branches" in the repository settings, make sure the default branch has required checks, and add `guard.auto_merge_reverts` in a reviewed PR. Who: repo admin.
- [ ] **On a sandbox repository with the ceiling at `enforce` and `--guard enforce`:** merge a PR that breaks a check, push one more commit, and check that one revert PR opens with the label, the fixed title and body and the author mention; that `pnpm graft guard list` shows `revert_opened`; that merging it gives `reverted`. Then break `main` with a PR whose file is changed again by the next merge and check `needs_human` with the path listed. Then `mode set --guard report` and repeat the first case: a "would open" comment only. Who: repo owner.
- [ ] **Check the T1 answers on real GitHub** that the offline build could not: `sha: null` on a directory entry (`type: tree`) in `POST …/git/trees` with `base_tree`, the `workflows` permission rule for a commit touching `.github/workflows/`, whether `POST …/issues/{n}/labels` creates a missing label, the `enablePullRequestAutoMerge` errors (auto-merge not allowed, clean status, already enabled) and the `clientMutationId` echo, that a PR opened with an installation token triggers `pull_request` workflows, and that `GET …/pulls?head=<owner>:<branch>&state=all` finds a closed PR. See [decisions.md](../decisions.md#phase-1-step-5-revert-prs) (T1). Who: operator.
- [ ] **Step 4 review 2, finding B (still open):** on the sandbox, two workflows with the same job name, one red then one green later, must still give a red result; and a "Re-run failed jobs" that ends green must give `flaky`. Who: repo owner.
- [ ] **Run the step 5 manual smoke test** (spec §18) and record it in the PR description; the developer agent ran only the offline suite. Who: operator.
