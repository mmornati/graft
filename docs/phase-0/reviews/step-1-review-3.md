# Step 1 review 3

Verdict: APPROVED

Reviewer: senior engineer (Opus). Scope: the uncommitted working tree after the fixes for [review 2](step-1-review-2.md).

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `db:up`, `lint`, `typecheck` | all ok (Biome checked 62 files) |
| `pnpm test` | 15 files, 63 tests, all pass |
| `pnpm build` | ok (`dist/bin/server.js` produced) |

The only code change since round 2 is in `src/webhooks/deliveries.ts`, together with new tests and README text. Round 2 already ran the manual smoke test on the same receiver and queue code and it passed, so I did not run it again.

## Verification of the round-2 findings

| # | Finding | Status |
| --- | --- | --- |
| 1 (major) | README must describe the queue deduplication and the ordering caveat | **Fixed.** §7 now says that `singletonKey` does not deduplicate on standard queues and that `JobQueue.send` uses a deterministic job ID. It names the deduplication window in bold: queued, active, completed and failed jobs are all covered until they are deleted, 7 days later. It also says a re-run needs a different key, what a `null` return means, and that a stale delivery row now stores the existing job ID. §5 Contracts now says deliveries can be processed out of order and concurrently, gives the ways to handle that, and says the installation handlers are not order-proof. §7 also records the empty-body 400 and the delivery-ID length check as deviations. |
| 2 | No test for the empty-body check | **Fixed.** U-WH-8 sends a correctly signed empty body. It asserts a 400 with `{error:"empty body"}`, that the stub DB that throws when touched was never called, and that nothing was queued. |
| 3 | A stale delivery row committed `enqueued` with `job_id` NULL | **Fixed.** On a `null` from `send`, the code now stores `singletonJobId(webhookJob.name, deliveryId)` as the job ID and returns `duplicate` (`deliveries.ts:60-70`). I-WH-6 enqueues a delivery, deletes the delivery row and redelivers. It then asserts a 200 `duplicate`, exactly one row whose `job_id` equals the original job ID, and still only one job. |
| 4 (nit) | No test for the redaction paths | **Fixed.** U-LOG-1 logs `{ config }` and asserts that the private key, the webhook secret and the database URL are absent and that `[redacted]` is present. |

## Findings

No blockers or majors. Two optional nits:

### 1. nit: U-LOG-1 builds its own pino instance

`test/unit/logger.test.ts`

The test builds a pino logger from `REDACT_PATHS` instead of calling `createLogger`. It therefore checks the path list but not that `createLogger` actually uses it. Today `createLogger` passes `REDACT_PATHS` straight through, so the risk is low. A stream parameter on `createLogger`, or a test of `createLogger` itself, would close the gap.

### 2. nit: I-WH-6 could assert that the first job ID exists

`test/integration/webhooks.test.ts:187`

The test reads `before` without checking it. If the first delivery somehow stored no job ID, `toBe(before)` would still pass with `null === null`. The 202 status and the job count make this unlikely. Adding `expect(before).toBeTruthy()` would make the test airtight.

Step 1 is ready to commit.
