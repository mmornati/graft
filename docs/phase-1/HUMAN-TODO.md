# Phase 1: human to-do

Things only a person can do. The developer agent never ticks these. Each item names who does it.

## Step 1: modes

- [ ] **Leave `GRAFT_MODE_CEILING` unset (report)** on every deployment until the Phase 1 rollout runbook says otherwise. Who: operator.
- [ ] **Decide which manifest each deployment uses.** Evaluation-only deployments register `github/app-manifest.report.json`. Who: product owner.
- [ ] **Run `pnpm graft mode refresh-permissions --installation <id>`** once per existing installation after deploying step 1, then `pnpm graft mode show --installation <id>` and check the permissions line. Who: operator.
- [ ] **On a sandbox PR**, check that the `graft/policy` check details start with the "Graft mode: report" line and the check is still `neutral`; then `mode set --policy enforce` with the ceiling at `report` and confirm `show` reports `effective report  ceiling`. Who: repo owner.
