# Phase 0, Step 1: Base setup

Spec for the developer agent. Implement exactly this. Where this spec is silent, choose the simplest option and record it in the README's "Decisions" section. The [Phase 0 README](README.md) constraints are binding: offline build and test, Postgres from `docker compose`, no stored code, pnpm, Node 24, strict TypeScript.

## 1. Goal

Set up a running, tested skeleton of the Graft service that later steps can add features to without changing its structure:

- an HTTP server that verifies GitHub webhooks, skips duplicate deliveries and turns each event into a job;
- a `pg-boss` worker that sends jobs to handlers registered by feature modules;
- Postgres tables for the whole MVP data model;
- an installation module that tracks installed repositories;
- a GitHub App manifest with least-privilege permissions for all of Phase 0;
- CI, local development tooling and docs, plus the list of tasks only a human can do.

## 2. Out of scope

Leave all of these to later steps. Do not create stub code for them.

- Parsing provenance trailers, intent cards, LLM calls, `graft.yaml`, policy evaluation and any check runs or PR comments (steps 2–5).
- Handling `pull_request` and `check_run` events. They are subscribed in the manifest, but in step 1 no handler exists for them, so they are recorded as `ignored`.
- An installation reconcile job that lists installations through the API. Nothing in step 1 calls the GitHub REST API at runtime; the client factory exists and is tested only.
- MCP server, post-merge guard logic, team-membership approvals (Phase 1).
- Pruning old `webhook_deliveries` rows or old jobs, apart from pg-boss's own retention setting.
- Deployment (Fly.io, Render), Dockerfile for the app, Octokit retry/throttling plugins.
- Registering the real App, creating the sandbox org or getting secrets. These go in `HUMAN-TODO.md` only.

## 3. Decisions

| Area | Choice | Rationale |
| --- | --- | --- |
| Runtime | Node 24, ESM (`"type": "module"`), `.nvmrc` = `24` | Required by the README; native `fetch`, `process.loadEnvFile`. |
| Language | TypeScript, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `module`/`moduleResolution` = `NodeNext`, `target` = `ES2024` | Strict as required; NodeNext matches what Node actually runs. |
| Dev runner | `tsx` | Runs TS directly in dev and scripts; `tsc` builds `dist/` for prod. |
| Lint and format | Biome (`biome ci` in CI) | One fast tool for lint and format, with no plugin setup. |
| Tests | Vitest with two projects, `unit` (no DB) and `integration` (Postgres) | Fast and native to TypeScript; `pnpm test:unit` needs nothing running. |
| HTTP | Fastify 5 | Mature, gives a raw body per route, and `inject()` tests without a socket. |
| Webhook verification and types | `@octokit/webhooks-methods` (`verify`) and the `@octokit/webhooks` types (`EmitterWebhookEvent`, `EmitterWebhookEventName`) | Timing-safe HMAC check and typed payloads, without its in-process emitter (we queue instead). |
| GitHub client | `@octokit/app` with `@octokit/rest` as its Octokit class | Handles JWTs, installation tokens and token caching; the REST client is typed. |
| Config | `zod` | Validates and types env vars in one place. |
| `.env` loading | `process.loadEnvFile()` in `src/bin/*` only, ignoring ENOENT | No dotenv dependency; tests never read `.env`. |
| DB access | `kysely` with the `pg` driver; hand-written `Database` interface | Typed queries without codegen; one tool for queries and migrations. |
| Migrations | Kysely `Migrator` with a static `MigrationProvider` (a map in `src/db/migrations/index.ts`); SQL written with `sql\`...\`` | No filesystem scanning (works the same in tsx and `dist/`), and the SQL stays reviewable. |
| Queue | `pg-boss` (current major, v10+), schema `pgboss` | Required by the plan; on the same Postgres, so receipt and enqueue share one transaction. |
| Logging | `pino` (Fastify's logger), with redaction | Structured logs; secrets and signatures never logged. |
| Postgres | `postgres:17-alpine` via `docker compose`, host port `55432` | Supports `gen_random_uuid()` and `UNIQUE NULLS NOT DISTINCT`; the unusual port avoids clashing with a local Postgres. |
| IDs | GitHub numeric IDs (`bigint`) as PKs for `installations` and `repositories`; `uuid` for Graft entities | The GitHub ID is the natural key; Graft rows need no external meaning. |
| `bigint` parsing | `pg.types.setTypeParser(20, …)` returns a `number`, and throws if the value is above `Number.MAX_SAFE_INTEGER` | GitHub IDs fit in 2^53; avoids handling string IDs everywhere. |
| Tunnel | `smee-client` (dev dependency) behind `pnpm tunnel` | `gh webhook forward` only supports repo and org webhooks, not GitHub App webhooks. |

Pin exact versions in the lockfile and list the major versions you used in the README. If the current pg-boss major has a different API from the one assumed here (`createQueue`, `send(name, data, { db })`, `work(name, opts, handler(jobs[]))`), keep the same behaviour and note the differences in the README.

## 4. Directory layout

```
.
├── .github/workflows/ci.yml
├── .env.example
├── .nvmrc
├── biome.json
├── docker-compose.yml
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json              # typecheck: src, test, scripts, vitest.config.ts
├── tsconfig.build.json        # build: src only → dist/
├── vitest.config.ts           # projects: unit, integration
├── README.md                  # local dev guide
├── github/
│   ├── app-manifest.json      # GitHub App manifest (source of truth for permissions)
│   └── register-app.html      # static page that POSTs the manifest to GitHub
├── scripts/
│   └── send-webhook.ts        # signs a fixture and POSTs it to the local server
├── src/
│   ├── bin/
│   │   ├── server.ts          # HTTP process
│   │   ├── worker.ts          # pg-boss worker process
│   │   └── migrate.ts         # `up` | `down` | `status`
│   ├── config/index.ts        # loadConfig(env) → Config
│   ├── core/
│   │   ├── clock.ts           # Clock interface + systemClock
│   │   ├── logger.ts          # createLogger(config) with redaction
│   │   └── context.ts         # JobContext, AppDeps types
│   ├── db/
│   │   ├── client.ts          # createDb(url) → Db (Kysely<Database>), bigint parser
│   │   ├── schema.ts          # Database interface (one interface per table)
│   │   ├── migrator.ts        # createMigrator(db), migrateToLatest, migrateDown
│   │   └── migrations/
│   │       ├── index.ts       # static provider: { "0001_initial": m0001 }
│   │       └── 0001_initial.ts
│   ├── github/
│   │   └── client-factory.ts  # GitHubClientFactory + createGitHubClientFactory
│   ├── queue/
│   │   ├── job.ts             # JobDefinition, defineJob
│   │   ├── queue.ts           # JobQueue interface + createPgBossQueue
│   │   └── worker.ts          # startWorker(queue, registry, ctx)
│   ├── webhooks/
│   │   ├── handler.ts         # WebhookHandler, defineWebhookHandler
│   │   ├── registry.ts        # createRegistry({ webhookHandlers, jobs })
│   │   ├── receiver.ts        # Fastify plugin: POST /webhooks/github
│   │   ├── deliveries.ts      # recordDelivery (dedupe insert) in a transaction
│   │   └── dispatch-job.ts    # the `github.webhook` JobDefinition
│   ├── http/
│   │   ├── server.ts          # buildServer(deps) → FastifyInstance (not listening)
│   │   └── health.ts          # /healthz, /readyz
│   ├── modules/
│   │   └── installations/
│   │       ├── index.ts       # exports { webhookHandlers, jobs }
│   │       ├── handlers.ts
│   │       └── store.ts       # upsertInstallation, upsertRepositories, markRepositoriesRemoved, …
│   └── app/
│       └── registry.ts        # THE list of modules; buildAppRegistry()
├── test/
│   ├── setup.ts               # network guard (blocks non-localhost fetch)
│   ├── global-setup.ts        # (integration) recreate graft_test DB, run migrations
│   ├── fixtures/webhooks/*.json
│   ├── helpers/
│   │   ├── fixtures.ts        # loadFixture(name) → { event, payload, body }
│   │   ├── sign.ts            # sign(body, secret) → "sha256=…"
│   │   ├── db.ts              # testDb(), truncateAll()
│   │   ├── config.ts          # testConfig(overrides) with a generated RSA key
│   │   ├── fake-queue.ts      # FakeJobQueue recording sends
│   │   └── fake-github.ts     # fake fetch for Octokit
│   ├── unit/**.test.ts
│   └── integration/**.test.ts
└── docs/phase-0/
    ├── step-1-base-setup.md   # this file
    └── HUMAN-TODO.md
```

**How later steps plug in.** Each feature is a folder `src/modules/<name>/` whose `index.ts` exports `webhookHandlers: WebhookHandler[]` and `jobs: JobDefinition[]`. `src/app/registry.ts` is the only file that lists modules. Expected additions: `modules/provenance` (step 2), `modules/intent` plus `src/llm/` holding the model-client interface and its fake (step 3), `eval/` with `src/bin/eval.ts` (step 4), `modules/policy` (step 5), `modules/pilot` with `scripts/pilot/` (step 6), and `src/mcp/` (Phase 1). Modules import from `config`, `core`, `db`, `github`, `queue` and `webhooks`. They import another module only through its `index.ts`, never its internals.

## 5. Interfaces later steps rely on

Keep these names and shapes. You may add fields; do not remove or rename any.

```ts
// core/clock.ts
export interface Clock { now(): Date }

// core/context.ts
export interface JobContext {
  db: Db; queue: JobQueue; github: GitHubClientFactory; log: Logger; clock: Clock; config: Config;
}
export interface AppDeps extends JobContext { registry: Registry }

// queue/job.ts
export interface JobDefinition<T> {
  name: string;                                  // dotted, e.g. "github.webhook", "intent.generate"
  schema: z.ZodType<T>;                          // validated on send AND on receive
  options?: { retryLimit?: number; retryDelaySeconds?: number; retryBackoff?: boolean; expireInSeconds?: number };
  handle(data: T, ctx: JobContext): Promise<void>;
}
export function defineJob<T>(def: JobDefinition<T>): JobDefinition<T>;

// queue/queue.ts
export interface JobQueue {
  start(): Promise<void>;                        // boss.start() + createQueue for every registered job
  stop(): Promise<void>;
  send<T>(job: JobDefinition<T>, data: T, opts?: { tx?: Transaction<Database>; singletonKey?: string; startAfterSeconds?: number }): Promise<string | null>;
  ping(): Promise<boolean>;
}

// webhooks/handler.ts
export interface WebhookHandler<E extends EmitterWebhookEventName = EmitterWebhookEventName> {
  name: string;                                  // unique, e.g. "installations.track"
  on: readonly E[];                              // "installation" or "installation.created" forms
  handle(event: EmitterWebhookEvent<E> & { deliveryId: string }, ctx: JobContext): Promise<void>;
}
export function defineWebhookHandler<E extends EmitterWebhookEventName>(h: WebhookHandler<E>): WebhookHandler;

// webhooks/registry.ts
export interface Registry {
  handlersFor(event: string, action: string | undefined): WebhookHandler[];  // registration order
  isHandled(event: string, action: string | undefined): boolean;
  jobs: readonly JobDefinition<unknown>[];                                   // includes github.webhook
}

// github/client-factory.ts
export type GitHubClient = InstanceType<typeof Octokit>;  // from @octokit/rest
export interface GitHubClientFactory {
  forInstallation(installationId: number): Promise<GitHubClient>;
  asApp(): GitHubClient;                                  // JWT-authenticated
}
export function createGitHubClientFactory(o: { appId: number; privateKey: string; baseUrl: string; fetch?: typeof fetch }): GitHubClientFactory;
```

**Contracts:**

- Webhook handlers must be **idempotent**, because a failed job retries every handler for that delivery. They must also be **fast**: DB writes, or enqueueing a follow-up job with `ctx.queue.send(...)`. Slow work such as LLM calls or many GitHub API calls goes into its own `JobDefinition`.
- Code that would persist file contents, diffs or patches does not pass review. Only paths, SHAs, numbers and model prose go in the DB.

## 6. Tasks

Each task lists acceptance criteria (AC) that the reviewer will check.

### T1. Project skeleton and tooling

Create `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `vitest.config.ts`, `.nvmrc`, `.gitignore` (`node_modules`, `dist`, `.env`, `*.pem`, `coverage`) and `.env.example`.

Scripts, with these exact names:

| Script | Command (or equivalent) |
| --- | --- |
| `build` | `tsc -p tsconfig.build.json` |
| `typecheck` | `tsc --noEmit` |
| `lint` | `biome ci .` |
| `format` | `biome check --write .` |
| `test` | `vitest run` |
| `test:unit` | `vitest run --project unit` |
| `test:integration` | `vitest run --project integration` |
| `dev:server` / `dev:worker` | `tsx watch src/bin/server.ts` / `tsx watch src/bin/worker.ts` |
| `start:server` / `start:worker` | `node dist/bin/server.js` / `node dist/bin/worker.js` |
| `db:up` | `docker compose up -d --wait` |
| `db:migrate` / `db:rollback` / `db:status` | `tsx src/bin/migrate.ts up` / `down` / `status` |
| `webhook:send` | `tsx scripts/send-webhook.ts` |
| `tunnel` | `smee --url "$SMEE_URL" --target "http://localhost:${PORT:-3000}/webhooks/github"` |

AC:
- `package.json` has `"engines": { "node": ">=24" }`, `"packageManager": "pnpm@<exact>"` and `"type": "module"`.
- `tsconfig.json` sets every flag from §3. Relative imports use `.js` extensions.
- `biome.json` lints and formats `src`, `test` and `scripts`, and ignores `dist` and fixture JSON from formatting.
- Vitest project `unit` covers `test/unit/**`. Project `integration` covers `test/integration/**`, uses `globalSetup: test/global-setup.ts` and `fileParallelism: false`. Both use `setupFiles: test/setup.ts`.
- No `any` in `src/` (Biome `noExplicitAny` set to error). No `// @ts-ignore`.

### T2. Config loading

`loadConfig(env: NodeJS.ProcessEnv): Config` is pure: it never reads `process.env` itself, but may read the key file path. It returns a frozen, typed object or throws `ConfigError`.

| Variable | Rule | Default |
| --- | --- | --- |
| `NODE_ENV` | `development` \| `test` \| `production` | `development` |
| `HOST` / `PORT` | string / integer 1–65535 | `0.0.0.0` / `3000` |
| `LOG_LEVEL` | pino level | `info` |
| `DATABASE_URL` | required, `postgres://` or `postgresql://` URL | — |
| `GITHUB_APP_ID` | required, positive integer | — |
| `GITHUB_APP_PRIVATE_KEY` | PEM string; literal `\n` is turned into newlines | — |
| `GITHUB_APP_PRIVATE_KEY_PATH` | path to a PEM file | — |
| `GITHUB_WEBHOOK_SECRET` | required, at least 16 characters | — |
| `GITHUB_API_URL` | URL | `https://api.github.com` |
| `PGBOSS_SCHEMA` | identifier `^[a-z_][a-z0-9_]*$` | `pgboss` |
| `WORKER_CONCURRENCY` | integer 1–50 | `5` |
| `WEBHOOK_BODY_LIMIT_BYTES` | integer | `26214400` (GitHub's 25 MB cap) |
| `SMEE_URL` | optional URL, used only by `pnpm tunnel` | — |

AC:
- Exactly one of `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_PRIVATE_KEY_PATH` must be set. The resolved key must contain `-----BEGIN` and `PRIVATE KEY-----`.
- A `ConfigError` lists **every** invalid variable by name in one message and never includes any variable's value.
- `.env.example` lists every variable, with comments and placeholder values (no real-looking secrets). It points `DATABASE_URL` at the compose DB.

### T3. Core: logger and clock

AC:
- `createLogger(config)` returns pino and redacts `req.headers["x-hub-signature-256"]`, `req.headers.authorization`, `*.privateKey`, `*.webhookSecret` and `*.token`.
- The webhook route logs `deliveryId`, `event`, `action`, `installationId` and the outcome, never the body.
- `systemClock` exists, and every timestamp the app sets (such as `updated_at`) comes from `ctx.clock`.

### T4. Database layer and migrations

Implement `createDb(url)`, the `Database` interface in `src/db/schema.ts` (columns match §7 exactly; use Kysely `Generated<>` / `ColumnType<>` for defaults), `createMigrator`, `src/bin/migrate.ts` and migration `0001_initial` covering all of §7, with a working `down`.

AC:
- `pnpm db:migrate` on an empty DB creates all nine tables. Running it again is a no-op.
- `pnpm db:rollback` drops everything `0001` created, and `up` works again afterwards.
- The int8 type parser is installed once in `createDb` and throws on values above `Number.MAX_SAFE_INTEGER`.
- The migrator never touches the `pgboss` schema; pg-boss manages its own schema on `start()`.

### T5. Job queue and worker

`createPgBossQueue({ connectionString, schema, registry, log })` and `startWorker(queue, registry, ctx, { concurrency })`.

AC:
- `send` validates `data` with `job.schema.parse` **before** calling pg-boss, so invalid data throws `ZodError` and nothing is enqueued.
- If `opts.tx` is given, the job is inserted through that transaction, using pg-boss's `db` option and an adapter `{ executeSql: (text, values) => tx.executeQuery(CompiledQuery.raw(text, values)) }`. Rolling back the transaction removes the job.
- `start()` creates one pg-boss queue per `registry.jobs` entry, idempotently.
- The worker calls `boss.work(name, …)` for every registered job. Each job's data is parsed with its schema again, then `handle` is called with a child logger `{ job: name, jobId }`. A handler that throws fails the job, so pg-boss retries it.
- Defaults when a job sets no `options`: `retryLimit: 5`, `retryBackoff: true`, `retryDelaySeconds: 10`, `expireInSeconds: 300`. Completed and failed jobs are deleted after 7 days (pg-boss retention config).

### T6. GitHub client factory

AC:
- `forInstallation(id)` returns an `@octokit/rest` client that authenticates with installation tokens obtained through `@octokit/app`. Tokens are cached until close to expiry (the `@octokit/app` default).
- `baseUrl` comes from `GITHUB_API_URL`, and an optional `fetch` is passed to `request.fetch`, which is how tests inject a fake.
- No other code in `src/` constructs an Octokit.

### T7. Webhook receiver

`POST /webhooks/github` is a Fastify plugin whose own content-type parser keeps the raw body as a string (`parseAs: "string"`). Steps, in this order:

1. If `content-type` is not `application/json` → **415**.
2. If the body is over `WEBHOOK_BODY_LIMIT_BYTES` → **413** (Fastify `bodyLimit` on the route).
3. If `x-github-event`, `x-github-delivery` or `x-hub-signature-256` is missing or empty → **400**.
4. `verify(secret, rawBody, signature)` from `@octokit/webhooks-methods`. If it fails → **401** with body `{ "error": "invalid signature" }`. The DB and queue are not touched.
5. `JSON.parse` fails → **400**.
6. In one DB transaction (`recordDelivery`):
   - `INSERT INTO webhook_deliveries … ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`.
   - No row returned → commit and respond **200** `{ "status": "duplicate" }`.
   - Otherwise, if `registry.isHandled(event, payload.action)`, send `github.webhook` with `{ deliveryId, event, action, installationId, payload }`, passing `tx` and `singletonKey: deliveryId`, and store `job_id` and `status = 'enqueued'`. Respond **202** `{ "status": "enqueued" }`.
   - If the event is not handled, store `status = 'ignored'` and respond **202** `{ "status": "ignored" }`.
7. Any error in step 6 rolls back the transaction and returns **500**, so a manual redelivery from GitHub is processed again rather than treated as a duplicate.

AC:
- Every step above has a named test (§8).
- Duplicates are detected by the primary key, not by a read-then-write, so concurrent duplicate deliveries produce exactly one row and one job.
- No other route accepts webhooks. The global JSON parser is not used for this route.

### T8. Registry and dispatch job

`createRegistry({ webhookHandlers, jobs })` and `githubWebhookJob` (name `github.webhook`).

AC:
- `handlersFor("installation", "created")` returns handlers registered for `"installation"` and for `"installation.created"`, in registration order, with no duplicates.
- Duplicate handler names or job names throw at construction. `github.webhook` is always present in `registry.jobs`.
- `githubWebhookJob.handle` runs every matching handler in order with a child logger `{ deliveryId, handler }` and rethrows the first error. If no handler matches (the registry changed between receipt and processing), it logs at `warn` and completes.
- `src/app/registry.ts` exports `buildAppRegistry()`, which spreads `installations.webhookHandlers` and `installations.jobs`. Later steps add one line each here.

### T9. Installation module

One handler, `installations.track`, on `installation` and `installation_repositories`. All writes for one event happen in a single transaction. `updated_at` comes from `ctx.clock`.

| Event.action | Effect |
| --- | --- |
| `installation.created` | Upsert the installation (clears `deleted_at` and `suspended_at`); upsert every `payload.repositories[]` with `removed_at = NULL`. |
| `installation.deleted` | Set `deleted_at`; set `removed_at` on all its repositories that are still active. |
| `installation.suspend` / `unsuspend` | Set / clear `suspended_at`. |
| `installation.new_permissions_accepted` | Upsert the installation (refreshes `repository_selection`). |
| `installation_repositories.added` | Upsert the installation from `payload.installation` (it may not exist yet); upsert `repositories_added[]` with `removed_at = NULL`; update `repository_selection`. |
| `installation_repositories.removed` | Set `removed_at` on `repositories_removed[]`; update `repository_selection`. |

AC:
- Processing the same event twice leaves the same state, apart from `updated_at`.
- Re-adding a removed repository clears `removed_at`. A renamed repository (same ID, new `full_name`) updates its name.
- The store functions are exported from `store.ts` for later modules: `getActiveRepository(id)` and `listActiveRepositories(installationId)`.

### T10. HTTP server and health

`buildServer(deps)` registers the receiver and health routes and returns the instance without listening.

AC:
- `GET /healthz` → 200 `{ "status": "ok", "version": "<package.json version>" }`, with no I/O.
- `GET /readyz` → 200 `{ "status": "ready", "db": "ok", "queue": "ok" }` when `select 1` and `queue.ping()` succeed, otherwise 503 with `"error"` for whichever failed. Each check has a 2-second timeout.
- Unknown routes → 404 JSON. No stack traces in responses when `NODE_ENV=production`.

### T11. Entry points and shutdown

AC:
- `src/bin/server.ts`: load `.env` if present, `loadConfig`, create db, queue (`start()` with `supervise: false` and no scheduling, so it only sends), GitHub factory and registry, then `buildServer(...).listen`.
- `src/bin/worker.ts`: the same deps, `queue.start()` with supervision on, then `startWorker`. It runs no HTTP server.
- Neither process runs migrations automatically. If the schema is behind (migrator reports pending migrations), both exit with code 1 and the message `run pnpm db:migrate`.
- On SIGINT/SIGTERM: stop accepting work, `server.close()` or `boss.stop({ graceful: true, timeout: 10000 })`, `db.destroy()`, then exit 0.

### T12. GitHub App manifest

Create `github/app-manifest.json` in [App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) format:

```json
{
  "name": "Graft Dev (CHANGE-ME)",
  "url": "https://github.com/CHANGE-ME",
  "description": "Intent review and policy checks for agent-written pull requests.",
  "public": false,
  "hook_attributes": { "url": "https://smee.io/CHANGE-ME", "active": true },
  "redirect_url": "http://localhost:3000/",
  "request_oauth_on_install": false,
  "default_permissions": {
    "metadata": "read",
    "contents": "read",
    "issues": "read",
    "pull_requests": "write",
    "checks": "write"
  },
  "default_events": ["check_run", "pull_request"]
}
```

Also create `github/register-app.html`, a static page with an org-name field and a form that POSTs the manifest to `https://github.com/organizations/<org>/settings/apps/new`. The human copies the `code` from the redirect URL and runs `gh api -X POST /app-manifests/<code>/conversions`. The README explains these steps.

The README has a permission justification table. These rows are required:

| Permission / event | Level | Phase 0 use |
| --- | --- | --- |
| `metadata` | read | Mandatory for every App; repository listing. |
| `contents` | read | Read `graft.yaml` (step 5) and commit data for trailers (step 2). |
| `issues` | read | Read the linked issue for the intent writer (step 3). No write: comments go through `pull_requests: write`. |
| `pull_requests` | write | Read PRs, files, diffs, commits and reviews (steps 2, 3, 6). Write is only for creating and updating the pinned card comment, since the issue-comments API accepts `pull_requests: write`. |
| `checks` | write | Create `graft/intent` and `graft/policy` check runs (steps 3 and 5). |
| `pull_request` event | — | Trigger provenance, intent and policy on opened, synchronize, reopened, edited and closed. |
| `check_run` event | — | `rerequested` re-runs our checks. |
| `installation`, `installation_repositories` | — | Delivered to every App without a subscription; drive T9. |

It also has a **Deferred** list:

- `members: read` (team approvals, Phase 1).
- `contents: write` (revert branches and PRs, Phase 1).
- `statuses: read` and `actions: read`, plus the `push`, `status`, `workflow_run` and `check_suite` events (post-merge guard, Phase 1).
- The `pull_request_review` event (approval counting, Phase 1).
- `administration`: never.

The list notes that comment reactions (thumbs-up/down, step 3) have no webhook, so step 3 polls them using `pull_requests: read`.

AC:
- `test/unit/manifest.test.ts` asserts that `default_permissions` and `default_events` deep-equal the values above and that `public` is `false`. Changing them requires updating the test and this table together.

### T13. Fixtures, test helpers and the send script

AC:
- `test/fixtures/webhooks/` contains these files, each the raw payload JSON: `ping.json`, `installation.created.json`, `installation.deleted.json`, `installation.suspend.json`, `installation.unsuspend.json`, `installation.new_permissions_accepted.json`, `installation_repositories.added.json`, `installation_repositories.removed.json`, `pull_request.opened.json`, `pull_request.synchronize.json`, `pull_request.closed.json` (merged), `check_run.rerequested.json`.
- Fixtures are built from `@octokit/webhooks-examples` (a dev dependency) and rewritten to one fictional world: org `graft-sandbox` (account id `9000001`), installation id `1000001`, repos `graft-sandbox/sample-ts` (`2000001`) and `graft-sandbox/sample-py` (`2000002`). They contain no real users or tokens.
- `loadFixture(name)` returns `{ event, payload, body }`. The event name comes from the filename prefix, and `body` is the exact string to sign.
- `scripts/send-webhook.ts <fixture> [--delivery <id>] [--url <url>]` signs with `GITHUB_WEBHOOK_SECRET` from `.env` and POSTs to `http://localhost:$PORT/webhooks/github` with a random delivery ID by default. It prints the status code and body.
- `test/setup.ts` replaces `globalThis.fetch` so that any request to a host other than `localhost`/`127.0.0.1` throws `Error("network access in tests: <host>")`. Injected fakes are unaffected.

### T14. docker-compose and CI

AC:
- `docker-compose.yml` defines one `postgres` service: `postgres:17-alpine`, user/password/db `graft`/`graft`/`graft`, port `55432:5432`, a `pg_isready` healthcheck and a named volume. `pnpm db:up` waits until it is healthy.
- Integration tests use `TEST_DATABASE_URL`, defaulting to `postgres://graft:graft@localhost:55432/graft_test`. `global-setup.ts` connects to the `postgres` maintenance DB, runs `DROP DATABASE IF EXISTS graft_test WITH (FORCE)` and `CREATE DATABASE graft_test`, then migrates to latest. If Postgres is unreachable, it fails with `Postgres not reachable at <host:port>; run pnpm db:up` (it must not skip silently).
- `.github/workflows/ci.yml` runs on `push` and `pull_request` with `permissions: contents: read`, on `ubuntu-latest`, with a `postgres:17-alpine` service (same credentials, `ports: 55432:5432`, health options). Steps: checkout → `pnpm/action-setup` → `actions/setup-node` (Node from `.nvmrc`, pnpm cache) → `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`. CI needs no secrets.

### T15. README (local dev guide)

Sections, in order:

1. What this is (two lines plus links to the spec and plan).
2. Prerequisites (Node 24, pnpm, Docker/OrbStack).
3. Quick start, fully offline: `pnpm install`, `pnpm db:up`, `cp .env.example .env`, generate a throwaway key with `openssl genrsa -out dev.pem 2048` (so the server boots without a real App), `pnpm db:migrate`, `pnpm dev:server`, `pnpm dev:worker`, `pnpm webhook:send installation.created`, then check the rows with `psql`.
4. Tests.
5. Connecting a real GitHub App: register from the manifest, fill `.env`, `pnpm tunnel` with smee. Include the caveat that `gh webhook forward` does not work for App webhooks, with ngrok or cloudflared as alternatives.
6. Architecture and module layout (the "How later steps plug in" paragraph and the two contracts from §5).
7. Permissions table and deferred list (T12).
8. Decisions and library versions.
9. Troubleshooting: 401 means the secret differs from the App's; duplicate deliveries; port 55432 already in use.

AC: a reader can follow section 3 from a clean clone with no network access other than `pnpm install` and the Docker image pull.

### T16. `docs/phase-0/HUMAN-TODO.md`

A checklist that every later step appends to. Each item says who does it, which values it produces and where they go (`.env` key or deployment secret). Step 1 items:

- [ ] Create the sandbox GitHub org (suggested name `graft-sandbox-<suffix>`). Record the org name.
- [ ] Create test repos in it: `sample-ts` (small TS project with CI), `sample-py`, `empty`. Enable Actions.
- [ ] Create a smee.io channel and set it as `hook_attributes.url` (dev) and in `SMEE_URL`.
- [ ] Register the App from `github/app-manifest.json` with `github/register-app.html`. Convert the code with `gh api`. Store the App ID → `GITHUB_APP_ID`, PEM → a file outside the repo referenced by `GITHUB_APP_PRIVATE_KEY_PATH`, webhook secret → `GITHUB_WEBHOOK_SECRET`. Record the App slug.
- [ ] Install the App on the sandbox org for **selected** repos (`sample-ts`, `sample-py`), and check that an `installations` row and two `repositories` rows appear.
- [ ] Add then remove `empty` from the installation, and check that `removed_at` gets set.
- [ ] Push this repo to GitHub and check that CI is green.
- [ ] Open decisions from the plan: pilot team source, first agent harness, diff retention ("not stored").

## 7. Schema (migration `0001_initial`)

All timestamps are `timestamptz NOT NULL DEFAULT now()` unless noted. "Enum" means `text` with a `CHECK (col IN (...))`, not a Postgres enum, so later migrations can add values cheaply. **No column holds file contents, diffs, patches or code.**

```sql
CREATE TABLE installations (
  id                    bigint PRIMARY KEY,                -- GitHub installation id
  account_id            bigint NOT NULL,
  account_login         text   NOT NULL,
  account_type          text   NOT NULL CHECK (account_type IN ('User','Organization','Enterprise')),
  repository_selection  text   NOT NULL CHECK (repository_selection IN ('all','selected')),
  suspended_at          timestamptz,
  deleted_at            timestamptz,
  created_at, updated_at
);
CREATE INDEX installations_account_login_idx ON installations (lower(account_login));

CREATE TABLE repositories (
  id               bigint PRIMARY KEY,                     -- GitHub repository id
  installation_id  bigint NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  full_name        text   NOT NULL,                        -- "owner/name"; updated on rename
  private          boolean NOT NULL,
  default_branch   text,                                   -- not in installation payloads; filled later
  removed_at       timestamptz,
  created_at, updated_at
);
CREATE INDEX repositories_installation_idx ON repositories (installation_id) WHERE removed_at IS NULL;
CREATE INDEX repositories_full_name_idx ON repositories (lower(full_name));

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id   bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  external_id     text   NOT NULL,                         -- Graft-Task trailer / MCP task id
  issue_number    integer,
  issue_url       text,
  goal            text,
  created_at, updated_at,
  UNIQUE (repository_id, external_id)
);

CREATE TABLE changes (                                     -- one row per PR
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id    bigint  NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_number        integer NOT NULL,
  pr_node_id       text    NOT NULL,
  task_id          uuid    REFERENCES tasks(id) ON DELETE SET NULL,
  head_sha         text    NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  base_ref         text    NOT NULL,
  author_login     text    NOT NULL,
  state            text    NOT NULL CHECK (state IN ('open','closed','merged')),
  merge_commit_sha text    CHECK (merge_commit_sha ~ '^[0-9a-f]{40}$'),
  opened_at        timestamptz NOT NULL,
  closed_at        timestamptz,
  merged_at        timestamptz,
  created_at, updated_at,
  UNIQUE (repository_id, pr_number)
);
CREATE INDEX changes_task_idx ON changes (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX changes_repo_state_idx ON changes (repository_id, state);

CREATE TABLE provenance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id         uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  source            text NOT NULL CHECK (source IN ('trailer','mcp')),
  commit_sha        text CHECK (commit_sha ~ '^[0-9a-f]{40}$'),   -- commit carrying the trailer; NULL for mcp
  agent             text,
  model             text,
  task_external_id  text,
  session_url       text,
  created_at,
  UNIQUE NULLS NOT DISTINCT (change_id, source, commit_sha)
);
CREATE INDEX provenance_change_idx ON provenance (change_id);

CREATE TABLE intent_cards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id           uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  head_sha            text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  prompt_version      text NOT NULL,
  goal                text NOT NULL,
  behavior_changes    jsonb NOT NULL DEFAULT '[]',          -- string[]
  out_of_scope_edits  jsonb NOT NULL DEFAULT '[]',          -- file paths only
  risk_class          text NOT NULL CHECK (risk_class IN ('trivial','logic','sensitive')),       -- final = max(floor, model)
  risk_floor          text NOT NULL CHECK (risk_floor IN ('trivial','logic','sensitive')),       -- from fixed rules
  model_risk_class    text CHECK (model_risk_class IN ('trivial','logic','sensitive')),
  verifier_status     text NOT NULL CHECK (verifier_status IN ('pending','agree','disagree','error')),
  verifier_notes      text,
  writer_model        text NOT NULL,
  verifier_model      text,
  input_tokens        integer,
  output_tokens       integer,
  comment_id          bigint,                               -- GitHub issue comment id
  check_run_id        bigint,
  created_at, updated_at,
  UNIQUE (change_id, head_sha, prompt_version)
);
CREATE INDEX intent_cards_change_idx ON intent_cards (change_id, created_at DESC);

CREATE TABLE policy_verdicts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id           uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  head_sha            text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  policy_sha          text,                                 -- git blob sha of graft.yaml; NULL = no file
  mode                text NOT NULL CHECK (mode IN ('report','enforce')),
  status              text NOT NULL CHECK (status IN ('pending','pass','fail','blocked','error')),
  check_conclusion    text CHECK (check_conclusion IN ('success','failure','neutral','action_required')),
  risk_class          text CHECK (risk_class IN ('trivial','logic','sensitive')),
  rules_matched       jsonb NOT NULL DEFAULT '[]',
  approvals_required  jsonb NOT NULL DEFAULT '{}',
  approvals_present   jsonb NOT NULL DEFAULT '{}',
  check_run_id        bigint,
  evaluated_at        timestamptz NOT NULL DEFAULT now(),
  created_at
);
CREATE INDEX policy_verdicts_change_idx ON policy_verdicts (change_id, evaluated_at DESC);

CREATE TABLE guard_events (                                -- Phase 1; table created now
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id      bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch             text NOT NULL,
  failing_sha        text NOT NULL CHECK (failing_sha ~ '^[0-9a-f]{40}$'),
  ci_run_url         text,
  culprit_change_id  uuid REFERENCES changes(id) ON DELETE SET NULL,
  revert_pr_number   integer,
  status             text NOT NULL CHECK (status IN ('detected','culprit_found','revert_opened','reverted','dismissed','error')),
  created_at, updated_at,
  UNIQUE (repository_id, failing_sha)
);

CREATE TABLE webhook_deliveries (
  delivery_id      text PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 100),  -- X-GitHub-Delivery
  event            text NOT NULL,
  action           text,
  installation_id  bigint,                                  -- no FK: may arrive before the installation row
  repository_id    bigint,                                  -- no FK, same reason
  status           text NOT NULL CHECK (status IN ('enqueued','ignored')),
  job_id           uuid,
  received_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_received_idx ON webhook_deliveries (received_at);
```

Deferred to the step that needs it: card feedback (`intent_card_feedback`, step 3), eval labels (step 4), break-glass audit log (Phase 1), MCP tokens (Phase 1).

## 8. Test plan

Every test runs offline. `unit` needs nothing running; `integration` needs only `pnpm db:up`. Use these names as the `it(...)` titles so the reviewer can grep them.

**Unit** (`test/unit/`)

| ID | Case |
| --- | --- |
| U-CFG-1 | A valid env parses; defaults are applied; the result is frozen. |
| U-CFG-2 | With an empty env, the error names `DATABASE_URL`, `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET` and the private-key pair in one message. |
| U-CFG-3 | Error messages never contain the provided secret or key values. |
| U-CFG-4 | A key with literal `\n` is normalized; `GITHUB_APP_PRIVATE_KEY_PATH` reads a temp file. |
| U-CFG-5 | Setting both key variables, or neither, is an error; a non-PEM key is an error. |
| U-CFG-6 | A bad `DATABASE_URL` scheme, `PORT=0` and a `GITHUB_WEBHOOK_SECRET` under 16 characters are each rejected. |
| U-SIG-1 | A correct `sha256=` signature verifies. |
| U-SIG-2 | A body with one byte changed fails. |
| U-SIG-3 | A wrong secret fails. |
| U-SIG-4 | A malformed header (`sha1=…`, no prefix, wrong length) fails without throwing. |
| U-WH-1 | Missing `x-hub-signature-256` → 400; the stub DB/queue are never called. |
| U-WH-2 | Bad signature → 401 `{error:"invalid signature"}`; the stub DB/queue are never called. |
| U-WH-3 | Missing `x-github-delivery` or `x-github-event` → 400. |
| U-WH-4 | `content-type: application/x-www-form-urlencoded` → 415. |
| U-WH-5 | A body over the limit (set to 1 KB in the test) → 413. |
| U-WH-6 | A valid signature over non-JSON text → 400. |
| U-REG-1 | `handlersFor` matches both the `event` and `event.action` keys, in order, with no duplicates. |
| U-REG-2 | An unregistered event → `isHandled` is false. |
| U-REG-3 | Duplicate handler names throw; duplicate job names throw. |
| U-REG-4 | `github.webhook` is always in `jobs`. |
| U-DISPATCH-1 | The dispatch job calls matching handlers in order and rethrows the first error (later handlers are not called). |
| U-DISPATCH-2 | With no matching handler, it completes and logs at `warn`. |
| U-Q-1 | `send` with data failing the schema throws `ZodError` and does not call pg-boss (stubbed boss). |
| U-GH-1 | `forInstallation(1000001)` requests `POST /app/installations/1000001/access_tokens` with a JWT `Bearer` (verified with the test public key, `iss` = app id), then calls the API with `token ghs_…`. Uses fake fetch. |
| U-GH-2 | Two `forInstallation` calls within token lifetime → one access-token request. |
| U-GH-3 | A custom `baseUrl` is used for all requests. |
| U-HEALTH-1 | `/healthz` → 200 with version. |
| U-HEALTH-2 | `/readyz` → 503 when the stub DB throws; 503 when `queue.ping` returns false. |
| U-MAN-1 | The manifest permissions and events equal the expected objects; `public` is false. |
| U-FIX-1 | Every fixture validates against `@octokit/webhooks-schemas` (via `ajv`). |
| U-FIX-2 | Every fixture uses installation `1000001` (where present) and only `graft-sandbox` repos. |
| U-NET-1 | `fetch("https://example.com")` throws the network-guard error. |

**Integration** (`test/integration/`, real Postgres and real pg-boss; tables truncated between tests)

| ID | Case |
| --- | --- |
| I-DB-1 | After migration, the nine tables exist (`information_schema.tables`). |
| I-DB-2 | `down` to zero, then `up` again, succeeds; the `pgboss` schema is untouched. |
| I-DB-3 | Insert and select one row per table through Kysely (proves `Database` matches the DB). |
| I-DB-4 | No column in the nine tables has a name matching `/(diff|patch|hunk|snippet|content|blob|code)/`. |
| I-DB-5 | CHECK constraints reject `risk_class='huge'`, `head_sha='abc'` and `status='done'` on `webhook_deliveries`. |
| I-DB-6 | A `bigint` above 2^53 read through `createDb` throws. |
| I-WH-1 | A signed `installation.created` → 202 `enqueued`; one `webhook_deliveries` row with `job_id`; one `github.webhook` job whose data has the `deliveryId`. |
| I-WH-2 | The same delivery ID twice → second response 200 `duplicate`; still one row and one job. |
| I-WH-3 | Five concurrent injects with the same delivery ID → exactly one row and one job; four responses are `duplicate`. |
| I-WH-4 | `ping` → 202 `ignored`; row `status='ignored'`; no job. `pull_request.opened` → same in step 1. |
| I-WH-5 | A queue whose `send` throws → 500; no `webhook_deliveries` row; resending the same delivery ID with a working queue → 202 `enqueued`. |
| I-Q-1 | `send` inside a transaction that is rolled back → no job in pg-boss. |
| I-INST-1 | `installation.created` → installation row and two repository rows with the fixture values. |
| I-INST-2 | Processing `installation.created` twice → identical rows (ignoring `updated_at`). |
| I-INST-3 | `installation_repositories.added` then `.removed` → `removed_at` set; re-adding clears it. |
| I-INST-4 | `installation_repositories.added` for an unknown installation → the installation is created from `payload.installation`. |
| I-INST-5 | `installation.deleted` → `deleted_at` set; all repositories have `removed_at`. |
| I-INST-6 | `suspend` then `unsuspend` → `suspended_at` set then null. |
| I-INST-7 | A rename (same repo ID, different `full_name` in an `added` payload) updates `full_name`. |
| I-E2E-1 | Server (`inject`) plus a running worker: a signed `installation.created` leads to repository rows within 10 s (poll every 100 ms). The fake GitHub factory is never called. |
| I-HEALTH-1 | `/readyz` → 200 against the real DB and started queue. |

Fixed clock in tests: `{ now: () => new Date("2026-10-14T12:00:00Z") }`.

## 9. Definition of done

From a clean clone with Docker running, all of these pass with no network access beyond the install and image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test            # unit + integration, every ID in §8 present and passing
pnpm build
cp .env.example .env && openssl genrsa -out dev.pem 2048   # set GITHUB_APP_PRIVATE_KEY_PATH=./dev.pem
pnpm db:migrate && pnpm db:migrate                          # second run: "no pending migrations"
```

Manual smoke test, recorded in the PR description:

1. Run `pnpm dev:server` and `pnpm dev:worker`.
2. `pnpm webhook:send installation.created --delivery smoke-1` prints `202 {"status":"enqueued"}`. Repeating the same command prints `200 {"status":"duplicate"}`.
3. `psql` shows one `installations` row and two `repositories` rows.
4. `curl localhost:3000/readyz` returns 200.
5. Ctrl-C on both processes exits cleanly within 10 s.

Also required:

- The CI workflow file exists and runs the same commands.
- `README.md` and `docs/phase-0/HUMAN-TODO.md` exist with the sections in T15 and T16.
- No secrets, `.pem` files or `.env` are committed.
- No explicit `any`, `@ts-ignore` or `@ts-expect-error` in `src/` (enforced by Biome `noExplicitAny`, checked by grep for the comments).
