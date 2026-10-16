# Live end-to-end scenarios

[Docs index](README.md) · [Runbook](e2e/runbook.md) · [Design spec](e2e/live-scenarios-spec.md)

Unit and integration tests use fakes for GitHub and the model. The live end-to-end runner checks the assumptions those fakes encode against real GitHub, in a sandbox repository you own. **Read the [runbook](e2e/runbook.md) before running anything except `--only-offline`.**

`pnpm graft e2e` proves Graft against **real GitHub** (and optionally the real Claude API) in a dedicated, user-owned sandbox repository, `mmornati/graft-sandbox`: a files-only copy of `mmornati/ai-running-coach` plus a `graft-e2e/` fixture directory, a starter `graft.yaml` and a marker file. It runs 10 scenarios (agent and human PRs, CI and policy file changes, an injection attempt, votes and eligibility, a push to `main`, a webhook redelivery) and 2 optional baseline scenarios, checks five system invariants after each (every Graft check `neutral`, one Graft comment per PR, no planted sentinel in Graft's database, `pilot doctor` OK, token spend recorded), verifies 21 assumptions that only fakes had tested so far, and writes a Markdown and JSON report to the gitignored `e2e-runs/`. Each confirmed assumption ticks its HUMAN-TODO item (`report --update-human-todo`). The runbook is [docs/e2e/runbook.md](e2e/runbook.md); the design is [docs/e2e/live-scenarios-spec.md](e2e/live-scenarios-spec.md).

**Two credentials, kept apart.** The *actor* (`GRAFT_E2E_ACTOR_TOKEN`, else `gh auth token`) acts as the repository owner; an optional *outsider* (`GRAFT_E2E_OUTSIDER_TOKEN`, a second account) votes without being the PR author's reviewer. Both live in the shell only: the runner refuses to start if `.env` holds a `GRAFT_E2E_*` key or any actor token value, and no file outside `src/e2e`, `src/bin/graft.ts`, `test/` and `docs/` names those variables. Graft itself still talks to GitHub only as its App.

```sh
pnpm graft e2e setup   [--sandbox o/r] [--create] [--yes] [--invite-outsider] [--dry-run] [--confirm o/r]
pnpm graft e2e run     [--sandbox o/r] [--scenario <id>]... [--run-id <id>] [--dry-run] [--interactive]
                       [--llm auto|live|none] [--max-cost-usd 5] [--lenient-model] [--wait-cron]
                       [--with-source-baseline] [--server-log <file>] [--worker-log <file>]
                       [--capture] [--timeout-scale 1] [--confirm o/r] [--json]
pnpm graft e2e run --only-offline            # the whole suite against the fake world; no network
pnpm graft e2e verify  [--run-id <id>] [--after-retention] [--server-log ...] [--worker-log ...]
pnpm graft e2e report  [--run-id <id>] [--update-human-todo]
pnpm graft e2e cleanup [--run-id <id> | --all] [--yes] [--dry-run]
```

Exit codes: 0 every scenario passed or was skipped, 1 a scenario, invariant or (non-lenient) model assertion failed, 2 usage or configuration, 3 aborted (preflight, guard refusal, budget, declined). `--scenario` takes `s01`..`s10`, `b1`, `b2` and adds the scenario's needs. Safety: the sandbox must be listed in `e2e/sandboxes.json` **and** hold `.graft-e2e-sandbox` naming it; `mmornati/ai-running-coach` and every configured `source` can never be a write target; every non-GET request of every runner client passes a request hook that refuses it before sending unless it targets the sandbox; the runner's database session is read-only; tokens, keys, the webhook secret and the smee URL are redacted from every output, report, state and capture file.

**Agents never run the runner against GitHub.** Implementing and reviewing agents run only the offline commands (`pnpm test`, `pnpm graft e2e run --only-offline`); `setup`, `run`, `verify`, `cleanup` and even `run --dry-run` (its preflight reads from GitHub) are started by a human after reading the runbook. `--only-offline` spawns `vitest run --project integration test/integration/live-e2e.test.ts`, which runs the same suite against the fake GitHub world (`test/helpers/fake-github-world.ts`), the fake LLM and the test database, and writes a real report.

## Related

- Runbook (setup, tokens, costs, failure codes, what never to do): [docs/e2e/runbook.md](e2e/runbook.md).
- Design: [docs/e2e/live-scenarios-spec.md](e2e/live-scenarios-spec.md). Review notes: [docs/e2e/reviews/](e2e/reviews/).
- Library facts and implementation choices: [decisions.md, E2E runner](decisions.md#e2e-runner-library-facts) and [live e2e runner deviations](decisions.md#live-e2e-runner-deviations-and-additions).
- The HUMAN-TODO items the runner can tick: [docs/phase-0/HUMAN-TODO.md](phase-0/HUMAN-TODO.md).
