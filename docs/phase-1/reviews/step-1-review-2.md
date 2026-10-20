# Step 1 review 2: Modes and safety rails

**Verdict: APPROVED**

Reviewer: senior engineer (Opus). Scope: the review 1 fixes in commit `7ab0e4b`, plus a fresh pass over the safety-critical areas of the whole step (`git diff main...HEAD`), judged against `docs/phase-1/step-1-modes.md` (binding), review 1 (`docs/phase-1/reviews/step-1-review-1.md`) and "Phase 1 step 1: modes" → "Review 1 fixes" in `docs/decisions.md`.

## Summary

All 10 review 1 findings are resolved, both majors included. The ceiling compare-and-set and the fan-out enqueue really do share one database transaction. The definition of done is green. Every mutation check that touches changed code is killed.

No blocker or major remains. Two new minors and two nits are listed below for a later step. Fix the host-check bypass (finding 1) before step 5 adds real Phase 1 writes.

## Review 1 findings

| # | Finding (review 1) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | major: Octokit built outside the factory (`src/eval/export.ts`) | **Resolved** | `buildExportClient --auth token` uses `makeGetOnly(forToken(...))`. The DoD grep is empty without an exemption. `@octokit/rest` is now imported only in `src/github/client-factory.ts`. The token client is also read-only now. |
| 2 | major: a failed enqueue after the ceiling compare-and-set loses the fan-out | **Resolved** | See "Is the ceiling fan-out really atomic?" below. The new I-MODE-7 case kills a "swallow the enqueue failure" mutation. |
| 3 | minor: an unrecognised permission level failed open | **Resolved** | `src/modes/index.ts:83` adds `!Object.hasOwn(LEVEL, have)`. U-MODE-8 covers `"maybe"`, `"toString"`, `"constructor"`, `""`, a number, `null`, and non-object `permissions`. Removing the check is killed by U-MODE-8. |
| 4 | minor: the guard ignored the request's host | **Partly resolved** | A literal URL to another host is refused (U-MG-9), and the fallback branch is gone. A per-request `baseUrl` override still gets through: new finding 1. |
| 5 | minor: the redelivery route passed for every client | **Resolved** | New `app` class at `src/github/mutation-guard.ts:82,248-250`. Installation clients get `unknown_route`, and only the App client passes (U-MG-1, U-MG-10). The comment says why it is in a production allow-list. |
| 6 | minor: N-4 cannot catch mutation 6 in step 1 | **Resolved** (documented) | Recorded in decisions.md for the step 2 reviewer. I confirmed again that only I-MODE-10 kills the mutation. |
| 7 | nit: Phase 1 route on the App client reads `no_feature` | **Resolved** | `app_client` is checked before the feature check. U-MG-7 is updated. |
| 8 | nit: `refuseAllGate` reads `repository_unknown` | **Resolved** | Explained in a comment (`mutation-guard.ts:40-44`). |
| 9 | nit: `routeTemplate` kept free names | **Resolved** | Every segment that is not a known route word or a number is templated, and the fragment is stripped too. U-MG-11 checks that a branch name never reaches the message. |
| 10 | nit: `mode set --repo` was ambiguous across installations | **Resolved** | `src/bin/graft-ops.ts:687-697` locks up to 2 rows. If both exist, it exits 1, prints the installation IDs and changes nothing (I-MODE-4b). |

### Is the ceiling fan-out really atomic?

Yes.
- `publishModeCeiling` passes `{ tx }` to `queue.send`.
- `createPgBossQueue.send` turns that into pg-boss's `db` send option through `txAdapter` (`src/queue/queue.ts:93-100,159`). That adapter runs the job `INSERT` through `tx.executeQuery` on the Kysely transaction's own connection, not pg-boss's pool.
- So the `service_state` update and the `modes.ceiling_fanout` row commit or roll back together, under the `FOR UPDATE` row lock that serialises concurrent worker starts.
- `modes.apply` already used the same path, and it is proven in production code.
- The singleton job id (`ceiling:<epoch>`) makes a duplicate insert a no-op.

Two caveats, neither a defect:
- Mutation M7 below (dropping `tx` but keeping the send inside the callback) survives. In that variant a failed send still throws inside the transaction and rolls it back. The only change is that a send that succeeds followed by a commit that fails would enqueue a duplicate fan-out on the next start. That is idempotent and safe, so the survival is acceptable. The test cannot tell "in the transaction" apart from "before commit", and it does not need to.
- `publishModeCeiling` now throws on a queue failure, so the worker exits at start (`src/bin/worker.ts:7`). That is the correct fail-loud behaviour, and the next start retries the fan-out.

## Fresh safety pass

- **Neutral conclusion.** No `success`, `failure` or `action_required` literal exists in `src/modules/`. The conclusion is never derived from the mode (`policy/job.ts:154`, `store.ts:39`). N-2 passes.
- **The guard cannot be bypassed** by path tricks:
  - Every factory client is guarded, `asApp()` included.
  - Allow-list matching uses the `endpoint.parse` output with no decoding. Dot segments, empty segments, `%`, `\` and wrong case fail closed.
  - Phase 0 writes never ask the gate, and Phase 1 writes ask on every request.
  - The remaining gap is host-level only (finding 1). Only Graft's own code can trigger it.
- **Gate freshness.** `mutationGate` reads the database on every call. Mutation 5 from review 1 is still covered by N-5 [max], and that code did not change in `7ab0e4b`.
- **Repository input cannot change a mode.** `policy_mode`, `guard_mode` and `mcp_write` are written only by `graft-ops mode set`. The installation and repository upserts (`src/modules/installations/store.ts:42,74`) do not list the mode columns in `doUpdateSet`, so webhooks cannot reset or raise them. Permissions still come only from `GET /app/installations/{id}`.
- **Secrets and PR text.** The `routeTemplate` change shrinks what refusals log. Job payloads are still IDs, enums and an epoch. The ceiling job payload is `{ at }`. `reason` and `actor` stay in `mode_changes` and the CLI. The ambiguous `mode set` error prints only installation IDs. Nothing new reaches logs or columns.
- **GHE and trailing slashes.** I checked with a throwaway probe against the real factory (deleted afterwards):
  - `https://ghe.example/api/v3`: Phase 0 write sent to `…/api/v3/repos/o/r/check-runs`. OK.
  - `https://api.github.com/` or `…/api/v3/` (trailing slash): every write is refused `unknown_route`, the installation token request included (finding 2). This fails closed, and it is not a regression from `7ab0e4b`: the old fallback branch produced the same `//…` path.

## New findings

### 1. minor: a per-request `baseUrl` defeats the host check

At `src/github/mutation-guard.ts:228,241`, the guard compares `parsed.url` with `options.baseUrl`, which is the merged per-request option, not the base the factory was built with. So `client.request("POST /repos/{owner}/{repo}/check-runs", { …, baseUrl: "https://evil.example" })` passes the guard and is sent to that host with the installation token. I confirmed this by probe.

Octokit's auth hook also sent the `access_tokens` request, with the App JWT, to the override host. The same applies to the App client and the `app` route.

Only Graft's own code can pass `baseUrl`, so this is defense in depth, like review 1 finding 4, which it leaves half closed.

**Fix:** capture the configured base once in `installMutationGuard` (from `octokit.request.endpoint.DEFAULTS.baseUrl`, or pass it in from the factory, trailing slashes trimmed). Refuse any write whose `options.baseUrl` differs from it or whose `parsed.url` does not start with `${configuredBase}/`. Add a U-MG-9 case that uses a `baseUrl` override.

### 2. minor: `GITHUB_API_URL` with a trailing slash refuses every write

At `src/config/index.ts:135` (the `url` validator at :55), the URL is not normalised. With `https://api.github.com/`, Octokit builds `https://api.github.com//app/installations/{n}/access_tokens`. The guard slices that to `//app/…`, which has an empty segment and so classifies as `unknown`. Every write, the token request included, is refused. This fails closed, and it predates `7ab0e4b`. But it is an easy operator mistake that would silently stop all Phase 0 publishing, and it would be logged as `unknown_route`.

**Fix:** strip trailing slashes in the config schema (`.transform((v) => v.replace(/\/+$/, ""))`), or reject them with a clear message. Add a config unit test.

### 3. nit: a mutation that drops `tx` from the ceiling send survives

As explained under "Is the ceiling fan-out really atomic?", this is behaviourally benign. To pin the contract anyway, I-MODE-7 could use a send stub that records whether `opts.tx` was passed. Optional.

### 4. nit: operator modes stick to a repository across a transfer or a re-add

`upsertRepositories` (`src/modules/installations/store.ts:74-80`) keeps `policy_mode`, `guard_mode` and `mcp_write` when a removed repository comes back, or when it moves to another installation (`installation_id` is updated in place). In step 1 this changes only the informational line. From step 2 on, a repository transferred to another account would keep an `enforce` that the operator set for the previous owner. The spec does not cover this. Decide in step 2 whether a transfer, meaning an `installation_id` change, should reset the modes to their floor and write a `mode_changes` row with actor `system`.

## Definition of done (spec §13), run by me

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK ("Already up to date") |
| `pnpm db:up` | Not run. I reused the running `scionhub-postgres-1` on 55432; no container was started or stopped |
| `pnpm lint` | OK (308 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm test` | OK: 89 files, **953** tests passed (947 + 6 new) |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0; every threshold passes, `matchBaseline: 1` |
| `db:migrate && db:status` (scratch DB `graft_review2_s1`) | 0001..0008 applied |
| `db:rollback && db:status && db:migrate` | Only `0008_modes` rolled back (`pending`), then re-applied. Scratch DB dropped |
| `@ts-ignore` / `@ts-expect-error` grep | Clean |
| `src/modes/` import grep | Clean |
| `new Octokit\|Octokit.defaults` grep | **Clean** (fixed since review 1) |
| non-neutral conclusion grep in `src/modules/` | Clean |
| test ID grep | 107 lines |

I did not run the manual smoke test. It belongs in the PR description.

## Mutation checks (code changed in `7ab0e4b` or named by the brief)

I applied each mutation, ran the named test files, then ran `git checkout -- <file>`. The tree was clean afterwards.

| # | Mutation | Result |
| --- | --- | --- |
| M1 | Ceiling ignored: removed `if (i.ceiling === "report") …` in `state()` | Killed: U-MODE-2, U-MODE-7 |
| M2 | `permissions === null` treated as granted (`continue`) | Killed: U-MODE-4, U-MODE-7 |
| M2b | `Object.hasOwn(LEVEL, have)` removed (unknown level granted) | Killed: U-MODE-8 |
| M3a | Unknown route allowed in the hook (`case "unknown": return`) | Killed: U-MG-5, U-MG-6, U-MG-11 |
| M3b | Unknown route allowed in `classifyWrite` (fallback `phase0`) | Killed: U-MG-1, 3, 4, 5, 6, 11 |
| M3c | Host check removed (classify `new URL(parsed.url).pathname`) | Killed: U-MG-5, U-MG-9 |
| M3d | `app` class passes for installation clients | Killed: U-MG-10 |
| M4 | Phase 1 route allowed without a feature | Killed: U-MG-6, U-MG-8, N-5 [max] |
| M6 | `policyMode` removed from `factsHash` | Killed: I-MODE-10. N-4 survives, as expected and documented for step 1 |
| M7 | Ceiling `send` without `{ tx }` (still inside the callback) | **Survives**: benign (nit 3) |
| M8 | Enqueue failure swallowed inside the ceiling transaction (`.catch(() => undefined)`) | Killed: I-MODE-7 (new case) |

## Before step 5

Fix finding 1, and preferably finding 2. Findings 3 and 4 can wait until step 2.
