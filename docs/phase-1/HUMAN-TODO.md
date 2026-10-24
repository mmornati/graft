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
- [ ] **Until every server and worker runs the step 7 build, lower `GRAFT_MODE_CEILING` with a full stop. After that, a rolling restart is safe (step 7, D2).** Who: operator.
- [x] ~~**Think twice before enforcing on a public repository.**~~ Decided by step 7 D10: `mode set --policy enforce` on a public repository needs `--public`, the doctor warns (`public_enforce`), and the [runbook](../pilots/phase-1-runbook.md) keeps public repositories in report mode in Phase 1. Who: operator.
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

## Step 6: MCP server

- [ ] **Decide who gets tokens.** Only agents that already have read access to the repository (spec §4, [features/mcp.md](../features/mcp.md#getting-a-token)). Write it in the pilot runbook. Who: product owner.
- [ ] **Expose `/mcp` through the proxy** in front of the Graft server (same host as the webhook receiver), over HTTPS only. Check that the proxy does not log the `Authorization` header. The failed-auth limit is per client IP and Graft configures no `trustProxy`, so behind a proxy every client shares the proxy's address; if that is too coarse, set Fastify's `trustProxy` for the known proxy (a code change, see [decisions.md](../decisions.md#phase-1-step-6-mcp-server)). Who: operator.
- [ ] **Set `GITHUB_APP_SLUG`** on the server before any pilot repository turns `mcp_write` on. `open_change` re-records a PR Graft opened, after a crash lost its record, only when it can recognise Graft's own bot (`<slug>[bot]`); without the slug such a PR keeps no D19 exclusion of its commit authors (review 1, finding 5). Who: operator.
- [ ] **Create one token per pilot repository** with `pnpm graft mcp-token create`, store it in the agent's secret store, and never paste it into a PR, issue or chat. Who: operator.
- [ ] **On a sandbox repository:** configure an MCP client (for example Claude Code with an HTTP server entry and a bearer header) and call `get_status` on an open PR and `get_policy`; then `report_provenance` with a different agent name and check the comment line and the verdict; then `open_change` with `mcp_write` off (refused); then, with the ceiling at `enforce` and `mode set --mcp-write on`, open a PR from a pushed branch and check its body trailers and that your own approval does not count. Then `mcp-token revoke` and check the next call fails. Who: repo owner.
- [ ] **Check the T1 answers on real clients** that the offline build could not: a 2025-era client (protocol `2025-11-25`) and a 2026-07-28 client both work against the stateless endpoint; and, on real GitHub, the `POST …/pulls` 422 bodies ("A pull request already exists", "No commits between") and `GET …/pulls?head=<owner>:<branch>&base=<b>&state=open` ([decisions.md](../decisions.md#phase-1-step-6-mcp-server), T1). Who: operator.
- [ ] **Run the step 6 manual smoke test** (spec §16: `pnpm dev:server` and `pnpm dev:worker`, a token from `pnpm graft mcp-token create`, `tools/list` and `get_status` with `curl`, a wrong token, a revoked token, `open_change` refused, the `mcp call` log line without the token) and record it in the PR description; the developer agent ran only the offline suite. Who: operator.

## Step 7: security review, pilots and gate

- [ ] **Read the security review** ([step-7-security-review.md](reviews/step-7-security-review.md)) and sign off its verdict before any repository leaves stage 2. Who: product owner.
- [ ] **Recruit three more pilot teams**, so five installations take part (development plan, "Where the 5 pilot teams come from"), and onboard each with Phase 0 onboarding and runbook stage 1. Who: product owner.
- [ ] **Set `GRAFT_TRUST_PROXY`** to the proxy's addresses on every server process, and check with two clients that one's bad tokens do not lock the other out. Who: operator.
- [ ] **Check on real GitHub** that `GET …/pulls/{n}/commits` returns `commit.verification.verified` for signed commits from an agent's SSH or GPG key, and `false` for unsigned ones (D8). Who: operator.
- [ ] **Have every agent that uses `open_change` sign its commits** (SSH signing key on the agent's GitHub account). Who: product owner, with each pilot.
- [ ] **Run the runbook per pilot repository** ([phase-1-runbook.md](../pilots/phase-1-runbook.md)) and keep its stage record outside git. Who: operator, repo admin, tech lead.
- [ ] **Weekly gate review**: `baseline --period phase1` per repository, `gate report --phase 1` for the five installations, the runbook's stage checks, a short note. Who: product owner and operator.
- [ ] **Calling the Phase 1 gate.** Call it at the first weekly review where the gate verdict (measured, not the preview) is PASS or FAIL and at least 4 weeks after the third pilot entered stage 3. If it is still INSUFFICIENT DATA 8 weeks after that, decide with the pilots whether to extend 2 weeks or record a FAIL for lack of enforcement. Judge pilot retention (reported, target 3 of 5) at the same time. Record the verdict, window, the four measured values, retention and the report's SHA-256 in `docs/plan/development-plan.md`. Who: product owner.
- [ ] **Run the enforce sandbox once**: add the sandbox entry with `"mode": "enforce"`, set the ceiling and `--policy enforce` for it, run `pnpm graft e2e run` (`e01`), then roll the sandbox back to report ([e2e runbook](../e2e/runbook.md)). Who: repo owner.
- [ ] **Check guard and MCP enforcement by hand** on the sandbox (no live e2e scenario covers them, D21): the step 5 and step 6 sandbox checks above, with the step 7 build. Who: repo owner.
- [ ] **Run the step 7 manual smoke test** (spec §15: the Phase 1 gate report on seeded data with `--check` exiting 4, then a worker with `GRAFT_MODE_CEILING=report` and a server with `enforce`, and `open_change` through `curl` answering `mcp_write_off` with reason `ceiling`) and record it in the PR description; the developer agent ran only the offline suite. Who: operator.

### Pending product decisions (step 7)

The spec raised five questions a person has not answered yet. The build uses the spec's current values; each one is a one-line change where it lives in code.

- [ ] **D8, verified commits on MCP-opened PRs.** Built as specified: any unverified commit means no approval counts. To turn it off (go back to step 6's D19 alone), set `REQUIRE_VERIFIED_COMMITS` to `false` in `src/modules/policy/facts.ts`. Who: product owner.
- [ ] **The gate thresholds** (targets 30%, −50%, 80%, no rise; the minimums; the 14-day defect lag; p < 0.05; the point estimate from 400; the 0.05 slack). All in the `PHASE1` object of `src/pilot/gate-phase1.ts`. Who: product owner.
- [ ] **The runbook numbers** (stage 2: 30 merged PRs, 14 days, at most 10% would-fail at merge). In `RUNBOOK_STAGE2` (`src/pilot/gate-phase1.ts`); the runbook quotes them and U-DOC-3 checks that it does, so a change is that constant plus the matching runbook line. The other stage criteria (14 days per stage, 3 reverts before stage 5, 7 days of MCP reads) are runbook text only. Who: product owner.
- [ ] **Pilot retention** (reported, not decided: target 3 of 5; an installation counts when it is at least 30 days old and had a delivery in the last 7 days). `PHASE1.retention` in `src/pilot/gate-phase1.ts`. Who: product owner.
- [ ] **The D21 e2e scenario.** `e01`'s steps and expectations are the `E01_STEPS` table in `src/e2e/scenarios/e01.ts`; dropping the scenario is removing `e01` from `SCENARIOS` in `src/e2e/scenarios/index.ts`. Who: product owner.
