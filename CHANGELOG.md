# Changelog

Graft's releases. Until both the Phase 0 and the Phase 1 gates pass on pilot data, versions stay below `1.0.0`. Every release defaults to report mode: nothing enforces until an operator raises `GRAFT_MODE_CEILING` and sets a repository to enforce.

## Unreleased

### Added

- The `copilot` provider kind (dormant until configured): calls billed to the installing organization's Copilot through an installation token limited to `copilot_requests: write`, only for installations listed as opted in, with a fallback model for the rest. Empty sessions: no tools, no MCP, a replaced system message. Needs `@github/copilot-sdk` in the image and the Copilot requests permission on the App. [Copilot provider](docs/configuration.md#copilot-provider)
- The console's System page lists the models that wrote, first-passed and verified cards in the window (with their registry provider), and the failure classes of unavailable cards and failed verifiers. [Operator console](docs/console.md)
- The `cli:codex` and `cli:opencode` provider kinds, with the same isolation as `cli:claude`: every tool feature off by name, nothing saved, and a call fails if a tool ran anyway. Self-hosted only. [CLI providers](docs/configuration.md#cli-providers)
- The `cli:claude` provider kind: Claude Code on the worker's machine, run per call with no tools, MCP servers or settings, in an empty directory, with a clean environment. For self-hosted single-tenant installs only: the new `GRAFT_DEPLOYMENT=hosted` refuses it. [CLI providers](docs/configuration.md#cli-providers)
- `pnpm eval` reads the provider registry, so a candidate model can be run against the saved baseline before it is put in a role. [Evaluation](docs/features/evaluation.md)
- The `openai-compatible` provider kind: OpenAI, OpenRouter, Mistral, DeepSeek, Gemini and local servers such as Ollama and vLLM through the Chat Completions format, with JSON-schema output, OpenRouter zero-data-retention routing and the same failure classes as the Claude client. [Model providers](docs/configuration.md#model-providers)
- A server-side **provider registry** (`GRAFT_LLM_PROVIDERS` or `GRAFT_LLM_PROVIDERS_FILE`): several model providers, each with its own credential, capabilities and prices, and roles that point the writer and verifier at any of them as `<provider id>/<model>`. Without it nothing changes. [Model providers](docs/configuration.md#model-providers)
- An optional, read-only **operator console** (`console/`): a daily journal of what Graft handled, every PR's record, what needs a human, the gate, the token budget and the job queue. Its own container and image, a SELECT-only database role, sign-in with GitHub restricted to a list. Graft runs the same without it. [Operator console](docs/console.md)
- `report.language` in `graft.yaml`: the intent card's model-written text in one of 12 languages (`intent-v3`). Headings and labels stay in English. [graft.yaml](docs/graft-yaml.md)

### Changed

- Behavior changes the verifier finds that the card leaves out are listed under **Also changed** and no longer count as a disagreement (`intent-v5`). The "verifier disagrees" warning and its `logic` floor are kept for claims the diff does not show or contradicts. [Intent cards](docs/features/intent-cards.md)
- Lower model cost per card (`intent-v4`): the writer and the verifier share one system prompt and a cached start of the user message holding the diff, so the verifier reads the diff from the prompt cache instead of paying for it again.

## v0.1.0 (2026-10-24): Phase 1 built, report mode by default

All seven Phase 1 steps are built, reviewed twice and merged. Each one ships with a report mode, and report mode is the default.

### Added

- **Modes and safety rails** (step 1): per-repository `policy_mode`, `guard_mode` and `mcp_write`, set only by the operator with `pnpm graft mode`; the server ceiling `GRAFT_MODE_CEILING`; a write allow-list that refuses any GitHub write a mode does not permit; a full and a report-only App manifest. [Modes](docs/features/modes.md)
- **Approvals Graft can enforce** (step 2): in enforce mode `graft/policy` concludes `success` or `failure` from approvals with write access on the current head and verified team membership, and re-runs on push, review and membership changes. Report mode shows the would-be conclusion. [Policy](docs/features/policy.md)
- **Break-glass and audit log** (step 3): a maintainer or admin adds `graft:break-glass` to bypass the policy for one commit; every bypass and mode change is audited (`pnpm graft audit list`, `pnpm graft mode history`).
- **Post-merge guard** (step 4): watches default-branch CI, confirms a failure on the next commit, names the culprit in a comment and in `pnpm graft guard list`. `guard.checks` in `graft.yaml` scopes it. [Guard](docs/features/guard.md)
- **Revert pull requests** (step 5): in enforce mode the guard opens a `graft:revert` PR built from blob SHAs, without reading code; a culprit whose files changed again is `needs_human`. Opt-in auto-merge for `trivial` and `logic` reverts with `guard.auto_merge_reverts`, never for `sensitive`.
- **MCP server** (step 6): `get_status`, `get_policy`, `report_provenance` and `open_change` at `/mcp`, with per-repository tokens (`pnpm graft mcp-token`). Reported provenance can only tighten a verdict. [MCP](docs/features/mcp.md)
- **Security review, rollout runbook and Phase 1 gate** (step 7): the [security review](docs/phase-1/reviews/step-7-security-review.md) of everything that writes, the [rollout runbook](docs/pilots/phase-1-runbook.md), and `pnpm graft gate report --phase 1`.
- Deployment: a Dockerfile and guides for [Fly.io and Coolify](docs/deploy/README.md); the Messages API client can go through gateways and authenticate with Workload Identity Federation.
- A third video, [Enforce mode, step by step](docs/video-enforce-tour.md), next to [What a reviewer sees](docs/video-reviewer-tour.md).

### Changed

- Security fixes from the step 7 review: every process honours the lower of its own ceiling and the worker's; writes whose path carries a query string are refused; MCP authenticates before reading the body and honours `GRAFT_TRUST_PROXY`; approvals on MCP-opened PRs count only when every commit is verified (and not `web-flow`); enforcing `policy_mode` on a public repository needs `--public`.
- The intent verifier gets file context and can answer "unverifiable".
- Graft's own `graft.yaml` treats the guard, MCP, audit and policy modules as sensitive and scopes the guard to the CI job `check`.

### Not done yet (people, not code)

The Phase 1 [HUMAN-TODO](docs/phase-1/HUMAN-TODO.md): real-GitHub checks of the new writes, the sandbox smoke tests, five pilot teams through the runbook, and the Phase 0 and Phase 1 gate calls.

## v0.0.1 (2026-10-16): Phase 0, shadow mode

Provenance, intent cards with a verifier and a rule-based risk floor, the evaluation set, the report-only policy engine, the pilot tooling and the Phase 0 gate, the live e2e runner, the website, the docs and the first explainer video.
