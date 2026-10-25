# Changelog

Graft's releases. Until both the Phase 0 and the Phase 1 gates pass on pilot data, versions stay below `1.0.0`. Every release defaults to report mode: nothing enforces until an operator raises `GRAFT_MODE_CEILING` and sets a repository to enforce.

## Unreleased

### Added

- An optional, read-only **operator console** (`console/`): a daily journal of what Graft handled, every PR's record, what needs a human, the gate, the token budget and the job queue. Its own container and image, a SELECT-only database role, sign-in with GitHub restricted to a list. Graft runs the same without it. [Operator console](docs/console.md)
- `report.language` in `graft.yaml`: the intent card's model-written text in one of 12 languages (`intent-v3`). Headings and labels stay in English. [graft.yaml](docs/graft-yaml.md)

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
