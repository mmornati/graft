# Step 4 review 2: Evaluation set

Verdict: APPROVED

Reviewed: the uncommitted diff after the fixes for [review 1](step-4-review-1.md), against `docs/phase-0/step-4-evaluation-set.md`, the Phase 0 constraints, and README §7 ("Step 4 deviations and additions", including "Redaction is wider than the spec's §6.4 table" and "Further step 4 review 1 changes").

## What I ran

**DoD chain.** All of it passed:
- `pnpm lint`, `pnpm typecheck` and `pnpm test` (49 files, 484 tests, all green), then `pnpm build`.
- `pnpm eval:ci`: exit 0, with the §9 headline values unchanged.
- `pnpm eval schema --write`: byte-identical to the committed schemas.
- `pnpm eval validate --set eval/synthetic`: 30 cases, 30 gold.
- On a throwaway database, `db:migrate`, `db:rollback`, `db:status` and `db:migrate`: only 0004 was rolled back and re-applied.
- The `@ts-ignore` and import greps are clean, and the test-ID grep returns 39 lines.

**The eight §15 mutation checks.** I ran them again by hand in a throwaway copy. Each is still caught:

| Mutation | Caught by |
| --- | --- |
| `combineRisk` floor term | U-SYN-6, E-SYN-1, E-SYN-2 |
| `.github/workflows/**` removed | U-SYN-5, U-SYN-6, E-SYN-1, E-SYN-2 |
| Plaintext `writeCase` | U-CRYPT-5, U-STORE-3, U-STORE-7 |
| AAD dropped | U-CRYPT-2, U-STORE-6 |
| `assertPrivateLocation` returns early | U-STORE-1 |
| `unexplained` not counted as predicted | U-MET-4, U-SYN-6, E-SYN-1, E-SYN-2 |
| Publish order reverted (comment before check run) | I-INT-23 |
| Pending display not written | I-FB-10 |

**Mutations on the round-1 fixes.** Each is caught:

| Mutation | Caught by |
| --- | --- |
| Budget reservation removed | U-HAR-11 |
| No quote allowed before the operator | U-RED-7, U-RED-8 |
| Segment rule removed (`token`, `auth`, `pwd`) | U-RED-7, U-RED-8, U-RED-11 |
| `url_credentials` disabled | U-RED-7, U-RED-8 |
| PGP `BLOCK` suffix removed | U-RED-9 |
| Harness stop flag removed | U-HAR-12 |
| `costUsdThisRun` no longer ignored in the diff | U-RPT-1 |
| `.env` key no longer dropped | U-CLI-10 |
| Empty-match pattern check removed | U-RED-13 |

**Credential probe.** I ran 75 lines through `redactInputs` as a patch: the round-1 set plus new forms.
- Line count and the `+` prefix were preserved on every line.
- Every round-1 leak is now redacted.
- These new forms are redacted:
  - mixed-case `PASSword:`, `Passwd =`, `apiSecret:`
  - `export API_TOKEN=`, `set PGPASSWORD=`, `$env:API_KEY =`
  - `.npmrc` `//registry…/:_authToken=<uuid>`
  - docker `{"auths":{…:{"auth":"…"}}}`, both on one line and pretty-printed
  - connection strings in code literals: `"postgres://user:…@db"`, `mongodb+srv://admin:…@`, and ADO.NET `Password=…;`
  - `X-Api-Key`, `aws_session_token`, `spring.datasource.password`, `private_key_id`, and `"client_secret": "GOCSPX-…"`
- Negatives stay readable: `password_length`, `tokenizer = buildTokenizer()`, `getToken()`, `process.env.…`, `os.environ[…]`, `${{ secrets.X }}`, and `${NPM_TOKEN}`.
- What still leaks, and what the redactor now hides that it should not, is in findings 1 to 3.

**ReDoS.** The regexes are bounded. None of these took more than about 5 ms:
- 100k-character lines of identifiers, dots or spaces
- an unterminated `<password>` element
- a long URL userinfo part
- an unterminated quote
- an `Authorization` header padded with spaces

The hand-written value parser is quadratic in one case (finding 1).

Everything I created has been removed: the throwaway copy, the throwaway database, the probe scripts and `eval/synthetic/runs/`.

## Round 1 findings

| # | Status |
| --- | --- |
| 1 | **Fixed.** See the probe above and findings 1 to 3 below for the remaining gaps (none major). |
| 2 | **Fixed.** U-HAR-11 holds one case open and checks spent + reserved + estimate; the mutation is caught. |
| 3 | **Fixed.** Schema messages name the field only (`case-schema.ts:153`). The entry point prints only the class of an unmapped error (`GRAFT_EVAL_DEBUG=1` adds the message). In fake mode the harness echoes the message only for the synthetic set. |
| 4 | **Fixed** (`report.ts:138, 186`). |
| 5 | **Documented** (README §7, "Resumed export"). **Acceptable for Phase 0.** Reproducing the original draw would mean classifying every already-exported pull request again. The sample stays seeded and stratified over the remainder, and the README tells you to export into a fresh set in one go when the exact sample matters. With about 100 cases exported once by the repo owner, this is a non-issue. |
| 6 | **Fixed.** A `failed` flag is checked before each new case (U-HAR-12). |
| 7 | **Fixed.** `validateRedactPattern` rejects patterns that match the empty string and invalid patterns, with a fixed message (U-RED-13). The CLI maps the error to exit 2. |
| 8 | **Documented** in `job.ts:235-241` and README §7. **Acceptable for Phase 0.** At most two retry chains per boundary, each capped at `attempt < 2`. Republishing the same card is idempotent, and a completed chain can never swallow a later failure. |
| 9 | **Fixed** with `loadEvalDotEnv`, which drops a key that only `.env` provides and warns (U-CLI-10). |

## Findings

### 1. Minor: the assignment parser is quadratic when values are rejected, and U-RED-12 does not cover it

`src/eval/redact.ts:112-118, 120-136`.

**Problem.** When a value is rejected (placeholder, env lookup, function call), `ASSIGN_HEAD.lastIndex` stays at the end of the head. The next head then scans the unquoted value to the next whitespace again. A whitespace-free line of repeated rejected heads is therefore quadratic. Measured on one line:

| Line | Characters | Time |
| --- | --- | --- |
| `password=${` × n | 27,500 | 0.28 s |
| | 55,000 | 1.06 s |
| | 110,000 | 4.3 s |
| | 220,000 | 17.3 s |

`token=$(…`, `password=a(…` and `password=process.env.…` behave the same way. A single minified line of 1 MB in a pilot PR would stall `export` for minutes. Nothing leaks: only the export slows down. U-RED-12's lines are all on the fast path. The README sentence "a long adversarial line cannot cause catastrophic backtracking" is true for the regexes but not for this loop.

**Fix (next step or a follow-up).**
- Cap the unquoted scan, for example at 512 characters; a longer token is redacted or skipped as a whole.
- After a rejected value, move `lastIndex` to the end of the scanned span.
- Add `"password=${".repeat(20_000)` to U-RED-12.

### 2. Minor: unquoted values in compact or minified code swallow the rest of the line

`src/eval/redact.ts:112-118`.

**Problem.** An unquoted value ends only at whitespace or a quote. Examples:
- `var a={password:null,user:"bob",…}` becomes `{password:[REDACTED:assignment]"bob",…}`. The `null` check fails because the value is `null,user:`.
- `x={token:e.token,user:u.name,flags:[1,2,3]}` loses everything up to the last `]`.

The line count is preserved, but non-secret code is hidden from the model in those cases.

**Fix.** End an unquoted value at `,`, `;`, `)`, `}`, `]` and `&` as well as at whitespace (a `,` cannot appear inside an unquoted credential in practice).

### 3. Minor: credential forms that still leak

The line-based rules cannot see a value on the next line, and a few names and forms have no rule. These still leak:
- **Values on the next line:** YAML block scalars (`password: |` or `token: >` followed by the value), line continuations (`password = \`), and quoted values split across lines.
- **Command-line flags:** `--password value`, `mysql -pSecret`, `curl -u user:pass`.
- **Redis URLs with an empty user:** `redis://:pass@host`. `URL_CREDENTIALS` requires one or more characters of user.
- **Key names with no secret word:** `encryption_key`, `master_key`, `signing_key`.
- **A camel split inside the secret word:** `PassWord` normalises to `pass_word`, so the README's "anywhere in the name" claim misses it.
- **Webhook URLs:** `hooks.slack.com/services/…`.

None of these is common enough to block. The README states the honest limit (no high-entropy rule; review `show` output before sharing). For a follow-up:
- When a secret-named key's value is empty or a block indicator (`|`, `>`, `\`), redact the indented continuation lines.
- Accept an empty user in `URL_CREDENTIALS`.
- Add `(?:encryption|master|signing)_?key` and the Slack webhook path.
- Run the camel split after the `KEY_SUBSTRING` test, or test both forms.

### 4. Nit: over-redaction of `max_tokens = 100000000`

The segment rule matches `tokens`, and the value is long enough. This falls within the documented over-redaction, but `max`, `limit` and `budget` as a **leading** segment could be added to the benign list next to the trailing words.

## Other points checked and found sound

- **Encryption, location checks, purge, metrics, kappa and the cache key:** unchanged since round 1.
- **The `\` line rule:** a "`\ No newline at end of file`" line is kept verbatim.
- **Hunk headers:** an `@@` line ends an open key block and keeps its markers.
- **Error output:** `validate` and `run` print schema issues by field path only, with no value or path.
- **Docs:** README §7 records every deviation, including the documented-only decisions for findings 5 and 8.
