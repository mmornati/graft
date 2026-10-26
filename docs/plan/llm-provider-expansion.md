# LLM provider expansion: research and improvement plan

Research date: 2026-10-16. Prices, policies and package versions change quickly; re-check the linked sources before acting on any of them.

Graft makes at most three model calls per pull request: a writer, an escalated writer and a verifier (`src/modules/intent/generate.ts`). All of them go through one Anthropic Messages API client, authenticated with `ANTHROPIC_API_KEY` (`src/llm/anthropic.ts`). That client relies on six Anthropic API features:

- **JSON-schema output:** `output_config.format` with constrained decoding.
- **Effort:** `output_config.effort`.
- **Prompt caching:** `cache_control` on the system prompt.
- **Server-side refusal fallback:** the `server-side-fallback-2026-07-01` beta.
- **Usage counters:** token counts per call, priced by `src/llm/pricing.ts`.
- **Failure taxonomy:** `timeout`, `rate_limited`, `unavailable`, `auth`, `bad_request`, `refusal`, `max_tokens`, `invalid_json`.

The `LlmClient` interface in `src/llm/types.ts` is already provider-neutral. That makes the job "add implementations and capability flags", not "redesign". Section 4 adds them behind a provider registry that the operator configures on the server, with roles that point the writer and verifier at any registered provider.

## TL;DR

| Idea | Verdict | Why |
| --- | --- | --- |
| Claude Code / Agent SDK on a Max licence | **No for the hosted App.** Fine for a local dev provider. | Works technically (tested below). Anthropic's terms forbid routing other users' requests through Pro/Max credentials and forbid automated commercial use. |
| Max/Team **API credits** | **Yes, do this first.** | Max and Team plans now include $100–$500 a month of API credits, usable with an API key. Zero code change. |
| Copilot SDK with GitHub App installation tokens | **Yes, as a provider.** It is the only multi-tenant, licence-backed path. | Billed to each installing org's Copilot AI-credit pool. GA since June 2026. Supports `responseSchema`. |
| GitHub Models API | **No.** | Retired on 2026-07-30. |
| OpenAI-compatible gateways (OpenRouter, Vercel, Requesty, LiteLLM) | **Yes.** Most need only a `baseURL` change. | Most of them also expose the Anthropic `/v1/messages` format. |
| Bedrock / Vertex / Foundry | **Yes**, for enterprise self-hosters. | Uses Anthropic SDK variants. Bedrock Mantle has **no structured outputs**. |
| Local models (Ollama, vLLM, LM Studio) | **Yes**, through a second, OpenAI-format transport. | Constrained JSON through grammars. Fully private. |
| Codex SDK on a ChatGPT login | **Only self-hosted, with the customer's own key or Business token.** | OpenAI recommends API keys for automation. Same consumer-plan problem as Claude. |
| opencode CLI | **Only self-hosted**, like the Claude and Codex CLIs. | It inherits the terms of whatever login it uses. |
| Gemini CLI on a Google account | **No.** | Tested here: personal Code Assist access is gone, and the CLI now refers users to Antigravity. |
| Jev (TypeSafe, "System One") | **Pilot offline only**, as a classifier or claim checker. | Outputs typed answers with probabilities, not text. Cannot write a card. Costs $0.042/M input. Early access, vendor-run benchmarks. |
| Cheaper "fast" model than Haiku 5.5 | **Not worth it.** | Haiku costs about $0.002 per call. Sonnet costs about $0.045 and is about 90% of the bill. |

The biggest cost win is not a new provider. It is **spending less on the Sonnet verifier**: shared-prefix caching and a cheap-first verifier with confidence-gated escalation. (Diff filtering already exists; see 3.3 B.)

---

## 1. Subscription licences instead of pay-per-token

### 1.1 Claude Code / Claude Agent SDK on Pro/Max

**Spike run for this plan.** Claude Code 2.1.284, logged in with a subscription, `ANTHROPIC_API_KEY` unset, one call per configuration:

```
claude -p --tools "" --strict-mcp-config --setting-sources "" \
  --model <m> [--system-prompt "..."] --output-format json --json-schema '<schema>'
```

| Configuration | Wall time | Extra input tokens (cache write) | Result |
| --- | --- | --- | --- |
| `--model haiku`, default system prompt | 4.9 s | 7,616 | Valid `structured_output`. The **alias resolved to `claude-haiku-4-5`**, not 5.5. |
| `--model sonnet`, default system prompt | 3.9 s | 3,389 | Valid. Resolved to `claude-sonnet-5-5`. |
| `--model claude-haiku-5-5 --effort low --system-prompt ...` | 1.1 s API | 1,237 | Valid. The CLI warned `unrecognized_model` but served it. |
| `--bare` | – | – | **Fails.** "Not logged in": `--bare` skips the OAuth keychain. |

What the spike shows:

- **Structured output works.** It is validated and re-prompted, not constrained decoding: `num_turns` was 2, and the SDK fails with `error_max_structured_output_retries` when the output never validates.
- **Pass explicit model IDs and a custom system prompt.** Without them you get the wrong model and up to about 7K tokens of Claude Code's own prompt on every call.
- **The CLI adds about 1 s of process overhead**, and it brings its own caching. Graft's `cache_control` cannot be set explicitly.
- **`total_cost_usd` is a local estimate**, not what the plan bills.

**Policy (the blocker).** Anthropic's Agent SDK and legal pages say third-party developers may not "route requests through Free, Pro, or Max plan credentials on behalf of their users". They also say developers using the Agent SDK "should use API key authentication". The Consumer Terms forbid automated access except through an API key, and forbid commercial use. Graft is a GitHub App that reviews other people's PRs on a webhook, which is exactly the forbidden case. Enforcement "without prior notice" is possible.

Sources:
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms)

**What to do instead: subscriber API credits.** Max 5x includes $100 a month, Max 20x $200, and Team up to $500 pooled. They are claimed by linking a Console org and used with an **API key** on the Claude API ([API credits for subscribers](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)). Graft's existing client keeps working unchanged, and it keeps constrained decoding, caching, effort and exact usage.

Credits expire monthly. Before relying on them, read the [credit terms](https://www.anthropic.com/legal/credit-terms) for any restriction on serving third parties.

**Where an Agent SDK provider still makes sense:** a `claude-code` provider for **local development and eval runs on your own machine**. That is ordinary individual use. It must never be enabled in production; refuse it when `NODE_ENV=production`.

### 1.2 GitHub Copilot SDK

`@github/copilot-sdk` has been GA since 2026-06-02. It drives the Copilot CLI and has a headless server mode.

**The multi-tenant fit is documented.** Give the GitHub App the **"Copilot Requests"** permission and mint installation tokens with `copilot_requests: write`. Usage "is attributed and billed to the account that owns the GitHub App installation". Each customer pays from their own Copilot seat pool, not from yours ([server-to-server tokens](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens)).

Caveats:
- **Billing changed on 2026-06-01** to GitHub AI Credits ($0.01 each) at per-token rates, for example Sonnet 5.5 at $2/$10 per M tokens. Business plans include 1,900 credits per user per month and Enterprise 3,900, pooled. It is a seat-funded token pool, not unlimited flat-rate use ([billing changelog](https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/), [model pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)).
- **Installation requirements:** the App must be installed on "All repositories". The org must allow Copilot requests from GitHub Apps. Tokens last one hour.
- **Structured output:** `responseSchema` throws on mismatch. Whether it is constrained decoding is unverified, so keep Graft's own validation.
- **Usage:** the `assistant.usage` event reports tokens and credit status.
- **Graft-specific risk:** the CLI is an *agent* with tools, and Graft feeds it untrusted PR text. The provider must start sessions with **no tools**, the system message in **replace** mode, and no MCP servers. Add a test that asserts this, the way U-LOG-2 guards logging.
- **Not an option:** GitHub Models was retired on 2026-07-30. Unofficial Copilot API proxies risk account suspension.

### 1.3 OpenAI Codex

`@openai/codex-sdk` (0.163) wraps the Codex CLI the same way the Agent SDK wraps Claude Code. `thread.run(prompt, { outputSchema })` returns typed output, and `turn.completed` carries usage. "Sign in with ChatGPT" works, but OpenAI says API keys are "the recommended default for automation". Codex access tokens (Business and Enterprise) are meant for "trusted scripts, schedulers and private CI runners" ([auth](https://learn.chatgpt.com/docs/auth), [access tokens](https://developers.openai.com/codex/enterprise/access-tokens)).

Verdict: the same pattern and the same limits as Claude. Offer Codex only as a **self-hosted, bring-your-own-key** option. For a plain API key, the OpenAI-compatible transport in section 2 is simpler than spawning a CLI.

### 1.4 Others

- **Gemini CLI:** tested here. It refuses with `IneligibleTierError` ("no longer supported for Gemini Code Assist for individuals… migrate to Antigravity"). Gemini models stay reachable through an API key, Vertex or a gateway.
- **opencode:** its Copilot provider is a personal login, so it has the same single-user limits.

---

## 2. Pay-per-token providers through two transports

The research found one shortcut. **Most gateways accept the Anthropic Messages wire format**, so the existing client plus a configurable `baseURL` covers them:

| Target | Transport | JSON schema | Cache | Effort | Refusal fallback | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude API (today) | Anthropic | native | yes | yes | server-side beta | – |
| Vertex / Foundry | Anthropic SDK variant | native | yes | yes | client-side only | +1 package. Data stays in the cloud tenant. |
| Bedrock (Mantle) | Anthropic (bearer `baseURL`) | **no** | yes | yes | client-side only | Prompt for the schema, then validate |
| OpenRouter `/api/v1/messages` | Anthropic | yes | passthrough | yes | `fallbacks` (≤3) | `provider.zdr: true`. 5.5% fee on credits. |
| Vercel AI Gateway, Requesty, Portkey | Anthropic or OpenAI | likely (unverified) | unverified | unverified | gateway fallbacks | Test with the eval set first |
| LiteLLM proxy (self-hosted) | Anthropic or OpenAI | translated | partial | unverified | proxy fallbacks | Pin versions: PyPI 1.82.7 and 1.82.8 were compromised in March 2026 |
| Ollama, vLLM, LM Studio, llama.cpp | **OpenAI** | grammar-constrained | n/a | n/a | n/a | Ollama's Anthropic endpoint has no schema or cache, so use OpenAI format |
| OpenAI, Mistral, DeepSeek, Gemini (compat) | **OpenAI** | `response_format: json_schema` | provider-specific | `reasoning_effort` where supported | none | – |
| Eden AI | OpenAI | **no `response_format` documented** | – | – | – | Not recommended |

Sources:
- OpenRouter: [Anthropic Messages endpoint](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message.md), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [ZDR](https://openrouter.ai/docs/guides/features/zdr)
- [Claude in Amazon Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock)
- [Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
- [Ollama Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility)
- [vLLM structured outputs](https://docs.vllm.ai/en/latest/features/structured_outputs.html)
- [Eden AI chat completions](https://www.edenai.co/docs/v3/llms/chat-completions.md)

**Library choice.** Use a thin in-house adapter on the `openai` npm package (one dependency) next to the existing `@anthropic-ai/sdk`. Skip the Vercel AI SDK for now, for three reasons:

- It went through v5, v6 and v7 in about a year.
- It pulls in several packages per provider.
- Its errors have no timeout class, so mapping them onto Graft's failure taxonomy would mean digging through `cause` objects and status codes.

**Privacy (Graft's contract).** Diffs leave the process for every provider. The README promises nothing is stored or logged, which is true of Graft itself, not of a third party. For each provider:

- Document where diffs go.
- Default gateway calls to zero-retention options: OpenRouter `provider.zdr`, `data_collection: deny`.
- Show the provider and model on the card. The writer and verifier models are already shown there (`src/modules/intent/render.ts`).

---

## 3. Cutting cost: Jev and "System 1" models

### 3.1 Where the money goes

Typical PR: 15K input and 1.5K output tokens per call.

| Setup | Cost per PR |
| --- | --- |
| Trivial path today (Haiku writer + Sonnet verifier) | $0.047 |
| Non-trivial path today (Sonnet + Sonnet) | $0.090 |
| Blend, assuming 30% trivial | ~$0.077 |

A Haiku 5.5 call costs about $0.0023 and a Sonnet 5.5 call about $0.045. **The verifier is always Sonnet, so it costs 0.045 of every PR.** No fast-model swap moves that number much. Candidates that beat Haiku:

| Model | Price per M tokens (input / output) | Status |
| --- | --- | --- |
| DeepSeek V4-Flash | $0.14 / $0.28 | aggregator price, unverified |
| Inception Mercury 2.5 | $0.04 / $0.15 | launch discount |
| Jev | $0.042 / free | early access |

Each saves under $0.002 per call. That is not worth the integration and quality risk on its own.

### 3.2 Jev

[TypeSafe AI](https://typesafe.ai) announced Jev on 2026-09-15 as a "System One" model ([DataCamp overview](https://www.datacamp.com/blog/system-one-models-jev), [llms.txt](https://www.everydev.ai/tools/jev/llms.txt)).

**What it does:**
- **Input and output:** takes text plus typed questions and returns calibrated answers with confidences in one parallel pass, with **no generated text**. Question types: Choice (up to 255 labels), Score, and yes/no probability.
- **Price:** $0.042/M input; output is free. TypeSafe admits the price may be subsidised.
- **Speed:** 70–500 ms per call.
- **Context:** 64K tokens. Graft's largest prompts are about 60K, so the biggest diffs may not fit.

**Weaknesses:**
- Accuracy drops on noisy input (raw diffs), and it is weak at counting.
- Its benchmarks are vendor-run.
- It is a new vendor that would receive customer code.

**Where it fits Graft:**
1. **Risk-class pre-classifier:** a Choice over trivial / logic / sensitive, alongside the rule-based floor. The floor stays a hard minimum, so Jev can only raise the class. About $0.0006 per PR.
2. **First-pass verifier:** one yes/no question per card claim ("is this supported by the diff?"). Only claims where Jev is unsure go to Sonnet.

It **cannot** write the goal, the behaviour changes or the unexplained edits. Haiku stays the writer.

### 3.3 Architectural savings, best first

| # | Change | Estimated saving | Risk |
| --- | --- | --- | --- |
| A | **Put the diff in a shared, cached prefix.** Writer and verifier both read it; the verifier reads it from cache at 0.05× the input price. | ~20% on non-trivial PRs | Changing `output_config.format` invalidates the cache ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)). The two calls use different schemas, so measure it. A tool-based schema may be needed. |
| B | ~~Diff filtering~~ **already done.** `classifyFile` leaves lockfiles, binaries and generated or vendored paths out of the model input. Filtering more would raise the floor to `logic` (R13 `partial_view`) and move PRs off the cheap Haiku pass, so it would cost more, not less. | – | – |
| C | **Cheap-first verifier:** a Haiku verifier with a per-claim confidence field. Escalate to Sonnet when the risk is `sensitive`, a claim is low-confidence or contested, or the writer was escalated. | ~60–80% overall if about 30% escalate | Correlated errors between Haiku writer and Haiku verifier. Calibrate on labelled PRs. |
| D | **Jev as the gate for C**, instead of a Haiku confidence field | A few tenths of a cent more | New vendor. 64K limit. Unvalidated. |
| E | **Batch API** (50% off) for eval runs and backfills only | 50% on those runs | Hours of latency, so never for live PRs |

Cascade research supports C and D: FrugalGPT reports [up to 98% cost reduction](https://arxiv.org/abs/2305.05176) and RouteLLM [35–85%](https://lmsys.org/blog/2024-07-01-routellm/) at about 95% of the quality. Graft has its own gate: the Phase 0 accuracy target of 90% or more in `pnpm eval`. **Every change in this section must pass that eval against the saved baseline before it ships.**

---

## 4. Implementation plan

Each step is shippable on its own and gated by `pnpm eval:ci` plus a live `pnpm eval` run on a pilot set.

### Step 1: Quick wins (no new provider), implemented

1. Claim the Max or Team API credits for the Console org that owns `ANTHROPIC_API_KEY`. This is a human task.
2. **Done.** `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (bearer, for gateways), and model IDs with a gateway prefix. This enables OpenRouter, Vercel, Requesty, LiteLLM and Bedrock Mantle in Anthropic format.
3. **Done.** The server-side fallback beta is sent only to the Claude API. `GRAFT_LLM_REFUSAL_FALLBACK_MODEL` adds a client-side retry on refusal.
4. **Dropped.** Diff filtering already exists (3.3 B).
5. **Done.** Workload Identity Federation as a third way to authenticate to the Claude API (`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, optional `ANTHROPIC_WORKSPACE_ID`): no long-lived key on hosts that issue OIDC tokens. See [decisions](../decisions.md#workload-identity-federation) and [Deploying with federation](../configuration.md#deploying-with-federation).

Details are in [decisions.md](../decisions.md#llm-gateways-and-client-side-refusal-fallback).

### Design: a server-side provider registry

Steps 2–7 replace the single "key present" switch with a list of providers that the operator configures on the server, and with roles that point at them. Repository owners do not choose providers in `graft.yaml`: a provider decides where diffs go and who pays, so it stays operator configuration. The one per-installation choice is Copilot billing (Step 6).

```yaml
# GRAFT_LLM_PROVIDERS_FILE, or the same document as JSON in GRAFT_LLM_PROVIDERS
providers:
  - id: claude
    kind: anthropic            # variant: api | vertex | foundry | bedrock
  - id: openrouter
    kind: openai-compatible
    baseUrl: https://openrouter.ai/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
    zeroRetention: true
  - id: ollama
    kind: openai-compatible
    baseUrl: http://ollama:11434/v1
    capabilities: { nativeSchema: true, promptCache: false, effort: false }
    prices: { "qwen3-coder-30b-a3b": { input: 0, output: 0 } }
  - id: local-claude
    kind: cli:claude           # self-hosted only, see "Scope of the CLI providers"
roles:
  fast: ollama/qwen3-coder-30b-a3b
  strong: claude/claude-sonnet-5-5
  refusalFallback: openrouter/anthropic/claude-opus-5.5
```

- **Roles** are the three models Graft already uses (`generate.ts`): `fast` (first writer), `strong` (escalated writer and verifier) and the optional `refusalFallback`. Each is `<provider id>/<model>`; everything after the first `/` is the provider's own model ID.
- **Secrets never sit in the registry.** An entry names the environment variable that holds its key (`apiKeyEnv`), so the file can be committed or mounted while keys stay runtime-only secrets on Coolify and Fly.
- **Backward compatible.** With no registry, Graft builds an implicit `anthropic` provider from today's `ANTHROPIC_*` settings and maps `GRAFT_LLM_MODEL_FAST`, `GRAFT_LLM_MODEL_STRONG` and `GRAFT_LLM_REFUSAL_FALLBACK_MODEL` to the three roles. An existing deployment changes nothing. Setting both the registry and the old model variables is a config error, not a silent precedence rule.
- **Validation moves to each provider kind.** The global `MODEL_ID` check in `src/config/index.ts` only accepts Claude IDs; it becomes the `anthropic` kind's check. The other kinds accept any model ID within a length and character limit.
- **Capabilities** (`nativeSchema`, `promptCache`, `effort`, `serverRefusalFallback`, `reportsUsage`) have a default per kind, and an entry may override them for an endpoint that differs (an Ollama build without grammar support, a gateway that drops `cache_control`).

### Scope of the CLI providers

The `cli:*` kinds spawn a coding agent's CLI (`claude`, `codex`, `opencode`) logged in with a personal subscription. Section 1 explains why that login may not serve other people's pull requests. The rules:

| Kind | Hosted Graft App | Self-hosted, single tenant | Why |
| --- | --- | --- | --- |
| `cli:claude` | **Refused** | Allowed, with a warning in the logs and on the card | Anthropic's terms (1.1) |
| `cli:codex` | **Refused** | Allowed with an API key or a Business access token; a ChatGPT login gets a warning | OpenAI's automation guidance (1.3) |
| `cli:opencode` | **Refused** | Allowed; the warning names the upstream provider's terms | It inherits whatever login it uses (1.4) |
| `copilot` (SDK) | **Allowed** | Allowed | Installation tokens bill the installing org (1.2) |

- **How "hosted" is detected:** a new `GRAFT_DEPLOYMENT = hosted | self-hosted` setting, defaulting to `self-hosted`. Graft's own deployment sets `hosted`, and config loading fails when a `cli:*` provider is configured there. `NODE_ENV=production` alone is not the signal: a self-hoster runs production too.
- **Every CLI is an agent with tools, and Graft feeds it untrusted PR text.** Each adapter must turn tools, MCP servers, settings files and plugins off, run in an empty temporary working directory, and start with an environment stripped to what the CLI needs (no `GITHUB_*`, no other providers' keys, no database URL). This is the main security cost of the feature, not an afterthought.
- **Packaging:** the default Docker image ships no CLI. Self-hosters who want one build `FROM` the Graft image and add it, and mount the CLI's login state read-only. Document this; do not bake subscriptions into an image.

### Step 2: Provider registry and roles (PR 1), implemented

1. **Done.** `GRAFT_LLM_PROVIDERS` / `GRAFT_LLM_PROVIDERS_FILE` are parsed in `src/llm/registry.ts` and checked in `src/config/index.ts`. Duplicate IDs, unset key variables, roles naming no provider and model IDs a kind does not accept fail at startup, with the field named and never a value. **Changed from the plan:** there is no implicit registry for existing deployments. Without a registry `createLlmClient` builds exactly the client it built before, so model IDs stay bare and card input hashes do not change. Setting both a registry and `GRAFT_LLM_MODEL_*` is an error.
2. **Done.** `src/llm/router.ts`: one client per provider. Requests carry `<provider id>/<model>`, the provider gets the bare model, and the result's model is qualified again. That is how the card footer, the `llm call` log line (through a child logger with `provider`) and the spend ledger name the provider (item 5).
3. **Done.** `LlmClient.capabilities(model)`. `generate.ts` puts the schema in the system prompt for a provider without `nativeSchema`. The Anthropic client drops `output_config.format`, `effort` or `cache_control` when the entry's capabilities say so.
4. **Done.** `LlmClient.costOf`: the entry's `prices` first, then the built-in Claude table for `anthropic` providers, otherwise `null`.
5. **Done** (see 2).
6. **Not done.** Vertex, Foundry and Bedrock SDK variants wait for an operator who needs them. Bedrock Mantle already works as an `anthropic` entry with `capabilities: { nativeSchema: false }`.

### Step 3: OpenAI-compatible transport (PR 2)

1. `src/llm/openai-compatible.ts` on the `openai` package: `response_format: { type: "json_schema", strict: true }`, plus `provider.require_parameters` and, when `zeroRetention` is set, `provider.zdr` and `data_collection: deny` on OpenRouter.
2. Map errors to the same taxonomy. A content-filter finish reason maps to `refusal`, `length` to `max_tokens`, and a body that is not JSON to `invalid_json`.
3. Contract tests with a fake `fetch`, mirroring the U-LLM tests. Run a live eval against Ollama with Qwen3-Coder-30B-A3B and one hosted model (OpenAI or Mistral).
4. This one transport covers OpenAI, OpenRouter, Mistral, DeepSeek, Gemini (compat), Ollama, vLLM, LM Studio, llama.cpp and the LiteLLM proxy.

### Step 4: CLI transport and the `claude` adapter (PR 3)

1. `src/llm/cli.ts`: the shared base. It spawns the binary with an argument array (never a shell), writes the prompt on stdin, enforces `timeoutMs` and `deadlineMs` by killing the process group, caps stdout size, parses JSON, and maps exit codes and stderr patterns to the failure taxonomy. Usage comes from the CLI's JSON when it reports it, otherwise zero with `reportsUsage: false`.
2. The isolation rules from "Scope of the CLI providers": empty temp directory, stripped environment, tools and MCP off. Enforced in the base, not left to each adapter.
3. The `cli:claude` adapter: `claude -p --tools "" --strict-mcp-config --setting-sources "" --model <id> --system-prompt … --output-format json --json-schema …`, as in the 1.1 spike. Pass explicit model IDs; aliases resolve to old models.
4. The `GRAFT_DEPLOYMENT=hosted` guard, and the warning on the card.
5. A security test with prompt-injection cases syn-019, syn-020, syn-021 and syn-030 against a fake CLI binary that records its arguments and environment: no tool flag enabled, no secret in the environment, the working directory empty.

### Step 5: `codex` and `opencode` adapters (PR 4)

1. Spike first: confirm the current flags for non-interactive JSON output, a schema option, and turning tools and MCP off, on the installed versions. Record them in this document.
2. `cli:codex`: `codex exec` with `--output-schema` (or `@openai/codex-sdk` with `outputSchema` if the CLI flag is missing). Read-only sandbox, no approvals.
3. `cli:opencode`: `opencode run` with JSON output. Schema support is unverified, so the default is `nativeSchema: false` and Graft's own validation.
4. Extend the Step 4 security test to both adapters.

### Step 6: Copilot provider (PR 5)

1. Add the "Copilot Requests" permission to `github/app-manifest.json`. Mint installation tokens with `copilot_requests: write` per job; they last one hour, so fetch one per job.
2. Write `src/llm/copilot.ts` on `@github/copilot-sdk`:
   - one headless CLI process per worker
   - an empty session per call: **no tools**, no MCP, system message in replace mode
   - `responseSchema`, then Graft's own validation
   - usage from `assistant.usage`
3. A `copilot` provider entry is installation-aware: the router passes the job's installation so the client uses that org's token. An installation opts in through a setting (stored with the installation, not in `graft.yaml`, since it is a billing decision). Without the opt-in, or when the org does not allow Copilot requests from apps, the role falls back to the provider named in `fallback`.
4. The same no-tools security test as Step 4.

### Step 7: Providers in the console (PR 6)

1. Show the configured providers, their kind, host, capabilities and role assignments in the read-only console. Never show `apiKeyEnv` values, only whether the variable is set.
2. Per-provider call counts, failure classes and spend from the existing `llm call` data.

### Step 8: Cost cascade (Section 3)

Independent of Steps 2–7, and can run before or after them.

1. Shared cached prefix (A): measure cache hits on the eval set first.
2. Cheap-first verifier with escalation rules (C). Bump `PROMPT_VERSION` and re-baseline.
3. Optional: a Jev spike as an offline eval provider only (D). Compare it with Sonnet verdicts on a few hundred pilot cases before any live use. With the registry in place, Jev is one more `openai-compatible` entry if OpenRouter serves it.

### Effort

Estimated for AI implementation with the same review loop as phases 0 and 1 (two review rounds per step). Sizes: **S** is under one working session, **M** about one session, **L** two or more.

| Step | PR | Size | Depends on | Main risk |
| --- | --- | --- | --- | --- |
| 2 | Registry, roles, router, capabilities, pricing | M | – | Keeping existing deployments unchanged; config migration tests |
| 3 | OpenAI-compatible transport | M | 2 | Error mapping across gateways that differ in small ways |
| 4 | CLI base and `claude` adapter | M | 2 | Process isolation; it carries the security test |
| 5 | `codex` and `opencode` adapters | S each | 4 | CLI flags change between versions; spike first |
| 6 | Copilot provider | L | 2 | App permission rollout, per-installation tokens and opt-in, fallback |
| 7 | Console view | S | 2 | – |
| 8 | Cost cascade | M | – | Eval regressions; needs re-baselining |

The code is the predictable part. The open-ended part is **quality per model**: every model put in a role must pass `pnpm eval` against the saved baseline (90% or more) before it is recommended. Weaker local models may need prompt tuning, or may only be good enough for `fast` and not for `strong`. Budget one live eval run per candidate model, and treat a failing model as "documented as unsupported for that role", not as a reason to lower the gate.

Recommended order: 2 and 3 first. Together they deliver "any OpenAI-compatible provider, configured on the server" with no licensing or tool-execution risk. Then 6 for hosted customers, and 4–5 for self-hosters.

---

## Open questions and unverified items

- Do the Max and Team API credit terms allow serving third parties (a hosted Graft)?
- Is Copilot SDK `responseSchema` constrained decoding, or validate-and-retry? What latency does one headless CLI per worker add?
- Do the Vercel AI Gateway and LiteLLM `/v1/messages` endpoints honour `output_config.format`, `effort` and `cache_control`?
- Do cache hits survive the writer-to-verifier schema change (3.3 A)?
- Can Jev be called on OpenRouter? Is its price subsidised? How does it score on Graft's labelled cases?
- The official Google announcement of the Gemini CLI personal-tier retirement was not found. The only evidence is the CLI's own error.
- OpenAI's Terms of Use page returned 403 during research.
- Which `codex exec` and `opencode run` flags give JSON output against a schema with tools and MCP off? (Step 5 starts with this spike.)
- Can one `copilot` provider entry serve installations that opted in and fall back cleanly for those that did not, without a token mint on every call?
