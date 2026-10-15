# Step 6 review 3: Pilots and gate

Verdict: APPROVED

Reviewer: senior engineer (Opus). Scope: the uncommitted step 6 diff after the fixes for [review 2](step-6-review-2.md), plus the coordinator's questions:
1. M23 and the other mutations;
2. no millisecond assertion left outside `expectDuration`;
3. leave-one-out and the window rule, checked by hand;
4. the per-code-point NFKC check;
5. the DoD chain and `pnpm test:perf`.

Review 2's major (the wall-clock tests) is fixed. No blocker or major remains. The open points below are minors and nits.

## What was checked

- **DoD chain.**
  - `lint`, `typecheck`, `build`, `eval:ci` (exit 0; its run directory was removed), `graft policy schema --check`, the example and the three starter files (exit 0) and `alias-bomb.yaml` (exit 1) all pass.
  - `db:migrate`, `db:rollback` (only 0006), `db:status` and `db:migrate` all pass on the empty dev database.
  - The greps are clean, the ID grep returns 65 lines and `app-manifest.json` is unchanged.
- **`pnpm test` twice under CPU load.** I ran 8 busy loops on 10 cores (load average 11 to 13). Both runs were green: **746 of 746**, exit 0.
- **`pnpm test:perf`** (load 4.6, the other containers still running): 557 of 557 unit tests, exit 0.
- **Millisecond assertions.**
  - Grepping `performance.now`, `Date.now` and `hrtime` under `test/` finds no assertion on a duration outside `expectDuration` (`test/helpers/perf.ts`). The limit is enforced only with `GRAFT_PERF=1`; otherwise a 30 s ceiling applies.
  - The remaining `Date.now()` uses are deadlines in the wait helpers, fake token expiry, and I-LOCK-1's ordering of start and end times, which compares timestamps and has no bound.
  - U-PG-8, U-PG-12, U-PG-14, U-PE-30 and U-PE-32 now assert units or limits in the default suite: `fuel`, `limitHits`, `exhausted` and `budget_exhausted`. The unit project timeout is 120 s, and `test:perf` is not in CI.
- **Mutations.** 39 mutations were applied in turn, with `src/` diffed byte-for-byte against a tarball afterwards. **All are killed except M23 at site 1** (see M23 below). In addition to the 21 spec mutations:

  | Mutation | Killed by |
  | --- | --- |
  | Invisible-character check, orphan-mark check, or NFKC check removed | U-PG-21 (and U-CFG-31) |
  | NFKC check back to the NFC-form comparison of review 2 | U-PG-21 |
  | Repository pairing removed | I-GATE-4 |
  | Leave-one-out removed | U-GATE-6 (dominant voter) |
  | Breadth counts every installation asked for | U-GATE-6 (breadth) |
  | Breadth guard removed | U-GATE-6 |
  | Window from `--since` | I-GATE-1 (data span) |
  | `+ 1` dropped from the window rule | U-GATE-5 |
  | Span floored again | I-GATE-1 |
  | All review states counted | I-REV-2 |
  | `DISMISSED` no longer counted | I-REV-2 |
  | Culprit validation removed | "a framed culprit is dropped" |
  | Rename lookup removed | U-GATE-2 |
- **M23** (`src/core/glob.ts`, the two `if (nextN === 0) return false;`):
  - **Both removed** (the Step 5 review 6/7 definition of M23): killed by U-PG-18.
  - **Site 2 alone** (line 697, the segment-level NFA): killed by U-PG-18.
  - **Site 1 alone** (line 522, `segMatchNfa`, the character-level NFA for class segments): survives the whole unit suite. I checked it against a worktree of the Step 5 commit (`HEAD`), and **it survives there too** (504 of 504).

  So this is **not a regression**. The Step 5 claim was about removing both, and that is still killed. The site-1 gap predates step 6 (finding 2).
- **Leave-one-out, by hand** (`decideGate`, coverage 100%, 8 voters, 2 × 75 votes, span 20). Wilson lower bounds used below: 141/150 → 0.8899, 138/150 → 0.8654, 116/126 → 0.8601.
  - 141/150, top voter 46 votes (44 up): **PASS**. The old 30% rule blocked this.
  - 141/150, top voter 60 votes, all up: without the top voter 81/90 = 0.900, lower 0.821, so **INSUFFICIENT DATA** (`dominant_voter`). This is the intended case.
  - 141/150, top voter 60 votes (52 up, the critic): **PASS**. Removing the critic only helps.
  - 362/400, top voter 130 votes (120 up): without the top voter 0.896 on 270 votes, so **INSUFFICIENT DATA**.
  - 362/400, top voter 40 votes: **PASS** (`point_estimate_decides`).
  - 358/400: **FAIL** (`point_estimate_decides`).
  - 137/150, top voter 25 votes (17%), 23 up: without the top voter 114/125 = 0.912, lower **0.8493**, so **INSUFFICIENT DATA** with the reason `dominant_voter`. See finding 1.
- **Breadth and window, by hand.**
  - 40/50 with 6 voters and installation votes 50/0: **INSUFFICIENT DATA**. The silent pilot no longer counts toward breadth.
  - The same with 25/25: **FAIL** (`upper_below_target`).
  - A span of 12.99 days is `window_too_short`; a span of 13.00 days passes (`span + 1 ≥ 14`, as documented).
- **NFKC per code point** (`validateGlob`).
  - Rejected with detail 10:
    - the Kelvin sign (`Keys/**`, my review-2 case), Ångström, Ohm and CJK compatibility U+F900;
    - Greek oxia U+1F71 and the combining mark U+0340;
    - `ﬁ`, fullwidth, mathematical bold, superscript `²` and long `ſ`.
  - Rejected with detail 9: Latin+Cyrillic.
  - Rejected with detail 2: CGJ, VS16, tag characters, the Hangul filler, the Braille blank and orphan marks.
  - Still valid:
    - `café` (precomposed and NFD) and Vietnamese (precomposed and NFD);
    - Cyrillic, Katakana+Han, Hangul+Latin, NFD Hangul, Han+Latin, Hindi, Thai, Arabic and Greek;
    - German `ß`, Turkish `ı`/`ş`, Polish and plain ASCII.

## Findings

1. **minor**, `src/pilot/gate.ts:116-140`. **Problem:** leave-one-out reruns the full PASS rule on a smaller sample, so it also fails borderline passes where nobody dominates.
   - The Wilson interval widens as n shrinks. In the 137/150 case above, a top voter with 17% of the votes who agrees with everyone else (23/25 against 114/125) drops the lower bound from about 0.857 to 0.8493. The verdict becomes INSUFFICIENT DATA with the reason `dominant_voter`.
   - The direction is fail-safe, but the reason is misleading, and the effective PASS bar near the boundary is stricter than §8.1.6.

   **Fix (optional):** any of these would do:
   - for the leave-one-out side, compare only the point estimate (`p̂ without the top voter ≥ 0.90`);
   - apply leave-one-out only when the top voter's share exceeds the 40% warning level;
   - rename the reason to something like `sensitive_to_top_voter`, and say in the report that removing one voter's votes widens the interval.
2. **minor**, `src/core/glob.ts:522` and `test/unit/policy-parse.test.ts` (U-PG-18). **Problem:** M23 at site 1 survives, both here and at the Step 5 commit.
   - `segMatchNfa` charges one unit per character iteration, so without the early exit a class segment that dies at its first character keeps charging to the end of the segment. That costs more units and more time, but returns the same answer.
   - No test pins the cost of such a call. This is a performance-mutation gap, not a correctness one, and it is not a regression from step 6.

   **Fix (optional):** extend U-PG-18 with a class glob such as `**/[ab]x*` against a single 1,000-character segment starting with `c`. Assert that the call costs a small constant plus the prepare, so that removing either early exit fails.
3. **nit**, `src/pilot/gate.ts:311-314`. **Problem:** the span is rounded to 2 decimals before the `span + 1 ≥ 14` test, so a 12.995-day span counts as 13. The rule also measures the elapsed time between the first and last vote, not calendar days. Both are harmless and documented, though "14 days of voting" in HUMAN-TODO means "13 × 24 h between the first and last vote". **Fix (optional):** compare the unrounded span, or say "13 days between the first and last vote" in HUMAN-TODO.

## Coordinator questions, answered

1. **M23:** removing both early exits, which is the Step 5 definition, is still killed by U-PG-18. Removing only the character-level exit survives now and also at the Step 5 commit, so it is not a regression (finding 2). The other 38 mutations are killed.
2. **Millisecond assertions:** none remain outside `expectDuration`. `pnpm test` passed twice at load 11 to 13 (746 of 746).
3. **Leave-one-out and window:** they behave as designed in every case above. The one quirk is the small-sample tightening (finding 1). The window rule matches its documentation.
4. **NFKC per code point:** the Kelvin `Keys/**` case and the other compatibility characters are rejected with detail 10. Every legitimate path probed stays valid.
5. **DoD chain:** green. `pnpm test:perf` passes.
