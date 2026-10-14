# Step 3 review 2

Verdict: APPROVED

Reviewer: senior engineer (Opus). Scope: the uncommitted working tree after the fixes for [review 1](step-3-review-1.md), checked against [step-3-intent-service.md](../step-3-intent-service.md) and the README §7 "Step 3 review 1 changes". No real Anthropic call was made.

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `build` | all ok (Biome checked 131 files) |
| `pnpm test` | 39 files, 346 tests, all pass. No `only`, `skip` or `todo`. |
| `db:rollback` → `db:status` → `db:migrate` → `db:status` → `db:rollback` → `db:migrate` | only `0003_intent` rolls back and re-applies; `intent_spend` and `intent_displays` exist afterwards (see nit 6 for the dev database) |
| DoD greps (`@ts-ignore`, `modules/` in `src/db`, sampling params in `src/llm`, test-ID count) | no hits, no hits, no hits, 79 |
| I-E2E-3/-4 run six times in a row | 6/6 pass |
| Mutation checks in a throwaway copy (deleted; `diff -r` against `src/` was clean before deletion) | table below |

### Mutation checks

| Mutation | Tests that fail |
| --- | --- |
| In-lock head check in `intent/job.ts` | I-INT-9 |
| In-lock head check in `provenance/job.ts` | I-PROV-10c |
| `combineRisk` floor term | U-RISK-17, U-RISK-18, U-INJ-1 (+ U-GEN-4, -13, -20) |
| PR body in the verifier data | U-GEN-15 |
| `<!--` rewrite removed from both functions | U-MD-4, U-MD-9, **U-INJ-2, U-INJ-4** |
| `<!--` rewrite removed from `codeSpan` only | U-MD-4, U-MD-9, U-INJ-2, U-INJ-4 |
| `<!--` rewrite removed from `escapeProse` only | nothing (see nit 5: that line is unreachable) |
| Spend ledger insert disabled | I-INT-17, I-INT-18, I-INT-19 |
| Display row written only when none exists | I-FB-1, I-FB-2, I-FB-6, I-FB-7 |
| `toJobError` returns the raw error and the worker logs/rethrows the raw error | U-GHE-4, U-GHE-5, I-INT-12, I-E2E-4 |
| Fallback block ignored | U-LLM-11 |
| Abort signal removed | U-LLM-12 |

## Review 1 findings

| # | Status |
| --- | --- |
| 1 (major) budget | **Fixed.** An append-only `intent_spend` ledger row is written per run before the card upsert, so in-place regeneration, a dropped concurrent `ok` save and next-day regeneration all count. `tokensUsedToday` reads the ledger for the UTC day. Proven by I-INT-17/18/19 and the mutation above. |
| 2 (major) model output in logs/pg-boss | **Fixed.** `sanitizeError` keeps name, a 200-char single-line message, status, method, route template and request id. It is applied in `toJobError`, the worker (log and rethrow), the receiver, the server error handler and pg-boss `error` events. The only raw `{ err }` logs left are the shutdown handlers in `src/bin/*` (DB/pg-boss errors, no request bodies). I-E2E-4 puts a sentinel in both the request and the response body and checks the logs and `pgboss.job.output`. |
| 3 attribution | **Fixed**, with the edge cases in minors 2 and 3. |
| 4 deadline | **Fixed.** `AbortSignal.timeout(remaining)` bounds SDK retries. `APIUserAbortError` maps to `timeout` (retryable). The deadline starts at the job start. |
| 5 fallback | **Fixed** (text after the last `fallback` block only). |
| 6 retry notice | **Fixed**, but see minor 1 on the new key. |
| Nits 7, 9, 10, 12, and the whitespace half of 8 | Fixed (U-OUT-7, U-MD-11, I-FB-9, the settings signature, U-RISK-19). |
| Nits 11, 13, and the paths half of 8 | Skipped. The reasons in README §7 are sound: each needs a spec change, and both skipped behaviours err towards a higher risk class. |

## Questions from the coordinator

**Does the `deliveryId`-suffixed retry key re-open duplicate retries or replay amplification?**

- **Replay: no.** A replayed body is stopped by the delivery table and by the D8 key, which has no delivery id. So one generate job gives at most one chain of retries.
- **pg-boss retries of the same run: no.** They reuse the same `deliveryId` and deduplicate. The chain stays bounded by `attempt ≤ 2`, because the retry job carries the original `deliveryId` forward.
- **What it does re-open:** chains are no longer shared between different triggers that have the same inputs. Every distinct trigger during an outage starts its own chain of up to 2 retries: `synchronize`, `edited`, and each Re-run (one per minute). So the model is called up to 3× per trigger instead of 3× per inputs. The cost is bounded: the budget now counts every attempt, outage failures usually carry zero usage, and once one chain succeeds the others hit the cached `ok` card for free. Minor 1.

**Display attribution edge cases.** The core logic is right:
- a reaction keeps its `created_at` across comment edits;
- displays are ordered by `(shown_at, seq)`, and the stable sort keeps `seq` ties;
- A→B→A credits A;
- reactions made during an `unavailable` display are dropped;
- unavailable→ok on the same card id adds a display;
- a stale run writes none.

Two windows remain (minors 2 and 3).

**Did the I-E2E-3 change hide an ordering bug? No.**
- The intent publish writes the comment and then the check run inside one lock and transaction (`job.ts:241-313`). The old test asserted the check runs as soon as the comment showed both sections, which is one request too early.
- The final assertions (exactly one comment, exactly one check run of each name) still hold, and the test passed 6/6 runs.

## Findings

### 1. minor — Each trigger now has its own retry chain

`src/modules/intent/job.ts:229-240`

With `:{deliveryId}` in the deterministic key, triggers with the same inputs no longer share a chain (see above). The cost is bounded, but it is up to 3× model calls per trigger during an outage, and repeated Re-runs stack chains. What is wanted is "at most one *pending* retry per (change, head, inputs, attempt)". pg-boss's own `singletonKey` gives exactly that when there is no deterministic id, because it only deduplicates jobs that are created, retrying or active. Another option is a time bucket (`…:{attempt}:{floor(now/300 s)}`) in place of the delivery id. Also, when a pg-boss retry of the same run hits the dedup, the notice says "Re-run to try again" even though a retry is queued from the first execution. That is harmless, and the README already documents it.

### 2. minor — The D11 "writing the card" note is not a display

`src/modules/intent/job.ts:174-205`, `src/modules/intent/store.ts:226-259`

While the pending note is on screen, the last display is still the previous card. So reactions made in that window (model latency, typically under a minute) are credited to a card that is no longer shown. Record the note as a display that drops reactions, like `unavailable` (for example a `pending` status, with `card_id` set to the previous card), or start counting the next display from the note's time.

### 3. minor — A comment written in a rolled-back publish has no display

`src/modules/intent/job.ts:248-311`

The comment is PATCHed before the check run. If the check-run call fails, the transaction rolls back and the display row is not written, but the comment already shows the new card. Reactions are then credited to the previous display until a pg-boss retry publishes again (backoff from 30 s), or forever if the failure is permanent. One fix is to write the check run first and the comment last. Another is to record the display in its own short transaction right after a successful comment write. This also narrows nit 4.

### 4. nit — `shown_at` is taken after the GitHub writes

`src/modules/intent/job.ts:306`

There are a few hundred milliseconds between the comment PATCH and `ctx.clock.now()`, plus any skew between GitHub's clock and ours. That is negligible, but worth a one-line comment in `markPublished`.

### 5. nit — `escapeProse`'s `<!--` rewrite cannot fire

`src/github/markdown.ts`

Step 6 has already escaped `<` and `!`, so `<!--` can never appear when step 9 runs. That is why removing it fails no test. The output is safe. Keep the line for defence in depth, but say in a comment that it is unreachable, so the DoD mutation check is understood to apply to `codeSpan`.

### 6. nit — Editing `0003` in place leaves databases that ran the old version stuck

`src/db/migrations/0003_intent.ts`

On a database that applied the earlier `0003`:
- `db:migrate` reports nothing pending, but `intent_spend` and `intent_displays` are missing;
- `db:rollback` fails on `DROP TABLE intent_displays`.

The local dev database was in that state. I repaired it by creating two empty placeholder tables, rolling back and re-migrating, and it is now on the new `0003`. This is acceptable because the migration was never committed. Add a one-line note to the PR description, or use `DROP TABLE IF EXISTS` for the two new tables in `down`.

### 7. nit — The sweep window still uses the first display

`src/modules/intent/feedback.ts:271-272`

The 30-day sweep window uses `max(intent_cards.published_at)`, which is each card's first display. A card that was first published more than 30 days ago and shown again recently (A→B→A with an old B) drops out of polling. Use `max(intent_displays.shown_at)`.

## Required before approval

None. Minors 1 to 3 are worth fixing before step 6 starts computing the accuracy gate; they can go in a follow-up.
