# Step 6 review 1: Pilots and gate

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted step 6 diff (Steps 1 to 5 committed), judged against `docs/phase-0/step-6-pilots-and-gate.md`, the Phase 0 README constraints, README §5/§7 ("Step 6 deviations and additions"), `docs/pilots/onboarding.md` and HUMAN-TODO.

## What was checked

- **DoD chain.**
  - Passed: `lint`, `typecheck`, `test` (67 files, 740 tests), `build` and `eval:ci` (exit 0, baseline equal).
  - Policy checks: `graft policy schema --check` exits 0, the example and the three starter files exit 0, `alias-bomb.yaml` exits 1, `non-ascii-glob.yaml` exits 0 with the warning line, and `lookalike-glob.yaml` exits 1 with detail 9.
  - `db:migrate`, `db:status`, `db:rollback` (only 0006 rolled back) and `db:migrate` all pass on the empty dev database.
  - The three greps are clean, the ID grep returns 61 lines and `app-manifest.json` is unchanged. `pnpm install --frozen-lockfile` was not re-run because it needs the network.
  - Every test ID in spec §12, plus U-Q-6, I-Q-6 and I-PRIV-1, exists as a named test.
- **Mutations.** I applied all 21 spec mutations in turn and restored each one, with checksums verified afterwards. Every mutation is killed by the named tests:

  | Mutation | Killed by |
  | --- | --- |
  | Eligibility filter removed | U-GATE-2, I-GATE-2 |
  | Author exclusion removed | U-GATE-2 |
  | `unavailable` votes counted | U-GATE-4 |
  | Wilson replaced by the normal approximation | U-GATE-1, U-GATE-7 |
  | N_min check removed | U-GATE-5 |
  | Coverage ignored | U-GATE-9 |
  | Draft time not subtracted | U-BASE-3 |
  | Re-request moves S | U-BASE-4 |
  | Self-approval counted | U-BASE-6 |
  | Draft request takes effect at once | U-BASE-2 |
  | Rounds count reviews, not commits | U-BASE-8 |
  | Run row written before the PR loop | I-BASE-2 |
  | Purge skips the pg-boss jobs | I-PURGE-1 |
  | Purge skips `webhook_deliveries` | I-PURGE-1 |
  | Policy reacts to `feedback_recorded` | I-REV-3 |
  | Culprit taken from the payload body (body plumbed through the job data) | I-INC-3 |
  | Rollup uses the first `facts_read_at` | I-ROLL-1 |
  | Sweep back on `published_at` | I-FB-11 |
  | Detail 9 removed | U-PG-21, U-PY-12, U-CFG-31 |
  | Env globs not validated | U-CFG-30 |
  | Warnings change the exit code | U-CLI-8 |
- **Wilson by hand.**
  - (118, 128): p̂ = 0.921875, centre 0.936881, margin 0.048854, denominator 1.030011, giving 0.86215 to 0.95701. This matches the spec sketch and U-GATE-1.
  - (9, 10): 0.59585 to 0.98212.
  - At n = 400 and p̂ = 0.90 the lower bound is about 0.868, so the ≥ 400 point-estimate rule is consistent with the 0.85 floor.
- **Decision order** (`gate.ts:52-113`) matches §8.1.6: early FAIL at n ≥ 50, then N_min, then coverage, then the n ≥ 400 rule, then the lower bound.
  - Installation ids are deduplicated, and a coverage population of 0 PRs fails coverage.
  - Each vote is deduplicated per (card, user), the latest vote winning (`pickEffectiveVotes`). The window applies to the effective vote.
- **pg-boss 12.38.0 internals.**
  - `deletion()` in `dist/plans.js` deletes a job when `completed_on + deletion_seconds < now`, or when it is queued and `keep_until < now`. Jobs copy `q.deletion_seconds` at insert.
  - `job` is `PARTITION BY LIST (name)`, with `job_common` as the default partition, so the start-time `UPDATE <schema>.job ... deletion_seconds > 3600` and the purge's `DELETE` reach every queue. There is no archive table.
  - I-Q-6 really proves that a 2-hour-old legacy webhook job is deleted while a 30-minute-old one and the intent job stay.
- **Picomatch exact-text shortcut.** `picomatch.test` sets `match = input === glob`, case-sensitive and without `format` because `windows` is unset. My own differential found 0 mismatches over 131,100 glob×path pairs in both case modes, including 13,850 text-equal paths and `./`- and `/`-prefixed globs.
- **Lookalike probe** (`validateGlob`):
  - Rejected with detail 9: Latin+Cyrillic, Latin+Greek, Latin+Armenian, Cyrillic+Greek, Hangul+Katakana and Cherokee+Latin.
  - Accepted: all-Cyrillic, Hangul+Latin, Katakana+Han, Han+Latin, and both forms of `café`.
  - The gaps are findings 1, 5 and 12.
- **Purge.** `OWNED_ROWS` covers every `TABLE_NAMES` entry except `pilot_purges`. I-PURGE-2 also compares the list with `information_schema`. Every job schema carries `installationId`, and `github.webhook` carries `payload.installation.id`.

## Findings

1. **major**, `src/policy/globs.ts:7`. **Problem:** the step widens `ALLOWED` to every `\p{M}`, which re-admits invisible combining marks.
   - Before step 6, `sec͏rets/**` (COMBINING GRAPHEME JOINER) was rejected with detail 2. It is now valid. So is `secrets️/**` (a variation selector).
   - Both read exactly like `secrets/**` and never match `secrets/a.pem`. I verified this with `globMatcher`.
   - Marks are `Inherited`, so detail 9 ignores them. Only the `glob_non_ascii` warning remains, and that is the same warning an honest `docs/руководство/**` gets.
   - This is the D14 threat ("reads right and never matches, which silently loosens a tightening rule") made worse by invisibility, introduced by this step's own deviation. It applies to `graft.yaml` globs, `sensitive_paths` and `GRAFT_INTENT_SENSITIVE_PATHS`.

   **Required fix:** keep accepting visible combining accents but reject:
   - `\p{Default_Ignorable_Code_Point}`, which covers CGJ, the variation selectors U+FE00–FE0F and U+E0100–E01EF, and similar characters;
   - any mark that does not follow a letter, such as a mark at the start of a segment or after `*`, `/` or a digit.

   Add the CGJ and variation-selector cases to U-PG-21 (and to a U-CFG case), plus a mutation note in README §7.
2. **major**, `src/pilot/gate.ts:460-507`. **Problem:** the shadow comparison pools the latest `baseline` run of every repository with the latest `shadow` run of every repository, without pairing them.
   - D4 says the report compares the two runs per repository. A repository that has only one side shifts that side's p50 and produces a silently wrong Δ%.
   - Examples: a repository added mid-pilot without a baseline (onboarding §5 allows adding one), or a baseline that aborted on the rate limit.
   - Δ% is shown next to the Phase 1 target (agent ≤ −50%), so a skewed Δ can mislead that decision. I-GATE-4 seeds a single repository and cannot see this.

   **Required fix:**
   - Restrict both sides to repositories that have both a `baseline` and a `shadow` run.
   - Report the repositories left out by id or count, never by name in JSON, or render a `repos without a pair: N` line.
   - Extend I-GATE-4 with a second repository that has only a baseline run.
3. **minor**, `src/pilot/gate.ts:57-62, 88, 297`. **Problem:** the gate is easy to skew.
   - `dominant_voter` only warns, and the markdown shows it below the table, away from the verdict.
   - The early FAIL fires at n ≥ 50 with a single voter, a single pilot and a 1-day window.
   - `window_too_short` measures the operator's `--since` to `--until`, not the span of the data, so an early `--since` satisfies 14 days with 2 days of votes.
   - Votes are clustered (one reviewer × many card versions of one PR), so Wilson's iid assumption overstates n.

   The spec mandates the order, so this is not blocking. **Fix:**
   - Print `dominant_voter` and the accuracy without the top voter on the verdict line.
   - Clamp the window start to the earliest installation's `created_at` (or the first eligible vote).
   - Label an early FAIL with fewer than 2 pilots or fewer than 6 voters as "provisional".
4. **minor**, `src/modules/pilot/reviewers.ts:65-69`. **Problem:** a `reviewed` row is stored for a review in any state from any user.
   - On a public repository anyone can leave a `COMMENTED` review, so a drive-by reactor makes their 👍 eligible with one comment, even retroactively, since the table is a union over time.
   - A reviewer requested after voting is also retroactively eligible. That follows D5 ("ever requested"), but the report should say so.

   **Fix:** keep `reviewed` only for `author_association` in {OWNER, MEMBER, COLLABORATOR}. The field is in `listReviews`. Alternatively, document the public-repo caveat in onboarding §8.
5. **minor**, `src/policy/globs.ts:47-53`. **Problem:** letters with `Script=Common` are ignored as the spec says. That lets `\u{1D42C}ecrets/**` (MATHEMATICAL BOLD SMALL S) and fullwidth `ｓecrets/**` (Latin) pass detail 9 with only a warning, and both never match `secrets/...`. **Fix:** reject a glob whose NFKC form differs from itself (outside the allowed combining accents), or treat `\p{L}` in `Common` as its own script.
6. **minor**, `src/pilot/gate.ts:460-473` and `src/pilot/baseline.ts:307`. **Problem:** open PRs are censored (no times) and simply dropped from the p50.
   - The shadow window (2 to 6 weeks, extracted "today") has a much larger censored tail than a 12-week baseline, so the shadow p50 is biased low.
   - "Same definitions" holds, but the same population does not.

   **Fix:** report the censored share (`open / prs`) next to each p50, or limit both runs to PRs created at least N days before `extracted_at`.
7. **minor**, `test/integration/pilot-ops.test.ts:883-888`. **Problem:** I-PRIV-1's "never reaches the new jobs" half checks an empty set. The test calls `syncReviewers` and `detectIncident` directly and the CLI queue throws, so `pgboss.job where name like 'pilot.%'` returns 0 rows. I confirmed this with a temporary `expect(jobs.rows.length).toBeGreaterThan(0)`, which failed with 0. **Fix:** enqueue through the handlers and the `feedback_recorded` listener with sentinel payloads, and assert that at least one `pilot.*` job exists before searching its data.
8. **minor**, `src/pilot/gate.ts:139-142`. **Problem:** §8.1's edge case "a voter whose login changed matches the allow-list by the latest stored login" is not implemented. The allow-list is matched against each vote's own `user_login`, so a renamed reviewer's older votes drop as `not_reviewer`. No test covers it. **Fix:** map `user_id` to the login of that user's newest `intent_feedback` row before the allow-list check, and add a U-GATE-2 case.
9. **minor**, `src/modules/pilot/incidents.ts:118-158`. **Problem:** framing through the live body.
   - Anyone who can edit the fix PR's body while the label is on can name any PR number as culprit with `Graft-Culprit: #N`. The `closed` (merged) event re-runs detection on the live body.
   - Culprits only accumulate; a corrected body never removes one.
   - Culprits are not checked to exist, be merged or predate the fix.
   - The impact is limited to the escaped-defect side metric and the Phase 1 baseline: an open or unknown number does not count, because the join is on merged `changes`. But a merged agent or would-approve PR can be framed or inflated.

   **Fix:**
   - Drop culprits that are not merged before the fix PR's `created_at` (`changes` or `review_time_prs`).
   - Show incident counts by `source` in the report.
   - Add "review label incidents with `incident list`" to the weekly ritual.
10. **nit**, `docs/pilots/onboarding.md:24, 37`. **Problem:** two inaccuracies.
    - "Logins are stored in exactly three places" omits `installations.account_login`, which is a user login for a personal-account install, and the owner part of `repositories.full_name`.
    - "14 days at the latest" holds only while a supervising worker runs pg-boss maintenance. With the worker down, nothing is deleted.

    **Fix:** reword both.
11. **nit**, `src/pilot/gate.ts:230-232, 300`. **Problem:** `votes_without_reviewer_sync` also fires for a synced PR that legitimately has no requested reviewers and no reviews, so the warning never clears. **Fix:** count only changes for which no sync ever ran. That needs a marker, or compare against `pull_request.closed` syncs. Alternatively, reword the warning.
12. **nit**, `src/policy/globs.ts:53`. **Problem:** two unlisted scripts share the one `Other` bucket and so may mix: Ogham+Runic is accepted. The spec's "one unknown bucket that never combines" reads as the opposite. **Fix:** return `Other:<code point block>`, or reject any segment with an `Other` letter plus any second script.
13. **nit**, `src/pilot/gate.ts:111` and `gate-render.ts`. **Problem:** a PASS has `reasons: []`, so the verdict line does not say why it passed. **Fix:** add a `pass` reason with p̂, the lower bound and n, so a reader can check the 0.90 / 0.85 rule from the report alone.

## Deviations (README §7), judged

- Sound:
  - 1-hour webhook retention, plus the tightening at start (verified against pg-boss internals and I-Q-6);
  - dates as strings;
  - `costUsd` outside `usage`;
  - in-memory `pickEffectiveVotes`;
  - cron wiring in `crons.ts`;
  - the rollup and gate choices;
  - a coverage population of 0 counts as a FAIL;
  - review-time `<=` at the merge second;
  - the fallback when every request sits in a pause that never ends;
  - doctor and purge behaviour (`--confirm` also for dry runs, and a dry run allowed on an active installation);
  - 1-based locations;
  - the picomatch reading (verified).
- Not sound as implemented: "`ALLOWED` now accepts combining marks (`\p{M}`)" is broader than `café/**` needs (finding 1).
