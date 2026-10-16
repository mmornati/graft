# Product

<!-- impeccable:product-schema 1 -->

> Interview substitution: the owner delegated every product and visual decision for this site and asked not to be
> interrupted. No interview round ran. Facts below come from README.md and docs/ (the source of truth); lines marked
> *(inferred)* are reasoned from the brief and should be confirmed by the owner.

## Platform

web

## Stack

Delegated, and mirrored from the sibling project `ai-email-assistant`: a hand-built static landing page in `website/`
(HTML, one CSS file, a few lines of JS, no build step) published at the root of GitHub Pages, and MkDocs Material
documentation built strictly from `docs/` under `/docs/`, deployed by `.github/workflows/docs.yml`. English only.

## Users

- **Tech leads and reviewers** on GitHub teams of roughly 20 to 500 people where coding agents already open many of the
  pull requests (from `docs/spec/mvp-spec.md`). Their pain is review capacity: dozens of agent PRs a day, each read line
  by line, with a description written by the agent being reviewed.
- **Platform and security owners** who want path-level and semantic rules ("agents never touch `infra/`") checked on
  every PR, beyond what CODEOWNERS can say.
- **Prospective pilot teams and contributors** evaluating whether to install a Phase 0 shadow-mode App *(inferred: the
  site's realistic first audience while the repository is young)*.

## Product Purpose

Graft is a GitHub App and service that puts four answers on every pull request, in one managed comment and three check
runs: who wrote it (agent, model, task, session, or a human), what it claims to do (an intent card), whether the diff
matches (a verifier model that sees only the diff, file list and card, plus a rule-based risk floor), and what the
repository's `graft.yaml` policy says. Success in Phase 0 is reviewers reading the card instead of the PR description and
rating cards accurate often enough to pass the 90% card-accuracy gate.

## Positioning

The PR description is untrusted input, so Graft never takes the agent's word for it: a separate verifier checks every
claim against the diff alone, and fixed rules set a risk floor (`trivial`, `logic`, `sensitive`) that no model can lower.
It sits on existing GitHub repositories with nothing to migrate.

## Operating Context

- Installed as a GitHub App; a Fastify server verifies and deduplicates signed webhooks and enqueues jobs in Postgres 17
  (pg-boss); a worker re-reads everything from the GitHub API, calls the Anthropic API (writer and verifier) and publishes
  three `neutral` check runs (`graft/provenance`, `graft/intent`, `graft/policy`) and one managed comment.
- Provenance comes from `Graft-Agent`, `Graft-Model`, `Graft-Task`, `Graft-Session` git trailers (or the PR description),
  bot accounts, configured logins and agent co-authors.
- Policy is `graft.yaml` read from the base branch only; block wins, then require, then approve; a CLI
  (`pnpm graft policy check`) and a CI lint exist.
- `pnpm eval` evaluation harness; pilot CLI and a Phase 0 gate report with a Wilson interval; `pnpm graft e2e` live
  scenarios against a sandbox repository.
- Offline quickstart in under five minutes with Node 24, pnpm 11 and Docker; no App or API key needed.

## Capabilities and Constraints

- **Phase 0, shadow mode.** Graft reports and never enforces: every check concludes `neutral`, a "would approve" is not
  an approval, team membership is not checked. Branch protection stays as it is.
- Phase 1 (enforcement, post-merge guard, MCP server) is planned and not implemented.
- Privacy: no file contents, diffs, PR titles or bodies are stored or logged; rows hold ids, numbers, SHAs, paths and
  the model's own prose. Diffs, PR text and linked issue text *are* sent to Anthropic to write and verify cards.
- No license has been chosen yet; all rights reserved. The repository is currently private *(per the owner's brief)*.

## Brand Commitments

- Name: Graft (repository `mmornati/graft`). The horticultural reading (a scion joined onto rootstock) is the owner's
  suggested metaphor for the site, made binding in the brief.
- Voice: plain, exact, understated; the README's register. Never "enforces", never hype.

## Evidence on Hand

- The managed-comment sample in README.md ("What a reviewer sees"): a fictional `acme` organisation, an agent adding a
  login rate limiter. This is the only demonstration material; it is fictional and must be labelled so.
- `docs/examples/graft.yaml`, the shipped example policy.
- Diagrams in README.md and docs/ (Mermaid).
- **Absent, never to be fabricated:** customers, logos, testimonials, accuracy numbers, review-time savings, pricing,
  star counts, adoption figures.

## Product Principles

1. Never take the author's word: claims are checked against the diff.
2. Rules set the floor; models may only raise it.
3. Report before enforce: Phase 0 earns trust in shadow mode, measured by a public gate.
4. Store as little as possible; say plainly what leaves the building.
5. Adopt without migrating: Graft sits on top of GitHub as it is.

## Accessibility & Inclusion

WCAG 2.2 AA contrast in light and dark, full keyboard use, `prefers-reduced-motion` respected, layouts usable down to
360px wide *(owner's brief)*.
