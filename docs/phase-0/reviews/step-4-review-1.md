# Step 4 review 1: Evaluation set

Verdict: CHANGES REQUESTED

Reviewed: the uncommitted diff on top of `e9a8fb6` (step 3), against `docs/phase-0/step-4-evaluation-set.md`, the Phase 0 constraints, and README §5 and §7 ("Step 4 deviations and additions").

## What I ran

- DoD chain: `pnpm lint`, `pnpm typecheck`, `pnpm test` (49 files, 471 tests, all green), `pnpm build`, `pnpm eval:ci` (exit 0, synthetic headline values as in §9), `pnpm eval schema --write` (no drift, U-CASE-6 green), `pnpm eval validate --set eval/synthetic` (30 cases, 30 gold), `db:migrate` / `db:status` / `db:rollback` / `db:migrate` on a throwaway database (0001–0004 applied, only 0004 rolled back and re-applied), the two greps (clean), and the test-ID grep (36 hits).
- Manual checks 1 to 3: `init` outside the repo works (dir 0700, `set.json` 0600); inside the repo exits 2, and so do an upper-case path on case-insensitive APFS, a symlink into the repo and a `..` path into the repo. `run --live` without a key exits 2; with `ANTHROPIC_API_KEY=dummy` and no TTY it prints the estimate and exits 3 with no request. `show` renders the zero-width character as `[U+200B]`. `purge` removes the set and appends a content-free line to `purge-log.jsonl`.
- All eight mutation checks of §15, in a throwaway copy, are caught by the named tests: `combineRisk` floor term (U-SYN-6, E-SYN-1, E-SYN-2), `.github/workflows/**` removed (U-SYN-5, U-SYN-6, E-SYN-1, E-SYN-2), plaintext `writeCase` (U-STORE-3, U-CRYPT-5), AAD dropped (U-STORE-6, U-CRYPT-2), `assertPrivateLocation` early return (U-STORE-1), `unexplained` not predicted (U-MET-4, E-SYN-1), T17.3 order reverted (I-INT-23), pending display not written (I-FB-10). Extra mutations: redacted private-key lines dropped (U-RED-2), retry key back to `deliveryId` (I-INT-10, -21, -22), TTY check removed (U-CLI-2). The budget reservation mutation is **not** caught (finding 2).
- Hand checks: kappa on the (20, 5, 10, 15) table gives 0.4; weighted-kappa weights, UC/SUC/OC/ACC per `S_X`, confusion precision and recall with null on a zero denominator, the flag and out-of-scope rows, and `cardAcceptableRate` all match §8. The cache key is `sha256([inputHash, promptFingerprint(), "live"])`, and `inputHash` covers `PROMPT_VERSION`, both models, efforts, limits and the globs. AES-256-GCM: raw 32-byte key, fresh 12-byte random IV per seal, 16-byte tag length enforced, `kid` checked before decryption, plaintext returned only after `final()` succeeds, AAD `<setId>/<rel path>`. Sound.
- The redaction rules were tested on common credential forms (finding 1).

Everything I created (the throwaway copy, the throwaway database, the temp sets, `eval/synthetic/runs/`) has been removed.

## Findings

### 1. Major: secret redaction misses the most common credential forms, and README §7 says it covers one it does not

`src/eval/redact.ts:30-33`, `README.md:292`.

**Problem.** E14 says redaction "removes live credentials", but the `assignment` rule only matches a key name that stands alone between word boundaries, with the operator right after the name. I ran `redactInputs` over a patch. These lines went through **unchanged**:

- `DB_PASSWORD=…`, `AWS_SECRET_ACCESS_KEY=…`, `aws_secret_access_key = …`, `GITHUB_TOKEN=…`, `SECRET_KEY_BASE=…`, `client_secret: …`, `access_token = "…"`: a prefix or suffix joined by `_` defeats `\b`. These are the normal `.env`, YAML and CI forms.
- `"password": "hunter2hunter2"` and `'api_key': '…'`: the closing quote of a JSON or YAML key sits between the name and `:`. README §7 says this form **is** matched. It is not, and no test covers it.
- `password: "correct horse battery staple"`: a quoted value with spaces.
- `PASSWORD := "…"`, `pwd=…`, `<password>…</password>`.
- `postgres://admin:S3cretPassw0rd@db.internal/app`: credentials in a URL.
- `Authorization: Bearer …`.
- `-----BEGIN PGP PRIVATE KEY BLOCK-----` blocks: `KEY_BEGIN` requires `PRIVATE KEY-----` right after the name.
- Provider tokens with no rule: Stripe `sk_live_`/`rk_live_`, OpenAI `sk-`/`sk-proj-`, Google `AIza…`, GitLab `glpat-`, npm `npm_`.

The line count was preserved in every case. That part is correct.

The spec's §6.4 table is the minimum, not a ceiling. Exported pilot diffs are copied into a store held by the Graft team, and in live runs they are sent to Anthropic. A rule that misses `DB_PASSWORD=` and JSON `"password":` does not meet the purpose of E14.

**Required fix.**

1. Widen `assignment`:
   - Allow an identifier prefix and suffix around the key word, for example `(?<![A-Za-z0-9])[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth)[A-Za-z0-9_.-]*`.
   - Allow an optional closing quote before the operator, and the operators `=`, `:`, `:=` and `=>`.
   - Handle a quoted value that contains spaces: up to the matching quote.
   - Keep the "keep the name and operator" behaviour and the 8-character minimum.
2. Add rules:
   - `url_credentials`: `scheme://user:pass@`. Replace only the password.
   - `bearer`: `Authorization: Bearer <token>`.
   - PGP private key blocks (`BEGIN PGP PRIVATE KEY BLOCK`).
   - Stripe, OpenAI, Google API key, GitLab and npm tokens.
   - Optionally, a long high-entropy run next to a key-like name.
3. Add U-RED tests for each new form, including `DB_PASSWORD=`, `AWS_SECRET_ACCESS_KEY=`, JSON `"password": "…"`, YAML `client_secret:`, a `.env` line with `export`, and a PGP block. Each test checks that the value is absent and that the line count and diff prefixes are unchanged. Check that U-SYN-2 stays at zero; adjust a synthetic case if a fictional value now matches.
4. Correct README §7: drop the `\b` sentence and record the widened rule set as a deviation from §6.4.

### 2. Minor: budget reservation under concurrency is untested

`src/eval/harness.ts:232-243`, `README.md:291`.

Removing `reservedUsd` from the budget check (`spentUsd + est.usd > o.maxCostUsd`) leaves every test green. U-HAR-4 runs with `concurrency: 1`, and U-HAR-7 has no budget. README §7 claims "in-flight cases reserve their estimate so that concurrency cannot overshoot". Add a test with a gated fake client, concurrency 3 and a cap that fits two estimates: exactly two cases start and the rest are `skipped: "budget"`.

### 3. Minor: error output can carry pilot paths or label text

- `src/eval/case-schema.ts:153` puts the file path into the refinement message (`outOfScope path is not in inputs.files: ${p}`). `readCase` copies issue messages into `EvalCaseError` (`src/eval/store.ts:294-301`), and `validate` and `run` print them. A pilot path then reaches the terminal and CI logs.
- Errors the CLI does not map reach `console.error(e.message)` (`src/bin/eval.ts:771-776`). For example, a `SyntaxError` from `JSON.parse` of `--apply labels.json` includes a snippet of the file.
- In fake mode, `harness.ts:249-253` includes `err.message` for any set, pilot sets too.

Use the issue path and code only, with no value or path, in schema messages. Map unknown errors to their `name` (or a fixed text) for commands that open a pilot set.

### 4. Minor: the baseline diff ignores `cached` and `cachedResults` but not `metrics.costUsdThisRun`

`src/eval/report.ts:134-141`.

A live re-run served from the cache equals its baseline row by row but differs in `costUsdThisRun` (0 against the original cost), so `equal` is false and a metric change is listed. Ignoring `thresholds`, `pass` and per-row `cached` is sound, since they are derived or run identity. Ignore `costUsdThisRun` for the same reason, and add it to the U-RPT-1 fixture.

### 5. Minor: a resumed export does not reproduce the uninterrupted sample

`src/eval/export.ts:160-166, 272-276`.

On a re-run the sample is re-allocated over the fresh candidates only, with `n = sample − existing`. `--min-per-stratum` is applied again to every non-empty stratum. The resumed set therefore differs from what an uninterrupted run with the same seed would have produced, and it can over-represent small strata. The behaviour is acceptable, but the README calls it "resumes with the rest". Either say in README §7 that a resume re-samples the remainder, or allocate over all stage-1 candidates (existing ones count as already picked).

### 6. Minor: an unexpected error in one case does not stop the other workers

`src/eval/harness.ts:246-254, 281-282`.

When a worker throws, `Promise.all` rejects, but the other workers keep taking cases. In live mode they keep calling the API and writing the cache until the queue drains, after the run has already "aborted". Set a stop flag that the worker loop checks before taking the next case.

### 7. Nit: a `--redact-pattern` that matches the empty string corrupts every line

`src/eval/redact.ts:62`.

`x*` inserts `[REDACTED:custom]` between every character (976 "redactions" on a short body). The line count is still preserved. Reject patterns for which `new RegExp(p).test("")` is true.

### 8. Nit: two triggers on either side of a 5-minute boundary queue two retries

`src/modules/intent/job.ts:245`.

This is inherent to the bucket. A completed retry can never swallow a later failure: the retry starts at least 300 s later, so in a later bucket. The cost is bounded to at most two retry chains per boundary. Say so in the comment above the send.

### 9. Nit: the CLI loads `.env` from the repo

`src/bin/eval.ts:771`.

A `GRAFT_EVAL_KEY` in `.env` is therefore honoured, against "never in `.env`". Consider warning when `GRAFT_EVAL_KEY` comes from `.env` (compare `process.env` before and after `loadDotEnv`).

## Other points checked and found sound

- **E1 boundary.** U-BND-1 and U-BND-2 hold, and `src/eval` imports only the allowed index files, `src/llm`, `client-factory` and `errors`.
- **Live gating.** The Anthropic client is built lazily on the first call and only with `--live`. `--live` needs the key, and with no TTY and no `--yes` the run exits 3.
- **Budget checks.** Over-budget is checked before the confirmation, and `--max-tokens` also gates the estimate.
- **Cache.** Fake mode never reads or writes it. Retryable failures are not cached.
- **Rate limits.** The `x-ratelimit-*` sleep, `retry-after` and three retries, `--max-wait` abort and `--max-requests` all use the injected clock and `sleep`.
- **Export listing.** It pages through `Link` and stops at `updated_at < from`. Patches are dropped in stage 1.
- **T17.**
  - 0004 up/down.
  - 0003 down with `IF EXISTS`.
  - The pending display is written inside the note's lock after the comment write. Attribution drops it because `available` is `status === "ok"`.
  - `latestPublishedCard` skips pending displays.
  - Check run, then comment, then `markPublished` with `now` taken after the comment. If the comment write fails after the check run succeeded, the retry adopts the check run through `listForRef`.
- **Purge** removes cache, runs and baseline because they all live in the set directory. The log holds no content.
