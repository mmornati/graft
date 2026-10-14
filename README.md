# Graft

Graft is a GitHub App and service that adds intent review and policy checks to agent-written pull requests. This repo holds the service; step 1 is the base skeleton (webhook intake, job queue, installation tracking).

See the [MVP spec](docs/spec/mvp-spec.md), the [development plan](docs/plan/development-plan.md) and the [Phase 0 steps](docs/phase-0/README.md).

## 1. Prerequisites

- Node 24 (`.nvmrc`), pnpm 11
- Docker (OrbStack works) for Postgres

## 2. Quick start (offline)

Only `pnpm install` and the Docker image pull need the network.

```sh
pnpm install
pnpm db:up                       # Postgres 17 on localhost:55432
cp .env.example .env
openssl genrsa -out dev.pem 2048 # throwaway key so the server boots without a real App
pnpm db:migrate
pnpm dev:server                  # terminal 1
pnpm dev:worker                  # terminal 2
pnpm webhook:send installation.created --delivery smoke-1   # 202 {"status":"enqueued"}
pnpm webhook:send installation.created --delivery smoke-1   # 200 {"status":"duplicate"}
psql postgres://graft:graft@localhost:55432/graft \
  -c 'select id, account_login from installations' \
  -c 'select id, full_name, removed_at from repositories'
curl localhost:3000/readyz
```

`.env.example` already points `GITHUB_APP_PRIVATE_KEY_PATH` at `./dev.pem`. Neither process runs migrations; if the schema is behind they exit with `run pnpm db:migrate`.

Other scripts: `pnpm db:status`, `pnpm db:rollback`, `pnpm format`, `pnpm build` then `pnpm start:server` / `pnpm start:worker`.

## 3. Tests

```sh
pnpm test:unit          # nothing needs to be running
pnpm db:up && pnpm test:integration   # real Postgres + real pg-boss
pnpm test               # both
```

Integration tests use `TEST_DATABASE_URL` (default `postgres://graft:graft@localhost:55432/graft_test`). `test/global-setup.ts` drops and recreates `graft_test` on every run, then migrates. If Postgres is not reachable it fails with `Postgres not reachable at <host:port>; run pnpm db:up`. A network guard (`test/setup.ts`) makes any `fetch` to a non-localhost host throw, and GitHub is only ever reached through injected fakes. Test names carry the IDs from the step spec (`U-WH-3`, `I-INST-5`, ...), so `grep -rn "I-WH-" test/` finds them.

Fixtures in `test/fixtures/webhooks/` come from `@octokit/webhooks-examples`, rewritten to one fictional world (`scripts/generate-fixtures.ts`).

## 4. Connecting a real GitHub App

1. Edit `github/app-manifest.json` (name, `url`, `hook_attributes.url`). Create a channel at <https://smee.io/new> and use its URL as the hook URL.
2. Serve `github/register-app.html` (for example `cd github && python3 -m http.server 8080`, then open <http://localhost:8080/register-app.html>), enter the org name and submit. GitHub redirects to `redirect_url` with `?code=...`.
3. Convert the code: `gh api -X POST /app-manifests/<code>/conversions`. The response has the App `id`, `pem` and `webhook_secret`.
4. Put the PEM in a file outside the repo and fill `.env`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`; also set `SMEE_URL`.
5. Run `pnpm tunnel` (smee) next to `pnpm dev:server` and `pnpm dev:worker`, then install the App on a sandbox org.

`gh webhook forward` does **not** work for GitHub App webhooks (it only supports repository and organization webhooks). Use smee, or ngrok / cloudflared pointed at `http://localhost:3000/webhooks/github`.

## 5. Architecture

```
GitHub ──POST /webhooks/github──▶ server (Fastify)
                                   │ verify HMAC → INSERT webhook_deliveries ON CONFLICT DO NOTHING
                                   │ + send `github.webhook` job (same transaction)
                                   ▼
                              Postgres (app tables + pgboss schema)
                                   ▲
worker (pg-boss) ── github.webhook job ──▶ handlers registered by modules
```

**How later steps plug in.** Each feature is a folder `src/modules/<name>/` whose `index.ts` exports `webhookHandlers: WebhookHandler[]` and `jobs: JobDefinition[]`. `src/app/registry.ts` is the only file that lists modules. Expected additions: `modules/provenance` (step 2), `modules/intent` plus `src/llm/` holding the model-client interface and its fake (step 3), `eval/` with `src/bin/eval.ts` (step 4), `modules/policy` (step 5), `modules/pilot` with `scripts/pilot/` (step 6), and `src/mcp/` (Phase 1). Modules import from `config`, `core`, `db`, `github`, `queue` and `webhooks`. They import another module only through its `index.ts`, never its internals.

**Contracts.**

- Webhook handlers must be idempotent, because a failed job retries every handler for that delivery. They must also be fast: DB writes, or enqueueing a follow-up job with `ctx.queue.send(...)`. Slow work such as LLM calls or many GitHub API calls goes into its own `JobDefinition`.
- Deliveries can be processed out of order and concurrently (`WORKER_CONCURRENCY`, retries with backoff, and GitHub itself does not order them), so handlers must tolerate reordering. For order-sensitive state, compare the head SHA or the payload's timestamp and ignore stale events, or use a `key_strict_fifo` queue keyed by installation or PR. Step 1's installation handlers are idempotent but not order-proof (for example a late `added` after `deleted`).
- Code that would persist file contents, diffs or patches does not pass review. Only paths, SHAs, numbers and model prose go in the DB.

Layout: `src/config` (env), `src/core` (clock, logger, context), `src/db` (Kysely, migrations), `src/queue` (pg-boss wrapper, worker), `src/webhooks` (receiver, registry, dispatch job), `src/github` (Octokit factory, the only place an Octokit is built), `src/http`, `src/modules`, `src/bin` (entry points).

## 6. GitHub App permissions

`github/app-manifest.json` is the source of truth; `test/unit/manifest.test.ts` pins it. Changing a permission means updating the test and this table together.

| Permission / event | Level | Phase 0 use |
| --- | --- | --- |
| `metadata` | read | Mandatory for every App; repository listing. |
| `contents` | read | Read `graft.yaml` (step 5) and commit data for trailers (step 2). |
| `issues` | read | Read the linked issue for the intent writer (step 3). No write: comments go through `pull_requests: write`. |
| `pull_requests` | write | Read PRs, files, diffs, commits and reviews (steps 2, 3, 6). Write is only for creating and updating the pinned card comment, since the issue-comments API accepts `pull_requests: write`. |
| `checks` | write | Create `graft/intent` and `graft/policy` check runs (steps 3 and 5). |
| `pull_request` event | — | Trigger provenance, intent and policy on opened, synchronize, reopened, edited and closed. |
| `check_run` event | — | `rerequested` re-runs our checks. |
| `installation`, `installation_repositories` | — | Delivered to every App without a subscription; drive the installations module. |

**Deferred** (not requested in Phase 0):

- `members: read` (team approvals, Phase 1).
- `contents: write` (revert branches and PRs, Phase 1).
- `statuses: read` and `actions: read`, plus the `push`, `status`, `workflow_run` and `check_suite` events (post-merge guard, Phase 1).
- The `pull_request_review` event (approval counting, Phase 1).
- `administration`: never.

Comment reactions (thumbs-up/down, step 3) have no webhook, so step 3 polls them using `pull_requests: read`.

## 7. Decisions and library versions

Choices from the step spec: Node 24 ESM, strict TypeScript (NodeNext, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `tsx` for dev, Biome for lint and format, Vitest with `unit` and `integration` projects, Fastify, Kysely with `pg` and a static migration provider, `pg-boss` in schema `pgboss`, `pino` with redaction, Postgres 17 on port 55432, GitHub numeric IDs as `bigint` keys (parsed to `number`, throwing above 2^53), `smee-client` for the dev tunnel.

Versions in the lockfile (majors): Fastify 5, Kysely 0.29, pg 8, **pg-boss 12**, pino 10, zod 4, `@octokit/app` 16, `@octokit/rest` 22, `@octokit/webhooks` 14, `@octokit/webhooks-methods` 6, `@octokit/webhooks-examples` and `-schemas` 7, TypeScript 7, Vitest 5, Biome 2, tsx 4, ajv 8, smee-client 5.

### Deviations and additions relative to the step spec

- **pg-boss is v12, not v10.** The assumed API held with these differences: queue and job retry delay is `retryDelay` (seconds), not `retryDelaySeconds` (our `JobDefinition.options.retryDelaySeconds` is mapped to it); retention is `deleteAfterSeconds` (set to 7 days on every queue); `work()` takes `{ localConcurrency, batchSize }` and a handler over `Job[]`; the transaction option is `db` with an `executeSql(text, values)` adapter (type exported as `Db`), which is what `createPgBossQueue` builds from a Kysely transaction. `start()` installs/migrates its own schema, so the server and worker both call it. Defaults when a job sets no options: `retryLimit 5`, `retryBackoff true`, `retryDelay 10`, `expireInSeconds 300`. They are applied as queue options in `createQueue`. Queue options are re-applied with `updateQueue` on every start, because `createQueue` does nothing for an existing queue (I-Q-3).
- **`singletonKey` does not deduplicate on pg-boss v12 standard queues.** Since v10 the key is only enforced by queue policies `short`, `singleton`, `stately`, `exclusive`, `key_strict_fifo` (or together with `singletonSeconds`); on our `standard` queues it is stored and ignored. `JobQueue.send(..., { singletonKey })` therefore also sets a deterministic job `id` (UUIDv5-style SHA-1 of job name and key; `singletonJobId` in `src/queue/queue.ts`). pg-boss inserts with `ON CONFLICT DO NOTHING`, so a second send with the same name and key inserts nothing and `send` returns `null` (I-Q-2). **The window covers queued, active, completed and failed jobs until they are deleted, 7 days after completion or failure (`deleteAfterSeconds`).** A caller that needs a re-run (for example a `check_run.rerequested` for the same SHA) must use a different key, such as one that includes an attempt number or a timestamp. A `null` return means "already enqueued". For webhooks the `webhook_deliveries` primary key is the first line of defence; if the job send returns `null` (job exists, delivery row gone) the existing job id is stored and the outcome is `duplicate`.
- **Empty body returns 400 before signature verification** (spec deviation: the spec has no empty-body rule). It is a cheap check that needs no secret and touches no state; GitHub never sends an empty body (U-WH-8). A delivery id over 100 characters also returns 400 (U-WH-7).
- **Permanent failures are retried** up to `retryLimit`; a non-retryable error type is deferred to a later step. Job data validation runs inside the logged `try`.
- **Kysely 0.29** exports `Migrator` from `kysely/migration`.
- **zod 4**: `z.ZodType<T>` works as in the spec; config defaults are applied before validation (string form).
- **Fastify 5.12**: `disableRequestLogging` is deprecated in favour of `LogController`, which `buildServer` uses (request logging is off; the receiver logs its own outcome line).
- **`githubWebhookJob` is built by a factory.** The job needs the registry's handler lookup and the registry lists the job, so `createRegistry` builds it with `createGithubWebhookJob(registry)` and exposes it as `registry.webhookJob` (also present in `registry.jobs`). The receiver sends `registry.webhookJob`.
- `createPgBossQueue` returns `PgBossJobQueue` (a `JobQueue` plus the `boss` instance the worker needs) and takes a `supervise` flag (false for the server, true for the worker). `buildServer` is `async` and returns the instance without listening.
- Store functions (`getActiveRepository`, `listActiveRepositories`, ...) take a Kysely `Db` or `Transaction` as their first argument.
- Extra files not in the layout: `src/bin/bootstrap.ts` and `src/bin/env.ts` (shared wiring), `scripts/generate-fixtures.ts` (how the fixtures were produced), `pnpm-workspace.yaml` (pnpm 11 build-script allowlist for esbuild), `test/helpers/app.ts`, `test/helpers/stubs.ts`.
- The upstream webhook examples are older than `@octokit/webhooks-schemas` and contain no merged `pull_request.closed`; the generator repairs missing required fields with neutral values and marks the closed PR as merged so all fixtures validate (U-FIX-1).

## 8. Troubleshooting

- **401 `invalid signature`**: `GITHUB_WEBHOOK_SECRET` differs from the App's webhook secret (or from the one `pnpm webhook:send` reads from `.env`).
- **Duplicate deliveries**: GitHub redelivers on timeouts; the second delivery with the same `X-GitHub-Delivery` returns `200 {"status":"duplicate"}` and enqueues nothing. A delivery that failed with 500 is rolled back, so redelivering it is processed normally.
- **Port 55432 already in use**: another process holds it; stop it or change the host port in `docker-compose.yml` and `DATABASE_URL` / `TEST_DATABASE_URL`.
- **`run pnpm db:migrate`** on startup: the schema is behind; run the migration.
- **`Postgres not reachable ... run pnpm db:up`** from the integration tests: start the container.
