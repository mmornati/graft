# Modes: report and enforce

[Docs index](../README.md) · [Configuration](../configuration.md) · [Phase 1 plan](../phase-1/README.md)

Every repository has modes that decide whether Graft only **reports** or may **change outcomes** on GitHub. Report is the default: with default modes every Graft check concludes `neutral`, exactly as in Phase 0. Since Phase 1 step 2, a repository whose effective `policy_mode` is `enforce` gets a `graft/policy` check that concludes `success` or `failure` (see [Policy, enforce mode](policy.md#enforce-mode)). This page is about the switches and the safety rails.

## The three keys

| Key | Values | Default | Needs on the installation |
| --- | --- | --- | --- |
| `policy_mode` | `report`, `enforce` | `report` | nothing beyond Phase 0 (without `members: read`, team constraints fail) |
| `guard_mode` | `report`, `enforce` | `report` | `contents: write` |
| `mcp_write` | `off`, `on` | `off` | `pull_requests: write` |

- **report** (and `off`): Graft computes and shows what it would do. It makes the same GitHub writes as in Phase 0 (check runs and the managed comment) and nothing else.
- **enforce** (and `on`): a feature may act. `policy_mode: enforce` publishes the enforce conclusion on `graft/policy` (`success`, `failure`, or `in_progress` while the intent card is written). It blocks a merge only if branch protection makes `graft/policy` a required check. `guard_mode` and `mcp_write` have no feature behind them yet.

## Who sets a mode

Only the operator. A mode can **not** be set from `graft.yaml` (a `mode` key there is still an `unknown_key` error), a label, a PR description, an API or a web page: the people who merge to a repository are the people `graft/policy` gates.

Two things must agree before a repository is enforced:

1. The server ceiling `GRAFT_MODE_CEILING` (`report` or `enforce`, default `report`) in the worker's environment. With `report`, no repository on the deployment can enforce anything, whatever the database says.
2. The repository's own request, set with `pnpm graft mode set` against the database, which writes an audit row.

The **effective** mode is the lower of the two, lowered further when the installation lacks a permission the mode needs, when the installation is suspended or deleted, or when the repository was removed. It always fails toward report.

## The CLI

```sh
pnpm graft mode show --repo acme/payments
pnpm graft mode show --installation 45 --json
pnpm graft mode set --repo acme/payments --policy enforce --reason "pilot week 3"
pnpm graft mode set --repo acme/payments --policy report --reason "rollback"
pnpm graft mode history --repo acme/payments --limit 5
pnpm graft mode refresh-permissions --installation 45
```

`show` prints each repository like this:

```
acme/payments (repository 123, installation 45)
  ceiling    report  (worker: report since 2026-10-20T10:00:00Z)
  policy     requested enforce  effective report   ceiling
  guard      requested report   effective report
  mcp_write  requested off      effective off
  permissions  checks:write contents:read issues:read metadata:read pull_requests:write  (read 2026-10-20T03:30:00Z)
  pending    1 change not yet applied by the worker
```

- `set` needs `--reason` (1 to 200 printable characters on one line) and at least one of `--policy`, `--guard`, `--mcp-write`. `--actor` defaults to your login name. Both are stored in the audit table and never sent to GitHub. Setting a key to the value it already has changes nothing and prints `no change`.
- `set` never refuses a value because of the ceiling or the permissions: it records the request, and `show` explains why it is not effective.
- The ceiling in `show` is the one the **worker** published at its last start. If your shell's `GRAFT_MODE_CEILING` differs, `show` warns and still uses the worker's.

## Rolling back

```sh
pnpm graft mode set --repo acme/payments --policy report --reason "rollback"
```

The CLI only writes the request. The worker's `modes.apply` job (every minute by default, `GRAFT_MODE_APPLY_CRON`) picks it up and re-evaluates every open PR of the repository, so each `graft/policy` check is republished within about a minute plus the stagger of the fan-out (5 seconds per ten PRs, at most 100 PRs), without a webhook. Changing `GRAFT_MODE_CEILING` and restarting the worker does the same for every repository.

**Lowering the ceiling needs a full stop, not a rolling restart.** Each worker trusts its own environment's ceiling. During a rolling deploy that lowers `GRAFT_MODE_CEILING` to `report`, an old worker still running with `enforce` can publish a `success` or `failure` after the new worker has republished `neutral`, and that conclusion stays until the PR's next trigger. Stop every worker, then start the new ones.

## "Requested but not effective"

`show` prints a reason after the effective value when it differs from the request:

| Reason | Meaning |
| --- | --- |
| `ceiling` | `GRAFT_MODE_CEILING` is `report`. |
| `permission_missing contents:write` | The installation has a lower level than the mode needs. The App owner has to accept the new permissions. |
| `permissions_unknown` | Permissions were never read. Run `pnpm graft mode refresh-permissions --installation <id>`. |
| `installation_inactive` | The installation is suspended or deleted. |
| `repository_removed` | The repository was removed from the installation. |

Installation permissions are read from the GitHub API (`GET /app/installations/{id}` with the App JWT), never from a webhook payload: on `installation.created`, on `installation.new_permissions_accepted`, once a day (`GRAFT_PERMISSIONS_REFRESH_CRON`) and on demand. `pnpm graft pilot doctor` warns when the permissions were not read in the last 48 hours and when a requested mode is not effective.

## What reviewers see

The first line of the `graft/policy` check details (its `output.text`) names the mode:

- `Graft mode: report. This check never blocks a merge.`
- `Graft mode: enforce. This check passes or fails on this policy; a passing check is not a review approval.`

In report mode the title is the Phase 0 one (`Would require …`) and the policy section adds a line saying what enforce mode would conclude, for example ``**In enforce mode this check would be:** `failure`, needs 1 more approval from `@acme/security`.`` In enforce mode the title is the conclusion itself (`Policy satisfied: required approvals present`, `Needs 1 more approval from @acme/security`, …) and the section footer reads `Graft mode: enforce. This check is required only if branch protection says so.`

`pnpm graft mode show` adds `note: team constraints cannot be verified (no members:read); they will fail` when a repository enforces policy and its installation has not granted (or Graft has not read) `members: read`, and `pnpm graft pilot doctor` warns about it (`teams`).

## The mutation guard

Every installation client refuses, before sending, any write that is not on an explicit allow-list ([`src/github/mutation-guard.ts`](../../src/github/mutation-guard.ts)). The Phase 0 writes (check runs and the managed comment) are always allowed, as long as a check run is `completed` and `neutral`. A check-run write with any other status or conclusion is a Phase 1 write: it is allowed only for `graft/policy`, only from the policy job's own client, and only while the repository's effective `policy_mode` is `enforce`. Intent and provenance can never block a merge, by construction. The routes later steps need (revert branches and PRs, labels) are declared there but belong to a feature, and a request is sent only by a client made for that feature **and** while the repository's effective mode permits it, read from the database at the time of the request. Everything else, GraphQL included, is refused in every mode. A refused write fails the job with `mutation_refused` and is logged at `error`.

## Transfers and re-added repositories

When a repository moves to another installation, or comes back after it was removed from the App, its three modes return to report/report/off. Each key that changed gets a `mode_changes` row with actor `system` and reason `installation changed` or `repository re-added`, which `mode history` shows like any other, and the worker republishes the check. An `enforce` set for one owner never follows the repository to another. A rename within the same installation keeps the modes.

## Report-only deployments

`github/app-manifest.report.json` is the permission set for a deployment that only ever evaluates Graft: the same as the full manifest in this version, and in later steps without `contents: write`. See [GitHub App](../github-app.md#which-manifest).
