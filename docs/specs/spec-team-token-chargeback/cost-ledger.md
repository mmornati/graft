# Cost ledger and current Graft state

## Current state

- The existing `intent_spend` table is an append-only aggregate with repository id, change id, total tokens, LLM call count, spend timestamp, and nullable `cost_usd`.
- Spend-time cost is estimated from the model response and pricing data. A missing model price is stored as `NULL`.
- `intent_spend` does not retain the model id or per-call input, output, cache-read, and cache-write token counts. `intent_cards` has token counters, but those describe the latest run that produced the card rather than a durable per-call breakdown.
- `intent_spend.repository_id` references `repositories(id)` with `ON DELETE CASCADE`; purging a repository therefore removes its aggregate budget rows.
- Providers have different billing bases: hosted API providers charge by usage, CLI providers use a logged-in subscription, Copilot is billed to the installing organization, and local models have no per-token bill.

## Implemented chargeback path

- `billing_spend_calls` records each model response separately with provider-qualified model, per-category token counts, nullable estimated cost, price version and call time.
- `billing_spend_allocations` freezes the billing-team names/IDs and equal token/cost splits at write time. It has no repository foreign key, so it survives repository purge.
- `billing_statement_lines` snapshots closed months; `billing_adjustments` records corrections and late-recorded calls in a later open month.
- `intent_spend` remains the existing aggregate used by the token-budget view. Chargeback statements use the new per-call ledger.
- `pilot_purges.rows_preserved` records counts of retained chargeback ledger and statement rows. These rows currently have no expiry policy.

## Data required by this contract

For each model call, retain enough information to reproduce and audit its estimate and allocation:

- Stable call and repository identifiers, timestamp, model/provider identity, and token counts for input, output, cache reads, and cache writes.
- Estimated USD amount and the version of the price data used to calculate it.
- The billing-team membership snapshot and the resulting per-team allocations, including the unattributed case.
- A source-call reference for late-recorded-call adjustments, without making closed statements mutable. Operator-entered USD corrections retain the selected line's team, repository and model dimensions, plus the operator's reason.

Preserve the historical identifiers and ledger rows needed for reconciliation when a repository is purged. The current implementation retains these rows indefinitely; there is no expiry or purge option for billing history.
