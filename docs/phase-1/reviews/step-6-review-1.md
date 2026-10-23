# Step 6 review 1: Minimal MCP server

**Verdict: CHANGES REQUESTED (post-merge: two required follow-up fixes)**

Reviewer: senior engineer (Opus). Scope: the 2 commits `e2d0c70` ("Phase 1 step 6: MCP server") and `3b1a5be` ("record adopted bot PRs; document two residual risks"), merged to `main` through PR mmornati/graft#40 (merge commit `dcf2b97`) with no review. I reviewed `main` at `dcf2b97` on the local branch `claude/phase-1-step-6-review-1`: 63 files in `e2d0c70` (+5003/−43), 4 in `3b1a5be`. I judged them against `docs/phase-1/step-6-mcp-server.md` (binding: D1–D22, §4, §5, §9, the §14 test IDs and the §16 mutation table), the Phase 1 README, the Phase 0 constraints, and the "Phase 1 step 6: MCP server" section of `docs/decisions.md`.

This review runs **after the merge**. Nothing here can block PR #40. "Required" below means required in a follow-up fix PR, before any pilot repository turns `mcp_write` on and before a token is issued to an agent outside the sandbox.

## Summary

This is a well-built step:
- All 13 tasks are implemented, and every §14 test ID exists (47 test lines carry them).
- I ran the definition of done myself, and it is green. So is the CI `check` job on PR #40.
- All 14 spec mutations are killed (the spec's first row split into its two halves). So are 49 of the 69 extra mutations I added; 2 more are equivalent.
- The three recorded deviations are sound. The D13 one is a real bug in the spec, found and fixed by the developer, and I agree with the fix.

The safety core holds:
- **Report mode stays inert.** `open_change` reads `getEffectiveModes` before any client exists (`open-change.ts:106-109`), so with default modes it makes no client and no request of any kind. I-MCP-9 counts both, N-14 [default] shows that the only writes of the MCP scenario are Phase 0 routes through the default client, with no gate question. I-MCP-10 shows an `mcp` client refused with `mode_off` before anything is sent. Mutations S4, X33 and X34 (a client, or one GET, before the mode read) all fail I-MCP-9 and N-14.
- **The one write is narrow.** `feature: "mcp"` appears once in `src/` (`open-change.ts:147`), and only `pulls.create` is called on that client. The mutation guard's `mcpBodyAllowed` (`mutation-guard.ts:327-344`) fails closed: `POST …/pulls` only, a key whitelist, D17 names for `head` and `base`, `maintainer_can_modify` absent or `false`. It reuses the step 5 `normalisedPath`, so the `#` hole of step 5 review 1 does not come back.
- **Tokens.** 32 random bytes, stored as the SHA-256 of the whole string, never logged, never in `AuthInfo` (`auth.ts:64`), one indexed query per request with no cache.
- **The 401 is uniform.** Missing, malformed, unknown, expired, revoked and orphaned tokens get the same status, header and bytes (I-MCP-3).
- **Provenance only tightens.** A disagreeing report makes the author `unknown`, and the policy job keeps the stricter of the two verdicts (D13 deviation), once per head (D14).
- **No code is read.** The §16 content greps are clean, and I-MCP-19 and N-16 hold.

Two findings are required as a follow-up:
- **Required:** the D13 fix lives in the policy job, and no test above the unit level runs it. Mutation X23 removes it from the job (the verdict with the unknown author alone, the exact bug the deviation fixes), and every test passes.
- **Required:** two properties of the authentication and scoping path have no test. A lookup by the 8-character prefix in place of the hash (X7) passes every test, and so does a `report_provenance` that finds the PR in any repository (X18).

The rest are two recommended test gaps (the D10 redaction and D19), one recommended behaviour change (`open_change` adopts *any* bot's PR), and minors and nits, listed below.

## What was checked

### Definition of done (spec §16), run by me

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | OK; adds `@modelcontextprotocol/client 2.3.1` (devDependency) to `node_modules` |
| `pnpm db:up` | Not run. The shared `scionhub-postgres-1` container on `localhost:55432` stopped during my first test run (another session), so I started my own `postgres:18-alpine` on `127.0.0.1:55446` (`docker run`; the compose file fixes port 55432) and removed nothing else |
| `pnpm lint` | OK |
| `pnpm typecheck` | OK |
| `pnpm test` (`TEST_DATABASE_URL=…:55446/graft_s6r1`, a fresh database) | OK: 106 files, **1224** tests passed |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0; every threshold passes, `matchBaseline: 1` |
| `db:migrate && db:status` (scratch DB `graft_s6r1_dod`) | `0001`..`0014` applied |
| `db:rollback && db:status && db:migrate` | Only `0014_mcp` rolled back (`pending`), then re-applied |
| `@ts-ignore` / `@ts-expect-error` grep | Clean |
| `src/mcp/` import grep | Clean |
| Content-read grep in `src/modules/mcp/`, `src/mcp/` | Clean |
| `feature: "mcp"` outside `open-change.ts` | Clean |
| `@modelcontextprotocol/sdk` grep | Clean |
| Exact-pin grep (`"@modelcontextprotocol/…": "^`) | Clean (`server 2.3.1`, `node 2.1.1`, `client 2.3.1`) |
| Test ID grep | 47 lines |
| CI on PR #40 (`gh pr checks 40`) | `check` **pass** (5m24s), `build` pass; `deploy` and the Graft checks skipped |

I did not run the manual smoke test or the T1 checks with real clients. They need a dev server and real MCP clients, and they are in HUMAN-TODO.

### Mutation checks (spec §16)

I applied each mutation alone with a script, ran the step's unit files (`mcp-tokens`, `mcp-schemas`, `mcp-rate-limit`, `provenance-mcp-merge`, `mutation-guard`, `policy-evaluate`, `policy-facts`) and `test/integration/mcp.test.ts` (plus `neutral.test.ts` where marked N) against a scratch database (`graft_s6r1m`), then restored the file with `git checkout`. `git status` was clean after the run.

| # | Mutation (how I applied it) | Result |
| --- | --- | --- |
| S1a | Token stored in clear (`tokenHash: token` in `cli.ts`) | Killed: I-MCP-17 (the `token_hash` CHECK refuses the insert, as the developer recorded) |
| S1b | The secret placed in `AuthInfo.token` | Killed: I-MCP-16 |
| S2 | Revocation cached (a per-process `Map` in front of `authorizeToken`) | Killed: I-MCP-3, I-MCP-15, I-MCP-17 |
| S3 | `repository` argument trusted (`checkRepository` a no-op) | Killed: I-MCP-4 |
| S4 | `open_change` skips the early mode read (N) | Killed: I-MCP-9, N-14 |
| S5 | `mcp` body rule removed (N) | Killed: U-MG-MCP-1, U-MG-MCP-2, U-MG-MCP-3 |
| S6 | A disagreeing report leaves the author fact as the trailers say (`buildFacts` ignores `mcp_report`) (N) | Killed: U-PMM-2, I-MCP-8 |
| S7 | A disagreeing report replaces the agent with the reported one (the job stores the reported agent as a trailer and `mcp_report = none`) (N) | Killed: I-MCP-8 |
| S8 | A second report for the same head overwrites the first (delete and re-insert in place of `already_reported`) | Killed: I-MCP-8 |
| S9 | Commit authors of an MCP-opened PR can approve it (`excludedLogins` ignored) | Killed: U-APP-MCP-1, I-MCP-14 |
| S10 | Null commit author treated as nobody to exclude | Killed: I-MCP-14 |
| S11 | Hourly open cap counted in memory (per server instance) | Killed: I-MCP-12 |
| S12 | Tokens kept active across a transfer (the D12 call removed) | Killed: I-MCP-15 |
| S13 | Arguments logged (the `mcp call` line gains `args`) | Killed: I-MCP-16 |

### Extra mutations (mine, on the security-critical paths)

X19 and X61 were dropped before the run (badly formed), so the numbers have two gaps.

| # | Mutation | Result |
| --- | --- | --- |
| X1 | `hashToken` hashes only the secret, not the prefix | Killed: U-MCPT-1 |
| X2 | `parseBearer` case-insensitive | Killed: U-MCPT-2, I-MCP-3 |
| X3 | Lookup ignores `expires_at` | Killed: I-MCP-3 |
| X4 | Lookup ignores the repository's `removed_at` | Killed: I-MCP-3 |
| X5 | **Lookup ignores a deleted installation** (`auth.ts:35`) | **Survived** (finding 6) |
| X6 | **Lookup ignores a suspended installation** (`auth.ts:36`) | **Survived** (finding 6) |
| X7 | **Lookup by `token_prefix` only** (`auth.ts:31`) | **Survived** (finding 2) |
| X8 | Lookup ignores `revoked_at` | Killed: I-MCP-3, I-MCP-15, I-MCP-17 |
| X9 | A malformed header gets its own 401 body | Killed: I-MCP-3 |
| X10 | An unknown token gets no `WWW-Authenticate` | Killed: I-MCP-3 |
| X11 | Origin check removed | Killed: I-MCP-6 |
| X12 | Origin checked after the token lookup | Killed: I-MCP-6 |
| X13 | Origin compared case-sensitively | Killed: I-MCP-6 |
| X14 | **An empty `Origin` header skips the check** | **Survived** (finding 6) |
| X15 | **The literal `Origin: null` allowed** | **Survived** (finding 6) |
| X16 | D8 compared case-sensitively | Killed: I-MCP-4 |
| X17 | `get_status` reads the PR number in any repository | Killed: I-MCP-4 |
| X18 | **`report_provenance` reads the PR number in any repository** (`report-provenance.ts:45`) | **Survived** (finding 2) |
| X20 | `mcpAgreement` case-sensitive | Killed: U-PMM-1, I-MCP-8 |
| X21 | No trailers or another head → `none` | Killed: U-PMM-1 |
| X22 | A `human` trailer author with the same agent agrees | Survived: equivalent (a `human` row always has `agent = null`, `compute.ts:126-133`) |
| X23 | **Policy job: the stricter-of-two merge dropped** (`job.ts:366`, `null` in place of the trailers' author) (N) | **Survived** (finding 1) |
| X24 | `stricterVerdict` does not merge two `would_require` | Killed: U-PMM-3, U-PMM-3b |
| X25 | `stricterVerdict` keeps the lower outcome | Killed: U-PMM-3, I-MCP-8 |
| X26 | The job uses the newest MCP report of any head (N) | Killed: I-MCP-8 |
| X27 | The job never compares a report (`mcp_report` always `none`) (N) | Killed: I-MCP-8 |
| X28 | **D14 "identical repeat" compares the agent only** | **Survived** (finding 6) |
| X29 | D15: closed PR accepted | Killed: I-MCP-8 |
| X30 | D15: stale head accepted | Killed: I-MCP-8 |
| X31 | D15: no `provenance.refresh` enqueued (N) | Killed: I-MCP-8, N-14 |
| X32 | `buildFacts` keeps trailer facts of an older head when `mcp_report = none` | Not counted: it mutates step 2's head rule, not step 6 code, and I ran only step 6 files |
| X33 | D16: a default client made before the mode read (N) | Killed: I-MCP-9, N-14 |
| X34 | D16: `repos.get` before the mode read (N) | Killed: I-MCP-9, N-14 |
| X35 | D16: `=== "off"` in place of `!== "on"` (N) | Survived: equivalent (`mcp_write` is a `Switch`, on or off) |
| X36 | A `mode_off` gate refusal returned as `internal` | Killed: I-MCP-13 |
| X37 | D17: `head` may be the default branch | Killed: I-MCP-12 |
| X38 | D17: `graft-revert/` allowed (N) | Killed: U-MCPS-2, U-MG-MCP-2, U-MG-MCP-3, I-MCP-12 |
| X39 | D17: `..` allowed | Killed: U-MCPS-2, U-MG-MCP-2, I-MCP-12 |
| X40 | D17: `.lock` allowed | Killed: U-MCPS-2, I-MCP-12 |
| X41 | D17: leading `-` allowed | Killed: U-MCPS-2 |
| X42 | D17: trailing `/` allowed | Killed: U-MCPS-2 |
| X43 | D17: `:` allowed (`owner:branch`) | Killed: U-MCPS-2, U-MG-MCP-2, I-MCP-12 |
| X44 | **D17: the tool checks `base` for existence only, not the name rule** (`open-change.ts:123`) | **Survived** (finding 6; the mutation guard still refuses such a body, so the tool would answer `internal`) |
| X45 | D17: `head` existence not checked | Killed: I-MCP-12 |
| X46 | D17: no lookup by head before the create (N) | Killed: I-MCP-11, I-MCP-13, N-15 |
| X47 | `adopt()` marks a person's PR | Killed: I-MCP-11 |
| X48 | `mcp` body: `maintainer_can_modify: true` allowed | Killed: U-MG-MCP-2 |
| X49 | `mcp` body: extra keys allowed | Killed: U-MG-MCP-1, U-MG-MCP-2 |
| X50 | `mcp` body: `head` not checked with the name rule | Killed: U-MG-MCP-2, U-MG-MCP-3 |
| X51 | `mcp` body: `base` not checked with the name rule | Killed: U-MG-MCP-2 |
| X52 | D9 a: one request too many (`tokens < 0`) | Killed: U-MCPRL-1, I-MCP-7 |
| X53 | D9 a: bucket per repository, not per token | Killed: I-MCP-7 |
| X54 | D9 a: the per-token preHandler removed | Killed: I-MCP-7 |
| X55 | **D9 b: a success resets the IP's failure count** (in `http.ts`) | **Survived** (finding 6) |
| X56 | D9 b: a blocked IP is still looked up | Killed: I-MCP-7 |
| X57 | **D9 b: one failure counter for every IP** (`http.ts:69`, `ip = "all"`) | **Survived** (finding 6) |
| X58 | **D9 b: a malformed header is not counted** | **Survived** (finding 6) |
| X59 | D9 c: off by one (`>`) | Killed: I-MCP-12 |
| X60 | D9 c: counted over all time | Killed: I-MCP-12 |
| X62 | D10: `redactTokens` is the identity | Killed: U-MCPT-3 |
| X63 | **D10: a failing tool logs the raw error and the arguments** (`server.ts:82`) | **Survived** (finding 3) |
| X64 | **D10: the SDK `onerror` logs the raw error** (`http.ts:36`) | **Survived** (finding 3) |
| X65 | D10: the tool result logged | Killed: I-MCP-16 |
| X66 | **D19: committers not excluded** (`facts.ts:189-191`) | **Survived** (finding 4) |
| X67 | D19: exclusion case-sensitive | Killed: U-APP-MCP-1 |
| X68 | D19: `everyone` does not mark the count truncated | Killed: U-APP-MCP-1, I-MCP-14 |
| X69 | **D19: more than 250 commits not refused up front** (`facts.ts:173`) | **Survived** (finding 4) |
| X70 | **D19: the `mcp_changes` lookup ignores the repository** (`job.ts`, `openedThroughMcp`) | **Survived** (finding 6) |
| X71 | D12: a re-added repository keeps its tokens | Killed: I-MCP-15 |

### Safety review

- **Who can write.** The only `mcp` client is at `open-change.ts:147`, after the D16 read, the D17 checks and the D9 (c) count. Every `mcp` write runs through `installMutationGuard`, the body rule runs before the gate (a bad body never queries the database), and the gate re-reads `mcp_write` per request. A rollback between the two reads is refused with `mode_off` and returned as `mcp_write_off` / `mode_changed` (I-MCP-13). No new GitHub App permission: `pull_requests: write` is Phase 0's.
- **Reads in report mode.** `get_status` reads the database only. `get_policy` makes GETs through the default client and the existing loader (`repos.get`, the ref, `graft.yaml`). `report_provenance` makes no request; its refresh job republishes the provenance check and comment section, both Phase 0 routes (N-14).
- **Authentication.** `parseBearer` accepts exactly `^Bearer (graft_mcp_[A-Za-z0-9_-]{43})$`. `authorizeToken` (`auth.ts:25-45`) joins the token to an active repository and an active, unsuspended installation in one query. No cache. A query-string or cookie token is ignored (I-MCP-3). The Origin check runs first and is refused before any lookup (I-MCP-6). The configured origins are validated at start (`u.origin === o`, so they are already lower case) and compared with the lowercased header.
- **Scoping (D8).** `checkRepository` compares the argument with the token's current `full_name`, and every tool reads the PR with the principal's `repositoryId`. A rename keeps the token working under the new name. The tests pin this for `get_status` but not for `report_provenance` (finding 2).
- **Provenance (D13–D15).** The report is validated with the trailer validators, stored once per head under the change lock (backed by the `(change_id, source, commit_sha)` key), refused for a closed PR or a stale head, and compared in the job with the trailers of the same head. `buildFacts` gives `unknown` only when `mcp_report = 'disagrees'` *and* the row is for the evaluated head. `persistProvenance` deletes only `trailer` and `pr_body` rows, so the MCP row survives a recompute. The job's `evaluateWithReport` keeps the stricter verdict (finding 1 is about its test, not its logic: I checked `stricterVerdict` by hand on block/require/approve pairs and on the U-PMM-3b policy).
- **`open_change` (D16–D18).** The order is the spec's. The body is exactly the §7 keys; the trailer block is built from validated values; title and body go to GitHub only (I-MCP-11 checks the result and the row). `url` is built from the stored `full_name`. A 422 is never parsed.
- **D19.** For a PR with an `mcp_changes` row, the job reads `pulls.listCommits` (logins only) and excludes authors and committers; a missing author login or more than 250 commits excludes everyone and sets `truncated`. The trust in git commit authors is recorded as a residual risk for step 7, and I agree it is out of this step's reach.
- **D12.** `revokeTokensOnTransfer` runs first in `upsertRepositories`' loop, in the same transaction, for a move and for a re-add.
- **Storage and logs.** New columns hold hashes, prefixes, names, actors, numbers and SHAs. The `mcp call` line is `{ tool, tokenId, repositoryId, outcome, ms }`. `detail` is always fixed text. Request logging stays off, and `Authorization` is redacted.

### Developer-reported deviations and choices (decisions.md)

- **D13: the stricter of two verdicts.** Agreed. The counterexample is right: an `unknown` author can match a looser `require` rule and so displace a stricter `default`. Evaluating with both authors and keeping the stricter one is the minimal fix, and `stricterVerdict` merges two `would_require` verdicts as one evaluation would. Its only weakness is that no integration test runs it (finding 1).
- **D20: schema failures are tool errors**, not `-32602`. Agreed: it is the SDK's behaviour, the tool never runs, and I-MCP-5 pins it.
- **N-15 restates N-8 for `max`.** Agreed.
- **`readOnlyHint: true` on `report_provenance`.** It follows the spec's "three reads", but see nit 8.
- **Adopting a bot's PR** (`3b1a5be`). Agreed that a PR Graft opened must not lose D19 after a crash. Disagreed with "any bot": finding 5.
- **The two residual risks** (the failed-auth lockout behind a proxy, D19's trust in commit authors). Agreed, both are correctly described and both belong to step 7. The first is made more likely by X57 having no test (finding 6).
- **Other choices.** I checked each one against the code: the principal passed through the factory, the HTTP order, the 10,000-key bound on the buckets, expired-name reuse, the repository row lock in `createTokenRow`, `listCommitLogins` paging, and the imports (`mutation-guard.ts` takes only the pure `validBranchName`). All match.

## Findings

### 1. required: the D13 fix in the policy job has no test above the unit level

The deviation exists because `evaluatePolicy` with the unknown author alone can loosen a verdict. The fix is `evaluateWithReport` (`src/policy/evaluate.ts:457-469`), called by the policy job with the trailers' author when the stored report disagrees (`src/modules/policy/job.ts:359-367`). U-PMM-3 and U-PMM-3b test `evaluateWithReport` directly. But I-MCP-8 uses a policy (`AGENT_POLICY`, `mcp.test.ts:65`) whose `default` asks for nothing stricter than the codex rule, so the job's result is the same with or without the merge.

**Probe:** mutation X23 passes `null` for the trailers' author at `job.ts:366`, which is exactly the loosening the deviation fixes. Every test in the step's unit files, `mcp.test.ts` and `neutral.test.ts` still passes.

**Fix:**
- Add an I-MCP-8 case (or I-MCP-8b) with U-PMM-3b's policy (`default: require { humans: 1, team: security }` and a rule `match: { agent: [codex] }` → `require: { humans: 1 }`), trailers saying `claude-code`, and a disagreeing report naming `codex`. After the provenance and policy jobs, the stored verdict must still require a `security` reviewer (and add the codex rule as matched, uncertain).
- X23 must then fail.

### 2. required: the hash lookup and `report_provenance`'s scoping are not pinned by any test

Both are correct in the code today. Both are the step's authentication and scoping boundary, and both can regress silently.

- **The hash.** `authorizeToken` looks the token up by `token_hash = hashToken(token)` (`src/modules/mcp/auth.ts:31`). Mutation X7 looks it up by `token_prefix` (the 8 characters after `graft_mcp_`) and every test passes: I-MCP-3's unknown token (`graft_mcp_AAAA…`) never shares a prefix with a stored one. With that mutation, anyone who sees a token's prefix (it is printed by `mcp-token list` and meant to be shown) could forge a working token.
- **`report_provenance` in another repository.** `getChangeByNumber(db, principal.repositoryId, input.pr)` (`report-provenance.ts:45`) is the only thing keeping a token for B from storing a report on A's PR, which would make A's author `unknown` and trigger A's provenance republish. Mutation X18 reads the PR in any repository, and every test passes. I-MCP-4 pins "PR numbers resolve only within B" for `get_status` only; its `report_provenance` call is refused earlier by D8.

**Fix:**
- I-MCP-3: add a token that keeps a valid token's `graft_mcp_` and 8-character prefix and changes one later character. It must get the same `401` body. X7 must fail.
- I-MCP-4: with the token for B, call `report_provenance` with `repository: B` and the PR number that exists only in A (with A's head). It must return `not_found`, store no `provenance` row and enqueue no `provenance.refresh`. Do the same for `get_status` (already there) so the test names both tools. X18 must fail.

### 3. recommended: the D10 redaction is tested only with errors that carry nothing

I-MCP-16 (`mcp.test.ts:1091`) sends two messages the SDK rejects. Their error messages contain neither the token nor the sentinels, so logging the raw error passes as well. No test reaches `mcp tool failed` at all.

**Probe:** X63 (`server.ts:82` logs `{ err, args }` in place of `safeMcpError(err)`) and X64 (`http.ts:36` logs the raw SDK error) both survive. X63 logs every tool argument, which D10 forbids by name. An Octokit `RequestError` also carries `request.body`, so a raw error from the `pulls.create` path would carry the PR title and body.

**Fix:**
- In I-MCP-16, make one tool fail with a non-`ToolError` whose message holds the token, a body sentinel and an argument sentinel (for example a fake `forInstallation` that throws such an error for `get_policy`). The result must be `internal`, and the log must have one `mcp tool failed` line with none of the three.
- Drive the SDK `onerror` path with an error whose message holds the token (for example a factory that throws for one request), and check the line holds `graft_mcp_[redacted]`.
- X63 and X64 must then fail.

### 4. recommended: two D19 rules have no test

| Rule | Mutation | Test to add |
| --- | --- | --- |
| Committers are excluded, not only authors (`facts.ts:189-191`) | X66 survives: I-MCP-14's only committer is `web-flow` | I-MCP-14: a commit authored by `alice` and committed by `carol`; `carol`'s approval does not count |
| More than 250 commits → no approval counts (`facts.ts:173`) | X69 survives | I-MCP-14: `pulls.get` says 260 commits and the listing returns 250 (GitHub's cap, T1 g). No approval counts, `truncated: true` |

The second matters more than it looks. GitHub's endpoint returns at most 250 commits, so the later `seen > MAX_COMMIT_LOGINS` check (`facts.ts:196`) can never fire against real GitHub. The up-front count is the only guard, and without it the authors of commit 251 onwards could approve.

### 5. recommended: `open_change` adopts any bot's PR, not only Graft's

`findOpenPull` sets `byBot` from `hit.user?.type === "Bot"` (`open-change.ts:71`), and `adopt` writes an `mcp_changes` row for it (`open-change.ts:83-94`). The decisions say "Marking another bot's PR only makes its approvals stricter". That is true per approval, but it has three effects a token holder controls:
- **Approvals can be switched off on another bot's PR.** With `mcp_write` on, `open_change` with the head of a Dependabot or Renovate branch marks that PR. Then D19 reads its commits, and a commit with no author login (common for bot commits whose email maps to no user) gives `excludedLogins: "everyone"`. In enforce mode, no approval of that PR can ever count.
- **`get_status` says `openedThroughMcp: true`** for a PR Graft never opened.
- **The adoption fills the D9 (c) cap.** The row's `created_at` is now, so it counts as an open in the rolling hour.

**Fix:** adopt only a PR whose author is Graft's own bot: compare `hit.user.login` with `` `${config.githubAppSlug}[bot]` `` (as the provenance job already builds `appBotLogin`), and adopt nothing when the slug is not configured. Extend I-MCP-11 with a PR by `renovate[bot]` that is returned with `existing: true` and not recorded.

### 6. minor: nine more rules have no test

| Rule | Mutation | Test to add |
| --- | --- | --- |
| A deleted or suspended installation's tokens fail D7 (`auth.ts:35-36`) | X5, X6 survive | I-MCP-3: set `deleted_at`, then `suspended_at`, on the installation: `401`, same body |
| An empty `Origin` header is refused | X14 survives | I-MCP-6: `Origin: ""` → `403` |
| `Origin: null` (a sandboxed iframe or a `file:` page) is refused | X15 survives | I-MCP-6: `Origin: null` → `403` |
| D9 b is keyed by the client IP | X57 survives: a global counter (the proxy case of the residual risk, for everyone) passes | I-MCP-7: after one IP is blocked, a request from another address is served. Fastify's `inject` with `remoteAddress` can do it |
| D9 b: a success does not reset the count | X55 survives: U-MCPRL-2 tests the counter, which has no reset; nothing tests `http.ts` | I-MCP-7: 19 bad tokens, one good call, then the 20th and 21st bad tokens: the 21st is `429` |
| D9 b: a malformed header counts (decisions.md) | X58 survives | I-MCP-7: use a malformed header for some of the 20 failures |
| D14: an identical repeat compares every field | X28 survives | I-MCP-8: a second report that changes only `model` → `already_reported` |
| D17: the tool applies the name rule to `base` | X44 survives (the mutation guard refuses the body later, so the tool would say `internal`) | I-MCP-12: an existing branch `graft-revert/x` as `base` → `base_not_found`, no `mcp` client |
| D19 looks up `mcp_changes` within the repository | X70 survives | I-MCP-14: a row for the same PR number in repository B must not exclude anyone in A |

### 7. minor: the hourly cap can be exceeded by concurrent calls

D9 (c) is a count (`open-change.ts:140`), then the create, then the insert (`open-change.ts:185`), with no lock. N concurrent `open_change` calls at 9 opens all pass the count, so the repository gets 9 + N PRs in the hour. The per-token limit bounds N, so the damage is small, but D9 says "at most".

**Fix (pick one, record it):** claim a slot before the create (insert an `mcp_changes` row with a placeholder and update it with the PR number, or a separate claim table) under a short transaction that counts and inserts with a repository-row lock, as `createTokenRow` does. No GitHub call goes inside the lock. Or record in decisions.md that the cap is "at most 10 plus the concurrent calls" and why that is acceptable.

### 8. nit: `report_provenance` is advertised as `readOnlyHint: true`

An MCP client may run a tool marked read-only without asking the user. `report_provenance` stores data, can make a verdict stricter, and republishes the check run and the comment section. The spec's "three reads" put it there, but its effects are not reads. Advertise `readOnlyHint: false, destructiveHint: false, idempotentHint: true`, as for `open_change`, and record the change.

### 9. nit: the body is parsed before authentication

The Origin check, the token and the rate limits run in `preHandler` (`http.ts:111`), after Fastify has read and parsed the body. An unauthenticated client therefore gets `413`, `415` or `400` before `401`, and the failed-auth limit does not cover JSON parsing of up to 64 KiB. None of it leaks anything. Moving `originCheck` and `authenticate` to `onRequest` (they read headers only) would make every unauthenticated request a `401` and keep D9 (b) in front of the parser.

### 10. nit: the fallback `401` in `rateLimit` is not the D5 response

`rateLimit` answers `401` with no `WWW-Authenticate` when `req.mcpAuth` is missing (`http.ts:87`). It cannot be reached today, but if it were, the "same bytes for every cause" rule would break. Use one `unauthorized(reply)` helper for both places.

## Required follow-up fixes

1. Finding 1: an integration case with U-PMM-3b's policy run through the provenance and policy jobs. X23 must fail.
2. Finding 2: a prefix-sharing token in I-MCP-3, and a cross-repository `report_provenance` in I-MCP-4. X7 and X18 must fail.

Recommended in the same fix PR: findings 3, 4 and 5. Findings 6 and 7 should land before a pilot repository turns `mcp_write` on. The nits can go with them or be recorded.

## Recommendation

PR #40 is merged, and I see no reason to revert it. Report mode is inert by construction and by test (S4, X33 and X34 are killed by I-MCP-9 and N-14), the one write is gated twice, and the code of every security-critical path I read is correct. The required findings are about tests: the D13 fix and two boundary properties are right today but unguarded, and this codebase has relied on mutations to keep such properties from regressing. Open a fix PR on a branch from `main` with findings 1 and 2, preferably 3 to 5, re-run the definition of done and the mutations named here, then run review 2. Until then, issue tokens only for the sandbox, keep `mcp_write` off on every pilot repository, and do the HUMAN-TODO checks with real clients.
