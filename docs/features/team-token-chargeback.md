# Team token chargeback

[Docs index](../README.md) · [Operator console](../console.md) · [Model providers](../model-providers.md)

The optional operator console can attribute Graft's estimated model usage to internal billing
teams. This is a chargeback report for reconciliation, not customer billing: it does not collect
payments, create invoices, or import provider invoices.

## Set it up

1. Apply the current Graft database migrations by starting the updated server, or run `pnpm
   db:migrate` before starting the worker.
2. Configure the console's optional Graft connection: set `CONSOLE_GRAFT_URL` and
   `CONSOLE_GRAFT_SECRET`, and set the matching `GRAFT_CONSOLE_SECRET` on Graft. Use a dedicated
   secret of at least 32 characters; keep it server-side and runtime-only. See
   [console configuration](../console.md#configuration).
3. Sign in to the console and open **Billing**. Create a billing team and attach one or more
   repositories. A repository can belong to multiple teams, and the same repositories can be
   assigned to different billing teams without changing GitHub teams or repository processing.
4. Repeat for the teams you want to report separately. Calls made before a repository is attached
   are not reallocated when membership changes.

The Graft connection is also needed for the **Repositories** tab. Team membership changes are
checked by Graft against the signed-in user's current GitHub identity and administrator permission
on the affected repository. Team creation, rename, archive, statements, and adjustments require an
authenticated console user. Console users share operator visibility: statements are not scoped to
the team or repository the user administers.

## What is recorded and allocated

Each model response with nonzero token usage is recorded separately, including retries, verification
calls, and fallback-model calls. The record includes the provider-qualified model, repository,
timestamp, input and output tokens, cache-read and cache-write tokens, estimated USD cost when
priced, and the price version used. The existing `intent_spend` aggregate remains in use for the
daily token-budget view; the Billing tab reads the separate per-call ledger.

At the time a call is recorded, Graft snapshots that repository's active billing teams. Each token
category and the call's cost (rounded to cents for allocation) is divided equally among those teams.
Integer-token and cent remainders go to teams in ascending billing-team ID order, so allocations
sum to the original token totals and the rounded USD estimate. Later membership changes, team
renames, and archives do not change historical allocations. If there are no active billing teams,
the call is assigned to the visible
**Unattributed** account. Archiving a team removes it from future snapshots but leaves its historical
allocations and statements intact.

Usage is grouped in statements by team, repository, and model. A line shows call count, input,
output, cache-read and cache-write token totals, estimated USD cost, and unpriced-call count.

## Pricing and unpriced calls

Prices are estimates in USD per million tokens, not provider invoices. For providers configured
with a model registry, define the model's `prices` entry there; `input` and `output` are required,
and `cacheRead` and `cacheWrite` default to the input rate unless set separately. See
[provider-registry pricing](../configuration.md#model-providers). With the built-in Anthropic
pricing table, the currently recorded rates are:

| Model | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| `claude-haiku-5-5` | $0.10 | $0.50 | $0.01 | $0.125 |
| `claude-sonnet-5-5` | $2.00 | $10.00 | $0.20 | $2.50 |

These are per million tokens; the built-in table was last verified on 2026-10-06. Check your
provider's current rates before using the estimates for reconciliation. CLI subscriptions,
organization-billed Copilot calls, local models, and any model without a matching price are shown
as **Unpriced** rather than assigned a zero-dollar cost. There is no console operation to reprice a
stored call: adding a price later does not change already-recorded calls, which remain unpriced and
keep their month open.

## Monthly statements and corrections

Periods use UTC. A daily worker job closes previous months that contain usage or adjustments only
when every call in the month has a known price. A month with no activity remains open; an
unpriced call prevents automatic close. Closed statements are immutable snapshots.

If a model call is recorded after its original month has closed, Graft records it as an adjustment
in the next available open month, including its frozen token allocation. Operators can also add a
non-zero USD-only correction, with a reason, against a usage line in a closed statement. Both kinds
of correction leave the original closed statement unchanged and appear in a later open month. The
console exports the selected statement as JSON or CSV.

The ledger, frozen allocations, adjustments, and closed statements survive a repository purge;
the current repository-to-team membership does not. There is no expiry policy for this retained
billing history. The purge report records how many billing rows were preserved. Provider-invoice
imports and comparison are not implemented.
