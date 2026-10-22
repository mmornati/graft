# Getting started

[Docs index](README.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md)

This guide takes you from a fresh clone to a running Graft server and worker on your laptop. It needs no GitHub App, no Anthropic API key and, after the install, no network. To connect a real App afterwards, see [github-app.md](github-app.md).

## Prerequisites

- Node 24 (`.nvmrc`), pnpm 11
- Docker (OrbStack works) for Postgres
- `openssl` (for a throwaway App key) and `curl`. `psql` is optional; it is only used to look at the rows.

## Quickstart (offline)

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

What you should see:

| Step | Result |
| --- | --- |
| `pnpm db:up` | A `postgres:18-alpine` container, published on **127.0.0.1:55432 only** (loopback; the dev credentials `graft`/`graft` are not reachable from the network). `--wait` returns once the health check passes. |
| `pnpm db:migrate` | Applies the migrations in `src/db/migrations/` (`0001_initial` to `0007_vote_eligibility`). |
| first `webhook:send` | `202 {"status":"enqueued"}`: the fixture `test/fixtures/webhooks/installation.created.json` was signed with `GITHUB_WEBHOOK_SECRET` from `.env`, verified, stored in `webhook_deliveries` and queued as a `github.webhook` job. |
| second `webhook:send` | `200 {"status":"duplicate"}`: the same `X-GitHub-Delivery` is never processed twice. |
| `psql ...` | One `installations` row and its `repositories` rows, written by the worker. |
| `curl localhost:3000/readyz` | `{"status":"ready","db":"ok","queue":"ok"}` (503 with `"unavailable"` if Postgres or pg-boss is down). `/healthz` answers `{"status":"ok","version":...}` without touching the database. |

`.env.example` sets `HOST=127.0.0.1`, so the server listens on the loopback only; use `0.0.0.0` only inside a container. `pnpm webhook:send <fixture> [--delivery <id>] [--url <url>]` accepts any file name in `test/fixtures/webhooks/` without `.json` (for example `pull_request.opened`), but fixtures other than the installation events make the worker call the GitHub API, which fails offline with the throwaway key.

### Next steps

- Without `ANTHROPIC_API_KEY` the service still runs: every intent card shows as unavailable with the rule-based risk floor. See [features/intent-cards.md](features/intent-cards.md).
- `pnpm eval:ci` runs the synthetic evaluation set against the fake model, offline ([features/evaluation.md](features/evaluation.md)).
- `pnpm graft policy check docs/examples/graft.yaml` validates a policy file with an empty environment ([features/policy.md](features/policy.md)).
- `pnpm graft e2e run --only-offline` runs the live end-to-end suite against a fake GitHub world ([e2e.md](e2e.md)).

## Tests

```sh
pnpm test:unit          # nothing needs to be running
pnpm db:up && pnpm test:integration   # real Postgres + real pg-boss
pnpm test               # both
pnpm test:perf          # opt-in: the wall-clock (millisecond) assertions of the unit tests
```

Integration tests use `TEST_DATABASE_URL` (default `postgres://graft:graft@localhost:55432/graft_test`). `test/global-setup.ts` drops and recreates `graft_test` on every run, then migrates. If Postgres is not reachable it fails with `Postgres not reachable at <host:port>; run pnpm db:up`. A network guard (`test/setup.ts`) makes any `fetch` to a non-localhost host throw, and GitHub is only ever reached through injected fakes. Test names carry the IDs from the step spec (`U-WH-3`, `I-INST-5`, ...), so `grep -rn "I-WH-" test/` finds them. **No default test asserts wall-clock time.** Tests about the cost of glob matching, redaction and the LLM deadline assert deterministic work units (`GlobBudget` fuel, `exhausted`, `limitHits`, `pairsUsed`) in `pnpm test`; their millisecond bounds go through `expectDuration` (`test/helpers/perf.ts`) and are enforced only with `GRAFT_PERF=1` (`pnpm test:perf`), otherwise only a 30 s sanity ceiling applies. Unit tests have a 120 s timeout, integration tests 30 s.

Fixtures in `test/fixtures/webhooks/` come from `@octokit/webhooks-examples`, rewritten to one fictional world (`scripts/generate-fixtures.ts`).

CI (`.github/workflows/ci.yml`) runs, on every push and pull request, with a Postgres 17 service on port 55432: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm eval:ci`, `pnpm graft policy schema --check`, `pnpm graft policy check` on `docs/examples/graft.yaml` and every `docs/pilots/graft.*.yaml`, and `pnpm build`. Its actions are pinned to commit SHAs and checkout keeps no credentials.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm build` | Compiles to `dist/` (`tsconfig.build.json`). |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm lint` / `pnpm format` | Biome in CI mode / Biome with `--write`. |
| `pnpm test`, `test:unit`, `test:integration`, `test:perf` | Vitest projects (see [Tests](#tests)). |
| `pnpm dev:server` / `pnpm dev:worker` | `tsx watch` on `src/bin/server.ts` / `src/bin/worker.ts`. |
| `pnpm start:server` / `pnpm start:worker` | The built entry points in `dist/bin/`. |
| `pnpm db:up` | `docker compose up -d --wait`. |
| `pnpm db:migrate`, `db:rollback`, `db:status` | `src/bin/migrate.ts up`, `down` (latest migration only), `status`. |
| `pnpm webhook:send` | Signs a fixture and POSTs it to the local server (`scripts/send-webhook.ts`). |
| `pnpm tunnel` | smee client forwarding `$SMEE_URL` to `http://localhost:${PORT:-3000}/webhooks/github`. |
| `pnpm eval`, `pnpm eval:ci` | The evaluation tool (`src/bin/eval.ts`); `eval:ci` checks the synthetic set against its baseline. |
| `pnpm graft` | The operator CLI (`src/bin/graft.ts`): `policy`, `pilot`, `baseline`, `gate`, `metrics`, `incident`, `e2e`. |
