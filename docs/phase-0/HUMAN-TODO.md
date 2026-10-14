# Human to-do (things only a person can do)

Every Phase 0 step appends to this checklist. Each item says who does it, what it produces, and where the value goes.

## Step 1: Base setup

- [ ] **Create the sandbox GitHub org** (suggested name `graft-sandbox-<suffix>`). Who: repo owner. Produces: the org name. Goes into: the register-app form and `github/app-manifest.json` (`url`).
- [ ] **Create test repos** in it: `sample-ts` (small TS project with CI), `sample-py`, `empty`. Enable Actions. Who: repo owner. Produces: three repositories used by later steps.
- [ ] **Create a smee.io channel** (<https://smee.io/new>) and set it as `hook_attributes.url` in `github/app-manifest.json` (dev) and as `SMEE_URL` in `.env`. Who: repo owner. Produces: the channel URL.
- [ ] **Register the App** from `github/app-manifest.json` with `github/register-app.html`, then convert the code with `gh api -X POST /app-manifests/<code>/conversions`. Who: org owner. Produces: App ID → `GITHUB_APP_ID`; PEM → a file outside the repo referenced by `GITHUB_APP_PRIVATE_KEY_PATH` (deployment secret in prod); webhook secret → `GITHUB_WEBHOOK_SECRET`. Record the App slug.
- [ ] **Install the App** (who: org owner) on the sandbox org for **selected** repos (`sample-ts`, `sample-py`), and check that an `installations` row and two `repositories` rows appear.
- [ ] **Add then remove `empty`** (who: org owner) from the installation, and check that `removed_at` gets set on its `repositories` row.
- [ ] **Push this repo to GitHub** and check that CI is green. Who: repo owner. CI needs no secrets.
- [ ] **Open decisions from the plan**: pilot team source, first agent harness, diff retention ("not stored"). Who: product owner. Produces: written answers in `docs/plan/development-plan.md`.

## Step 2: Provenance

- [ ] **Configure the first harness (Claude Code) to add `Graft-*` trailers**: instruct it in the project's `CLAUDE.md`, or use a `prepare-commit-msg` hook. Who: repo owner.
- [ ] **Open a PR in `sample-ts` with trailers** and check the comment and the `graft/provenance` check. Then force-push without trailers and check that the output flips to "Human" (or to "Agent (agent co-author)").
- [ ] **Confirm that comments created by the App carry `performed_via_github_app.id`.** If they do not, set `GITHUB_APP_SLUG` (the fallback matches the bot login `<slug>[bot]` plus the marker) and report it, because decision D13 then needs a permanent bot-login rule. Who: repo owner, from the first real PR.
- [ ] **Decide `GRAFT_AGENT_LOGINS` for the pilots.** Who: product owner.

