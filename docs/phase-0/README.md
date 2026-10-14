# Phase 0 — how each step is built

Each step of Phase 0 goes through the same loop, each part run by a separate agent:

1. **Spec** (Opus, senior engineer): writes `docs/phase-0/step-N-<name>.md` — the detailed task list, acceptance criteria and test plan for the step.
2. **Build** (Sonnet, developer): implements exactly that spec, with tests.
3. **Review** (Opus, senior engineer): reviews the implementation against the spec and writes `docs/phase-0/reviews/step-N-review-R.md` with a verdict (`APPROVED` or `CHANGES REQUESTED`) and numbered findings.
4. **Fix** (Sonnet, a fresh developer): addresses every finding; then back to 3 until approved.
5. The step is committed, then the next step starts.

Source documents: [MVP spec](../spec/mvp-spec.md), [development plan](../plan/development-plan.md).

## Constraints for every step

- Everything must build and test **offline on a laptop**: no real GitHub App, no Claude API key, no internet. GitHub is reached through Octokit and is mocked in tests (recorded/fixture webhook payloads, `nock` or an injected client). The Claude API is behind an interface with a deterministic fake for tests.
- Postgres runs from `docker compose` (OrbStack is available). Tests that need a database use that container or a throwaway schema; pure logic is unit-tested without it.
- Things only a human can do (registering the real GitHub App, creating API keys, recruiting pilots, labeling real PRs) are written down in `docs/phase-0/HUMAN-TODO.md`, never faked.
- Graft stores no source code: diffs may be read in memory and sent to the model, never persisted.
- Package manager: pnpm. Node 24. TypeScript strict mode.
