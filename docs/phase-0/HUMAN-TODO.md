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

## Step 6: Pilots and gate

- [ ] **Recruit two pilot teams** (20-500 engineers, agents open most PRs, GitHub, willing to vote on cards for 4+ weeks). Who: product owner. Produces: names, contacts, signed agreement (consent for diffs to Anthropic, retention terms, optional eval export) → `docs/plan/development-plan.md` decision "Where the pilot teams come from".
- [ ] **Onboarding session per pilot** (60 min) following `docs/pilots/onboarding.md`: install on selected repos, pick a starter `graft.yaml`, install the trailer hook in each agent harness, explain shadow mode and voting, collect the allow-list (reviewers who review without being requested) as logins, then resolve them to numeric user IDs with `pnpm graft pilot allow-list resolve <file> --installation <id>` and check each ID with the person (the gate matches IDs, not logins). Who: repo owner with the pilot's tech lead. Produces: installation id, allow-file of `login:id` lines (stored outside git), `pilot doctor` all OK.
- [ ] **Baseline**: right after install, `pnpm graft baseline --repo <r> --from <today - 12 weeks> --to <install date>` per pilot repo (at least 4 weeks of history; 2-4 weeks only if history is short). Ask each pilot to list incidents in that period and record them with `pnpm graft incident add`. Who: repo owner.
- [ ] **Backfill eligibility** once after deploying step 6, and **again after deploying the eligibility hardening (migration 0007)**: `pnpm graft pilot sync-reviewers --installation <id> --since <install date>`. Rows stored by the older rules are `verified = false` and the gate ignores them until this has re-verified them (gate reports warn `votes_without_reviewer_sync` meanwhile). Then confirm on one real PR that a reviewer who was requested and holds write access appears (`select reason, verified from pr_reviewers`): requested users are checked with `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, which GitHub documents as needing only `Metadata: read` (already in the manifest), but this was not verifiable offline and a 403/404 fails closed (the user is not eligible). If requested reviewers never show up, look at `pnpm graft pilot doctor` (the `feedback` check WARNs on permission checks answered 403) and the worker log (warning "reviewer permission check denied"), and raise it with the product owner before adding any permission. Who: repo owner.
- [ ] **Weekly gate review** (30 min, same day each week): `pnpm graft pilot doctor` per pilot; `pnpm graft baseline --period shadow --from <pilot start> --to <today>` per repo; `pnpm graft gate report --installation A --installation B --since <pilot start> --allow-file ... --out ~/graft-reports`; read verdict, 👎 cards (open them on GitHub), unavailable reasons, cost; adjust prompts through `pnpm eval run` before shipping any change. Who: repo owner + product owner. Produces: the report files and a short note per week.
- [ ] **Calling the gate.** Call it at the first weekly review where the report says PASS or FAIL, and no earlier than 2 weeks of pilot data; if still INSUFFICIENT DATA after 6 weeks, decide with the pilots whether to extend 2 weeks or record a FAIL for lack of engagement. PASS → start Phase 1. FAIL → prompt work against the eval set, then a fresh 2-week window (`--since` reset). Record the verdict, window, n, interval and report hash in `docs/plan/development-plan.md`. Who: product owner.
- [ ] **Compare the eval proxy**: for PRs in both the pilot eval set and the gate window, compare `cardAcceptableRate` with the thumbs by hand and note the gap. Who: repo owner.
- [ ] **Incident label**: agree the label name with each pilot (`GRAFT_INCIDENT_LABEL`) and ask them to put `Reverts owner/repo#N` (the GitHub revert button does) or `Graft-Culprit: #N` in fix PRs. Who: product owner.
- [ ] **Check `GRAFT_INTENT_SENSITIVE_PATHS`** still loads after deploy (startup now rejects globs the matcher does not model and mixed-script segments, and warns about non-ASCII characters). Who: repo owner.
- [ ] **Webhook payload retention.** Confirm after the first deploy that `select deletion_seconds from pgboss.queue where name = 'github.webhook'` is 3600 and that completed webhook jobs disappear within about an hour; the pilot agreement and `docs/pilots/onboarding.md` say so. Who: repo owner.
- [ ] **Check the baseline on real GitHub.** On the first pilot repository, run `pnpm graft baseline --dry-run` and compare a few PRs' numbers with GitHub's timeline by hand (the shape of `review_requested`, `reviewed` and draft events is only verified against the fake API). Who: repo owner.
- [ ] **Offboarding**: when a pilot leaves, follow the onboarding doc's deletion procedure and record the `pilot_purges` id. Who: repo owner.

