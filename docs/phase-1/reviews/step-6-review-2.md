# Step 6 review 2: Minimal MCP server

**Verdict: APPROVED** (with two minor follow-ups and four nits, none blocking)

Reviewer: senior engineer (Opus). Scope: the nine fix commits `0639e15..10d8de3` on `claude/phase-1-step-6-review-fixes` (PR mmornati/graft#42), from `db4fb9f` ("D13 merge through the jobs (finding 1)") to `10d8de3` ("decisions record (findings 8, 9 deferred)"): 19 files, +925/−70, of which `src/` is 6 files and one new migration (`0015_mcp_open_claims`). I reviewed them on `claude/phase-1-step-6-review-2`, cut from that branch. I judged them against review 1 (`docs/phase-1/reviews/step-6-review-1.md`), the "Phase 1 step 6: MCP server" → "Review 1 fixes" section of `docs/decisions.md`, and `docs/phase-1/step-6-mcp-server.md` (binding).

PR #40 (the step) is merged. PR #42 (these fixes) is open, and its CI is green (`check` pass, 6m13s; `build` pass). Unlike step 5, this review runs **before** the fix PR merges, so nothing here is post-merge. Nothing below needs to block #42.

## Summary

Both required findings are resolved, and so are the three recommended findings, both minors and nit 10. Every fix has a test, and every test kills the mutation it was written for:
- **Finding 1.** I-MCP-8b runs U-PMM-3b's policy through the provenance and policy jobs. X23 is killed.
- **Finding 2.** A token that shares a valid token's prefix gets the same `401` (X7 killed). `report_provenance` through B's token cannot reach A's PR (X18 killed).
- **Findings 3 to 6.** The 17 extra mutations that survived review 1 are all killed now. I re-applied each one alone.
- **Finding 5.** Only `<GITHUB_APP_SLUG>[bot]` PRs are adopted, and nothing is adopted without the slug.
- **Finding 7.** The hourly cap is now a claim row inserted under the repository row lock, and no GitHub call runs inside the lock.

I agree with both deferred nits (8 and 9). Both are bound by the spec, both are harmless today, and both belong in step 7.

Report mode is still inert. The claim (`claimOpenSlot`) runs after the D16 mode read and the D17 GETs, so with `mcp_write` off `open_change` writes no row and makes no client, as before (I-MCP-9 and N-14 pass in the full run). The only `feature: "mcp"` is still `open-change.ts:178`.

I looked hard at the three things I was asked to look at:
- **The migration rolls back safely.** Its down keeps every PR row, deletes the claims and restores `NOT NULL`, in one transaction. A claim committed while the down waits for its lock makes the down fail and change nothing. I probed both cases by hand.
- **A stale claim cannot block opens past its hour**, and it never matches a PR number. But it can stay in `mcp_changes` forever in a quiet repository, and a crash can leave two rows for one PR. Step 7's metrics must count PR rows only (finding B).
- **The no-lock test is not flaky in CI.** The test passes deterministically: with the lock, exactly one claim wins, and it passed 15 of 15 runs. What depends on timing is the *kill* of the lock-removal mutation. It killed 10 of 10 runs here, but a regression that dropped the lock would be caught with high probability, not with certainty. See "The no-lock test".

New findings, none blocking:
- **A (minor):** what the 0015 down keeps is not pinned. A down that deletes every `mcp_changes` row passes every test, and so does one that leaves `head_sha` nullable. The first would silently drop D19 for every MCP-opened PR after a rollback.
- **B (minor, for the step 7 spec):** claim rows live in `mcp_changes`. They need `pr_number IS NOT NULL` in any count of "PRs opened through MCP", and step 7 must say so.
- **C to F (nits):** four rules in the new code have no test. They are the claim's one-hour expiry, the second half of the CHECK, adoption on the 422 path, and a mixed-case `GITHUB_APP_SLUG`.

## Review 1 findings

| # | Finding (review 1) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | required: the D13 fix in the policy job has no test above the unit level | **Resolved** | I-MCP-8b (`test/integration/mcp.test.ts:871`) seeds U-PMM-3b's policy (`default: require { humans: 1, team: security }`, a rule `agent: [codex]` → `require: { humans: 1 }`), checks the verdict before the report (`usedDefault`, `teamCount: 1`), sends a disagreeing `codex` report, runs `refreshProvenance` and `evaluatePolicyJobRun`, and expects `author_kind: unknown`, both constraints (the default's with `teamCount: 1`, and rule 1's), and rule 1 matched with `agent` uncertain. **X23 killed** by I-MCP-8b. |
| 2 | required: the hash lookup and `report_provenance`'s scoping are not pinned | **Resolved** | I-MCP-3 (`:520`) builds a token with the same first 30 characters as a valid one (so the same `graft_mcp_` and 8-character prefix) and one later character changed, and asserts the same `401` bytes. I-MCP-4 (`:603`) calls `report_provenance` with B's token, `repository: B`, A's PR number and A's head: `not_found`, no `provenance.refresh`. **X7 and X18 killed** by I-MCP-3 and I-MCP-4. |
| 3 | recommended: the D10 redaction is tested only with errors that carry nothing | **Resolved** | I-MCP-16 (`:1407`): an `mcp-protocol-version` header holding the token makes the SDK echo it into the error passed to `onerror`, and the `mcp sdk error` line holds only `graft_mcp_[redacted]`. A Kysely plugin (`failModes`) throws an Octokit-shaped error on the next modes read of `get_policy` (the token in its message, title and body sentinels in `request.body`), and the call's `base` holds a third sentinel. The result is `internal`, there is exactly one `mcp tool failed` line, it holds the redacted token, and no sentinel is logged anywhere. **X63, X63b (raw error, no args) and X64 killed** by I-MCP-16. |
| 4 | recommended: two D19 rules have no test | **Resolved** | I-MCP-14 (`:1251`): `alice` authors and `carol` commits, and `carol`'s approval does not count while `bob`'s does. `pulls.get` says 260 commits, the listing serves 260 (GitHub would cap at 250; either way the up-front check is what fires), and the result is `current: 0, truncated: true`. **X66 and X69 killed** by I-MCP-14. |
| 5 | recommended: `open_change` adopts any bot's PR | **Resolved** | `findOpenPull` (`open-change.ts:69`) sets `byGraft` only for a `Bot` whose login, lowercased, equals `graftBotLogin(ctx)` (`:56`, `<slug>[bot]` lowercased), and `null` without the slug. `adopt` (`:103`) records only `byGraft`. I-MCP-11 (`:986`) returns a `renovate[bot]` PR with `existing: true` and no row, and a server with no slug does not restore a lost row of Graft's own PR. HUMAN-TODO asks the operator to set `GITHUB_APP_SLUG` before `mcp_write` goes on, and `docs/configuration.md` and `docs/features/mcp.md` say why. **F5 (`byGraft = type === "Bot"`) killed** by I-MCP-11. Four rules of the new code are not pinned (nits E and F). |
| 6 | minor: nine more rules have no test | **Resolved** | One assertion per rule, each where review 1 asked. I-MCP-3: the installation's `deleted_at`, then `suspended_at` (X5, X6). I-MCP-6: `Origin: ""` and `Origin: null` → `403` with no token lookup (X14, X15). I-MCP-7 uses Fastify `inject` with `remoteAddress`: another IP is served while one is blocked (X57), and from a third IP, ten malformed headers and nine unknown tokens, one good call, then the 20th failure → `401` and the 21st → `429` (X55, X58). I-MCP-8: a repeat that changes only `model` → `already_reported` (X28). I-MCP-12: an existing `graft-revert/x` as `base` → `base_not_found` (X44). I-MCP-14: a row for the same PR number in repository B excludes nobody in A (X70). **All nine killed.** |
| 7 | minor: the hourly cap can be exceeded by concurrent calls | **Resolved** (review 1's first option) | See "Finding 7 in detail". `claimOpenSlot` (`store.ts:193`) and `settleOpenClaim` (`store.ts:230`), migration `0015_mcp_open_claims`, I-MCP-12b (`:1155`). The developer's four mutations (no claim, no lock, a failed create keeps its slot, a crashed claim never expires) and five of mine are killed. Three of mine survive (nits C and D, and one equivalent). |
| 8 | nit: `report_provenance` advertised as `readOnlyHint: true` | **Deferred, agreed: step 7** | See "Deferred nits". |
| 9 | nit: the body is parsed before authentication | **Deferred, agreed: step 7** | See "Deferred nits". |
| 10 | nit: the fallback `401` in `rateLimit` is not the D5 response | **Fixed**, no test (accepted) | One `unauthorized(reply)` helper (`http.ts:56`) serves `authenticate` (`:81`) and the fallback (`:90`). The fallback cannot be reached while `authenticate` runs first, so no test can reach it, as review 1 said. |

### Finding 7 in detail

**What the code does.** After D16 and the D17 checks, and before any `mcp` client exists:
1. `claimOpenSlot` opens one transaction. It locks the repository row (`SELECT … FOR UPDATE`, `store.ts:202`, the same lock as `createTokenRow`). It deletes this repository's claims that are an hour old or older, counts the rolling hour with `opensInLastHour` (claims included), and inserts a claim (`pr_number` and `head_sha` null) unless the cap is reached. Then it commits. No GitHub call runs inside.
2. The `mcp` client is made and `pulls.create` runs, both inside one `try`. A failure of either, a gate refusal (`mode_off` included) or a `422` calls `settle(null)` first (`open-change.ts:195`), which deletes the claim, and only then maps the error.
3. On success, `settleOpenClaim` deletes the claim and inserts the PR's row with `ON CONFLICT DO NOTHING`, in one transaction (`:217`).

**Why it is correct under concurrency.** Under READ COMMITTED, a second `claimOpenSlot` blocks on the row lock until the first commits. Its `count` statement then takes a fresh snapshot and sees the first claim. `settleOpenClaim` replaces one row with at most one row inside a transaction, so another process's count never sees both and never sees neither. It takes no lock and needs none, because it never adds to the count. The 422 race (call A creates #5, call B gets `422` and adopts #5 before A settles) ends with one row for #5: B gave its claim back first, and A's insert hits the conflict. Lock order is repository row, then `mcp_changes` (and the token row through the FK), the same order as `createTokenRow` and `upsertRepositories`. I see no deadlock.

**The mutations of finding 7**, each applied alone (the first four are the developer's, re-run; the rest are mine):

| # | Mutation | Result |
| --- | --- | --- |
| F7a | No claim row: count, then create (`claimOpenSlot` returns a fixed id and inserts nothing) | Killed: I-MCP-12b |
| F7b | No repository row lock in `claimOpenSlot` | Killed: I-MCP-12b, **10 of 10 runs** (see "The no-lock test") |
| F7c | A failed create keeps its slot (`settle(null)` removed) | Killed: I-MCP-11, I-MCP-12b, I-MCP-13 |
| F7d | A crashed claim never expires (no stale delete, and claims counted at any age) | Killed: I-MCP-12b |
| C1 | `>` in place of `>=` (one open too many) | Killed: I-MCP-12, I-MCP-12b |
| C2 | The stale delete drops every claim, not only those an hour old | Killed: I-MCP-12b (the held call's claim is dropped, so the concurrent call passes) |
| C3 | Claims expire after one minute, not one hour | **Survives** (nit C) |
| C4 | The stale delete ignores the repository | Survives, equivalent: it deletes only rows that no count includes (older than the window) |
| C5 | `settleOpenClaim` never deletes the claim | Killed: I-MCP-11, I-MCP-12, I-MCP-12b, I-MCP-13 |
| C6 | `settleOpenClaim` deletes the claim but never inserts the PR row | Killed: I-MCP-11, I-MCP-12, I-MCP-12b |
| C7 | The claim kept when the create answers `422` | Killed: I-MCP-11, I-MCP-12b |
| C8 | Success inserts the PR row and leaves the claim (the review 1 insert restored) | Killed: I-MCP-11, I-MCP-12, I-MCP-12b, N-15 |
| C9 | `settleOpenClaim` without its transaction | Survives, accepted: it differs only if the process dies between the delete and the insert, and then the PR's row is lost either way. Only the slot count differs, by one, for an hour |

### The no-lock test

The last block of I-MCP-12b runs five `claimOpenSlot` in parallel through `Promise.all` on the test pool (5 connections) with one free slot, and expects exactly one winner.
- **Passing direction: deterministic.** With the lock, the five transactions serialise on the repository row, so exactly one can insert, whatever the scheduling. I ran `mcp.test.ts` 15 times in a row on a fresh database each time, with a full `pnpm test` running against the same server in parallel, and it passed 15 of 15. I see no other timing dependency in the test. The held call uses the fake's `block`/`reached`/`release`, which is a gate rather than a sleep, and the back-dated rows are two hours old, far from the one-hour edge.
- **Mutation-kill direction: depends on timing.** Without the lock, the test fails only if at least two of the five transactions run their `count` before either commits. With five connections issued in one tick that is very likely, and F7b was killed in 10 of 10 runs here (the developer reports 3 of 3), but nothing forces the interleaving. A future regression that drops the lock would be caught with high probability, not with certainty. That is acceptable for a guard of this size, and the first block of I-MCP-12b, held deterministically at the create, independently kills the "no claim at all" regression (F7a). If certainty is wanted later, hold the first transaction open between its count and its insert (for example with an injected hook, or a `pg_sleep` in a test-only plugin), then start the second. No change needed now.

### Migration 0015 and its rollback

**Up** drops `NOT NULL` from `pr_number` and `head_sha` (metadata only) and adds `CHECK ((pr_number IS NULL) = (head_sha IS NULL))`, which scans the table once. Every existing row has both values, so the scan passes. The existing `pr_number > 0` and `head_sha ~ '^[0-9a-f]{40}$'` CHECKs pass on NULL, and `UNIQUE (repository_id, pr_number)` allows many claims, so the old constraints need no change.

**Down** deletes the claims, drops the CHECK and restores `NOT NULL`. Kysely's migrator runs each migration in a transaction on Postgres (`supportsTransactionalDdl`), so the down is atomic. I checked the cases that matter by hand on a scratch database (`graft_s6r2_dod`):
- **Rows kept.** With two PR rows and one claim, `db:rollback` left both PR rows, deleted the claim, and both columns were `NOT NULL` again. Migrate re-applied.
- **A claim inserted while the down runs.** A session inserts a claim and holds its transaction for four seconds while `db:rollback` starts. The down's `DELETE` does not see the uncommitted claim. Its `ALTER TABLE` waits for the session's lock, then finds the committed NULL and fails ("column pr_number contains null values"). The whole migration rolls back: 0015 still `applied`, the CHECK still there, the claim still there. So a down run against a live server fails closed and can be retried once the servers are stopped.
- **Code and schema out of step.** New code on a rolled-back schema cannot insert a claim (`NOT NULL`), so `open_change` answers `internal` before any `pulls.create`. Old code on the 0015 schema never writes a claim and counts as before. Neither mix can exceed the cap or open a PR without a row.

What the down *keeps* is not pinned by any test (finding A).

### Stale claims and step 7

- **A stale claim cannot block opens past its hour.** `opensInLastHour` counts only `created_at > now() − 1 hour`. A claim left by a crash between the claim and the settle holds one slot for an hour, which is fail-closed and documented. After that it is never counted, whether or not anything deletes it.
- **It is never read as a PR.** `isMcpChange` (`get_status`), `openedThroughMcp` (D19) and adoption all match on `pr_number = n`, which a NULL never satisfies. `pilot purge` deletes by repository, claims included (its count includes them, which is correct for a purge).
- **But it can live forever, and it can double count** (finding B):
  - Only the next `claimOpenSlot` *of the same repository* deletes stale claims. In a repository that never opens again, a crashed claim stays in `mcp_changes` indefinitely.
  - A crash after `pulls.create` and before the settle leaves the claim, and the agent's retry adopts the PR (with the slug), so for up to an hour one PR holds two slots. That is fail-closed for the cap, and acceptable.
  - The step 6 spec says the row "is what the rate limit, D19 and step 7 count". A step 7 metric that counts `mcp_changes` rows, such as "PRs opened through MCP" or the share of agent PRs, would include in-flight claims, crashed claims and those double rows unless it filters `pr_number IS NOT NULL`.

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | OK ("Already up to date") |
| `pnpm db:up` | Not run. The shared `scionhub-postgres-1` was stopped (exited, another session), so I started my own `postgres:18-alpine` on `127.0.0.1:55448` (`graft-s6r2-pg`) and removed it at the end. |
| `pnpm lint` | OK (373 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm test` (`TEST_DATABASE_URL=…:55448/graft_s6r2`) | OK: 106 files, **1226** tests passed (the developer's count), in 5 of 6 runs on that database and in 1 more run on a second fresh database. My first run on a fresh database reported **1 failed / 1225 passed**. I lost its output (I kept only the summary lines) and could not reproduce it in six more runs, so I cannot name the test. The CI `check` job on PR #42 is green. I record it as an unexplained single failure, not as a finding. |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0; every threshold passes, `matchBaseline: 1` |
| `db:migrate && db:status` (scratch DB `graft_s6r2_dod`) | `0001`..`0015` applied |
| `db:rollback && db:status && db:migrate` | Only `0015_mcp_open_claims` rolled back (`pending`), then re-applied; plus the two hand probes above |
| `@ts-ignore` / `@ts-expect-error` grep | Clean |
| `feature: "mcp"` in `src/` | Once: `src/modules/mcp/tools/open-change.ts:178` |
| CI on PR #42 (`gh pr checks 42`) | `check` pass (6m13s), `build` pass; `deploy` and the Graft checks skipped |

I did not run the manual smoke test or the T1 checks with real clients. They are still in HUMAN-TODO, now with the `GITHUB_APP_SLUG` item.

### Mutation checks

I applied each mutation alone with a script in a separate scratch worktree at `10d8de3`, on a fresh database for each run (`graft_s6r2m`, dropped and recreated). The script ran the step's unit files (`mcp-tokens`, `mcp-schemas`, `mcp-rate-limit`, `provenance-mcp-merge`, `mutation-guard`, `policy-evaluate`, `policy-facts`) and `test/integration/mcp.test.ts`, plus `neutral.test.ts` for the job and `open_change` mutations and `db.test.ts` for the migration ones. Then it restored the file with `git checkout --`. `git status` was clean after every run, and this branch has no source change.

**Review 1's surviving mutations, re-applied:**

| # | Mutation | Result |
| --- | --- | --- |
| X5 | Lookup ignores a deleted installation | Killed: I-MCP-3 |
| X6 | Lookup ignores a suspended installation | Killed: I-MCP-3 |
| X7 | Lookup by `token_prefix` | Killed: I-MCP-3 |
| X14 | An empty `Origin` skips the check | Killed: I-MCP-6 |
| X15 | `Origin: null` allowed | Killed: I-MCP-6 |
| X18 | `report_provenance` reads the PR number in any repository | Killed: I-MCP-4 |
| X23 | The policy job drops the stricter-of-two merge (N) | Killed: I-MCP-8b |
| X28 | D14 identical repeat compares the agent only | Killed: I-MCP-8 |
| X44 | `base` checked for existence only (N) | Killed: I-MCP-12 |
| X55 | A success resets the IP's failures (`reset` added to the counter, called after a good token) | Killed: I-MCP-7 |
| X57 | One failure counter for every IP | Killed: I-MCP-7 |
| X58 | A malformed header not counted | Killed: I-MCP-7 |
| X63 | A failing tool logs `{ err, args }` | Killed: I-MCP-16 |
| X63b | A failing tool logs the raw error | Killed: I-MCP-16 |
| X64 | The SDK `onerror` logs the raw error | Killed: I-MCP-16 |
| X66 | Committers not excluded | Killed: I-MCP-14 |
| X69 | More than 250 commits not refused up front | Killed: I-MCP-14 |
| X70 | D19's `mcp_changes` lookup ignores the repository (N) | Killed: I-MCP-14 |
| F5 | Finding 5: any bot's PR adopted (`byGraft = type === "Bot"`) (N) | Killed: I-MCP-11 |

All 17 of review 1's surviving mutations are killed, as are X63b and F5. The finding 7 mutations are in the table above.

**Mine, on migration 0015:**

| # | Mutation | Result |
| --- | --- | --- |
| G1 | No CHECK | Killed: I-MCP-1 |
| G2 | CHECK only refuses a PR number without a head (`pr_number IS NULL OR head_sha IS NOT NULL`) | **Survives** (nit D) |
| G3 | CHECK only refuses a head without a PR number | Killed: I-MCP-1 |
| G4 | Down does not delete claims (so `SET NOT NULL` fails) | Killed: I-MCP-1 |
| G5 | **Down deletes every `mcp_changes` row** | **Survives** (finding A) |
| G6 | Up keeps `head_sha NOT NULL` | Killed: I-MCP-1, I-MCP-11, I-MCP-12, I-MCP-12b, I-MCP-13, I-MCP-16 |
| G7 | Down restores `NOT NULL` on `pr_number` only | **Survives** (finding A) |

**Mine, on the `GITHUB_APP_SLUG` adoption rule:**

| # | Mutation | Result |
| --- | --- | --- |
| A1 | Login compared case-sensitively | Survives, equivalent: GitHub returns an App bot's login in lower case, and the configured slug is lowercased |
| A2 | The configured slug not lowercased | **Survives** (nit F): the config accepts `[A-Za-z0-9-]+` |
| A3 | `type === "Bot"` dropped (login only) | Survives, equivalent: a user login cannot contain `[bot]` |
| A4 | No slug → any bot adopted | Killed: I-MCP-11 |
| A5 | Any `…[bot]` login adopted | Killed: I-MCP-11 |
| A6 | A bot whose slug is a prefix of Graft's adopted (`graft[bot]` for `graft-dev`) | Survives; contrived, folded into nit E |
| A7 | **The 422 path adopts the PR it finds whatever its author** | **Survives** (nit E) |

## Deferred nits

**Nit 8 (`readOnlyHint: true` on `report_provenance`): I agree it belongs in step 7.** The spec binds it: §6's `server.ts` row sets `readOnlyHint: true` "on the three reads", and §1 counts `report_provenance` among them. Changing it is a spec amendment, which a fix PR should not make on its own. The developer's analysis is right. Its effects (a stored row, a possibly stricter verdict, a republished check and comment section through Phase 0 routes) can only make Graft stricter, so a client that runs it without asking cannot loosen anything. **The step 7 spec should pick it up:** amend §6 to `readOnlyHint: false, destructiveHint: false, idempotentHint: true` for `report_provenance`, and have I-MCP-2 (the tool list) assert the annotations of all four tools.

**Nit 9 (body parsed before authentication): I agree it belongs in step 7.** D3 binds the `preHandler` chain. Nothing leaks today: the `400`, `413` and `415` bodies carry nothing, and the route's `bodyLimit` caps parsing at 64 KiB. What remains is a small pre-auth cost that D9 (b) does not cover, and it belongs with the proxy and `trustProxy` question that is already in the residual risks for step 7. **The step 7 spec should pick it up:** move the Origin check and `authenticate` to `onRequest` (they read headers only), keep the per-token limit where it is, and add an I-MCP-3 or I-MCP-6 case where an unauthenticated `text/plain` or oversized body gets `401` (or `403` for a foreign origin), not `415` or `413`.

## New findings

### A. minor: what the 0015 down keeps is not pinned

I-MCP-1 checks that the down drops claims (G4 killed). But at that point the table holds only claim rows. So nothing checks that PR rows survive the down, or that both columns are `NOT NULL` again:
- **G5** (down deletes every row) survives. After such a rollback, every PR opened through MCP loses its `mcp_changes` row, so D19 no longer excludes its commit authors, and their approvals count again, silently. That is the one way this migration could loosen a gate.
- **G7** (down restores `NOT NULL` on `pr_number` only) survives. It is a harmless schema drift, but the down is meant to restore 0014 exactly.

**Fix:** in I-MCP-1, insert one PR row next to the claim before `migrateDownOne`. After the down, expect exactly that PR row, and read `information_schema.columns` to expect `is_nullable = 'NO'` for both columns. G5 and G7 must then fail. One more step-down assertion, no code change.

### B. minor (for the step 7 spec): `mcp_changes` now holds claims

The claim design is right, and it keeps D9 (c) "counted from `mcp_changes` rows" across processes. But the table no longer means "PRs opened through MCP" row for row:
- An in-flight call holds a claim row.
- A crash between the claim and the settle leaves a claim, which only the next claim *of the same repository* deletes. In a quiet repository it stays forever.
- A crash after `pulls.create` followed by an adopting retry leaves a claim and a PR row for one PR, for an hour.

None of this affects the cap, D19 or `get_status`. It does matter for step 7, which the spec names as the third reader of this table ("The row is what the rate limit, D19 and step 7 count").

**Fix:** the step 7 spec must count `mcp_changes` rows with `pr_number IS NOT NULL` for any metric of PRs opened through MCP, and must not use `created_at` of such a row as the open time. The settle inserts a new row, so `created_at` is the settle time, a few hundred milliseconds after the create. Optionally, step 7 can also delete claims older than an hour in a periodic job (the guard's `observe` cadence would do), so they do not wait for the next claim of their repository. Neither change is needed before pilots.

### C. nit: the claim's one-hour expiry has no test

C3 (claims expire after one minute) survives. I-MCP-12b's crashed claim is two hours old, so any expiry up to two hours passes. The rule "a claim left by a crash holds its slot for an hour" (decisions.md, the migration comment) is therefore not pinned. A short expiry could also delete the claim of a slow live call, which would then settle normally and leave the count one too low for the rest of the hour. **Fix:** in I-MCP-12b, add a claim aged 59 minutes, which must still count (the next call at the cap is `rate_limited`) and must not be deleted.

### D. nit: half of the CHECK has no test

G2 survives. I-MCP-1 inserts `pr_number = 5, head_sha = NULL` (refused), but never `pr_number = NULL` with a head. Such a row would count against the cap and match nothing, so the gap is harmless. It is one more `rejects.toThrow(/check constraint/)` line in I-MCP-1.

### E. nit: adoption on the 422 path is not pinned to Graft's bot

`findOpenPull` is called twice: before the claim, and after a `422` (`open-change.ts`, the `githubStatus(err) === 422` branch). I-MCP-11 tests the `renovate[bot]` case only on the first call. A7 (the 422 path adopts whatever it finds) survives. Reaching it needs another bot to open a PR for the same head and base between the lookup and the create, so the practical risk is very low. But both call sites go through the same helper, and the second one is the one a refactor would most likely inline. **Fix:** an I-MCP-11 case where `pulls.create` answers `422` and the lookup then returns a `renovate[bot]` PR: `existing: true`, no row. The same case covers A6 if the other bot is named `graft[bot]`.

### F. nit: a mixed-case `GITHUB_APP_SLUG` has no test

`GITHUB_APP_SLUG` accepts `[A-Za-z0-9-]+`, and `graftBotLogin` lowercases it, so `Graft-Dev` still recognises `graft-dev[bot]`. A2 (no lowercasing) survives because every test uses a lower-case slug. Without the lowercasing, an operator who typed the App's display-cased slug would silently lose recovery of lost rows. **Fix:** start one I-MCP-11 server with `GITHUB_APP_SLUG: "Graft-Dev"`, or lowercase the slug once in `loadConfig`, where the managed-comment fallback would benefit too.

## Regressions

- **Report mode is still inert.** `claimOpenSlot` runs after `getEffectiveModes` and the D17 GETs. With `mcp_write` off, `open_change` throws `mcp_write_off` before any claim. I-MCP-9, I-MCP-10, N-14 and N-15 pass in the full run.
- **The one write is unchanged.** The `mcp` client is still only at `open-change.ts:178`. It now sits inside the `try` that gives the slot back, so a failure to make the client also frees the slot (C7 and F7c are killed). The body is still the §7 keys.
- **D19 and `get_status` ignore claims.** Both match on `pr_number = n`.
- **The step-down tests** in `db`, `modes`, `policy-enforce`, `break-glass`, `guard`, `guard-revert` and `pilot-ops` now step through `0015_mcp_open_claims` first, and all pass in the full run.
- **Docs.** `decisions.md` records every fix, both deferrals and the mutation table, which matches what I re-ran (my run adds C1–C9, G1–G7 and A1–A7). `docs/features/mcp.md`, `docs/configuration.md` and HUMAN-TODO describe the claim and the slug correctly.

## Recommendation

**Merge PR #42.** Its two required fixes are correct, and their tests kill X7, X18 and X23. The recommended and minor fixes hold, and every one of review 1's surviving mutations is now killed. The new claim is correct under concurrency, its migration rolls back atomically and fails closed, and report mode is unchanged.

Findings A, C, D, E and F are test-only and can go in one small follow-up, before or with step 7. **The step 7 spec should pick up:**
- finding B: count `mcp_changes` rows with `pr_number IS NOT NULL` only, and optionally purge stale claims periodically;
- nit 8: amend §6 for `report_provenance`'s annotations;
- nit 9: move the Origin check and authentication to `onRequest`, with the proxy question.

Before any pilot repository turns `mcp_write` on, the HUMAN-TODO items still stand: set `GITHUB_APP_SLUG`, expose `/mcp` behind the proxy, and do the real-client and T1 checks.
