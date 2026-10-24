# Step 7 review 1: Security review, five pilots, gate

**Verdict: CHANGES REQUESTED (one required fix before merge)**

Reviewer: senior engineer (Opus). Scope: the 12 commits `b6c9d04..333a43d` of `claude/phase-1-step-7-build` (PR mmornati/graft#45, open, not merged), from `3925002` (H1) to `333a43d` (decisions, HUMAN-TODO and the feature docs). That is 77 files, +5793/−154. I reviewed it on the local branch `claude/phase-1-step-7-review-1`, cut from `333a43d`. I judged it against `docs/phase-1/step-7-security-pilots-gate.md` (binding: D1–D21, §4, §5, §8, §9, the §13 test IDs and the §15 mutation table), the Phase 1 README, the Phase 0 constraints, and the "Phase 1 step 7: security review, pilots, gate" section of `docs/decisions.md`, with its deviations.

This review runs **before the merge**. "Required" below means it must be fixed in PR #45 before it merges. "Recommended" means it should go in the same PR, or must at least be done before the runbook stage it names.

## Summary

This step is careful and mostly correct:
- All nine hardening items (H1–H9) are implemented, and every §13 test ID has a test.
- I ran the definition of done myself, and it is green: 113 files, **1,282** tests. The CI `check` job on PR #45 passes too.
- All 22 spec mutations are killed (26 forms in all, counting the a/b variants). The exception is the one the developer reported as equivalent, and I agree with that.
- 34 of my 41 extra mutations are killed. Of the 7 that survive, 1 is equivalent.
- The Phase 0 gate report is byte-identical. `src/pilot/gate.ts` and `gate-render.ts` are untouched, `--phase` absent or `0` takes the old code path, and U-P1G-11 passes.
- The report-mode regression suite is green and inert in all four profiles, N-17 included.

The safety core holds:
- **D2.** The ceiling is `min(env, stored)`, read in the same statement as the modes (`store.ts:67`), with no cache. A read error throws, and the gate then refuses the write (fail closed). An unknown stored value counts as `report`.
- **D3.** Every write whose path carries a `?` is `unknown_route`, on every route.
- **D5.** Authentication runs in `onRequest`, before the body is parsed.
- **D6.** The trusted-proxy setting refuses `true`, hop counts and hostnames.
- **D10.** It refuses only a change *to* enforce, so a rollback is never blocked (X17).
- **Migration `0016`.** It rolls back cleanly and refuses to roll back while a `phase1` run exists (my probe).
- **The gate SQL.** It matches §8: the denominators, the exclusions, the null `confirm_reason`, and `pr_number IS NOT NULL`. That last filter is redundant but harmless.

One finding is required:
- **Required (finding 1): a regression from D4.** A *permanent* GitHub error (422, 404, 403) after the revert's writes began is no longer settled. Pre-step 7, it was settled `error` and the team got a comment. Now the event stays `culprit_found` with no outcome and no comment, holds a cap slot forever, and has `guard.revert` re-sent on every observe, where the same `POST …/pulls` fails again. My probe shows four `POST …/pulls` in three rounds and a slot that is never released. The security review says this case fails closed with only a temporary effect (finding 10). For a permanent error, that is not true.

The rest:
- Recommended: the D8 rule trusts the author of any `web-flow` commit (the coordinator's item, finding 2).
- Recommended: the runbook's emergency ceiling rollback (finding 3).
- Recommended: three corrections to the security review document (finding 4).
- Minor test gaps, plus two minor doc points.
- Nits.

## What was checked

### Definition of done (spec §15), run by me

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | OK |
| `pnpm db:up` | Not run. The shared `scionhub-postgres-1` (port 55432) was stopped, and I did not touch it. I ran my own `postgres:18-alpine` (`graft-s7r1-pg`) on `127.0.0.1:55471` and removed it at the end |
| `pnpm lint` | OK |
| `pnpm typecheck` | OK |
| `pnpm test` (`TEST_DATABASE_URL=…:55471/graft_s7r1`) | OK: 113 files, **1,282** tests passed |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0; every threshold passes, `matchBaseline: 1` (run directory removed) |
| `db:migrate && db:status` (scratch `graft_s7r1_dod`) | `0001`..`0016` applied |
| `db:rollback && db:status && db:migrate` | Only `0016_phase1_gate` rolled back (CHECK back to `('baseline','shadow')`), then re-applied |
| Probe: `0016` down with one `phase1` run | Refused (`phase1 review time runs exist; delete them first`), CHECK unchanged; down succeeds after the row is deleted |
| `@ts-ignore` / `@ts-expect-error` grep | Clean |
| `{ feature: "` grep | Exactly three: `policy/job.ts:194`, `guard/revert.ts:1123`, `mcp/tools/open-change.ts:178` |
| `metrics_daily\|rollup` in `gate-phase1.ts` | Clean |
| `^Verdict: READY FOR PILOT ENFORCEMENT` | One line (but see finding 4) |
| Test-ID grep | 68 lines; each of the 53 IDs of §13 has an `it(` |
| Q-MG-1 inventory grep, re-run | Matches the review's table line for line (16 hits plus the one `.request(\`DELETE …\`)`) |
| CI on PR #45 (`gh pr checks 45`) | `check` **pass** (7m22s), `build` pass; `deploy` and the Graft checks skipped |

I did not run the manual smoke test of §15, the enforce sandbox against live GitHub, or the real-GitHub checks. They are HUMAN-TODO items.

### Mutation checks (spec §15)

I applied each mutation alone with a script, ran the named test files against a scratch database, and restored the file. The run used three throwaway copies of the tree, each with its own database. Afterwards I diffed `src/` of every copy with the branch: clean.

| # | Mutation (as applied) | Result |
| --- | --- | --- |
| S1 | The gate ignores the stored ceiling (`modesOf` passes `ceiling` alone) | Killed: I-CEIL-1, N-17 |
| S2 | A missing `service_state` row read as `report` | Killed: U-CEIL-1, U-CEIL-2, I-CEIL-2 |
| S3 | The stored ceiling wins (`return worker`) | Killed: U-CEIL-1, I-CEIL-3 |
| S4 | `writePath` drops the query again | Killed: U-MG-1, U-MG-21 |
| S5 | `recordPulls` uses `writePath` | Killed: U-MG-19, U-MG-22 |
| S6 | `settleBegunWrites` always returns null (settles `error`) | Killed: I-REV-10c, I-REV-10d |
| S7 | `isStale` measures from `detected_at` | Killed: I-REV-10e |
| S8 | `originCheck` and `authenticate` back in `preHandler` | Killed: I-MCP-6b |
| S9 | `trustProxy: true` | Killed: I-MCP-7b (and X9 for the config side) |
| S10 | An unverified commit ignored (`REQUIRE_VERIFIED_COMMITS = false`) | Killed: U-FCT-1, I-MCP-14b |
| S11 | MCP PR count without `m.pr_number is not null` | Survived: **equivalent** (the join on `ch.pr_number = m.pr_number` never matches a null; agreed with the security review, finding 12) |
| S12 | The rollup purge deletes claims of any age | Killed: I-ROLL-5 |
| S13 | `--public` not required | Killed: I-MODE-PUB-1 |
| S14 | Observe's confirm path does not store `guard_mode` | Killed: I-GRD-MODE-1 |
| S15a/b | `flaky` with null `confirm_reason` → `flaky` / → `missed` | Killed: U-P1G-6, I-P1G-1 (both) |
| S16a/b | `requirements_met` / `break_glass` → `auto` | Killed: U-P1G-1 (both), I-P1G-1 (a) |
| S17a/b | Merge-head verdict the oldest / of any head | Killed: I-P1G-3 (both) |
| S18 | Graft revert PRs counted in M1 | Killed: I-P1G-4 |
| S19 | M2 projection applied to enforce rows | Killed: U-P1G-5 |
| S20 | M4 without the 14-day lag | Killed: I-P1G-6 |
| S21 | The gate verdict from projected values | Killed: U-P1G-9, I-P1G-2 |
| S22 | INV-1E: `neutral` added to the accepted policy conclusions | Survived: **equivalent** in this form (a neutral still differs from the scenario's expectation, so the next check reports it). The developer's form, and S22b below, are killed |
| S22b | INV-1E: the expectation comparison removed | Killed: U-LIVE-ENF-2 |

### Extra mutations (mine, on the security-critical paths)

| # | Mutation | Result |
| --- | --- | --- |
| X1 | `effectiveCeiling`: an unknown stored value counts as `enforce` | Killed: U-CEIL-1 |
| X2 | The scalar subquery reads the wrong key (the stored ceiling is never seen) | Killed: I-CEIL-1 |
| X3 | `classifyWrite` back on `normalisedPath` (Phase 0 routes accept `?`) | Killed: U-MG-1, U-MG-21 |
| X4 | `writePath` refuses only a trailing `?` | Killed: U-MG-1, U-MG-21 |
| X5 | D4: a PR found by the lookup is not adopted | Killed: I-REV-10c |
| X6 | **D4: a failed lookup settles `error`** (the `catch` returns null, `revert.ts:519-525`) | **Survived** (finding 5) |
| X7 | D4: "writes began" checks `revert_branch` only | Killed: I-REV-10d |
| X8 | D5: Origin check after the token (`onRequest: [authenticate]`) | Killed: I-MCP-6, I-MCP-6b |
| X9 | D6: a hostname accepted as a proxy entry | Killed: U-CFG-40 |
| X10 | D6: an IPv4 prefix up to 128 accepted | Killed: U-CFG-40 |
| X11 | D6: `trustProxy: 1` (a hop count) in the server | Killed: I-MCP-7b |
| X12 | D8: a null committer accepted | Killed: U-FCT-1 |
| X13 | D8: an unknown result excludes nobody (`[]` in place of `"everyone"`) | Killed: I-MCP-14, I-MCP-14b |
| X14 | D8: the exclusion line not rendered | Killed: I-MCP-14b |
| X15 | D9 b: the purge deletes PR rows too | Killed: I-ROLL-5 |
| X16 | D9 c: the slug not lowercased | Killed: U-CFG-41 |
| X17 | D10: any `--policy` change refused on a public repository (rollback blocked) | Killed: I-MODE-PUB-1 |
| X18 | D10: the refusal tests `private === null` | Killed: I-MODE-PUB-1 |
| X19 | D13: settled events always record `report` | Killed: I-GRD-MODE-1 |
| X20 | D13: an event settled at insert (`GRAFT_GUARD_CONFIRM=off`) records nothing | Killed: I-GRD-MODE-1 |
| X21 | M3: `culprit_found` with no outcome not `open` | Killed: U-P1G-6 |
| X22 | M3 measured counts report rows | Killed: I-P1G-1, I-P1G-2 |
| X23 | Merged population keeps removed repositories | Killed: I-P1G-4 |
| X24 | M2 measured takes every `phase1` row | Killed: I-P1G-1, I-P1G-5 |
| X25 | M2 pairing removed | Killed: I-P1G-5 |
| X26 | M4 (b) measured takes report-mode `auto` rows | Killed: I-P1G-1 |
| X27 | M1 FAIL without the 3-installation condition | Killed: U-P1G-2 |
| X28 | M1 span without the "+1 day" | Killed: U-P1G-3 |
| X29 | `--check` exits 0 on INSUFFICIENT DATA | Killed: I-P1G-2 |
| X30 | **`enforceSince` ignores "requested still enforce"** (`gate-phase1.ts:860`) | **Survived** (finding 5) |
| X31 | M4: `rises` always true | Survived: **equivalent** (a rate at or below the baseline's gives an upper tail ≥ about 0.5, never < 0.05) |
| X32 | M1 point estimate from n > 400 | Killed: U-P1G-2 |
| X33 | INV-1E accepts a non-neutral `graft/intent` | Killed: U-LIVE-ENF-2 |
| X34 | INV-1E ignores a missing Graft check | Killed: U-LIVE-ENF-2 |
| X35 | Preflight: an enforce sandbox may request guard enforce or `mcp_write` on | Killed: the preflight mode-rule test of `live-e2e-enforce.test.ts` (no ID) |
| X36 | Scenario selection never refuses the other mode | Killed: U-LIVE-ENF-3 |
| X37 | **`0016` down without the `phase1`-row refusal** | **Survived** (finding 5; my manual probe shows the refusal works) |
| X38 | Preflight accepts a shell-only `enforce` ceiling | Killed: the same preflight test (no ID) |
| X39 | **M3 window on `created_at` instead of `COALESCE(detected_at, created_at)`** | **Survived** (finding 5) |
| X40 | **M2 measured baseline takes every paired repository**, not only those with measured rows (`gate-phase1.ts:621`) | **Survived** (finding 5) |
| X41 | **Retention ignores the 7-day delivery window** | **Survived** (finding 5) |

### Probes

- **P1, D4 with a permanent error.** I added a throwaway test to a copy of `guard-revert.test.ts`. In enforce mode with a culprit, `POST …/pulls` answers 422 once per round. After the first run: `revert_outcome: null`, `status: culprit_found`, `comment_id: null`, `revert_branch` set, and `countOpenReverts` = 1. Then I ran three rounds of "advance 2 h, observe, run". Each round re-sent `guard.revert`, which returned `stopped` with no outcome and no comment. `POST …/pulls` was sent 2, 3, then 4 times in total. The slot was never released (finding 1).
- **P2, migration `0016` with data.** See the DoD table.
- **P3, D8 and `web-flow`.** I read the code and the tests, and checked GitHub's documentation on signature verification and the contents API (finding 2).

### Judgement of the recorded deviations and choices

- **D4: no comment when the writes began.** Agreed in principle. A comment sets `comment_id`, and `runRevert` and `eventsAwaitingComment` both skip such an event, so publishing it would stop the resumption. Agreed only for the *retryable* case, though. For a permanent error, there is no resumption to protect, and finding 1 is the result. The comment is then the only signal the team gets.
- **D2, `mode show` uses the resolved ceiling** (the worker's value wins over the shell's). Agreed: `mode show` is a CLI that never writes, and I-CEIL-3 asks for the worker's value. The same holds for the doctor and the gate's per-repository modes (nit 9).
- **D3 applied after the API base is removed; GraphQL with `?` falls through to `classifyWrite`.** Agreed. I checked that `parsed.url === graphqlUrl` fails with a query, and that `/graphql?x` is then `unknown`.
- **D6, one comma-joined string for proxy-addr.** Agreed. See finding 6 for the docs.
- **D8: the order no-author, then verification, then committer; the `REQUIRE_VERIFIED_COMMITS` toggle.** I agree with the order. The toggle is a nit (nit 8): the spec decided D8, so it is not a pending product decision.
- **D9 b, the database clock.** Agreed.
- **D10, the refusal inside the transaction, which drops the other keys of the same call.** Agreed. X17 confirms that only a change *to* enforce is refused, so a rollback to report is never blocked.
- **D13, reading the mode through `modesOf` on the row observe already reads; an event settled at insert records it.** Agreed (X19, X20).
- **D14: the `m2_above_target` and `m3_below_target` codes; M4 (b) with no baseline counts as INSUFFICIENT DATA.** Agreed. Both fill real gaps in the spec.
- **D21: the outsider may `APPROVE` any sandbox PR; INV-4 allows `break_glass` on an enforce sandbox.** Agreed (security review finding 11; the INV-4 allowance is in decisions.md).
- **N-17: "no feature client" read as no `guard` or `mcp` client.** Agreed: it matches N-14, because the policy job builds its client on every evaluation. But see minor 7: N-17 does not run every scenario.
- **Tests placed differently (U-RVC-1, U-P1G-11 as integration).** Agreed.
- **Security review finding 12 (S11 equivalent).** Agreed.

### The specific questions

- **D2, fail-closed and startup.** A read error throws inside `mutationGate` or `getEffectiveModes`, and the request or job fails, so nothing is written. A missing row means the process's value, as specified. At startup, a server with no worker uses its own environment, which is the specified "no rollback can have happened". The real race is a different one: a worker start always stores its own environment (`casServiceState`, `store.ts:236-243`), raises included. So during a lowering roll, an old-config worker that restarts, for example a crash-looping pod of the old ReplicaSet, stores `enforce` again. Every old process is then back at `enforce` until the next new worker start. The spec's "can only be lowered by a worker start" (§4), the comment at `modes/index.ts:58` and Q-MD-1's second bullet are wrong about this (finding 4 and minor 6). The outcome is bounded and documented as a residual risk, so no code change is required.
- **D3.** Correct and complete (S4, X3, X4).
- **D4.** The adoption is correct (X5, X7). The resumable branch has finding 1 and the untested lookup failure (X6).
- **D5.** Correct. The hooks are async and return `reply` after sending, so the chain stops; `touchLastUsed` runs only for a valid token.
- **D6.** An untrusted peer cannot choose its address (I-MCP-7b, X11). Through the trusted proxy, proxy-addr takes the rightmost address the proxy did not vouch for, so a client's own prepended `X-Forwarded-For` entries are ignored. That holds only while the proxy *appends* to the header (or overwrites it), and while no client can connect from an address in the list. `.env.example` suggests `fd00::/8`, the whole IPv6 ULA range, which in many networks includes the clients (finding 6).
- **D8.** A forged *unverified* commit cannot let an approval count (S10, X12, X13). See finding 2 for `web-flow`.
- **D10.** Correct. Only a change *to* enforce is refused; the doctor reads the requested value.
- **D13–D19.** Every query of §8 matches the spec. Spot checks: the excluded authors and the revert PR exclusion of §8.1; the merge-head lateral (`facts_read_at DESC, created_at DESC`, same head); M2's newest-run rule and pairing; M3's class order, with `flaky` and a null `confirm_reason` out of both terms; M4's lag and the conditional binomial (`k = x`, `n = x + x_b`, `p0 = N / (N + N_b)`); the MCP counts. Three rules have no test (X30, X40, X41; finding 5).
- **The runbook.** It is correct and safe per repository. Stage 3 rollback restores required reviewers before `mode set … report`. The emergency path does not do that for a deployment-wide ceiling drop (finding 3).
- **D21.** On the default (report) sandbox, the runner still runs INV-1 (`run.ts:108-114`). The report sandbox now also gains a preflight check that every mode is requested `report`, which only refuses more. INV-1E replaces INV-1 only when `sandbox.mode === "enforce"`.

## Findings

### 1. required: a permanent error after the revert's writes began is never settled

`failed()` calls `settleBegunWrites` for **every** non-retryable error, not only on the last attempt (`src/modules/guard/revert.ts:911-914`). `toJobError` makes 404, 403 and 422 a `PermanentJobError` (`src/github/errors.ts:56`), so `isRetryable` is false at once. When the event has `revert_branch` or `revert_commit_sha`, the lookup finds no PR, and the run returns `"stopped"` with no outcome and no comment. Then:
- **The cap slot is held forever.** `countOpenReverts` counts `culprit_found` with a claim and a null outcome, with no time bound (`src/modules/guard/store.ts:466-475`). With the default cap, one stuck event silently takes a slot from the repository.
- **It retries forever.** The stale rule exempts an event whose writes began, so every observe after the job row expires re-sends `guard.revert`, and the same write fails again. In probe P1, `POST …/pulls` was sent four times in three rounds.
- **Nobody is told.** No comment is written, `guard_revert_errors` never sees it, and the gate counts it as `open` forever, so M3 can never count it.

Before this step, the same failure was settled `error` with a comment, which also released the slot. The spec's D4 is written for "`failed()` on its last attempt". A permanent error is not the case D4 fixes (a run that died after `POST …/pulls`, then lost its retries). The security review's finding 10 says the D4 cases "fail closed (no write is lost, the cap only refuses more)". For this case, that is not accurate.

**Fix:**
- In `failed()`, call `settleBegunWrites` only when the error is retryable and this was the last attempt (`isRetryable(err) && !canRetry(ctx)`).
- For a `PermanentJobError` after writes began, look the PR up once. If one is found, adopt it as today. If not, `settle("error", …)` and write the comment, as before step 7. The ref left behind is the one I-REV-10's stale-branch rule already deletes on a later run.
- Do the same in `settleFailedRun` (`revert.ts:1230`): it runs for non-retryable errors raised outside `failed()` too (`revert.ts:1269`).
- Add I-REV-10f, my probe P1 turned into a test: `api.failNext("POST", /\/pulls$/, 422)` after the ref. The event must be settled `error` with a comment, `countOpenReverts` must be 0, and a later observe must send no `guard.revert`.
- Correct finding 10 of the security review.

### 2. recommended: D8 trusts the author of any `web-flow` commit (required before any repository turns `mcp_write` on)

The coordinator asked me to check an automated push review's claim about `src/modules/policy/facts.ts:204-211`.

**What the code does.** For a commit with `verification.verified: true` and committer `web-flow`, `listCommitLogins` adds only the author login to the excluded set (`facts.ts:208-211`). U-FCT-1 pins this (`test/unit/policy-facts.test.ts:226`: a `web-flow` commit by `Alice` gives `{ logins: ["alice"] }`). So does I-MCP-14b (`test/integration/mcp.test.ts:1519-1520`, commits authored by `alice` and committed by `web-flow`): `bob`'s approval counts. The security review's Q-MCP-7 and `docs/features/mcp.md:137` justify this with "a verified signature ties the committer to its account, so every committer is genuine". That is true for a commit signed with the committer's own key. For a `web-flow` commit, the signature only proves that *GitHub* created it. It says nothing about who asked GitHub to create it. The excluded set then rests entirely on GitHub filling in the author truthfully.

**Is it exploitable?** Not proven, and it depends on GitHub behaviour the offline build cannot check:
- **The web UI.** It signs as `web-flow` with the signed-in user as author. That is genuine, and the pusher is excluded.
- **GitHub's documentation.** It says GitHub signs API commits for bots only when the request has **no custom author or committer**. It also says rebased commits ("Rebase and merge", "Update branch" with rebase) are not signed.
- **The contents API (`PUT /repos/{o}/{r}/contents/{path}`).** It takes an `author` object, with the authenticated user as the default committer. Its page does not say whether a call with a user token and a custom author is signed by `web-flow`.

So the push review's exploit needs one undocumented behaviour: GitHub signing, as `web-flow`, a commit whose author the caller chose. If that happens, a write collaborator `bob` can push commits to the head of an MCP-opened PR through that route with `alice`'s email as author. Then `alice` is excluded, `bob` is never listed, and `bob`'s approval counts. That is exactly the case D8 exists to close. If it never happens, the rule is sound. Today nothing pins which one is true.

**Fix (the fail-closed choice):**
- On a PR opened through MCP, treat a commit whose committer is `web-flow` as `unverified` (option 2 of the push review), until the real-GitHub check below shows that GitHub never signs a `web-flow` commit whose author differs from the requester.
- The cost: a person who edits the PR in the web UI, or clicks "Update branch" (merge), makes approvals stop counting on that PR. That is the D8 direction (no approval counts), it is shown in the policy section, and an agent with a signing key or a GitHub App identity is unaffected.
- Option 1 (allow the author only if it is the PR opener or the token owner) cannot be built: the opener is Graft's bot, and a token is not tied to a GitHub user (§2, out of scope).
- Option 3 (exclude the head ref's pushers) needs data the spec puts out of scope (§2, "reading who pushed a branch"), and the push events API is not reliable enough to fail closed on.
- **Tests:**
  - Change U-FCT-1's first case to expect `unverified` for the `web-flow` commit, and add an all-verified case with real committers that still gives the logins.
  - Change I-MCP-14b's commits to committer `carol` (signed). Then add a case with one `web-flow` commit by `alice`, in which `bob`'s approval does not count and `mcpExclusion` is `unverified`.
  - The current code then **fails** U-FCT-1. That is the mutation the push review asked for: "`web-flow` commits accepted" is exactly today's line 209.
- Record the rule in decisions.md, `docs/features/mcp.md`, the policy-section text if it gets its own reason (for example `web_flow`), and Q-MCP-7.
- Extend the HUMAN-TODO D8 check: on real GitHub, create a commit through the contents API with a user token and a custom `author`, and record `verification.verified` and the committer.

I grade this recommended, not required, because the exploit is not demonstrated and MCP-opened PRs exist only once `mcp_write` is on (runbook stage 6, optional). Until the fix or the check is done, no repository may enter stage 6.

### 3. recommended: the emergency ceiling rollback can leave other repositories unprotected

The runbook's emergency path (`docs/pilots/phase-1-runbook.md:124-129`) has two steps. Step 1: the repo admin "restore[s] the required reviewers, and remove[s] `graft/policy` from the required checks". Step 2: the operator rolls back, "or for every repository at once set[s] `GRAFT_MODE_CEILING=report` and restart[s]". The ceiling drop turns `graft/policy` `neutral` on **every** enforcing repository. Any repository past stage 3 step 5 (required reviewers dropped) whose admin did not act in step 1 then merges with no review, because `neutral` passes a required check. That is the exact hazard §4 and the stage 3 rollback order exist to prevent.

**Fix:** split the emergency path:
- For one repository, as today.
- For the deployment-wide ceiling drop: first, on **every** repository whose `repositories[].modes.policy.effective` is `enforce`, the repo admin restores required reviewers. Only then lower the ceiling.

Say that this is slower, and that the per-repository rollback is the fast path.

### 4. recommended: three statements in the security review are not accurate

The verdict line can stay once findings 1 and 2 are resolved, but the document must say what was found:
- **Finding 10 and the D4 claims** (`step-7-security-review.md:29`, Q-RV-4). Add the permanent-error case (finding 1 here). Today the review says both D4 outcomes fail closed with a temporary effect.
- **Q-MD-1, second bullet** (`:80`): "the old worker's start, if it restarts later with `enforce`, cannot raise `S` above what the next new start stores". A restart of an old-config worker *does* raise `S` to `enforce` (`casServiceState` overwrites it), and old processes compute `enforce` until the next new start. State it as a residual of the rolling restart: during a lowering roll, a restarted old worker undoes the lowering for old processes until the next new worker start or the end of the roll. Fix the same sentence in `src/modes/index.ts:58` ("A worker start can therefore only lower the ceiling …") and the spec-derived wording in `docs/features/modes.md`.
- **Q-MCP-7 and finding 7** (`:134`, `:26`). Add the `web-flow` caveat of finding 2, or the new rule if finding 2's fix lands.

Then add the new findings to the numbered list with their status. The DoD grep only checks the verdict line. The person who signs it off (HUMAN-TODO) needs these three facts.

### 5. minor: six rules have no test

| Rule | Mutation | Test to add |
| --- | --- | --- |
| D4: a failed lookup leaves the event resumable, not `error` (`revert.ts:519-525`) | X6 survives | I-REV-10d variant: the `GET …/pulls?head=` lookup fails (500) on the last attempt → `revert_outcome` null |
| `enforceSince` is null when the requested value is no longer `enforce` (`gate-phase1.ts:860`) | X30 survives | I-P1G-8: enforce, then report (applied) → `enforceSince.policy` null |
| M2 measured baseline: only repositories with measured rows (`gate-phase1.ts:621-623`) | X40 survives | I-P1G-5: a paired repository with only report-mode `phase1` rows is not in the measured baseline |
| Retention needs a delivery in the last 7 days | X41 survives | I-P1G-1 or a new I-P1G-11: an old installation whose last delivery is 8 days before `--until` is not retained |
| M3 window on `COALESCE(detected_at, created_at)` | X39 survives | I-P1G-1: one event with `detected_at` inside the window and `created_at` before it |
| `0016` down refuses with a `phase1` run (§11) | X37 survives | I-DB-16: insert a `phase1` run, `migrateDownOne` throws and the CHECK is unchanged |

### 6. minor: the trusted-proxy docs promise more than the setting gives

`docs/features/mcp.md:105` says "a client that is not the proxy can never choose its own address". That holds only while the proxy appends to (or overwrites) `X-Forwarded-For`, and while no client can reach Graft from an address in the list. `.env.example:144` suggests `fd00::/8`, a range that commonly holds the clients themselves.

**Fix:**
- In `docs/configuration.md` and `mcp.md`, say: list only the proxy's own addresses, never a client network; the proxy must append the peer address to the header (nginx `$proxy_add_x_forwarded_for`) or overwrite it; Graft must not be reachable except through the proxy.
- Use a single address in the example.

### 7. minor: N-17 does not run every scenario

The spec (§13) says that in N-17 "every scenario of the suite runs again". The N-17 test runs the `beforeAll` world and `mcpScenario()` only (`test/integration/neutral.test.ts:1223`). `breakGlassScenario` (`:964`, `:1006`) and the guard scenarios driven by their own `it`s are not registered for the stored-ceiling profiles. S1 is still killed (by I-CEIL-1 and N-17), so the old-worker case is covered for the policy check and MCP. It is not covered for break-glass in enforce. Either call `breakGlassScenario()` in N-17, or record the narrower reading in decisions.md.

### 8. nit: `REQUIRE_VERIFIED_COMMITS` is presented as a pending product decision

The spec decided D8. HUMAN-TODO's "pending product decisions" list (and `facts.ts:163-167`) invites someone to flip a security rule with a one-line change. Keep the constant if wanted, but remove D8 from the pending decisions, or mark it "decided by the spec; changing it reopens step 6 residual risk 2".

### 9. nit: the gate's per-repository modes use the worker's ceiling, not D2's lower one

`gatherPhase1Gate` computes `repositories[].modes` with `resolveCeiling` (`gate-phase1.ts:821`, `:850`), so a shell with `report` and a worker with `enforce` shows `effective enforce`. That is the right answer for the workers, and the same choice as `mode show`. It differs from §8.6's "(D2's ceiling)" literally. Record it in decisions.md next to the `mode show` choice.

### 10. nit: `private` defaults to `true` in the report

`gate-phase1.ts:872` uses `priv.get(id) ?? true`. A missing row cannot happen (same query scope), but the runbook's stage 2 criterion 6 reads this field. A default should fail toward "public" (`false`), so the criterion does not pass on missing data.

## Required fixes before merge

1. Finding 1: settle a permanent error after the writes began (adopt if found, else `error` with a comment), in `failed()` and `settleFailedRun`. Add I-REV-10f, and correct the security review's finding 10.

Recommended in the same PR: findings 2 (or, at least, the runbook and HUMAN-TODO saying no stage 6 until it is done), 3 and 4. Finding 5's tests and findings 6 and 7 should land before the first repository leaves stage 2. The nits can go with them or be recorded.

## Recommendation

Fix finding 1 in PR #45, re-run I-REV-10c/d/e, the new I-REV-10f, the neutral suite and the mutations S6, X5, X6 and X7. Then merge. Report mode is inert by construction and by test: all four neutral profiles are green, and S1 is killed by N-17. Every hardening item does what the spec says. The gate's numbers are computed as §8 defines them. Before any pilot reaches stage 3 step 5, the operator should have the corrected security review (finding 4) and the corrected emergency procedure (finding 3) in hand. Before stage 6, finding 2 must be fixed or disproved on real GitHub. Review 2 can then check the fix PR against this list.
