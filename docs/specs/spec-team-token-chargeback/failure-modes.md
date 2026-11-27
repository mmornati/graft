# Billing failure modes

| Failure or dispute | Required handling |
| --- | --- |
| A model has no known price | Keep the call visible as unpriced; do not record a zero-dollar estimate or close a month containing it. |
| Pricing changes after a call | Keep the price version and estimate used at call time; do not recalculate closed periods. |
| A repository changes team membership | Use the membership snapshot recorded for each call; never reattribute historical calls. |
| A repository has no billing team | Report its spend in the visible unattributed account instead of silently assigning it. |
| A repository is purged | Preserve the immutable spend ledger, allocations, adjustments and closed statement rows; memberships are removed. `pilot_purges.rows_preserved` records retained-row counts. There is currently no expiry policy. |
| Equal division produces fractional cents | Round allocations to cents and place the remainder by ascending billing-team ID so allocation totals remain equal to the rounded call estimate. |
| A retry, refusal fallback, or regeneration uses tokens | Record every model call as a separate spend line so repeated work is visible and not collapsed into the surviving card. |
| A provider invoice differs from Graft's estimate | Label the amount as an estimate. Invoice import and comparison are non-goals and are not implemented. |
| A provider charges a subscription or has no token price | Keep the call visible as unpriced; do not imply that token counts are a provider invoice, and do not close its month. |
| A closed month needs correction | Keep the closed statement unchanged and add a traceable adjustment in a later month. |
