# Step 6 review 2: Pilots and gate

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted step 6 diff after the fixes for [review 1](step-6-review-1.md), plus the coordinator's questions:
1. the glob probe;
2. the gate logic and the 30% rule;
3. the wall-clock tests;
4. the DoD chain and the mutations.

Both majors of review 1 are fixed. One new major remains: the wall-clock-bounded tests make `pnpm test` flaky, and it failed in my own DoD run.

## What was checked

- **DoD chain.**
  - `lint` and `typecheck` pass.
  - **`pnpm test` failed: 743 of 745 passed.** U-PE-32 timed out (5,966 ms against the 5,000 ms default), and U-PG-14's "policy + floor" phase took 2,053 ms against its `< 2,000` assertion. The load average was 6 to 8 on a 10-core machine, not the 18 the developer saw (finding 1).
  - The same three files pass alone, even with 4 extra busy loops running.
  - `build`, `eval:ci` (exit 0; its run directory was removed), `graft policy schema --check`, the example and the three starter files (exit 0) and `alias-bomb.yaml` (exit 1) all pass.
  - `db:migrate`, `db:rollback` (only 0006), `db:status` and `db:migrate` all pass on the empty dev database.
  - The greps are clean, the ID grep returns 64 lines and `app-manifest.json` is unchanged.
- **Mutations.** The 21 spec mutations and 10 of my own mutations of the round-2 fixes are all killed. Every mutation was applied in turn, and `src/` was diffed against a tarball afterwards, so it is byte-identical:

  | Mutation | Killed by |
  | --- | --- |
  | The 21 of spec §13 (same anchors as review 1, re-anchored where the code moved) | the named tests (U-GATE-1/2/4/5/7/9, U-BASE-2/3/4/6/8, I-BASE-2, I-PURGE-1 ×2, I-REV-3, I-INC-3, I-ROLL-1, I-FB-11, U-PG-21, U-PY-12, U-CFG-30/31, U-CLI-8) |
  | `Default_Ignorable_Code_Point` check removed | U-PG-21, U-CFG-31 |
  | Orphan-mark check removed | U-PG-21 |
  | NFKC check removed | U-PG-21, U-CFG-31 |
  | Repository pairing removed | I-GATE-4 |
  | 30% dominant-voter block removed | U-GATE-6 (dominant voter) |
  | Early-FAIL breadth guard removed | U-GATE-6 |
  | Window measured from `--since` again | I-GATE-1 (data span) |
  | Comment-only reviews stored again | I-REV-2 |
  | Culprit validation removed | "a framed culprit is dropped" |
  | Rename lookup for the allow-list removed | U-GATE-2 |
- **Glob probe (`validateGlob`).** Rejected:
  - Detail 9 (mixed scripts or NFKC change):
    - Latin+Cyrillic, Latin+Greek and Latin+Armenian;
    - `ﬁ`, superscript `²`, Roman numeral `Ⅸ`, mathematical bold `𝐬` and fullwidth `ｓ`;
    - long `ſ`, halfwidth katakana and compatibility jamo `ㄱ`.
  - Detail 2 (character not allowed):
    - default-ignorable code points: CGJ U+034F, VS16 U+FE0F, VS17 U+E0100, Mongolian FVS1 U+180B, the tag characters U+E0061 and U+E007F, ZWSP and the soft hyphen;
    - the Hangul fillers U+3164, U+115F, U+1160 and U+FFA0, and the Braille blank U+2800;
    - an orphan mark at the start of a segment, after a digit, after `*` or after `/`.

  Accepted:
  - `café` (precomposed and decomposed), two stacked marks and Vietnamese (precomposed and NFD);
  - all-Cyrillic, Katakana+Han, Hangul+Latin, Han+Latin and NFD Hangul;
  - Hindi with a virama, Thai with marks, Arabic and all-Greek.

  An env glob with CGJ or `ﬁ` gives a ConfigError that names the index and the reason, never the value. The exceptions are in finding 2.
- **Other fixes from review 1.**
  - **Shadow comparison:** pairs repositories and reports baseline-only and shadow-only counts and the right-censored PRs.
  - **I-PRIV-1:** now asserts at least 2 `pilot.*` jobs before it searches them.
  - **Allow-list renames:** matched by the login of the user's newest vote.
  - **Incident culprits:** must be merged earlier in the same repository.
  - **Onboarding doc:** names `installations.account_login`.
  - **README §7:** records every change to spec §8.1.6 and D5.

## Findings

1. **major**, `test/unit/policy-evaluate.test.ts:925` (U-PE-32, no explicit timeout, so vitest's 5 s default applies), `test/unit/policy-parse.test.ts:110, 615, 635, 873-875, 900, 966, 1050, 1065` (U-PG-8, U-PG-12, U-PG-14 and others; bounds as tight as `< 50 ms` and `< 100 ms`), `test/unit/intent-risk.test.ts:341` (U-RISK-21), and U-PE-30.
   - **Problem:** these tests assert wall-clock milliseconds, and the full `pnpm test` run (unit files in parallel plus Postgres integration) makes them fail.
   - Here they failed at a moderate load of 6 to 8 on a 10-core laptop. Alone, U-PE-32 takes about 2.3 s and U-PG-14 about 1.9 to 2.2 s, so the headroom is about 2× for U-PE-32 and under 10% for U-PG-14.
   - CI runs `pnpm test` (`.github/workflows/ci.yml:37`) on a shared 2- or 4-vCPU runner with slower single-thread speed, so these tests will flake. The DoD's `pnpm test` is then not reliably green.
   - The guarantees they protect are structural: the work-unit budget is "sized to run out well before any realistic wall clock" (`src/core/glob.ts` header). The units are deterministic and already exposed: `EVALUATION_FUEL - budget.fuel`, `exhausted`, `limitHits` and `pairsUsed` on `GlobBudget`.

   **Required fix:**
   - In the default suite, assert work units instead of milliseconds: pin an upper bound on the units spent and on `exhausted`/`limitHits` for each of these tests. Where the point is "a hostile input stays bounded", assert that the budget is exhausted, plus a generous sanity ceiling such as 30 s.
   - Move the millisecond assertions into an opt-in perf check: a separate vitest project or file glob that runs only with `GRAFT_PERF=1`, or a `pnpm test:perf` script. It is not part of `pnpm test` or CI.
   - Give the heavy U-PE-32 an explicit per-test timeout, or cut its sizes, so it does not depend on the 5 s default.
   - Record the split in README §7.
2. **minor**, `src/policy/globs.ts` (the NFKC check). **Problem:** the check compares NFKC with the **NFC** form, so a code point whose canonical (NFC) decomposition is a single other character slips through.
   - Examples: the Kelvin sign `K` (U+212A), the Ångström sign U+212B, the Ohm sign U+2126 and the about 1,000 CJK compatibility ideographs such as U+F900.
   - `Keys/**` validates, reads as `Keys/**` and matches neither `keys/a` nor `Keys/a`, with or without `nocase`. I verified this with `globMatcher`. Only the non-ASCII warning flags it, which is the same silent loosening as review 1's major, for a narrow set.

   **Fix:** check each code point: reject when `[...glob].some((ch) => ch.normalize("NFKC") !== ch)`. Precomposed `é`, a lone combining accent and Hangul jamo are all stable on their own, so `café` (both forms) and Korean NFD paths stay valid. Add `Keys/**` and `豈/**` to U-PG-21.
3. **minor**, `src/pilot/gate.ts:64` and `:112-126`. **Problem:** two gaps in the gate decision.
   - **(a) Breadth counts installations asked for, not installations heard from.** `broadEnough` counts `o.installations.length`, which includes an installation with 0 eligible votes. A report for A and B where only A's reviewers voted can still early-FAIL. **Fix:** count installations with at least 1 eligible vote (or at least `minVotesPerInstallation / 4`), and add the zero-vote case to U-GATE-6.
   - **(b) Is a 30% hard block sensible with 6 voters?** Not as a hard block. Six voters average 16.7% each, but review load in real teams is skewed: a tech lead doing 30 to 40% of the reviews is normal in a 6 to 8 person pilot.
     - The block also applies at n ≥ 400, so PASS can become unreachable however many votes come in. The HUMAN-TODO then turns 6 weeks of INSUFFICIENT DATA into "record a FAIL for lack of engagement".
     - It also suppresses the n ≥ 400 point-estimate FAIL, while the early FAIL is not affected. That asymmetry is fail-safe but undocumented.

     **Fix:** keep the 40% warning, and replace the hard block with a leave-one-out check: PASS also requires the same rule (`p̂ ≥ 0.90` and `lower ≥ 0.85`, or `p̂ ≥ 0.90` at n ≥ 400) to hold on the votes without the top voter. Block only when removing that voter changes the conclusion. The report already computes `accuracyWithoutTop`.
4. **minor**, `src/pilot/gate.ts:296-297`. **Problem:** `dataSpanDays` is `floor((last − first) / day)`, so 14 calendar days of voting (Monday 10:00 to the second Sunday 16:00) is a span of 13 and still `window_too_short`. In practice the first PASS can come only at the third weekly review, although the HUMAN-TODO says "no earlier than 2 weeks". **Fix:** count UTC calendar days (`last day − first day + 1`), or say "15 days of votes" in HUMAN-TODO and the report.
5. **minor**, `src/modules/pilot/reviewers.ts:69`. **Problem:** `APPROVED` and `CHANGES_REQUESTED` only. A stale approval dismissed by a push, common with "dismiss stale approvals" branch protection, comes back from `listReviews` as `DISMISSED`. A sync that runs after the dismissal, such as the `pilot sync-reviewers` backfill or an hourly sync, does not store that reviewer. They stay eligible only if an earlier sync caught the approval. **Fix:** accept `DISMISSED` too, since it was a real approval or change request, and add it to I-REV-2.
6. **nit**, `src/policy/globs.ts`. **Problem:** fail-closed side effects of the NFKC rule. Legitimate compatibility characters are now rejected: Korean compatibility jamo (`ㅋㅋ/**`), halfwidth katakana, and superscripts or Roman numerals in file names. That is acceptable, because the author gets a detail 9 error, not a silent miss. The message "mixes writing systems" is misleading for them, though. **Fix:** give the NFKC case its own wording, either detail 9 with a second message or a new detail 10, or document it in `docs/graft-yaml.md`.
7. **nit**, carried from review 1 and skipped by the developer with a note in README §7: Ogham+Runic share the `Other` bucket, and the never-synced marker for `votes_without_reviewer_sync`. Both are acceptable as recorded.

## Coordinator questions, answered

1. **Glob probe:** every case asked about is rejected or accepted as it should be. The exceptions are the NFC-singleton lookalikes (finding 2) and the compatibility-character false positives (finding 6, fail-closed).
2. **Gate logic:**
   - The order is sound, and the rewritten U-GATE-6 keeps the spec's intent: an evidently bad accuracy fails before N_min, given 6 voters and 2 pilots.
   - The breadth test should count pilots that actually voted (finding 3a).
   - The 30% block is too blunt for 6-voter teams; use leave-one-out (finding 3b).
3. **Timing tests:** yes, they are a CI flakiness risk, and they flaked in this review's own DoD run. Major (finding 1): assert work units in the default suite and keep milliseconds as an opt-in perf check.
4. **DoD and mutations:** everything passes except `pnpm test`, which fails only on the two timing tests. All 31 mutations are killed.
