# Graft MVP development plan

Copied from the "Development plan" tab of the MVP spec doc (2026-10-14).

Two to three engineers take Graft from an empty repository to an enforced `graft/policy` check in 12 weeks, matching phases 0 and 1 of the roadmap.

## Spec fixes before week 1

1. **Auto-approve and GitHub branch protection conflict.** A passing `graft/policy` check does not count as a human approval. Pilot repos drop required reviewers from branch protection, and `graft/policy` counts approvals itself.
2. **Scope differs between sections.** Phase 1 ships a small MCP surface. Task grouping and ranking wait for phase 2.
3. **Bisecting needs more GitHub access than allowed.** The MVP finds the culprit from CI results that already exist on every commit to `main`. Bisecting with re-runs is off by default.

## Stack

| Layer | Choice |
| --- | --- |
| Language and GitHub client | TypeScript on Node, `@octokit/webhooks` and `@octokit/rest` (or Probot) |
| Storage | Postgres — intents, provenance and verdicts, never code |
| Job queue | `pg-boss` on the same Postgres |
| MCP server | Official TypeScript MCP SDK, in the same service |
| Models | Claude API: Haiku 5.5 (`claude-haiku-5-5`) for `trivial` diffs and first-pass risk; Sonnet 5.5 (`claude-sonnet-5-5`) for cards on `logic` and `sensitive` PRs |
| Hosting | One deployable service on Fly.io, Render or similar |

## Phase 0: shadow mode (weeks 1–6)

Phase 0 ends with intent cards and provenance on every pilot PR and a report-only policy check, gated on card accuracy of 90% or more.

- **Step 1 — Base setup.** Register the GitHub App with the fewest permissions possible. Webhook receiver that checks signatures and skips duplicate deliveries. Job queue, Postgres tables from the data model, install flow, a sandbox org with test repos, and CI.
- **Step 2 — Provenance.** Parse the `Graft-Agent:`, `Graft-Model:` and `Graft-Task:` trailers and store them per PR. Show them on the PR.
- **Step 3 — Intent service.** A writer builds the card from the PR description, linked issue and diff. A verifier checks the card against the diff only. A risk classifier assigns the class. The card shows as a pinned comment and a check run, with a thumbs-up or thumbs-down to measure accuracy.
- **Step 4 — Evaluation set.** About 100 past agent PRs from the pilots, labeled by hand. Every prompt change runs against it.
- **Step 5 — Policy engine, report-only.** A JSON schema for `graft.yaml` and rule evaluation. The check says what it would require but always finishes as neutral.
- **Step 6 — Pilots and gate.** Onboard 2 pilot teams, pull baseline review times from the GitHub reviews API, and check card accuracy against the 90% gate.

**Safety rule.** The model can only raise a PR's risk class, never lower it. Fixed rules set a minimum class from paths, diff size, deleted tests, dependency or CI file changes, and the policy's sensitive paths. The PR description comes from the agent being judged, so it is untrusted input.

## Phase 1: enforce (weeks 7–12)

- Weeks 7–8: `graft/policy` becomes required; approvals from reviews + team membership; re-run on push/review; stale approvals; break-glass label with audit log.
- Weeks 9–10: post-merge guard; culprit from existing CI results; revert PR; optional auto-merge of reverts.
- Week 11: minimal MCP server (`open_change`, `report_provenance`, `get_status`, `get_policy`), per-repo tokens.
- Week 12: security review, 5 pilots, gate.

## Decisions needed by week 1

- [ ] Where the 5 pilot teams come from
- [ ] First agent harness for provenance (Claude Code is easiest)
- [ ] How long diffs sent to the model are kept (should be "not stored")
