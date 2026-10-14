# Graft

Graft is a GitHub App and service that adds intent review and policy checks to agent-written pull requests. This repo holds the service; step 1 is the base skeleton (webhook intake, job queue, installation tracking) and step 2 adds provenance (who wrote each PR, shown in a check run and the managed PR comment).

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

Other scripts: `pnpm db:status`, `pnpm db:rollback` (reverts only the latest migration), `pnpm format`, `pnpm build` then `pnpm start:server` / `pnpm start:worker`.

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

**How later steps plug in.** Each feature is a folder `src/modules/<name>/` whose `index.ts` exports `webhookHandlers: WebhookHandler[]` and `jobs: JobDefinition[]`. `src/app/registry.ts` is the only file that lists modules. Step 2 added `modules/changes` (the `changes` row and its guarded upsert; store only, no handlers) and `modules/provenance` (trailers, handlers, the `provenance.refresh` job). Expected additions: `modules/intent` plus `src/llm/` holding the model-client interface and its fake (step 3), `eval/` with `src/bin/eval.ts` (step 4), `modules/policy` (step 5), `modules/pilot` with `scripts/pilot/` (step 6), and `src/mcp/` (Phase 1). Modules import from `config`, `core`, `db`, `github`, `queue` and `webhooks`. They import another module only through its `index.ts`, never its internals.

**Contracts.**

- Webhook handlers must be idempotent, because a failed job retries every handler for that delivery. They must also be fast: DB writes, or enqueueing a follow-up job with `ctx.queue.send(...)`. Slow work such as LLM calls or many GitHub API calls goes into its own `JobDefinition`.
- Deliveries can be processed out of order and concurrently (`WORKER_CONCURRENCY`, retries with backoff, and GitHub itself does not order them), so handlers must tolerate reordering. For order-sensitive state, compare the head SHA or the payload's timestamp and ignore stale events, or use a `key_strict_fifo` queue keyed by installation or PR. Step 1's installation handlers are idempotent but not order-proof (for example a late `added` after `deleted`).
- Code that would persist file contents, diffs or patches does not pass review. Only paths, SHAs, numbers and model prose go in the DB.

**Managed PR comment.** Graft keeps exactly one comment per PR, created once and then updated in place (it is not pinned through the API). The contract lives in the doc comment of [`src/github/managed-comment.ts`](src/github/managed-comment.ts), which steps 3 and 5 reuse:

- The body starts with `<!-- graft:managed-comment v1 -->`, then `## Graft`, then one block per section, `<!-- graft:section:<name>:start -->` ... `<!-- graft:section:<name>:end -->`, in the order `intent`, `provenance`, `policy`; unknown sections found in an existing body are kept verbatim after them. A `<sub>` footer closes it.
- Each module writes only its own section through `upsertManagedSection`; every other section is preserved byte for byte. Section markdown may not contain `<!-- graft:` and is capped at 20,000 characters.
- Finding the comment: the stored `changes.graft_comment_id` if it still exists and is ours, else the first of the PR's comments that is ours, else a new comment. **Ours** means the marker is the first line **and** `performed_via_github_app.id` equals `GITHUB_APP_ID`. Because D13 (that field being present on REST comment responses) is unverified against real GitHub, there is a fallback: when `GITHUB_APP_SLUG` is set, a comment authored by the bot login `<slug>[bot]` (type `Bot`) with the marker also counts. A human pasting the marker is never adopted.
- **`withChangeLock(db, changeId, fn)`** (`src/db/locks.ts`): every writer of the managed comment or of per-change GitHub output (check runs) must hold this per-change advisory lock, and must store the comment id in `changes.graft_comment_id` inside the same transaction. The lock is a transaction that holds a pooled connection while requests are in flight, so **do no slow work (LLM calls, diff fetches) inside `withChangeLock`; compute first, then lock, re-check freshness (head SHA and `pr_updated_at`) and publish.**
- **`PermanentJobError(message, reason)`** (`src/queue/errors.ts`): a job throws it when a retry cannot help (deleted PR, lost permission, repo mismatch). The worker logs it and completes the job. `toJobError` in `src/github/errors.ts` maps Octokit errors: 404/410/401/non-rate-limit 403/422 are permanent; 429, rate-limit 403 and 5xx/network errors are retried.

**Webhook replay.** The webhook HMAC covers only the body, so `X-GitHub-Event` and `X-GitHub-Delivery` are unauthenticated: anyone holding one captured signed body can replay it under a new delivery ID (bypassing the `webhook_deliveries` dedup) or under another event name. Mitigations: (1) a payload is only a **trigger**: `pull_request` and `check_run` handlers validate the payload and enqueue a job, nothing else; the job re-fetches the PR from the API and writes only what the API returned (it also checks the PR number and repository id); (2) every handler parses its payload with a zod schema (`parsePayload`, logging issue paths only) and returns on a mismatch, which catches a relabeled event; (3) replays converge: the same body under a fresh delivery ID yields the same job dedup key, so no job is created within 7 days, and a later or stale replay only refreshes live state. **The rule for later steps: handlers treat payloads as triggers; jobs write only from API data or from data Graft computed.** Residual risk: an attacker with a captured body can force extra GitHub API calls after the 7-day window, but cannot forge state. A replayed `check_run.rerequested` body is not bounded even inside the window: its key is `prov-rerun:{deliveryId}` (a re-run must always run), so every fresh delivery ID enqueues a full refresh (`pulls.get`, commit pages, two writes). The work is idempotent and never forges state; only cost is at stake.

Layout: `src/config` (env), `src/core` (clock, logger, context), `src/db` (Kysely, migrations), `src/queue` (pg-boss wrapper, worker), `src/webhooks` (receiver, registry, dispatch job), `src/github` (Octokit factory, the only place an Octokit is built), `src/http`, `src/modules`, `src/bin` (entry points).

## Provenance trailers for agents

Graft works out who wrote a PR from `Graft-*` git trailers in its commits, with the PR description as a fallback. Agents add them with `git commit --trailer`:

```sh
git commit -m "Fix the retry loop" \
  --trailer "Graft-Agent: claude-code" \
  --trailer "Graft-Model: claude-sonnet-5-5" \
  --trailer "Graft-Task: #42" \
  --trailer "Graft-Session: https://claude.ai/code/session/abc"
```

| Key | Value rule |
| --- | --- |
| `Graft-Agent` | `[A-Za-z0-9][A-Za-z0-9 ._:/@+()-]{0,99}` |
| `Graft-Model` | `[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}` |
| `Graft-Task` | `[A-Za-z0-9#][A-Za-z0-9._:/#@+-]{0,127}`; `#42` links issue 42 of the repo |
| `Graft-Session` | an `https` URL, at most 2,048 characters, no credentials, a plain LDH hostname (letters, digits, hyphen, dots; at least two labels; no IP, no `localhost`); `( ) [ ] \| \ `` ` `` `*` are percent-encoded |

Keys are case-insensitive. The trailers must be in the last paragraph of the message (git `interpret-trailers` rules, simplified; the subject alone never counts). A value that fails its rule is ignored and listed as a warning (the warning never repeats the value). **Precedence:** per field, the newest commit with a valid value wins, then older commits, then the PR description (same trailer syntax, last paragraph). If values disagree, the newest wins and all distinct values are shown. **Agent or human:** a PR is agent-authored if any of these holds, in this order: a resolved `Graft-Agent`; the PR author is a GitHub Bot account; the author login is in `GRAFT_AGENT_LOGINS`; a commit has a `Co-authored-by` with an email in `GRAFT_AGENT_COAUTHOR_EMAILS` (default `noreply@anthropic.com`, Claude Code's). Otherwise it is human. Graft stores parsed `Graft-*` values only; commit messages and e-mail addresses are read in memory and never stored.

## 6. GitHub App permissions

`github/app-manifest.json` is the source of truth; `test/unit/manifest.test.ts` pins it. Changing a permission means updating the test and this table together.

| Permission / event | Level | Phase 0 use |
| --- | --- | --- |
| `metadata` | read | Mandatory for every App; repository listing. |
| `contents` | read | Read `graft.yaml` (step 5) and commit data for trailers (step 2); `git.getCommit` for the head commit when a PR has more than 250 commits. |
| `issues` | read | Read the linked issue for the intent writer (step 3). No write: comments go through `pull_requests: write`. |
| `pull_requests` | write | Read PRs, files, diffs, commits and reviews (steps 2, 3, 6); list PR commits (step 2). Write is only for creating and updating the pinned card comment, since the issue-comments API accepts `pull_requests: write`. |
| `checks` | write | Create `graft/provenance` (step 2), `graft/intent` and `graft/policy` check runs (steps 3 and 5). |
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

### Step 2 deviations and additions

- **Library reality.** `@octokit/rest` 22 includes `paginate.iterator` (used for commits and comments; the iterator is stopped early after 3 and 10 pages). `checks.update` takes the check run id and no `head_sha`, so the PATCH body omits it. Nothing else differed from the spec's assumptions. pg-boss 12 only marks a failed job `retry` and bumps `retry_count` when it is next fetched, so I-Q-4 asserts the `retry` state, not the count.
- **D13 fallback (added).** New optional env `GITHUB_APP_SLUG` (`Config.githubAppSlug`). When set, a comment authored by `<slug>[bot]` (type `Bot`) that starts with the marker is accepted as ours when `performed_via_github_app.id` does not match. Without the slug the strict app-id check is the only check. Tested in U-MC-9, U-MC-10 and I-PROV-9. HUMAN-TODO has an item to confirm the field on real GitHub.
- **Dedup key carries `updated_at` for every action.** D6 as written would swallow any return to an earlier state within 7 days: `closed`/`reopened` after `opened`, a body edited X to Y to X, or a force-push H1 to H2 to H1 would all hit the key of a completed job, leaving stale provenance. The key is `prov:{repo}:{pr}:{head}:{base}:{bodyHash}:{pull_request.updated_at}` for all five actions, and `pull_request.updated_at` is required in the payload schema (a payload without it enqueues nothing). A replayed body has the same `updated_at`, so replay protection is kept. The cost is one redundant, idempotent job for a title-only edit (the comment comes back `unchanged`, the check run gets one PATCH).
- **In-lock staleness check.** Inside `withChangeLock` the job publishes only if the stored head SHA equals the live head and the stored `pr_updated_at` is not newer than the live `updated_at`. Otherwise two jobs on the same head with different bodies could publish the older body last (I-PROV-10b; the head-moved branch is I-PROV-10c). `updated_at` has one-second resolution, so two edits inside the same second cannot be ordered; the later job still refreshes on the next event.
- **Session host is plain LDH (D14 hardening).** `validateSessionUrl` additionally requires every host label to match `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`, at least two labels, at most 253 characters (one trailing dot is tolerated and `localhost.` is rejected), because the hostname is the link text and WHATWG `URL` accepts `` ` * _ ~ ! $ & ' { } = `` in a host. `\`, `` ` `` and `*` are percent-encoded in the href. Trailer whitespace follows git (space and tab only), not JavaScript `\s`.
- **Output-size failures are permanent.** `upsertManagedSection` throws `PermanentJobError` (`invalid_output`) for a marker in the section or an oversize section or comment, instead of retrying a deterministic failure 8 times.
- **Order inside the lock.** The job upserts the managed comment first and then the check run (T14 lists the check run first). This is what I-PROV-8 describes ("comment created, then the check-run POST fails") and it keeps the outcome identical: a failure rolls everything back and the retry adopts the existing comment (T8 3b).
- **Not applied snapshot returns early.** If `upsertChangeFromPull` reports `applied: false` (stored `updated_at` is newer), the job logs `stale` and stops before any commit fetch or publish. That is what I-PROV-3 requires; T14 does not say it.
- **`parseTrailerBlock` also returns `blockTooLong`** (P7 needs a way to reach the `block_too_long` warning); `ProvenanceResult` also carries `truncated` (the renderer needs it and `counts` cannot express it); `persistProvenance` also takes `repositoryFullName` (for the issue URL). When the text was cut from the front (P2) the single remaining paragraph is not treated as a subject.
- **Session URLs must be printable ASCII** (no non-ASCII at all, not even in the path), a stricter reading of "all character sets are ASCII". `|` is percent-encoded as well as `( ) [ ]`, because the URL is rendered inside a table cell (and see the LDH rule below).
- **Rendering of warnings without a field** (`unknown_graft_key`, `block_too_long`): `- <where>: trailer block ignored (<code>)`, or `unknown Graft key ignored (unknown_graft_key)` for an unknown key. When there are no trailers and the PR is truncated, the "no `Graft-*` trailers found" footer still gets the truncation sentence appended.
- **U-REN-7** uses the agent value `octo@bot/@team`: the spec's `@octo/bot` starts with `@`, which the agent character set rejects (a separate assertion checks that it is rejected and never rendered).
- **I-SEC-3** posts the `installation.created` body as `pull_request` twice: unchanged (the receiver ignores it, since the action `created` is not handled) and with `action: "opened"` so the handler really runs and logs `payload_shape_mismatch`.
- **`pnpm db:rollback` reverts one migration** (the latest), as T1 requires; in step 1 it rolled back everything. The test helper `migrateDown` still goes to zero.
- **Extras:** `getActiveInstallation` (installations store, exported) is the "installation exists and is not deleted or suspended" check used by the handlers and the job; `ProvenanceTable.source` gains `pr_body`; `changes.pr_updated_at` and `graft_comment_id` are optional on insert so step 1 tests compile unchanged; a `continue` instead of `return` lets the worker finish a batch after a permanent error (batch size is 1).

## 8. Troubleshooting

- **401 `invalid signature`**: `GITHUB_WEBHOOK_SECRET` differs from the App's webhook secret (or from the one `pnpm webhook:send` reads from `.env`).
- **Duplicate deliveries**: GitHub redelivers on timeouts; the second delivery with the same `X-GitHub-Delivery` returns `200 {"status":"duplicate"}` and enqueues nothing. A delivery that failed with 500 is rolled back, so redelivering it is processed normally.
- **Port 55432 already in use**: another process holds it; stop it or change the host port in `docker-compose.yml` and `DATABASE_URL` / `TEST_DATABASE_URL`.
- **`run pnpm db:migrate`** on startup: the schema is behind; run the migration.
- **`Postgres not reachable ... run pnpm db:up`** from the integration tests: start the container.
