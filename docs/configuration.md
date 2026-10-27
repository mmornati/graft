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
| `GITHUB_APP_SLUG` | unset | The App's slug. Enables the `<slug>[bot]` fallback for recognising Graft's own PR comment when `performed_via_github_app` is missing (decision D13). MCP's `open_change` also needs it to recognise a PR Graft opened whose record was lost (Phase 1 step 6, review 1): without it such a PR is returned but not re-recorded. Stored lowercased (Phase 1 step 7), as GitHub writes `<slug>[bot]` logins. |
| `ANTHROPIC_API_KEY` | unset | Sent as `x-api-key`. Without a credential (this, `ANTHROPIC_AUTH_TOKEN` or federation) the service still runs and every card shows as unavailable with the rule-based risk floor. Never commit a real key. |
| `ANTHROPIC_AUTH_TOKEN` | unset | Sent as `Authorization: Bearer`, for gateways that expect a bearer token (OpenRouter, Vercel AI Gateway, Bedrock Mantle). Set at most one way to authenticate: the key, this token or federation. |
| `ANTHROPIC_FEDERATION_RULE_ID` | unset | Workload Identity Federation: the federation rule (`fdrl_...`). Federation needs this, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE`, all or none, and no key or token. The only federation value that is logged. See [Deploying with federation](#deploying-with-federation). |
| `ANTHROPIC_ORGANIZATION_ID` | unset | Federation: the organization UUID (Claude Console, Settings, Organization). |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | unset | Federation: the service account (`svac_...`) the minted token acts as. |
| `ANTHROPIC_WORKSPACE_ID` | unset | Federation, optional: the workspace (`wrkspc_...`) to scope the token to. Required when the rule is enabled for more than one workspace. |
| `ANTHROPIC_IDENTITY_TOKEN_FILE` | unset | Federation: absolute path to the OIDC JWT your platform writes (for example a projected Kubernetes token). Read on every exchange, never at startup, and never logged. |
| `ANTHROPIC_BASE_URL` | unset (the Claude API) | An http(s) URL of any service that speaks the Anthropic Messages API, for example `https://openrouter.ai/api`. Diffs go to that service: check its data retention first. Only the host is logged. With federation the token exchange goes to the same host, so it must be https (or loopback). |
| `GRAFT_LLM_MODEL_FAST` | `claude-haiku-5-5` | Without a provider registry only (with one, its `roles.fast` names the model and setting this is an error). First-pass writer when the rule-based floor is `trivial`. A Claude model ID, optionally with a gateway's vendor prefix or version suffix (`anthropic/claude-haiku-5.5`, `us.anthropic.claude-haiku-5-5-v1:0`). |
| `GRAFT_LLM_MODEL_STRONG` | `claude-sonnet-5-5` | Without a provider registry only (`roles.strong` with one). Writer for everything else, and always the verifier. Same pattern. |
| `GRAFT_LLM_TIMEOUT_MS` | `120000` | Per-call timeout, 5,000 to 600,000 ms. |
| `GRAFT_LLM_MAX_RETRIES` | `2` | SDK retries, 0 to 5. |
| `GRAFT_LLM_REFUSAL_FALLBACK` | `true` | `true` or `false`: let the API retry a refused request on a substitute model (Sonnet and Opus only). Applies only on the Claude API: with an `ANTHROPIC_BASE_URL` other than `api.anthropic.com` it is never sent. |
| `GRAFT_LLM_REFUSAL_FALLBACK_MODEL` | unset (off) | Without a provider registry only (`roles.refusalFallback` with one). A model Graft itself retries once when a call is refused and no server-side fallback ran: on a gateway or cloud, and for Haiku on the Claude API. The card names the model that answered. Same pattern as the model settings. |
| `GRAFT_DEPLOYMENT` | `self-hosted` | `self-hosted` or `hosted`. Set `hosted` when Graft serves repositories of people other than the operator (a GitHub App others install): startup then refuses the `cli:*` [provider kinds](#model-providers), which run on a personal CLI login. |
| `GRAFT_LLM_PROVIDERS` | unset | A [provider registry](#model-providers), inline as YAML or JSON. Set at most one of this and `GRAFT_LLM_PROVIDERS_FILE`. Unset: Graft uses the single client built from the `ANTHROPIC_*` settings, as before. |
| `GRAFT_LLM_PROVIDERS_FILE` | unset | Path to the same document as a YAML or JSON file, read at startup. |
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
| `GRAFT_GUARD_REVERT` | `on` | `on` or `off` (Phase 1 step 5). The revert kill switch: `off` makes `guard.revert` publish the step 4 comment (no plan) and record `skipped` / `revert_off`; detection is unaffected. See [Post-merge guard, revert pull requests](features/guard.md#revert-pull-requests). |
| `GRAFT_GUARD_MAX_OPEN_REVERTS` | `3` | Integer 1 to 10. At most this many guard events per repository in `revert_opened`; a confirmed culprit beyond it is `skipped` / `cap_reached`. A revert PR merged or closed releases its slot. |
| `GRAFT_GUARD_REVERT_MAX_PATHS` | `300` | Integer 1 to 1000. A culprit whose tree diff has more changed paths than this is `needs_human` / `too_large`. |
| `GRAFT_GUARD_REVERT_MAX_TREE_READS` | `200` | Integer 10 to 1000. Tree objects one revert plan may read (`GET …/git/trees/{sha}`); a plan that needs more is `needs_human` / `too_large`. |
| `GRAFT_GUARD_REVERT_MAX_AGE_HOURS` | `24` | Integer 1 to 168. A culprit confirmed more than this many hours ago is `skipped` / `stale` before any write, so a `guard.revert` sent again late (after a failed run) never opens a revert days after the failure. A revert whose writes already began is resumed whatever its age. |
| `GRAFT_MCP` | `on` | `on` or `off`. Phase 1 step 6: the MCP endpoint `/mcp` on the server. `off` does not register the route (`404`); `pnpm graft mcp-token` still manages tokens. With no token created, `on` exposes only a `401`. See [MCP server](features/mcp.md). |
| `GRAFT_MCP_ALLOWED_ORIGINS` | empty | Comma-separated origins (`https://host[:port]`, no path) a browser may call `/mcp` from. A request with any other `Origin` header gets `403`. Empty refuses every browser; agents send no `Origin`. |
| `GRAFT_MCP_RATE_LIMIT_PER_MINUTE` | `60` | Integer 1 to 600. Requests per MCP token per minute, per server process (`429` with `Retry-After`). |
| `GRAFT_MCP_AUTH_FAILURES_PER_MINUTE` | `20` | Integer 1 to 600. Failed MCP authentications per client IP per minute, per server process; past it the IP gets `429` for the rest of the minute, before any database lookup. The IP is the connection's peer, or the client address from `X-Forwarded-For` when the peer is listed in `GRAFT_TRUST_PROXY`. |
| `GRAFT_MCP_OPEN_CHANGE_PER_HOUR` | `10` | Integer 1 to 100. PRs `open_change` may open per repository in any rolling hour, counted in the database across processes. |
| `GRAFT_MCP_MAX_TOKENS_PER_REPO` | `10` | Integer 1 to 50. Active MCP tokens per repository (`pnpm graft mcp-token create` refuses past it). |
| `GRAFT_TRUST_PROXY` | empty | Phase 1 step 7 (D6). Comma-separated IP addresses or CIDR ranges (IPv4 or IPv6) of the proxies in front of the server. When the connection's peer is one of them, the client address is taken from `X-Forwarded-For`, so each MCP client behind the proxy has its own failed-authentication bucket. Empty: the peer is the client. `true`, hop counts and hostnames are refused (`ConfigError` naming the entry's position, never its value). List only the proxy's own addresses (for example `10.0.0.5`), never a network that holds clients: a client that connects from a listed address chooses its own. The proxy must append the peer address to `X-Forwarded-For` (nginx `$proxy_add_x_forwarded_for`) or overwrite it, and Graft must be reachable only through the proxy. |
| `GRAFT_POLICY_CARD_WAIT_SECONDS` | `600` | Integer 0 to 3600. In enforce mode, how long `graft/policy` stays `in_progress` after a head is first evaluated while its intent card is still being written; after that it concludes on the conservative pending-card rules. `0` never waits. Report mode never waits (it still schedules the re-evaluation). See [Policy](features/policy.md#enforce-mode). |

## Model providers

By default Graft sends every model call to one Anthropic Messages API endpoint, configured with the `ANTHROPIC_*` variables. A **provider registry** lists several providers instead and says which one each role uses. It is operator configuration only: repositories cannot choose a provider in `graft.yaml`, because the provider decides where diffs go and who pays.

```yaml
# GRAFT_LLM_PROVIDERS_FILE=/etc/graft/providers.yaml
providers:
  - id: claude               # 1-30 characters of a-z, 0-9 and '-'
    kind: anthropic          # uses ANTHROPIC_API_KEY / _AUTH_TOKEN / federation and ANTHROPIC_BASE_URL
  - id: openrouter
    kind: anthropic
    baseUrl: https://openrouter.ai/api
    authTokenEnv: OPENROUTER_API_KEY   # the variable's name, never the key
    prices:                  # USD per million tokens; cacheRead and cacheWrite default to input
      anthropic/claude-sonnet-5.5: { input: 2, output: 10 }
  - id: ollama
    kind: openai-compatible
    baseUrl: http://ollama:11434/v1    # up to, not including, /chat/completions
    prices:
      qwen3-coder: { input: 0, output: 0 }
roles:
  fast: ollama/qwen3-coder:30b
  strong: openrouter/anthropic/claude-sonnet-5.5
  refusalFallback: claude/claude-opus-5-5      # optional
```

- **Roles.** `fast` is the first-pass writer for `trivial` PRs, `strong` the writer for everything else and the verifier, and `refusalFallback` the model Graft retries once on a refusal. Each is `<provider id>/<model>`: everything after the first `/` is the provider's own model ID. The card, the `llm call` log line and the spend ledger name the model with its provider.
- **Credentials.** An entry names the variable holding its key with `apiKeyEnv` (sent as `x-api-key`) or `authTokenEnv` (sent as a bearer token), at most one. An `anthropic` entry with neither uses the `ANTHROPIC_*` credential, federation included, and `ANTHROPIC_BASE_URL`; it cannot set its own `baseUrl`, so a shared credential never goes to a host it was not meant for. Startup fails when a named variable is unset.
- **Kinds.**
  - `anthropic`: any endpoint that speaks the Anthropic Messages API (the Claude API, OpenRouter, Vercel AI Gateway, LiteLLM, Bedrock Mantle). Its roles take Claude model IDs, as `GRAFT_LLM_MODEL_*` do.
  - `openai-compatible`: any Chat Completions endpoint: OpenAI, OpenRouter, Mistral, DeepSeek, Gemini's OpenAI-compatible endpoint, and local servers (Ollama, vLLM, LM Studio, llama.cpp, the LiteLLM proxy). `baseUrl` is required. `apiKeyEnv` is optional (sent as a bearer token; a local server may need none) and `authTokenEnv` does not exist. Its roles take any model ID without spaces, Ollama tags included. `zeroRetention: true` asks OpenRouter for zero-data-retention endpoints and no data collection (refused for any other host). `maxTokensParam` is `max_completion_tokens` for `api.openai.com` and `max_tokens` elsewhere; set it when a server wants the other one. The `OPENAI_*` variables are never read, except `OPENAI_CUSTOM_HEADERS`, which the SDK always applies.
  - `cli:claude`: Claude Code (`claude -p`) on this machine, logged in however the operator set it up (a subscription, `CLAUDE_CODE_OAUTH_TOKEN`, an API key). **Self-hosted, single-tenant only**: a personal login may not serve other people's pull requests, so `GRAFT_DEPLOYMENT=hosted` refuses it, and the worker logs a warning at startup. `command` is the binary (default `claude` on `PATH`, or an absolute path). Its roles take Claude model IDs; pass explicit IDs, as aliases can resolve to older models. See [CLI providers](#cli-providers).
  - `cli:codex`: OpenAI Codex (`codex exec`), with the same rules. Model IDs are Codex's (`gpt-5.5`). Built against codex-cli 0.162.1 and checked offline (every flag and feature name is accepted), but not yet run against a live login: run `pnpm eval --live` with it before putting it in a role. Graft puts the schema in the prompt, because `--output-schema` is strict and Graft's schema has an `anyOf` root.
  - `cli:opencode`: opencode (`opencode run`), with the same rules. Model IDs are opencode's `<provider>/<model>` (`openrouter/qwen/qwen3-coder`). Checked against opencode 1.19.3. No schema flag: the schema goes in the prompt.
  - `copilot`: GitHub Copilot, billed to the installation that owns the pull request. Allowed on a hosted deployment, but only for the installations listed in `installations`; every other installation (and the eval tool) gets the model named in `fallbackModels`. See [Copilot provider](#copilot-provider).
- **Capabilities.** An `anthropic` provider is assumed to support JSON-schema output, prompt caching, effort and usage counts. An `openai-compatible` one is assumed to support JSON-schema output and usage counts only: many models reject `reasoning_effort`, and caching, where it exists, needs no markers. Set `capabilities: { effort: true }` to send Graft's effort as `reasoning_effort`. Override what an endpoint lacks, for example `capabilities: { nativeSchema: false }` for Bedrock Mantle: Graft then puts the schema in the system prompt and relies on its own validation and retry.
- **Prices.** Calls on an `anthropic` provider are priced from the built-in Claude table unless the entry's `prices` names the model. An `openai-compatible` provider has only its `prices`. The longest key that equals the model or is followed by `-`, `:` or `@` wins, so `qwen3-coder` prices `qwen3-coder:30b`. A model with no price leaves the card's cost unknown; the daily token budget still counts its tokens.
- **Refusal fallback.** `GRAFT_LLM_REFUSAL_FALLBACK` applies to every `anthropic` provider whose URL is the Claude API.
- **Backward compatible.** Without `GRAFT_LLM_PROVIDERS` or `GRAFT_LLM_PROVIDERS_FILE` nothing changes. With a registry, `GRAFT_LLM_MODEL_FAST`, `GRAFT_LLM_MODEL_STRONG` and `GRAFT_LLM_REFUSAL_FALLBACK_MODEL` must be unset: the roles replace them instead of quietly overriding them. Changing models changes the card's input hash, so open PRs get a new card on their next push, as with any model change.
- **Errors** name the field (`GRAFT_LLM_PROVIDERS: providers[1].authTokenEnv: names a variable that is not set`), never a value. The startup log lists each provider's id, kind, host and whether it uses the shared credential.

The evaluation tool (`pnpm eval`) reads the same registry with the same rules, so a candidate model can be run against the saved baseline before it goes into a role. A live run refuses a model with no price: give a local model `{ input: 0, output: 0 }`. See [Evaluation](features/evaluation.md).

### CLI providers

A `cli:*` provider runs the CLI once per model call. The CLI is an agent with tools, and Graft feeds it untrusted PR text, so Graft isolates it whatever the registry says:

- **No tools.** Tools, MCP servers, settings files (and the hooks, plugins and skills they enable) and session storage are all off. For `cli:claude` that is `--tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands --no-session-persistence`. The PR text goes on stdin, never as an argument.
- **An empty directory.** Each call runs in a fresh temporary directory, removed afterwards, so no project file or `CLAUDE.md` is in reach.
- **A clean environment.** The CLI gets `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL` and `TMPDIR`, plus the variables listed in the entry's `passEnv` (its login, for example `CLAUDE_CODE_OAUTH_TOKEN`). `GITHUB_*`, `GRAFT_*`, `PG*`, `SMEE_*`, anything ending in `DATABASE_URL` or `_PRIVATE_KEY`, and other providers' key variables are refused in `passEnv` and never passed.
- **Bounded.** The whole process group is killed at the call's deadline, and output beyond 4 MiB fails the call.

Per CLI:

- **`cli:claude`:** the flags above. The output-token limit goes through `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
- **`cli:codex`:** `exec --json --ephemeral --ignore-user-config --ignore-rules --sandbox read-only`. Every feature that hands the model a tool (`shell_tool`, `unified_exec`, `browser_use`, `computer_use`, `apps`, `plugins`, `hooks`, `multi_agent` and more) gets a `--disable`. Web search, MCP servers and `AGENTS.md` are off, shell commands inherit no environment, and Graft's system prompt goes in `developer_instructions`. The login comes from `CODEX_HOME` (default `~/.codex`) or from `CODEX_API_KEY` / `OPENAI_API_KEY` named in `passEnv`.
- **`cli:opencode`:** opencode has no flag that turns tools off. Each call carries its own config in `OPENCODE_CONFIG_CONTENT`: one agent with every tool off by name and every permission denied, no MCP server, plugin or instruction file. The `OPENCODE_DISABLE_*` switches turn off project config, Claude Code files, default plugins, external skills, LSP downloads and updates. Its config and data directories point into the call's scratch directory, so neither the global config nor `auth.json` is read, and no session stays on disk. Pass the login as `OPENCODE_AUTH_CONTENT` (the contents of `auth.json`) or as a provider's own key variable (`OPENROUTER_API_KEY`, ...) in `passEnv`.
- **All three:** for `cli:codex` and `cli:opencode`, a call whose event stream shows a tool that actually ran fails as `bad_request`, and nothing it produced is used.

Run the worker as a dedicated user whose `HOME` holds only the CLI's login. The default Docker image ships no CLI: build `FROM` the Graft image, install the CLI, and mount its login read-only. Usage comes from the CLI's own counters. Calls are unpriced unless the entry has `prices`, since the login, not Graft, decides what they cost.

### Copilot provider

A `copilot` provider bills each call to the Copilot plan of the organization that installed Graft, through an installation token limited to `copilot_requests: write`. It is built against `@github/copilot-sdk` 1.0.19 and **has not yet been run against a live installation**. Run `pnpm eval --live` with it on an opted-in test installation before relying on it.

```yaml
providers:
  - id: claude
    kind: anthropic
  - id: copilot
    kind: copilot
    installations: [12345678]            # installations that opted into billing their Copilot
    fallbackModels:                      # required for every model a role uses on copilot
      gpt-5-mini: claude/claude-haiku-5-5
      claude-sonnet-4.5: claude/claude-sonnet-5-5
roles:
  fast: copilot/gpt-5-mini
  strong: copilot/claude-sonnet-4.5
```

Before it serves an installation, set up all of the following:

1. **Install the SDK.** `@github/copilot-sdk` is not one of Graft's dependencies: its runtime is large and most deployments never use it. Add it to your image (`pnpm add @github/copilot-sdk@1.0.19` in a derived Dockerfile). Without it every Copilot call fails `not_configured`, the card falls back to "unavailable", and the worker logs `copilot provider: the SDK is not installed`.
2. **Grant the permission.** In the GitHub App's settings, add the **Copilot requests** permission (read and write). Graft's shipped manifests do not request it, so an App created from them never asks installers for Copilot billing. Each installing organization then has to accept the new permission.
3. **Let the organization allow it.** The organization's Copilot policy must allow Copilot requests from GitHub Apps. GitHub also requires the App to be installed on all repositories.
4. **Opt the installation in.** Add the installation ID to `installations`. Removing it switches that installation back to the fallback at the next restart.

How it runs:

- Each call mints a fresh installation token limited to `copilot_requests: write`. It lasts an hour and is never logged or cached with Graft's other tokens.
- One Copilot runtime runs per worker, in multi-user (`"empty"`) mode, with no logged-in user and the same stripped environment as the CLI providers (`passEnv` adds to it).
- Every session gets `availableTools: []` and `mcpServers: {}`, with config discovery, skills, the session store and infinite sessions off.
- The system message is replaced, not appended to; every permission request is rejected; each session runs in an empty directory removed afterwards.
- A call fails as `bad_request` if a tool ran anyway.
- The card names the model that answered, `copilot/...` or the fallback, and calls are unpriced unless the entry has `prices`, since GitHub bills AI credits to the organization.

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
