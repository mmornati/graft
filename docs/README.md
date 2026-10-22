# Graft documentation

[Back to the project README](../README.md)

New to Graft? Start with the [two-and-a-half-minute video](video.md): how it works, who is involved and what changes for reviewers and agents. Then [What a reviewer sees](video-reviewer-tour.md) shows the comment, the checks and the ratings on four simulated pull requests.

## Use and run Graft

| Page | What is in it |
| --- | --- |
| [getting-started.md](getting-started.md) | Prerequisites, the offline quickstart in detail, tests, CI and every `pnpm` script. |
| [github-app.md](github-app.md) | Registering a real GitHub App from the manifest, smee tunnel, the permissions and events table. |
| [deploy/README.md](deploy/README.md) | Deploying Graft: the Docker image, its processes and secrets, pointing the App at it; guides for [Fly.io](deploy/fly.md) and [Coolify](deploy/coolify.md). |
| [configuration.md](configuration.md) | Every environment variable with its default and rule, and the configuration files. |
| [troubleshooting.md](troubleshooting.md) | Common errors and what they mean. |

## Features

| Page | What is in it |
| --- | --- |
| [features/provenance.md](features/provenance.md) | `Graft-*` trailers, agent or human, precedence, the commit hook. |
| [features/intent-cards.md](features/intent-cards.md) | How a card is written and verified, the risk floor, rating cards, feedback internals. |
| [features/policy.md](features/policy.md) | `graft.yaml` in Phase 0 (report only), the CLI and the CI lint workflow. |
| [graft-yaml.md](graft-yaml.md) | The full `graft.yaml` v1 reference. Example: [examples/graft.yaml](examples/graft.yaml). |
| [features/evaluation.md](features/evaluation.md) | `pnpm eval`: case sets, encryption, labeling, live runs, the synthetic CI baseline. |
| [features/modes.md](features/modes.md) | Report and enforce modes, `pnpm graft mode`, the ceiling, rollback, the mutation guard. |
| [features/guard.md](features/guard.md) | The post-merge guard: default-branch history, CI result classes, the culprit rule, confirmation, the report-mode comment, `guard.checks`, `pnpm graft guard list`. |
| [features/pilots-and-gate.md](features/pilots-and-gate.md) | Pilot CLI, the Phase 0 gate, review-time baseline, rollup, incidents. |
| [e2e.md](e2e.md) | The live end-to-end runner against a real sandbox repository. |

## Internals

| Page | What is in it |
| --- | --- |
| [architecture.md](architecture.md) | Diagrams, modules, contracts (webhooks, LLM, managed comment, retention, replay, policy), source layout, data model. |
| [decisions.md](decisions.md) | Library versions, library facts checked, and every deviation from the step specs, by step. |

## Runbooks and reference material

| Page | What is in it |
| --- | --- |
| [pilots/onboarding.md](pilots/onboarding.md) | Onboarding a pilot team: what Graft reads and stores, data sent to Anthropic, shadow mode, weekly ritual, offboarding. |
| [pilots/](pilots/) | Starter policies: [graft.service.yaml](pilots/graft.service.yaml), [graft.platform.yaml](pilots/graft.platform.yaml), [graft.library.yaml](pilots/graft.library.yaml). |
| [e2e/runbook.md](e2e/runbook.md) | Running the live e2e suite step by step, and one section per failure code. |
| [e2e/live-scenarios-spec.md](e2e/live-scenarios-spec.md) | Design of the live scenarios. Reviews: [e2e/reviews/](e2e/reviews/). |
| [phase-0/labeling-guide.md](phase-0/labeling-guide.md) | How to label pull requests for the evaluation set. |
| [phase-0/HUMAN-TODO.md](phase-0/HUMAN-TODO.md) | Things only a person can do (App registration, keys, pilots, real-GitHub checks). |

## Product and planning

| Page | What is in it |
| --- | --- |
| [spec/mvp-spec.md](spec/mvp-spec.md) | The MVP spec: thesis, users, scope, core features, architecture, success metrics, risks. |
| [plan/development-plan.md](plan/development-plan.md) | The 12-week plan: Phase 0 (shadow mode) and Phase 1 (enforce). |
| [phase-0/README.md](phase-0/README.md) | How each Phase 0 step is built (spec, build, review, fix) and the constraints for every step. |
| Step specs | [1 Base setup](phase-0/step-1-base-setup.md) · [2 Provenance](phase-0/step-2-provenance.md) · [3 Intent service](phase-0/step-3-intent-service.md) · [4 Evaluation set](phase-0/step-4-evaluation-set.md) · [5 Policy engine](phase-0/step-5-policy-engine.md) · [6 Pilots and gate](phase-0/step-6-pilots-and-gate.md) |
| [phase-0/reviews/](phase-0/reviews/) | Review notes for every step. |
| [phase-1/README.md](phase-1/README.md) | The Phase 1 plan (enforce), with report mode as the default so it can be tried without changing outcomes. |
| Phase 1 step specs | [1 Modes and safety rails](phase-1/step-1-modes.md) · [2 Approvals Graft can enforce](phase-1/step-2-approvals.md) · [3 Break-glass and audit log](phase-1/step-3-break-glass.md) · [4 Guard detection](phase-1/step-4-guard-detection.md) · [5 Revert PRs](phase-1/step-5-revert-prs.md) |

Security reports: see [SECURITY.md](../SECURITY.md).
