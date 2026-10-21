# Step 2 review 1: Approvals Graft can enforce

**Verdict: CHANGES REQUESTED**

Reviewer: senior engineer (Opus). Scope: the 11 commits `origin/main..8adc76f` on `claude/step-2-rebase` (pushed as `claude/phase-1-step-2-approvals`, PR mmornati/graft#17): 49 files, +3754/−163. I judged them against `docs/phase-1/step-2-approvals.md` (binding), the Phase 1 plan, `step-1-modes.md`, the Phase 0 constraints, the "Phase 1 step 2: approvals" section of `docs/decisions.md`, and the follow-ups that step 1 review 2 left for this step.

## Summary

This is a careful step. All 12 tasks and all 18 decisions are implemented. Every §13 test ID exists. The definition of done is green. All 13 spec mutations are killed, and so are 4 of the 7 extra mutations I added.

The safety core holds:
- In report mode, nothing publishes a non-neutral or `in_progress` check. `publishedCheck` returns `completed` + `neutral` for every mode except `enforce`.
- The guard is a second, independent barrier. When I made `publishedCheck` ignore the mode (M9), the gate refused the writes in the neutral suite before anything reached the fake.
- Provenance and intent cannot publish non-neutral: they use the default client, so the guard refuses with `feature_not_allowed` or `no_feature`.
- The rule chain in `enforcedConclusion` fails toward `failure` at every step.
- Deviation 1 (the guard reads the parsed body) is correct and better than the spec.
- Deviation 4 (the facts hash) is benign.

One major finding blocks approval. The team fan-out's debounce drops any membership or team change that arrives after the fan-out has run but inside the same 5-minute window. A `membership.removed` can therefore leave a PR at `success` in enforce mode. The developer implemented the spec's key literally, so the defect is in D14 as written. The fix is small.

The other findings are minors and nits:
- a check-run POST with no `status`, which GitHub creates `queued`, passes the guard as neutral;
- team slugs and logins can reach error logs through the route of a job error;
- outsiders can push real approvers past the D17 bound on a public repository;
- two fail-closed rules have no test;
- the remaining ones are smaller.

## What was checked

### Definition of done (spec §15), run by me

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK ("Already up to date") |
| `pnpm db:up` | Not run. I reused the shared container on 127.0.0.1:55432 and started or stopped no container. |
| `pnpm lint` | OK (317 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm test` (`TEST_DATABASE_URL=…/graft_test_review2`) | OK: 93 files, **1008** tests passed |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0; every threshold passes, `matchBaseline: 1` |
| `db:migrate && db:status` (scratch DB `graft_review_s2`) | 0001..0009 applied |
| `db:rollback && db:status && db:migrate` | Only `0009_enforce` rolled back (`pending`), then re-applied. Scratch DBs dropped afterwards. |
| `@ts-ignore` / `@ts-expect-error` grep | Clean |
| `src/modes/`, `src/policy/enforce.ts` import grep | Clean |
| `new Octokit\|Octokit.defaults` grep | Clean |
| `conclusion: "(success\|failure\|action_required)"` in `src/modules/` | Clean |
| `"(success\|failure)" as const` in `src/modules/` | Clean |
| `getCollaboratorPermissionLevel` outside `collaborator.ts` | Clean |
| Test ID grep | 57 lines. I also checked each §13 ID one by one: none is missing. |

I did not run the manual smoke test. It needs a running App in enforce mode, and the developer listed it in HUMAN-TODO and the PR description. It still has to be run before any repository enforces.

### Mutation checks (spec §15)

I applied each mutation alone with a script, ran the named test files, then ran `git checkout -- <file>`. `git status` was clean after each one.

| # | Mutation (how I applied it) | Result |
| --- | --- | --- |
| M1 | Stale approvals counted (`commit_id === headSha \|\| true`) | Killed: U-ENF-1, I-ENF-3 (also U-PA-4, U-PA-6) |
| M2 | Triage counts as write (`RANK.triage = 3`) | Killed: U-COL-4, I-ENF-4 |
| M3 | Unverified team treated as satisfied (every counted approver added as a member) | Killed: U-ENF-8, I-ENF-5, I-ENF-6 (also I-ENF-12) |
| M4 | Change requests ignored | Killed: U-ENF-6, I-ENF-7 |
| M5 | `no_policy` concludes `success` | Killed: U-ENF-2, I-ENF-13 |
| M6 | Truncated reviews ignored | Killed: U-ENF-5, I-ENF-14 |
| M7 | Guard ignores the body (`target === null \|\| true`) | Killed: U-MG-13..17, N-7 [default], N-7 [max], N-2b [max] |
| M8 | Name check removed | Killed: U-MG-15, N-7 [max] |
| M9 | `publishedCheck` ignores the mode | Killed: N-2, N-6 [default], I-ENF-2, and N-1/N-3 (the gate refused the writes: defence in depth works) |
| M10 | `published` removed from `policyFactsHash` | Killed: I-ENF-9 (the direct hash check only, see deviation 4) |
| M11 | `MutationRefusedError` rethrown on `mode_report` | Killed: I-ENF-10 |
| M12 | `resetModesOnTransfer` not called | Killed: I-MODE-14 |
| M13 | Team fan-out ignores `teamCount` (`>= 0`) | Killed: I-ENF-11 |

Extra mutations (mine):

| # | Mutation | Result |
| --- | --- | --- |
| X1 | `policyMode` removed from the hash | **Survives** (I-ENF suite, I-MODE suite, neutral suite). Expected and benign: see deviation 4. |
| X2 | `card_wait` job never sent | Killed: I-ENF-8 |
| X3 | A change requester answered 403, or past the bound, does not block | **Survives** (finding 5) |
| X4 | A team cut by the 100-membership bound keeps its partial member list | Killed: I-ENF-12 |
| X5 | A membership with `state: "pending"` counts as active | **Survives** (finding 5) |
| X6 | Recycled-login check removed | Killed: U-COL-3, I-REV-7, I-REV-14 |
| X7 | `members: read` check skipped | Killed: I-ENF-5 |

### Extra probes

I ran each one as a throwaway test file and deleted it afterwards.
- `checks.create({ name: "graft/policy" })` with no `status` and no `conclusion`, through the **default** client: **sent** (finding 2). GitHub creates such a run as `queued`.
- `PATCH …/check-runs/7` with `{ name: "graft/policy", status: "completed", conclusion: "failure" }` through a `policy` client and an allowing gate: sent. The body renames whatever run 7 is (nit 8).
- `toJobError` on a 502 from `GET /orgs/acme/teams/secret-team/memberships/alice` gives `route: "/orgs/acme/teams/secret-team/memberships/alice"`. The worker logs that at `error` (finding 3).
- `EXPLAIN` of the §10 fan-out query on the migrated scratch DB uses `repositories_installation_idx`, `changes_repo_state_idx` and `policy_verdicts_change_idx`. The `jsonb_path_exists` filter runs only on the verdict rows of open changes. It is bounded by the open PRs of one installation, and `LIMIT 101` caps the output. It is not slow or unbounded.

### Safety review

- **Report mode cannot publish non-neutral or `in_progress`.**
  - Mode, enforcement and body all live in one place. The job reads the mode once, before the lock (`job.ts:172-174`). `publishedCheck` (`enforce.ts:164-171`) maps anything but `enforce` to `completed` + `neutral`, and `checkState` (`job.ts:488-499`) only passes that through.
  - The guard reads the parsed body for both check-run routes and asks the gate on every non-neutral request (`mutation-guard.ts:316-336`). The gate reads the database each time (`effective.ts:37-46`).
- **The D12 race windows.** I walked through every ordering of "job reads enforce", "rollback commits", "fan-out job publishes" and "job takes the lock":
  - If the fan-out published first with a later `factsReadAt`, the job is `stale` at `maxFactsReadAt`.
  - If the job's `factsReadAt` is later (slow `upsertChangeFromPull`), the gate still reads `report` at request time and refuses with `mode_report`. The job then returns `stale`.
  - If the job's write passed the gate before the rollback committed, the fan-out republishes `neutral` afterwards, because its hash differs (`policyMode`, `published`).
  - Every ordering ends neutral.
  - One caveat sits outside this step's code: the gate trusts the process's own `GRAFT_MODE_CEILING` (finding 7).
- **Provenance and intent.** Both use `forInstallation(id)` with no feature, and both always send `completed` + `neutral`. A non-neutral body from them is refused (`feature_not_allowed` for any name but `graft/policy`, `no_feature` for that name). N-2b checks this for the max profile.
- **Fail closed.** I traced each case:
  - **Stale approvals:** an approval counts only when its `commit_id` is the head.
  - **Roles:** triage < write, maintain ≥ write. A custom role goes by its base `permission`. A legacy `permission` maps maintain to write and triage to read, so neither path lets triage through.
  - **Recycled logins:** answer `none`.
  - **Bots and the PR author:** excluded before the latest-review pass (`evaluate.ts:435-436`).
  - **Truncated reviews:** `failure`.
  - **Approvers:** a 403 or a 404 means "not counted".
  - **Change requesters:** a 403, or a requester past the bound, blocks; a 404 does not (deviation 3).
  - **Teams:**
    - `owner_not_org` for any account type other than `Organization`;
    - `no_permission` with no request when `members` is missing or permissions were never read;
    - `team_not_found` on 404 and `team_unreadable` on 403, including a 403 on a membership, which also drops the members already verified;
    - `check_limit` past 20 teams, and for a whole team when the 100-membership bound cut it;
    - only `state: "active"` counts.
  - In `satisfyConstraints`, a team missing from the map counts as `check_limit`, and `met` needs `humans > 0`.
- **The D17 bounds are real.**
  - At most 20 approver role checks, and 20 more for change requesters (deviation 3). The role cache is shared, so nobody is checked twice.
  - At most 20 team lookups and 100 membership requests.
  - The worst case is 160 GETs, not 140. Unbounded inputs (300 reviews) are cut before any request.
  - I-ENF-12 checks the approver and membership bounds, and X4 is killed. The requester bound has no test (finding 5).
- **D13 and `ensureRepository`.**
  - The reset fires only in `upsertRepositories`, which is the only path that reactivates a row or changes its `installation_id`. Both handlers go through it (`installation.created`, `installation_repositories.added`).
  - `ensureRepository` never reactivates a removed row and never moves a row to another installation (`store.ts:233-266`). So no path reactivates a repository without the reset.
  - In a transfer race, a job for the new installation reads the old owner's modes and is then refused `repository_unknown`. That fails closed but noisily (finding 6).
- **No team slugs or tokens stored or logged.**
  - `policy_verdicts.approvals` and `required` hold counts and `unverified` reasons only.
  - Job payloads hold IDs: `{ installationId }` for the team fan-out, and the usual evaluate payload.
  - Log lines carry outcomes and counts.
  - Rendered output shows team names in code spans, as Phase 0 does.
  - The one leak is the error route (finding 3).

### Step 1 review 2 follow-ups

| # | Follow-up | Status |
| --- | --- | --- |
| 1 | Per-request `baseUrl` defeats the host check | Fixed before this step: `mutation-guard.ts:299-305` compares with the factory's base |
| 2 | Trailing slash in `GITHUB_API_URL` | Fixed before this step (U-CFG-1b) |
| 3 | Ceiling send without `tx` survives a mutation (nit) | Left as is; harmless |
| 4 | Modes stick across transfer or re-add | **Resolved by D13**: `resetModesOnTransfer`, I-MODE-14; M12 is killed |

### Live production evidence (PR mmornati/graft#17, read-only `gh api`)

Graft runs in report mode on this repository. The deployed build is `main`, not this branch, so the step 2 wording is not live yet. On head `8adc76f`:
- **`graft/provenance`**: `neutral`, "Agent: claude-code · Model: claude-opus-5-5". It is read from the PR description trailers, which is correct.
- **`graft/policy`**: `neutral`, "No graft.yaml on main". The section and footer are still the Phase 0 text ("Graft only reports in Phase 0…") with no would-be line, because the deployed build is `main`. Once this step is deployed, a PR on this repository will read ``**In enforce mode this check would be:** `failure`, no valid graft.yaml on `main`.``, which is right (D1).
- **`graft/intent`**: `neutral`, "Risk: sensitive · verifier disagrees". **The intent card appeared**, and its nine behaviour changes describe this PR accurately: enforce conclusions, who counts, teams, the guard body rule, the triggers and the card wait, the transfer reset, the manifests, the wording, and the doctor and `mode show` notes. The risk floor `sensitive` is right (migration, `.env.example`, size).
- **The verifier's objection.** It calls change 2 (author and bots excluded) unsupported, because that logic sits in unchanged lines of `countApprovals` outside the hunk. The claim is true (`evaluate.ts:435-436`), so the disagreement is a context artefact, not a card error.
- **The verifier's "missing" items** are accurate and useful. The most relevant: evaluations now make role, team and membership requests in **every** mode, report included (spec §5 asks for this). Operators should expect up to about 160 extra GETs on a heavily reviewed PR, usually under 10.
- **Managed comment.** There is one managed comment, from `graft-mmornati[bot]`, with all three sections.
- **Timestamps.** Both the intent and the policy runs show `started_at` later than `completed_at`. That is pre-existing behaviour (the completion stamp is taken before the request) and not part of this step.

### Developer-reported deviations

| Deviation | Judgement |
| --- | --- |
| 1. The guard reads `endpoint.parse(options).body`, not `options.status`/`conclusion`/`name`, and refuses a body that is not a plain object | **Accepted, better than the spec.** The `data` override is real: reading `options.*` would both miss a non-neutral body and refuse a neutral one. The body the hook parses is the one Octokit sends: every hook registered earlier (auth, retry) wraps inside the guard and does not touch the body. U-MG-13 covers the `data` case, and M7 and M8 are killed. One gap remains, a missing `status` on POST (finding 2), and the spec's own wording has the same gap. |
| 2. `ApproverFacts` and `Unverified` live in `src/policy/enforce.ts` | Accepted: the pure file may not import `modules`. |
| 3. Requesters get their own bound of 20. A 403 or a requester past the bound blocks; a 404 does not | **Accepted** (fail closed, consistent with D2). Not tested: X3 survives (finding 5). |
| 4. I-ENF-9 checks `policyFactsHash` directly; removing `policyMode` alone is no longer observable (the step 1 review finding 6 follow-up about N-4) | **Accepted.** `published` is a pure function of (`policyMode`, `enforced`): `publishedCheck(mode, enforced)`. So the two terms are redundant with each other, and each is sufficient. X1 and M10, through the job, cannot be observed and are harmless: a mode flip always changes `published` (enforce is never `neutral`), and the rendered mode line changes too. N-4 and I-MODE-10 still assert the republication. No action needed. |
| 5. `created_at` from the job's clock | **Accepted.** I checked that the `card_wait` job cannot be dropped by its own singleton id while still inside the window. It is sent after the commit, so `start_after ≥ stamp + wait`, where `stamp` is the `created_at` of the first row. When it runs, `factsReadAt` is past the deadline that later jobs compute from `MIN(created_at)`. This holds even with an offset between the app and database clocks, because both ends of the interval are measured on the database side. |
| 6. Step 1 tests updated where step 2 changes pinned behaviour | Accepted. I-MODE-10 and N-4 still assert the republication and its mode line. |
| 7. The A08 live e2e probe calls the permission route directly | Accepted; this keeps the grep meaningful. |
| `approvedCount`; a team missing from the map counts as `check_limit`; `approvers: null` gives `approvals_missing`; no `registry.ts` line; the neutral suite's `drain` skips deferred jobs | Accepted. All fail closed, or are test plumbing. |
| Manual smoke test not run; `website/` snapshots stale | Accepted for the review. The smoke test is a HUMAN-TODO item before enforcing. |

## Findings

### 1. major: the team fan-out's debounce drops changes that arrive after it ran in the same window

`scheduleTeamFanout` sends `policy.team_fanout` with singleton `policy:team:<inst>:<floor(now/300 s)>` and `startAfterSeconds: 60` (`src/modules/policy/team-fanout.ts:56-63`). Our singleton is a deterministic job id, and it deduplicates **completed** jobs too, for 7 days (`src/queue/queue.ts:10-22`, decisions.md Phase 0). So:

- 12:00:10, `membership.added` → fan-out scheduled for 12:01:10, which runs and re-evaluates.
- 12:03:00, `membership.removed` (an approver leaves `@acme/security`) → same key → `send` returns `null` → **nothing is re-evaluated**.

In enforce mode, the PR keeps `success` on a team approval that no longer qualifies, until an unrelated trigger. The same thing happens one level down: two fan-outs that run in the same window (one for an event at 12:04:59, one for an event at 12:05:30, both running around 12:06) give each PR the same evaluate key `policy:team:<repo>:<pr>:<window>` (`:86,104`). The second one's evaluations are dropped even though they would read newer facts.

D14 promises re-evaluation on membership and team changes, and §2 lists only `member` (collaborator permission) changes as "picked up at the next trigger". This is a fail-open on a removal, and a liveness bug on an addition. The developer implemented the spec's key exactly, so the defect is in D14 as written. Only one event per window is tested (I-ENF-11 sends three events before the job runs).

**Fix:** use a trailing-edge debounce. Keep the window key, but set `startAfterSeconds` to the seconds left in the window plus a margin (for example `(window + 1) * 300 − nowSec + 60`), so the one fan-out per window always runs after every event of that window. Put `window` in the fan-out payload and use it, not the run time, in the per-PR key, so fan-outs of different windows never collide. Record the D14 change in decisions.md. Extend I-ENF-11: an event, the fan-out runs, a second event in the same window, then the next fan-out re-evaluates the PR (or the second event's job runs after the first event's job with a later start).

### 2. minor: a check-run POST without `status` passes the guard as neutral, but GitHub creates it `queued`

`checkRunBodyKind` treats an absent `status` and an absent `conclusion` as neutral (`src/github/mutation-guard.ts:196-215`). That is correct for a PATCH, which leaves the stored values alone. For a POST it is not: GitHub defaults `status` to `queued`, so the run is pending and, if required, blocks a merge. My probe sent `checks.create({ name: "graft/policy" })` through the **default** client in report mode, with no refusal. No production code does this today (intent, provenance and policy always send `completed`), so this is defence in depth. But the guard is the barrier that is supposed to make "report mode is inert" true by construction, and `docs/features/modes.md` now says a Phase 0 check run must be "`completed` and `neutral`".

**Fix:** for `POST …/check-runs`, require `status === "completed"` and `conclusion === "neutral"` for the Phase 0 path. Anything else is `enforce`, so a status-less create needs the policy client and the gate. Add the case to U-MG-12 and U-MG-13. Record it in decisions.md next to deviation 1.

### 3. minor: a retryable team or membership error logs the team slug and the login

`rethrow(err, "team lookup" | "team membership")` (`src/modules/policy/approvals.ts:39-42,125,155`) goes through `toJobError` → `sanitizeError`. Its `routeTemplate` (`src/queue/errors.ts:42-55`) replaces only numbers and SHAs. Probe: a 502 on `/orgs/acme/teams/secret-team/memberships/alice` keeps `route: "/orgs/acme/teams/secret-team/memberships/alice"`. The worker logs that at `error` (`src/queue/worker.ts:32-39`), and pg-boss stores it with the failed attempt. Spec §15 says no log line or error message holds a team slug, and Phase 0 D19 keeps slugs out of storage. Rate limits and 5xx are exactly the errors that reach this path.

**Fix:** template the segments after `teams/` and `memberships/` (or after `/orgs/{org}/`) in `routeTemplate`, or give the two calls a fixed route string before rethrowing. Add a unit case to the sanitiser tests.

### 4. minor: on a public repository, outsiders can push real approvers past the D17 bound

The bounds are applied in login order over every reviewer (`approvals.ts:57-82`), and on a public repository anyone can submit `APPROVED` or `CHANGES_REQUESTED`. Twenty throwaway accounts whose logins sort first (for example `aaa01`…`aaa20`) use up the 20 role checks. A maintainer's approval then lands in `check_limit` and does not count. A 21st outsider requesting changes is "unchecked" and **blocks**. Both effects fail closed, so nobody can merge on false approvals, but a cheap denial of service is possible on an enforcing public repository. The reviewer sync already filters on `author_association` (`src/modules/pilot/reviewers.ts:52`).

**Fix:** order the candidates by association first (`OWNER`, `MEMBER`, `COLLABORATOR`, then the rest), then by login, before applying the bounds. Keep the fail-closed rules for anyone left unchecked. Associations are not proof of access, so do not use them to skip a role check, only to order the checks. Alternatively, note it in HUMAN-TODO as a reason not to enforce on public repositories in Phase 1.

### 5. minor: two fail-closed rules have no test

- **X5:** counting a `state: "pending"` membership as active survives the whole I-ENF suite. Only `active` counts (§5, T1 (b)), and the fake already models `state`.
- **X3:** making a requester answered 403, or past the requester bound, non-blocking survives. These are the rules of deviation 3.

Both rules are correct in the code. Nothing stops a regression.

**Fix:** add an I-ENF-6 or I-ENF-12 case with a pending membership (constraint unmet), and a case with a requester answered 403 and one past the 20-requester bound (both `changes_requested`). Re-run X3 and X5.

### 6. minor: in a transfer race, the policy job reads the previous owner's modes and fails permanently

If a PR event for the new installation arrives before `installation_repositories.added`, `ensureRepository` (`src/modules/installations/store.ts:233-266`) finds the active row of the old installation. It returns `active`, because it neither moves nor resets the row. `getEffectiveModes(repositoryId)` then returns the old owner's `enforce`. The job renders enforce wording and tries a non-neutral publish. The gate scopes by installation (`modes/store.ts:84`) and refuses `repository_unknown`, so the job fails permanently with an error log. This fails closed, and the later `added` event resets and republishes. Still, the job should not act on another installation's modes at all.

**Fix:** have `ensureRepository` report a row whose `installation_id` differs from the caller's (for example a third result, `"other_installation"`), and skip the job with `skipped` and reason `repository moved`, as for `removed`. A test: a job for installation B on a row that still belongs to A publishes nothing and fails nothing.

### 7. minor: the gate trusts the process's own ceiling, so a rolling restart can publish enforce after a ceiling rollback

`mutationGate` and `getEffectiveModes` use `config.modeCeiling`, the environment of the process that runs the job (`src/modules/modes/effective.ts:25-29,36-40`). During a rolling deploy that lowers `GRAFT_MODE_CEILING` to `report`:
1. The new worker's ceiling fan-out republishes `neutral`.
2. An old worker, still running with `enforce`, picks up a later review-triggered job, reads `enforce`, passes its own gate, and publishes `failure` or `success`.
3. That conclusion stays until the next trigger.

This is a step 1 design choice, but step 2 is the first step where a stale ceiling changes a merge outcome.

**Fix:** either make the gate (and the job's mode read) use the lower of the environment ceiling and the ceiling stored in `service_state` by the last worker start, or document in `docs/features/modes.md` and HUMAN-TODO that lowering the ceiling requires stopping every worker before starting the new one.

### 8. nit: a non-neutral PATCH can rename another check run to `graft/policy`

The body rule checks `body.name` (`mutation-guard.ts:325`), and a PATCH may carry a new `name`. Probe: `PATCH …/check-runs/7 { name: "graft/policy", conclusion: "failure" }` through a `policy` client is sent, whatever run 7 was. Only the policy job's own code holds a `policy` client, and it PATCHes only run IDs it found as `graft/policy`, so this is theoretical. Consider requiring, for a PATCH through the `policy` client, that the run ID came from `checkRunIdForHead`/`listForRef` for `graft/policy` (a comment is enough), or refusing `name` in a non-neutral PATCH body unless it equals the stored name.

### 9. nit: the recycled-login check passes when the response has no `user`

`if (res.data.user && res.data.user.id !== o.user.id)` (`src/github/collaborator.ts:64`) accepts the role when `user` is missing or null. GitHub always returns it, and the reviewer sync has had the same line since Phase 0. Since this helper now decides who can approve a merge, `if (!res.data.user || res.data.user.id !== o.user.id) return { role: "none", denied: null }` fails closed for free. Add a U-COL-3 case.

## Required before approval

Finding 1, with its decisions.md note and the extended I-ENF-11. I recommend findings 2, 3 and 5 as well: each one is a few lines, and they close the guard's last body gap, the slug leak in logs and two untested fail-closed rules. Findings 4, 6 and 7 must be fixed or documented before any repository enforces (step 7 rollout at the latest). Nits 8 and 9 are optional.
