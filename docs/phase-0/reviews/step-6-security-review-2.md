# Step 6 security review 2: vote-eligibility hardening

Verdict: APPROVED

Reviewer: senior engineer (Opus). Scope: the uncommitted diff on top of `0cbdce2` after the fixes for [security review 1](step-6-security-review-1.md):
- migration `0007_vote_eligibility` (`pr_reviewers.verified`, `changes.author_id`, `reviewer_check_denials`);
- the permission check for review authors;
- author exclusion by id;
- logged and recorded 403/404 denials;
- `@login` allow-list entries;
- the atomic allow-list write.

Every blocker and major of review 1 is fixed. Five minors and nits remain; none blocks.

## What was checked

- **DoD chain.**
  - `lint`, `typecheck`, `test` (**766 of 766**), `build`, `eval:ci` (exit 0; its run directory was removed), `graft policy schema --check`, the example and the three starter files (exit 0) and `alias-bomb.yaml` (exit 1) all pass.
  - **All three DoD greps are clean**, including `grep -rn "modules/" src/db/ src/policy/`, which caught review 1's major. The ID grep returns 80 lines and `app-manifest.json` is unchanged.
  - `db:migrate`, `db:rollback` (only `0007_vote_eligibility`), `db:status` and `db:migrate` ran against `graft_test`, which the test suite drops and recreates itself.
    - After the rollback, the table and both columns are gone.
    - After the re-apply, there are 20 public tables, matching `TABLE_NAMES`.
  - The dev database could not be used for this step; see finding 5.
- **Mutations.** All mutations were applied in turn, with `src/` diffed against a tarball afterwards (byte-identical). Results:
  - the 21 spec mutations and the 16 security mutations of review 1: **all killed**. That includes the custom-role fallback (now killed by I-REV-10), a case-insensitive role name (I-REV-10) and the doctor's `verified` filter (I-DOC-4), all three of which survived in review 1.
  - 14 new mutations: killed, except the non-atomic in-place write.

  | Mutation | Killed by |
  | --- | --- |
  | Review authors skip the permission check | I-REV-11 |
  | Author-id exclusion removed, or author ids not loaded | U-GATE-16, I-GATE-11 |
  | `author_id` not stored on upsert | I-REV-13 |
  | Purge map without `reviewer_check_denials` | I-PURGE-2, I-PURGE-1 |
  | Denials not recorded, or never cleared | I-REV-12 |
  | Doctor's 403 warning removed | I-DOC-4 |
  | Temp file mode not kept | U-ATOMIC-1 |
  | Temp file not removed on failure | U-ATOMIC-2 |
  | `@login` form removed | U-GATE-14 |
  | `resolve` bypasses the atomic writer | I-ALLOW-1 |
  | **`rename` replaced by an in-place `writeFile`** | **survives** (finding 3) |
- **Purge.**
  - `OWNED_ROWS` has `reviewer_check_denials` (by `change_id`). The table cascades from `changes`, so it goes with the installation.
  - I-PURGE-1 seeds it for installations A and B and checks that A's rows are gone and B's are kept.
  - I-PURGE-2 enumerates `TABLE_NAMES` and compares it with `information_schema`. Removing the map entry fails both tests.
  - I-PRIV-1's table list includes the new table.
- **`author_id`.**
  - `changes` has one write path, `upsertChangeFromPull`. It sets `author_id = pull.user?.id ?? null` on insert and in the guarded `ON CONFLICT` update, and all three callers (intent, provenance and policy jobs) pass the API's `pulls.get`.
  - In the gate, a vote is the author's if the login flag from ingest is set **or** `changes.author_id = vote.user_id`.
  - A `null` author id (legacy row, or a deleted "ghost" author) gives `undefined === userId`, which is false. It excludes no one by itself, and the login flag still applies. It can never exclude everyone.
  - Legacy closed PRs that are never upserted again keep `null`, so only the login check covers them (finding 4).
- **`reviewer_check_denials` holds no login.** Its columns are `change_id`, `user_id`, `status ∈ {403, 404}` and `checked_at`.
  - The warning log carries the status, the route template and the PR number. I-REV-12 asserts that the sentinel login does not appear in any log line.
  - A later passing check clears the user's row.
- **Permission check for review authors.**
  - Same bar as requests: triage or higher, with the user id checked against the answer. Results are cached per job by user id.
  - The check is called only after the state and association filters, so outsiders (`NONE` and others) cost no request.
  - Per sync: 1 request-list call, at most 3 review pages (300 reviews), and **one permission call per distinct qualifying user**. I-REV-11 asserts one check per user.
  - Usage is bounded per job, but it is not incremental across jobs (finding 1).
- **Atomic write, probed.**
  - The temp file is created in `dirname(file)`, so the rename stays on the same file system. It is opened with `wx` and a random suffix, then chmod-ed to the original mode (0600 for a new file), fsync-ed, closed and renamed. It is unlinked on any failure.
  - U-ATOMIC-1 checks that the mode is kept and that no temp file remains. U-ATOMIC-2 checks that an injected failure leaves the original intact.
  - **Symlink:** I tested it on a symlinked allow-list (`work/allow.txt → vault/allow.txt`). `stat` follows the link, so the mode came from the target, but the rename **replaced the symlink with a regular file**. The resolved list ended up in `work/`, and `vault/allow.txt` was left stale (finding 2).

## Findings

1. **minor**, `src/modules/pilot/reviewers.ts:107-150`. **Problem:** each sync re-checks the permission of every qualifying user, including users already stored `verified` for this change.
   - The table is a union over time: once a user is verified, they stay verified. So these calls cannot change anything.
   - A sync runs per `pull_request_review.submitted` delivery, per request, on close, and hourly on votes. A PR with R distinct qualifying reviewers and E review events therefore costs about R × E permission calls. That is up to 300 × E in the worst case, though small for real PRs.

   **Fix:** before checking, load the change's verified `(user_id, reason)` rows and skip users already verified for that reason. Keep the check for unverified (legacy) rows so they can be promoted.
2. **minor**, `src/pilot/atomic-write.ts:21-39`. **Problem:** a symlinked allow-list is replaced by a regular file next to the link. The target keeps the old content, and the new file lives wherever the link was, possibly outside the protected location the operator chose. **Fix:** write to `realpath(file)` (temp file in the target's directory, rename over the target). Alternatively, refuse a symlink with a usage error. Add a U-ATOMIC case.
3. **nit**, `test/unit/atomic-write.test.ts`. **Problem:** replacing `rename` with an in-place `writeFile` survives, because the tests only see the end state. **Fix:** in U-ATOMIC-1, assert that the file's inode changed across the write (`stat(file).ino`), which only a rename produces. Optionally `fsync` the directory after the rename for durability across power loss.
4. **nit**, `src/modules/changes/store.ts:55` and README §7. **Problem:** `author_id` is filled only when a pull is next upserted. A closed or merged legacy PR is never upserted again, so for votes on it the author exclusion stays login-based, with the rename residual of review 1. **Fix (optional):** have `pilot sync-reviewers`, which already reads the PR, fill a null `changes.author_id` from `pulls.get`. Otherwise, document that legacy PRs keep login-only author exclusion.
5. **nit**, migration rename (operational). **Problem:** the round-1 file `0007_reviewer_verified` was renamed to `0007_vote_eligibility` and extended.
   - A database that applied the round-1 migration keeps that row in `kysely_migration` plus the `pr_reviewers.verified` column. `db:status` then shows `0007_vote_eligibility` pending, and `db:migrate` would fail on the existing column.
   - The diff was never committed, so only local databases are affected. That includes **this repository's dev database** (`graft` on port 55432), where my review-1 DoD run applied the old 0007.
   - I tried to undo that: drop `pr_reviewers.verified` and delete the `0007_reviewer_verified` migration row. The sandbox refused the change to a shared database, so the dev database still needs it before the next `pnpm db:migrate`. It holds no rows.

   **Fix:** run once on any affected dev database, then `pnpm db:migrate`:

   ```sql
   alter table pr_reviewers drop column if exists verified;
   delete from kysely_migration where name = '0007_reviewer_verified';
   ```

## Questions, answered

- **Purge and `TABLE_NAMES`:** covered. The table is in `TABLE_NAMES` (20 tables) and `OWNED_ROWS`, cascades from `changes`, and is enumerated by I-PURGE-2 against `information_schema`. The mutations are killed.
- **`author_id` on every upsert path:** yes, there is a single path, fed only by API data. A `null` id never excludes anyone wrongly, and the login check remains as a fallback (finding 4 for legacy PRs).
- **Logins in the denials table:** none. Ids, a status and a time only, and no login reaches the logs.
- **Atomic write:** same directory, mode preserved, all-or-nothing on failure. A symlink is replaced instead of followed (finding 2).
- **API usage:** bounded per job (3 review pages, a per-job cache, one call per distinct qualifying user, outsiders free). It repeats across syncs (finding 1).
- **DoD and mutations:** green, including the module-boundary grep and the migrate/rollback/migrate round trip. All mutations are killed except the non-atomic-write mutant (finding 3).
