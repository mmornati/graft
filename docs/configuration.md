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
| `ANTHROPIC_API_KEY` | unset | Sent as `x-api-key`. Without a credential (this, `ANTHROPIC_AUTH_TOKEN` or federation) the service still runs and every card shows as unavailable with the rule-based risk floor. Never commit a real key. |
| `ANTHROPIC_AUTH_TOKEN` | unset | Sent as `Authorization: Bearer`, for gateways that expect a bearer token (OpenRouter, Vercel AI Gateway, Bedrock Mantle). Set at most one way to authenticate: the key, this token or federation. |
| `ANTHROPIC_FEDERATION_RULE_ID` | unset | Workload Identity Federation: the federation rule (`fdrl_...`). Federation needs this, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE`, all or none, and no key or token. The only federation value that is logged. See [Deploying with federation](#deploying-with-federation). |
| `ANTHROPIC_ORGANIZATION_ID` | unset | Federation: the organization UUID (Claude Console, Settings, Organization). |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | unset | Federation: the service account (`svac_...`) the minted token acts as. |
| `ANTHROPIC_WORKSPACE_ID` | unset | Federation, optional: the workspace (`wrkspc_...`) to scope the token to. Required when the rule is enabled for more than one workspace. |
| `ANTHROPIC_IDENTITY_TOKEN_FILE` | unset | Federation: absolute path to the OIDC JWT your platform writes (for example a projected Kubernetes token). Read on every exchange, never at startup, and never logged. |
| `ANTHROPIC_BASE_URL` | unset (the Claude API) | An http(s) URL of any service that speaks the Anthropic Messages API, for example `https://openrouter.ai/api`. Diffs go to that service: check its data retention first. Only the host is logged. With federation the token exchange goes to the same host, so it must be https (or loopback). |
| `GRAFT_LLM_MODEL_FAST` | `claude-haiku-5-5` | First-pass writer when the rule-based floor is `trivial`. A Claude model ID, optionally with a gateway's vendor prefix or version suffix (`anthropic/claude-haiku-5.5`, `us.anthropic.claude-haiku-5-5-v1:0`). |
| `GRAFT_LLM_MODEL_STRONG` | `claude-sonnet-5-5` | Writer for everything else, and always the verifier. Same pattern. |
| `GRAFT_LLM_TIMEOUT_MS` | `120000` | Per-call timeout, 5,000 to 600,000 ms. |
| `GRAFT_LLM_MAX_RETRIES` | `2` | SDK retries, 0 to 5. |
| `GRAFT_LLM_REFUSAL_FALLBACK` | `true` | `true` or `false`: let the API retry a refused request on a substitute model (Sonnet and Opus only). Applies only on the Claude API: with an `ANTHROPIC_BASE_URL` other than `api.anthropic.com` it is never sent. |
| `GRAFT_LLM_REFUSAL_FALLBACK_MODEL` | unset (off) | A model Graft itself retries once when a call is refused and no server-side fallback ran: on a gateway or cloud, and for Haiku on the Claude API. The card names the model that answered. Same pattern as the model settings. |
| `GRAFT_LLM_DAILY_TOKEN_BUDGET` | `2000000` | Per-repository daily token budget (UTC day, from the `intent_spend` ledger); `0` means unlimited. |
| `GRAFT_INTENT_SENSITIVE_PATHS` | empty | Extra comma-separated globs that set the risk floor to `sensitive`, for example `services/billing/**`. 1 to 200 characters each, no leading `!`, no `..` segment, and the same checks as `graft.yaml` globs (validated at startup). |
| `GRAFT_FEEDBACK_POLL_CRON` | `*/15 * * * *` | Cron for polling 👍/👎 reactions on the managed comment, or `off`. Checked for shape only (5 fields). |
| `GRAFT_INCIDENT_LABEL` | `incident` | Label that marks a revert or fix PR as an incident, or `off`. 1 to 50 characters of `[A-Za-z0-9 ._:/-]`. |
| `GRAFT_METRICS_ROLLUP_CRON` | `15 2 * * *` | Cron for the daily metrics rollup (recomputes the last 7 UTC days), or `off`. |
| `GRAFT_METRICS_EXCLUDED_AUTHORS` | `dependabot[bot],renovate[bot]` | Logins left out of the baseline, the rollup PR counts and the gate coverage. |
| `GRAFT_MODE_CEILING` | `report` | `report` or `enforce`. The most any repository can be set to; `report` makes every repository report/off whatever `graft mode set` recorded. Read by the worker at start; see [Modes](features/modes.md). Leave it at `report` until the Phase 1 rollout runbook says otherwise. |
| `GRAFT_MODE_APPLY_CRON` | `* * * * *` | Cron for the worker job that republishes the policy check of a repository after `graft mode set`, or `off`. |
| `GRAFT_PERMISSIONS_REFRESH_CRON` | `30 3 * * *` | Cron for the daily refresh of each installation's permissions from the GitHub API, or `off`. |
| `GRAFT_BREAK_GLASS_LABEL` | `graft:break-glass` | The label a maintainer or admin adds to bypass the policy for one commit (Phase 1 step 3). 1 to 50 characters, no control characters or surrounding spaces, matched case-insensitively against label names. `off` (any case) turns break-glass off: the label is then an ordinary label and nothing is audited. Not settable from `graft.yaml`. See [Policy, break-glass](features/policy.md#break-glass). |
| `GRAFT_GUARD_DETECTION` | `on` | `on` or `off`. The post-merge guard's kill switch: `off` drops every guard trigger and makes the guard jobs and crons do nothing. See [Post-merge guard](features/guard.md). |
| `GRAFT_GUARD_CONFIRM` | `on` | `on` or `off`. Wait for a red default-branch check to persist (the next commit is red, or the window below passes) before naming a culprit; a check that turns green first makes the event `flaky`. `off`: the outcome is final at detection. |
| `GRAFT_GUARD_CONFIRM_SECONDS` | `7200` | Integer 300 to 86400. The confirmation window; `guard.confirm` runs at its end. |
| `GRAFT_GUARD_OBSERVE_DELAY_SECONDS` | `30` | Integer 0 to 600. How long `guard.observe` waits after a trigger; triggers for one commit within this window share one job. `0`: no wait and no grouping. |
| `GRAFT_GUARD_RETENTION_DAYS` | `30` | Integer 7 to 365. Default-branch commits and CI results older than this are deleted by `guard.prune` (except those an open event refers to). |
| `GRAFT_GUARD_PRUNE_CRON` | `45 3 * * *` | Cron for the daily `guard.prune` job, or `off`. |
| `GRAFT_POLICY_CARD_WAIT_SECONDS` | `600` | Integer 0 to 3600. In enforce mode, how long `graft/policy` stays `in_progress` after a head is first evaluated while its intent card is still being written; after that it concludes on the conservative pending-card rules. `0` never waits. Report mode never waits (it still schedules the re-evaluation). See [Policy](features/policy.md#enforce-mode). |

## Deploying with federation

Workload Identity Federation lets Graft authenticate to the Claude API without a long-lived key: the platform it runs on issues an OIDC JWT, Graft exchanges it at `POST /v1/oauth/token` for a token that lasts as long as the federation rule says (one hour by default), and the SDK exchanges again shortly before it expires or after a 401. Set it up in the Claude Console (an issuer, a service account and a federation rule; see Anthropic's [Workload Identity Federation guide](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation)), then set the four required variables above.

- **The host must issue OIDC tokens.** Kubernetes (projected service account tokens, including GKE and EKS), Google Cloud Run, Azure (managed identity or workload identity), GitHub Actions and Fly.io (custom OIDC tokens) do. The token has to reach Graft as a file: a projected volume on Kubernetes, or a small sidecar or startup script that fetches it from the metadata service and rewrites the file on other platforms. Render and similar hosts that issue no OIDC token cannot use federation: keep `ANTHROPIC_API_KEY` there.
- **Tokens are single use.** An assertion with a `jti` claim can be exchanged only once, so the file must hold a fresh token before every exchange. Kubernetes rotates projected tokens on its own (set `expirationSeconds` well below the rule's maximum lifetime); a script that writes the file must refresh it more often than the minted token expires. A replayed token fails with a 401 and shows as `jti_reused` in the Console's authentication history; Graft reports the call as `auth`.
- **Remove the old key.** Graft refuses to start when `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set alongside federation, rather than letting the key silently win. Unset the variable (do not leave it empty in a secret store that other tools also read: the SDK and Claude Code treat an empty key as set).
- **Failures.** A rejected token, rule or ID and an unreadable token file map to `auth`; an unreachable token endpoint or a 5xx to `unavailable`. The card shows "unavailable" either way; the log line carries the HTTP status, never the token or the response body.

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
