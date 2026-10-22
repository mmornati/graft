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
