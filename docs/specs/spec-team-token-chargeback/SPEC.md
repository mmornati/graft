---
id: SPEC-team-token-chargeback
companions:
  - cost-ledger.md
  - failure-modes.md
sources: []
---

# Internal team token chargeback

## Why

Graft can estimate model spend by repository, but internal teams cannot use that data to understand or reconcile their share of usage. Billing owners need a monthly, auditable statement that attributes estimated model costs to teams without depending on a particular organization's directory, ERP, or payment provider.

## Capabilities

- **CAP-1**
  - **intent:** Operators can define billing teams and attach repositories to them independently of GitHub teams.
  - **success:** A repository can be attached to more than one billing team, and the configured membership is available when a model call is recorded.
- **CAP-2**
  - **intent:** Graft can attribute each model call's spend to the billing teams responsible for its repository.
  - **success:** The call's cost is split equally across the repository's billing teams, and that allocation remains unchanged after membership changes; calls from repositories with no team appear in a visible `unattributed` account.
- **CAP-3**
  - **intent:** Each team can inspect its monthly estimated spend by repository, model, and token usage.
  - **success:** The statement shows USD estimates and token counts by model, including input, output, and cache usage; unpriced calls are visible and prevent close.
- **CAP-4**
  - **intent:** Operators can export team statements for reconciliation.
  - **success:** The console can export the same statement data as CSV and JSON.
- **CAP-5**
  - **intent:** Operators can close a billing month and correct errors without rewriting a closed statement.
  - **success:** A closed month is immutable; corrections are represented as adjustment lines in a later month, and a month with unpriced calls cannot be closed.

## Constraints

- The feature is for internal team chargeback, not customer billing, and must remain generic for open-source deployments.
- Use USD and estimated costs from a versioned price grid; do not treat the estimate as the provider's authoritative invoice.
- Freeze repository membership and equal-share allocation for each call when that call is recorded. Later membership changes are not retroactive.
- Preserve spend history when a repository is purged.
- Close months automatically in UTC. If unpriced calls exist, leave the month open until they can be priced.
- Only authenticated console users with administrator permission on the affected repositories can change repository-to-team memberships.
- Round allocated amounts to cents while assigning any remainder deterministically and preserving the rounded total.
- Do not silently treat missing model prices as zero; prevent monthly close while affected calls remain unpriced.

## Non-goals

- Collecting payments, issuing invoices to external customers, or integrating with an ERP or payment provider.
- Replacing or changing how model providers bill Graft's operator.
- Importing provider invoices or reconciling actual charges; invoice comparison is deferred.

## Success signal

A month can be closed with a complete USD statement for every billing team and the unattributed account. For every model call, the displayed allocations sum to its rounded estimate, the membership snapshot is unchanged by later edits, CSV and JSON exports match the console totals, and unpriced calls prevent close.

## Resolved Decisions

- Calls without a known per-token price (including subscription-funded, organization-paid, and local models) remain explicitly unpriced; they are never assigned a zero-dollar cost and prevent period close.
- A future invoice comparison is deferred; the current statement is an estimate, not a provider invoice.
- Token and cent remainders go to billing-team IDs in ascending lexical order.
- Billing ledger and closed statement rows are retained after a repository purge. A separate expiry policy is not implemented.
