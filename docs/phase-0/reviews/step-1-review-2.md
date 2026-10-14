# Step 1 review 2

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted working tree after the fixes for [review 1](step-1-review-1.md).

The code changes are good. One required item from finding 1 of review 1 is still missing: the README was not updated. Its file timestamp is older than review 1, and it contains no mention of `singletonKey`, ordering or the empty-body check. That is the only thing blocking approval.

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `db:up`, `lint`, `typecheck` | all ok |
| `pnpm test` (verbose) | 14 files, 60 tests, all pass (up from 56). No skipped tests. |
| `pnpm build` | ok |
| `pnpm db:migrate` twice | second run prints `no pending migrations` |
| `pnpm db:status` with `GITHUB_WEBHOOK_SECRET` and `GITHUB_APP_ID` emptied | works, so migrations now need only `DATABASE_URL` (finding 8 verified) |
| Manual smoke test: server, worker, `webhook:send installation.created --delivery smoke2-N` twice | `202 {"status":"enqueued"}` then `200 {"status":"duplicate"}`. One `installations` row and two `repositories` rows. The delivery's `job_id` is a v5-shaped UUID (`8fb3d82e-46f4-57c9-...`) and that job reached `completed`. `/readyz` 200. |
| SIGINT to both processes | both exit cleanly in under 1 s, with no error logs from the worker |

Probes against the running server:

- No body, or an empty body with any signature: 400 `empty body`. The DB is not touched.
- A delivery ID of 101 characters: 400 `invalid delivery id`.
- I deleted the delivery row and redelivered the same ID: 200 `duplicate`, and no second job was created. This is the new dedup working, but see finding 3.

I removed the `.env`, `dev.pem` and probe rows I created.

## Verification of the round-1 findings

| # | Claim | Verified |
| --- | --- | --- |
| 1 | Deterministic job ID with `ON CONFLICT DO NOTHING`, plus test I-Q-2 | **Code yes, docs no.** `singletonJobId` hashes the job name and key, and `send` passes it as `id`. I-Q-2 really asserts the behaviour: a second send with the same key returns `null`, the job count stays 1, a different key creates a second job, and a send inside a transaction with the same key also returns `null`. The `deliveries.ts` branch now treats `null` as a duplicate. The required README update is missing (finding 1 below). |
| 2 | `updateQueue` on start, plus test I-Q-3 | Yes. I-Q-3 starts the queue with `retryLimit 2` and then `7`, reads `pgboss.queue.retry_limit` each time, and cleans up afterwards. |
| 3 | `coalesce` on `deleted_at` and `suspended_at`, plus test I-INST-2b | Yes. The test reprocesses each event with a different clock and asserts that the first timestamp is kept. Unsuspend still clears the value. |
| 4 | 400 for a long delivery ID, plus test U-WH-7 | Yes. The test uses the DB proxy that throws when touched and checks that nothing was queued. |
| 5 | Parse inside the `try` | Yes (`worker.ts:18-19`). The non-retryable error type is deferred, which is acceptable. |
| 6 | "Documented only" | **Not found.** No README or doc text mentions ordering. This is included in finding 1 below. |
| 7 | Redaction paths | Yes. `*.githubAppPrivateKey`, `*.githubWebhookSecret` and `*.databaseUrl` were added. No test covers them; that is optional. |
| 8 | `migrate.ts` needs only `DATABASE_URL` | Yes, verified by running it. |
| 9 | Skipped | Fine. It was a nit. |
| 10 | Mostly fixed | HUMAN-TODO items now say who does them. Empty body is now 400 (see below). SHA pinning of CI actions was skipped, which is fine. The global `bodyLimit` was removed from `buildServer`, so only the webhook route has the 25 MB limit. |

### Is 400 for an empty body before signature verification acceptable?

Yes.

- It is the same kind of check as step 3 of the spec (missing headers → 400 before `verify`). The check is cheap, needs no secret, touches no state, and tells the caller nothing they don't already know.
- GitHub never sends an empty body, so no valid delivery can be rejected by it.
- It also replaces the round-1 behaviour, where `verify` threw on an empty payload and the error was hidden behind a 401.
- It does not weaken the "verify before parse" rule, because nothing is parsed or stored.

Two things are missing: a named test, and a line in the README decisions (finding 2).

## Findings

### 1. major: the README does not describe the new queue behaviour or the ordering caveat

`README.md` §7 ("Deviations and additions"), §5 (Contracts)

**What's wrong.**

- Review 1 finding 1 required recording the pg-boss v12 `singletonKey` difference in the README. §7 still says the v12 API "held with these differences" and lists none of the dedup changes.
- The new behaviour has a consequence that later steps must know about. Deduplication now lasts as long as the job row exists, and that includes **completed and failed** jobs, until `deleteAfterSeconds` (7 days). Suppose step 3 sends `intent.generate` with `singletonKey: repo:pr:sha`. A user who clicks "Re-run" (`check_run.rerequested`) on a failed or finished card for the same SHA gets `null` back, and nothing runs for 7 days. Today this is only stated in a code comment in `queue.ts`.
- The developer said review 1 finding 6 (ordering) was "documented only", but I found no such text anywhere.

**Required fix.** Add to README §7:

- pg-boss v12 `singletonKey` only deduplicates on non-standard queue policies.
- `JobQueue.send` gives it real deduplication through a deterministic job ID.
- The dedup window covers queued, active, completed and failed jobs until they are deleted (7 days after completion).
- A caller that wants a re-run must use a different key, for example by adding an attempt number or a timestamp.

Add to the README Contracts paragraph (§5): deliveries can be processed out of order and concurrently, so handlers must tolerate reordering. Point to the options from review 1 finding 6. Also record the empty-body 400 (finding 2) in §7.

### 2. minor (optional): the empty-body check has no named test

`src/webhooks/receiver.ts:66-70`, `test/unit/webhook-receiver.test.ts`

The behaviour is correct (see the assessment above), but no test asserts it. Suggested fix: add U-WH-8. An empty body with the headers present should give 400, with the DB proxy untouched and nothing queued.

### 3. minor (optional): a `null` from the dedup path commits a delivery row that says `enqueued` with no `job_id`

`src/webhooks/deliveries.ts:60-62`

When the delivery row is gone but the job still exists, `send` returns `null` and the function returns `"duplicate"`. The transaction still commits the freshly inserted row with `status = 'enqueued'` and `job_id = NULL`. I reproduced this by deleting a delivery row and redelivering. It cannot happen in step 1, since nothing prunes delivery rows, but it would leave a row whose status is false once pruning exists. Suggested fix: either look up and store the existing job ID (`singletonJobId(name, deliveryId)`), or throw and roll back so the row isn't written. Rolling back would turn every later redelivery into a 500, so storing the existing ID is the better option.

### 4. nit: no test for the new redaction paths

`src/core/logger.ts:6-15`

A one-line unit test would stop the paths from drifting away from the `Config` field names again: log `{ config }` to a stream and assert that the key, the secret and the DB URL are censored.

## Fitness for later steps

The queue now honours the `singletonKey` contract that later steps rely on, queue options follow the code, and the installation handlers are idempotent under retry. Once the README states the dedup window and the ordering caveat, I expect to approve.
