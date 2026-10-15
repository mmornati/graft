# Step 5 review 5: Policy engine, report-only

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted step 5 diff after the fixes for review 4, judged against the spec, the Phase 0 constraints and reviews 1 to 4.

## What was checked

- **DoD chain.**
  - `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test` (57 files, 642 tests, all pass), `build` and `eval:ci` (exit 0, baseline equal).
  - `graft policy schema --check` exits 0, `graft policy check docs/examples/graft.yaml` exits 0 and `graft policy check test/fixtures/policy/alias-bomb.yaml` exits 1.
  - `db:migrate`, `db:status`, `db:rollback` (only 0005 rolls back) and `db:migrate` all pass.
  - The three greps are clean, and the ID grep returns 91 lines.
- **Mutations.** All 16 spec mutations are killed (same tests as before). The budget mutations:

  | Mutation | Result |
  | --- | --- |
  | M17a (`paths` with `onLimit: false`) | Killed by U-PE-29 |
  | M17b (`sensitive_paths` with `onLimit: false`) | Killed by U-PE-25 and U-PG-12 |
  | `mayChangePolicy` ignores the budgets | Killed by U-PE-28 |
  | The floor ignores exhaustion | Killed by U-RISK-21 |
  | Misses for code units above 255 not charged | Killed by U-PG-17 (review 4 nit 2 resolved) |
  | `EVALUATION_FUEL` halved | Killed by U-PE-30 |
  | M18 (`only_paths` with `onLimit: true`) | Survives |

  M18 is a true equivalent mutant: any limit hit already makes `only_paths` not match. It is documented in README §7 (line 380), and I accept it. Every file was restored byte for byte.
- **Review 4 reproductions, re-run.**
  - The shipped example policy, an agent PR of 1,000 renames and a pending card no longer gives `would_block`.
  - The 41- and 61-rule policies with 1,000 renames of 4-segment paths and a final card no longer hit a limit.
- **Hostile shapes against the new fuel.** Measured on 1,000 renamed files with 1,024-character paths, with the floor and the policy sharing one budget and the card pending:

  | Shape | Floor + evaluation |
  | --- | --- |
  | Literal | 0.61 s |
  | 44-entry class | 0.67 s |
  | Class with `**` | 0.67 s |
  | Classes over code units above 255 | 1.0 s |
  | `**/a/**/a/**/a/**/x` on 127-segment paths | 0.56 s |

  All end `would_block` with `budget_exhausted`, the strict side. That is a little above the reported ≤ 0.6 s, but acceptable.
- **Review 4 nits.**
  - The global memo cap of 100,000 is added, and U-PG-17 pins the miss charge.
  - M17a is killed and M18 is documented.
  - The budget is created after the database reads.

## Findings

### 1. Major: the 48 M fuel is sized on 4-segment paths, so ordinary policies still exhaust it on realistic deeper paths and give false requirements and false blocks

`src/core/glob.ts:51` (`EVALUATION_FUEL`), `src/core/glob.ts` `matchCompiled` (the full `(parts + 1) × (segments + 1)` table per glob per path), and `test/unit/policy-evaluate.test.ts:817-885` (U-PE-30 derivation).

**Problem.** The cost of one (glob, path) pair is close to proportional to the **number of segments** in the path:
- `matchCompiled` fills the whole DP table for every glob and every path, so `**` parts and `segMatch` are tried at every segment;
- an anchored glob such as `area3/part1/**` costs the same as a floating one, even though its first segment rules out almost every path.

U-PE-30 derived the 1.9× margin from `src/moduleN/dirN/fileN.ts`, which is 4 segments and about 30 characters. Real repositories are deeper. These numbers come from an unlimited budget, 1,000 renamed files and an agent author:

| Policy | Paths | Card | Units used | Share of 48 M |
| --- | --- | --- | --- | --- |
| U-PE-30's shape (161 rules, 483 `areaN/partM/**` + 7 `sensitive_paths`) | 4 segments, 44 chars | pending | 29.5 M | 62 % |
| same | 15 segments, 293 chars | **final** | 67.9 M | **142 %, exhausted** |
| same | 15 segments, 293 chars | pending | 80.0 M | 167 % |
| same | 30 segments, 308 chars | final | 126.5 M | 264 % |
| 161 rules of `**/xN/**` | 15 segments | final | 67.9 M | 142 % |
| 161 rules of `**/*.eN` | 15 segments | final | 48.6 M | 101 % |
| 161 rules of `**/mN/**/*.eN` | 4 segments | pending | 42.9 M | 89 % |
| `docs/examples/graft.yaml` | 60 segments | pending | 42.9 M | 89 % (floor 40.5 M) |

One concrete false block, with an ordinary Java-layout PR and the card **final**:
- **Files:** 1,000 renames of `core/src/main/java/com/acmecorp/platform/moduleN/internal/service/impl/handlers/v2/HandlerNImplementation.java` (14 segments, 110 characters).
- **Policy:** 160 rules of three plain globs (`services/svcN/**`, `**/legacyN/**`, `libs/lN/**`) plus a final `no-agent-secrets` block on `**/secrets/**`.
- **Result:** `would_block`, `blockedBy [161]`, `limits: ["budget_exhausted"]`, and 36 unrelated team rules marked as uncertain requirements. No file is near `secrets/`.
- **Smaller policies:** with 20, 40 or 80 rules the same PR is correct.

So a policy inside the spec's limits (200 rules, 500 globs), on a PR inside the listing limit (1,000 files), still reports "Would block" and unrelated "Would require … from `@team`" for ordinary deep paths. That is review 4 finding 1 again, in a different dimension.

**Judgement on the margin.** Yes, path depth must be part of the derivation; a fixed 1.9× measured on 4-segment paths does not hold. The worst legitimate cost is about globs × paths × parts × segments. At the legal maxima that is 500 × 2,000 × ~4 × up to 128, hundreds of millions of cells. No fuel that also caps hostile input at about 1 s can cover it. The fix has to make ordinary globs cheap rather than raise the fuel.

**Required fix.**
1. **Make the cost of an ordinary glob independent of path depth.** For example, either:
   - match forward over the live states only, stopping when none are left (an anchored literal first part then costs 1 step per path, and `**/x/**` costs about live states × segments with a tiny constant); or
   - add a cheap, charged prefilter: an anchored glob's literal first segment must equal the path's first segment, and each literal non-wildcard segment of the glob must occur among the path's segments (a set lookup per path, built once in `prepare`).
2. **Re-derive `EVALUATION_FUEL`** with segment count as a parameter.
3. **Extend U-PE-30.** Run the same largest-ordinary policy against 1,000 renames at 15 and 30 segments (about 300 characters), with the card both pending and final, and assert no `limits` and the true verdict. Add the Java-layout case above (no `would_block`) as a regression test.
4. **Re-measure the hostile shapes** to confirm they still stay at about 1 s.

### 2. Nit: the hostile timings in README §7 are a little optimistic

The class-over-code-units-above-255 shape takes about 1.0 s per job here (floor 0.92 s), against the reported ≤ 0.6 s. Update the figure when finding 1 is re-measured.

## Areas found correct

- **The pair cap is removed.** Fuel is the only work limit, the DP buffer is reused, and the memo has both a per-class and a global cap.
- **A spent budget is always strict.**
  - `paths` is uncertain;
  - `sensitive_paths` raises the risk;
  - `only_paths` and approve rules do not match;
  - the policy-file globs have their own budget and never fake a `graft.yaml` change, while `mayChangePolicy` blocks approval;
  - the floor adds `glob_budget`.
- **Determinism.** Verdicts are deterministic: the fuel binds before the 10 s guard in every shape tried.
- **The rest.** Trust boundary, parser safety, output safety, ordering, migration, storage and redaction are unchanged and still correct.
