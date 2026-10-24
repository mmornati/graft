# Phase 1 pilot rollout runbook

One copy of the stage checklist per pilot repository. The operator copies the [stage table](#the-stage-record) into the pilot's record, which is kept outside git, and fills in the date, who did it and the SHA-256 of the gate report at each stage.

Every criterion below reads a field of the Phase 1 gate report's `repositories[]` (the JSON of `pnpm graft gate report --phase 1`). Every command exists. The thresholds of stage 2 are the code's `RUNBOOK_STAGE2` constant (`src/pilot/gate-phase1.ts`), and a test checks that this page quotes them.

Graft never changes branch protection, rulesets, CODEOWNERS or repository settings, and nothing in a repository changes a mode. Every branch protection step below is a human step done by a repository admin. A repository moves between stages only through `pnpm graft mode set`.

Background: [the modes](../features/modes.md), [the policy](../features/policy.md), [the guard](../features/guard.md), [MCP](../features/mcp.md), [the gate](../features/pilots-and-gate.md#the-phase-1-gate), the [security review](../phase-1/reviews/step-7-security-review.md) and the Phase 0 [onboarding guide](onboarding.md).

## Roles

- **Operator.** Runs Graft and the CLI.
- **Repo admin.** Changes branch protection and repository settings.
- **Tech lead.** Classifies would-be failures and guard comments as "Graft right" or "Graft wrong".
- **Product owner.** Makes the go/no-go calls and the gate call.

## Stage 0: deployment ready (once per deployment)

All of these hold before any repository leaves stage 2:

1. Every process (server and workers) runs the Phase 1 step 7 build. Until then, lower `GRAFT_MODE_CEILING` only with a full stop (see [modes, rolling back](../features/modes.md#rolling-back)).
2. `GRAFT_MODE_CEILING=report` on every process.
3. `GITHUB_APP_SLUG` is set on the server.
4. The manifest is chosen: the full manifest for any repository that will reach stage 4, the report manifest otherwise.
5. `/mcp` is behind the proxy, over HTTPS, and `GRAFT_TRUST_PROXY` lists the proxy's addresses ([configuration](../configuration.md)).
6. The HUMAN-TODO smoke tests and real-GitHub checks of steps 2 to 6 are done and recorded ([HUMAN-TODO](../phase-1/HUMAN-TODO.md)), including:
   - the step 3 label-lag measurement and whether the issue events API serves `Link: rel="last"` (step 7, D11: a PR with more than 1,000 issue events cannot be break-glassed);
   - the step 4 review 2, finding B check (two workflows with the same job name);
   - the step 5 T1 (b) check: `sha: null` on a directory entry in `POST …/git/trees`.

**No-go:** any of them open.

## Stage 1: install in report mode (day 0)

1. Phase 0 onboarding §1 to §7 ([onboarding](onboarding.md)).
2. Extract the review-time baseline of the 12 weeks before day 0:

   ```sh
   pnpm graft baseline --repo <owner/repo> --from <day 0 − 12 weeks> --to <day 0>
   ```

3. Record the incidents of that period:

   ```sh
   pnpm graft incident add --repo <owner/repo> --pr <n> --occurred-at <ISO date>
   ```

4. Create the labels `graft:break-glass` and `graft:revert` (repo admin).
5. Check the modes: every mode is `report`.

   ```sh
   pnpm graft mode show --repo <owner/repo>
   ```

6. Check the deployment: no FAIL.

   ```sh
   pnpm graft pilot doctor --installation <id>
   ```

7. Tell the team what the would-be line on `graft/policy` and the guard comments mean.

## Stage 2: watch (at least 14 days and at least 30 merged PRs)

Weekly:

```sh
pnpm graft gate report --phase 1 --installation <id> --since <day 0> --out <dir>
```

The tech lead opens every PR counted in `repositories[].wouldFailAtMerge.total` (by reason in `repositories[].wouldFailAtMerge.byReason`) and every guard comment, and classifies each one:
- **Graft right:** the policy says what the team wants and the PR really lacked it;
- **Graft wrong:** the policy is misconfigured, or Graft has a defect.

Before stage 3 the team also encodes in `graft.yaml` any CODEOWNERS approval rule it relies on, because stage 3 drops CODEOWNERS review.

**Go to stage 3** when all of these hold:

1. `repositories[].merged.total ≥ 30`, and the report window is at least 14 days.
2. `repositories[].wouldFailAtMerge.total / repositories[].merged.total ≤ 0.10`, and no "Graft wrong" case among the PRs of the last 7 days (`repositories[].last7.total` of them).
3. `repositories[].last7.invalidOrMissingPolicy = 0`.
4. If the policy names a team: `members: read` is granted (`pnpm graft mode show --repo <owner/repo>` prints no teams note), and no `would_fail` with reason `approvals_missing` in `repositories[].last7` was caused by an unverified team (read it in the check details).
5. `pnpm graft pilot doctor --installation <id>`: no FAIL, and no WARN in `modes`, `permissions`, `teams` or `public_enforce`.
6. The repository does not use a merge queue, and it is private or internal: `repositories[].private` is `true`. A public repository stays in report mode in Phase 1 (step 7, D10).
7. The team has named who may use `graft:break-glass`.

**No-go:** fix the policy or report the defect. The last 7 days must then meet criteria 2 and 3 again.

## Stage 3: enforce `policy_mode`

In this order:

1. **Operator, once per deployment.** Set `GRAFT_MODE_CEILING=enforce` while **no repository requests enforce** (so raising it changes nothing). Restart every process. Check that `pnpm graft mode show --repo <owner/repo>` prints the ceiling `enforce` from the worker.
2. **Repo admin.** Make `graft/policy` a required status check with **the Graft App as the expected source**. Keep the existing required reviewers.
3. **Operator.**

   ```sh
   pnpm graft mode set --repo <owner/repo> --policy enforce --reason "pilot stage 3"
   ```

   Within about a minute `pnpm graft mode show --repo <owner/repo>` says `effective enforce` (`repositories[].modes.policy.effective`), and an open PR's `graft/policy` is `success` or `failure`.
4. **Two working days with both protections.** Go to 5 when every `failure` the team reported was explained by the policy, and no check stayed `in_progress` past the card wait.
5. **Repo admin.** Drop "Require approvals" and "Require review from Code Owners" from branch protection. `graft/policy` now counts the approvals.
6. **Watch 14 days** (from `repositories[].enforceSince.policy`). **Stay** while:
   - no merged PR is classified by the tech lead as approved by Graft when the policy should have required a human;
   - at most 1 incident is linked to a PR of class `auto` in the stage (`repositories[].incidentsOnAuto`);
   - `repositories[].mergedWhileFailing = 0`, unless each one was a deliberate admin bypass.

### Rollback of stage 3

On any no-go above, or on request. **The order matters**, because a `neutral` check passes a required check on GitHub:

1. **Repo admin.** Restore "Require approvals" (and Code Owners review if it was used).
2. **Operator.**

   ```sh
   pnpm graft mode set --repo <owner/repo> --policy report --reason "rollback: <why>"
   ```

   Check `pnpm graft mode show --repo <owner/repo>`, and that open PRs are `neutral` within about a minute.
3. Leave `graft/policy` required, or remove it: `neutral` passes either way.

### Emergency

Graft is down, or every check is stuck `in_progress`:

1. **Repo admin.** Restore the required reviewers, and remove `graft/policy` from the required checks.
2. **Operator.** Roll back as above, or for every repository at once set `GRAFT_MODE_CEILING=report` and restart. Once every process runs the step 7 build, a rolling restart is safe (step 7, D2): the first new worker's start lowers every process.

## Stage 4: enforce `guard_mode` (not before 14 days in stage 3)

Prerequisites:
- the full manifest with `contents: write` is accepted, then:

  ```sh
  pnpm graft mode refresh-permissions --installation <id>
  ```

- "Automatically delete head branches" is on;
- the default branch has required checks, so revert PRs are tested;
- in stages 2 and 3, no guard comment classified "Graft wrong" in the last 14 days. `repositories[].guard.missed` and `repositories[].guard.caught` are not criteria: a quiet default branch is fine.

Then:

```sh
pnpm graft mode set --repo <owner/repo> --guard enforce --reason "pilot stage 4"
```

**Stay** while no revert PR blames the wrong PR.

**Rollback:**

```sh
pnpm graft mode set --repo <owner/repo> --guard report --reason "rollback: <why>"
```

Close unwanted open revert PRs by hand and turn off their auto-merge in the GitHub UI: Graft never disables it. Deployment-wide: `GRAFT_GUARD_REVERT=off` and a restart.

## Stage 5: auto-merged reverts (optional, step 7 D12)

Only after 14 days in stage 4 with `repositories[].guard.caught ≥ 3` and no wrong revert. Only `guard.auto_merge_reverts: [trivial]`, added to `graft.yaml` in a reviewed PR. Only if changes to `.github/workflows/` require a review (CODEOWNERS or a ruleset) and "Allow auto-merge" is on.

**Rollback:** remove the key in a reviewed PR.

## Stage 6: `mcp_write` (optional, any time after stage 3)

1. Tokens go only to agents that already have read access to the repository, one per repository:

   ```sh
   pnpm graft mcp-token create --repo <owner/repo> --name "<agent>"
   ```

2. The agents use the reads for at least 7 days.
3. The agents that will call `open_change` sign their commits (step 7, D8): otherwise no approval on their PRs counts.
4. Then:

   ```sh
   pnpm graft mode set --repo <owner/repo> --mcp-write on --reason "pilot stage 6"
   ```

**Rollback:**

```sh
pnpm graft mode set --repo <owner/repo> --mcp-write off --reason "rollback: <why>"
```

A leaked token:

```sh
pnpm graft mcp-token revoke --id <token id> --reason "leaked"
```

Deployment-wide: `GRAFT_MCP=off` and a restart.

## Gate review (weekly, product owner and operator)

Per pilot repository:

```sh
pnpm graft baseline --period phase1 --repo <owner/repo> --from <since> --to <until>
```

Then, for all five pilots:

```sh
pnpm graft gate report --phase 1 --installation <id 1> --installation <id 2> --since <since> --out <dir>
```

Read the gate verdict, the preview and the per-repository table. The calling rule is in [HUMAN-TODO](../phase-1/HUMAN-TODO.md#step-7-security-review-pilots-and-gate).

## The stage record

Copy this table into the pilot's record (outside git), once per repository.

| Stage | Date | Who | Gate report SHA-256 | Go / no-go and why |
| --- | --- | --- | --- | --- |
| 0 deployment ready | | | | |
| 1 report mode | | | | |
| 2 watch | | | | |
| 3 policy enforce | | | | |
| 3 rollback (if any) | | | | |
| 4 guard enforce | | | | |
| 5 auto-merged reverts | | | | |
| 6 mcp_write | | | | |
