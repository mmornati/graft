# Step 5 review 2: Policy engine, report-only

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted step 5 diff after the fixes for review 1, judged against the spec, the Phase 0 constraints and review 1.

## What was checked

- **DoD chain.**
  - `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test` (57 files, 624 tests, all pass), `build` and `eval:ci` (exit 0, baseline equal).
  - `graft policy schema --check` exits 0, `graft policy check docs/examples/graft.yaml` exits 0 and `graft policy check test/fixtures/policy/alias-bomb.yaml` exits 1.
  - `db:migrate`, `db:status`, `db:rollback` (only 0005 rolls back) and `db:migrate` all pass.
  - The three greps are clean, and the ID grep returns 84 lines.
- **Mutation checks.** All 16 spec mutations were killed:
  - M1: I-POL-3 and I-POLH-2;
  - M2: U-PE-4 and U-PE-15;
  - M3: U-PE-9 and I-POL-10;
  - M4: U-PE-5, U-PE-8 and U-PE-10;
  - M5: U-PE-14 and U-PE-17;
  - M6: U-PY-3 and U-PY-4;
  - M7: U-PS-3;
  - M8: U-PE-7 and I-POL-21 (review 1 nit 6 resolved);
  - M9: U-PE-6 and U-PE-21;
  - M10: I-POLH-1;
  - M11: I-POL-16;
  - M12: U-PR-4 and I-POL-18;
  - M13: I-POL-11;
  - M14: I-POL-12;
  - M15: U-FACT-1;
  - M16: U-RED-12.

  I also tried two extra mutations on the new `onLimit` wiring, and both **survived** (see finding 3). Every file was restored byte for byte.
- **Review 1 fixes.**
  - **Finding 1 (glob backtracking).** The round 1 shapes now take ≤ 0.2 ms per call: `**/*a*a*/**/*a*a*`, `**/*a*/**/*a*/**/*a*/**/*a*` and `**/*a*a*a/**/*a*a*a/**/*a*a*a/**/*a*a*a` on 8 to 128 segments. The rest of that finding is open (finding 1 below).
  - **Finding 2 (incomplete listing).** Fixed: an incomplete listing overrides approve rules with the built-in, and U-PE-23/24 cover it, along with a matching `[!NOTE]` in the section.
  - **Finding 3 (redaction).** Fixed:
    - `if password:`, `for token in tokens:`, `class PasswordForm:` and `case "password":` are left alone;
    - `password:`, `- password:` and `password: |` with indented values are still redacted;
    - 1 MB adversarial lines take ≤ 106 ms.
  - **Nits 4 to 7.** Fixed: the CLI checks the size through `lstat`; the `push` fixture now targets `refs/heads/master`, the fixture PR's base; I-POL-21 exists; and `load.ts` throws a `PermanentJobError`.
- **Differential check of the new matcher against picomatch.** My generator was broader than U-PG-7:
  - every punctuation character `validateGlob` allows;
  - class edge cases (`[-a]`, `[a-]`, `[*]`, `[?]`, `[ ]`, `[Z-a]`, `[é-ü]`, `[a/b]`);
  - case-folding edge characters (`ß`, `K` Kelvin, `ı`, `É`);
  - both case modes.

  That came to 770,184 comparisons:
  - In case-insensitive mode, every place where the new matcher says "match" and picomatch does not involves `K`, `ı` or `ß` against a class, which errs on the strict side. That is acceptable.
  - Every place where it says "no match" and picomatch says "match" comes from a `/` inside `[...]` (finding 2).
- **`onLimit` at every call site.**
  - The evaluator: tightening `paths`, `sensitive_paths` and the policy-file globs use `true`, and `only_paths` uses `false`. Correct.
  - The floor's R1 to R7 use `true`. Correct.
  - Test, docs, lockfile and generated classification use `false`. Those are not safety rules, except R8 and R9 (finding 4).

## Findings

### 1. Major: there is no budget per evaluation, so a crafted policy can still stall the worker for minutes per job

`src/policy/evaluate.ts:100,127,214,238`, `src/core/glob.ts:31-33,246-265`, `test/unit/policy-parse.test.ts:726`.

**Problem.** The budget applies per matcher call: 200,000 units or 20 ms. `evaluatePolicy` makes one call per (rule × file × path or previous path), plus the `sensitive_paths` and policy-file calls, and nothing bounds the total. What one call costs depends on the length of the literal between stars times the path length. So a glob such as `*` + 194 × `a` + `b?*`, matched against a 1,024-character path, stays under the fuel and costs about 1.3 ms per call. Measured, with no network:
- **One glob.** That glob against 1,000 paths of 1,024 characters takes **1.3 s**. That fails review 1's "under 1 s" requirement, and U-PG-8 has no long-literal case.
- **Whole evaluation.** I built a valid 32,665-byte policy (`policy check` OK): 132 block rules, each with one such glob, plus 8 such `sensitive_paths`. Facts were renamed files with 1,024-character `path` and `previousPath`.
  - `evaluatePolicy` takes **17.8 s for 50 files and 73 s for 200 files**: linear at about 0.36 s per file.
  - That gives about **6 minutes of synchronous event-loop block for a 1,000-file PR**, per evaluation.
  - `computeRiskFloor` stays small (0.46 s for 200 files).

Each push triggers several evaluations (`pr`, then the `intent_published` and `provenance_published` signals, plus reviews). `expireInSeconds: 120` expires a job that is still running synchronously, and `retryLimit: 5` runs it again. So someone who controls one installed repository's `graft.yaml` can block the shared worker for every tenant for tens of minutes per push, again and again.

I lowered the severity from review 1's blocker for two reasons. This now needs a deliberately crafted policy at the size cap, while realistic globs cost ≤ 0.05 ms per call. And the stall is bounded, not unbounded.

**Required fix.** Bound the work for the whole evaluation, not only for one call. For example:
- create one `Budget` per `evaluatePolicy` (and per `computeRiskFloor`) and pass it to every matcher call;
- once it is spent, answer every remaining tightening key "matched, uncertain" and every approve or `only_paths` key "no match", which keeps the verdict strict.

Alternatively, cap the cost at validation time, for example the total literal length times the number of `**` parts per glob, or the total glob characters per file. Either way:
- add a test where the worst accepted 32 KB policy, against 1,000 renamed files with paths of the maximum length, finishes `evaluatePolicy` in about 1 s and stays strict;
- add the long-literal shape to U-PG-8.

### 2. Minor: a `/` inside a character class silently matches less than the documented semantics

`src/policy/globs.ts:32-46`, `src/core/glob.ts:118-128`.

**Problem.** `validateGlob` accepts `[a/b]`. picomatch, whose semantics the header comment and §6.2 promise, treats it as a class. The new matcher splits the glob at `/` first, so `[a` and `b]` become literal segments. For example, `sensitive_paths: ["secrets/[a/b]"]` no longer matches `secrets/a`. A tightening glob that matches less is a silent loosening. It was the only loosening divergence in the differential run. U-PG-7 cannot find it, because its pieces never put `/` inside brackets. Its corpus also leaves out the allowed punctuation `@+=~#%,`, space, and the case-folding edge characters.

**Fix.** Reject a `/` inside `[...]` (`glob_invalid`, detail 6 or 7), say so in `docs/graft-yaml.md`, and widen the U-PG-7 corpus with the pieces listed above.

### 3. Minor: no evaluator test pins which side `onLimit` answers

`src/policy/evaluate.ts:127,139,214`.

**Problem.** Two extra mutations survive the whole unit suite:
- `paths`/`sensitive_paths` with `onLimit: false`;
- `only_paths` with `onLimit: true`.

U-PG-9 tests `onLimit` on the matcher only, not that each evaluator call site picks the strict side.

**Fix.** Add U-PE cases with a path over 1,024 characters and one with more than 128 segments:
- a `require` with `paths` and a `block` both match;
- `sensitive_paths` raises the risk;
- an `only_paths` approve rule does not match.

### 4. Minor: R8 and R9 of the risk floor lose their tightening when a path hits a limit

`src/modules/intent/risk-floor.ts:377`.

**Problem.** `test_deleted` (sensitive) and `test_shrunk` (logic) raise the floor, but they use `globMatcher(TEST_GLOBS)` with the default `onLimit: false`. With picomatch, a removed test file whose path is over 1,024 characters or 128 segments raised the floor. Now it does not.

**Fix.**
- Use a strict-side matcher (`onLimit: true`) for `test(f.path)` on removed and modified files, and for `test(f.previousPath)` on renames.
- Keep `onLimit: false` for the `!test(f.path)` term.
- Add a U-RISK case.

### 5. Nit: the wall-clock budget makes results depend on load

`src/core/glob.ts:158,255`. The 20 ms deadline means a GC pause or a busy worker can turn a call into `onLimit`. The answer stays on the strict side, but the verdict and `facts_hash` can then differ between runs, which republishes for no reason. Fuel alone is deterministic. Keep the wall clock only as a much larger backstop.

### 6. Nit: an over-long path is reported as a `graft.yaml` change

`src/policy/evaluate.ts:215` with `src/modules/policy/render.ts:215`. A path over the limits makes `policyMatch` answer `true`. That is strict and correct, but the section then states "This pull request changes `graft.yaml`". Report a limit hit apart from a real match (for example an `uncertain` flag) and word the note accordingly.

## Areas found correct

- **The matcher.** The DP over (part × segment) and the two-pointer segment match never backtrack exponentially. Realistic and review 1 globs cost ≤ 0.2 ms per call. The path caps and the per-call budget answer `onLimit`. `***` and `]+` are rejected.
- **Case folding.** It mirrors a non-`u` case-insensitive RegExp, including the non-ASCII to ASCII exception.
- **The rest.** Trust boundary, parser safety, output safety, ordering, migration and storage are unchanged since review 1 and still correct.
