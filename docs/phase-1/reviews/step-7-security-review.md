# Phase 1 step 7 security review: everything that writes

Verdict: READY FOR PILOT ENFORCEMENT

Reviewer: the developer agent (Claude Code, model `claude-opus-5-5`).

Scope: branch `claude/phase-1-step-7-build`, from `b6c9d04` (the step 7 spec, the last commit before any hardening, on top of the step 6 review 1 fixes of PR #42) to the hardening commits `3925002` (H1), `805d420` (H2), `f88a5c6` (H3), `24781be` (H4 to H7), `1efa878` (H9), `00a6d2a` (the Phase 1 gate, which also carries the CLI part of H8), `63b0c62` (H8) and `93a9149` (the D21 enforce sandbox). The areas are those of spec §5: the mutation guard and the client factory, the ceiling and the modes, break-glass, the revert tree and the revert job, the MCP endpoint and its one write, and the Phase 1 permissions.

Every blocker and major is fixed. H1 to H9 are listed as findings 1 to 9 and are fixed with tests. Three minors and two nits remain, each accepted or deferred below with a reason; none loosens report mode, an approval or a refusal. A person still has to sign this verdict off before any repository leaves runbook stage 2 (HUMAN-TODO, step 7).

## What was checked

- **DoD chain** (on the final commit, against a throwaway `postgres:18-alpine` on `127.0.0.1:55491`; the shared container on port 55432 was not running). `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm eval:ci` pass; `db:migrate`, `db:status`, `db:rollback` (only `0016_phase1_gate`) and `db:migrate` again pass on a scratch database. The numbers are in [decisions.md](../../decisions.md#phase-1-step-7-security-review-pilots-gate). The greps of spec §15: no `@ts-ignore` or `@ts-expect-error` in `src/`; the three `{ feature: "…" }` constructions are in `policy/job.ts`, `guard/revert.ts` and `mcp/tools/open-change.ts` only; `src/pilot/gate-phase1.ts` names no pre-aggregated table; the test-ID grep is non-zero.
- **The write-call inventory** of Q-MG-1 (below), from the spec's grep plus `.request(` calls, which the grep misses.
- **Probes** (a script against `installMutationGuard` with the fake GitHub, an allow-all gate, and the real gate on the test database; results under each question).
- **Mutations.** The 22 mutations of spec §15 and the variants listed in decisions.md, each applied alone by a script, the named test files run, the file restored; results in [decisions.md](../../decisions.md#phase-1-step-7-security-review-pilots-gate). The one survivor is an equivalent mutation (finding 12).

## Findings

1. **major** — `src/modules/modes/effective.ts:11`, `src/modules/modes/store.ts:47` (H1, step 2 review 1, finding 7). **Problem:** each process trusted its own `GRAFT_MODE_CEILING`. During a rolling restart that lowers the ceiling, an old worker with `enforce` could publish a `success` or `failure` after the new worker republished `neutral`, and the conclusion stayed until the PR's next trigger. **Fix:** D2. `effectiveCeiling(env, stored)` (`src/modes/index.ts`) is the lower of the process's value and `service_state('mode_ceiling')`, read in the same query as the repository's modes (a scalar subquery); a missing row is the process's value, an unknown value `report`. Every effective-mode computation (`getEffectiveModes`, `mutationGate`, `mode show`, the doctor, the guard's settlement) goes through `modesOf`, which applies it. Tests U-CEIL-1/2, I-CEIL-1..3, N-17. **Status:** fixed in `3925002`.
2. **minor** — `src/github/mutation-guard.ts:174` (H2, step 5 review 2, nit D). **Problem:** the path normalisation dropped the query string, so `POST …/pulls?head=main&base=release` with a valid guard body was sent; GitHub ignores the query for a POST today, but a rule must not leave part of the request unexamined. **Fix:** D3. `writePath(raw)` returns null for a raw path with `?`; `classifyWrite`, `checkRunWrite`, `guardBodyAllowed` and `mcpBodyAllowed` use it, so every write with a query is `unknown_route`, Phase 0 routes included. `recordPulls` keeps the old normalisation, so the guard's `pulls.list` by head still records node ids. Tests U-MG-21, U-MG-22. **Status:** fixed in `805d420`.
3. **major** — `src/modules/guard/revert.ts:1159` (H3, step 5 review 2, finding A; with finding B and nit C, test-only). **Problem:** a run that died after `POST …/pulls` and then failed its last attempt was settled `error`, leaving an open revert PR that the cap, D17 (e), `revert_closed` and `guard.track` never saw. **Fix:** D4. On the last attempt, when the event has a revert branch or commit and no PR number, `settleBegunWrites` looks the PR up by head with the default client: found, it is adopted (`revert_opened`, outcome `opened`); not found or the lookup fails, no outcome is written and the next observe re-sends `guard.revert` after the job row expires. Tests I-REV-10c, I-REV-10d, I-REV-10e (stale age from the confirmation), U-RVC-1 (the conditional `revert_closed` update). **Status:** fixed in `f88a5c6`. See finding 10 for what this leaves.
4. **minor** — `src/modules/mcp/http.ts:121` (H4, step 6 review 1, nit 9). **Problem:** the Origin check and the token ran in `preHandler`, after Fastify parsed and bounded the body, so an unauthenticated client could make the server parse up to 64 KiB of JSON and got `413`/`415` before `401`. **Fix:** D5. `originCheck` and `authenticate` run in `onRequest` (headers only); `rateLimit` stays in `preHandler`. Test I-MCP-6b. **Status:** fixed in `24781be`.
5. **major** — `src/http/server.ts:14` (H4, step 6 residual risk 1). **Problem:** behind a proxy every MCP client shared the proxy's address, so 20 bad tokens from anyone locked every client out for the rest of the minute. **Fix:** D6. `GRAFT_TRUST_PROXY`, a list of IPs or CIDR ranges, is passed to Fastify as `trustProxy` (never `true`); `true`, hop counts, hostnames and bad prefixes are a `ConfigError` naming the entry's position only. Tests I-MCP-7b, U-CFG-40. **Status:** fixed in `24781be`; the operator still has to set it (HUMAN-TODO).
6. **nit** — `src/modules/mcp/server.ts:127` (H5, step 6 review 1, nit 8). **Problem:** `report_provenance` was annotated `readOnlyHint: true` although it stores a row, can tighten a verdict and republishes. **Fix:** D7, `readOnlyHint: false, destructiveHint: false, idempotentHint: true`. Test I-MCP-2 (all four tools' annotations). **Status:** fixed in `24781be`.
7. **major** — `src/modules/policy/facts.ts:169` (H6, step 6 residual risk 2). **Problem:** D19 excluded the commit authors and committers of an MCP-opened PR, but whoever pushes chooses those emails: a pusher could commit as someone else and approve the PR. **Fix:** D8. `listCommitLogins` answers the logins only when every commit has `commit.verification.verified === true` and a committer GitHub links to an account (or `web-flow`); otherwise `unverified` (or `too_many`, `no_author`), and the policy job passes `excludedLogins: "everyone"`. The reason is stored as `approvals.mcpExclusion` and shown as one line in the policy section (and so in the facts hash). Tests U-FCT-1, I-MCP-14b. **Status:** fixed in `24781be`. The product decision to keep it is pending (`REQUIRE_VERIFIED_COMMITS`, HUMAN-TODO); agents must sign their commits.
8. **minor** — `src/modules/pilot/rollup.ts:282`, `src/config/index.ts:420`, `src/pilot/gate-phase1.ts` (H7, step 6 review 2, finding B and nits A, C to F). **Problem:** a crashed claim in a quiet repository waited for that repository's next claim; any count of MCP PRs had to filter claims; the slug was compared case-sensitively with lower-case `[bot]` logins; four rules had no test. **Fix:** D9. The daily rollup deletes claims older than an hour (`purgeStaleClaims`); the gate counts `mcp_changes` rows with a PR number, joined to the change and timed by `changes.opened_at`; `GITHUB_APP_SLUG` is lowercased. Tests I-ROLL-5, I-MCP-1b, I-MCP-1c, I-MCP-11b, I-MCP-12c, U-CFG-41, I-P1G-7. **Status:** fixed in `24781be` and `00a6d2a`.
9. **minor** — `src/bin/graft-ops.ts` (`mode set`), `src/pilot/doctor.ts` (H8, step 2 review 1, finding 4). **Problem:** on a public repository, 21 or more outsider change requests block an enforcing check (fail closed): a nuisance, not a bypass, but not a Phase 1 pilot target. **Fix:** D10. `mode set --policy enforce` on a repository with `private = false` exits 1 with nothing written unless `--public`; the doctor's `public_enforce` WARN; the runbook keeps public repositories in report mode. Tests I-MODE-PUB-1, I-DOC-5. **Status:** fixed in `00a6d2a` (CLI) and `63b0c62` (doctor).
10. **minor** — `src/modules/guard/revert.ts` (`settleBegunWrites`), found while fixing finding 3. **Problem:** D4 says "the comment is published as today", but the published comment sets `comment_id`, and both `runRevert` and observe's re-send (`eventsAwaitingComment`) skip an event with a comment. Publishing it would stop the resumption D4 exists for. **Fix:** in the two D4 cases the comment is not written; the resumed run writes it as its last step. What remains: until the next observe of the repository (a push or a check run on the default branch), an adopted PR has no label and auto-merge, and a "resumable" event holds its claimed cap slot. Both fail closed (no write is lost, the cap only refuses more). **Status:** accepted; recorded in decisions.md as a deviation.
11. **nit** — `src/e2e/guard.ts:outsiderMayUse` (D21). **Problem:** e01 (b) needs the outsider to approve; the runner's write guard now lets the outsider `POST …/pulls/{n}/reviews` with `event: APPROVE` on any PR of the sandbox, not only a run PR. **Fix:** none needed: the guard still confines every write to the sandbox, and the outsider is a collaborator there. **Status:** accepted.
12. **nit** — `src/pilot/gate-phase1.ts` (the MCP count). **Problem:** the spec's mutation "MCP PR count without `pr_number IS NOT NULL`" survives: the count joins `mcp_changes` to `changes` on `pr_number`, and a claim's null never matches, so the filter is redundant and the mutation is equivalent. **Fix:** kept the filter (it states the rule); I-P1G-7 kills the variant that times a PR by `mcp_changes.created_at`. **Status:** accepted.

H9 (D13, settled guard events record their guard mode, `1efa878`, test I-GRD-MODE-1) is a correctness fix the gate needs (§8.4), not a security finding.

Accepted with documentation, no code (spec §6): **D11**, the 1,000-event cap on break-glass (fails closed, `actor_unknown`; the runbook's stage 0 requires the label-lag and `Link: rel="last"` measurements) and **D12**, the guard's framing boundary (Q-RV-8).

## Questions, answered

### Mutation guard and clients

**Q-MG-1. Inventory.** Every write call in `src/` on the final commit (the spec's grep, plus `.request(` with a template string, which it misses):

| File and line | Method and route | Class | Client | Test through the guard |
| --- | --- | --- | --- | --- |
| `github/managed-comment.ts:161` | `POST …/issues/{n}/comments` | phase0 | default | U-MG-12, N-1 |
| `github/managed-comment.ts:170` | `PATCH …/issues/comments/{n}` | phase0 | default | N-1 |
| `modules/guard/comment.ts:280` | `POST …/issues/{n}/comments` | phase0 | default | N-1g |
| `modules/intent/job.ts:399`, `:406` | `PATCH …/check-runs/{n}`, `POST …/check-runs` (neutral) | phase0 | default | N-2, U-MG-12 |
| `modules/provenance/job.ts:80`, `:83` | `PATCH`/`POST` check runs (neutral) | phase0 | default | N-2 |
| `modules/policy/job.ts:641`, `:648` | `PATCH`/`POST` `graft/policy` (neutral, or non-neutral in enforce) | phase0 / phase1 by body | `policy` | U-MG-14, N-7, I-CEIL-1 |
| `modules/guard/revert.ts:608` | `POST …/git/trees` | phase1 | `guard` | U-MG-18, N-12 |
| `modules/guard/revert.ts:631` | `POST …/git/commits` | phase1 | `guard` | U-MG-18 |
| `modules/guard/revert.ts:646` | `POST …/git/refs` (`refs/heads/graft-revert/<uuid>`) | phase1 | `guard` | U-MG-18, U-MG-20 |
| `modules/guard/revert.ts:672` | `DELETE …/git/refs/heads/graft-revert/<uuid>` (`.request`) | phase1 | `guard` | U-MG-18, I-REV-10 |
| `modules/guard/revert.ts:695` | `POST …/pulls` (head `graft-revert/<uuid>`) | phase1 | `guard` | U-MG-18, U-MG-21 |
| `modules/guard/revert.ts:727` | `POST …/issues/{n}/labels` (`graft:revert`) | phase1 | `guard` | U-MG-18, U-MG-20 |
| `modules/guard/revert.ts:749` | `POST /graphql` (`ENABLE_AUTO_MERGE_MUTATION`) | phase1 | `guard` | U-MG-19, U-MG-22 |
| `modules/mcp/tools/open-change.ts:182` | `POST …/pulls` (the `open_change` body) | phase1 | `mcp` | U-MG-MCP-1..4, N-15 |
| the client factory (Octokit auth) | `POST /app/installations/{id}/access_tokens` | auth | — | U-MG-7 |
| `src/e2e/*` (runner only) | the runner's own writes, through its own sandbox guard (`e2e/guard.ts`), never through Graft's clients | — | e2e clients | U-LIVE-GUARD-*, U-LIVE-ENF |

Every Graft hit is a row of `ROUTES` or a GET; the e2e runner's writes go through `checkRequest` (`src/e2e/guard.ts`) and the redelivery route (`app` class, App client only, U-MG-10).

**Q-MG-2. Path normalisation.** Probed with a guard client and an allow-all gate: `#` (`…/check-runs#x`), `%` (`…/check-runs%2F1`), `\`, `?` on every route (D3), `.` and `..` segments, an empty segment (`/repos//o/r/…`), a path not starting with `/` → `unknown_route`, nothing sent (U-MG-2, U-MG-21). A trailing slash is the route without it, and a lower-case `post` is classified as `POST` (U-MG-1): in the probe these two were the only requests of 22 that reached the fake API (which answered 422 for the unknown branch). Another host, and a per-request `baseUrl` that differs from the factory's, → `unknown_route` (U-MG-9, U-MG-9b). A GHES base `…/api/v3` is stripped and GraphQL is `…/api/graphql` (U-MG-5).

**Q-MG-3. Body rules.** Probed directly: `checkRunBodyKind(Object.create({ conclusion: "failure", status: "completed" }), "PATCH")` → `unreadable`; a `Map` → `unreadable`; `{ status: "completed", conclusion: "neutral", name: undefined }` → `neutral`; `guardBodyAllowed` with an extra key on the labels body, an inherited head or an `undefined` head → false; `mcpBodyAllowed` with an extra key, an inherited body or an `undefined` base → false. Check-run rule (`checkRunBodyKind`): a body passed through `data` is the body Octokit sends (`parsed.body`), a non-plain body (class instance, array) is `unreadable` → `unknown_route`, an inherited key (`Object.create({ conclusion: "failure" })`) is not an own key and the body is not plain → refused, an `undefined` value is absent (JSON drops it) (U-MG-13, U-MG-17). Guard rule: a ref outside `graft-revert/<uuid>`, a head outside it, a label other than `graft:revert`, an extra key on the labels body → `feature_not_allowed` (U-MG-20). MCP rule: an extra key, `maintainer_can_modify: true`, an `owner:` head, a `graft-revert/` head, a non-plain body → `feature_not_allowed` (U-MG-MCP-2). All fail closed, before the gate is asked.

**Q-MG-4. The gate.** `mutationGate` (`src/modules/modes/effective.ts:43`) runs `findActiveRepositoryByName` at every request: one `SELECT` of `repositories ⋈ installations` with the scalar subquery `(select ss.value from service_state ss where ss.key = 'mode_ceiling')` (`store.ts:47`), then `modesOf(row, config.modeCeiling)` = `effectiveModes({ ceiling: effectiveCeiling(env, stored), … })`. No cache: I-MODE-10 and I-MCP-13 change the mode between two requests and see the second refused.

**Q-MG-5. Feature clients.** `grep -rn "{ feature: \"" src/` gives exactly three: `policy/job.ts:194` (`policy`: can send a non-neutral `graft/policy` check run, nothing else), `guard/revert.ts:1123` (`guard`: trees, commits, the `graft-revert/<uuid>` ref and its deletion, the revert PR, the `graft:revert` label, the one GraphQL document for a PR it read or created), `mcp/tools/open-change.ts:178` (`mcp`: `POST …/pulls` with the `open_change` body). Each also needs the gate's answer for its feature.

**Q-MG-6. Blast radius.** With `contents: write` and `pull_requests: write`, an installation token without the guard could merge (`PUT …/pulls/{n}/merge`), move any branch (`PATCH …/git/refs/…`, `POST …/git/refs`), write files (`PUT …/contents/…`, `POST …/git/blobs`), approve or dismiss reviews, label, comment, and run any GraphQL mutation (`mergePullRequest`, `updateRef`). The guard keeps all of these unreachable: `PUT …/merge`, `PATCH …/git/refs`, `POST …/git/blobs`, `PUT …/contents`, reviews, dismissals, branch protection, statuses, workflow re-runs and every GraphQL document but `ENABLE_AUTO_MERGE_MUTATION` are `unknown_route` in every mode (U-MG-4, U-MG-20, U-MG-MCP-4). Branch protection needs `administration`, which neither manifest requests.

**Q-MG-7. Refusals and logs.** `MutationRefusedError` (`mutation-guard.ts:90`) names method, route template, feature and reason. Probe: a guard client sending `POST /repos/graft-sandbox/sample-ts/pulls?head=secret-branch` with `head: "secret-branch"` in the body → `GitHub write refused by the mutation guard: POST /repos/{owner}/{repo}/pulls (feature guard): unknown_route`; no branch name, no query, no body. The factory logs that message at `error` (U-MG-6, U-MG-11, U-MG-21 asserts the query is absent).

### Modes and rollback

**Q-MD-1.** With `S` the stored value and `E` a process's environment:
- **Lower, old worker first** (old `enforce` processes keep running, a new `report` worker starts): the new worker stores `report`; every old process computes `min(enforce, report) = report` from its next request (I-CEIL-1, N-17 [max]).
- **Lower, new worker first**: the same; the old worker's start, if it restarts later with `enforce`, cannot raise `S` above what the next new start stores, and until then computes `min` with the stored `report`.
- **Raise, old worker first** (old `report` processes, a new `enforce` worker): the new worker stores `enforce`; old processes compute `min(report, enforce) = report` until they restart (I-CEIL-3). Safe direction.
- **Raise, new worker first**: the same.
- **A server with no worker started**: no row, the process's value (I-CEIL-2). No rollback can have happened.
The residual: an old process that never restarts keeps `E` until a worker publishes a lower value.

**Q-MD-2.** The only writers of `repositories.policy_mode`, `guard_mode`, `mcp_write` are `mode set` (`src/bin/graft-ops.ts`, with a `mode_changes` row) and the transfer/re-add reset in `upsertRepositories` (`src/modules/installations/store.ts`, a `system` row). No label or PR text is read for a mode, and a `mode` key in `graft.yaml` stays `unknown_key` (I-MODE-2).

**Q-MD-3.** `upsertRepositories` resets the three keys with `system` rows on a transfer or a re-add (I-MODE-14) and calls `revokeTokensOnTransfer` first (I-MCP-15).

**Q-MD-4.** `mode set … report` writes the row; `modes.apply` (every minute) fans out `policy.fanout`, which republishes every open PR's check `neutral` (I-MODE-6, N-4). A ceiling change fans out once per worker start, under the compare-and-set (I-MODE-7). Left behind: an open revert PR and its auto-merge (Graft never disables auto-merge; the runbook's stage 4 rollback closes them by hand).

### Break-glass

**Q-BG-1.** `resolveBreakGlass` (`src/modules/policy/break-glass.ts`) reads the actor of the newest `labeled` issue event from the API, then `repos.getCollaboratorPermissionLevel` for that user id: below `maintain` → `role_too_low` (`break-glass.ts:386`); a `Bot` actor → `bot`; an unreadable role → `role_unverified`; no matching event (deleted actor, lag past the retries) → `actor_unknown` (U-BG-*, I-BG-*).

**Q-BG-2.** The bypass binds to the head SHA of the signed `labeled` delivery and to the newest `labeled` issue event of the label (its id is stored, `label_event_id`); a push (`head_moved`), an `unlabeled` event or delivery, or a later `labeled` event by someone else ends or replaces it (I-BG-*, N-11; I-LIVE-ENF-1 (d)→(e) live in the offline world).

**Q-BG-3.** At most 1,000 issue events are read; more → `actor_unknown` (D11, fails closed). The run retries while the queue allows (5 retries, backoff from 30 s) when the listed event is not the delivery's, then records `actor_unknown`. Every failure path writes `ignored` or nothing; none applies the bypass.

**Q-BG-4.** In report mode the audit rows are written (`policy_mode: report`) and the check stays `neutral` (N-10).

### Revert tree and job

**Q-RV-1.** The revert reads `git/trees`, `git/commits`, `git/ref`, `pulls` GETs and the policy loader's one `contents` read of `graft.yaml` (`trees.ts:39`, `:65`); I-REV-20 asserts it over every request of the file, I-REV-10c..e included.

**Q-RV-2.** D7 compares entries (path, mode, type, sha); D9's `treeMatchesPlan` re-reads the created tree before the commit and ends `error tree_mismatch` on any difference, including a directory GitHub did not delete for `sha: null` (I-REV-5b). The real behaviour of `sha: null` on a `tree` entry is HUMAN-TODO step 5, T1 (b); runbook stage 0 requires it.

**Q-RV-3.** Names come from trees, never from user text; a `/` inside a name, `.`, `..`, a workflow path, a submodule (`commit` type), a type change and the path and read bounds end `needs_human` or `skipped` before any write (U-RVP-*).

**Q-RV-4.** One revert per event: the pg-boss singleton (`revertKey`), the claim under the repository lock (`withRepositoryGuardLock`), the D17 resume points (commit, ref, PR found by head), the partial unique index `(repository_id, culprit_change_id) WHERE revert_pr_number IS NOT NULL`, and D4 (finding 3): a last attempt after writes began adopts the PR or stays resumable (I-REV-10, I-REV-10c, I-REV-10d, I-REV-11).

**Q-RV-5.** The branch, PR head and base, label and GraphQL rules are those of Q-MG-3; the GraphQL `pullRequestId` must be a node id this client read or created for the repository and number its client mutation id names (U-MG-19); D3 adds that the `pulls.list` by head that records it is a GET (U-MG-22).

**Q-RV-6.** `eventByRevertPr` reads the database row: a culprit that is a Graft revert PR is `skipped revert_of_revert`; a look-alike branch or trailer is not (I-REV-9).

**Q-RV-7.** Auto-merge needs every D14 condition, with `guard.auto_merge_reverts` read at the baseline commit, never for a `sensitive` card, a break-glass culprit, a missing card or a policy file change (I-REV-14).

**Q-RV-8.** Re-read [features/guard.md, the trust boundary](../../features/guard.md#the-trust-boundary). D12 is enough for Phase 1: a framing workflow must already be merged on the default branch, a revert is a pull request with its own required checks, one forged red is not enough (confirmation), the cap and one-revert-per-culprit bound repetition, and auto-merge is opt-in per risk class at the baseline. A team must configure: a review requirement for `.github/workflows/` changes (CODEOWNERS or a ruleset), required checks on the default branch, and `auto_merge_reverts: [trivial]` only, after stage 4 has run 14 days with at least 3 reverts and none wrong (runbook stage 5).

### MCP

**Q-MCP-1.** Tokens are 32 random bytes (`randomBytes`, base64url) with the `graft_mcp_` prefix (`src/mcp/tokens.ts:18`); only the SHA-256 is stored (`:25`, CHECK on the column). Every request looks the hash up (`src/modules/mcp/auth.ts:31`) with `revoked_at IS NULL`, `expires_at > now()`, the repository not removed and the installation neither deleted nor suspended; nothing is cached (I-MCP-3, I-MCP-17).

**Q-MCP-2.** The repository is the token row's (`AuthInfo.extra`), compared with the `repository` argument; every PR lookup is scoped to the token's repository id (I-MCP-4).

**Q-MCP-3.** After D5: `onRequest` Origin (403), then the failed-auth block of the client IP (429), then the token (401); body parsing (`415`, `413`), then the per-token bucket (429), then the SDK. An unauthenticated client can make the server read headers, count a failure for its IP and do one indexed hash lookup (I-MCP-6b).

**Q-MCP-4.** With `GRAFT_TRUST_PROXY` naming the proxy, two clients behind it have separate failed-auth buckets; from an untrusted peer `X-Forwarded-For` is ignored, so a client cannot choose its address; without the setting, the peer is the client (I-MCP-7b). Both limits are per process.

**Q-MCP-5.** `safeMcpError` and `redactTokens` replace token-shaped strings in every logged error; the `mcp call` line holds tool, token id, repository id, outcome and duration, never arguments or results (I-MCP-16).

**Q-MCP-6.** `open_change` reads the modes first and answers `mcp_write_off` before any GitHub request (I-MCP-9, I-CEIL-1); the `mcp` body rule (U-MG-MCP-2); the claim under the repository row lock (I-MCP-12b, I-MCP-12c); adoption only of a PR by `<slug>[bot]`, the slug lowercased (I-MCP-11, I-MCP-11b, U-CFG-41).

**Q-MCP-7.** On an MCP-opened PR no approval counts unless every commit is verified and has a linked committer (D8); then the authors and committers are excluded and other reviewers count (I-MCP-14b). `web-flow` (GitHub's web committer, which signs) is accepted as a committer and not excluded; the commit's author is. A pusher who pushes someone else's genuine signed commits reviews someone else's work: a normal review.

**Q-MCP-8.** `report_provenance` is stored once per head (`already_reported` on a repeat, I-MCP-8); a disagreeing report makes the policy evaluate with the unknown author and with the trailers' author and keep the stricter (`stricterVerdict`, U-PMM-3, I-MCP-8b). It is annotated as a write (finding 6).

### Permissions

**Q-PM-1.** Full manifest (`github/app-manifest.json`): `metadata: read` (Phase 0), `contents: write` (the revert's trees, commits and ref; gates `guard_mode`), `issues: read` (issue events for break-glass, incidents), `pull_requests: write` (comments, the revert PR, `open_change`; gates `mcp_write`), `checks: write` (Graft's checks; non-neutral `graft/policy` in enforce), `members: read` (team constraints), `statuses: read` (the guard's commit statuses). The report manifest is the same with `contents: read`. Nothing beyond phase-1/README §4; no `administration`, `workflows` or `actions: write` (U-MAN-6 unchanged).

**Q-PM-2.** `installations.refresh_permissions` reads `GET /app/installations/{id}` with the App JWT, never a payload (`src/modules/modes/permissions.ts:2`, I-MODE-8). `permissions_read_at IS NULL` means never read and lowers every mode that needs a permission (`permissions_unknown`); an unknown level counts as missing (U-MODE-*, `PERMISSION_NEEDS` in `src/modes/index.ts`).

**Q-PM-3.** With the report manifest `contents` is `read`: `guard_mode` needs `contents: write`, so it is `report` with `permission_missing contents:write` (I-REV-4), and no `guard` client write passes the gate. `mcp_write` needs `pull_requests: write`, which both manifests have, so `mcp_write` can be on with the report manifest; its only write is `POST …/pulls`. `policy_mode: enforce` needs no extra permission: non-neutral `graft/policy` checks need `checks: write`, which both manifests have, so a report-manifest deployment can still enforce the policy check (and nothing else beyond Phase 0 and `open_change`).

### Data

**Q-DT-1.** The Phase 1 report and its JSON hold counts, ratios, minutes, installation ids, account and repository names, dates and reason codes. I-P1G-9 seeds sentinels in every text column the gate reads (author logins, an audit actor, an MCP token name, an MCP provenance agent) and finds none in the markdown, the JSON or stdout; the files are mode 0600.
