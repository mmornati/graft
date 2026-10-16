# Troubleshooting

[Docs index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md)

## Webhooks and local setup

- **401 `invalid signature`**: `GITHUB_WEBHOOK_SECRET` differs from the App's webhook secret (or from the one `pnpm webhook:send` reads from `.env`).
- **Duplicate deliveries**: GitHub redelivers on timeouts; the second delivery with the same `X-GitHub-Delivery` returns `200 {"status":"duplicate"}` and enqueues nothing. A delivery that failed with 500 is rolled back, so redelivering it is processed normally.
- **Port 55432 already in use**: another process holds it; stop it or change the host port in `docker-compose.yml` and `DATABASE_URL` / `TEST_DATABASE_URL`.
- **`run pnpm db:migrate`** on startup: the schema is behind; run the migration.
- **`Postgres not reachable ... run pnpm db:up`** from the integration tests: start the container.
- **`Invalid configuration:` at startup**: the message lists each bad variable by name with its rule (values are never printed). Common ones: `GITHUB_APP_PRIVATE_KEY / GITHUB_APP_PRIVATE_KEY_PATH: set exactly one of them` (or `not both`), `GITHUB_APP_PRIVATE_KEY_PATH: file cannot be read` (run `openssl genrsa -out dev.pem 2048` for a local run), `GITHUB_WEBHOOK_SECRET: must be at least 16 characters`.
- **`GITHUB_WEBHOOK_SECRET: is the .env.example placeholder`**: with `NODE_ENV=production` the shipped placeholder is refused. Generate a secret with `openssl rand -hex 32` and set the same value on the App.
- **Nothing arrives from GitHub**: `gh webhook forward` does not work for GitHub App webhooks. Use `pnpm tunnel` (smee, with `SMEE_URL` set), or ngrok / cloudflared pointed at `http://localhost:3000/webhooks/github`. See [github-app.md](github-app.md).
- **The server is unreachable from a container or another host**: `.env.example` sets `HOST=127.0.0.1` (loopback). Use `HOST=0.0.0.0` only inside a container. The config default when `HOST` is unset is `0.0.0.0`.
- **`/readyz` answers 503**: the body says which of `db` and `queue` is `error`; check that Postgres is up (`pnpm db:up`) and that `DATABASE_URL` points at it.

## Cards, policy and crons

- **Every card says unavailable**: neither `ANTHROPIC_API_KEY` nor `ANTHROPIC_AUTH_TOKEN` is set, the gateway at `ANTHROPIC_BASE_URL` rejects the credential or the model ID (`llm_auth`, `llm_bad_request`), the model call failed or timed out, or the repository's daily token budget (`GRAFT_LLM_DAILY_TOKEN_BUDGET`) is used up. The card states the reason and the risk is at least `logic`.
- **The worker stops at startup after a cron change**: `GRAFT_FEEDBACK_POLL_CRON` and `GRAFT_METRICS_ROLLUP_CRON` are checked for shape only (5 fields of digits, `*`, `/`, `,`, `-`); pg-boss validates the expression itself at `schedule()` time. Use `off` to disable a cron.
- **A startup error names a glob position**: `GRAFT_INTENT_SENSITIVE_PATHS` is validated with the same checks as `graft.yaml`; the error gives the glob's 1-based position and the reason, never the value. See [graft-yaml.md](graft-yaml.md).
- **The `graft/policy` check is neutral even for "Would block"**: expected in Phase 0. Nothing is enforced.

## Pilot and gate commands

- **`run pnpm db:migrate`** from any `pnpm graft` command: the schema is behind.
- **Exit code 2**: usage or configuration error (a bad value names the variable only). **3**: aborted (rate-limit wait above `--max-wait`, `--max-requests`, a refused purge). **4**: `gate report --check` with INSUFFICIENT DATA. See [features/pilots-and-gate.md](features/pilots-and-gate.md).
- **`pilot doctor` warns about 403s** in the `feedback` check: the reviewer permission check was refused; does the App have `Metadata: read`? Requested reviewers are then not eligible (fail closed).
- **Votes dropped as `not_reviewer` after deploying migration 0007**: rows stored before it are unverified; run `pnpm graft pilot sync-reviewers --installation <id> --since <date>`.

## Live e2e

The runbook has one section per failure code (`preflight`, `guard_refusal`, `no_delivery`, `signature`, `card_timeout`, `llm_failure`, `neutral_violation`, `comment_ownership`, `sentinel_leak`, `doctor`, `permission_403`, `rate_limit`, `model_mismatch`, `budget`): [docs/e2e/runbook.md](e2e/runbook.md#11-when-something-fails).
