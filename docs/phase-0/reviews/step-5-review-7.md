# Step 5 review 7: Policy engine, report-only

Verdict: APPROVED

Reviewer: senior engineer (Opus). Scope: the uncommitted step 5 diff after the fixes for review 6, judged against the spec, the Phase 0 constraints and reviews 1 to 6. Changes in this round:
- the stamp clock is replaced by 0/1 flags cleared in `finally`;
- a glued `**` is rejected;
- a character-level NFA models picomatch's literal-text alternative for classes;
- every NFA iteration is charged.

## What was checked

- **DoD chain.**
  - `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test` (57 files, 647 tests, all pass), `build` and `eval:ci` (exit 0, baseline equal).
  - `graft policy schema --check` exits 0, `graft policy check docs/examples/graft.yaml` exits 0 and `graft policy check test/fixtures/policy/alias-bomb.yaml` exits 1.
  - `db:migrate`, `db:status`, `db:rollback` (only 0005 rolls back) and `db:migrate` all pass.
  - The three greps are clean, and the ID grep returns 93 lines.
- **Mutations.** All 16 spec mutations are killed (same tests as before), along with:
  - M17a (U-PE-29) and M17b (U-PE-25, U-PG-12);
  - M23, both empty-live-set early exits removed (U-PG-18);
  - my earlier budget mutations (U-PE-28, U-RISK-21, U-PG-17).

  My new mutations this round, all killed:

  | Mutation | Killed by |
  | --- | --- |
  | Flag clearing in `matchCompiled`'s `finally` removed | many unit tests |
  | The class literal-text alternative removed | U-PG-7 and U-PG-20 |
  | The text-alternative rule ignores the body characters | U-PG-7 and U-PG-20 |
  | The glued-`**` rejection removed | U-PG-20 |

  Only M18 survives. It is a true equivalent mutant: any limit makes `only_paths` not match. Every file was restored byte for byte.
- **(1) Review 6 blocker, wraparound.** I re-ran the reproduction in one process: 17.5 M calls of `**/*` on a 127-segment path, the same work that wrapped the old clock. Every 1,000 calls I also interrupted calls on a spent budget at varying fuel (50 to 350 units), in both the segment NFA and the class NFA, then checked `matcherScratchClean()`.
  - After all 17.5 M calls, these still return `true`: `**/secrets/**`, `*.ts`, `infra/**`, `docs/**` on `docs`, and `**/[ab]x/**` on literal `[ab]x`.
  - The control `**/secrets/**` against `a/b/c` stays `false`.
  - No flag was ever left set (0 of 17,500 checks).
  - Both NFAs clear exactly the entries they set, in `finally`, including on `OutOfBudget`. No state survives a call.
  - Re-entrancy is not possible: neither NFA calls back into a matcher, and the only callback during a match is the wall-clock `backstopHook` log line.

  **Fixed.**
- **(2) The character-level NFA for class parts.**
  - **The rule for the text alternative.** I probed picomatch directly on `x[<body>]y` for 63 bodies. These covered every character `validateGlob` allows inside brackets (letters including `Ā`, `ß`, `K` and `ı`, digits, `_ . - * ? @ + = ~ # % ,` and space, at the start, the end and alone) and ranges such as `a-c`, `-a`, `a-`, `é-ü` and `A-b`. Each was tested against the literal text, its upper-cased form, a member character and the literal text under a directory, in both case modes. That gave **0 mismatches**: the rule "present unless the body contains `- * ? + .`" matches picomatch for every body the validator can produce.
  - **Differential.** I ran two seeds of 30,000 generated globs (about 2.6 M comparisons), built mostly from classes and their literal text, both case modes, including code units above 255 (`[Ā-ſ]`, `[Āb]`) and paths up to 20 segments made from class texts.
    - Where the new matcher matches and picomatch does not, the case involves `K`, `ı`, `ſ` or `ß` against `[A-b]`. That is the known case-folding difference, and it errs on the strict side.
    - The only cases where the new matcher does not match and picomatch does are those where the path is exactly the anchored glob's own text (nit 2).
  - **Cost.** Shapes that defeat the prefilters, with the floor and policy sharing one budget against 1,000 maximum-length renames, at the default 60 M:

    | Shape | Time |
    | --- | --- |
    | Text-alternative classes, `**/*[ab]?[ab]*[ab][ab]*/**/…` on paths made of `[ab]` text | 0.76 s |
    | Classes over code units above 255 | 1.04 s |

    Both end `would_block` with `budget_exhausted`. With an unlimited budget those shapes would need 0.8 G units (about 10 s), so the fuel is what bounds them. The cost per unit stays at 12 to 17 ns.
- **(3) Scratch array growth.** The arrays grow only to the largest compiled glob:
  - `growPart(P + 1)`: P is at most the number of segments of a 200-character glob, so at most about 100.
  - `growSeg(nodes.length)`: nodes are at most 1 + tokens + class-text characters, so at most about 400 for a 200-character glob. That is under the initial 512.
  - The arrays are module scratch replaced only to grow. So memory is bounded by the validation caps: under about 4 KB in total. Environment globs (finding 1) are bounded by their 200-character limit too.
- **Earlier reproductions.** These still hold:
  - the five ordinary 161-rule shapes at 4 to 60 segments, and the Java case, stay well within the fuel and give the true verdict;
  - a spent budget is always strict;
  - the policy-file globs have their own budget.

## Findings

### 1. Minor: environment globs are not checked by `validateGlob`, so syntax the new matcher does not model is accepted and silently matches nothing

`src/config/index.ts:54-70` (`globList` for `GRAFT_INTENT_SENSITIVE_PATHS`).

**Problem.** The environment list only checks length, a leading `!` and `..`. Step 3 matched it with picomatch, so an operator may have written `/**.pem`, `@(a|b)/**` or an extglob. The new matcher reads these as literals:
- `/**.pem` against `a/b.pem` gives `false`;
- `@(a|b)/**` against `a/x` gives `false`;
- `secrets/!(x)` against `secrets/y` gives `false`.

The config is still accepted, so the operator's sensitive paths silently stop raising the floor.

**Fix.** Run `validateGlob` on every configured glob in `loadConfig`. Fail at startup with the index and detail, never the value. Note this in README §7 and HUMAN-TODO, where the move to `graft.yaml` is already listed.

### 2. Nit: picomatch's exact-text shortcut is not modelled

picomatch returns `true` when the input equals the glob's own text, before it runs the regex. So anchored `/[0-9]` matches a file literally named `[0-9]`, and `/[s][Ā-ſ]` matches `[s][Ā-ſ]`. The new matcher does not. It only matters for a file named exactly like an anchored glob's text containing a class. Either model it with one string compare after normalising (charged), or record it in README §7 as an intended difference.

### 3. Nit: M18 is accepted as equivalent

As documented in README §7. Nothing to do.

## Areas found correct

- **Matching.** The forward live-state NFA with 0/1 flags cleared in `finally` cannot wrap, go stale or leak across calls or budget interruptions. The class NFA reproduces picomatch's `(?:\[ab\]|[ab])` exactly where picomatch emits it. Prefilters remain sound. Every iteration is charged, and fuel binds before wall-clock time for every shape tried.
- **Validation.** Glued `**` is rejected (detail 7), along with the earlier cost caps (detail 8) and `/` inside brackets.
- **Strict when spent.** A spent budget or an over-long path:
  - makes tightening `paths` keys uncertain matches;
  - raises the risk through `sensitive_paths`;
  - never lets `only_paths` or an approve rule match;
  - never fakes a `graft.yaml` change;
  - adds `glob_budget` to the floor.
- **The rest.** Trust boundary, parser safety, output safety, ordering, migration, storage and redaction are unchanged and still correct.
