# Step 1 review 1

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted working tree against [step-1-base-setup.md](../step-1-base-setup.md) and the [Phase 0 constraints](../README.md).

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | ok (lockfile up to date) |
| `pnpm db:up` | ok, container healthy on 55432 |
| `pnpm lint` | ok, 61 files, no fixes |
| `pnpm typecheck` | ok |
| `pnpm test` | 14 files, 56 tests, all pass (about 5 s). No skipped or `todo` tests. |
| `pnpm build` | ok |
| `cp .env.example .env && openssl genrsa -out dev.pem 2048` | ok |
| `pnpm db:migrate` twice | second run prints `no pending migrations` |
| `pnpm db:rollback`, `db:status`, `db:migrate` | rollback drops `0001_initial`, status shows `pending`, up re-applies it; the `pgboss` schema survives |
| Manual smoke test (server and worker, `webhook:send installation.created --delivery smoke-N` twice) | `202 {"status":"enqueued"}` then `200 {"status":"duplicate"}`; one `installations` row, two `repositories` rows; `/readyz` 200; `/healthz` 200 with version; unknown route 404 JSON |
| SIGINT to both processes | both log `shutting down` and exit in under 1 s |
| pg-boss queue row for `github.webhook` | `retry_limit 5`, `retry_delay 10`, `retry_backoff true`, `expire_seconds 300`, `deletion_seconds 604800`, as specified |

Extra probes against the running server: `application/json; charset=utf-8` is accepted. A JSON array body gives 400. Uppercase hex signatures and an empty body give 401. A delivery ID over 100 characters gives 500 (see 4). An installation ID above 2^53 is stored with lost precision (see 9). A malformed `installation` payload goes into the retry loop (see 5).

Every test ID from §8 is present (33 unit, 22 integration) and the tests assert what they claim. None are tautological. Some good details: I-INST-2 changes the clock between runs, U-WH-1/2 use a DB proxy that throws when touched, I-WH-3 really runs five concurrent transactions, I-Q-1 checks both rollback and commit, and U-GH-1 verifies the JWT signature with the public key.

## Assessment of the reported deviations

- **pg-boss v12 instead of v10.** Using the current major is fine, and most of the mapping is right: `retryDelay`, `deleteAfterSeconds`, `localConcurrency`/`batchSize`, the `db` adapter, and both processes calling `start()`. One part is not: `singletonKey` no longer means what the interface promises (finding 1).
- **Newer TypeScript, zod, Vitest, Kysely and Biome.** Fine. Everything builds, typechecks and tests on these versions, and the README records them.
- **Webhook job built by a factory from the registry (`registry.webhookJob`).** Sound. It breaks the circular dependency cleanly, the job is still in `registry.jobs`, and the receiver gets it from the registry rather than importing a module-level constant. Keep it.
- **Interface additions** (`PgBossJobQueue.boss`, the `supervise` flag, async `buildServer`, store functions taking an executor first). All sound. Taking the executor first is better than the spec's `getActiveRepository(id)`, because later modules can call these functions inside their own transactions.
- **Fixture-repair script.** Sound, and better than hand-edited fixtures. Repairs are neutral, U-FIX-1 validates the output, and no upstream identities or tokens remain (I grepped logins, hosts and `ghs_`).
- **Extra bootstrap files** (`bin/bootstrap.ts`, `bin/env.ts`, test helpers, `pnpm-workspace.yaml`). Fine. They remove duplication between the server and the worker.
- **Async network guard.** Fine. `fetch` already reports failure by rejecting, so a guard that rejects behaves the same for callers, and U-NET-1 asserts the exact message.

## Findings

### 1. major: `singletonKey` silently does nothing on pg-boss v12 standard queues

`src/queue/queue.ts:111`, `src/webhooks/deliveries.ts:58-60`

**Problem.** Since pg-boss v10, `singletonKey` only deduplicates jobs on queues whose policy is `short`, `singleton`, `stately`, `exclusive` or `key_strict_fifo` (unique indexes `job_i1`–`job_i6`), or when it is combined with `singletonSeconds`. `createQueue` here uses the default `standard` policy, so the key is stored but nothing enforces it. I confirmed this against the dev database: two `queue.send(webhookJob, data, { singletonKey: "same-key" })` calls returned two different job IDs, and neither returned `null`.

- **Step 1 is unaffected.** The `webhook_deliveries` primary key does the deduplication, which is correct. But the `jobId === null` branch in `deliveries.ts:60` ("singleton conflict") can never run, so the code says the key does something it does not.
- **Later steps depend on it.** `JobQueue.send(..., { singletonKey })` is one of the §5 interfaces later steps rely on. The §5 contract also says handlers must be idempotent because a failed job reruns every handler, and that slow work goes into follow-up jobs sent with `ctx.queue.send`. Step 3's intent handler will naturally send `intent.generate` with `singletonKey: repo:pr:sha` to stay idempotent, and with this implementation every retry creates another LLM job and another PR comment.
- **The README is wrong.** It says the v12 API "held with these differences" and does not mention this one.

**Required fix.** Make `singletonKey` actually deduplicate, or remove it from the interface. Either way, add an integration test (for example `I-Q-2`): two `send` calls with the same `singletonKey` give one job, and the second returns `null`. Options:

- (a) Derive a deterministic job `id` from `(job.name, singletonKey)`, for example a UUIDv5. pg-boss inserts with `ON CONFLICT DO NOTHING` and returns `null` on a conflict. Check that this holds in v12 and pick the retention window you want.
- (b) Give queues an explicit policy, such as `short` (at most one queued job per key) or `stately`, and document what it means for each job.

Whichever you pick, update the `deliveries.ts:60` branch so it matches the real behaviour, and record the v12 difference in the README's deviations list.

### 2. minor (optional): queue options are only applied when a queue is first created

`src/queue/queue.ts:86-96`

In v12, `create_queue` is `INSERT ... ON CONFLICT DO NOTHING`. Changing `JobDefinition.options` (for example `retryLimit`) or `deleteAfterSeconds` after the first deploy has no effect on an existing queue, and nothing reports it. The spec only asks for idempotent creation, so this is not required now. Suggested fix: after `createQueue`, call `boss.updateQueue(name, options)` (or compare with `getQueue` and update), and test that a changed option is applied on the next start.

### 3. minor (optional): retried installation events overwrite `deleted_at` and `suspended_at`

`src/modules/installations/store.ts:118` and `:131`

T9 says processing the same event twice leaves the same state, apart from `updated_at`. On a retry, `installation.deleted` and `installation.suspend` set `deleted_at` or `suspended_at` to the new `now`. The tests use a fixed clock, so they cannot see this. `markRepositoriesRemoved` already guards with `removed_at IS NULL`. Do the same here (`COALESCE(deleted_at, now)`, or `WHERE deleted_at IS NULL`), or use the payload's timestamp. A test like I-INST-2 for `deleted` with two different clocks would cover it.

### 4. minor (optional): a delivery ID over 100 characters returns 500

`src/webhooks/receiver.ts:50`, with the CHECK constraint in `src/db/migrations/0001_initial.ts`

A delivery ID longer than 100 characters violates the CHECK constraint, so the request gets a 500 and the error is logged with the pg `detail`, which contains the row. GitHub always sends UUIDs, and the request must already carry a valid signature, so the impact is low. Suggested fix: validate the length together with the header checks and return 400.

### 5. minor (optional): permanent failures are retried 5 times

`src/queue/worker.ts:18`, `src/modules/installations/handlers.ts:42`

A job whose data fails `schema.parse`, or a payload that can never be processed ("installation payload has no account"), is retried with backoff until the retries run out. `schema.parse` also runs outside the `try`, so that failure is never logged with job context. Suggested fix: move the parse inside the `try`. Later, consider a non-retryable error type that the worker completes or fails without retrying.

### 6. minor (optional): events can be processed out of order

`src/queue/worker.ts:13`, `src/modules/installations/handlers.ts`

With `localConcurrency: 5` and retries with backoff, deliveries for the same installation can run out of order. For example, an `installation_repositories.removed` processed before the `added` for the same repository leaves it active, and a late retry of `added` after `installation.deleted` reactivates repositories. GitHub does not guarantee ordering either. This is acceptable for step 1, but step 2's `pull_request.synchronize` handling will hit the same problem. Write the strategy down now (a `key_strict_fifo` queue keyed by installation or PR, or comparing `updated_at` / head SHA in handlers).

### 7. minor (optional): log redaction paths do not match the config field names

`src/core/logger.ts:6-12`

`*.privateKey` and `*.webhookSecret` follow the spec literally, but the `Config` fields are `githubAppPrivateKey` and `githubWebhookSecret`. If anyone logs `{ config }`, the key and secret are written in clear. No code logs the config today. Add `*.githubAppPrivateKey`, `*.githubWebhookSecret` and `*.databaseUrl`, which contains the DB password.

### 8. minor (optional): `migrate.ts` needs the full app config

`src/bin/migrate.ts:13`

Migrations only need `DATABASE_URL`, but `loadConfig` also requires the GitHub App key and webhook secret. A deploy-time migration job would therefore need App secrets it has no use for. Suggested fix: validate only `DATABASE_URL` in `migrate.ts`.

### 9. nit: IDs above 2^53 lose precision without an error

`src/webhooks/receiver.ts:30-33`

`JSON.parse` has already rounded the value by the time `numericId` checks it. The receiver stores `NULL`, but the job payload carries the rounded ID and the handler writes it: I stored `9007199254740992` for `...993`. Every later read through `createDb` then throws. This is not realistic for GitHub IDs, and the spec accepts the `number` choice. I mention it only so the `bigint` decision covers the write path as well as the read path.

### 10. nit: small items

- An empty body with a valid signature returns 401 instead of 400, because `verify` throws on an empty payload (`receiver.ts:61-65`).
- `webhookReceiver` logs with `deps.log.child` and is not part of Fastify's request logging. That is fine, but the global `bodyLimit` of 25 MB also applies to the GET routes. Only the webhook route needs it.
- In `docs/phase-0/HUMAN-TODO.md:11-12`, the "Install the App" and "Add then remove `empty`" items do not say who does them (T16).
- `.github/workflows/ci.yml` pins actions by tag. Pinning by SHA is worth doing once the repository is public.
- `@octokit/webhooks` is a devDependency but its types are imported in `src/`. This works because the imports are type-only, but it breaks if someone later needs a runtime import.

## Security checklist

| Item | Status |
| --- | --- |
| Signature verified before parsing | Yes. Raw string parser, `verify` runs before `JSON.parse`, and U-WH-2 shows the DB and queue are never touched. |
| Constant-time compare | Yes. `@octokit/webhooks-methods` `verify` uses `timingSafeEqual`, and malformed headers return false without throwing (U-SIG-4). |
| Raw body | Yes. The route-scoped parser uses `parseAs: "string"`, and the global JSON parser is removed inside the encapsulated plugin. |
| Secrets in logs | None logged today. The signature header is redacted and the body is never logged. Redaction gap for config field names: finding 7. |
| Private key | Read from a file or env, never logged, `*.pem` gitignored, PEM shape checked, and ConfigError never echoes values (U-CFG-3). |
| Least privilege | The manifest matches T12 exactly and is pinned by U-MAN-1. |
| No code or diff columns | Yes. I-DB-4 passes. The full webhook payload is kept in `pgboss.job.data` for up to 7 days. It contains no diffs, but later steps must keep it that way. |
| SQL injection | None found. All queries go through Kysely parameters. The raw SQL is static DDL, or test setup with a regex-checked identifier. |
| Concurrent duplicate deliveries | Correct. `ON CONFLICT DO NOTHING` on the primary key inside one transaction, proven by I-WH-3. |
| Enqueue failure | Correct. The transaction rolls back, the request gets 500 with no delivery row, and a redelivery is processed (I-WH-5). |

## Fitness for later steps

The module, registry and job shapes are sound for provenance, intent and policy. Each module exports `webhookHandlers` and `jobs`, there is one registry file, jobs are validated on send and on receive, and `JobContext` carries everything a handler needs. Store functions that take an executor compose well with module transactions. The interface problem is finding 1: the idempotent follow-up-job pattern from the §5 contract needs a `singletonKey` that actually deduplicates. Findings 2, 5 and 6 are the next things steps 2 and 3 will run into.
