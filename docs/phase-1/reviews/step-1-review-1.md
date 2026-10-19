# Step 1 review 1: Modes and safety rails

**Verdict: CHANGES REQUESTED**

Reviewer: senior engineer (Opus). Scope: commits `08bab79..145e34e` on `claude/phase-1-step-1-modes` (everything after the spec commit `804e3d7`), judged against `docs/phase-1/step-1-modes.md`, the Phase 1 plan, the Phase 0 constraints and the "Phase 1 step 1: modes" section of `docs/decisions.md`. The local `main` ref is stale (merge base `355f640`), so `git diff main...HEAD` also shows unrelated, already-merged work (website, LLM federation). I reviewed `git diff 804e3d7..HEAD`: 54 files, +3692/−74.

## Summary

The step is in good shape. All 12 tasks and all 17 decisions are implemented. The safety core holds up under attack: every client the factory returns is guarded, `asApp()` included, and the route table is a real allow-list matched on `endpoint.parse` output. Dot segments, empty segments, percent escapes, backslashes and wrong case all fail closed. `/graphql` is refused, and I confirmed that `octokit.graphql()` goes through the hook. The gate reads the database on every call. The policy conclusion is still the literal `neutral`. Only the ops CLI writes the mode columns. Permissions come from `GET /app/installations/{id}`, never from the payload. Every §11 test ID exists and tests what its row says. All 10 spec mutations are killed (I ran all of them, not just the 6 the developer skipped). Lint, typecheck, test, build and `eval:ci` are green, and so are migrate and rollback.

Two things block approval:
- The definition-of-done Octokit grep fails as written.
- A failure in the window between the ceiling compare-and-set and its enqueue loses the ceiling fan-out permanently. That fan-out is the rollback path that step 2 depends on.

Both fixes are small. The other findings are minors and nits.

## What was checked

### Definition of done (spec §13), run by me

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK ("Already up to date") |
| `pnpm db:up` | Not run. I reused the running `scionhub-postgres-1` on 55432; no container was started or stopped |
| `pnpm lint` | OK (308 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm test` | OK: 89 files, 947 tests passed |
| `pnpm build` | OK |
| `pnpm eval:ci` | OK, exit 0; every threshold passes, `matchBaseline: 1` |
| `db:migrate && db:status` (scratch DB `graft_review_s1`) | 0001..0008 applied |
| `db:rollback && db:status && db:migrate` | Only `0008_modes` rolled back (shown `pending`), then re-applied. Scratch DB dropped afterwards |
| `@ts-ignore` / `@ts-expect-error` grep | Clean |
| `src/modes/` import grep | Clean |
| `new Octokit\|Octokit.defaults` grep | **FAILS**: `src/eval/export.ts:372` (finding 1) |
| non-neutral conclusion grep in `src/modules/` | Clean |
| test ID grep | 101 lines |

I did not run the manual smoke test. It belongs in the PR description; the developer should record it there.

### Mutation checks (spec §13)

I applied each mutation, ran the named tests, then ran `git checkout -- <file>`. The tree was clean at the end.

| # | Mutation (how I applied it) | Result |
| --- | --- | --- |
| 1 | Ceiling ignored: removed rule 4 in `state()` | Killed: U-MODE-2, U-MODE-7 |
| 2 | `permissions === null` treated as granted (`continue`) | Killed: U-MODE-4, U-MODE-7 |
| 3a | Unknown write allowed in the hook (`case "unknown": return`) | Killed: U-MG-5, U-MG-6. U-MG-4 does not catch this variant because it tests `classifyWrite` only; N-1 does not either |
| 3b | Unknown write allowed in `classifyWrite` (fallback `phase0`) | Killed: U-MG-1, 3, 4, 5, 6 |
| 4 | Phase 1 route allowed without a feature | Killed: U-MG-6, U-MG-8, N-5 [max] |
| 5 | Gate verdict cached per client | Killed: N-5 [max] (mode flipped between two calls) |
| 6 | `policyMode` removed from `factsHash` | Killed: I-MODE-10. **N-4 survives**; this is expected in step 1 (finding 6) |
| 7 | `conclusion` derived from the effective mode | Killed: N-2 [max] |
| 8 | Handler writes the payload's permissions on `installation.created` | Killed: I-MODE-8 |
| 9 | `claimUnappliedModeChanges` without `SKIP LOCKED` | Killed: I-MODE-6c (blocks, then times out) |
| 10 | `mode_changes` missing from `OWNED_ROWS` | Killed: I-MODE-12, I-PURGE-1, I-PURGE-2, I-PURGE-4 |

### Extra probes

I ran each probe as a throwaway test file and deleted it afterwards.
- `client.graphql("mutation …")` is refused with `unknown_route`, and nothing is sent.
- `POST /Repos/o/r/check-runs` (wrong case) is refused with `unknown_route`.
- `POST https://evil.example/repos/o/r/check-runs`, sent from an installation client, **passes** the guard and is sent with the installation token (finding 4).
- `POST /app/hook/deliveries/5/attempts`, sent from an **installation** client, passes the guard (finding 5).
- `effectiveModes` with `permissions = { contents: "maybe", pull_requests: "toString" }` gives guard `enforce` and mcp `on` (finding 3).

### Safety review

- **Non-neutral conclusions.** The only conclusion literals in `src/modules/` are `"neutral" as const`. The mode is read once, outside the lock, and feeds only `view.mode` and the hash (`src/modules/policy/job.ts:155,200,267`). N-2 passes under both profiles.
- **Guard bypasses.**
  - Every `forInstallation` call gets a fresh Octokit (`@octokit/app` builds a new instance per call), so hooks and features never leak between callers.
  - The shared `asApp()` client is guarded once. `forToken` clients are unguarded by spec.
  - The path is not decoded, so `%2e%2e` and `%2F` are refused.
  - A query string or fragment is stripped. A trailing slash is tolerated.
  - The GHE prefix is stripped only on an exact string-prefix match. Otherwise the full pathname, including `/api/v3`, is matched, which fails closed.
  - The weak points are the host (finding 4) and the `auth` class (finding 5).
- **Gate freshness.** `mutationGate` queries the database on every call (`src/modules/modes/effective.ts:36-49`). Phase 0 writes never call the gate (unit test "phase 0 writes never ask the gate").
- **Fail toward report.**
  - `permissions_read_at IS NULL` maps to `null` and then `permissions_unknown`.
  - A missing name gives `permission_missing`.
  - An unrecognised level is the exception (finding 3).
- **Repository input.** `policy_mode`, `guard_mode` and `mcp_write` are written only in `src/bin/graft-ops.ts` (`mode set`). Nothing in the webhook, policy or label paths touches them.
- **Permissions source.** The refresh job carries `{ installationId }` only and stores what `apps.getInstallation` returns, after sanitising it (I-MODE-8, I-MODE-9).
- **Logs, payloads and columns.**
  - Job payloads hold IDs, an enum reason, a uuid and an epoch.
  - Refusals log only method, route template, feature and reason.
  - `actor` and `reason` appear only in `mode_changes` and the CLI.
  - No token, body, PR text or YAML is logged (one nit in finding 9).

### Developer-reported deviations

| Deviation | Judgement |
| --- | --- |
| Ceiling fan-out singleton uses the change timestamp, not the ceiling value | **Accepted.** The spec's key would swallow report→enforce→report→enforce within the job retention window, and I-MODE-7 covers it. Better than the spec. |
| Factory `gate` optional, defaulting to refuse-all | **Accepted.** It fails closed, and production (`bootstrap.ts:80`) passes the real gate. The one risk is a future production caller forgetting the gate, which would silently refuse Phase 1 writes: safe, just confusing. Consider making `gate` required in a later step once `forApp` stops needing the default. |
| `POST /app/hook/deliveries/{n}/attempts` added as `auth` | **Accepted with a change (finding 5).** In practice it cannot be abused: GitHub rejects it without an App JWT, and webhook replay is benign by design because payloads are triggers. But the guard lets it through from installation clients too, and the production App client can call it. Give it an app-only class. |
| Extra job `installations.refresh_permissions_all` | **Accepted.** pg-boss crons need a fixed payload, and the fan-out keeps the 2 s stagger and a per-minute singleton. |
| N-4 under the default profile asserts nothing is republished | **Accepted.** Under a `report` ceiling the effective mode cannot change, so the spec's N-4 wording cannot hold for that profile. The `max` profile covers the rollback. |
| Encoded slashes refused | **Accepted.** No decoding means no confusion attacks. The consequence for step 5 (delete with a literal path, not `rest.git.deleteRef`) is recorded in decisions.md. |
| I-MODE-10 freezes the details with `vi.mock` | **Accepted, and meaningful.** In step 1 the mode line is part of the rendered details, which are already hashed, so only a freeze can isolate the D8 term. Mutation 6 confirms that I-MODE-10 kills it and N-4 cannot (finding 6). |
| `src/eval/export.ts:372` builds an Octokit outside the factory | **Not accepted as is (finding 1).** It needs a fix, not an exemption. |
| Only 4 of 10 mutation checks tried | **Resolved by this review.** All 10 are killed (table above). |
| `refresh_permissions` in `permissions.ts`, not `jobs.ts` (import cycle) | Accepted. |

## Findings

### 1. major: the DoD Octokit grep fails on `src/eval/export.ts:372`

`buildExportClient` with `--auth token` runs `new Octokit({ auth: GRAFT_EVAL_GITHUB_TOKEN, … })`. Spec §13 requires `grep -rn "new Octokit\|Octokit.defaults" src/ | grep -v src/github/client-factory.ts` to be empty, so the DoD does not pass as written. The code is pre-existing, but this step's grep is what makes it a gate. Exempting the file would weaken an invariant this step relies on: "the factory file is the only place an Octokit is built". Fixing it is a one-liner, and the read-only guarantee is worth having anyway.

**Fix:** replace the constructor with `makeGetOnly(forToken(o.env.GRAFT_EVAL_GITHUB_TOKEN, { baseUrl: o.env.GITHUB_API_URL, ...(o.fetch ? { fetch: o.fetch } : {}) }))` (export only reads), and drop the `@octokit/rest` import if nothing else uses it. Keep or adjust the eval-export unit tests and re-run the grep.

### 2. major: a failure between the ceiling compare-and-set and its enqueue loses the fan-out permanently

At `src/modules/modes/ceiling.ts:19-26`, `casServiceState` commits the new ceiling in its own transaction (`src/modules/modes/store.ts:207-240`). `queue.send(modesCeilingFanoutJob, …)` runs only after that commit. If the send fails (a database blip, or a crash or kill at startup), the worker exits or restarts. The next start then sees the stored value equal to the environment, returns `"unchanged"`, and never fans out. That republication is how a ceiling rollback (enforce → report) reaches GitHub "without a webhook". In step 1 the only casualty is a stale informational line. From step 2 on, open PRs would keep enforce conclusions after an operator rolled the ceiling back. `modes.apply` already does this correctly (it sends inside the claiming transaction, `jobs.ts:49-62`).

**Fix:** do the compare-and-set and the `modes.ceiling_fanout` send in one transaction. Either `casServiceState` accepts a transaction, or `publishModeCeiling` opens one and passes `{ tx }` to `queue.send`. Add a case to I-MODE-7: a queue whose `send` throws leaves `service_state` at the old value, and the next start fans out.

### 3. minor: an unrecognised permission level counts as granted (fails open)

At `src/modes/index.ts:81-82`, `LEVEL[have] < LEVEL[level]` is `false` whenever `have` is not a key of `LEVEL`. For example, `"maybe"` gives `undefined < 2`, and `"toString"` gives `Function < 2`, so the permission counts as satisfied. I confirmed both with a probe. Today `sanitizePermissions` keeps such values out on the write path. But `effectiveModes` is the pure rule that must "always fail toward report" (D2), the `installations.permissions` column has no CHECK, and `toRow` (`store.ts:42`) passes the jsonb through unvalidated.

**Fix:** treat any value that is not an own key of `LEVEL` as missing, for example `if (have === undefined || !Object.hasOwn(LEVEL, have) || LEVEL[have] < LEVEL[level])`. Add a U-MODE case with an unknown level and with a non-object `permissions`.

### 4. minor: the guard ignores the request's host

At `src/github/mutation-guard.ts:182-185`, when the parsed URL does not start with the base URL, the guard falls back to `new URL(parsed.url, base).pathname` and classifies that path. So `client.request("POST https://other.host/repos/o/r/check-runs")` is classified `phase0` and sent with the installation token. Only Graft's own code can build such a call, so this is defense in depth, not an exploit. Still, a write to a host other than the configured API is never legitimate.

**Fix:** refuse (as `unknown_route`) any write whose URL does not start with `${base}/`. Then the fallback branch is only needed for reads, which return earlier. Add a U-MG case.

### 5. minor: the redelivery route is `auth`, which passes for every client

At `src/github/mutation-guard.ts:76,199-201`, `auth` returns before any check on `installationId`. As a result `POST /app/hook/deliveries/{n}/attempts` passes from installation clients (confirmed by probe; GitHub would reject it for lack of an App JWT), and from the production `asApp()` client, although Graft never calls it. The access-token row has the same shape, but it has to: the token request runs through the installation client's hook (T1 b).

**Fix:** add an app-only class (for example `kind: "app"`, passing only when `installationId === null`) and use it for the redelivery row, with U-MG-1/U-MG-7 cases for installation and App clients. Alternatively, keep the route out of the shared table and let only `forApp` (the e2e runner's factory) allow it. Either way, the comment and decisions.md should say why the route is in a production allow-list.

### 6. minor: N-4 cannot catch "policyMode removed from factsHash" in step 1

Spec §13 lists I-MODE-10 and N-4 as catching mutation 6. N-4 survives it: the rendered text, which already holds the mode line, is part of the hash at `src/modules/policy/job.ts:267-269`. I-MODE-10's freeze is what kills it. This is inherent to step 1, not a test defect.

**Fix:** state in decisions.md, next to the I-MODE-10 deviation, that N-4 is not a catcher for this mutation until step 2, so the step 2 reviewer re-checks it.

### 7. nit: a Phase 1 route on the App client is refused with `no_feature`

At `src/github/mutation-guard.ts:208`, `installationId === null` yields `no_feature` even when a feature is given. `app_client` describes the cause. Consider `if (o.installationId === null) throw refusal("app_client")` before the feature check (U-MG-7 currently expects `no_feature`).

### 8. nit: `refuseAllGate` answers `repository_unknown`

At `src/github/mutation-guard.ts:40-43`, a refusal from the export, ops or e2e clients reads as if the repository were missing. A comment on the gate, or a log hint, would save someone a debugging session. The reason union is spec-fixed, so no new code is required.

### 9. nit: `routeTemplate` keeps non-numeric literal segments

At `src/github/mutation-guard.ts:155-164`, for a literal-URL request, owner and repo are replaced and digits become `{n}`, but a branch name in `DELETE …/git/refs/heads/<name>` or a label path would be logged as is. That is not a secret, but D13 says "never … the expanded URL". Consider templating every segment after `/repos/{owner}/{repo}` that is not a known literal, or logging the matched table row's template instead.

### 10. nit: `mode set --repo` resolves by name across installations

At `src/bin/graft-ops.ts` (`mode set`), `lower(full_name)` is used with `executeTakeFirst()` and no installation scope. Two active rows with the same name, for example a transfer whose `removed` event has not been processed yet, would make the target arbitrary. Consider refusing with exit 1 when more than one active row matches, and printing both IDs.

## Required before approval

Findings 1 and 2. I recommend finding 3 as well, since it is a one-line fail-closed fix in the pure rule. Findings 4 to 10 are optional in this step, but 4 and 5 should be fixed before step 5 adds real Phase 1 writes.
