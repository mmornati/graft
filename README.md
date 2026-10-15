# Graft

Graft is a GitHub App and service that adds intent review and policy checks to agent-written pull requests. This repo holds the service; step 1 is the base skeleton (webhook intake, job queue, installation tracking) and step 2 adds provenance (who wrote each PR, shown in a check run and the managed PR comment) and step 3 adds the intent service (a model-written intent card per PR, checked by a second model call and a rule-based risk floor); step 4 adds the evaluation set (`pnpm eval`: case format, encrypted private storage, export, labeling, harness, metrics, a synthetic CI set).

See the [MVP spec](docs/spec/mvp-spec.md), the [development plan](docs/plan/development-plan.md) and the [Phase 0 steps](docs/phase-0/README.md).

## 1. Prerequisites

- Node 24 (`.nvmrc`), pnpm 11
- Docker (OrbStack works) for Postgres

## 2. Quick start (offline)

Only `pnpm install` and the Docker image pull need the network.

```sh
pnpm install
pnpm db:up                       # Postgres 17 on localhost:55432
cp .env.example .env
openssl genrsa -out dev.pem 2048 # throwaway key so the server boots without a real App
pnpm db:migrate
pnpm dev:server                  # terminal 1
pnpm dev:worker                  # terminal 2
pnpm webhook:send installation.created --delivery smoke-1   # 202 {"status":"enqueued"}
pnpm webhook:send installation.created --delivery smoke-1   # 200 {"status":"duplicate"}
psql postgres://graft:graft@localhost:55432/graft \
  -c 'select id, account_login from installations' \
  -c 'select id, full_name, removed_at from repositories'
curl localhost:3000/readyz
```

`.env.example` already points `GITHUB_APP_PRIVATE_KEY_PATH` at `./dev.pem`. Neither process runs migrations; if the schema is behind they exit with `run pnpm db:migrate`.

Other scripts: `pnpm db:status`, `pnpm db:rollback` (reverts only the latest migration), `pnpm format`, `pnpm build` then `pnpm start:server` / `pnpm start:worker`.

## 3. Tests

```sh
pnpm test:unit          # nothing needs to be running
pnpm db:up && pnpm test:integration   # real Postgres + real pg-boss
pnpm test               # both
```

Integration tests use `TEST_DATABASE_URL` (default `postgres://graft:graft@localhost:55432/graft_test`). `test/global-setup.ts` drops and recreates `graft_test` on every run, then migrates. If Postgres is not reachable it fails with `Postgres not reachable at <host:port>; run pnpm db:up`. A network guard (`test/setup.ts`) makes any `fetch` to a non-localhost host throw, and GitHub is only ever reached through injected fakes. Test names carry the IDs from the step spec (`U-WH-3`, `I-INST-5`, ...), so `grep -rn "I-WH-" test/` finds them.

Fixtures in `test/fixtures/webhooks/` come from `@octokit/webhooks-examples`, rewritten to one fictional world (`scripts/generate-fixtures.ts`).

## 4. Connecting a real GitHub App

1. Edit `github/app-manifest.json` (name, `url`, `hook_attributes.url`). Create a channel at <https://smee.io/new> and use its URL as the hook URL.
2. Serve `github/register-app.html` (for example `cd github && python3 -m http.server 8080`, then open <http://localhost:8080/register-app.html>), enter the org name and submit. GitHub redirects to `redirect_url` with `?code=...`.
3. Convert the code: `gh api -X POST /app-manifests/<code>/conversions`. The response has the App `id`, `pem` and `webhook_secret`.
4. Put the PEM in a file outside the repo and fill `.env`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`; also set `SMEE_URL`.
5. Run `pnpm tunnel` (smee) next to `pnpm dev:server` and `pnpm dev:worker`, then install the App on a sandbox org.

`gh webhook forward` does **not** work for GitHub App webhooks (it only supports repository and organization webhooks). Use smee, or ngrok / cloudflared pointed at `http://localhost:3000/webhooks/github`.

## 5. Architecture

```
GitHub ──POST /webhooks/github──▶ server (Fastify)
                                   │ verify HMAC → INSERT webhook_deliveries ON CONFLICT DO NOTHING
                                   │ + send `github.webhook` job (same transaction)
                                   ▼
                              Postgres (app tables + pgboss schema)
                                   ▲
worker (pg-boss) ── github.webhook job ──▶ handlers registered by modules
```

**How later steps plug in.** Each feature is a folder `src/modules/<name>/` whose `index.ts` exports `webhookHandlers: WebhookHandler[]` and `jobs: JobDefinition[]`. `src/app/registry.ts` is the only file that lists modules. Step 2 added `modules/changes` (the `changes` row and its guarded upsert; store only, no handlers) and `modules/provenance` (trailers, handlers, the `provenance.refresh` job). Step 3 added `modules/intent` (handlers, the `intent.generate` job, card generation, rendering, feedback) and `src/llm/` (the model-client interface, the Anthropic client, the fake). Expected additions: `eval/` with `src/bin/eval.ts` (step 4), `modules/policy` (step 5), `modules/pilot` with `scripts/pilot/` (step 6), and `src/mcp/` (Phase 1). Modules import from `config`, `core`, `db`, `github`, `queue` and `webhooks`. They import another module only through its `index.ts`, never its internals.

**Contracts.**

- Webhook handlers must be idempotent, because a failed job retries every handler for that delivery. They must also be fast: DB writes, or enqueueing a follow-up job with `ctx.queue.send(...)`. Slow work such as LLM calls or many GitHub API calls goes into its own `JobDefinition`.
- Deliveries can be processed out of order and concurrently (`WORKER_CONCURRENCY`, retries with backoff, and GitHub itself does not order them), so handlers must tolerate reordering. For order-sensitive state, compare the head SHA or the payload's timestamp and ignore stale events, or use a `key_strict_fifo` queue keyed by installation or PR. Step 1's installation handlers are idempotent but not order-proof (for example a late `added` after `deleted`).
- Code that would persist file contents, diffs or patches does not pass review. Only paths, SHAs, numbers and model prose go in the DB.

**LLM contract (step 3).**

- Modules never build model clients; they use `ctx.llm` (`LlmClient`, `src/llm/types.ts`). `complete()` **returns** a result for every API outcome (timeout, rate limit, refusal, bad JSON, no API key, ...) and throws only on programmer errors, so failure paths are easy to fake and test.
- No prompt, diff, PR title or body, issue text or raw model output is ever logged, put in job data, or stored as such. Logs carry metadata only (model, purpose, token counts, duration, outcome). The DB holds paths, SHAs, numbers and the model's own prose (goal, behavior changes, reasons), nothing else. `test/unit/log-hygiene.test.ts` and I-INT-5 enforce this.
- Token usage is logged per call and stored per card (`intent_cards.input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `llm_calls`, which describe the last run that produced the row); the daily per-repository budget is computed from the append-only `intent_spend` ledger (one row per model run), not from the card rows.
- The system prompt is sent with `cache_control: ephemeral` and is stable per `PROMPT_VERSION`; the volatile diff comes after it.
- All tests use the fake LLM (`src/llm/fake.ts`) or the real client with an injected `fetch`. No test reaches the Anthropic API.
- Model text reaches markdown only through `escapeProse` and `codeSpan` (`src/github/markdown.ts`).

**Feedback (step 3).** Reviewers rate each intent card in two ways. (a) 👍/👎 reactions on the managed comment: GitHub sends no webhook for them, so a scheduled sweep (`intent.feedback.sweep`, cron `GRAFT_FEEDBACK_POLL_CRON`, default every 15 minutes, run by the worker only) enqueues `intent.feedback.poll` for open PRs and recently closed ones, which lists the comment's reactions. A reaction is attributed **by time** to the card that was displayed when it was made (the card with the greatest `published_at` not after the reaction), because one comment shows a series of cards. (b) The buttons "Card is accurate" and "Card is wrong" on the `graft/intent` check run (`requested_action` webhook) belong to exactly the card whose id is in the check run's `external_id`. One vote is stored per `(card, user, source)`; the effective vote per `(card, user)` is the latest across sources; bots are ignored; `is_pr_author` is recorded, and `feedbackSummary` leaves PR authors out by default. **Exception to the payload rule:** the `requested_action` handler only enqueues `intent.feedback.record`, and that job confirms the check run through `checks.get` (our app, name `graft/intent`, an `external_id` that is a card of this repository) but takes the voter and the button from the payload. Residual risk: a replayed captured body can re-assert the same vote, but cannot create a vote for another user.

**Managed PR comment.** Graft keeps exactly one comment per PR, created once and then updated in place (it is not pinned through the API). The contract lives in the doc comment of [`src/github/managed-comment.ts`](src/github/managed-comment.ts), which steps 3 and 5 reuse:

- The body starts with `<!-- graft:managed-comment v1 -->`, then `## Graft`, then one block per section, `<!-- graft:section:<name>:start -->` ... `<!-- graft:section:<name>:end -->`, in the order `intent`, `provenance`, `policy`; unknown sections found in an existing body are kept verbatim after them. A `<sub>` footer closes it.
- Each module writes only its own section through `upsertManagedSection`; every other section is preserved byte for byte. Section markdown may not contain `<!-- graft:` and is capped at 20,000 characters.
- Finding the comment: the stored `changes.graft_comment_id` if it still exists and is ours, else the first of the PR's comments that is ours, else a new comment. **Ours** means the marker is the first line **and** `performed_via_github_app.id` equals `GITHUB_APP_ID`. Because D13 (that field being present on REST comment responses) is unverified against real GitHub, there is a fallback: when `GITHUB_APP_SLUG` is set, a comment authored by the bot login `<slug>[bot]` (type `Bot`) with the marker also counts. A human pasting the marker is never adopted.
- **`withChangeLock(db, changeId, fn)`** (`src/db/locks.ts`): every writer of the managed comment or of per-change GitHub output (check runs) must hold this per-change advisory lock, and must store the comment id in `changes.graft_comment_id` inside the same transaction. The lock is a transaction that holds a pooled connection while requests are in flight, so **do no slow work (LLM calls, diff fetches) inside `withChangeLock`; compute first, then lock, re-check freshness (head SHA and `pr_updated_at`) and publish.**
- **`PermanentJobError(message, reason)`** (`src/queue/errors.ts`): a job throws it when a retry cannot help (deleted PR, lost permission, repo mismatch). The worker logs it and completes the job. `toJobError` in `src/github/errors.ts` maps Octokit errors: 404/410/401/non-rate-limit 403/422 are permanent; 429, rate-limit 403 and 5xx/network errors are retried. It never returns the original error: Octokit errors carry the request body (a rendered card is model output) and pino and pg-boss serialize it, so `sanitizeError` (`src/queue/errors.ts`) rebuilds them as metadata only (name, short message, status, method, route template, request id). The worker sanitizes again before logging and rethrowing, so a job's `pgboss.job.output` and the logs never hold request or response bodies (I-E2E-4).

**Webhook replay.** The webhook HMAC covers only the body, so `X-GitHub-Event` and `X-GitHub-Delivery` are unauthenticated: anyone holding one captured signed body can replay it under a new delivery ID (bypassing the `webhook_deliveries` dedup) or under another event name. Mitigations: (1) a payload is only a **trigger**: `pull_request` and `check_run` handlers validate the payload and enqueue a job, nothing else; the job re-fetches the PR from the API and writes only what the API returned (it also checks the PR number and repository id); (2) every handler parses its payload with a zod schema (`parsePayload`, logging issue paths only) and returns on a mismatch, which catches a relabeled event; (3) replays converge: the same body under a fresh delivery ID yields the same job dedup key, so no job is created within 7 days, and a later or stale replay only refreshes live state. **The rule for later steps: handlers treat payloads as triggers; jobs write only from API data or from data Graft computed.** Residual risk: an attacker with a captured body can force extra GitHub API calls after the 7-day window, but cannot forge state. A replayed `check_run.rerequested` body is bounded to one re-run per PR per minute: the key is `prov-rerun:{repoId}:{pr}:{floor(now/60000)}` (and `intent-rerun:...` for the intent check), so a flood of fresh delivery IDs enqueues at most one refresh per PR per minute. The work is idempotent and never forges state; only cost is at stake.

Layout: `src/config` (env), `src/core` (clock, logger, context), `src/db` (Kysely, migrations), `src/queue` (pg-boss wrapper, worker), `src/webhooks` (receiver, registry, dispatch job), `src/github` (Octokit factory, the only place an Octokit is built; managed comment; markdown safety), `src/llm` (model clients: the only place an Anthropic client is built), `src/http`, `src/modules`, `src/eval` (the evaluation tool, step 4: a tool, not a module; it imports Graft code only through `modules/intent/index.ts`, `modules/provenance/index.ts`, `modules/changes/index.ts`, `src/llm`, `src/github/client-factory.ts` and `src/github/errors.ts`, never `db`, `queue`, `webhooks`, `http` or `config`), `src/bin` (entry points, including `eval.ts`), and at the repo root `eval/` (JSON Schemas, the synthetic set, the saved baseline and the thresholds). `src/db` imports nothing from `src/modules`.

## Provenance trailers for agents

Graft works out who wrote a PR from `Graft-*` git trailers in its commits, with the PR description as a fallback. Agents add them with `git commit --trailer`:

```sh
git commit -m "Fix the retry loop" \
  --trailer "Graft-Agent: claude-code" \
  --trailer "Graft-Model: claude-sonnet-5-5" \
  --trailer "Graft-Task: #42" \
  --trailer "Graft-Session: https://claude.ai/code/session/abc"
```

| Key | Value rule |
| --- | --- |
| `Graft-Agent` | `[A-Za-z0-9][A-Za-z0-9 ._:/@+()-]{0,99}` |
| `Graft-Model` | `[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}` |
| `Graft-Task` | `[A-Za-z0-9#][A-Za-z0-9._:/#@+-]{0,127}`; `#42` links issue 42 of the repo |
| `Graft-Session` | an `https` URL, at most 2,048 characters, no credentials, a plain LDH hostname (letters, digits, hyphen, dots; at least two labels; no IP, no `localhost`); `( ) [ ] \| \ `` ` `` `*` are percent-encoded |

Keys are case-insensitive. The trailers must be in the last paragraph of the message (git `interpret-trailers` rules, simplified; the subject alone never counts). A value that fails its rule is ignored and listed as a warning (the warning never repeats the value). **Precedence:** per field, the newest commit with a valid value wins, then older commits, then the PR description (same trailer syntax, last paragraph). If values disagree, the newest wins and all distinct values are shown. **Agent or human:** a PR is agent-authored if any of these holds, in this order: a resolved `Graft-Agent`; the PR author is a GitHub Bot account; the author login is in `GRAFT_AGENT_LOGINS`; a commit has a `Co-authored-by` with an email in `GRAFT_AGENT_COAUTHOR_EMAILS` (default `noreply@anthropic.com`, Claude Code's). Otherwise it is human. Graft stores parsed `Graft-*` values only; commit messages and e-mail addresses are read in memory and never stored.

## Intent cards

For every open PR, Graft writes an **intent card** into the `intent` section of the managed comment and into a `graft/intent` check run (always `neutral` in Phase 0). Reviewers read the card instead of the PR description. It holds:

- **Goal**: one sentence stating what the diff does.
- **Behavior changes**: observable effects, most important first.
- **Out-of-scope edits**: files the goal does not explain (from the writer, plus any the verifier flags).
- **Risk**: `trivial`, `logic` or `sensitive`, shown with where it came from (`rules`, `writer`, `verifier`).

**How it is made.** A writer model reads the PR title and description, the linked issue (`Fixes #N`, the `Graft-Task` issue, or the first `#N`), the file list and the diff. A second call, the verifier, sees the diff, the file list and the card, but **not** the title, description or issue, and checks every claim. The PR description comes from the agent being judged, so it is untrusted input: it is wrapped in nonce-tagged data blocks, the prompts say it is data, and injection markers raise the floor.

**Risk classes and the floor.** The final class is `max(floor, writer, first pass, verifier, logic if the verifier disagrees or fails, logic if injection is suspected)`. **The model can only raise the class, never lower it.** The floor comes from fixed rules over each file's path (and previous path, so renames count both ways), case-insensitively:

| Floor | Rule |
| --- | --- |
| `sensitive` | CI and repository config (`.github/workflows/**`, `CODEOWNERS`, ...); `graft.yaml`; dependency manifests and lockfiles; infrastructure and deployment files; auth, security, crypto and secrets paths; migrations and schema files; paths in `GRAFT_INTENT_SENSITIVE_PATHS`; a deleted test; more than 1,500 changed lines or 50 files; a PR too large to list; an incomplete file list |
| `logic` | a test that lost 10 or more lines; an added binary; more than 300 lines or 15 files; part of the diff not shown to the model (truncated, generated, no patch); text addressed to AI reviewers |
| `trivial` | nothing above matched |

Without a checked card (no API key, model down, budget used up) the risk is at least `logic`, and the card says why.

**"The verifier disagrees"** means that at least one claim on the card was not supported by the diff (unsupported or contradicted), or that the verifier found observable behavior changes the card does not mention. The comment then shows a warning listing them, and the risk is at least `logic`. "Not verified" means the verifier call failed.

**Rating a card.** Click 👍 or 👎 on the Graft comment, or press "Card is accurate" / "Card is wrong" on the `graft/intent` check. Reactions are picked up within 15 minutes. One vote counts per user and card, and the latest wins. The data feeds the 90% accuracy gate.

**Sensitive paths.** Add globs (comma-separated, for example `services/billing/**,**/payments/**`) to `GRAFT_INTENT_SENSITIVE_PATHS` now; from step 5 `graft.yaml` will extend the list. A glob without `/` matches at any depth; a leading `/` anchors it at the repository root.

**Without an API key** (`ANTHROPIC_API_KEY` unset) the service runs and every card shows as unavailable with the rule-based floor.

## Evaluation set

`pnpm eval <command>` measures the quality of the intent cards against hand-labeled pull requests and runs a synthetic set in CI. Nothing here changes the service: the tool lives in `src/eval/` and `src/bin/eval.ts`, never touches Graft's database and never writes into the repo (except the committed synthetic set and its baseline).

```sh
pnpm eval keygen                                   # new GRAFT_EVAL_KEY; keep it in the password manager, never in .env
export GRAFT_EVAL_KEY=...                          # the shell only
pnpm eval init --set ~/.graft-eval/pilot-acme --kind pilot --consent-ref "Acme agreement 2026-11-02" \
     --sensitive-paths 'services/billing/**'
pnpm eval export --set ~/.graft-eval/pilot-acme --repo acme/api --from 2026-06-01 --to 2026-09-30 \
     --auth app --installation-id 123 --sample 50 --dry-run      # drop --dry-run to write the cases
pnpm eval assign-double --set ~/.graft-eval/pilot-acme                # 20% (at least 20) get two labelers
pnpm eval label --set ~/.graft-eval/pilot-acme --as ada               # blind, interactive
pnpm eval agreement --set ~/.graft-eval/pilot-acme                    # Cohen's kappa; target risk >= 0.6
pnpm eval adjudicate --set ~/.graft-eval/pilot-acme --as judge
pnpm eval run --set ~/.graft-eval/pilot-acme                          # fake model: floor + a model that says "trivial"
pnpm eval run --set ~/.graft-eval/pilot-acme --live                   # the only way to reach the Anthropic API
pnpm eval purge --set ~/.graft-eval/pilot-acme --confirm pilot-acme   # when the pilot leaves
pnpm eval:ci                                       # the synthetic set against eval/baselines/synthetic.json
```

Run `pnpm eval` with no command for `run`; `pnpm eval frobnicate` prints the usage. Exit codes: 0 ok, 1 check failed, 2 usage or configuration error, 3 aborted (declined, over budget, rate-limit wait too long).

**Where the data lives.** A case set is a directory (`set.json`, `cases/`, and for pilots `cache/` and `runs/`). The committed synthetic set is `eval/synthetic/` (plaintext, fictional code only). A pilot set is `$GRAFT_EVAL_DIR/<setId>/` (default `~/.graft-eval`) and must be outside every git working tree: the tool walks up from the real path and refuses when it finds a `.git` entry. Files are written with mode 0600 and directories with 0700. Every file in a pilot set except `set.json` and the reports is a sealed AES-256-GCM envelope (`node:crypto`; a fresh random IV per write; the authentication tag is verified before any plaintext is returned; the AAD is `<setId>/<relative path>`, so a file moved to another set or renamed does not open). `GRAFT_EVAL_KEY` is the base64 of 32 random bytes; `set.json` stores only the first 8 hex characters of its SHA-256, to detect a wrong key early. Creating a pilot set needs `--consent-ref`, and `export` refuses a set without one. `purge` deletes the directory and appends `{setId, purgedAt, caseCount, by}` to `purge-log.jsonl`.

**Reports carry no code.** `report.json` and `report.md` (written to `<set>/runs/<runId>/`, or `--out`) hold case ids, classes, rule ids, counts, booleans, tokens and cost, never paths, titles, bodies, diffs or model prose. `pnpm eval show --set <dir> --case <id>` is the local way to read a case; everything it prints goes through `toTerminalSafe` because PR text may hold terminal escape sequences.

**Live runs.** `--live` needs `ANTHROPIC_API_KEY`; without `--live` the key is ignored and the Anthropic client is never built. Before the first call the tool prints an upper-bound estimate and asks `Continue? [y/N]` (`--yes` skips the question; without a terminal and without `--yes` it exits 3). It refuses an estimate above `--max-cost-usd` (default 10), starts a case only if the money and tokens spent so far plus the estimate stay under `--max-cost-usd` and `--max-tokens` (the rest are `skipped_budget` and the report says `complete: false`), and caches results by (inputs, prompt fingerprint) in `<set>/cache/`. Prices are in `src/eval/pricing.ts` (`PRICING_VERIFIED_AT`); check them before a live run.

**Updating the synthetic baseline.** `pnpm eval:ci` compares the whole fake-model report (metrics and per-case rows) with `eval/baselines/synthetic.json` and checks `eval/thresholds.json`. A change to the floor, `combineRisk` or a synthetic case shows up as a diff; when it is intended, run `pnpm eval run --set eval/synthetic --save-baseline eval/baselines/synthetic.json` in the same pull request. The JSON Schemas in `eval/schema/` are generated from the zod schemas (`pnpm eval schema --write`) and a test fails when they drift. The labeling guide is `docs/phase-0/labeling-guide.md`.

## 6. GitHub App permissions

`github/app-manifest.json` is the source of truth; `test/unit/manifest.test.ts` pins it. Changing a permission means updating the test and this table together.

| Permission / event | Level | Phase 0 use |
| --- | --- | --- |
| `metadata` | read | Mandatory for every App; repository listing. |
| `contents` | read | Read `graft.yaml` (step 5) and commit data for trailers (step 2); `git.getCommit` for the head commit when a PR has more than 250 commits. |
| `issues` | read | Read the linked issue for the intent writer (now used, step 3). No write: comments go through `pull_requests: write`. |
| `pull_requests` | write | Read PRs, files, diffs, commits and reviews (steps 2, 3, 6); list PR commits (step 2); list PR files and patches (step 3); list comment reactions (step 3). Write is only for creating and updating the pinned card comment, since the issue-comments API accepts `pull_requests: write`. |
| `checks` | write | Create `graft/provenance` (step 2), `graft/intent` with Accurate/Wrong buttons (`requested_action`, step 3) and `graft/policy` check runs (step 5). |
| `pull_request` event | — | Trigger provenance, intent and policy on opened, synchronize, reopened, edited and closed. |
| `check_run` event | — | `rerequested` re-runs our checks; `requested_action` delivers the card buttons (step 3). |
| `installation`, `installation_repositories` | — | Delivered to every App without a subscription; drive the installations module. |

**Deferred** (not requested in Phase 0):

- `members: read` (team approvals, Phase 1).
- `contents: write` (revert branches and PRs, Phase 1).
- `statuses: read` and `actions: read`, plus the `push`, `status`, `workflow_run` and `check_suite` events (post-merge guard, Phase 1).
- The `pull_request_review` event (approval counting, Phase 1).
- `administration`: never.

Comment reactions have no webhook; step 3 polls them every 15 minutes using `pull_requests: read`.

## 7. Decisions and library versions

Choices from the step spec: Node 24 ESM, strict TypeScript (NodeNext, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `tsx` for dev, Biome for lint and format, Vitest with `unit` and `integration` projects, Fastify, Kysely with `pg` and a static migration provider, `pg-boss` in schema `pgboss`, `pino` with redaction, Postgres 17 on port 55432, GitHub numeric IDs as `bigint` keys (parsed to `number`, throwing above 2^53), `smee-client` for the dev tunnel.

Versions in the lockfile (majors): Fastify 5, Kysely 0.29, pg 8, **pg-boss 12**, pino 10, zod 4, `@octokit/app` 16, `@octokit/rest` 22, `@octokit/webhooks` 14, `@octokit/webhooks-methods` 6, `@octokit/webhooks-examples` and `-schemas` 7, TypeScript 7, Vitest 5, Biome 2, tsx 4, ajv 8, smee-client 5.

### Deviations and additions relative to the step spec

- **pg-boss is v12, not v10.** The assumed API held with these differences: queue and job retry delay is `retryDelay` (seconds), not `retryDelaySeconds` (our `JobDefinition.options.retryDelaySeconds` is mapped to it); retention is `deleteAfterSeconds` (set to 7 days on every queue); `work()` takes `{ localConcurrency, batchSize }` and a handler over `Job[]`; the transaction option is `db` with an `executeSql(text, values)` adapter (type exported as `Db`), which is what `createPgBossQueue` builds from a Kysely transaction. `start()` installs/migrates its own schema, so the server and worker both call it. Defaults when a job sets no options: `retryLimit 5`, `retryBackoff true`, `retryDelay 10`, `expireInSeconds 300`. They are applied as queue options in `createQueue`. Queue options are re-applied with `updateQueue` on every start, because `createQueue` does nothing for an existing queue (I-Q-3).
- **`singletonKey` does not deduplicate on pg-boss v12 standard queues.** Since v10 the key is only enforced by queue policies `short`, `singleton`, `stately`, `exclusive`, `key_strict_fifo` (or together with `singletonSeconds`); on our `standard` queues it is stored and ignored. `JobQueue.send(..., { singletonKey })` therefore also sets a deterministic job `id` (UUIDv5-style SHA-1 of job name and key; `singletonJobId` in `src/queue/queue.ts`). pg-boss inserts with `ON CONFLICT DO NOTHING`, so a second send with the same name and key inserts nothing and `send` returns `null` (I-Q-2). **The window covers queued, active, completed and failed jobs until they are deleted, 7 days after completion or failure (`deleteAfterSeconds`).** A caller that needs a re-run (for example a `check_run.rerequested` for the same SHA) must use a different key, such as one that includes an attempt number or a timestamp. A `null` return means "already enqueued". For webhooks the `webhook_deliveries` primary key is the first line of defence; if the job send returns `null` (job exists, delivery row gone) the existing job id is stored and the outcome is `duplicate`.
- **Empty body returns 400 before signature verification** (spec deviation: the spec has no empty-body rule). It is a cheap check that needs no secret and touches no state; GitHub never sends an empty body (U-WH-8). A delivery id over 100 characters also returns 400 (U-WH-7).
- **Permanent failures are retried** up to `retryLimit`; a non-retryable error type is deferred to a later step. Job data validation runs inside the logged `try`.
- **Kysely 0.29** exports `Migrator` from `kysely/migration`.
- **zod 4**: `z.ZodType<T>` works as in the spec; config defaults are applied before validation (string form).
- **Fastify 5.12**: `disableRequestLogging` is deprecated in favour of `LogController`, which `buildServer` uses (request logging is off; the receiver logs its own outcome line).
- **`githubWebhookJob` is built by a factory.** The job needs the registry's handler lookup and the registry lists the job, so `createRegistry` builds it with `createGithubWebhookJob(registry)` and exposes it as `registry.webhookJob` (also present in `registry.jobs`). The receiver sends `registry.webhookJob`.
- `createPgBossQueue` returns `PgBossJobQueue` (a `JobQueue` plus the `boss` instance the worker needs) and takes a `supervise` flag (false for the server, true for the worker). `buildServer` is `async` and returns the instance without listening.
- Store functions (`getActiveRepository`, `listActiveRepositories`, ...) take a Kysely `Db` or `Transaction` as their first argument.
- Extra files not in the layout: `src/bin/bootstrap.ts` and `src/bin/env.ts` (shared wiring), `scripts/generate-fixtures.ts` (how the fixtures were produced), `pnpm-workspace.yaml` (pnpm 11 build-script allowlist for esbuild), `test/helpers/app.ts`, `test/helpers/stubs.ts`.
- The upstream webhook examples are older than `@octokit/webhooks-schemas` and contain no merged `pull_request.closed`; the generator repairs missing required fields with neutral values and marks the closed PR as merged so all fixtures validate (U-FIX-1).

### Step 2 deviations and additions

- **Library reality.** `@octokit/rest` 22 includes `paginate.iterator` (used for commits and comments; the iterator is stopped early after 3 and 10 pages). `checks.update` takes the check run id and no `head_sha`, so the PATCH body omits it. Nothing else differed from the spec's assumptions. pg-boss 12 only marks a failed job `retry` and bumps `retry_count` when it is next fetched, so I-Q-4 asserts the `retry` state, not the count.
- **D13 fallback (added).** New optional env `GITHUB_APP_SLUG` (`Config.githubAppSlug`). When set, a comment authored by `<slug>[bot]` (type `Bot`) that starts with the marker is accepted as ours when `performed_via_github_app.id` does not match. Without the slug the strict app-id check is the only check. Tested in U-MC-9, U-MC-10 and I-PROV-9. HUMAN-TODO has an item to confirm the field on real GitHub.
- **Dedup key carries `updated_at` and the action.** (Step 3 appended `:{action}`; see T18.) D6 as written would swallow any return to an earlier state within 7 days: `closed`/`reopened` after `opened`, a body edited X to Y to X, or a force-push H1 to H2 to H1 would all hit the key of a completed job, leaving stale provenance. The key is `prov:{repo}:{pr}:{head}:{base}:{bodyHash}:{pull_request.updated_at}` for all five actions, and `pull_request.updated_at` is required in the payload schema (a payload without it enqueues nothing). A replayed body has the same `updated_at`, so replay protection is kept. The cost is one redundant, idempotent job for a title-only edit (the comment comes back `unchanged`, the check run gets one PATCH).
- **In-lock staleness check.** Inside `withChangeLock` the job publishes only if the stored head SHA equals the live head and the stored `pr_updated_at` is not newer than the live `updated_at`. Otherwise two jobs on the same head with different bodies could publish the older body last (I-PROV-10b; the head-moved branch is I-PROV-10c). `updated_at` has one-second resolution, so two edits inside the same second cannot be ordered. The **next** event, or a Re-run of the check, refreshes the output; until then it can be one same-second change behind. The second window (a same-second change with an unchanged head and body, for example `closed` then `reopened`) is now closed by `action` in the dedup key. The title-edit plus close case remains: a title-only edit and a close inside one second share `updated_at`, head and body, and only the action tells them apart.
- **Session host is plain LDH (D14 hardening).** `validateSessionUrl` additionally requires every host label to match `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`, at least two labels, at most 253 characters (one trailing dot is tolerated and `localhost.` is rejected), because the hostname is the link text and WHATWG `URL` accepts `` ` * _ ~ ! $ & ' { } = `` in a host. `\`, `` ` `` and `*` are percent-encoded in the href. Trailer whitespace follows git (space and tab only), not JavaScript `\s`.
- **Output-size failures are permanent.** `upsertManagedSection` throws `PermanentJobError` (`invalid_output`) for a marker in the section or an oversize section or comment, instead of retrying a deterministic failure 8 times.
- **Order inside the lock.** The provenance job upserts the managed comment first and then the check run (T14 lists the check run first); the intent job publishes in the other order since step 4 (see "Step 4 deviations and additions"). This is what I-PROV-8 describes ("comment created, then the check-run POST fails") and it keeps the outcome identical: a failure rolls everything back and the retry adopts the existing comment (T8 3b).
- **Not applied snapshot returns early.** If `upsertChangeFromPull` reports `applied: false` (stored `updated_at` is newer), the job logs `stale` and stops before any commit fetch or publish. That is what I-PROV-3 requires; T14 does not say it.
- **`parseTrailerBlock` also returns `blockTooLong`** (P7 needs a way to reach the `block_too_long` warning); `ProvenanceResult` also carries `truncated` (the renderer needs it and `counts` cannot express it); `persistProvenance` also takes `repositoryFullName` (for the issue URL). When the text was cut from the front (P2) the single remaining paragraph is not treated as a subject.
- **Session URLs must be printable ASCII** (no non-ASCII at all, not even in the path), a stricter reading of "all character sets are ASCII". `|` is percent-encoded as well as `( ) [ ]`, because the URL is rendered inside a table cell (and see the LDH rule below).
- **Rendering of warnings without a field** (`unknown_graft_key`, `block_too_long`): `- <where>: trailer block ignored (<code>)`, or `unknown Graft key ignored (unknown_graft_key)` for an unknown key. When there are no trailers and the PR is truncated, the "no `Graft-*` trailers found" footer still gets the truncation sentence appended.
- **U-REN-7** uses the agent value `octo@bot/@team`: the spec's `@octo/bot` starts with `@`, which the agent character set rejects (a separate assertion checks that it is rejected and never rendered).
- **I-SEC-3** posts the `installation.created` body as `pull_request` twice: unchanged (the receiver ignores it, since the action `created` is not handled) and with `action: "opened"` so the handler really runs and logs `payload_shape_mismatch`.
- **`pnpm db:rollback` reverts one migration** (the latest), as T1 requires; in step 1 it rolled back everything. The test helper `migrateDown` still goes to zero.
- **Extras:** `getActiveInstallation` (installations store, exported) is the "installation exists and is not deleted or suspended" check used by the handlers and the job; `ProvenanceTable.source` gains `pr_body`; `changes.pr_updated_at` and `graft_comment_id` are optional on insert so step 1 tests compile unchanged; a `continue` instead of `return` lets the worker finish a batch after a permanent error (batch size is 1).

### Step 3 deviations and additions

- **Versions.** `@anthropic-ai/sdk` 0.133.0, `picomatch` 4.0.7, `@types/picomatch` 4.0.3 (dev; picomatch ships no types).
- **SDK verified against `node_modules` (T1).** Everything the spec names exists and behaves as assumed: the constructor options `apiKey`, `maxRetries`, `timeout`, `fetch` (and `baseURL`, used by the tests); per-request `{ timeout, maxRetries }`; `output_config: { effort, format: { type: "json_schema", schema } }` on the plain `messages.create` (effort is `low | medium | high | xhigh | max`); system text blocks with `cache_control`; `client.beta.messages.create` with `betas` and `fallbacks: "default"` (`server-side-fallback-2026-07-01` is a listed beta); `usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` (the cache counters can be `null`); `stop_reason` `"refusal"` and `"max_tokens"`; `response.model`; the error classes `APIConnectionTimeoutError`, `APIConnectionError`, `RateLimitError`, `InternalServerError`, `AuthenticationError`, `PermissionDeniedError`, `BadRequestError` and `APIError.status`. Detail the spec did not state: the beta call puts `betas` into the `anthropic-beta` header and adds `?beta=true` to the URL, while `fallbacks` stays in the JSON body (U-LLM-2 asserts exactly that). A 529 arrives as an `InternalServerError`-style `APIError` with status 529 and is retried by the SDK (U-LLM-10). Errors that are not `AnthropicError`s are rethrown as programmer errors.
- **pg-boss 12.38 verified (T1).** `schedule(name, cron, data?, options?)`, `unschedule(name, key?)`, `getSchedules(name?, key?)` and the constructor option `schedule: boolean` exist as named. `schedule` needs the queue to exist (the queue wrapper creates all queues in `start()`), calling it again for the same name replaces the cron (`unschedule` removes it), and the cron expression is only validated by pg-boss at `schedule()` time: `GRAFT_FEEDBACK_POLL_CRON` is checked for shape only (5 fields of digits, `*`, `/`, `,`, `-`), so a cron that passes the shape but is invalid stops the worker at startup. `JobQueue.unschedule` takes the job definition, like `schedule`.
- **The card JSON sent to the verifier escapes `<`** as `\u003c` (still valid JSON). Without it, a writer that echoes the nonce it saw could put a closing data tag into the card and break out of the data block. The spec says "`JSON.stringify` of the validated writer output"; the parsed JSON is identical.
- **Injection rule (R15) ignores format characters.** Before matching, `computeRiskFloor` removes Unicode `Cf` characters and the visible `[U+XXXX]` form that `neutralizeUntrusted` writes for them, so `ig\u200bnore previous instructions` still counts. The spec's patterns are unchanged.
- **Floor reasons.** `FloorReason.paths` holds at most 5 paths as specified, so the check output lists at most 5 per rule (the spec's "up to 50" is an upper bound). The injection reason has no paths and `count` is the number of matching texts; size and listing reasons have none and `count` 0 (the renderer takes line and file counts from `inputs`).
- **Classification order.** Lockfile, then binary, then generated, then "no patch from the API" (T9), implemented once in `classifyFile` (`risk-floor.ts`) and shared by the diff preparation and rule R10. Files beyond the 300th in priority order are summarised per top-level directory; files at the root fall under `"."`.
- **`InputStats.truncated`** is true when the listing is truncated, the PR is too large, or any file is partial (truncated, or omitted for a reason other than lockfile or binary).
- **Nonce seam.** `chooseNonce(canonical, untrustedBlocks, derive?)` in `diff.ts` takes the derivation function as an optional parameter; U-DIFF-10 uses it to force a k=0 collision.
- **A failed escalation keeps what is known.** If the fast writer answered and the strong re-write fails, the unavailable result still carries the first-pass class, its model and the instruction flag, so a first pass of `sensitive` is not lost.
- **Cached cards skip the pending note and the budget.** The cache check (step 5) comes before the outdated-section note (D11) and the budget check, so a cache hit makes no extra GitHub write and counts no tokens.
- **Card rows use the injected clock.** `saveCard` writes `created_at` and `updated_at` from `ctx.clock` (not the database default), so the daily budget and the tests follow the injected time.
- **`intent.feedback.sweep` data** is the empty object, validated strictly. The sweep reads owner and repo from `repositories.full_name`, skips removed repositories, and the poll job re-checks the installation.
- **Feedback summary `since`** applies to the effective vote's `reacted_at` (the vote that wins first, then the time filter).
- **Reactions** with a `null` user are dropped when read; reactions of any user type other than `Bot` count (`Mannequin` and `Organization` included).
- **Models in the card row** are `response.model` as returned by the API (often a dated id), not the requested alias.
- **Pure `generate.ts` exports** also `RETRYABLE` (used by the store to rebuild `retryable` from a stored row) and `EFFORTS`, `MAX_OUTPUT_TOKENS`.
- **Test changes outside the spec's list.** `test/unit/fixtures.test.ts` lists the new `check_run.requested_action` fixture (the generator reuses the upstream example and rewrites it); I-DB-7 now rolls back two migrations (0003 then 0002) because 0003 is the latest; I-CHG-6 uses a replay of `opened` for its first assertion because the action is now part of the key; U-RISK-13's "removed line does not match" half is tested at the card level (U-RISK-13c), because `computeRiskFloor` receives only the added lines; U-INJ-2 includes a file whose name tries to close the section from inside a code span, so that removing the `<!--` rewrite in `codeSpan` fails it. New helper files: `test/helpers/intent-inputs.ts` (pure builders) next to the specified `intent-scenario.ts`. `test/unit/log-hygiene.test.ts` (U-LOG-2) is an extra grep-style test that no logger call in `src/llm` or `src/modules/intent` mentions prompts, diffs, PR text or model output.
- **T18 follow-ups.** Done as specified: provenance re-run key `prov-rerun:{repoId}:{pr}:{minute}` (I-PROV-11), `:{action}` in `refreshKey`, `WarningCode` and `GraftField` moved to `src/db/schema.ts` (`fields.ts` re-exports them; `grep -rn "modules/" src/db/` finds nothing), I-PROV-10c isolated by clearing `changes.pr_updated_at` before the gate is released, and the README wording in the step 2 section. **Mutation check for I-PROV-10c:** with the in-lock head check removed from `provenance/job.ts` the test now fails (the same holds for I-INT-9 and `intent/job.ts`).
- **Mutation checks (DoD)** were run by hand and each made the named tests fail: removing the in-lock head check in `intent/job.ts` fails I-INT-9; dropping the floor term in `combineRisk` fails U-RISK-17, U-RISK-18, U-INJ-1 (and U-GEN-4, U-GEN-13, U-GEN-20); adding the PR text to the verifier message fails U-GEN-15; removing the `<!--` rewrite in `markdown.ts` fails U-MD-4, U-MD-9, U-INJ-2 and U-INJ-4.

### Step 3 review 1 changes

- **Spend is a ledger (D21 changed).** `intent_spend (repository_id, change_id, tokens, llm_calls, spent_at)` is append-only and `saveCard` writes one row per model run before the card upsert, so retries, re-runs, in-place regeneration of an `unavailable` row and a dropped concurrent `ok` save all count. `tokensUsedToday` sums the ledger for the UTC day (bounded on both sides), not `intent_cards.created_at`. The card's token columns still describe only the run that produced the row. Migration `0003_intent` (not yet committed) was edited in place; `TABLE_NAMES` now has 13 tables (I-DB-3 and I-DB-8 updated). I-INT-17, I-INT-18, I-INT-19; I-INT-11 seeds the ledger.
- **Displays are recorded (reaction attribution changed).** `intent_displays (change_id, card_id, status, shown_at, seq)` gets a row whenever what is on screen changes (another card, or the same card in another status), written in the publish lock with `ctx.clock.now()` taken right before `markPublished` (not the job start). Reactions are attributed to the display with the greatest `shown_at <= created_at`, so A, B, A credits later votes to A, and a reaction made while the "card unavailable" notice was shown is dropped. `intent_cards.published_at` keeps the first display only (the sweep still uses it, and `publishedCheckRunForHead`); `latestPublishedCard` (the D11 note) follows the latest display. `markPublished` takes `{ id, changeId, status }`. I-INT-20, I-FB-6, I-FB-7, I-FB-8, U-FB-7.
- **Retry notice (D9/D8 changed).** The retry job is queued before the publish and "Graft retries automatically" is rendered only when `send` returned an id. The retry key ended with the triggering `deliveryId` in step 3; since step 4 it ends with a 5-minute bucket (see "Step 4 deviations and additions"). A deduplicated send shows the "Re-run" text. I-INT-21, I-INT-22.
- **Total deadline (D6 changed).** `LlmRequest.deadlineMs` (the remaining job deadline) becomes an `AbortSignal.timeout` on the SDK request, so SDK retries and their backoff end at the deadline; the abort maps to `timeout`. The deadline starts at the job start (`GenerateOptions.startedAtMs`), so the listing time counts. U-LLM-12.
- **Fallback blocks (D5).** Only the text blocks after the last `fallback` block are the answer. U-LLM-11.
- **Feedback button guard.** The job data carries the payload's `check_run.external_id` (`externalId`, optional); a vote whose card differs from the check run's current `external_id` is rejected (`feedback_rejected`). I-FB-9.
- **Nits fixed.** Output strings made only of `Cf` characters are empty (U-OUT-7); R15 patterns use `\s+` between words (U-RISK-19); `GH-<n>` is broken with a word joiner (U-MD-11); `intentRepoSettings` takes `{ repositoryId, installationId, owner, repo, baseSha }` for step 5 (`LivePull.base.sha` is optional).
- **Nits not fixed.** Paths in R15 (spec change: file names like `ai-reviewer.md` would raise the floor on ordinary repositories). Pure rename classified `no_patch_from_api` (needs `diff.ts` to handle a file without a patch and a spec change to U-DIFF). "Up to 50 paths" in the check output (U-RISK-7 and the stored `FloorReason` shape fix the cap at 5; carrying a second list is a spec change).
- **I-E2E-3** now waits for both check runs as well as the comment: the comment contains both sections one request before the intent check run exists.
- **Review 1 mutation checks** (run by hand in a throwaway copy): dropping the ledger insert in `saveCard` fails I-INT-17, I-INT-18, I-INT-19; making `toJobError` return the original error and the worker log and rethrow the raw one fails I-INT-12 and I-E2E-4 (with only one of the two layers undone, U-GHE-4/U-GHE-5 or nothing fails, by design); taking the display time at the job start fails I-INT-20; recording a display only when none exists fails I-FB-6 and I-FB-7 (and I-FB-1, I-FB-2); ignoring the fallback block fails U-LLM-11; removing the abort signal fails U-LLM-12; always showing the retry text fails I-INT-21; removing the `external_id` guard fails I-FB-9; removing the in-lock head check in `provenance/job.ts` fails I-PROV-10c.

### Step 4 deviations and additions

- **Retry key (T17.1).** `intent-retry:{changeId}:{headSha}:{inputHash16}:{attempt}:{floor(nowMs / 300000)}`, with `nowMs` from `ctx.clock`. A pending-only singleton is not available on our `standard` queues (pg-boss 12), hence the bucket: two triggers for the same inputs within five minutes queue one retry, and a later failure in a new bucket queues its own even when an earlier chain completed. The comment above the send in `job.ts` says so. I-INT-21 now moves the clock by one bucket for its last step (a different delivery in the same bucket is deduplicated); I-INT-22 covers the new rule.
- **The D11 "outdated" note is a display (T17.2).** Migration `0004_intent_display_pending` widens `intent_displays.status` to `ok | unavailable | pending` (down: deletes `pending` rows, restores the old CHECK). After the note's comment write, inside the same lock, the job records a `pending` display of the previous card. `attributeReactions` already treated every non-`ok` display as a dropped one, so a reaction made while the note is shown is not credited to any card. `latestPublishedCard` skips `pending` displays. `markPublished` still compares with the last display of any status, so the next `ok` or `unavailable` publish after a note adds a row. I-FB-10, I-DB-9.
- **Publish order and display time (T17.3).** The intent job now writes the check run first, then the comment, then `markPublished` with a `now` taken right after the comment write. A failed check-run call leaves the old comment and no new display, a failed comment call leaves no new display either, and the pg-boss retry finds the saved card and publishes once. This replaces the "comment first" order for the intent job only (the provenance job keeps its order). I-INT-23.
- **`0003` down (T17.4)** uses `DROP TABLE IF EXISTS` for `intent_displays` and `intent_spend`. **`escapeProse` (T17.5)** keeps the `<!--` rewrite with the "unreachable, defence in depth" comment; no behavior change.
- **New exports.** `modules/intent/index.ts` also exports `fetchIntentInputs`, `promptFingerprint`, `maxRisk`, `RISK_ORDER`, `DOCS_GLOBS`, `TEST_GLOBS`, `globMatcher` and `MAX_OUTPUT_TOKENS`; `modules/provenance/index.ts` exports `computeProvenance` and `fetchPrCommits`. U-PROMPT-1 also asserts `promptFingerprint()` equals the pinned hash.
- **No new dependency.** zod 4's `z.toJSONSchema` (draft 2020-12, verified against `node_modules`) generates the schemas; dates and timestamps are checked with regular expressions instead of `format`, so that a plain JSON Schema validator needs no format plugin. Refinements JSON Schema cannot express are listed in the case schema's top-level `description`.
- **Report details the spec left open.** `status` of a row is `ok | unavailable | skipped` (a case skipped by the budget has status `skipped`). Report thresholds carry a `provisional` boolean; `report.pass` is true only when every result passes (a provisional failure makes it false but exits 1 only with `--strict`). The baseline comparison also ignores the derived fields `thresholds` and `pass` (they depend on the baseline itself) and the per-row `cached` flag; everything else must be equal. Cached rows keep the cost of the result they reuse, `costUsdThisRun` counts only the rows that were not cached. A baseline that does not exist is a usage error with `--check` on the synthetic set, and an explicit `--baseline` that does not exist is always one.
- **Run options added.** `RunOptions.git` is not part of the harness: the CLI fills `report.git` itself. `maxTokens` also gates the pre-run estimate. Budgets and the confirmation apply to `--live` only (fake mode has no real spend); in-flight cases reserve their estimate so that concurrency cannot overshoot `--max-cost-usd`.
- **Export details.** The export counts cases that already exist toward `--sample` (so a re-run of the same export writes nothing, and an aborted one resumes with the rest, re-sampled: see "Resumed export" below), and skips them before stage 1. Exported cases are tagged `size-s|m|l|xl` and `path-sensitive|tests|docs|source` so that the report's per-tag under-classification shows the strata. `--author bot` filters on the list response (`user.type`, `--agent-logins`) and makes no commit request; `--author any` fetches commits only to classify. Pull requests with more than 20,000 changed lines or 1,000 files are classified without a file listing (stratum `source`). `source.baseSha` falls back to forty zeros if the API omits `base.sha`. `--redact` accepts only `emails`.

**Redaction is wider than the spec's §6.4 table** (step 4 review 1, finding 1). The `assignment` rule matches an identifier that contains a secret word (`password`, `passwd`, `passphrase`, `secret`, `credential`, `api_key`, `access_key`, `private_key` anywhere in the name; `token(s)`, `pwd`, `auth`, `authorization` as a whole `_`, `-`, `.` or camelCase segment), so `DB_PASSWORD`, `AWS_SECRET_ACCESS_KEY`, `client_secret`, `access_token`, `app.db.password` and `clientSecret` are covered, and `tokenize(...)` and `author` are not. It accepts a quote before the operator (`"password": "..."`, `'api_key': '...'`, escaped JSON), the operators `=`, `==`, `===`, `:=`, `=>` and `:`, and a quoted value with spaces (up to the matching quote); the name, operator and quotes stay, and a value shorter than 8 characters stays. Further rules: `url_credentials` (`scheme://user:PASSWORD@`, only the password), `bearer` (`Authorization: Bearer|Basic|Token ...`), `<password>...</password>` elements, PEM and PGP private key blocks, and the provider tokens GitHub (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`), AWS (`AKIA`, `ASIA`), Stripe (`sk_live_`, `rk_live_`), Anthropic and OpenAI (`sk-`), Google (`AIza`), GitLab (`glpat-`), npm (`npm_`), Slack (`xox[abprs]-`) and JWTs. Every quantifier is bounded, so a long adversarial line cannot cause catastrophic backtracking (U-RED-12). Line count and diff prefixes (`+`, `-`, space, `@@`, `\`) never change; a hunk header ends an unterminated key block. **Intentional over-redaction:** any 8+ character value after a secret-looking name is replaced, including a bare identifier (`token = someLongVariableName`) or `PWD=/home/user/project`; names ending in `length`, `size`, `count`, `type`, `name`, `path`, `file`, `url`, `ttl`, `expires`, `enabled` and similar are left alone, as are placeholders (`${VAR}`, `$VAR`, `<token>`, `{{ x }}`), env lookups (`process.env...`), function calls and `null`/`true`/`false`. **Not covered:** a secret with no secret-looking name and no known prefix (a raw high-entropy string in prose); review `show` output before sharing a set. `--redact-pattern` values that match the empty string, or that are not a valid regular expression, are rejected (exit 2).

**Further step 4 review 1 changes.** Error output never carries pilot paths or label text: schema messages name the field only, unmapped errors print their class name (`GRAFT_EVAL_DEBUG=1` adds the message), and a fake-mode generation error echoes its message only for a synthetic set. The baseline comparison also ignores `metrics.costUsdThisRun` (0 for a run served from the cache). After an unexpected error in one case no worker starts another. The CLI ignores a `GRAFT_EVAL_KEY` that only `.env` provides and warns on stderr: `.env` is for `ANTHROPIC_API_KEY` and the GitHub App settings, and the case-set key stays in the shell. **Resumed export:** a re-run does not reproduce the sample of an uninterrupted run. It counts existing cases toward `--sample`, then draws the remainder (`sample - existing`) from the fresh candidates with the same seed, and `--min-per-stratum` applies to the strata of those candidates only. Reproducing the original draw would mean fetching and classifying every already-exported pull request again, which costs requests for no new data; if an exact sample matters, export into a fresh set in one go. **Retry key:** the 5-minute bucket in the retry `singletonKey` means two triggers on either side of a bucket boundary queue two retry chains (at most two per boundary, each capped at two attempts); this is accepted, see the comment in `src/modules/intent/job.ts`.
- **Fake GitHub API (T8).** `GET /repos/{o}/{r}/pulls` (state, sort, direction, `Link` paging, and `state.listPageSize` to force small pages), `state.rateLimit` with `x-ratelimit-*` headers and 403 when exhausted, an injectable clock (`createFakeGitHubApi({ now })`), and `base.sha` in `makePull` (optional in `FakePull`).
- **Existing tests changed.** I-INT-10 (retry key), I-INT-21 (bucket), I-DB-2, I-DB-7 and I-DB-8 (they now roll back and re-apply `0004` too). No assertion was weakened.
- **Prices and models.** Haiku and Sonnet prices are the ones in the spec (`PRICING_VERIFIED_AT = 2026-10-06`); I did not check them against Anthropic's page (HUMAN-TODO). No live eval was run and the real API was never called.
- **The synthetic cases** are fictional and were adjusted only where the spec's table described behaviour the floor does not produce on its own: none needed a floor change. The floor additionally reports `size_large` for syn-016 and syn-018 (more than 15 files or 300 lines) and `partial_view` for syn-025 (the rename has no patch); the table lists the rules that decide the class. Headline values: UC floor 6/30, severe UC floor 1/30, UC final 0, accuracy final 28/30, out-of-scope and flag precision and recall 1, unavailable rate 2/30.

## 8. Troubleshooting

- **401 `invalid signature`**: `GITHUB_WEBHOOK_SECRET` differs from the App's webhook secret (or from the one `pnpm webhook:send` reads from `.env`).
- **Duplicate deliveries**: GitHub redelivers on timeouts; the second delivery with the same `X-GitHub-Delivery` returns `200 {"status":"duplicate"}` and enqueues nothing. A delivery that failed with 500 is rolled back, so redelivering it is processed normally.
- **Port 55432 already in use**: another process holds it; stop it or change the host port in `docker-compose.yml` and `DATABASE_URL` / `TEST_DATABASE_URL`.
- **`run pnpm db:migrate`** on startup: the schema is behind; run the migration.
- **`Postgres not reachable ... run pnpm db:up`** from the integration tests: start the container.
