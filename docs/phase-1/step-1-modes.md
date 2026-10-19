# Phase 1, Step 1: Modes and safety rails

Spec for the developer agent. Implement exactly this. Where it is silent, choose the simplest option and record it in [docs/decisions.md](../decisions.md) under a new heading "Phase 1 step 1: modes". The [Phase 0 constraints](../phase-0/README.md#constraints-for-every-step) are binding: offline build and test, Postgres from `docker compose`, **no stored code, diffs or file contents**, pnpm, Node 24, strict TypeScript. The code as it is after Phase 0 is described in [docs/architecture.md](../architecture.md) and [docs/decisions.md](../decisions.md); where this spec and those documents disagree on an existing interface, they win and you record the difference. The plan for the whole phase is [phase-1/README.md](README.md).

Binding rules from earlier steps:
- **Payloads are triggers** ([architecture.md](../architecture.md#webhook-replay)): handlers validate the payload and enqueue a job. Jobs write only from API data or from data Graft computed. This step reads installation permissions from the API, never from the webhook payload.
- **Lock discipline**: no slow work inside `withChangeLock`.
- **Spec fix 1** (development plan): a passing `graft/policy` check is not a human approval.
- **This step enforces nothing.** Whatever the modes say, every Graft check still concludes `neutral` at the end of step 1. The enforce conclusions arrive in step 2.

## 1. Goal

Put the switches and the rails in place before any Phase 1 feature exists, so that every later step is born in report mode and provably inert there:

- **Modes.** Per repository: `policy_mode` and `guard_mode` (`report` | `enforce`) and `mcp_write` (`off` | `on`), all defaulting to report/off. A server ceiling `GRAFT_MODE_CEILING` (`report` | `enforce`, default `report`). The effective mode is the lower of the two, lowered further when the installation lacks a permission the mode needs (§6).
- **Operator CLI.** `pnpm graft mode show|set|history|refresh-permissions`. `set` writes an audit row. Nothing in a repository (`graft.yaml`, labels, PR text) can change a mode (D1).
- **Applying a change.** A worker cron picks up new mode changes and re-evaluates the policy of the repository's open PRs, so a rollback to `report` is republished within minutes without a webhook (D6).
- **Mutation guard.** Every installation Octokit client refuses, before sending, any non-GET request that is not on an explicit allow-list. Phase 0 writes are always allowed; Phase 1 writes need a feature-scoped client and an effective mode that permits them (§7).
- **Permissions.** Installation permissions are read from the API and stored, so features can ask "does this installation have `contents: write`?" without a failing request (T5).
- **Neutral regression suite.** One integration test drives every Phase 0 flow with default modes and with every mode at its maximum, and asserts that the set of GitHub writes is exactly the Phase 0 set and every check is `neutral` (T10). Later steps add a scenario per feature.
- **Report manifest.** `github/app-manifest.report.json`, the permission set for deployments that only ever evaluate Graft (T11).

## 2. Out of scope

Do not create stub code for any of these.

- Any conclusion other than `neutral`, the "In enforce mode this check would be …" line, and `enforced_conclusion` (step 2).
- Team membership, `members: read`, stale approval rules, break-glass, audit of approvals (steps 2 and 3).
- Guard detection, revert PRs, the `actions`, `statuses` and `contents: write` permissions (steps 4 and 5). This step only **declares** their routes in the guard's table (§7.2) so they are refused today.
- The MCP server and its tokens (step 6). `mcp_write` exists as a stored switch only.
- Setting a mode from `graft.yaml`, a label, an API or a web page (D1).
- Changing branch protection, or any GitHub write that Phase 0 does not already make.
- A web UI for modes.

## 3. Decisions

| # | Area | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | Who sets modes | Only the operator: `GRAFT_MODE_CEILING` in the worker's environment, and `pnpm graft mode set` against the database. `graft.yaml` has no mode key; a `mode` key there stays `unknown_key`. | The people who merge to a repository are the people `graft/policy` gates. Turning enforcement on is an operator decision with an audit trail. |
| D2 | Combining | Effective = min(ceiling, requested), then lowered to report/off when a required permission is missing or unknown, the installation is inactive, or the repository is removed. Order `report < enforce`, `off < on`. The ceiling also caps `mcp_write` (`report` ceiling ⇒ `off`). | One rule, always fails toward report. |
| D3 | Values | Text columns with CHECK constraints, not booleans, for all three keys, so the audit table stores `from`/`to` uniformly. | Uniform history; room for a later value without a type change. |
| D4 | Permission needs | `guard_mode: enforce` needs `contents: write`; `mcp_write: on` needs `pull_requests: write`; `policy_mode: enforce` needs nothing beyond Phase 0 in this step (step 2 adds `members: read` for team constraints, not for the mode). A permission set never read (`permissions_read_at` null) counts as missing. | Each feature knows exactly what it needs; an installation that has not accepted new permissions keeps working in report mode. |
| D5 | Permissions source | `GET /app/installations/{id}` with the App JWT, on `installation.created`, `installation.new_permissions_accepted`, a daily cron, and `pnpm graft mode refresh-permissions`. Only known permission names with values `read`/`write`/`admin` are stored. | Payloads are triggers. A daily refresh catches a permission removed by an org owner. |
| D6 | Applying changes | The CLI never enqueues (the ops CLI has no queue, step 6 D9). It writes a `mode_changes` row with `applied_at = NULL`. The worker cron `modes.apply` (default every minute) claims unapplied rows with `FOR UPDATE SKIP LOCKED`, fans out `policy.evaluate` for the open PRs of each repository whose `policy_mode` changed, and stamps `applied_at`. | Keeps the CLI queue-free; a rollback reaches GitHub within about a minute plus the fan-out stagger. |
| D7 | Ceiling changes | At worker start, a compare-and-set on `service_state('mode_ceiling')`. If the stored value existed and differs, the worker enqueues one repository fan-out per active repository. Only one of several starting workers wins the update. | The ceiling lives in the environment; a restart is the only way it changes, and the database remembers what was published. |
| D8 | Mode in the facts hash | The policy job adds the effective `policy_mode` to its `factsHash` and stores it in `policy_verdicts.policy_mode`. | Without it, a mode change leaves the facts hash equal and the job answers `unchanged` without republishing. |
| D9 | Visible effect in step 1 | One line at the top of the `graft/policy` check `output.text` (§9). The PR comment and the check title do not change. The conclusion stays the literal `neutral`. | Reviewers see which mode applies; nothing else changes until step 2. |
| D10 | Guard design | An allow-list of write routes, classified as `auth`, `phase0` or a Phase 1 route with the features allowed to use it. Unknown write routes are refused in every mode. GET and HEAD always pass. | A new write must be added to the table on purpose, with a test. |
| D11 | Feature-scoped clients | Phase 1 writes need `ctx.github.forInstallation(id, { feature })` (`"guard"` or `"mcp"`). The default client (no feature) can make only `auth` and `phase0` writes. The same route can belong to several features (`POST /pulls`: guard and mcp). | Route alone cannot tell a revert PR from an MCP `open_change`; the caller must say which feature it acts for. |
| D12 | Gate freshness | A Phase 1 write reads the effective mode from the database at request time; no cache. Phase 0 writes never query the database. | A rollback takes effect on the next request; Phase 0 hot paths stay as fast as today. |
| D13 | Refusal | `MutationRefusedError extends PermanentJobError`, code `mutation_refused`, message names the method, the route template, the feature and the reason, never the body or the expanded URL. Logged at `error`. | A job that tries a forbidden write fails visibly and is not retried. |
| D14 | Route matching | The hook computes the method and path with `octokit.request.endpoint.parse(options)` and matches the path (no query string) against anchored regexes. `/graphql` is refused in this step (Graft makes no GraphQL calls; step 5 adds `enablePullRequestAutoMerge` by operation name). | Works for `octokit.rest.*`, `octokit.request("POST /…")` and `paginate` alike; T1 verifies the API. |
| D15 | Actor and reason | `mode set` requires `--reason` (1 to 200 printable characters, no newline). `--actor` defaults to `os.userInfo().username`, must match `^[A-Za-z0-9._@-]{1,64}$`. Both are stored in `mode_changes` and never sent to GitHub. | An audit row that says who and why; operator text only, no PR content. |
| D16 | Purge | `mode_changes` belongs to an installation through `repositories` and is covered by `pilot purge`. `service_state` holds no installation data and joins `pilot_purges` in the purge type's exclusion list, with a comment saying why. | The purge map stays exhaustive (I-PURGE-2). |
| D17 | Manifests | Two manifests: `app-manifest.json` (full) and `app-manifest.report.json`. In step 1 both carry the Phase 0 permissions; later steps add read permissions to both and `contents: write` to the full one only. U-MAN-2 asserts the report manifest never has a write permission other than `checks` and `pull_requests`. | An evaluating deployment cannot be enforced on, by construction. |

## 4. Files

New:

| File | What |
| --- | --- |
| `src/modes/index.ts` | Pure: types, `effectiveModes()`, `PERMISSION_NEEDS`, `lowest()`. No `db`, no `github`. |
| `src/modules/modes/store.ts` | Read the repository's requested modes and the installation's permissions; insert and claim `mode_changes`; `service_state` compare-and-set. |
| `src/modules/modes/jobs.ts` | `modes.apply` (cron), `modes.ceiling_fanout`, `installations.refresh_permissions`. |
| `src/modules/modes/index.ts` | Module exports: `jobs`, `getEffectiveModes(db, repositoryId, config)`, `mutationGate(db, config)`. |
| `src/github/mutation-guard.ts` | Route table (§7.2), `classifyWrite()`, `installMutationGuard()`, `MutationRefusedError`. |
| `src/db/migrations/0008_modes.ts` | §5. |
| `test/integration/neutral.test.ts` | The neutral regression suite (T10). |
| `test/unit/modes.test.ts`, `test/unit/mutation-guard.test.ts` | §11. |
| `test/integration/modes.test.ts` | §11. |
| `github/app-manifest.report.json` | T11. |
| `docs/features/modes.md` | User-facing page (T12). |
| `docs/phase-1/HUMAN-TODO.md` | §12. |

Changed: `src/config/index.ts`, `src/db/schema.ts`, `src/db/migrations/index.ts`, `src/github/client-factory.ts`, `src/bin/bootstrap.ts`, `src/bin/worker.ts`, `src/bin/graft.ts`, `src/bin/graft-ops.ts`, `src/app/registry.ts`, `src/app/crons.ts`, `src/modules/installations/handlers.ts`, `src/modules/policy/job.ts`, `src/modules/policy/render.ts`, `src/modules/policy/store.ts`, `src/pilot/purge.ts`, `src/pilot/doctor.ts`, `test/unit/manifest.test.ts`, the test GitHub fakes as needed, and the docs in T12.

## 5. Schema (migration `0008_modes`)

```sql
ALTER TABLE repositories
  ADD COLUMN policy_mode text NOT NULL DEFAULT 'report' CHECK (policy_mode IN ('report','enforce')),
  ADD COLUMN guard_mode  text NOT NULL DEFAULT 'report' CHECK (guard_mode  IN ('report','enforce')),
  ADD COLUMN mcp_write   text NOT NULL DEFAULT 'off'    CHECK (mcp_write   IN ('off','on'));

ALTER TABLE installations
  ADD COLUMN permissions         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN permissions_read_at timestamptz;

CREATE TABLE mode_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  key           text NOT NULL CHECK (key IN ('policy_mode','guard_mode','mcp_write')),
  from_value    text NOT NULL,
  to_value      text NOT NULL,
  actor         text NOT NULL CHECK (actor ~ '^[A-Za-z0-9._@-]{1,64}$'),
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz,
  CHECK (from_value <> to_value)
);
CREATE INDEX mode_changes_repo_idx ON mode_changes (repository_id, created_at DESC);
CREATE INDEX mode_changes_unapplied_idx ON mode_changes (created_at) WHERE applied_at IS NULL;

CREATE TABLE service_state (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z_]{1,64}$'),
  value      text NOT NULL CHECK (char_length(value) <= 200),
  updated_at timestamptz NOT NULL
);

ALTER TABLE policy_verdicts
  ADD COLUMN policy_mode text NOT NULL DEFAULT 'report' CHECK (policy_mode IN ('report','enforce'));
```

`down` drops exactly what `up` adds, in reverse order. `mode_changes` rows with `key = 'policy_mode'` also CHECK `to_value IN ('report','enforce')`, `mcp_write` rows `IN ('off','on')` (one CHECK per key, or a single CASE expression).

## 6. Effective modes (`src/modes/index.ts`)

```ts
export type Mode = "report" | "enforce";
export type Switch = "off" | "on";
export type ModeKey = "policy_mode" | "guard_mode" | "mcp_write";

export type ModeReason =
  | "repository"           // effective = requested
  | "ceiling"              // lowered by GRAFT_MODE_CEILING
  | "permission_missing"   // a needed permission is absent or too low
  | "permissions_unknown"  // permissions never read
  | "installation_inactive"
  | "repository_removed";

export interface ModeState<V> { requested: V; effective: V; reason: ModeReason; missing?: string } // missing: "contents:write"
export interface EffectiveModes {
  ceiling: Mode;
  policy: ModeState<Mode>;
  guard: ModeState<Mode>;
  mcpWrite: ModeState<Switch>;
}

export const PERMISSION_NEEDS = {
  policy_mode: [],
  guard_mode: [["contents", "write"]],
  mcp_write: [["pull_requests", "write"]],
} as const;

export function effectiveModes(input: {
  ceiling: Mode;
  requested: { policy_mode: Mode; guard_mode: Mode; mcp_write: Switch };
  permissions: Readonly<Record<string, "read" | "write" | "admin">> | null; // null: never read
  installationActive: boolean;
  repositoryActive: boolean;
}): EffectiveModes;
```

Rules, applied per key in this order; the first that lowers the value sets `reason`:

1. Installation inactive (suspended or deleted) → report/off, `installation_inactive`.
2. Repository removed → report/off, `repository_removed`.
3. Requested is already report/off → report/off, `repository`.
4. Ceiling is `report` → report/off, `ceiling`.
5. A permission in `PERMISSION_NEEDS[key]` is missing: `permissions === null` → `permissions_unknown`; otherwise a level below the need (`read < write < admin`) → `permission_missing` with `missing = "<name>:<level>"`.
6. Otherwise effective = requested, `repository`.

`getEffectiveModes(db, repositoryId, config)` reads the repository, its installation and `config.modeCeiling` and calls `effectiveModes`. An unknown repository id throws.

## 7. Mutation guard (`src/github/mutation-guard.ts`)

### 7.1 Behaviour

```ts
export type Feature = "guard" | "mcp";
export type WriteClass =
  | { kind: "read" }
  | { kind: "auth" }
  | { kind: "phase0" }
  | { kind: "phase1"; features: readonly Feature[]; owner: string; repo: string }
  | { kind: "unknown" };

export function classifyWrite(method: string, path: string): WriteClass;

export type MutationGate = (q: {
  installationId: number; owner: string; repo: string; feature: Feature;
}) => Promise<{ allowed: true } | { allowed: false; reason: string }>;

export function installMutationGuard(octokit: GitHubClient, o: {
  installationId: number | null;   // null for the App-JWT client
  feature: Feature | undefined;
  gate: MutationGate;
}): void;
```

`installMutationGuard` registers a `hook.before("request")` that:

1. Computes `{ method, url } = octokit.request.endpoint.parse(options)` and takes the URL's pathname, with the API base path prefix removed (GitHub Enterprise `…/api/v3`).
2. `GET`/`HEAD` → pass.
3. `auth` → pass.
4. `phase0` → pass only when `installationId !== null`.
5. `phase1` → refuse unless `o.feature` is set **and** in the route's `features` **and** `await gate({ installationId, owner, repo, feature })` allows it.
6. `unknown` → refuse.

A refusal throws `MutationRefusedError` (D13) with `reason` one of `unknown_route`, `no_feature`, `feature_not_allowed`, `mode_report`, `mode_off`, `repository_unknown`, `app_client`.

`mutationGate(db, config)` (in `src/modules/modes`) resolves the repository by installation id and `owner/repo` (case-insensitive on `full_name`, active rows only; none → `repository_unknown`), then calls `getEffectiveModes` and maps the feature to its key: `guard` → `guard_mode` must be `enforce`; `mcp` → `mcp_write` must be `on`.

`createGitHubClientFactory` gains `gate: MutationGate` and `forInstallation(id, opts?: { feature?: Feature })`. Every client it returns, `asApp()` included (`installationId: null`), has the guard installed. `forToken` clients are unchanged (the e2e runner has its own sandbox hook). Callers that build the factory (`bootstrap.ts`, `graft-ops.ts`, `eval/export.ts`) pass the gate; `eval/export.ts` and `asApp` uses never write, so a gate that always refuses is acceptable there.

### 7.2 Route table

Paths below use `{o}/{r}` for `owner/repo` (`[A-Za-z0-9_.-]{1,100}`), `{n}` for digits, and are anchored at both ends.

| Class | Method | Path | Used by |
| --- | --- | --- | --- |
| auth | POST | `/app/installations/{n}/access_tokens` | Installation tokens (if the auth strategy's request passes the hook; T1 records whether it does). |
| phase0 | POST | `/repos/{o}/{r}/check-runs` | provenance, intent, policy |
| phase0 | PATCH | `/repos/{o}/{r}/check-runs/{n}` | provenance, intent, policy |
| phase0 | POST | `/repos/{o}/{r}/issues/{n}/comments` | managed comment |
| phase0 | PATCH | `/repos/{o}/{r}/issues/comments/{n}` | managed comment |
| phase1 [guard] | POST | `/repos/{o}/{r}/git/trees` | step 5 revert |
| phase1 [guard] | POST | `/repos/{o}/{r}/git/commits` | step 5 revert |
| phase1 [guard] | POST | `/repos/{o}/{r}/git/refs` | step 5 revert branch |
| phase1 [guard] | DELETE | `/repos/{o}/{r}/git/refs/heads/graft-revert/…` | step 5 cleanup; only refs under `heads/graft-revert/` |
| phase1 [guard] | POST | `/repos/{o}/{r}/issues/{n}/labels` | step 5 `graft:revert` label |
| phase1 [guard, mcp] | POST | `/repos/{o}/{r}/pulls` | step 5 revert PR, step 6 `open_change` |

Anything else that is not GET/HEAD is `unknown`, `/graphql` included. A new write route is added to this table by the step that needs it, together with a U-MG case.

## 8. Operator CLI

Added to `src/bin/graft-ops.ts` as the group `mode` (and to `OPS_GROUPS` and the usage text in `src/bin/graft.ts`). Same conventions as the other ops commands: `.env` and config are loaded, pending migrations exit 2, terminal-safe output, exit codes 0 ok / 1 failed / 2 usage or config.

```
graft mode show (--repo <owner/repo> | --installation <id>) [--json]
graft mode set --repo <owner/repo> [--policy report|enforce] [--guard report|enforce] [--mcp-write off|on]
               --reason "<text>" [--actor <name>]
graft mode history --repo <owner/repo> [--limit <1..200, default 20>] [--json]
graft mode refresh-permissions --installation <id>
```

- **`show`** prints, per repository (lines shown literally; values aligned with spaces):

  ```
  acme/payments (repository 123, installation 45)
    ceiling    report  (worker: report since 2026-10-20T10:00:00Z)
    policy     requested enforce  effective report   ceiling
    guard      requested report   effective report
    mcp_write  requested off      effective off
    permissions  checks:write contents:read issues:read metadata:read pull_requests:write  (read 2026-10-20T03:30:00Z)
    pending    1 change not yet applied by the worker
  ```

  The ceiling used for `effective` is the worker's (`service_state.mode_ceiling`). If that is absent the CLI's own config is used and the line says `(worker: not seen; using this shell's GRAFT_MODE_CEILING)`. If both exist and differ, add a line `warning: this shell's GRAFT_MODE_CEILING is <x>; the worker runs with <y>` and still exit 0. A `missing` permission prints after the reason: `permission_missing contents:write`. The `pending` line appears only when unapplied rows exist. `--json` prints `{ repositories: [{ fullName, repositoryId, installationId, ceiling, ceilingSource, policy, guard, mcpWrite, permissions, permissionsReadAt, pendingChanges }] }`.
- **`set`** needs at least one of `--policy`, `--guard`, `--mcp-write` (else usage, exit 2) and an active repository (else `unknown or removed repository`, exit 1). In one transaction it locks the repository row, writes one `mode_changes` row per key whose value changes, and updates the columns. Unchanged keys write nothing; if nothing changes it prints `no change` and exits 0. It then prints the same block as `show`. When a requested value will not be effective, it adds `note: policy is requested enforce but effective report (ceiling)`. It never refuses a value because of the ceiling or permissions: the request is recorded, the effective mode explains itself.
- **`history`** lists `created_at  key  from → to  actor  applied|pending  reason`, newest first. The reason is printed terminal-safe.
- **`refresh-permissions`** runs the refresh of T5 inline for one installation and prints the stored permissions.

## 9. Policy job and rendering

- `evaluatePolicyJobRun` reads `getEffectiveModes` once, outside the lock, after the installation check. `factsHash` gains `policyMode: modes.policy.effective` (D8). `VerdictValues` and `upsertVerdict` gain `policyMode`.
- The `conclusion` stays the literal `"neutral" as const` with its existing comment. Do not read the mode near it.
- `renderPolicyDetails(view)` takes `view.mode: { effective: Mode }` and starts `output.text` with exactly one of:
  - `Graft mode: report. This check never blocks a merge.`
  - `Graft mode: enforce. Enforcement is not active in this version; this check never blocks a merge.` (replaced in step 2)

  followed by a blank line and the existing details. If the details are `null` today, they become this line alone. The summary (`renderPolicySection`) and title do not change.
- `POLICY_TRIGGERS` gains `"mode"`. `fanoutSchema` becomes a discriminated union on `scope`:
  - `{ scope: "branch", …existing fields }` (the push path, unchanged behaviour; existing jobs without `scope` are parsed as `"branch"`),
  - `{ scope: "repository", installationId, repositoryId, owner, repo, reason: "mode_change" | "ceiling_change", changeId: uuid | null }`: all open PRs of the repository, any base, same cap (`FANOUT_MAX`), order and stagger; trigger `"mode"`; singleton key `policy:mode:<repositoryId>:<pr>:<changeId ?? "ceiling-" + ceiling>`.

## 10. Tasks

### T1. Library verification

Confirm offline, in a scratch test, and record the answers in decisions.md: (a) `octokit.request.endpoint.parse(options)` inside `hook.before("request")` returns the expanded method and URL for `octokit.rest.checks.create`, `octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", …)` and `octokit.paginate`; (b) whether `@octokit/app`'s installation-token request passes through the installation client's `hook.before` (decides whether the `auth` row is reachable; keep it either way); (c) that a throw in `hook.before` rejects the call without a network request (the fake records nothing).

### T2. Config

`GRAFT_MODE_CEILING` (`report` | `enforce`, default `report`), `GRAFT_MODE_APPLY_CRON` (cron or `off`, default `* * * * *`), `GRAFT_PERMISSIONS_REFRESH_CRON` (cron or `off`, default `30 3 * * *`). Exposed as `config.modeCeiling`, `config.modeApplyCron`, `config.permissionsRefreshCron`. `.env.example` and `docs/configuration.md` list them. The worker logs `mode ceiling` with the value at start (info).

### T3. Migration and schema types

§5, plus `src/db/schema.ts` types (`ModeChangesTable`, `ServiceStateTable`, new columns) and `TABLE_NAMES`. Rollback test as in earlier steps.

### T4. Pure modes

`src/modes/index.ts` per §6. No imports from `db`, `github` or `modules` (checked by the definition-of-done grep).

### T5. Permissions refresh

Job `installations.refresh_permissions` `{ installationId }` (IDs only): `asApp().rest.apps.getInstallation({ installation_id })`; keep only names matching `^[a-z_]{1,64}$` with values in `read|write|admin`, at most 100 entries; write `permissions` and `permissions_read_at` (clock). 404 → mark nothing, log `installation_not_found` (the installation handler deals with deletion). Enqueued by `installations.track` on `created` and `new_permissions_accepted` (singleton per installation per minute), and by the daily cron for every active installation (staggered 2 s). The CLI command runs the same function inline.

### T6. Store and apply

- `insertModeChanges(tx, …)`, `claimUnappliedModeChanges(tx, limit 50)` (`FOR UPDATE SKIP LOCKED`, oldest first), `markApplied(tx, ids, at)`.
- `modes.apply` job (cron `GRAFT_MODE_APPLY_CRON`, registered in `src/app/crons.ts` with the same `off` handling as the others): claim rows; for each distinct repository with at least one `policy_mode` row, send one repository fan-out with `changeId` = the newest such row; mark every claimed row applied (guard and mcp rows have nothing to republish in this step). Fan-out jobs are sent inside the claiming transaction only if the queue supports it; otherwise send after commit and accept at-least-once (a repeated fan-out is harmless: unchanged verdicts publish nothing). Record which in decisions.md.
- `casServiceState(db, key, value, now)` returns the previous value or `null`, updating only when it differs, atomically (`INSERT … ON CONFLICT DO UPDATE … WHERE service_state.value <> EXCLUDED.value RETURNING` plus a read of the old value in the same statement or transaction).

### T7. Ceiling at worker start

In `src/bin/worker.ts`, after crons are scheduled: `prev = casServiceState("mode_ceiling", config.modeCeiling)`. If `prev !== null && prev !== config.modeCeiling`, enqueue `modes.ceiling_fanout`, which sends one repository fan-out (`reason: "ceiling_change"`) per active repository of an active installation, staggered 1 s. First start (`prev === null`): store only.

### T8. Mutation guard and factory

§7. `MutationRefusedError` in `src/github/mutation-guard.ts`, re-using the `PermanentJobError` contract. `bootstrap.ts` builds the gate from `mutationGate(db, config)`. No existing caller passes a `feature` in this step.

### T9. Policy job, render, purge, doctor

- §9.
- `src/pilot/purge.ts`: add `mode_changes` (through `repositories`) to the map; add `service_state` to the exclusion type with a one-line justification.
- `src/pilot/doctor.ts`: two new checks, both `warn`, never `fail`: "permissions not read in the last 48 h" (count of active installations) and "requested mode not effective" (count of repositories with requested ≠ effective, by reason). Doctor still reads only the database.

### T10. Neutral regression suite (`test/integration/neutral.test.ts`)

Built on the existing scenario helpers and the fake GitHub API's request log. For each **mode profile**:

- `default`: ceiling `report`, all repositories report/off;
- `max`: ceiling `enforce`, the repository `enforce`/`enforce`/`on`, permissions including `contents: write`;

run, in one test repository with a valid `graft.yaml`: installation created → PR opened (agent trailers) → intent card → policy → review approved → label added → push to the PR → push to `main` changing `graft.yaml` (fan-out) → `check_run.rerequested` → `requested_action` Accurate → feedback sweep → `pnpm graft mode set` (policy enforce, then back to report) → `modes.apply`.

Assert, for both profiles:

- **N-1** every non-GET request in the fake's log matches a `phase0` or `auth` row of §7.2;
- **N-2** every Graft check run created or updated has conclusion `neutral`;
- **N-3** no request was refused by the guard (the Phase 0 flows never try a Phase 1 write);
- **N-4** after `mode set`, the next `modes.apply` republishes the policy check (the `output.text` mode line changes) without any webhook;

and, in a separate case, **N-5**: a test-only job that calls `forInstallation(id, { feature: "guard" }).rest.git.createRef(…)` is refused with `mode_report` under `default`, is refused with `no_feature` through the default client under `max`, and reaches the fake under `max` with the feature client. The suite's file header says: "Every Phase 1 step adds its feature to this suite in report mode. A failure here means Graft would change outcomes for a team that has not opted in."

### T11. Report manifest

`github/app-manifest.report.json`: same as `app-manifest.json` except `name`/`description` say "report only". `test/unit/manifest.test.ts`: U-MAN-1 unchanged; **U-MAN-2** the report manifest's permissions are a subset of the full manifest's, and no permission other than `checks` and `pull_requests` has a level above `read`; **U-MAN-3** both manifests have the same events.

### T12. Docs

- `docs/features/modes.md`: what report and enforce mean, the two keys, the CLI with examples, how to roll back, what "requested but not effective" means. Linked from `docs/README.md`, `mkdocs.yml` (Features) and the Phase 1 plan.
- `docs/configuration.md`: the three new variables.
- `docs/architecture.md`: a "Modes contract (Phase 1 step 1)" section: who can set a mode, the effective rule, the mutation guard and its route table location, D8.
- `docs/github-app.md`: the two manifests, which to register.
- `docs/decisions.md`: "Phase 1 step 1: modes" with T1 answers and any deviation.

## 11. Test plan

Unit (`test/unit/modes.test.ts`):

| ID | Case |
| --- | --- |
| U-MODE-1 | All defaults → report/report/off, reason `repository` |
| U-MODE-2 | Requested enforce, ceiling report → effective report, reason `ceiling`; `mcp_write` on → off, `ceiling` |
| U-MODE-3 | Ceiling enforce, requested enforce, permissions with `contents: read` → guard report, `permission_missing`, `missing = "contents:write"`; policy enforce |
| U-MODE-4 | `permissions = null` → guard and mcp `permissions_unknown`; policy still enforce |
| U-MODE-5 | `contents: admin` satisfies `write` |
| U-MODE-6 | Installation inactive beats every other reason; repository removed beats ceiling |
| U-MODE-7 | Property test: effective is never above requested and never above the ceiling, for every combination |

Unit (`test/unit/mutation-guard.test.ts`):

| ID | Case |
| --- | --- |
| U-MG-1 | Each §7.2 row classifies as listed; a trailing slash, a query string, upper-case method all handled |
| U-MG-2 | `POST /repos/o/r/git/refs/../check-runs`, encoded slashes, `//` → `unknown` |
| U-MG-3 | `DELETE /repos/o/r/git/refs/heads/main` → `unknown`; `…/heads/graft-revert/x` → phase1 guard |
| U-MG-4 | `POST /graphql`, `PUT /repos/o/r/pulls/1/merge`, `PUT …/branches/main/protection`, `POST /repos/o/r/pulls/1/reviews`, `PUT /repos/o/r/pulls/1/reviews/2/dismissals` → `unknown` |
| U-MG-5 | GHE base URL `https://ghe.example/api/v3` → path matched after the prefix |
| U-MG-6 | A refused request records nothing in the fake (T1 c) and the error message holds no body text and no expanded owner/repo |
| U-MG-7 | `asApp()` client: phase0 route → refused `app_client` |
| U-MG-8 | Phase 1 route, feature client, gate denies → refused with the gate's reason; gate allows → sent |

Integration (`test/integration/modes.test.ts`):

| ID | Case |
| --- | --- |
| I-MODE-1 | Migration up/down/up |
| I-MODE-2 | `mode set --policy enforce --reason r` → one row, column updated, exit 0; same again → `no change`, no row |
| I-MODE-3 | `mode set` without a key flag, without `--reason`, with a 201-character reason, with a newline, with a bad `--actor` → exit 2 |
| I-MODE-4 | `mode set` on a removed repository → exit 1, no row |
| I-MODE-5 | `mode show` output equals §8 literally for a seeded repository; the ceiling warning line when shell and worker differ; `--json` shape |
| I-MODE-6 | `modes.apply` claims rows, sends one repository fan-out per repository with policy rows, marks all applied; two concurrent runs claim disjoint rows |
| I-MODE-7 | Ceiling change at worker start → one fan-out per active repository; two workers starting together → one set of fan-outs; first start → none |
| I-MODE-8 | `installation.created` → refresh job → permissions stored from the API response, not the payload (payload and API differ in the fixture) |
| I-MODE-9 | Refresh drops unknown values (`"maybe"`), names that fail the regex and entries past 100 |
| I-MODE-10 | Policy job: changing only the effective mode republishes (`published`, not `unchanged`); the verdict row stores `policy_mode` |
| I-MODE-11 | Policy check `output.text` starts with the §9 line for each mode; title and summary unchanged from Phase 0 fixtures |
| I-MODE-12 | `pilot purge` removes `mode_changes`; `service_state` untouched; I-PURGE-2 passes |
| I-MODE-13 | Doctor shows both new warnings and still exits 0 when only they fire |

Neutral suite: N-1 to N-5 (T10). Manifest: U-MAN-2, U-MAN-3.

## 12. HUMAN-TODO (create `docs/phase-1/HUMAN-TODO.md`, section "Step 1: modes")

- [ ] **Leave `GRAFT_MODE_CEILING` unset (report)** on every deployment until the Phase 1 rollout runbook says otherwise. Who: operator.
- [ ] **Decide which manifest each deployment uses.** Evaluation-only deployments register `github/app-manifest.report.json`. Who: product owner.
- [ ] **Run `pnpm graft mode refresh-permissions --installation <id>`** once per existing installation after deploying step 1, then `pnpm graft mode show --installation <id>` and check the permissions line. Who: operator.
- [ ] **On a sandbox PR**, check that the `graft/policy` check details start with the "Graft mode: report" line and the check is still `neutral`; then `mode set --policy enforce` with the ceiling at `report` and confirm `show` reports `effective report  ceiling`. Who: repo owner.

## 13. Definition of done

From a clean clone with Docker running, and no network beyond install and the image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test                                  # every ID in §11 present and passing; all Phase 0 IDs still passing
pnpm build
pnpm eval:ci                               # exit 0, baseline unchanged
pnpm db:migrate && pnpm db:status          # 0001..0008 applied
pnpm db:rollback && pnpm db:status && pnpm db:migrate   # only 0008 rolled back, then re-applied
grep -rnE "@ts-(ignore|expect-error)" src/ && exit 1 || true
grep -rnE "from \"\.\./(db|github|modules)" src/modes/ && exit 1 || true
grep -rn "new Octokit\|Octokit.defaults" src/ | grep -v src/github/client-factory.ts && exit 1 || true
grep -rnE "conclusion: \"(success|failure|action_required)\"" src/modules/ && exit 1 || true
grep -rn "U-MODE-\|U-MG-\|I-MODE-\|N-[1-5]\|U-MAN-[23]" test/ | wc -l   # non-zero
```

**Manual smoke test** (record it in the PR description):
1. `pnpm dev:server` and `pnpm dev:worker`; the worker logs `mode ceiling` = `report`.
2. `pnpm webhook:send installation.created --delivery m1-1`, then `pnpm graft mode show --installation <id>` → all report/off; permissions line says not read (offline token failure is logged, classified, not a crash).
3. `pnpm graft mode set --repo <fixture repo> --policy enforce --reason "smoke"` → `effective report  ceiling`, `pending 1 change`.
4. Within a minute the worker logs `modes.apply` and one `policy.fanout` with `scope: repository`; `pnpm graft mode history --repo …` shows the row as `applied`.

**Mutation checks** (the reviewer reverts each one; the named tests must fail):

| Mutation | Caught by |
| --- | --- |
| Ceiling ignored in `effectiveModes` | U-MODE-2, U-MODE-7 |
| `permissions === null` treated as "all granted" | U-MODE-4 |
| Unknown write routes allowed (deny-list instead of allow-list) | U-MG-4, N-1 |
| Phase 1 route allowed without a feature | U-MG-8, N-5 |
| Gate result cached across requests | N-5 (mode flipped between two calls) |
| `policyMode` removed from `factsHash` | I-MODE-10, N-4 |
| `conclusion` derived from the effective mode | N-2 |
| Permissions read from the webhook payload | I-MODE-8 |
| `modes.apply` without `SKIP LOCKED` | I-MODE-6 |
| `mode_changes` missing from the purge map | I-MODE-12 |

**Also required:**
- No log line, job payload, column or error message holds a token, a request body, PR text or YAML; `mode_changes.reason` and `actor` appear only in the CLI and the database.
- Every existing caller of `forInstallation` works unchanged (no `feature` argument).
- The Phase 0 live e2e runner's INV-1 still holds with the default sandbox (no change to the runner in this step).
