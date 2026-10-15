# Step 5 review 6: Policy engine, report-only

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted step 5 diff with the rewritten matcher (a forward live-state NFA plus prefilters) and fuel of 60 M, judged against the spec, the Phase 0 constraints and reviews 1 to 5.

## What was checked

- **DoD chain.**
  - `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test` (57 files, 645 tests, all pass), `build` and `eval:ci` (exit 0, baseline equal).
  - `graft policy schema --check` exits 0, `graft policy check docs/examples/graft.yaml` exits 0 and `graft policy check test/fixtures/policy/alias-bomb.yaml` exits 1.
  - `db:migrate`, `db:status`, `db:rollback` (only 0005 rolls back) and `db:migrate` all pass.
  - The three greps are clean, and the ID grep returns 93 lines.
- **Mutations.** All 16 spec mutations are killed (same tests as before), and so are M17a (U-PE-29) and M17b (U-PE-25, U-PG-12). M18 and M23 survive (see nit 3). My extra mutations:

  | Mutation | Result |
  | --- | --- |
  | `mayChangePolicy` ignores the budgets | Killed by U-PE-28 |
  | The floor ignores exhaustion | Killed by U-RISK-21 |
  | Misses for code units above 255 not charged | Killed by U-PG-17 |
  | The `reqLits` prefilter applied to anchored globs | Killed by U-PG-18 |
  | Suffix prefilter always case-sensitive | Killed by many tests (U-CLI-1, U-HAR-4, U-SYN-4 and others) |
  | `reqRuns` against the unfolded path | Killed by many tests |
  | `minSegs` off by one | Killed by many tests |

  Every file was restored byte for byte.
- **(1) Depth reproductions, under the default budget.** Five policy shapes, each with 161 rules and 483 globs plus `sensitive_paths`: anchored `areaN/partM/**`, floating `**/xN/**`, `**/*.eN`, mixed `**/mN/**/*.eN`, and the shipped example. Paths were 1,000 renames at 4, 15, 30 and 60 segments (49 to 363 characters), plus the review 5 Java layout, with the card both pending and final.
  - The worst fuel use is 29 % (`**/*.eN` at 60 segments, pending).
  - The worst time is 0.31 s.
  - No run hits a limit, and the Java case is `would_require`, not `would_block`.
  - Realistic multi-star globs (up to 480 of `**/*serv*/**/*impl*` and similar, on Java paths) use at most 20 % of the fuel.
  - Only crafted shapes exhaust the fuel: every path segment built to satisfy every literal run, or all-`?` globs. Those end on the strict side within 0.5 to 0.8 s.

  Review 5 finding 1 is resolved.
- **(2) Prefilter soundness.** I ran a targeted differential against picomatch: 2 × 40,000 generated globs, about 3.8 M comparisons, in both case modes, both with and without a shared budget. The generator covered:
  - literal-heavy pieces that exercise `reqLits`, `reqRuns`, `suffix` and `minSegs`;
  - case-folding characters (`ß`, `K`, `ı`, `É`) and mixed-case literals;
  - classes holding the "literal" character (`[s]`, `[.]`, `[*]`, `[A-b]`, `[é-ü]`);
  - `?`, `**` inside longer segments (`a**b`, `x**`, `**x`), leading `./`, trailing `/**` and `a*/**`;
  - paths up to 30 segments deep, including `[`, `]`, `*` and `?` as literal path characters.

  **No prefilter wrongly rejected a path.** Every place where the new matcher says "no match" and picomatch says "match" comes from the matcher's own segment semantics (finding 2), not from a prefilter. The prefilters are necessary conditions, computed on the same folded form `segMatch` uses.
- **(3) Hostile coverage.** The changed fixtures (`*a…ab?x*` against paths containing `a…ab`) still defeat every prefilter: the run is present, and there is no literal tail or literal-only segment. My own prefilter-defeating shapes, with the floor and policy sharing one budget against 1,000 maximum-length renames, end `would_block` with `budget_exhausted`:

  | Shape | Time |
  | --- | --- |
  | 44-entry class | 0.56 s |
  | Classes over code units above 255 | 0.79 s |
  | `**/*m*N*/**/*h*N*` on 120-segment paths built to contain `m` and `h` | 0.51 s |
  | `**/*?*?*/**/?*?*?/**/*x?*` | 0.51 s |

## Findings

### 1. Blocker: the NFA's stamp clock overflows `Int32`, after which every glob matches nothing until the process restarts

`src/core/glob.ts:459-463` (`stampA`/`stampB` are `Int32Array`, `stampClock` is a JS number) and `src/core/glob.ts:512,533,546,548`.

**Problem.** `stampClock` is incremented once per `matchCompiled` call and once per path segment advanced, and it is never reset. Storing it in an `Int32Array` wraps it at 2³¹. From then on, `nextStamp[x] === clock` compares, for example, `-2147483648` against `2147483648`, which is always false:
- the dedup in `add` stops working;
- `nextStamp[P] === clock` (both the absorbing check and the final answer) is false;
- **so every glob returns `false`, without charging any limit or setting `exhausted`.**

Reproduced in one process with no network. I called `globMatcher(["**/*"])` on a 127-segment path 17.5 M times (about 2.2 × 10⁹ stamp ticks, about 125 s of CPU). Before that, `**/secrets/**` on `a/secrets/b.env`, `*.ts` on `src/a.ts` and `infra/**` on `infra/main.tf` all returned `true`. After it, all three return `false`.

Every matcher shares this module state: `sensitive_paths`, `paths` and block rules, the floor's R1 to R7 and R8/R9, and the `graft.yaml` globs. A long-lived worker therefore silently stops detecting sensitive paths, secrets, CI and policy-file changes. That loosens both the intent floor and the policy verdict, and nothing logs it. One max-cost job advances the clock by up to tens of millions, so a few dozen hostile jobs reach the wrap, and ordinary traffic gets there over weeks.

**Required fix.**
- When `stampClock` approaches 2³¹ − 1, clear both stamp arrays (`fill(0)`) and restart the clock at 1. Alternatively, use per-call epochs that cannot overflow (for example, reset the stamps for the `P + 1` positions at the start of each call).
- Assert that `P + 1 ≤ 128`, or size the arrays from the largest compiled glob.
- Add a test seam that sets the clock just below 2³¹, then assert that matches (including `**`, absorbing and `docs/**`-style globs) stay correct across the wrap.

### 2. Minor: `**` glued to other characters in an anchored glob with no slash diverges from picomatch on the loosening side, as does a path containing a class's literal text

`src/core/glob.ts` `parseSegment` (`**` inside a segment is treated as `*`) and `src/policy/globs.ts`.

**Problem.** picomatch, the documented semantics (D2) and what step 3's floor used, gives two cases where the new matcher says "no match" and picomatch says "match":
- **`**` glued to other characters.** `/**.ts` normalises to `**.ts` with no slash. picomatch compiles that to "any characters, across `/`, then `.ts`", so it matches `a/b.ts`. The matcher reads it as `*.ts` in one root segment and answers `false`. A tightening glob such as `/**.pem` in `sensitive_paths` or `GRAFT_INTENT_SENSITIVE_PATHS` therefore matches less than it did in step 3. Unanchored `**.ts` agrees, because it normalises to `**/**.ts`.
- **A class's literal text.** picomatch compiles `[ab]` to `(?:\[ab\]|[ab])`, so `*[ab]` also matches a path segment ending in the literal text `[Ab]` (case-insensitive). The matcher does not.

U-PG-7 never generates a leading `/` followed by a `**x` segment, nor paths that contain a class's source text.

**Fix.** Make `validateGlob` reject `**` glued to other characters inside a segment (`glob_invalid` 7, and the same rule for config globs). Either document the bracket-literal case as an intended difference that matches less only for such literal file names, or model it. Add both cases to the differential.

### 3. Nit: M18 is equivalent; M23 is equivalent for the verdict but not for the cost

- **M18** (`only_paths` with `onLimit: true`): any limit makes `only_paths` not match, so this is a true equivalent mutant. Accepted.
- **M23** (removing `if (nextN === 0) return false`): the verdict is the same, because `nextStamp[P] === clock` stays false. But the loop then runs to the last segment with `curN = 0` and charges nothing: up to 127 uncharged iterations per pair, each also advancing `stampClock` (finding 1). I estimate at most about 0.5 s of uncharged work at a million pairs, so the gap between units and time is bounded. It is not equivalent for cost, though.

Either count loop iterations behind a test seam and assert on them in U-PG-18, or record it in README §7 as equivalent for the verdict only.

## Areas found correct

- **The matcher.** The forward live-state NFA with early exit makes an anchored glob cost a constant per path and a floating glob cost about live states × segments. Only work actually done is charged.
- **Prefilters.** They are sound in every case tested: `minSegs`; `reqLits`, used for floating globs only; `reqRuns`; and the literal `suffix`, all computed on the folded form when case-insensitive.
- **Fuel.** 60 M covers the ordinary worst case at depth (≤ 29 %), and hostile shapes still end strict in under 1 s.
- **A spent budget is always strict.**
  - `paths` is uncertain;
  - `sensitive_paths` raises the risk;
  - `only_paths` and approve rules do not match;
  - the policy-file globs have their own budget, while `mayChangePolicy` blocks approval;
  - the floor adds `glob_budget`.
- **The rest.** Trust boundary, parser safety, output safety, ordering, migration, storage and redaction are unchanged and still correct.
