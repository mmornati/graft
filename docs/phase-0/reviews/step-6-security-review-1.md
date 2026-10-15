# Step 6 security review 1: vote-eligibility hardening

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted diff on top of `0cbdce2` (Phase 0 step 6) that closes two vote-eligibility bypasses:
- reviews and review requests from users without standing on the repository;
- allow-list matching by recyclable logins.

Judged against the step 6 spec (D5, §8.1), the Phase 0 constraints and the README §7 notes the diff adds.

The hardening itself is sound: the outsider paths are closed, and the fail-closed versus retry split is right. The one major is a DoD break: a doc comment trips the module-graph grep. It is a one-line fix.

## What was checked

- **DoD chain.**
  - Passed:
    - `lint`, `typecheck`, `test` (**756 of 756**), `build` and `eval:ci` (exit 0; its run directory was removed);
    - `graft policy schema --check`, the example and the three starter files (exit 0) and `alias-bomb.yaml` (exit 1);
    - `db:migrate` (0007 applied), `db:rollback` (only 0007), `db:status` and `db:migrate`, on the empty dev database. After the round trip, `pr_reviewers.verified` is `boolean NOT NULL DEFAULT false`.
  - The ID grep returns 74 lines and `app-manifest.json` is unchanged.
  - **The module-graph grep fails** (finding 1).
- **New test IDs.** I-REV-6..9, I-GATE-9/10, U-GATE-14/15, I-ALLOW-1 and I-DB-12 exist as named tests. U-GATE-13 has no test of its own: it is a block inside `U-GATE-2 / U-GATE-13`, which is acceptable.
- **Mutations.** All mutations were applied in turn, with `src/` diffed against a tarball afterwards (byte-identical). Results:
  - the 21 spec mutations and 8 of the review-2/3 mutations: all killed, by the same tests as before;
  - 18 new security mutations: 15 killed, 3 survive.

  | Mutation | Result |
  | --- | --- |
  | `author_association` check removed / `CONTRIBUTOR` accepted | killed by I-REV-6 |
  | Review-state check removed | killed by I-REV-2, I-REV-6 |
  | Permission result ignored | killed by I-REV-7 |
  | User-id mismatch check removed | killed by I-REV-7 |
  | 403 fails open / 404 fails open | killed by I-REV-7 |
  | Rate limit or 5xx fails closed (no retry) | killed by I-REV-8 |
  | `triage` dropped / `read` accepted | killed by I-REV-7 |
  | Gate ignores `verified` | killed by I-GATE-10 |
  | Re-sync does not promote (`doNothing`) / rows inserted unverified | killed by I-REV-9 / I-REV-7 |
  | Login-only allow-list line accepted | killed by U-GATE-14 |
  | `resolve` writes despite unresolved lines | killed by U-GATE-15, I-ALLOW-1 |
  | **Custom-role fallback (`BASE_PERMISSIONS`) removed** | **survives** (finding 3) |
  | **Doctor ignores `verified`** | **survives** (nit, finding 8) |
  | Allow-list matched by login again | survives, but **equivalent**: `allow` is a `Set<number>`, so a login can never match |
- **Outsider paths, traced.** Every way a vote can count now goes through a user id:
  - **Reactions** use the voter id from `reactions.list`. **Check-run buttons** use the HMAC-signed `sender.id`; `checks.get` confirms the run, and a replay only re-asserts the same user's vote (README §5).
  - Either way the vote counts only if `(change, user id)` is a **verified** `pr_reviewers` row, or the user id is on the allow-list.
  - A **verified** row needs one of two things:
    - a review whose state is `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED` **and** whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`;
    - a user-type review request whose user holds triage or higher (`role_name` admin, maintain, write or triage, or legacy `permission` admin or write), with an answer for the same user id.
  - An outsider (`NONE`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`) is rejected on both paths.
  - On a public repository the permission endpoint answers `read` for a non-collaborator, or 404; both are ineligible.
  - **Bots** are dropped at ingest (`type: Bot`) and by the `[bot]` suffix.
  - The two residual cases are findings 2 and 5.
- **Error classification.**
  - `classifyGitHubError` maps a 403 carrying `x-ratelimit-remaining: 0`, `retry-after` or "secondary rate limit" to `rate_limited`, so the job retries. A plain 403, 401, 404 or 410 counts as forbidden or not found, which means ineligible (fail closed).
  - A 5xx is `transient` and retries. A classified job error is not wrapped a second time (`classified` WeakSet).
  - I-REV-8 checks both rate limit and 5xx, and confirms that nothing is stored before the retry.
- **Migration 0007 and legacy rows.**
  - Existing rows become `verified = false`, and the gate (`where verified`) and the doctor ignore them.
  - A re-sync upserts only users who pass the checks, with `ON CONFLICT ... DO UPDATE SET verified = true`, keeping `first_seen_at`. Nothing is deleted.
  - I-REV-9 shows that a member and a triage requester are promoted while an outsider stays unverified. I-DB-12 shows that down then up keeps the rows unverified.
  - Legacy rows that cannot be re-verified any more (for example a request that was later withdrawn) stay unverified. That is fail-closed and documented in HUMAN-TODO.
- **Allow-list parser, probed.**
  - Accepted:
    - `12345` and `alice : 12345 # lead`;
    - tabs, CRLF, blank and comment-only lines, an empty file;
    - a leading BOM or NBSP (trimmed), and `123#45`, read as id 123;
    - `dependabot[bot]:49699333`, which the bot rule drops later anyway.
  - Duplicates (`12345`, `alice:12345`, `bob:12345`) count as 1 id.
  - Rejected, naming the line number only:
    - `0123`, `0`, 17 digits, `9999999999999999` (above `MAX_SAFE_INTEGER`);
    - fullwidth digits, `+123`, `-123`, `a:1:2`, `12345:alice`, `al_ice:1`;
    - `alice` and `1e3` (login-only).
  - `resolve` keeps comments and CRLF, resolves everything or nothing, and rejects a malformed line before any lookup is written.
- **Logins still matched.** Only for exclusion: the PR-author flag (`is_pr_author`, which compares logins at ingest), the `[bot]` suffix and `GRAFT_AGENT_LOGINS`. No login makes a vote count (finding 4).

## Findings

1. **major**, `src/db/schema.ts:299`. **Problem:** the DoD's module-graph check `grep -rn "modules/" src/db/ src/policy/ && exit 1` now matches the new doc comment "Passed the standing checks of `modules/pilot/reviewers.ts`". The DoD chain therefore exits 1. The grep guards against `src/db` importing modules, and a comment is enough to trip it. **Required fix:** reword the comment so it does not contain `modules/`, for example "the reviewer sync's standing checks (pilot module)". Then re-run the DoD greps.
2. **minor**, `src/modules/pilot/reviewers.ts:43, 134`. **Problem:** `MEMBER` and `COLLABORATOR` do not prove write or triage access.
   - On a **public organisation repository**, any member of the organisation has `MEMBER` association and can submit an approving review, even with only read access to this repository and no link to the pilot team.
   - `COLLABORATOR` includes read-only outside collaborators. README §7 documents that case but not the `MEMBER` one.
   - These people are insiders, not anonymous outsiders. Still, the two paths apply different bars: triage for requests, association for reviews.

   **Fix:** either run the same cached `hasTriagePermission` check for reviewers (one call per distinct user, already cached per job), or document the `MEMBER` residual next to the `COLLABORATOR` one in README §7 and onboarding §8.
3. **minor**, `src/modules/pilot/reviewers.ts:73` and `test/integration/pilot-module.test.ts` (I-REV-7). **Problem:** the custom-role path is untested; removing the `BASE_PERMISSIONS` fallback survives.
   - The mapping itself is sound:
     - a custom role reports its own `role_name`, and the legacy `permission` reflects its base role, with maintain mapped to write and triage to read;
     - so custom roles built on write or maintain pass, and those built on triage or read fail closed, as documented;
     - built-in role names are lowercase, so a custom role named `Triage` does not collide.
   - But nothing pins it.

   **Fix:** add three I-REV-7 cases using the fake's `permission` override: `{ role: "release-manager", permission: "write" }` passes; `{ role: "triager-plus", permission: "read" }` fails; and a role named `Triage` with `permission: "read"` fails.
4. **minor**, `src/modules/intent/feedback.ts:71, 169` and `src/pilot/gate.ts:185-187`. **Problem:** two exclusions still compare logins, so a rename defeats them.
   - **Author exclusion:** `is_pr_author` compares the voter's login with `changes.author_login`, as stored when the PR opened. An author who renames their account and is on the allow-list (by id) has their own votes counted. GitHub stops authors approving or being requested on their own PR, so the allow-list is the only route.
   - **Agent exclusion:** an agent account listed in `GRAFT_AGENT_LOGINS` and renamed escapes it. If that account has write access and is requested, it is a verified reviewer.
   - Both need an insider's deliberate rename. They are the last login matches on the eligibility path, and they fail open.

   **Fix:**
   - Store the author's user id on `changes` from `pulls.get` (`user.id`) and compare ids. Until then, also drop a vote whose user id is the PR author's id from the API.
   - Accept `GRAFT_AGENT_IDS` (or `login:id` in `GRAFT_AGENT_LOGINS`).
   - Otherwise, document the residual.
5. **minor**, `src/modules/pilot/reviewers.ts:74-80` and `docs/phase-0/HUMAN-TODO.md`. **Problem:** a 403 or 404 from the permission check returns `false` without a log, and the sync's info line logs only `candidates` and `verified`. HUMAN-TODO tells the operator to "check the worker log for 403" if requested reviewers never appear, but there is nothing to find.
   - The required App permission (`Metadata: read`) is an assumption that could not be checked offline.
   - If it is wrong, every requested reviewer becomes silently ineligible.

   **Fix:** count the fail-closed answers by class and log them with the sync, as `{ permissionDenied, permissionNotFound }`, numbers only. Optionally make the doctor warn when a repository's recent syncs saw requested candidates but stored none.
6. **minor**, `src/pilot/allow-list.ts:50-53`. **Problem:** a line of digits is always read as a user id. GitHub logins can be all digits, for example `1234`. An operator who writes such a teammate's login alone gets user **id** 1234 instead, an unrelated account that becomes eligible. `resolve` does not catch it either, because the line is not "login-only". **Fix:** document in onboarding §8 and the parser comment that a numeric login must be written as `login:id`. Better: have `resolve --check` look up every bare id with `GET /user/{id}` and print id→login for a human to confirm.
7. **minor**, `src/bin/graft-ops.ts:268`. **Problem:** `resolve` is all-or-nothing in memory: no write happens unless every login resolves, and a lookup error throws before writing. But the write itself is a plain `writeFile` on the original path, which truncates and then writes. An interrupted write (crash, full disk) leaves a partial or empty allow-list, and an empty one is valid and silently drops every allow-listed voter. **Fix:** write to `<file>.tmp-<pid>` in the same directory with mode 0600, `fsync`, then `rename` it over the original. Keep the original's mode, or use 0600.
8. **nit**, `src/pilot/doctor.ts:135`. **Problem:** the `feedback` warning now counts only verified rows, but no test pins it, so the mutation survives. **Fix:** add a doctor case with an unverified-only change.
9. **nit**, `test/unit/pilot-gate.test.ts:43`. **Problem:** U-GATE-13 lives inside `U-GATE-2 / U-GATE-13` instead of in its own `it`, and the DoD's per-ID check needs a regex that allows that. Fine as is, but a separate `it("U-GATE-13 ...")` would keep the ID convention.

## Questions, answered

- **Can an outsider's vote still count?** No. Reactions and buttons both need a verified reviewer row for that PR, or an allow-listed id. Outsider reviews are rejected by association, outsider requests by the permission check, bots by type and suffix, and legacy rows are ignored until re-verified. The residuals are insiders: read-only collaborators and, on public repositories, any organisation `MEMBER` (finding 2), plus the rename edges of the login-based exclusions (finding 4).
- **Is the permission and role mapping correct?** Yes, including custom roles (write and maintain bases pass, triage and read bases fail closed), but the custom-role path is untested (finding 3).
- **Fail-closed versus retry?** Correct: 404, 410, 401 and a plain 403 mean ineligible, while a rate-limit 403, 429 or 5xx retries. The silent 403 should be logged (finding 5).
- **Migration 0007 and legacy rows?** Correct: the default is `false`, the gate filters on it, and a re-sync promotes rows without deleting any. Tests I-DB-12, I-GATE-10 and I-REV-9 cover it.
- **Allow-list parser?** Sound on every edge case I probed; the numeric-login ambiguity is finding 6.
- **Is `resolve` atomic?** It is all-or-nothing in memory, but the file write is not atomic (finding 7).
- **Is any login still matched?** Only in exclusions (author, `[bot]`, agent logins). No login can make a vote count.
- **DoD and mutations?** Everything passes except the module-graph grep (finding 1). The mutations are killed except the two untested paths and one equivalent mutant.
