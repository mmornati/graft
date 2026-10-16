# Configuration

[Docs index](README.md) · [Getting started](getting-started.md) · [Troubleshooting](troubleshooting.md)

The server, the worker and the `pnpm graft` commands read their settings from the environment. `src/bin/*` loads `.env` if it exists (copy [`.env.example`](../.env.example)); tests never read `.env`. Validation lives in [`src/config/index.ts`](../src/config/index.ts): an unset or empty variable takes its default, then the value is checked, and an error names the variable and the rule only, never the value. The evaluation tool has its own copy of the relevant rules in `src/eval/env.ts`, so it never needs a database URL or the webhook secret.

"Default" is the value used when the variable is unset; ".env.example" shows what the shipped example sets when that differs.

## Server and worker

| Variable | Default | Rule and use |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. In `production` the `.env.example` webhook secret is refused. |
| `HOST` | `0.0.0.0` (.env.example: `127.0.0.1`) | Listen address. Keep the loopback for local runs (smee forwards to localhost); use `0.0.0.0` only inside a container. |
| `PORT` | `3000` | 1 to 65535. Also used by `pnpm tunnel`. |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. |
| `DATABASE_URL` | required (.env.example: `postgres://graft:graft@localhost:55432/graft`) | A `postgres://` or `postgresql://` URL. The compose database is bound to 127.0.0.1:55432. |
| `GITHUB_APP_ID` | required (.env.example: `123456`) | The App's numeric ID. Any number works for a local run without a real App. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | (.env.example: `./dev.pem`) | Path to the App's PEM key. Set exactly one of this and `GITHUB_APP_PRIVATE_KEY`. Keep the file outside the repository for a real App. |
| `GITHUB_APP_PRIVATE_KEY` | unset | The PEM inline; a literal `\n` is accepted. Exactly one of the two key variables. |
| `GITHUB_WEBHOOK_SECRET` | required (.env.example: a placeholder) | At least 16 characters; must equal the App's webhook secret. Generate with `openssl rand -hex 32`. The placeholder is refused when `NODE_ENV=production`. |
| `GITHUB_API_URL` | `https://api.github.com` | A URL. |
| `PGBOSS_SCHEMA` | `pgboss` | Postgres schema for pg-boss; `^[a-z_][a-z0-9_]*$`. |
| `WORKER_CONCURRENCY` | `5` | 1 to 50 jobs at a time per worker. |
| `WEBHOOK_BODY_LIMIT_BYTES` | `26214400` | Webhook body cap in bytes (GitHub's limit is 25 MB). |
| `SMEE_URL` | unset | A URL from <https://smee.io/new>; only used by `pnpm tunnel`. |
| `GRAFT_AGENT_LOGINS` | empty | Comma-separated GitHub logins that always count as agent accounts (letters, digits, `-`, optional `[bot]`; lowercased). Also excluded from gate votes. |
| `GRAFT_AGENT_COAUTHOR_EMAILS` | `noreply@anthropic.com` | Comma-separated `Co-authored-by` emails that mark a commit as agent-written (default: Claude Code's). |
| `GITHUB_APP_SLUG` | unset | The App's slug. Enables the `<slug>[bot]` fallback for recognising Graft's own PR comment when `performed_via_github_app` is missing (decision D13). |
| `ANTHROPIC_API_KEY` | unset | Without it the service still runs and every card shows as unavailable with the rule-based risk floor. Never commit a real key. |
| `GRAFT_LLM_MODEL_FAST` | `claude-haiku-5-5` | First-pass writer when the rule-based floor is `trivial`. `^claude-[a-z0-9-]{1,60}$`. |
| `GRAFT_LLM_MODEL_STRONG` | `claude-sonnet-5-5` | Writer for everything else, and always the verifier. Same pattern. |
| `GRAFT_LLM_TIMEOUT_MS` | `120000` | Per-call timeout, 5,000 to 600,000 ms. |
| `GRAFT_LLM_MAX_RETRIES` | `2` | SDK retries, 0 to 5. |
| `GRAFT_LLM_REFUSAL_FALLBACK` | `true` | `true` or `false`: let the API retry a refused request on a substitute model (Sonnet and Opus only). |
| `GRAFT_LLM_DAILY_TOKEN_BUDGET` | `2000000` | Per-repository daily token budget (UTC day, from the `intent_spend` ledger); `0` means unlimited. |
| `GRAFT_INTENT_SENSITIVE_PATHS` | empty | Extra comma-separated globs that set the risk floor to `sensitive`, for example `services/billing/**`. 1 to 200 characters each, no leading `!`, no `..` segment, and the same checks as `graft.yaml` globs (validated at startup). |
| `GRAFT_FEEDBACK_POLL_CRON` | `*/15 * * * *` | Cron for polling 👍/👎 reactions on the managed comment, or `off`. Checked for shape only (5 fields). |
| `GRAFT_INCIDENT_LABEL` | `incident` | Label that marks a revert or fix PR as an incident, or `off`. 1 to 50 characters of `[A-Za-z0-9 ._:/-]`. |
| `GRAFT_METRICS_ROLLUP_CRON` | `15 2 * * *` | Cron for the daily metrics rollup (recomputes the last 7 UTC days), or `off`. |
| `GRAFT_METRICS_EXCLUDED_AUTHORS` | `dependabot[bot],renovate[bot]` | Logins left out of the baseline, the rollup PR counts and the gate coverage. |

## Tool and shell-only variables

These are read by the CLIs, tests or hooks, not by the server and worker. Secrets among them belong in the shell or a password manager, **never in `.env`**.

| Variable | Read by | Default and use |
| --- | --- | --- |
| `GRAFT_EVAL_DIR` | `pnpm eval` | Directory holding pilot case sets; default `~/.graft-eval`. Must be outside every git working tree; exclude it from backups and cloud sync. |
| `GRAFT_EVAL_KEY` | `pnpm eval` | Base64 of 32 random bytes that encrypts pilot sets (`pnpm eval keygen` makes one). Shell only: the CLI ignores a value that only `.env` provides and warns. |
| `GRAFT_EVAL_GITHUB_TOKEN` | `pnpm eval export --auth token` | Read-only fine-grained token, for pilots without the App installed. |
| `GRAFT_EVAL_DEBUG` | `pnpm eval` | `1` adds the message to unmapped errors (which otherwise print their class name only). |
| `GRAFT_BASELINE_GITHUB_TOKEN` | `pnpm graft baseline --auth token` | Token for a dry-run baseline of a repository the App is not installed on (GET requests only). |
| `GRAFT_E2E_ACTOR_TOKEN` | `pnpm graft e2e` | The actor (repository owner) token; falls back to `gh auth token`. Shell only: the runner refuses to start if `.env` holds any `GRAFT_E2E_*` key or the actor token's value. |
| `GRAFT_E2E_OUTSIDER_TOKEN` | `pnpm graft e2e` | Optional second account that votes without being a reviewer. Shell only. |
| `GRAFT_AGENT`, `GRAFT_MODEL`, `GRAFT_TASK`, `GRAFT_SESSION` | `scripts/pilot/prepare-commit-msg` | Values for the `Graft-*` trailers; the hook does nothing without `GRAFT_AGENT`. |
| `TEST_DATABASE_URL` | integration tests | Default `postgres://graft:graft@localhost:55432/graft_test`; the database is dropped and recreated on every run. |
| `GRAFT_PERF` | unit tests | `1` (or `pnpm test:perf`) enforces the millisecond bounds of the performance assertions. |

The e2e runner also sets `GRAFT_E2E_GIT_TOKEN` (for its own `git` child, through `GIT_ASKPASS`) and `GRAFT_E2E_OFFLINE_OUT`, `GRAFT_E2E_OFFLINE_LLM` and `GRAFT_E2E_OFFLINE_SCENARIOS` (for the `--only-offline` test child). They are internal; do not set them yourself.

## Files

| File | Purpose |
| --- | --- |
| [`.env.example`](../.env.example) | The local defaults; copy to `.env`. |
| [`docker-compose.yml`](../docker-compose.yml) | Postgres 17 on `127.0.0.1:55432` (user, password and database `graft`). |
| [`github/app-manifest.json`](../github/app-manifest.json) | The App's permissions and events (pinned by `test/unit/manifest.test.ts`). |
| `graft.yaml` (in each target repository) | The policy; see [features/policy.md](features/policy.md). |
| [`e2e/sandboxes.json`](../e2e/sandboxes.json) | The sandbox repositories the live e2e runner may write to. |
