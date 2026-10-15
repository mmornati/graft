# Step 5 review 4: Policy engine, report-only

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted step 5 diff after the fixes for review 3, judged against the spec, the Phase 0 constraints and reviews 1 to 3.

## What was checked

- **DoD chain.**
  - `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test` (57 files, 639 tests, all pass), `build` and `eval:ci` (exit 0, baseline equal).
  - `graft policy schema --check` exits 0, `graft policy check docs/examples/graft.yaml` exits 0 and `graft policy check test/fixtures/policy/alias-bomb.yaml` exits 1.
  - `db:migrate`, `db:status`, `db:rollback` (only 0005 rolls back) and `db:migrate` all pass.
  - The three greps are clean, and the ID grep returns 89 lines.
- **Mutations.** All 16 spec mutations are killed (same tests as review 3). Of the `onLimit` mutations:
  - M17b (`sensitive_paths` `onLimit: false`) is killed by U-PE-25 and U-PG-12.
  - M17a (`paths` `onLimit: false`) and M18 (`only_paths` `onLimit: true`) survive, as the developer says. See nit 3 for my judgement.

  My extra mutations:

  | Mutation | Result |
  | --- | --- |
  | An exhausted budget makes a tightening `paths` key not match | Killed by U-PE-27, U-PE-29, U-PG-12 and U-PG-14 |
  | `mayChangePolicy` ignores the budgets | Killed by U-PE-28 (review 3 nit 5 resolved) |
  | The floor ignores exhaustion | Killed by U-RISK-21 and U-PG-14 |
  | A limit-only hit reported as certain | Killed by U-PE-29 |
  | Pair cap removed | **Survives** |
  | Misses for code units above 255 not charged | **Survives** |
  | Wall-clock guard disabled | Survives (expected for a bug guard) |

  Every file was restored byte for byte.
- **Review 3 finding 1 is fixed.** The policy and floor share one budget per job. Measured on 1,000 renamed files with 1,024-character paths:

  | Shape | Floor | Evaluation | Result |
  | --- | --- | --- | --- |
  | Literal | 410 ms | 64 ms | strict |
  | 44-entry class | 367 ms | 68 ms | strict |
  | Class with `**` | 371 ms | 71 ms | strict |
  | Classes over code units above 255 (`[Ā-ſ]`, 173 rules) | 838 ms | 85 ms | strict |

  Round 3's 36 s is down to under 1 s. Every run ends `would_block` with `budget_exhausted`, which is the strict side.
- **Review 3 finding 2 (the wall clock is only a backstop).**
  - It is checked on the shared `since` counter every 16,384 units.
  - It is set to 10 s, and `bootstrap.ts` logs through `setGlobBackstopHook`.
  - The fuel binds first in every case I tried, so verdicts do not depend on load.
  - The floor has its own `glob_budget` reason (review 3 nit 3).
  - Limit-only hits are uncertain (review 3 nit 4).
- **Shared budget in the pending-card path.** Confirmed. `policy/job.ts:184-196` builds one `GlobBudget` and passes it to `buildFacts`, whose `computeRiskFloor` uses it, and then to `evaluatePolicy`. The intent job's floor and `diff.ts` grouping use their own budgets, which is fine because that is a separate job.
- **Memory across jobs.**
  - The `prepared` path cache lives on the per-job `GlobBudget`, holds at most 5,000 entries and is collected with the job.
  - The compiled-matcher caches are cleared when they pass 200 keys.
  - The memo for code units above 255 is capped at 4,096 entries per compiled class, and every miss is charged.
  - I ran 12 successive jobs with a 112-rule, 50-`sensitive_paths` policy built from CJK-range classes, each job against 1,000 new paths that cycle through the whole CJK block. The retained heap stayed at 3.9 MB (see nit 2 for the theoretical bound).

## Findings

### 1. Major: ordinary large PRs within the spec's limits run out of the budget, which produces false requirements and false blocks

`src/core/glob.ts:36-40` (`EVALUATION_FUEL`, `EVALUATION_PAIRS`) and `src/core/glob.ts` `build` (`shared.pairs--`).

**Problem.** The 250,000-pair cap counts every (glob × path) comparison, including cheap ones. That is far below what legitimate inputs inside the spec's limits need. The spec allows 500 globs, 1,000 listed files, and `previousPath` for renames. When the budget runs out, every remaining tightening `paths` rule is assumed to match. That is strict, but it reports requirements and blocks that do not apply. Measured, with no network:

- **The shipped `docs/examples/graft.yaml`.** An agent PR of 1,000 renamed `src/module*/file*.ts` files, with the card pending (the floor and the policy share the budget), gives `would_block`, `blockedBy [5]` ("no-agent-secrets") and `limits: ["budget_exhausted"]`. No file is anywhere near `secrets/`. With 400 renames, or 1,000 modified files without renames, the verdict is correct.
- **A realistic policy, card final (no floor in the job).** A policy with 41 rules (130 ordinary globs such as `area3/part1/**`) and 10 `sensitive_paths`, against 1,000 renamed files, gives `budget_exhausted`, with 2 unrelated team rules added as uncertain requirements. With 61 rules (190 globs), 22 unrelated rules are added. If a `paths` block rule came after the cut-off, the verdict would be `would_block`.
- **The largest legitimate policy.** 161 rules and 491 ordinary globs against 1,000 renamed files need **982,000 pairs and 16.7 M fuel** for `evaluatePolicy` alone (measured with an unlimited budget). The pending-card floor adds about 1.5 M fuel and about 140,000 pairs.

So "the budget is sized to run out well before any realistic input" does not hold. In Phase 0 this puts false "Would block" and "Would require … from `@team`" verdicts on real PRs, and pilots compare those with what actually happened. In Phase 1 it would be enforcement.

**Required fix.**
- Size the limits so that the spec maxima fit with margin: 500 globs × 1,000 files × 2 paths, plus the floor's built-in globs. For example, about 1.5 M pairs and about 40 M fuel. Then re-measure the crafted worst cases; the class-heavy and high-code-unit shapes should still finish within about 1 to 2 s.
- Alternatively, drop the pair cap and let the fuel, which already charges per pair, be the only work limit.
- Add a test: the largest valid policy of ordinary globs (about 500 globs), against 1,000 renamed files with the card pending, gives no `limits` and the true verdict. Also add a test that pins the pair cap; removing it currently survives.

### 2. Nit: the memo for code units above 255 has no global bound

`src/core/glob.ts` (`inSet`, `set.more.size < 4_096`). Memory is bounded only by (cached matchers ≤ 201) × (classes per matcher) × 4,096 entries. A 500-glob, class-heavy policy can, in theory, reach tens of millions of entries over many jobs. Each new entry costs at least 4 units, so one job adds at most about 5 M. My 12-job run stayed flat, so this is not a finding in practice. Still, a single global entry cap (or clearing the memos together with `coreCache`) would make the bound obvious. Also pin the miss charge: removing `spend(b, set.ranges.length * 4)` survives the suite.

### 3. Nit: M18 is equivalent; M17a is equivalent only for the verdict

- **M18** (`only_paths` `onLimit: true`) is a true equivalent mutant. Any limit increments `limitHits`, and `only_paths` returns `null` when `limitHits` grew or the budget is spent, whatever `onLimit` answered.
- **M17a** (`paths` `onLimit: false`) gives the same outcome and the same `uncertain` flag, because any limit hit makes a tightening `paths` key match as uncertain. But the reason's `paths` and `count` differ: the over-limit file drops out of the list, so the rendered "paths match … and K more" changes. It is safe to leave, but either:
  - assert the reason's `count` in U-PE-25 or U-PE-29 so that it is killed; or
  - note in README §7 that it is equivalent for the verdict only.

### 4. Nit: the wall-clock guard starts before the job's database reads

`src/modules/policy/job.ts:184`. `new GlobBudget()` stamps its 10 s deadline before `await latestPublishedCard(...)` and `await getChangeProvenance(...)`. A slow database eats into the guard. That is harmless at 10 s, but create the budget after the awaits.

## Areas found correct

- **The cost model.**
  - Each path is split and folded once per job and charged by length.
  - Classes are compiled to 256-entry tables with case folding applied.
  - Every inner step costs 1 unit, and the DP cells are charged.
  - Fuel binds before the wall clock in every shape I tried, so verdicts are deterministic.
- **A spent budget is always strict.** Every call site answers the strict side when the budget is spent or a path is over the limits:
  - `paths` is uncertain;
  - `sensitive_paths` raises the risk;
  - `only_paths` and approve rules do not match;
  - the policy-file globs have their own budget and never fake a `graft.yaml` change, while `mayChangePolicy` blocks approval;
  - the floor adds `glob_budget`, and the `diff.ts` grouping puts every file in group 0.
- **The rest.** Trust boundary, parser safety, output safety, ordering, migration, storage and redaction are unchanged and still correct.
