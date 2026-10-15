# Step 5 review 3: Policy engine, report-only

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted step 5 diff after the fixes for review 2, judged against the spec, the Phase 0 constraints and reviews 1 and 2.

## What was checked

- **DoD chain.**
  - `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test` (57 files, 633 tests, all pass), `build` and `eval:ci` (exit 0, baseline equal).
  - `graft policy schema --check` exits 0, `graft policy check docs/examples/graft.yaml` exits 0 and `graft policy check test/fixtures/policy/alias-bomb.yaml` exits 1.
  - `db:migrate`, `db:status`, `db:rollback` (only 0005 rolls back) and `db:migrate` all pass.
  - The three greps are clean, and the ID grep returns 87 lines.
- **All 18 mutations were killed.**
  - M1: I-POL-3 and I-POLH-2;
  - M2: U-PE-4 and U-PE-15;
  - M3: U-PE-9 and I-POL-10;
  - M4: U-PE-5, U-PE-8 and U-PE-10;
  - M5: U-PE-14 and U-PE-17;
  - M6: U-PY-3 and U-PY-4;
  - M7: U-PS-3;
  - M8: U-PE-7 and I-POL-21;
  - M9: U-PE-6 and U-PE-21;
  - M10: I-POLH-1;
  - M11: I-POL-16;
  - M12: U-PR-4 and I-POL-18;
  - M13: I-POL-11;
  - M14: I-POL-12;
  - M15: U-FACT-1;
  - M16: U-RED-12;
  - M17 and M18: U-PE-25.
- **Three extra mutations on the new budget code.**
  - "An exhausted budget makes a tightening `paths` key not match" is killed by U-PE-27 and U-PG-12.
  - "The floor ignores an exhausted budget" is killed by U-RISK-21.
  - "`mayChangePolicy` ignores `budget.exhausted` and `policyBudget.exhausted`" **survives** (nit 5).

  Every file was restored byte for byte.
- **Review 2 fixes.**
  - Finding 2 is fixed: the validator rejects `/` inside brackets (detail 6).
  - Finding 3 is fixed: U-PE-25 kills M17 and M18.
  - Finding 4 is fixed: R8 and R9 use a strict-side matcher (U-RISK-20).
  - Finding 6 is fixed: `path_too_long` is separate from a policy-file match (U-PE-26).
  - The cost cap (detail 8) holds: 48 non-star characters per segment and 96 per glob.
- **A spent budget never loosens.** I traced every call site:
  - In the evaluator, a tightening `paths` key answers "matched, uncertain", `sensitive_paths` raises the risk, and `only_paths` and approve rules answer "no match".
  - The policy-file globs have their own budget and `onLimit: false`. So neither a spent budget nor an over-long path can fake a `graft.yaml` change. `mayChangePolicy` still overrides approve rules in both cases.
  - In the floor, R1 to R7 and the strict R8 and R9 answer `true`, and a spent budget adds `listing_truncated` (sensitive). In `diff.ts`, the shared budget puts every file into group 0.

  I found no path where exhaustion loosens a verdict.

## Findings

### 1. Major: the evaluation budget does not bound time, and the 3 s backstop never fires for cheap calls

`src/core/glob.ts:177-197` (`spend`), `src/core/glob.ts:206-211` (`oneMatches`, `set`), `src/core/glob.ts:299-307`.

**Problem.** Two defects together leave a crafted policy able to block the worker for half a minute per job, against a stated bound of about 0.5 s (fuel) or 3 s (wall clock).

1. **Fuel does not track time.**
   - One unit is charged per segment step, but in case-insensitive mode a `set` token runs `ranges.some` up to four times (original, `toLowerCase()`, `toUpperCase()`, folded) and allocates two strings each time. So a 44-entry class costs about 60× a literal for the same 1 unit.
   - `foldString` over the whole path on every call is charged only `path.length >> 4`.
2. **The wall-clock backstop is checked only when one call's own `ticks` reach 4,096.** A call that spends fewer units, which is typical, never looks at the shared deadline. That deadline is the 3 s `EVALUATION_WALL_MS`.

Measured, with no network. Each glob passes `validateGlob` and the cost cap, and the facts are 1,000 renamed files with 1,024-character `path` and `previousPath`:

| Policy (≤ 32,768 bytes, `policy check` OK) | `evaluatePolicy` | `computeRiskFloor` (same globs as `sensitive_paths`) |
| --- | --- | --- |
| 197 rules of `*a{46}b*/**/*a{46}x*`, 20 `sensitive_paths` (the U-PG-12 shape) | **0.52 s**, `budget_exhausted` | 0.87 s, `listing_truncated` |
| 200 rules of `*[bcd…J]x*` (one 44-entry class), 20 `sensitive_paths` | **32.1 s**, `budget_exhausted` | **5.4 s**, budget not exhausted, backstop not fired |
| 194 rules of `**/*[class]*/**/*[class]x*` | **30.0 s** | **5.4 s** |

When the card is still pending, the policy job runs `evaluatePolicy` and `buildFacts`'s `computeRiskFloor` back to back. That blocks one worker's event loop for about **36 s** per evaluation. The intent job adds about 5 s more (floor plus `diff.ts` grouping). A push fires several evaluations, and a fan-out repeats it for every open PR whose paths the attacker controls. The verdicts stay strict. But the claim that the worst 32 KB policy against 1,000 maximum-length files finishes in about 0.5 s holds only for the literal shape, and the stated 3 s bound does not hold.

**Required fix.**
- **Make fuel follow cost.** Charge a `set` token by its number of ranges, times 4 in case-insensitive mode (or precompute a folded class once, at compile time). Charge the whole path for `foldString`, or fold once per evaluation and cache by path.
- **Make the backstop real.** Check the shared deadline on a counter that lives in the shared `GlobBudget`, not on per-call `ticks`, or check it at the entry of every call.
- **Test it.** Add a U-PG-12 variant with the class-heavy shape above, asserting that `evaluatePolicy` and `computeRiskFloor` each finish within about 1 s and stay strict.

### 2. Minor: once finding 1 is fixed, the wall clock must remain a backstop that ordinary hostile input never reaches

`src/core/glob.ts:36-38`.

**Judgement on the 3 s backstop.** It cannot loosen a verdict: it sets `exhausted`, and every caller then answers the strict side. But where it fires depends on load. Two runs of the same input on a busy worker or a slow CI machine can then stop at different points. The result is a different `matched` list, different `uncertain` flags and a different `facts_hash`, so the check and comment are republished.
- **Today** it cannot fire at all (finding 1).
- **With only the deadline fixed**, the class-heavy policy above would reach the wall clock on every machine before the fuel. That would make wall-clock nondeterminism the normal path for hostile input.
- **On a 4× slower CI**, U-PG-12 (0.5 s locally, limit 2 s) is close to its own timing assertion.

**Fix.** After the fuel follows cost (finding 1), size `EVALUATION_FUEL` so that the worst accepted policy runs out of fuel in well under 1 s on a slow machine. Keep 3 s only as a guard against bugs. Add one test: a policy that hits the fuel gives a deep-equal verdict when the wall-clock limit is set very high and very low (only possible once fuel binds first).

### 3. Nit: reusing `listing_truncated` for a spent floor budget is acceptable but mislabelled

`src/modules/intent/risk-floor.ts:419`. The strict effect is right: the floor goes to sensitive. Reusing an existing rule id also avoids touching stored card reasons and the eval metrics. But the intent card then tells reviewers the file listing was truncated when it was not, and the step 4 metrics count it as a truncation. Either add a distinct id (`glob_budget`) or at least a distinct rendered text, and record the choice in README §7.

### 4. Nit: a per-call fuel or path-limit hit is shown as a certain match

`src/policy/evaluate.ts` (the `paths` key).
- A path over the caps is recorded in `limits: path_too_long`, but its reason in the rule is still `uncertain: false` and lists the path as matching.
- A per-call `MATCH_FUEL` hit (as opposed to the shared budget) sets neither `exhausted` nor `limits`, so it reads as a real match.

Both are strict. Mark these reasons `uncertain` so reviewers can tell an assumed match from a real one.

### 5. Nit: no test pins `policyBudget.exhausted` and `budget.exhausted` in `mayChangePolicy`

`src/policy/evaluate.ts` (`mayChangePolicy`). Removing both terms survives the unit suite. The shared-budget term is belt-and-braces, because the policy-file globs have their own budget. The `policyBudget` term is the only guard if that budget is ever spent. Add a U-PE case that passes a spent policy budget (through a test seam or a tiny-fuel option) and asserts that an approve rule is overridden.

## Areas found correct

- **Cost cap and validator.** Detail 8 and the `/`-in-brackets rejection work. With the cap, the literal-heavy worst case dropped from about 6 minutes (review 2) to 0.52 s.
- **Determinism for ordinary inputs.** Fuel decides, and U-PG-13 checks that two runs of the same input deep-equal.
- **Rendering.** `path_too_long` and `budget_exhausted` render separately (U-PR-10), and the `graft.yaml` note is no longer shown for a long path.
- **Unchanged since earlier rounds.** Trust boundary, parser safety, output safety, ordering, migration, storage and redaction are all still correct.
