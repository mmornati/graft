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

## Step 3: Intent service

- [ ] **Create an Anthropic API key.** Use a dedicated workspace for Graft with a monthly spend limit. Who: repo owner. Produces: `ANTHROPIC_API_KEY`. Goes into: the deployment secret (never committed); `.env` for local runs.
- [ ] **Confirm model access.** Check that the workspace can call `claude-haiku-5-5` and `claude-sonnet-5-5` (one manual card on a sandbox PR). Who: repo owner.
- [ ] **Data retention decision.** Diffs, PR descriptions and issue text are sent to the Anthropic API and are never stored by Graft. Confirm the org's API data-retention terms with Anthropic: standard retention, or a zero-data-retention agreement. Decide whether pilots require ZDR, and write the answer into `docs/plan/development-plan.md` ("How long diffs sent to the model are kept") and into the pilot agreement. Who: product owner.
- [ ] **Pilot consent.** Each pilot team agrees in writing that its code diffs are sent to Anthropic for card generation. Who: product owner.
- [ ] **Set the budget.** Set `GRAFT_LLM_DAILY_TOKEN_BUDGET` for pilots after one week of usage data (`select ... from intent_cards`). Who: repo owner.
- [ ] **Check the outputs on GitHub.** On a sandbox PR, check that:
  - the intent section and the `graft/intent` check appear;
  - the "Card is accurate" and "Card is wrong" buttons show on the check and are recorded (`intent_feedback.source = 'check_action'`);
  - a 👍 on the comment is recorded within 15 minutes (`source = 'reaction'`).

  Who: repo owner.
- [ ] **Sensitive paths for pilots.** Decide the extra `GRAFT_INTENT_SENSITIVE_PATHS` per pilot until `graft.yaml` lands. Who: product owner with the pilot's security owner.

## Step 4: Evaluation set

- [ ] **Pilot consent for export.** Each pilot agrees in writing that a sample of its merged agent PRs (diffs, descriptions, linked issues) is copied to an encrypted evaluation store held by the Graft team, used only to measure card quality, never committed, and deleted on request or when the pilot ends. Who: product owner. Produces: an agreement reference → `pnpm eval init --consent-ref`.
- [ ] **Create and store `GRAFT_EVAL_KEY`** (`pnpm eval keygen`) in the team password manager; share it only with labelers. Exclude `GRAFT_EVAL_DIR` from backups and cloud sync; confirm full-disk encryption on every labeler laptop. Who: repo owner.
- [ ] **Export each pilot's PRs** (`pnpm eval export … --sample 50`, about 100 cases over two pilots), with the pilot's `--sensitive-paths` and any `--redact-host` they ask for. Who: repo owner, with the App installed on the pilot (step 6) or a read-only token.
- [ ] **Labeling sessions.** Two labelers read `docs/phase-0/labeling-guide.md`, label every case, run `assign-double` and double-label the subset, run `agreement` (target risk κ ≥ 0.6), adjudicate. Who: two engineers familiar with the pilot code. Produces: gold labels for about 100 cases.
- [ ] **First live baseline.** `pnpm eval run --set <pilot set> --live` (check the printed estimate; set `--max-cost-usd`), review `report.md`, then `--save-baseline <set>/baseline.json`. Set the `pilot` thresholds in `eval/thresholds.json` from it and set `provisional: false`. Record the date, models, `PROMPT_VERSION` and cost in `docs/plan/development-plan.md`. Who: repo owner.
- [ ] **Check prices** in `src/eval/pricing.ts` against Anthropic's pricing page before the first live run and update `PRICING_VERIFIED_AT`. Who: repo owner.
- [ ] **When a pilot leaves**: `pnpm eval purge --set <dir> --confirm <setId>` on every labeler machine, and delete any other copies. Who: repo owner.

## Step 5: Policy engine (report-only)

- [ ] **Update the App's events.** In the registered App's settings (Permissions & events), subscribe to **Pull request review** and **Push**. No permission changes. Check whether the installations must accept the change. Then confirm that one push and one review on `sample-ts` arrive (`select event, action from webhook_deliveries order by received_at desc limit 5`). Who: org owner.
- [ ] **Pilot teams write their `graft.yaml`** on the default branch through a normal reviewed PR, starting from `docs/examples/graft.yaml`. Each pilot runs `pnpm graft policy check graft.yaml` and adds the Action from `docs/graft-yaml.md`. Who: each pilot's tech lead with their security owner. Produces: one valid `graft.yaml` per pilot repo.
- [ ] **Move `GRAFT_INTENT_SENSITIVE_PATHS` into `graft.yaml`** (`sensitive_paths`) for each pilot, then clear the env value. Who: product owner.
- [ ] **Check team slugs exist** in each pilot org (`gh api orgs/<org>/teams --jq '.[].slug'`). Graft cannot check them until Phase 1 (`members: read`). Who: pilot tech lead.
- [ ] **Do not change branch protection in Phase 0.** Keep required reviewers. Do **not** make `graft/policy` a required check. Removing required reviewers and requiring `graft/policy` happens in Phase 1 (development plan, spec fix 1). Who: pilot repo admins.
- [ ] **Publish the JSON Schema URL.** Decide the final Graft repo location, replace `<org>` in `docs/examples/graft.yaml`, `docs/graft-yaml.md` and the Action snippet, and set `GRAFT_TOOL_TOKEN` in pilot repos while the Graft repo is private (a fine-grained, read-only token for that one repository). Who: repo owner.
- [ ] **Check on GitHub.** On a sandbox PR, check that:
  - the `graft/policy` check is `neutral` with a "Would ..." title;
  - the comment's policy section renders, with no team notification;
  - a push to `main` that edits `graft.yaml` re-evaluates open PRs.

  Who: repo owner.
- [ ] **Plan Phase 1 permission.** Note that team approvals need `members: read` (org), which installations must accept. Who: product owner.
