# Step 5 review 1: Policy engine, report-only

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted step 5 diff on top of `379d4f2`, judged against `docs/phase-0/step-5-policy-engine.md`, the Phase 0 constraints, README §5 and §7 and `docs/graft-yaml.md`.

## What was checked

- **DoD chain.** `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test` (57 files, 614 tests, all pass), `build`, `eval:ci` (exit 0, baseline equal), `graft policy schema --check` (0), `graft policy check docs/examples/graft.yaml` (0), `graft policy check test/fixtures/policy/alias-bomb.yaml` (1). `db:migrate`, `db:status`, `db:rollback` (only 0005), `db:migrate` all pass. The three greps are clean, and the ID grep returns 81 lines. Every test ID in §13 exists as a named `it`/`describe`.
- **Mutation checks.** I applied all 16 mutations one at a time and restored each file byte for byte. All 16 were killed by the named tests: M1 (head SHA in the policy job: I-POL-3; in the intent hook: I-POLH-2), M2 (U-PE-4, U-PE-15), M3 (U-PE-9, I-POL-10), M4 (U-PE-5, U-PE-8, U-PE-10), M5 (U-PE-14, U-PE-17), M6 (U-PY-3, U-PY-4), M7 (U-PS-3), M8 (U-PE-7), M9 (U-PE-6, U-PE-21), M10 (I-POLH-1), M11 (I-POL-16), M12 (U-PR-4, I-POL-18), M13 (I-POL-11), M14 (I-POL-12), M15 (U-FACT-1) and M16 (U-RED-12). See nit 6 for M8.
- **Manual smoke test, with the network blocked** (`GITHUB_API_URL=http://127.0.0.1:9`, a throwaway key, the server and worker on 3999). The deliveries returned `202`. `policy.evaluate` had IDs only in `data`, and the push gave one `policy.fanout`. The worker logged a classified token failure and did not crash. Afterwards I deleted the rows the smoke test created in the dev DB.
- **Worked examples.** I checked E1 to E14 by hand against `evaluate.ts`, including block precedence, the `max` merge, `approve` only when no require or block matches, the default of 1, and the built-in. They match, and U-PE-1 to U-PE-14 assert the exact verdict objects.
- **Parser probes.** These all fail safe without echoing values: a 16-level flow nest passes and 17 levels are rejected; 16,000 nested block sequences give `yaml_syntax` in 26 ms; 180-deep block maps; `%TAG` directives; `!!str` on a key; an anchor on a key; `<<` without an alias; `__proto__` (no pollution); duplicate keys; two documents; an empty file; a NUL byte. The error messages for a file full of marker values contain none of them.
- **Redaction probes.** Lines of 1 MB built from `password=a `, `token: `, `--password `, `-u a:`, `mysql -p…`, `redis://:`, `<password>`, `authorization: bearer ` and far-quoted values each finish in ≤ 80 ms. The new forms work, and `max_tokens = 100000000` is kept.

## Findings

### 1. Blocker: glob matching backtracks catastrophically on valid globs and PR-controlled paths

`src/policy/globs.ts:22-47`, `src/core/glob.ts:28`; used by `src/policy/evaluate.ts:126,213-214` and the intent floor through `src/modules/intent/settings.ts`.

**Problem.** The §6.2 limits are at most 4 `**` segments, 3 `*` per segment and a regex of 2,000 characters or less. They bound each segment, but not how segments interact across `**`. Interleaving `**` with segments that hold several stars gives a picomatch regex with nested, overlapping quantifiers. These were measured with `globMatcher` on one non-matching path made of `a` segments:

| Glob (passes `validateGlob` and the CLI) | Path | Time |
| --- | --- | --- |
| `**/*a*a*/**/*a*a*` | 12 segments × 50 chars | 5.6 s |
| `**/*a*/**/*a*/**/*a*/**/*a*` | 10 × 20 | 2.3 s |
| `**/*a*a*a/**/*a*a*a/**/*a*a*a/**/*a*a*a` | 8 × 10 | 3.9 s |
| same | 8 × 30 | > 20 s (killed) |

Whoever opens the PR controls the paths, including from a fork, and GitHub allows paths of up to 4,096 bytes. A PR can carry 1,000 such files. Nothing truncates paths before matching. Matching is synchronous, so it blocks the worker's event loop for every installation, and pg-boss `expireInSeconds` cannot interrupt it. The same globs run in the intent hook's floor (`sensitive_paths`). The admin of any one installed repository can therefore commit a valid `graft.yaml` that lets any contributor stall the shared worker. U-PG-4 tests only one segment, so it does not cover this. The spec's §6.2 limits are the root cause, but this review is where it gets caught.

**Required fix.**
- Bound the complexity across segments, not only within one. Either:
  - (a) allow at most one `**` when any segment has more than one `*`, and cap the total of non-`**` stars per glob (for example 4); or
  - (b) match without backtracking: segment by segment, with a linear wildcard matcher per segment, and `**` as a segment skip handled by dynamic programming.
- Cap the length of the path that is matched (for example skip paths over 1,024 characters and treat them as an incomplete listing, which only tightens).
- Add a test that runs the worst glob the validator accepts against 1,000 adversarial paths of the maximum length, in under 1 s.
- Record the new limit in §6.2, `docs/graft-yaml.md`, the `glob_invalid` reasons and `POLICY_REFINEMENTS`.

### 2. Major: a PR that changes `graft.yaml` can be would-approved when the file listing is incomplete

`src/policy/evaluate.ts:216, 294-309`; `src/modules/policy/facts.ts:34`.

**Problem.** `policyFileChanged` and the `sensitive_paths` raise come only from `facts.files`. With more than 1,000 changed files, or a listing that stops short, `files` is empty or partial and `listingComplete` is false. Step 4 then returns `would_approve` for any approve rule that does not use `only_paths`. I reproduced it with:
- the rule `{ match: { size: { max_lines: 10 } }, approve: auto }`;
- facts `files: []`, `listingComplete: false`, `size: { lines: 0, files: 1001 }` (for example 1,001 pure renames, one of them `graft.yaml`);
- a card that is final `sensitive`.

The result is `would_approve`. `risk`-only approve rules happen to be safe, because the floor's `listing_truncated` forces `sensitive`. But `size`-only approve rules, or approve rules that accept `sensitive`, are not. This breaks:
- D5: "can never be would-approved";
- D11: paths are an unknown fact when the listing is incomplete, and "an unknown fact never loosens".

**Required fix.** When `!facts.listingComplete`, treat "this PR may change the policy file" as possible. In step 4, override the matched approve rules with the `policy_file_changed` built-in (`would_require` 1, marked uncertain or with a distinct note such as "file list incomplete"). Equivalently, approve rules never match while the listing is incomplete. Add a U-PE case (a size-only approve rule with `listingComplete: false` gives `would_require`) and update §9.2 step 4 and `docs/graft-yaml.md`.

### 3. Minor: the T14 "empty value" continuation over-redacts ordinary code blocks

`src/eval/redact.ts:170-177, 375-376`

**Problem.** Any secret-named identifier that ends a line with `:` starts the `empty` state, which redacts every more-indented line that follows (up to 50). This is real code, not YAML:

```
+if password:
+    [REDACTED:assignment]
+    [REDACTED:assignment]
```

The same happens for `for token in tokens:`, `class PasswordForm:` and `case "password":` (TS/JS). The code follows the T14 text literally, and it errs on the safe side. But it hides whole Python blocks from the model in real-sample evaluations, which skews the step 4 measurements.

**Fix (recommended).** Start the `empty` state only for a YAML-like key line:
- the line is just `key:`, optionally quoted, with an optional `- ` list prefix and nothing else;
- the key is not preceded by a keyword or other tokens (`if`, `for … in`, `class`, `case`, `def`, `while`).

Add the four examples above to U-RED-15 as negatives.

### 4. Nit: the CLI reads the whole file before checking its size

`src/bin/graft.ts:61-77`. `lstat` already gives `info.size`. Reject `size > 32768` with `file_too_large` before `readFile`, so that a huge file is never loaded. That matches the server's "checked before decoding" (D6).

### 5. Nit: the smoke test's fan-out finds no PR

`scripts/generate-fixtures.ts` and `test/fixtures/webhooks/push.json`. The `push` fixture targets `main`, but the fixture PR's base is `master` (the `policy:pr:…:master:…` key). Step 4 of the smoke test therefore yields a `policy.fanout` that enqueues 0 evaluations. Point the push at the fixture PR's base branch (or note it in the smoke-test text) so that the smoke test exercises the fan-out end to end.

### 6. Nit: M8 is caught only by U-PE-7

With the built-in removed, I-POL-3 still passes, because its PR is blocked and the built-in never applies. The spec names both tests. Either add an integration case (an approving policy plus a PR that edits `graft.yaml` gives `Would require 1 human`) or correct the table.

### 7. Nit: the loader throws a plain `Error`

`src/policy/load.ts:111`. A parsed file without a valid blob SHA throws a plain `Error`, which pg-boss retries 5 times. Make it a `PermanentJobError`, or return `invalid` / `file_not_regular`.

## Judgement of the README §7 "Step 5 deviations"

All are sound:
- `maxAliasCount` moved to `toJS`, with `visit` as the real defence;
- every explicit tag rejected, which is stricter than D6;
- `crossChecks` on the raw value instead of `superRefine`, so no errors are hidden;
- `too_many_errors` counted inside the 50;
- E12 test data changed to `Docs/A.MD`: the spec's own example would match rule 1 through `*.md`, and the intent (case-sensitive `only_paths`) is kept;
- `raisedBy` listed only when it changed the class;
- `facts_hash` widened with the rendered output;
- in-flight read sharing in the loader;
- the intent job emitting for cached cards too.

One point is left open: the symlink `path` behaviour of `getContent` and the `heads%2F…` ref encoding are unverified against real GitHub. They are recorded in HUMAN-TODO, and the `type === "file" && path === "graft.yaml"` check is safe either way.

## Areas found correct

- **Trust boundary.**
  - The policy is read only at `git.getRef(heads/<live base.ref>)`, in the base repository from the payload, and never at the head or a `refs/pull` ref. That holds for forks too.
  - Octokit percent-encodes special characters in the ref.
  - A retargeted base is picked up from the live `pulls.get`, through the `edited` key, which includes `baseRef`, and through the stored `base_ref`.
  - `author`, `agent` and `labels` are rejected in approve rules (`approve_untrusted_key`) and only tighten.
  - Unknown facts match as uncertain in tightening rules and must hold for every value in approve rules. Finding 2 is the one exception.
- **Parser order.** The parser checks the size, strict UTF-8, the flow-depth pre-scan, one document, then anchors, aliases and tags, all before `toJS`.
- **Loader.** It handles symlinks, directories, submodules, `encoding: "none"` and over-size files. It caches by `repositoryId:commitSha` and never caches a failure.
- **Output.** The check conclusion is a constant `neutral`, also in the DB row. Teams are always code spans, and logins, labels, agents and paths go through `codeSpan`.
- **Ordering.** Rule names go through `escapeProse`. The D16 checks (a), (b) and (c) run inside the lock. `unchanged` writes nothing to GitHub but moves `facts_read_at` forward. Job IDs are deterministic. The fan-out is capped at 100 and staggered.
- **Signals.** They flow one way, and nothing outside `src/app/registry.ts` imports `modules/policy`.
- **Migration 0005.** `down` restores the 0001 table and index exactly, and no column name contains `code` or `blob`.
- **Storage.** Nothing from the YAML is stored or logged (I-POL-17 is a strong test).
