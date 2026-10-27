# Choosing a model provider

[Docs index](README.md) · [Configuration](configuration.md#model-providers) · [Troubleshooting](troubleshooting.md)

Graft writes each intent card with one model call and checks it with a second. By default both go to the Claude API. This page explains how to pick another provider, install what it needs, select its models and check the result before you rely on it. Every setting is listed in [Configuration, Model providers](configuration.md#model-providers).

Providers are **operator configuration only**. A repository cannot choose one in `graft.yaml`, because the provider decides where diffs go and who pays for them.

## Which provider should I use?

| You want | Use | Setup |
| --- | --- | --- |
| The default: best card quality, least setup | The Claude API | [`ANTHROPIC_API_KEY`](#1-the-claude-api-default) |
| Claude through a gateway (OpenRouter, Vercel AI Gateway, LiteLLM, Bedrock Mantle) | The Anthropic format on another URL | [`ANTHROPIC_BASE_URL`](#2-claude-through-a-gateway) |
| OpenAI, Mistral, DeepSeek, Gemini or any model on OpenRouter | `openai-compatible` | [A registry entry with a key](#4-hosted-openai-compatible-providers) |
| No diff leaving your network, no per-token bill | `openai-compatible` on a local server (Ollama, vLLM, LM Studio, llama.cpp) | [A registry entry, no key](#5-local-models) |
| Cheaper cards, keeping Claude for the harder ones | A mix: a cheap or local `fast` model, Claude for `strong` | [Mixing providers](#6-mixing-providers-to-cut-cost) |
| Use a Claude, ChatGPT or opencode subscription on a server you run for yourself | `cli:claude`, `cli:codex`, `cli:opencode` | [CLI providers](#7-cli-providers-self-hosted-only) (self-hosted only) |
| Bill each organization's own GitHub Copilot plan | `copilot` | [Copilot](#8-github-copilot) (dormant until set up) |

Things to weigh:

- **Quality.** The prompts, the evaluation baseline and the refusal fallback were built on Claude models. Any other model must pass [`pnpm eval --live`](#check-a-model-before-you-use-it) before it goes into a role.
- **Where diffs go.** Every provider receives the PR's title, description, file list and diff. Check its data retention. On OpenRouter, `zeroRetention: true` routes only to endpoints that keep no data.
- **Who pays.** API providers bill your account per token. CLI providers bill the logged-in subscription. Copilot bills the organization that installed Graft.
- **Hosted or self-hosted.** If other people install your GitHub App, set `GRAFT_DEPLOYMENT=hosted`. Graft then refuses every `cli:*` provider, because a personal login may not serve other people's code.

## How Graft uses models

Graft has three **roles**:

| Role | Used for | Default without a registry |
| --- | --- | --- |
| `fast` | First-pass writer when the rule-based risk floor is `trivial` | `claude-haiku-5-5` (`GRAFT_LLM_MODEL_FAST`) |
| `strong` | Writer for every other PR, and always the verifier | `claude-sonnet-5-5` (`GRAFT_LLM_MODEL_STRONG`) |
| `refusalFallback` | Optional. Retried once when a call is refused | unset (`GRAFT_LLM_REFUSAL_FALLBACK_MODEL`) |

You can configure them in one of two ways:

- **Only the `ANTHROPIC_*` variables** (sections [1](#1-the-claude-api-default) and [2](#2-claude-through-a-gateway)): one endpoint that speaks the Anthropic Messages API, with models picked by `GRAFT_LLM_MODEL_*`. Nothing more to learn.
- **A provider registry** (sections [3](#3-the-provider-registry) to [8](#8-github-copilot)): a YAML or JSON document listing the providers, plus `roles` that point each role at `<provider id>/<model>`. You need a registry for anything that is not the Anthropic format.

Whatever the provider, the [rule-based risk floor](features/intent-cards.md) still applies. A model can raise the risk class but never lower it. If a call fails, the card shows as unavailable with the reason, and the risk is at least `logic`.

## 1. The Claude API (default)

1. Create a key in the [Claude Console](https://platform.claude.com/).
2. Set it for the server and the worker:

   ```sh
   ANTHROPIC_API_KEY=sk-ant-...
   ```

3. Restart the worker. It logs `llm client: anthropic` with `host: "default"`.

To change models, set `GRAFT_LLM_MODEL_FAST` and `GRAFT_LLM_MODEL_STRONG` to other Claude model IDs. To avoid a long-lived key on Kubernetes, Cloud Run, Azure or Fly.io, use [Workload Identity Federation](configuration.md#deploying-with-federation) instead.

## 2. Claude through a gateway

Any service that speaks the Anthropic Messages API works without a registry. Point Graft at it and use the gateway's model IDs:

```sh
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=sk-or-...               # sent as a bearer token; set at most one of this and ANTHROPIC_API_KEY
GRAFT_LLM_MODEL_FAST=anthropic/claude-haiku-5.5
GRAFT_LLM_MODEL_STRONG=anthropic/claude-sonnet-5.5
```

- `GRAFT_LLM_REFUSAL_FALLBACK` only works on the Claude API itself. On a gateway, set `GRAFT_LLM_REFUSAL_FALLBACK_MODEL` if you want a retry after a refusal.
- `pnpm eval --live` needs a price for each model. A gateway model ID such as `anthropic/claude-sonnet-5.5` is not in the built-in table, so move to a [registry](#3-the-provider-registry) and give the entry `prices`.

## 3. The provider registry

A registry is needed for every provider below. Set it up once.

**1. Write the file.** For example, `/etc/graft/providers.yaml`:

```yaml
providers:
  - id: claude          # your name for it: 1-30 characters of a-z, 0-9 and '-'
    kind: anthropic     # no key named: uses ANTHROPIC_API_KEY / _AUTH_TOKEN / federation
roles:
  fast: claude/claude-haiku-5-5
  strong: claude/claude-sonnet-5-5
```

This registry does exactly what the default does. Start from it and add providers one at a time.

**2. Point Graft at it.** Set exactly one of:

```sh
GRAFT_LLM_PROVIDERS_FILE=/etc/graft/providers.yaml     # a file, read at startup
GRAFT_LLM_PROVIDERS='{"providers":[...],"roles":{...}}' # or the same document inline (YAML or JSON)
```

Use the inline form on platforms that cannot mount files, such as Fly.io secrets or Coolify variables. JSON on one line is the easiest to paste.

**3. Unset the model variables.** With a registry, `GRAFT_LLM_MODEL_FAST`, `GRAFT_LLM_MODEL_STRONG` and `GRAFT_LLM_REFUSAL_FALLBACK_MODEL` must be unset or empty. The `roles` replace them, and Graft refuses to start if they are set. **`.env.example` sets the first two**, so comment them out in your `.env`.

**4. Put keys in variables, never in the file.** An entry names the variable that holds its key (`apiKeyEnv`, or `authTokenEnv` for a bearer token on an `anthropic` entry). The registry only ever holds the variable's name. Startup fails if a named variable is unset.

**5. Restart the server and the worker,** then [check that it worked](#check-that-it-works).

How role values are read: everything before the first `/` is the provider `id`, and everything after it is that provider's own model ID, slashes included. In `openrouter/qwen/qwen3-coder`, the provider is `openrouter` and the model is `qwen/qwen3-coder`.

## 4. Hosted OpenAI-compatible providers

`kind: openai-compatible` covers every service with a Chat Completions endpoint. `baseUrl` is the URL up to `/chat/completions`, without that part.

| Provider | `baseUrl` | Key variable (your choice of name) |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| DeepSeek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| Gemini (OpenAI-compatible endpoint) | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` |

Take model IDs from the provider's own model list. Example with OpenRouter and OpenAI:

```yaml
providers:
  - id: openrouter
    kind: openai-compatible
    baseUrl: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
    zeroRetention: true                 # OpenRouter only: no data retention, no data collection
    prices:                             # USD per million tokens, from the provider's price page
      qwen/qwen3-coder: { input: 0.3, output: 1.2 }
  - id: openai
    kind: openai-compatible
    baseUrl: https://api.openai.com/v1
    apiKeyEnv: OPENAI_API_KEY
    prices:
      gpt-5.5: { input: 1.25, output: 10 }
roles:
  fast: openrouter/qwen/qwen3-coder
  strong: openai/gpt-5.5
```

The prices above only illustrate the format. Copy current prices from each provider's price page.

```sh
OPENROUTER_API_KEY=sk-or-...
OPENAI_API_KEY=sk-...
```

What to know:

- **Prices.** An `openai-compatible` provider has no built-in prices. Without a `prices` entry the card's cost is unknown (the daily token budget still counts tokens) and `pnpm eval --live` refuses the model. A key also prices longer IDs that start with it followed by `-`, `:` or `@`.
- **Structured output.** Graft asks for `response_format: json_schema`. If an endpoint rejects it (`llm_bad_request` on every card), set `capabilities: { nativeSchema: false }`. Graft then puts the schema in the prompt and validates the answer itself.
- **Reasoning effort** is not sent by default, because many models reject it. Set `capabilities: { effort: true }` to send it as `reasoning_effort`.
- **Token limit parameter.** Graft sends `max_completion_tokens` to `api.openai.com` and `max_tokens` everywhere else. If a server wants the other one, set `maxTokensParam`.
- **`OPENAI_*` variables are ignored** by Graft's client, except `OPENAI_CUSTOM_HEADERS`, which the OpenAI SDK always applies. Naming your key variable `OPENAI_API_KEY` is fine: it is only read because `apiKeyEnv` names it.

## 5. Local models

A local server keeps diffs on your network and costs nothing per token. It uses the same `openai-compatible` kind with no key.

### Ollama

1. Install Ollama (<https://ollama.com/download>) and pull a model:

   ```sh
   ollama pull qwen3-coder:30b
   ```

2. **Raise the context window.** Graft's prompt carries the whole diff, and Ollama's default context window is small enough to cut it off silently. Start the server with a larger one, for example `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`, or set it in the model's `Modelfile`.
3. Add the entry:

   ```yaml
   providers:
     - id: ollama
       kind: openai-compatible
       baseUrl: http://localhost:11434/v1
       prices:
         qwen3-coder: { input: 0, output: 0 }    # free, and priced so pnpm eval --live accepts it
   roles:
     fast: ollama/qwen3-coder:30b
     strong: ollama/qwen3-coder:30b
   ```

**Which `baseUrl`?** It depends on where the worker runs:

| Worker runs | Ollama runs | `baseUrl` |
| --- | --- | --- |
| On the host (`pnpm dev:worker`) | On the host | `http://localhost:11434/v1` |
| In Docker (Docker Desktop, OrbStack) | On the host | `http://host.docker.internal:11434/v1` |
| In Docker on Linux | On the host | `http://host.docker.internal:11434/v1`, with `extra_hosts: ["host.docker.internal:host-gateway"]` on the worker, and Ollama listening beyond loopback (`OLLAMA_HOST=0.0.0.0`) |
| In Docker Compose | Its own service named `ollama` | `http://ollama:11434/v1` |

### vLLM, LM Studio, llama.cpp, LiteLLM

These are the same entry with a different URL. Use the model name the server reports at `GET <baseUrl>/models`.

| Server | Typical `baseUrl` | Notes |
| --- | --- | --- |
| vLLM (`vllm serve <model>`) | `http://localhost:8000/v1` | Set `--max-model-len` high enough for large diffs. |
| LM Studio (Developer tab, Start server) | `http://localhost:1234/v1` | Load the model with a large context length. |
| llama.cpp (`llama-server -m model.gguf -c 32768`) | `http://localhost:8080/v1` | `-c` sets the context window. |
| LiteLLM proxy | `http://localhost:4000/v1` | Add `apiKeyEnv` if the proxy has a master key. |

A server that rejects `json_schema` needs `capabilities: { nativeSchema: false }`.

**Model size matters.** The verifier checks each claim against the diff, and small models often return invalid cards (`invalid_output`) or miss changes. Run [`pnpm eval --live`](#check-a-model-before-you-use-it) before trusting a local model with `strong`. A local model is often good enough for `fast`.

## 6. Mixing providers to cut cost

`fast` only writes the first pass for PRs the floor already calls `trivial`, so it is the cheapest place to save. This registry keeps Claude for everything that needs judgment:

```yaml
providers:
  - id: claude
    kind: anthropic
  - id: ollama
    kind: openai-compatible
    baseUrl: http://host.docker.internal:11434/v1
    prices:
      qwen3-coder: { input: 0, output: 0 }
roles:
  fast: ollama/qwen3-coder:30b
  strong: claude/claude-sonnet-5-5
  refusalFallback: claude/claude-opus-5-5      # optional
```

`GRAFT_LLM_REFUSAL_FALLBACK=true` (the default) still lets the Claude API retry a refused Sonnet or Opus call on its own. `refusalFallback` is Graft's own retry, for providers that have no such feature.

## 7. CLI providers (self-hosted only)

A `cli:*` provider runs a coding agent's command-line tool once per model call, logged in with your own subscription or key. Graft turns off every tool, MCP server and settings file, runs the CLI in an empty directory with a clean environment, and kills it at the deadline. See [CLI providers](configuration.md#cli-providers) for the full list of isolation steps.

> **Only for a Graft you run for yourself or your own team.** A personal subscription may not serve other people's pull requests. `GRAFT_DEPLOYMENT=hosted` refuses these kinds, and the worker logs a warning for each one at startup.

| Kind | CLI | Checked against | Install | Login for a server |
| --- | --- | --- | --- | --- |
| `cli:claude` | Claude Code | 2.1.284 (one live call) | `npm install -g @anthropic-ai/claude-code@2.1.284` | `claude setup-token` on your machine, then pass `CLAUDE_CODE_OAUTH_TOKEN` |
| `cli:codex` | OpenAI Codex | 0.162.1 (offline check only, **no live run yet**) | `npm install -g @openai/codex@0.162.1` | `CODEX_API_KEY` in `passEnv`, or a `~/.codex` login in the worker's `HOME` |
| `cli:opencode` | opencode | 1.19.3 (one live call) | `npm install -g opencode-ai@1.19.3` | `OPENCODE_AUTH_CONTENT` (the contents of `auth.json`) or a provider key such as `OPENROUTER_API_KEY` in `passEnv` |

Pin the version that was checked. A newer CLI may add a tool Graft does not know how to turn off. For `cli:codex` and `cli:opencode`, a call fails (`bad_request`) if a tool actually ran, so a new tool shows up as failed cards and never as a card fed by tool output.

### Install the CLI in the image

The Graft image ships no CLI. Build a derived image for the **worker** (the server makes no model calls):

```dockerfile
# Dockerfile.worker
FROM graft:local                  # the image built from this repository's Dockerfile
USER root
RUN npm install -g @anthropic-ai/claude-code@2.1.284
USER node
CMD ["node", "dist/bin/worker.js"]
```

```sh
docker build -t graft:local .
docker build -f Dockerfile.worker -t graft-worker:local .
```

Running Graft directly on a machine (no Docker)? Install the CLI for the user that runs the worker, and make sure it is on that user's `PATH`, or set `command` to its absolute path.

### Register it

```yaml
providers:
  - id: local
    kind: cli:claude
    passEnv: [CLAUDE_CODE_OAUTH_TOKEN]    # the only variables beyond PATH, HOME, USER, LOGNAME, LANG, LC_ALL, TMPDIR
    # command: /usr/local/bin/claude      # default: the kind's binary on PATH
roles:
  fast: local/claude-haiku-5-5
  strong: local/claude-sonnet-5-5
```

```yaml
  - id: codex
    kind: cli:codex
    passEnv: [CODEX_API_KEY]
    # roles: codex/gpt-5.5
  - id: oc
    kind: cli:opencode
    passEnv: [OPENROUTER_API_KEY]
    # roles: oc/openrouter/qwen/qwen3-coder  (opencode's own <provider>/<model>)
```

Rules for these entries:

- **Use explicit model IDs.** Aliases such as `sonnet` can resolve to an older model.
- **`passEnv` cannot carry Graft's secrets.** `GITHUB_*`, `GRAFT_*`, `PG*`, `SMEE_*`, anything ending in `DATABASE_URL` or `_PRIVATE_KEY`, and any variable another entry names as its `apiKeyEnv` or `authTokenEnv` are refused.
- **Run the worker as a dedicated user** whose `HOME` holds only the CLI's login. If you mount a login directory, mount it read-only.
- **Prices.** The subscription decides the cost, so calls are unpriced unless you add `prices`. `pnpm eval --live` needs them: use `{ input: 0, output: 0 }` if you only want the quality check.
- **The CLI's own caching** is used. Graft cannot place cache markers, so the cost savings from [`intent-v4`](features/intent-cards.md) do not apply.

## 8. GitHub Copilot

`kind: copilot` bills each call to the Copilot plan of the organization that installed Graft. It is allowed on a hosted deployment, but only for installations that opted in. Every other installation, and `pnpm eval`, uses the fallback model you name. **It has not yet been run against a live installation.** Test it on one opted-in installation first.

It is dormant until you complete all four steps in [Copilot provider](configuration.md#copilot-provider):

1. Add `@github/copilot-sdk@1.0.19` to a derived image. It is not a Graft dependency.
2. Add the **Copilot requests** permission (read and write) to the GitHub App. Each organization must accept it.
3. The organization's Copilot policy must allow requests from GitHub Apps, and the App must be installed on all repositories.
4. List the installation ID under `installations`.

```yaml
providers:
  - id: claude
    kind: anthropic
  - id: copilot
    kind: copilot
    installations: [12345678]
    fallbackModels:                      # required for every copilot model a role uses
      gpt-5-mini: claude/claude-haiku-5-5
      claude-sonnet-4.5: claude/claude-sonnet-5-5
roles:
  fast: copilot/gpt-5-mini
  strong: copilot/claude-sonnet-4.5
```

## Check a model before you use it

`pnpm eval` reads the same registry, with the same rules, as the server. Run the candidate against the saved baseline before you put it into a role on the server:

```sh
export GRAFT_LLM_PROVIDERS_FILE=./providers.candidate.yaml   # or set it in .env
pnpm eval run --set eval/synthetic --live                    # shows an estimate and asks before spending
pnpm eval run --set ~/.graft-eval/pilot-acme --live          # your labeled pilot set, if you have one
```

- Every role's model needs a price: the built-in table for `anthropic` providers, otherwise the entry's `prices`. Use `{ input: 0, output: 0 }` for a local model.
- The tool prints an upper-bound cost and asks `Continue? [y/N]`. `--max-cost-usd` (default 10) caps the spend.
- Compare the report with the Claude baseline: missed risk classes, invalid cards and verifier disagreements matter most. See [Evaluation](features/evaluation.md).
- `copilot` roles fall back to their `fallbackModels` here, because the eval tool has no installation.

## Check that it works

After a restart:

1. **Startup log.** The worker logs `llm client: registry` with each provider's id, kind and host, and the roles. It never logs keys or full URLs. Without a registry it logs `llm client: anthropic`, or `llm client: unconfigured` if no credential is set. A CLI provider adds the warning `llm provider runs a CLI on a personal login`.
2. **The card.** The next card's footer names the model that answered as `<provider id>/<model>`, for example `ollama/qwen3-coder:30b`. A model change also changes the card's input hash, so open PRs get a new card on their next push.
3. **Logs per call.** Each `llm call` log line has a `provider` field, with tokens and duration.
4. **The console.** If you run the [operator console](console.md), the System page lists the models that wrote, first-passed and verified cards, and the failure classes of unavailable ones.

## Deploying with a registry

**Docker Compose or Docker.** The server and the worker both validate the registry at startup, so give both of them the file (mounted read-only) and the key variables:

```yaml
  server:
    environment:
      GRAFT_LLM_PROVIDERS_FILE: /etc/graft/providers.yaml
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
    volumes:
      - ./providers.yaml:/etc/graft/providers.yaml:ro
  worker:
    environment:
      GRAFT_LLM_PROVIDERS_FILE: /etc/graft/providers.yaml
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
    volumes:
      - ./providers.yaml:/etc/graft/providers.yaml:ro
```

**Fly.io.** Store the registry inline as a secret, along with each key variable it names:

```sh
fly secrets set --app <app-name> \
  GRAFT_LLM_PROVIDERS="$(cat providers.yaml)" \
  OPENROUTER_API_KEY=sk-or-...
```

**Coolify.** `compose.coolify.yaml` passes only the variables it lists to the containers. It already lists `GRAFT_LLM_PROVIDERS`, `GRAFT_DEPLOYMENT` and the `ANTHROPIC_*` gateway variables. **Add a line for each key variable your registry names** to the `x-graft-env` block (for example `OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}`), then set the values in the resource's Environment Variables page. See [Coolify](deploy/coolify.md#4-environment-variables).

**Local network models from a hosted platform.** A worker on Fly.io or another cloud cannot reach `localhost` on your machine. Run the model server where the worker can reach it, and never expose an unauthenticated model server to the internet.

## When something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| `GRAFT_LLM_MODEL_FAST / GRAFT_LLM_MODEL_STRONG: unset with a provider registry` | Comment out the model variables in `.env` (`.env.example` sets them) or on the platform. |
| `GRAFT_LLM_PROVIDERS / GRAFT_LLM_PROVIDERS_FILE: set at most one` | Keep only one of the two. |
| `GRAFT_LLM_PROVIDERS_FILE: file cannot be read` | Wrong path, or the file is not mounted into this container (server and worker both read it). |
| `providers[i].apiKeyEnv: names a variable that is not set` | Set that variable for the process, or add it to the platform's environment (Coolify: the compose file too). |
| `roles.strong: ... for a anthropic provider` (or another kind) | The model ID does not fit the kind. `anthropic` and `cli:claude` take Claude model IDs only. Check which provider the prefix points at. |
| `providers[i].kind: cli:... is refused when GRAFT_DEPLOYMENT=hosted` | CLI providers are for self-hosted, single-tenant use only. Use an API provider. |
| `providers[i].baseUrl: an entry using the ANTHROPIC_* credential uses ANTHROPIC_BASE_URL` | An `anthropic` entry with its own URL needs its own `apiKeyEnv` or `authTokenEnv`. |
| `zeroRetention: is only understood by OpenRouter` | Remove `zeroRetention` from entries that do not point at `openrouter.ai`. |
| `passEnv[j]: is another provider's key` / `names a variable Graft never passes to a CLI` | A CLI cannot receive another entry's key or Graft's own secrets. Use a separate variable for the CLI's login. |
| `roles.fast: has no fallbackModels entry on provider copilot` | Every copilot model used by a role needs a fallback on a non-copilot provider. |
| Cards say "the model service rejected the request" (`llm_bad_request`) | Usually a wrong model ID, or an endpoint that rejects `json_schema` (`capabilities: { nativeSchema: false }`) or the token parameter (`maxTokensParam`). |
| Cards say "the model returned an invalid card twice" (`invalid_output`) | The model cannot follow the schema reliably. Try `nativeSchema: false`, a larger model, or a larger context window on a local server. |
| Cards say "the model service rejected Graft's credentials" (`llm_auth`) | A wrong or expired key, or, for a CLI, a login that is missing in the worker's environment (check `passEnv`). |
| Cards say "no model API key is configured" with a `copilot` role | `@github/copilot-sdk` is not installed in the worker image. The worker logs `copilot provider: the SDK is not installed`. |
| The card's cost is missing | The model has no price. Add it to the entry's `prices`. |

More general card problems are covered in [Troubleshooting](troubleshooting.md#cards-policy-and-crons).
