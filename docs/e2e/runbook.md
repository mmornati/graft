# Live e2e runbook

How a person runs `pnpm graft e2e` against real GitHub. The design is in [live-scenarios-spec.md](live-scenarios-spec.md). **Never run it from CI, from a schedule or from an agent.**

## 1. What the runner does and costs

It opens real pull requests in a private sandbox repository (`mmornati/graft-sandbox`), waits for the real Graft (server, worker, tunnel, and optionally the Claude API) to answer, and checks what Graft computed, published and stored against exact expectations. It runs 10 scenarios (s01 agent typo, s02 CI file, s03 misleading body, s04 injection text and mentions, s05 policy file edit, s06 second commit, s07 human PR with a rewritten history, s08 votes and eligibility, s09 push to `main`, s10 webhook redelivery), plus b1 (baseline dry run on the sandbox) and, on request, b2 (baseline dry run on the source). After every scenario it checks five invariants, and at the end 21 assumption checks.

- **Time:** about 40 minutes, most of it waiting for webhooks, cards and policy re-evaluations.
- **Cost:** with a live model, at most `--max-cost-usd` (default 5 USD). The plan's bound is `20,000` input tokens and three times `MAX_OUTPUT_TOKENS` output tokens at the strong model's price, per expected model run; the runner refuses to start if the whole plan's bound exceeds the limit and skips a scenario whose bound would cross it. Without `ANTHROPIC_API_KEY` the mode is `none`: no spend, s08 skipped.
- **What lands on GitHub:** a run issue, about nine branches `graft-e2e/<runId>/<scenario>`, about eight pull requests titled `[graft-e2e <runId> <scenario>] ...`, comments and check runs by the App, reactions, reviews, and two commits to `main` (s09) that edit and then restore `graft.yaml`. All carry the label `graft-e2e`. `cleanup` closes and deletes them. Nothing is ever merged and no repository is ever deleted.

## 2. One-time setup

1. **Register a personal-account App** from the manifest. Serve `github/register-app.html` (`cd github && python3 -m http.server 8080`), open it, choose **Personal account**, and submit. First edit `github/app-manifest.json`: set `name` and `url`, and set `hook_attributes.url` to a **new** smee channel (<https://smee.io/new>). The manifest keeps `"public": false`: a private App installs only on its owner's account, which is why it is registered under `mmornati`. Convert the code with `gh api -X POST /app-manifests/<code>/conversions`. Keep the **App id**, **slug**, the **PEM** (in a file outside the repository) and the **webhook secret**.
2. **Fill `.env`** (copy `.env.example`): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_SLUG`, `SMEE_URL`, and optionally `ANTHROPIC_API_KEY` and `GRAFT_LLM_DAILY_TOKEN_BUDGET`. **No `GRAFT_E2E_*` variable and no actor token may be in `.env`**: the runner refuses to start otherwise.

## 3. The actor token

The actor acts as the repository owner. Either:

- a fine-grained personal access token owned by `mmornati`, limited to `graft-sandbox`, with Contents, Pull requests and Issues set to read and write, and Administration read and write **only for `setup`** (create the repository, disable Actions, invite the outsider); or
- nothing at all: the runner then reads `gh auth token`.

Export it in the shell where you run the runner: `export GRAFT_E2E_ACTOR_TOKEN=...`. It is never written to a file, to `.env`, to a URL or to argv.

## 4. The outsider (optional)

Scenario s08 needs a second GitHub account. Create a classic personal access token for it (`repo` for a private sandbox, `public_repo` for a public one) with a 7-day expiry, and export it in the shell only: `export GRAFT_E2E_OUTSIDER_TOKEN=...`. Without it s08 is skipped (`needs_outsider`). On a **private** sandbox the outsider is invited as a collaborator (you accept the invitation in the browser); it is ineligible on the PR it votes on because it is neither requested nor a reviewer there. On a **public** sandbox it has no access, forks the sandbox and opens its PR from the fork; the report states the mode.

## 5. Start Graft

```sh
mkdir -p e2e-runs/logs
pnpm db:up
pnpm db:migrate
pnpm dev:server 2>&1 | tee e2e-runs/logs/server.log     # terminal 1
pnpm dev:worker 2>&1 | tee e2e-runs/logs/worker.log     # terminal 2
pnpm tunnel                                              # terminal 3 (smee)
```

Keep these running for the whole run. The logs let the runner check that no sentinel or secret leaked (`--server-log`, `--worker-log`) and that the redelivery was a duplicate.

## 6. Create the sandbox and install the App

```sh
pnpm graft e2e setup --create --yes [--invite-outsider]
```

It creates the private repository, copies the files of `mmornati/ai-running-coach` (no history, without `.github/workflows` and `.circleci`) with one commit, adds the marker `.graft-e2e-sandbox`, the starter `graft.yaml` and the `graft-e2e/` fixtures, disables Actions and creates the label. Then **install the App on the sandbox** from the link it prints, choosing **Only select repositories** and ticking `graft-sandbox` alone. Never "All repositories": the App is owned by the account that also owns `ai-running-coach`, and Graft would then comment on that repository's pull requests. `setup` and `run` refuse (check `installation_scope`) unless the installation lists exactly the sandbox, and run `pnpm graft e2e setup --yes` again: it checks the installation, its permissions and events, and the database rows, and writes `e2e-runs/sandbox.json`. A drifted `graft.yaml` or fixture is restored with one commit (`setup --yes`).

## 7. Run

```sh
pnpm graft e2e run --dry-run                    # the preflight and every step, without writing anything
pnpm graft e2e run [--interactive] [--capture] \
    --server-log e2e-runs/logs/server.log --worker-log e2e-runs/logs/worker.log
```

The runner asks you to type the sandbox name (or pass `--confirm mmornati/graft-sandbox`). With `--interactive` it also asks you to click **Card is wrong** (as the outsider) and **Card is accurate** (as the actor) on the `graft/intent` check, and to say whether you see the buttons. `--llm none` forces the no-model mode, `--wait-cron` waits for the real 15-minute poll (A04; **needed to tick the `s3-outputs` item**, so do one run with `--interactive --wait-cron`, about 16 minutes longer), `--with-source-baseline` adds b2, `--scenario s03` runs one scenario and what it needs, `--timeout-scale 2` doubles every timeout.

### The enforce sandbox (Phase 1 step 7, D21)

One scenario, `e01`, checks `policy_mode: enforce` end to end. It runs only against a sandbox whose entry in `e2e/sandboxes.json` has `"mode": "enforce"` (the default is `"report"`), and nothing else runs there: `s01` to `s10`, `b1` and `b2` refuse an enforce sandbox, and `e01` refuses a report one (exit 2). It needs the outsider (a write collaborator of a private sandbox), else it is skipped.

**The runner never changes a mode.** You set it, and the preflight checks it with the in-process, read-only `pnpm graft mode show --repo <sandbox> --json`:

```sh
# GRAFT_MODE_CEILING=enforce on every process, then restart them
pnpm graft mode set --repo <sandbox> --policy enforce --reason "e2e enforce sandbox"
pnpm graft e2e setup --sandbox <sandbox> --yes    # writes e2e/fixtures/graft.enforce.yaml as main:graft.yaml
pnpm graft e2e run --sandbox <sandbox>
```

An enforce sandbox must have the worker's ceiling `enforce`, `policy_mode` effective `enforce`, `guard_mode` requested `report` and `mcp_write` `off`; a report sandbox must request report everywhere. Otherwise the preflight refuses (check `modes`) and prints the command to run. Its `graft.yaml` is `e2e/fixtures/graft.enforce.yaml`: one rule, `graft-e2e/**` requires one human approval, no team.

`e01`: (a) an agent commit in `graft-e2e/` and its PR → `graft/policy` `failure`; (b) the outsider approves → `success`; (c) the actor pushes a second commit → `failure` (stale approval); (d) the actor adds `graft:break-glass` → `success`, and `pnpm graft audit list --repo <sandbox>` (in process, read-only) shows an `applied` row; (e) the actor pushes again → `failure`. Each step waits for the check on the new head. **INV-1E** replaces INV-1: every Graft check on the current head of each open run PR is completed, `graft/provenance` and `graft/intent` are `neutral`, and `graft/policy` is `success` or `failure`, as the scenario last expected. Afterwards roll the sandbox back: `pnpm graft mode set --repo <sandbox> --policy report --reason "e2e done"`.

Guard and MCP enforce scenarios are not built: the sandbox has no CI by design, and MCP needs a token the runner must not hold. They stay manual checks in [HUMAN-TODO](../phase-1/HUMAN-TODO.md).

## 8. Read the report

`e2e-runs/<runId>/report.md` has, in order: the header (mode, sandbox, Graft commit, duration, cost against the limit), the summary table, one section per scenario with an expected-versus-observed table (kinds: **system** always fails, **model** fails unless `--lenient-model`, **soft** only warns) and its invariants, the assumptions table, the sentinels, the HUMAN-TODO items that can be ticked, what was skipped, and one line of next steps per failure type. `report.json` is the same in a stable schema. `--capture` also saves redacted API exchanges and webhook payloads under `capture/`.

## 9. After 65 minutes

Webhook payloads live in pg-boss for one hour after their job finishes, so a sentinel in a `github.webhook` job is only "accounted for" until then. Wait 65 minutes after the last delivery, then:

```sh
pnpm graft e2e verify --after-retention          # refused before 3,900 s; remaining github.webhook jobs now fail
pnpm graft e2e report --update-human-todo        # see below: ticks what the run proves, annotates the rest
git diff docs/phase-0/HUMAN-TODO.md              # then commit the updated file
```

Only items that *are* a check are ticked: `s2-performed-via`, `s3-model-access`, `s3-outputs` (needs the `--wait-cron` run), `s5-check-github` and `s6-redelivery`, each when every assumption mapped to it passed. Items that are a deployment or pilot action (`s1-install`, `s5-events`, `s6-backfill`, `s6-retention`, `s6-baseline-github`) keep their box: the sandbox run only adds "Observed in sandbox on <date> (live e2e run <id>; assumptions ...); the action above is still to do".

## 10. Clean up

```sh
pnpm graft e2e cleanup --run-id <runId> --yes    # or --all
```

It closes the run's open pull requests and issues (found by label, title prefix and head branch prefix, all three) and deletes only `heads/graft-e2e/<runId>/*`. It never touches `main` and never deletes a repository. Running it twice does nothing the second time.

## 11. When something fails

Each failure type of the report's "Next steps" has a subsection.

### preflight
One line names the check: `ci`, `confirm`, `env_tokens`, `actor_token`, `actor_owner`, `outsider_token`, `sandbox_exists`, `sandbox_renamed` (GitHub answered under another name: the repository was renamed or moved; fix `e2e/sandboxes.json` only after checking it is still the sandbox), `sandbox_marker`, `app_installation`, `installation_scope`, `database`, `migrations`, `installation_rows`, `readyz`, `stale_jobs`, `policy_drift`, `actor_agent`, `open_prs`, `lock`. Fix that one thing: unset `CI`; remove a `GRAFT_E2E_*` line from `.env`; install the App on the sandbox only (`installation_scope`: not "All repositories", no other repository); run `pnpm db:migrate`; start the server and worker; run `setup --yes` to restore `graft.yaml`; remove the actor's login from `GRAFT_AGENT_LOGINS`; run `cleanup`; delete a stale `e2e-runs/.lock` only if no runner is alive.

### guard_refusal
A request was refused before it was sent. This is the safety net working: read the route in the message. If you pointed `--sandbox` at a real repository, stop and fix the command; never edit `e2e/sandboxes.json` to add one.

### no_delivery
No `webhook_deliveries` row within 90 seconds. Check that `pnpm tunnel` is running with the App's hook URL, that the App is subscribed to `check_run`, `pull_request`, `pull_request_review` and `push`, and GitHub's "Recent deliveries" page for the App.

### signature
The server log shows `invalid_signature`: `GITHUB_WEBHOOK_SECRET` differs from the App's webhook secret.

### card_timeout
No card within 10 minutes (2 in mode `none`): is the worker running, is the model slow, is the daily budget used up (`GRAFT_LLM_DAILY_TOKEN_BUDGET`)? Look at the worker log and `pnpm graft pilot doctor`.

### llm_failure
The first card was unavailable for a reason other than a missing key (`llm_auth`, `budget_exceeded`, `llm_timeout`, ...). The report shows `failure_reason`. Fix the key or the budget and rerun with `--run-id <id>` or a new run.

### neutral_violation
A Graft check run is not `neutral` (INV-1). Phase 0 enforces nothing, so this is a bug: stop, keep the report, and report it.

### comment_ownership
A01 or A02 failed, or INV-2 found no comment of ours: GitHub's comment response lacks `performed_via_github_app`. Set `GITHUB_APP_SLUG` (the `<slug>[bot]` fallback) and review decision D13 with the product owner.

### sentinel_leak
A planted sentinel is in a table or column where Graft must never write it (INV-3). This is a privacy bug: stop, keep the report (it names the table and column, never the text), and purge with `pnpm graft pilot purge` if needed.

### doctor
`pilot doctor` returned a FAIL or an unexpected WARN (INV-4). Run `pnpm graft pilot doctor --installation <id>` and read the failing check.

### permission_403
A08: the permission endpoint answered 403. Raise it with the product owner before adding any permission to the manifest.

### rate_limit
The runner waits for GitHub's rate limit up to 15 minutes and sends at most 3,000 requests per client. Wait for the reset or run fewer scenarios.

### model_mismatch
A model assertion failed (risk class bounds, verifier verdict). Look at the card on GitHub. Prompt work goes through `pnpm eval`, never by editing expectations; use `--lenient-model` only to finish a run.

### budget
The plan's cost bound exceeds `--max-cost-usd`, or a scenario was skipped for it. Raise the limit deliberately.

## 12. Never

- Never run the runner in CI, on a schedule, or from an agent.
- Never put a token, a `GRAFT_E2E_*` variable or an actor token value in `.env`.
- Never point `--sandbox` at a real repository (`mmornati/ai-running-coach` and every `source` are refused anyway).
- Never export the actor token in the terminals that run the server, worker or tunnel: only the runner's terminal needs it.
- Never share the smee URL: anyone who holds it reads the webhook payloads.
- Never delete the guard, the marker file or the label to "make a run work".
