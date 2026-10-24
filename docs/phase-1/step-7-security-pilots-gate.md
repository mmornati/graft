# Phase 1, Step 7: Security review, five pilots, gate

Spec for the developer agent. Implement exactly this. Where it is silent, choose the simplest option and record it in [docs/decisions.md](../decisions.md) under a new heading "Phase 1 step 7: security review, pilots and gate". The [Phase 0 constraints](../phase-0/README.md#constraints-for-every-step) are binding: offline build and test, Postgres from `docker compose`, **no stored code, diffs, logs or file contents**, pnpm, Node 24, strict TypeScript. The code as it is after step 6 and its review fixes (PR #42) is described in [docs/architecture.md](../architecture.md) (the modes, policy, guard and MCP contracts) and [docs/decisions.md](../decisions.md). Where this spec and those documents disagree on an existing interface, they win and you record the difference. The plan for the whole phase is [phase-1/README.md](README.md). The previous step is [step-6-mcp-server.md](step-6-mcp-server.md). The Phase 0 gate this step extends is [phase-0/step-6-pilots-and-gate.md](../phase-0/step-6-pilots-and-gate.md).

This step depends on steps 1 to 6, which are merged, and on the step 6 review 1 fixes (PR #42, migration `0015_mcp_open_claims`). Build it on a branch that contains both.

Binding rules from earlier steps:
- **Report mode stays inert.** Nothing in this step adds a GitHub write. The hardening below only refuses more, reads less, or stores more Graft-side data. The neutral suite must stay green in both profiles, and it gains N-17 (§13).
- **Payloads are triggers** ([architecture.md](../architecture.md#webhook-replay)). The gate report and the readiness numbers are read from the database only, never from GitHub, never from a payload.
- **Missing permissions fall back to report, never to "allow"** (README §1). Every rule this step adds fails toward report, toward "approval does not count", or toward "refused".
- **Graft never changes branch protection** and never requests `administration`. Every branch protection change in the runbook is a human step, done by a repository admin.
- **Nothing in a repository changes a mode.** The runbook moves a repository between stages only through `pnpm graft mode set`.
- **Log and report hygiene.** Reports, logs, job data and errors carry ids, counts, codes, SHAs, repository and account names. Never a voter login, a reviewer login, PR text, a path list or YAML.

## 1. Goal

Phase 1 ends here. This step does three things, in this order:

1. **A security review of everything that writes**, written by you in the Phase 0 security review format (D1), with the hardening it requires fixed in code in this step (H1 to H9, §6). The write surface is: the mutation guard and the client factory, the ceiling and the modes, break-glass, the revert tree and the revert job, the MCP endpoint and its one write, and the Phase 1 permissions. The review ends with a verdict that pilots may enforce, or a list of what blocks it.
2. **A pilot rollout runbook**, `docs/pilots/phase-1-runbook.md`, written per repository: install in report mode, watch two weeks of would-be conclusions and guard comments, turn `policy_mode` to `enforce`, have the team drop required reviewers and make `graft/policy` required with the Graft App as source, later `guard_mode`, and optionally `mcp_write`. Each stage has its commands, its go/no-go criteria read from the gate report, and its rollback (§9).
3. **The Phase 1 gate**: `pnpm graft gate report --phase 1` computes the four MVP metrics (share of PRs merged with no human, review minutes per agent PR, post-merge breakages caught, escaped defects) exactly as defined in §8. Each metric is **measured** from enforce-mode data and **projected** from report-mode data (would-be conclusions and guard plans), so the gate can be previewed before anything is enforced. A per-repository table gives the runbook its numbers.

It also folds in every item earlier steps deferred to step 7 (§3, D2 to D13), and adds one enforce-mode scenario to the live e2e runner (D21).

## 2. Out of scope

Do not create stub code for any of these.

- Any new GitHub permission, event or manifest change. Both manifests stay as step 5 left them (U-MAN-6 unchanged).
- Changing branch protection, rulesets, CODEOWNERS or repository settings from code. The runbook tells a human what to change.
- A web dashboard, charts, or gate numbers on a PR. Markdown and JSON reports only, as in Phase 0.
- Rolling the Phase 1 metrics into `metrics_daily` (D14: they are computed from raw rows at report time). `ROLLUP_VERSION` stays `1`.
- Business-hours review time, bootstrap or other resampled intervals for medians (D19).
- Automatic stage changes. No code moves a repository from one runbook stage to the next.
- Reading the issue events API newest page first (step 3 review 1, nit 8). D11 records why it stays as it is.
- Tying an MCP token to a GitHub user, or reading who pushed a branch (D8 closes the D19 gap another way).
- Enforce-mode live e2e scenarios for the guard and for MCP (D21). They stay manual HUMAN-TODO checks.
- Merge queues (`merge_group`). A repository that uses one stays in report mode (runbook stage 2).
- Task grouping and candidate ranking (Phase 2, spec fix 2).

## 3. Decisions

| # | Area | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | Security review deliverable | You write `docs/phase-1/reviews/step-7-security-review.md` in the format of [phase-0/reviews/step-6-security-review-1.md](../phase-0/reviews/step-6-security-review-1.md): a title, `Verdict:` (`READY FOR PILOT ENFORCEMENT` or `NOT READY`), `Reviewer:` (the developer agent and model), `Scope:` (the commit range and the areas of §5), **What was checked** (the DoD chain, the write-call inventory of Q-MG-1, the probes you ran, the mutations you applied and their results), **Findings** (numbered; severity `blocker`, `major`, `minor` or `nit`; `file:line`; **Problem**; **Fix**; and the status `fixed in <commit>`, `accepted` or `deferred`), and **Questions, answered** (one answer per question of §5, each with evidence: `file:line`, a test ID, or a probe result). H1 to H9 (§6) are findings you must list and fix. Any other `blocker` or `major` you find is fixed in this step with a test. A `minor` or `nit` is fixed, or recorded as accepted or deferred in decisions.md, with a HUMAN-TODO item when a person must act. The verdict is `READY` only when no blocker or major is open. | The Phase 0 security reviews found real bypasses because they traced every path and probed it. The same format makes the review checkable by the step 7 reviewer, who re-runs its probes. |
| D2 | Ceiling: the lower of the process's and the worker's | Every effective-mode computation uses **`effectiveCeiling(env, stored)`** = the lower of the process's `GRAFT_MODE_CEILING` and `service_state('mode_ceiling')`, where a missing row means `env` alone and a value other than `report`/`enforce` means `report`. `getRepositoryModeRow` and `findActiveRepositoryByName` (`src/modules/modes/store.ts`) read the stored value in the same query (a scalar subquery on `service_state`), `RepositoryModeRow` gains `storedCeiling: Mode \| null`, and `modesOf(row, ceiling)` (`effective.ts`) passes `effectiveCeiling(ceiling, row.storedCeiling)` to `effectiveModes`. So `getEffectiveModes`, `mutationGate`, `mode show` and the doctor all use it. `publishModeCeiling` is unchanged: a worker still stores its environment's value at start. | Step 2 review 1, finding 7: during a rolling restart that lowers the ceiling, an old worker with `enforce` could publish after the rollback. With this rule, the first new worker's start stores `report`, and from the next request on every old process computes `report` too. A raise is the safe direction: an old `report` process stays at `report` until it restarts. A missing row means no worker ever started, so no rollback can have happened. |
| D3 | Writes with a query string | A non-GET request whose path contains `?` is refused `unknown_route`, on every route (Phase 0 routes included). A new `writePath(raw)` in `src/github/mutation-guard.ts` returns null when `raw` contains `?`, and otherwise `normalisedPath(raw)`. `classifyWrite`, `checkRunWrite`, `guardBodyAllowed` and `mcpBodyAllowed` use `writePath`. `recordPulls` keeps `normalisedPath`, because the guard's `pulls.list` by head (a GET with a query) must still record node ids. | Step 5 review 2, nit D: `POST …/pulls?head=main&base=release` with a valid body was sent. No Graft write carries a query, so refusing all of them is the narrowest rule that leaves no route unexamined. |
| D4 | A failed revert run whose writes began | `settleFailedRun` (`src/modules/guard/revert.ts`) and `failed()` on its last attempt, when the event has `revert_branch` or `revert_commit_sha` set and no `revert_pr_number`: look the PR up by head with the default client (`findPr`, the step 5 review 1 finding 6 lookup). Found → `storePr` (status `revert_opened`, outcome `opened`), so the next `guard.revert` resumes the label and auto-merge steps. Not found, or the lookup fails → for a retryable error, leave `revert_outcome` null and write no outcome, so the next observe re-sends `guard.revert` after the one-hour job retention (the `stale` rule already exempts an event whose writes began) and it resumes from the stored steps; for a permanent error (422, 404, 403), settle `error` with the comment, as before step 7 (amended by step 7 review 1, finding 1). The comment is published as today. | Step 5 review 2, finding A: a run that died after `POST …/pulls` and then failed its last attempt was settled `error`, which left an open revert PR that the cap, D17 (e), `revert_closed` and `guard.track` never saw. Both outcomes keep exactly one revert per event. |
| D5 | MCP: authenticate before the body is parsed | In `mcpRoutes` (`src/modules/mcp/http.ts`), `originCheck` and `authenticate` move from the route's `preHandler` to its `onRequest` (they read headers only). `rateLimit` stays in `preHandler`. Nothing else in the order changes: Origin, the failed-auth block of the client IP, the token, then (after parsing) the per-token bucket. | Step 6 review 1, nit 9, with the amendment of review 2: an unauthenticated request now gets `401` (or `403` for a foreign origin) before Fastify parses or bounds its body, so the pre-auth cost is a header read. |
| D6 | MCP: the client IP behind a proxy | New config `GRAFT_TRUST_PROXY`: a comma-separated list of IP addresses or CIDR ranges (IPv4 or IPv6), default empty. `buildServer` passes it to Fastify as `trustProxy` (the list as a string) when non-empty, and `false` otherwise. `req.ip` is then the client address from `X-Forwarded-For` only when the connection's peer is in the list. `true`, hop counts and hostnames are refused at config parsing (`ConfigError` naming the entry index, never the value). | Step 6 residual risk 1: without it, every client behind the proxy shares one failed-auth bucket, so 20 bad tokens from anyone lock every MCP client out. `trustProxy: true` would let any client choose its own IP and escape D9 (b); a list trusts only the operator's proxy. |
| D7 | MCP: tool annotations | `report_provenance` is registered with `readOnlyHint: false, destructiveHint: false, idempotentHint: true` (`src/modules/mcp/server.ts`). The other three are unchanged. This amends step 6 §6. | Step 6 review 1, nit 8: it stores a row, can make a verdict stricter and republishes the check and comment section. It is not a read, although it can only make Graft stricter. |
| D8 | MCP: approvals on an MCP-opened PR need verified commits | `listCommitLogins` (`src/modules/policy/facts.ts`) returns `{ logins: string[] }` or `{ unknown: "too_many" \| "no_author" \| "unverified" }`. A commit is **unverified** when `commit.verification.verified` is not `true` in the `pulls.listCommits` response, or when its `committer` has no login or is `web-flow` (a `web-flow` signature proves only that GitHub made the commit; amended by step 7 review 1, finding 2). Any unverified commit → `unknown: "unverified"` → the policy job passes `excludedLogins: "everyone"` (no approval counts, as today for `too_many` and `no_author`). The stored approvals (`storedApprovals` in `src/modules/policy/job.ts`) gain `mcpExclusion: "commit_authors" \| "too_many" \| "no_author" \| "unverified" \| null`, and the policy section renders one line for each non-null value other than `commit_authors` (§11). | Step 6 residual risk 2: D19 excludes commit authors and committers, but anyone who pushes chooses the author and committer emails, so a pusher could commit as someone else and approve the PR. GitHub verifies a signature against the committer's account, so with verified commits every committer other than `web-flow` is genuine and is excluded. A pusher who pushes other people's genuine commits is reviewing someone else's work, which is a normal review. GitHub's API does not say who pushed a branch, so no stronger rule is available without new data. |
| D9 | MCP: claims are not PRs | (a) Every count of PRs opened through MCP (the gate report, §8.6) filters `mcp_changes.pr_number IS NOT NULL` and takes the open time from `changes.opened_at` of the PR, never `mcp_changes.created_at`. (b) `runRollup` (`src/modules/pilot/rollup.ts`) deletes claims older than one hour (`pr_number IS NULL AND created_at < now − 1 hour`) before it computes, so a crashed claim in a quiet repository does not wait for the next claim of that repository. (c) `loadConfig` lowercases `GITHUB_APP_SLUG`. (d) The test-only findings A, C, D and E of step 6 review 2 are added (§13). | Step 6 review 2, finding B and nits A, C to F. The daily rollup is the one periodic job that already reads every repository; the cap's own stale delete stays. |
| D10 | Public repositories | `pnpm graft mode set --policy enforce` on a repository whose `repositories.private` is `false` is refused (exit 1, `public repository: read the Phase 1 runbook, stage 3; pass --public to enforce anyway`, nothing written) unless `--public` is given. `--public` changes nothing else (the reason is still required). `pilot doctor` gains a `WARN` check `public_enforce`: a repository with `policy_mode` requested `enforce` and `private = false`. The runbook says pilots do not enforce `policy_mode` on public repositories in Phase 1. `guard_mode` and `mcp_write` are not affected. | Step 2 review 1, finding 4: 21 or more outsider change requests still block an enforcing check (fail closed). The review's alternative (only `OWNER`, `MEMBER`, `COLLABORATOR` block past the bound) would infer "no access" from an association, which loosens a fail-closed rule. A public repository is not a Phase 1 pilot target, so the cheaper fix is to make enforcing one a deliberate act. |
| D11 | The 1,000-event cap on break-glass | Accepted, no code change. A PR with more than 1,000 issue events cannot be break-glassed (fail closed, `actor_unknown`). The runbook's stage 0 requires the HUMAN-TODO step 3 measurements (the label lag and whether `Link: rel="last"` is served) before any repository enforces. | Step 3 review 1, nit 8: reading the newest page first depends on real pagination, which offline tests cannot check. A PR with 1,000 events is rare, the cap fails closed, and a maintainer can still merge by restoring required reviewers (runbook rollback). |
| D12 | Guard framing and auto-merged reverts | The step 5 §4 trust boundary is re-read in the security review (Q-RV-8) and kept: no code change. The runbook limits `guard.auto_merge_reverts` to `[trivial]`, only after stage 4 has run for 14 days with at least 3 reverts opened and none of them wrong (§9, stage 5), and only in repositories where the default branch requires a review for changes to `.github/workflows/` (CODEOWNERS or a ruleset). | A framing workflow must already be merged on the default branch. Requiring review of workflow changes is what keeps it out, and that is a branch protection setting, which Graft never changes. |
| D13 | Every settled guard event records its mode | When `guard.observe` or `guard.confirm` settles an event to `ambiguous`, `no_culprit`, `flaky` or `culprit_found`, it stores `guard_mode` (the effective guard mode, read once per run with `getEffectiveModes` before the repository lock) if the column is still null. `guard.revert` keeps overwriting it at its start (step 5, D2). | §8.4 splits breakages into measured (enforce) and projected (report) by `guard_events.guard_mode`. Today only events that reach the comment or the revert job have it. A null on rows from before this step counts as `report`. |
| D14 | Phase 1 gate: one report, raw rows | `pnpm graft gate report --phase 1` (default `--phase 0`, whose output stays byte for byte as today). It reads the database only, computes every number from raw rows at report time (no rollup), and writes `gate-phase1-<until>.md` and `.json` with `--out` (mode 0600, as Phase 0). Pure decision code in `src/pilot/gate-phase1.ts` (`decidePhase1`), gathering in the same file (`gatherPhase1Gate`), schema and markdown in `src/pilot/gate-phase1-render.ts` (`phase1GateReportSchema`, `schemaVersion: 1`, `phase: 1`). `--allow-file` with `--phase 1` is a usage error. | The metrics need the latest verdict at each merge head, guard event outcomes and per-PR review minutes; additive counters cannot express them. Pilot volumes make raw queries cheap. A separate schema keeps the Phase 0 report and its tests stable. |
| D15 | Measured and projected | Each metric is computed twice. **Measured**: only rows whose mode was `enforce` (the merge-head verdict's `policy_verdicts.policy_mode`, or the event's `guard_events.guard_mode`). **Projected**: every row, with report-mode rows counted by what enforce would have done (`enforced_reason`, `revert_outcome = 'planned'`). The gate verdict uses measured values only. The projected values give a **preview** verdict, labelled as such, which never sets an exit code. | The gate must be decided on what happened under enforcement. The preview answers "if we enforced, would we pass", which is what the runbook's stage 2 needs. |
| D16 | M2 needs a Phase 1 extraction | Migration `0016_phase1_gate` widens `review_time_runs.period` to `('baseline','shadow','phase1')`. `pnpm graft baseline --period phase1` extracts the Phase 1 window with the existing extractor. | M2 compares Phase 1 review time with the pre-Graft baseline on the same definition (Phase 0 D4). A new period keeps Phase 0's shadow runs meaningful. |
| D17 | Breakages: which events count | §8.4. `flaky` with a null `confirm_reason` ("flaky (unconfirmed)") is **neither a caught breakage nor a flake**: it is left out of the numerator and the denominator and reported on its own line. A `culprit_found` event with no revert outcome yet counts as open. | Step 4 review 2, nit D, as README step 7 requires. An undecided event is neither evidence for nor against the guard. |
| D18 | Escaped defects: lag and test | §8.5: PRs merged in `[since, until − 14 days)`, so an incident has at least 14 days to be recorded. "No rise" fails only when the window's rate is above the baseline's **and** a one-sided exact conditional binomial test gives p < 0.05. | Incidents are recorded by people, later than merges. Small counts make a plain rate comparison flip on one incident. |
| D19 | Decision rules | §8.7. M1 uses the Phase 0 Wilson structure (interval, minimum N, point estimate from N = 400). M2 and M3 decide on the point estimate once their minimum sample is reached, with the interval shown for M3. The gate is PASS when all four metrics PASS, FAIL when any FAILs, otherwise INSUFFICIENT DATA. Pilot retention (MVP: 3 of 5 after 30 days) is reported, not part of the verdict. | Medians have no cheap exact interval, and breakage counts are small; a point estimate past a minimum, with the numbers on the page, is what a human can check. Retention depends on reasons outside the product, so the product owner judges it (HUMAN-TODO). |
| D20 | Runbook | `docs/pilots/phase-1-runbook.md`, one copy of its stage checklist per pilot repository (§9). It references only commands that exist and fields of the Phase 1 report's `repositories[]` (U-DOC-3). The onboarding guide (`docs/pilots/onboarding.md`) §8 and §9 link to it. | Spec fix 1 is a human step per repository; the criteria must be the same for every team and checkable from one report. |
| D21 | Enforce-mode live e2e | `e2e/sandboxes.json` entries gain an optional `mode: "report" \| "enforce"` (default `report`). For an `enforce` sandbox the runner runs only the new scenario `e01` (policy enforce, §12) and replaces INV-1 with INV-1E. The runner never changes a mode: preflight requires the human to have set the ceiling and `--policy enforce` for that sandbox, and refuses otherwise. Guard and MCP enforce scenarios are not built (the sandbox has no CI by design, live spec D2, and MCP needs a token the runner must not hold). | The step 2 spec deferred enforce-mode live scenarios to this step. The policy check is the enforcement every pilot turns on first, and the sandbox can exercise it end to end; the other two stay manual checks in HUMAN-TODO. |

## 4. Trust boundary after this step

What an enforcing deployment relies on, and what this step changes:

- **The ceiling is a deployment-wide maximum** that can only be lowered by a worker start, and every process honours the lowest value any worker published (D2). Rolling restarts are safe once every process runs this step's code.
- **The mutation guard is the proof**: every write either is a Phase 0 route with a neutral body, or a Phase 1 route through the one feature client allowed to send it, with a body rule, and a mode read at the request. After D3, no write path carries anything a rule does not read.
- **An MCP token holder** still cannot approve the work of anyone whose commits are on the PR (D8), cannot lock other clients out through the proxy (D6), and costs Graft only a header read before authentication (D5).
- **Branch protection is the enforcement.** `graft/policy` blocks only when a repository admin makes it required, with the Graft App as source. A `neutral` check passes a required check on GitHub, so rolling a repository back to report while required reviewers are dropped lets PRs merge with no review. The runbook's rollback restores required reviewers first (§9).

Residual risks, recorded in the security review and in `docs/features/modes.md`, `docs/features/mcp.md` and `docs/features/guard.md`:
- An old process that never restarts keeps its environment's ceiling until a worker publishes a lower one (D2 covers rollbacks only after the first new worker starts).
- On a public repository with `--public`, 21 or more outsider change requests block the check (D10).
- A framing workflow already merged on the default branch can still get a revert opened (D12); auto-merge of that revert needs the D12 conditions.
- Agents that use `open_change` must sign their commits, or approvals on their PRs never count (D8).

## 5. The security review (`docs/phase-1/reviews/step-7-security-review.md`)

Scope: the code on this branch at the commit before your first hardening commit, plus every hardening commit. Answer each question below in "Questions, answered", in this order, with evidence. A question you cannot answer from the code and a probe is a finding.

**Mutation guard and clients** (`src/github/mutation-guard.ts`, `src/github/client-factory.ts`, `src/bin/bootstrap.ts`):
- **Q-MG-1. Inventory.** Run `grep -rnE "rest\.[a-zA-Z]+\.(create|update|delete|add|remove|set|merge|enable|request)[A-Za-z]*\(|request\(\"(POST|PATCH|PUT|DELETE)|graphql\(" src/` and list every hit in a table: file and line, method and route, route class (`auth`, `app`, `phase0`, `phase1`, unknown), feature client, the test that sends it through the guard. Every hit must be in `ROUTES` or be a GET.
- **Q-MG-2. Path normalisation.** Probe each with a guard client and an allow-all gate, and record the refusal: `#`, `%`, `\`, `?` (D3), `.`/`..`/empty segments, a trailing slash, lower-case method, another host, a per-request `baseUrl`, the GHES GraphQL URL.
- **Q-MG-3. Body rules.** For each of the check-run, guard and `mcp` body rules: a body passed through `data`, a non-plain body, an extra key, an inherited key (`Object.create` with a prototype), `undefined` values. Each must fail closed.
- **Q-MG-4. The gate.** The mode is read per request with no cache, through D2's ceiling. Show the query.
- **Q-MG-5. Feature clients.** `grep -rn "{ feature: \"" src/` gives exactly one construction site per feature (`policy` in the policy job, `guard` in `revert.ts`, `mcp` in `open-change.ts`). Say what each can reach.
- **Q-MG-6. Blast radius.** With `contents: write` and `pull_requests: write`, what could an installation token do if the guard were bypassed? Name the routes the guard keeps unreachable (`PUT …/merge`, `PATCH …/git/refs`, `POST …/git/blobs`, `PUT …/contents/…`, branch protection, any GraphQL but the one document).
- **Q-MG-7. Refusals and logs.** A refusal names method, route template, feature and reason only (no body, no branch name); show a refused request's log line.

**Modes and rollback** (`src/modes/index.ts`, `src/modules/modes/*`):
- **Q-MD-1.** The ceiling after D2, for the four orders of a rolling restart (lower, raise; old worker first, new worker first), and for a server process with no worker started.
- **Q-MD-2.** A `graft.yaml`, label or PR text cannot change a mode (show the only writers of `repositories.policy_mode`, `guard_mode`, `mcp_write`).
- **Q-MD-3.** A transfer or re-add resets modes and revokes MCP tokens (step 2 D13, step 6 D12): show the code and the test.
- **Q-MD-4.** Rollback timing: a `mode set … report` republishes neutral within about a minute; a ceiling rollback fans out once; what is left behind (an open revert PR and its auto-merge).

**Break-glass** (`src/modules/policy/break-glass.ts`):
- **Q-BG-1.** Only the sender's `maintain` or `admin` role at labelling time counts, read from the API; a bot never counts; a deleted actor is `actor_unknown`.
- **Q-BG-2.** The bypass binds to the head SHA of the signed `labeled` delivery and to the newest `labeled` issue event of that label; a push, an unlabel or a later label by someone else ends or replaces it.
- **Q-BG-3.** The events cap (D11), the retry budget against the API's lag, and what fails closed.
- **Q-BG-4.** Report mode: rows are written and the check stays neutral.

**Revert tree and job** (`src/guard/revert-plan.ts`, `src/modules/guard/revert.ts`, `trees.ts`, `revert-closed.ts`):
- **Q-RV-1.** No content is read: only `git/trees`, `git/commits`, `git/ref` GETs, `pulls` GETs and the policy loader's one `contents` read (show the request log of I-REV-20).
- **Q-RV-2.** D7 entry equality and D9's `treeMatchesPlan` make a wrong tree fail before a commit; what if GitHub ignores `sha: null` on a directory (HUMAN-TODO T1 b).
- **Q-RV-3.** Names: `/` inside a name, `.`, `..`, workflow paths, submodules, type changes, size bounds.
- **Q-RV-4.** Exactly once: the singleton, the claim under the repository lock, the D17 resume points, the one-revert-per-culprit index, and D4 of this step.
- **Q-RV-5.** The branch, PR, label and GraphQL body rules, and the GraphQL `pullRequestId` binding (step 5 review 1, finding 7).
- **Q-RV-6.** Revert of a revert is decided by the database row only.
- **Q-RV-7.** Auto-merge eligibility: every D14 condition, the policy read at the baseline, never for `sensitive` or break-glass culprits.
- **Q-RV-8.** Re-read step 5 §4 (framing) and state whether D12 is enough; say what a team must configure.

**MCP** (`src/modules/mcp/*`, `src/mcp/*`):
- **Q-MCP-1.** Token generation, hashing, lookup per request, revocation and expiry, installation and repository state (step 6 D6, D7).
- **Q-MCP-2.** Repository scoping by token row only (D8 of step 6); PR lookups scoped to it.
- **Q-MCP-3.** Order of the HTTP checks after D5; what an unauthenticated client can make the server do.
- **Q-MCP-4.** Rate limits after D6, behind a trusted and an untrusted peer.
- **Q-MCP-5.** Redaction: tokens in errors, arguments never logged.
- **Q-MCP-6.** `open_change`: the early mode read, the body rule, the claim, adoption limited to Graft's bot.
- **Q-MCP-7.** D19 with D8: who can approve an MCP-opened PR; the `web-flow` case.
- **Q-MCP-8.** `report_provenance` can only tighten (the stricter-of-two merge) and is once per head.

**Permissions** (`github/app-manifest.json`, `github/app-manifest.report.json`, `src/modules/modes/permissions.ts`):
- **Q-PM-1.** Each permission of each manifest, the feature that needs it, and the mode it gates; nothing above what §4 of the README lists; no `administration`, `workflows` or `actions: write`.
- **Q-PM-2.** Permissions are read from `GET /app/installations/{id}`, never from a payload; never-read counts as missing; an unknown level counts as missing.
- **Q-PM-3.** A deployment with the report manifest can never enforce: show the chain from the missing permission to `report` for `guard_mode` and `mcp_write`, and say what `policy_mode: enforce` can still do with the report manifest (non-neutral `graft/policy` checks need `checks: write`, which both manifests have).

**Data**:
- **Q-DT-1.** The Phase 1 gate report and its JSON hold no login, title, body, path list or YAML (I-P1G-9).

## 6. Hardening (fixed in this step)

Each item is a finding of the security review with its fix and its tests.

| # | Fix | Source | Tests |
| --- | --- | --- | --- |
| H1 | D2: the ceiling is the lower of the process's and the worker's | Step 2 review 1, finding 7 | U-CEIL-1, U-CEIL-2, I-CEIL-1 to I-CEIL-3, N-17 |
| H2 | D3: a write path with `?` is refused | Step 5 review 2, nit D | U-MG-21, U-MG-22 |
| H3 | D4: a failed last attempt after writes began adopts or stays resumable; plus step 5 review 2 finding B (stale age from confirmation, test only) and nit C (the conditional `revert_closed` update, test only) | Step 5 review 2, A, B, C | I-REV-10c, I-REV-10d, I-REV-10e, U-RVC-1 |
| H4 | D5 and D6: authenticate in `onRequest`; `GRAFT_TRUST_PROXY` | Step 6 review 1, nit 9; step 6 residual risk 1 | I-MCP-6b, I-MCP-7b, U-CFG-40 |
| H5 | D7: `report_provenance` annotations | Step 6 review 1, nit 8 | I-MCP-2 (amended) |
| H6 | D8: verified commits on MCP-opened PRs | Step 6 residual risk 2 | U-FCT-1, I-MCP-14b |
| H7 | D9: claims are not PRs; stale-claim purge; slug lowercased; step 6 review 2 test findings A, C, D, E | Step 6 review 2, B and A, C to F | I-ROLL-5, I-MCP-1b, I-MCP-1c, I-MCP-11b, I-MCP-12c, U-CFG-41, I-P1G-7 |
| H8 | D10: `--public` for enforcing a public repository; doctor `public_enforce` | Step 2 review 1, finding 4 | I-MODE-PUB-1, I-DOC-5 |
| H9 | D13: settled events record their guard mode | Needed by §8.4 | I-GRD-MODE-1 |

The step 3 review 1 nit 8 (D11) and the step 5 framing residual (D12) are accepted with documentation, not code.

## 7. Files

New:

| File | What |
| --- | --- |
| `docs/phase-1/reviews/step-7-security-review.md` | D1, §5. |
| `docs/pilots/phase-1-runbook.md` | D20, §9. |
| `src/pilot/gate-phase1.ts` | `decidePhase1` (pure, §8.7) and `gatherPhase1Gate` (database only, §8). |
| `src/pilot/gate-phase1-render.ts` | `phase1GateReportSchema` and `renderPhase1Markdown` (§10). |
| `src/db/migrations/0016_phase1_gate.ts` | §11. |
| `src/e2e/scenarios/e01.ts`, `e2e/fixtures/graft.enforce.yaml` | D21, §12. |
| `test/unit/gate-phase1.test.ts`, `test/integration/gate-phase1.test.ts`, `test/unit/ceiling.test.ts`, `test/integration/ceiling.test.ts` | §13. |

Changed: `src/modules/modes/store.ts`, `effective.ts`, `cli.ts` (D2, D10), `src/modes/index.ts` (`effectiveCeiling`), `src/github/mutation-guard.ts` (D3), `src/modules/guard/revert.ts` (D4), `observe.ts` and `store.ts` (D13), `src/modules/mcp/http.ts`, `server.ts` (D5, D7), `src/http/server.ts` (D6), `src/modules/policy/facts.ts`, `job.ts`, `render.ts` (D8), `src/modules/pilot/rollup.ts` (D9 b), `src/config/index.ts` (D6, D9 c), `.env.example`, `src/pilot/doctor.ts` (D10), `src/pilot/baseline.ts` and `src/bin/graft-ops.ts` (D10, D14, D16), `src/db/schema.ts`, `src/db/migrations/index.ts`, `src/e2e/guard.ts`, `preflight.ts`, `invariants.ts`, `scenarios/index.ts`, `setup.ts` (D21), `e2e/sandboxes.json` (unchanged content; the schema accepts `mode`), the GitHub fakes (`commit.verification` on `pulls.listCommits`, default `verified: true`), `test/integration/neutral.test.ts` (N-17), and the docs of T12.

## 8. Phase 1 metrics (exact definitions)

All times UTC. The window is `[since, until)` from the CLI (`--until` defaults to the start of today). The installations are the `--installation` ids. Common terms, used by every query below:

- **Repositories** `R`: `repositories r` with `r.installation_id IN (:ids)` and `r.removed_at IS NULL`.
- **Excluded authors**: `lower(ch.author_login) IN (GRAFT_METRICS_EXCLUDED_AUTHORS)`, as Phase 0.
- **Graft reverts**: a change whose PR number is the `revert_pr_number` of a guard event of the same repository.
- **Merge-head verdict** of a change `ch`: the newest `policy_verdicts` row for `(ch.id, ch.head_sha)`, ordered by `facts_read_at DESC, created_at DESC` (the rollup's rule):

```sql
LEFT JOIN LATERAL (
  SELECT pv.policy_mode, pv.outcome, pv.enforced_conclusion, pv.enforced_reason,
         COALESCE((pv.approvals->>'counted')::int, 0) AS counted
  FROM policy_verdicts pv
  WHERE pv.change_id = ch.id AND pv.head_sha = ch.head_sha
  ORDER BY pv.facts_read_at DESC, pv.created_at DESC
  LIMIT 1) v ON true
```

A row's **policy mode** is `v.policy_mode`, and `report` when `v` is null.

### 8.1 Merged population

```sql
WITH merged AS (
  SELECT ch.id, ch.repository_id, ch.pr_number, ch.merged_at,
         COALESCE(cp.author_kind, 'human') AS author_kind,
         COALESCE(v.policy_mode, 'report') AS mode,
         v.enforced_conclusion, v.enforced_reason, COALESCE(v.counted, 0) AS counted
  FROM changes ch
  JOIN repositories r ON r.id = ch.repository_id
  LEFT JOIN change_provenance cp ON cp.change_id = ch.id
  LEFT JOIN LATERAL (…merge-head verdict…) v ON true
  WHERE r.installation_id IN (:ids) AND r.removed_at IS NULL
    AND ch.state = 'merged' AND ch.merged_at >= :since AND ch.merged_at < :until
    AND lower(ch.author_login) NOT IN (:excluded)
    AND NOT EXISTS (SELECT 1 FROM guard_events g
                    WHERE g.repository_id = ch.repository_id AND g.revert_pr_number = ch.pr_number))
```

Each merged row has one **class**, from `enforced_reason`:

| Class | `enforced_reason` |
| --- | --- |
| `auto` | `approved_by_policy` |
| `human` | `requirements_met` |
| `break_glass` | `break_glass` |
| `would_fail` | `no_policy`, `policy_invalid`, `blocked`, `reviews_truncated`, `changes_requested`, `approvals_missing` |
| `pending` | `card_pending` |
| `no_verdict` | no merge-head verdict, or `enforced_reason` null (rows from before step 2) |

### 8.2 M1: share of PRs merged with no human (target ≥ 30%)

- **Measured**: `n` = merged rows with `mode = 'enforce'`; `x` = those of class `auto`. Share `x / n`.
- **Projected**: `n` = every merged row; `x` = every row of class `auto`.
- **Also reported**: the same two shares for `author_kind = 'agent'`; the class distribution for each mode; `autoWithHumanApproval` = measured `auto` rows with `counted > 0` (a human approved although the policy did not require it); `mergedWhileFailing` = enforce rows of class `would_fail` or `pending` (merged with Graft's check failing or pending: an admin bypass or a check that was not required).
- **Minimum sample (measured)**: `n ≥ 200`; at least 3 installations with at least 20 measured rows each; first to last measured `merged_at` spans at least 13 days (14 days, the first counting in full, as Phase 0).

### 8.3 M2: review minutes per agent PR (target ≤ −50% against the baseline)

Rows: `review_time_prs p` of the newest run per repository and period (Phase 0's `latestRunRows` rule) for `period IN ('baseline','phase1')`, repositories in `R`, with `p.state = 'merged'`, `p.excluded_reason IS NULL` and `p.author_kind = 'agent'`. Review minutes of a row:

```sql
CASE WHEN p.merged_without_review THEN 0
     WHEN p.minutes_to_first_approval IS NOT NULL THEN p.minutes_to_first_approval
     ELSE p.minutes_to_merge END
```

A `phase1` row is joined to its change (`changes` by `repository_id` and `pr_number`) and its merge-head verdict. Its **projected minutes** are 0 when its mode is `report` and its class is `auto` (enforce would have let it merge on the policy alone), and its review minutes otherwise. A `phase1` row without a change keeps its review minutes and counts as `report`.

- **Paired repositories**: repositories with both a baseline and a `phase1` run (Phase 0's pairing rule).
- **Measured**: `phase1` rows with mode `enforce`, against the baseline rows of the repositories that have at least one such row. Statistic: `Δ = (p50(phase1) − p50(baseline)) / p50(baseline)` with `percentile` type 7 from `src/pilot/stats.ts`. A baseline p50 of 0 gives `Δ = null`.
- **Projected**: every paired `phase1` row with projected minutes, against every paired baseline row.
- **Also reported**: p50, p75 and mean per side; the count of rows set to 0 by the projection; each run's `from_date`, `to_date` and `extracted_at`.
- **Minimum sample (measured)**: at least 30 rows on each side, from at least 2 repositories.

### 8.4 M3: post-merge breakages caught (target ≥ 80%)

Rows: `guard_events g` of repositories in `R` with `COALESCE(g.detected_at, g.created_at)` in the window. A row's mode is `COALESCE(g.guard_mode, 'report')` (D13). Each row has one class, tested in this order:

| Class | Rule | In the ratio? |
| --- | --- | --- |
| `open` | `status IN ('detected','confirming')`, or `status = 'culprit_found' AND revert_outcome IS NULL` | No |
| `flaky` | `status = 'flaky' AND confirm_reason IN ('flaky_rerun','flaky_next')` | No |
| `flaky_unconfirmed` | `status = 'flaky' AND confirm_reason IS NULL` (D17) | No |
| `dismissed` | `status = 'dismissed'` | No |
| `caught` | `revert_pr_number IS NOT NULL` | Numerator and denominator |
| `would_catch` | `revert_outcome = 'planned'` | Projected: numerator and denominator. Measured: denominator only (it cannot occur in enforce mode; if it does, it counts as missed) |
| `missed` | anything else: `ambiguous`, `no_culprit`, `needs_human`, `error`, and `culprit_found` with outcome `skipped` or `error` | Denominator |

- **Measured**: rows with mode `enforce`: `caught / (caught + would_catch + missed)`.
- **Projected**: every row: `(caught + would_catch) / (caught + would_catch + missed)`.
- **Also reported**: counts of every class; `missed` broken down by `status` and, for `culprit_found`, by `revert_outcome`/`revert_reason` (for example `skipped cap_reached`); among `caught`, how many are `reverted`, `revert_closed` and still `revert_opened`, and how many had `auto_merge_state = 'enabled'`. A note says the denominator holds only breakages the guard detected.
- **Minimum sample (measured)**: at least 10 rows in the denominator, from at least 2 repositories.

### 8.5 M4: escaped defects (target: no rise against the baseline)

- **Window population**: the merged population of §8.1, restricted to `merged_at < until − 14 days` (D18). If `until − 14 days ≤ since`, M4 is INSUFFICIENT DATA (`defect_lag`).
- **Incidents of a PR**: `incidents i` with `i.repository_id = ch.repository_id AND i.culprit_pr_number = ch.pr_number` (all sources). Incidents with a null culprit are reported as `unlinked`, never counted.
- **Baseline**: Phase 0's rule (the newest baseline run per repository, its merged rows with `excluded_reason IS NULL`, incidents matched the same way).
- **Criterion (a), all merged PRs**: window `x_w` incidents over `N_w` PRs against baseline `x_b` over `N_b`.
- **Criterion (b), PRs merged on the policy alone**: measured rows of class `auto` (`x_a` over `N_a`) against the baseline.
- **Test** (pure, `src/pilot/stats.ts`, `binomialUpperTail(k, n, p)`): with `n = x + x_b` and `p0 = N / (N + N_b)`, `pValue = P(X ≥ x)` for `X ~ Binomial(n, p0)`, computed exactly in log space. A criterion FAILs when `x / N > x_b / N_b` and `pValue < 0.05`; otherwise it PASSes once its minimum is met.
- **Minimums**: `N_w ≥ 100` and `N_b ≥ 100` for (a); `N_a ≥ 50` for (b). Below → INSUFFICIENT DATA for that criterion.
- **M4** = FAIL if either criterion FAILs, PASS if both PASS, otherwise INSUFFICIENT DATA.
- **Preview**: criterion (b) on every `auto` row, labelled "not a projection: report-mode PRs were reviewed by people".

### 8.6 Reported, not decided

- **Overrides**: `audit_log` rows with `created_at` in the window by `kind` and `policy_mode`.
- **MCP**: active tokens at `until`; PRs opened through MCP = `mcp_changes` rows with `pr_number IS NOT NULL` whose change has `opened_at` in the window (D9 a); `provenance` rows with `source = 'mcp'` and `created_at` in the window; `change_provenance` rows with `mcp_report = 'disagrees'` and `computed_at` in the window.
- **Pilot retention** (MVP: 3 of 5): installations of the report with `created_at ≤ until − 30 days`, not deleted or suspended, with at least one `webhook_deliveries` row (`installation_id` or a repository of it) in `[until − 7 days, until)`. Shown as "retained N of M".
- **Per repository** (`repositories[]`, the runbook's numbers): full name; effective modes at report time (D2's ceiling); for policy and guard, the newest applied `mode_changes` row to `enforce` while the requested value is still `enforce` (`enforceSince`, or null); merged PRs by mode and class (§8.1); `wouldFailAtMerge` = report rows of class `would_fail` by `enforced_reason`; `invalidOrMissingPolicy` = rows with `enforced_reason IN ('no_policy','policy_invalid')`; merged rows of the last 7 days of the window by class (`last7`); break-glass `applied` rows; guard rows by class (§8.4); `needsHuman`; MCP PRs opened; `private`.

### 8.7 Decision (`decidePhase1`, pure)

M1, in this order: if measured `n ≥ 50`, the Wilson upper bound is below 0.30, and at least 3 installations have measured rows → FAIL (`m1_upper_below_target`). Else any minimum of §8.2 not met → INSUFFICIENT DATA (one reason per unmet minimum). Else if `n ≥ 400` → PASS iff the share is at least 0.30 (`m1_point_estimate_decides`). Else PASS iff the share is at least 0.30 and the Wilson lower bound is at least 0.25; otherwise INSUFFICIENT DATA (`m1_inconclusive`).

M2: minimum not met → INSUFFICIENT DATA; `Δ` null → INSUFFICIENT DATA (`m2_baseline_zero`); PASS iff `Δ ≤ −0.50`, otherwise FAIL.

M3: minimum not met → INSUFFICIENT DATA; PASS iff the share is at least 0.80, otherwise FAIL. The Wilson interval is shown.

M4: §8.5.

**Gate verdict**: FAIL if any metric FAILs; PASS if all four PASS; otherwise INSUFFICIENT DATA. **Preview verdict**: the same rules on the projected values, with the measured minimums applied to the projected counts.

Constants live in one exported object `PHASE1` (targets, minimums, `defectLagDays: 14`, `pValue: 0.05`, `pointEstimateFromN: 400`, `lowerSlack: 0.05`). Reason codes: `m1_upper_below_target`, `m1_below_min_merged`, `m1_below_min_installations`, `m1_window_too_short`, `m1_inconclusive`, `m1_point_estimate_decides`, `m2_below_min_rows`, `m2_below_min_repositories`, `m2_baseline_zero`, `m3_below_min_breakages`, `m3_below_min_repositories`, `m4_defect_lag`, `m4_below_min_window`, `m4_below_min_baseline`, `m4_below_min_auto`, `m4_rise`, `pass`.

## 9. The runbook (`docs/pilots/phase-1-runbook.md`)

Write it with these sections, in this order. Every command must exist; every criterion names the `repositories[]` field of the Phase 1 report it reads (U-DOC-3). The runbook is a checklist per repository: the operator copies the stage table into the pilot's record (kept outside git) and fills in dates, who, and the report hash at each stage.

**Roles.** Operator (runs Graft and the CLI), repo admin (branch protection and settings), tech lead (classifies would-be failures and guard comments), product owner (go/no-go and the gate call).

**Stage 0: deployment ready (once per deployment).** Every process (server and workers) runs this step's code; `GRAFT_MODE_CEILING=report`; `GITHUB_APP_SLUG` set; the manifest chosen (full for any repository that will reach stage 4); `/mcp` behind the proxy with `GRAFT_TRUST_PROXY` set to the proxy's addresses; the HUMAN-TODO smoke tests and real-GitHub checks of steps 2 to 6 done and recorded, including the step 3 label-lag and `Link: rel="last"` measurements (D11), the step 4 review 2 finding B check, and the step 5 T1 (b) `sha: null` check. No-go: any of them open.

**Stage 1: install in report mode (day 0).** Phase 0 onboarding §1 to §7 (`docs/pilots/onboarding.md`); `pnpm graft baseline --repo <r> --from <day 0 − 12 weeks> --to <day 0>`; incidents of that period recorded with `pnpm graft incident add`; labels `graft:break-glass` and `graft:revert` created; `pnpm graft mode show --repo <r>`: every mode `report`; `pnpm graft pilot doctor --installation <id>`: no FAIL. Tell the team what the would-be line and the guard comments mean.

**Stage 2: watch (at least 14 days and at least 30 merged PRs).** Weekly: `pnpm graft gate report --phase 1 --installation <id> --since <day 0> --out <dir>`; the tech lead opens every PR counted in `wouldFailAtMerge` and every guard comment, and classifies each as "Graft right" (the policy says what the team wants and the PR really lacked it) or "Graft wrong" (policy misconfigured or a Graft defect). Before stage 3 the team also encodes any CODEOWNERS approval rule it relies on in `graft.yaml` (stage 3 drops CODEOWNERS review). **Go to stage 3** when all hold:
1. `merged.total ≥ 30` and the window is at least 14 days;
2. `wouldFailAtMerge.total / merged.total ≤ 0.10`, and no "Graft wrong" case among the last 7 days' PRs;
3. `invalidOrMissingPolicy = 0` in `last7`;
4. if the policy names a team: `members: read` granted (`pnpm graft mode show` has no teams note) and no `would_fail` with reason `approvals_missing` caused by an unverified team in `last7` (checked from the check details);
5. `pilot doctor`: no FAIL, and no WARN in `modes`, `permissions`, `teams`, `public_enforce`;
6. the repository does not use a merge queue and is private or internal (`private = true`); a public repository stays in report (D10);
7. the team has named who may use `graft:break-glass`.

No-go: fix the policy or report the defect; the last 7 days must then meet 2 and 3 again.

**Stage 3: enforce `policy_mode`.** In this order:
1. Operator, once per deployment: set `GRAFT_MODE_CEILING=enforce` while **no repository requests enforce** (so the raise changes nothing), restart every process, check `pnpm graft mode show`: ceiling `enforce` from the worker.
2. Repo admin: make `graft/policy` a required status check with **the Graft App as the expected source**. Keep the existing required reviewers.
3. Operator: `pnpm graft mode set --repo <r> --policy enforce --reason "pilot stage 3"`; within about a minute `mode show` says `effective enforce`, and an open PR's `graft/policy` is `success` or `failure`.
4. Two working days with both protections. Go to 5 when every `failure` the team reported was explained by the policy and no check stayed `in_progress` past the card wait.
5. Repo admin: drop "Require approvals" and "Require review from Code Owners" from branch protection (spec fix 1). `graft/policy` is now what counts approvals.
6. Watch 14 days. **Stay** while: no merged PR that the tech lead classifies as approved by Graft when the policy should have required a human; at most 1 incident linked to a PR of class `auto` in the stage; `mergedWhileFailing = 0` unless each was a deliberate admin bypass.

**Rollback of stage 3** (any no-go above, or on request). Order matters, because `neutral` passes a required check:
1. Repo admin: restore "Require approvals" (and Code Owners review if it was used).
2. Operator: `pnpm graft mode set --repo <r> --policy report --reason "rollback: <why>"`; check `mode show` and that open PRs are `neutral` within about a minute.
3. Leave `graft/policy` required or remove it; neutral passes either way.

**Emergency** (Graft down or every check stuck `in_progress`): the repo admin restores required reviewers and removes `graft/policy` from the required checks; then the operator rolls back as above, or `GRAFT_MODE_CEILING=report` and a restart for every repository at once (D2 makes a rolling restart safe).

**Stage 4: enforce `guard_mode` (not before 14 days in stage 3).** Prerequisites: the full manifest with `contents: write` accepted and `pnpm graft mode refresh-permissions --installation <id>` run; "Automatically delete head branches" on; the default branch has required checks (so revert PRs are tested); in stage 2 and 3, no guard comment classified "Graft wrong" in the last 14 days (`guard.missed` and `guard.caught` are not criteria: a quiet `main` is fine). Then `pnpm graft mode set --repo <r> --guard enforce --reason "pilot stage 4"`. Stay while no revert PR blames the wrong PR. Rollback: `mode set --guard report`; close unwanted open revert PRs by hand and turn off their auto-merge in the GitHub UI (Graft never disables it); deployment-wide, `GRAFT_GUARD_REVERT=off` and a restart.

**Stage 5: auto-merged reverts (optional, D12).** Only after 14 days in stage 4 with `guard.caught ≥ 3` and no wrong revert; only `guard.auto_merge_reverts: [trivial]`, added in a reviewed PR; only if `.github/workflows/` changes require a review (CODEOWNERS or a ruleset) and "Allow auto-merge" is on. Rollback: remove the key in a reviewed PR.

**Stage 6: `mcp_write` (optional, any time after stage 3).** Tokens issued only to agents that already have read access, one per repository (`pnpm graft mcp-token create`); reads used for at least 7 days; the agents that will call `open_change` sign their commits (D8: otherwise no approval on their PRs counts). Then `pnpm graft mode set --repo <r> --mcp-write on --reason "pilot stage 6"`. Rollback: `mode set --mcp-write off`; a leaked token: `pnpm graft mcp-token revoke`; deployment-wide: `GRAFT_MCP=off`.

**Gate review (weekly, product owner and operator).** `pnpm graft baseline --period phase1 --repo <r> --from <since> --to <until>` per pilot repository, then `pnpm graft gate report --phase 1 --installation …` for all five pilots. Read the gate verdict, the preview, and the per-repository table. The calling rule is in HUMAN-TODO (§14).

## 10. CLI and report

```sh
pnpm graft gate report --phase 1 --installation 123 [--installation 456 ...] --since 2026-12-01 [--until 2027-01-26]
                       [--out ~/graft-reports] [--json] [--check]
pnpm graft baseline --repo acme/api --from 2026-12-01 --to 2027-01-26 --period phase1
pnpm graft mode set --repo acme/oss --policy enforce --reason "…" --public
```

`--phase` takes `0` (default) or `1`. With `--phase 1`, `--check` exits 0 on a gate PASS, 1 on FAIL and 4 on INSUFFICIENT DATA; the preview never changes the exit code. The JSON has `schemaVersion: 1`, `phase: 1`, `window`, `installations`, `verdict`, `reasons`, `preview: { verdict, reasons }`, `metrics: { m1, m2, m3, m4 }` (each with `measured`, `projected`, the counts of §8 and its own verdict), `overrides`, `mcp`, `retention`, `repositories[]` and `runs[]`. Markdown sketch:

```md
# Graft Phase 1 gate — 2026-12-01 to 2027-01-26

**Verdict: INSUFFICIENT DATA** — m3_below_min_breakages (6 of 10)
**Preview (projected from report mode): PASS**

Installations: 123 (acme, 2 repos), … Data through 2027-01-25. Retained 4 of 5 (target 3 of 5; not part of the verdict).

| Metric | Target | Measured (enforce) | Projected (all) | Verdict |
| M1 merged with no human | ≥ 30% | 34.1% (n 412, Wilson 29.7–38.8%) | 36.0% (n 655) | PASS |
| M2 agent review minutes p50 | ≤ −50% | 212 → 88 min, −58% (n 140 / 96) | −61% | PASS |
| M3 breakages caught | ≥ 80% | 5 of 6, 83% (Wilson 44–97%) | 9 of 11, 82% | INSUFFICIENT DATA |
| M4 escaped defects | no rise | all 0.9 vs 1.1 per 100 (p 0.71); auto 0.6 (p 0.83) | — | PASS |

## M3 detail | open 1 | flaky 3 | flaky (unconfirmed) 2, not counted | missed: needs_human 1 …
## Per repository | acme/api: policy enforce since 2026-12-15 … would fail at merge 2 of 48 …
```

## 11. Schema (migration `0016_phase1_gate`)

`0016` is the number after step 6's `0015`; renumber if another migration lands first.

```sql
ALTER TABLE review_time_runs DROP CONSTRAINT review_time_runs_period_check,
  ADD CONSTRAINT review_time_runs_period_check CHECK (period IN ('baseline','shadow','phase1'));
```

Check the constraint name `0006` really produced and use it. `down` restores the two-value CHECK and fails if a `phase1` row exists (the rollback test runs on an empty table). Nothing else is stored: D8's `mcpExclusion` lives in the existing `policy_verdicts.approvals` jsonb, and D13 uses the existing `guard_events.guard_mode`.

**Rendering of D8** (`src/modules/policy/render.ts`): in the approvals block, one line: `unverified`: "Approvals do not count: this PR was opened through MCP and has commits that GitHub has not verified."; `too_many`: "… has more than 250 commits."; `no_author`: "… has commits that GitHub cannot link to an account.". It is part of the rendered text, so the facts hash changes and the check republishes.

## 12. Live e2e: the enforce sandbox (D21)

- `sandboxEntrySchema` (`src/e2e/guard.ts`) gains `mode: z.enum(["report","enforce"]).default("report")`. One run targets one sandbox, as today.
- **Ops calls.** The runner's in-process ops list (live spec D8) gains the read-only `mode show --json` and `audit list`; nothing else.
- **Preflight** (read-only DB and the in-process `mode show --json`): a `report` sandbox must have every mode requested `report`; an `enforce` sandbox must have the worker's ceiling `enforce` and `policy_mode` effective `enforce`, `guard_mode` requested `report` and `mcp_write` `off`. Otherwise refuse with the command the human must run. The runner never calls `mode set`.
- **Setup** for an `enforce` sandbox writes `e2e/fixtures/graft.enforce.yaml` as the starter (`version: 1`, one rule `match: { paths: ["graft-e2e/**"] }` → `require: { humans: 1 }`, no team: a user-owned sandbox has none).
- **Scenario `e01`** (enforce only, needs the outsider token, else skipped): (a) agent commit in `graft-e2e/` and PR E → `graft/policy` `failure`, reason approvals missing; (b) the outsider (a write collaborator in private mode) approves → `success`; (c) the actor pushes a second commit → `failure` (stale approval); (d) the actor (owner, so `admin`) adds `graft:break-glass` → `success`, and the in-process `audit list --repo <sandbox>` shows an `applied` row; (e) the actor pushes again → `failure`. Each step waits for the check on the new head.
- **INV-1E** replaces INV-1 for an `enforce` sandbox: every Graft check on the current head of every open run PR is completed; `graft/provenance` and `graft/intent` are `neutral`; `graft/policy` is `success` or `failure`, equal to the scenario's last expectation for that PR.
- Scenarios `s01` to `s10` and `b1`, `b2` refuse to run against an `enforce` sandbox, and `e01` against a `report` one.

## 13. Test plan

Unit:

| ID | Case |
| --- | --- |
| U-CEIL-1 | `effectiveCeiling`: (enforce, null) → enforce; (enforce, report) → report; (report, enforce) → report; (enforce, "garbage") → report |
| U-CEIL-2 | `modesOf` with `storedCeiling: "report"` and an `enforce` process ceiling gives `ceiling` reasons for every requested enforce mode, and `mcp_write` off |
| U-MG-21 | `?` on every write route (check-run POST and PATCH, comments, `git/trees`, `git/refs`, `pulls`, `labels`, the ref DELETE) → `unknown_route`, for the default, `policy`, `guard` and `mcp` clients; `POST …/pulls?head=main&base=release` with a valid guard body is refused (the step 5 review 2 probe) |
| U-MG-22 | A GET with a query passes; a guard client's `pulls.list` by head still records node ids, and the GraphQL write for that PR is still allowed |
| U-RVC-1 | `guard.revert_closed`: the event becomes `reverted` between the job's read and its update → `settled`, `reverted_at` unchanged (step 5 review 2, nit C) |
| U-FCT-1 | `listCommitLogins`: all verified with real committers → logins (authors and committers); a verified commit committed by `web-flow` → `unverified` (amended by step 7 review 1, finding 2); one commit `verification.verified: false` → `unverified`; `verification` absent → `unverified`; a null committer → `unverified`; 251 commits → `too_many`; a null author → `no_author` |
| U-CFG-40 | `GRAFT_TRUST_PROXY`: empty → off; `10.0.0.1,10.0.0.0/8,::1,fd00::/8` accepted; `true`, `2`, `proxy.local`, `10.0.0.0/33` → `ConfigError` naming the entry index only |
| U-CFG-41 | `GITHUB_APP_SLUG=Graft-Dev` is stored as `graft-dev` (step 6 review 2, nit F) |
| U-P1G-1 | Class table of §8.1: one row per `enforced_reason`, null reason, no verdict |
| U-P1G-2 | M1: 200 measured rows from 3 installations of 20+, share 0.34, lower ≥ 0.25 → PASS; share 0.30 with lower < 0.25 → `m1_inconclusive`; n 400 at 0.30 → PASS `m1_point_estimate_decides`; n 60, upper < 0.30, 3 installations → FAIL; the same from 2 installations → INSUFFICIENT DATA |
| U-P1G-3 | M1 minimums: 199 rows; 2 installations; an installation with 19 rows; a 12-day span → one reason each |
| U-P1G-4 | M2: Δ −0.50 → PASS, −0.49 → FAIL; 29 rows on a side → INSUFFICIENT; one repository → INSUFFICIENT; baseline p50 0 → `m2_baseline_zero` |
| U-P1G-5 | M2 review minutes: merged without review → 0; first approval; no approval → minutes to merge; projection sets a report `auto` row to 0 and leaves an enforce row |
| U-P1G-6 | M3 classes, in order, one case each, including `culprit_found` with no outcome (`open`), `flaky` with null `confirm_reason` (`flaky_unconfirmed`, out of both terms), `revert_closed` (`caught`), `skipped cap_reached` (`missed`), `planned` in enforce (missed in measured) |
| U-P1G-7 | M3: 8 of 10 → PASS; 7 of 10 → FAIL; 9 rows → INSUFFICIENT; 10 rows from one repository → INSUFFICIENT |
| U-P1G-8 | `binomialUpperTail`: pinned values to 1e-12 (`(0,0,0.5)` = 1; `(3,10,0.5)`; `(12,20,0.3)`; `(50,500,0.08)`); M4 (a) rate above with p 0.04 → FAIL `m4_rise`; above with p 0.2 → PASS; below → PASS; 99 window PRs → INSUFFICIENT; (b) with 49 `auto` rows → INSUFFICIENT and M4 INSUFFICIENT |
| U-P1G-9 | Gate and preview combination: any FAIL → FAIL; all PASS → PASS; otherwise INSUFFICIENT; the preview never feeds `--check` |
| U-P1G-10 | Markdown byte for byte for a fixed input; JSON parses with `phase1GateReportSchema` |
| U-P1G-11 | Phase 0 rendering unchanged: U-GATE-11's fixture still renders byte for byte with `--phase` absent and `--phase 0` |
| U-DOC-3 | Every relative link of `docs/pilots/phase-1-runbook.md` resolves; every `pnpm graft …` command in it parses with the ops CLI's argument parser; every `repositories[]` field it names exists in `phase1GateReportSchema` |
| U-LIVE-ENF-1 | `sandboxEntrySchema` defaults `mode` to `report`; an unknown mode is refused |
| U-LIVE-ENF-2 | INV-1E: a neutral `graft/policy` on an enforce sandbox fails; `success` where the scenario expects `failure` fails; a non-neutral `graft/intent` fails |
| U-LIVE-ENF-3 | Scenario selection: `s01` against an enforce sandbox and `e01` against a report one are refused |

Integration:

| ID | Case |
| --- | --- |
| I-CEIL-1 | **Rolling restart, lowered:** `service_state` holds `report`, the process ceiling is `enforce`, the repository requests `enforce`: the policy job publishes `neutral`; a direct non-neutral write through a `policy` client is refused `mode_report`; `open_change` returns `mcp_write_off` with reason `ceiling` |
| I-CEIL-2 | No `service_state` row and a process ceiling `enforce` → enforce (the first start) |
| I-CEIL-3 | **Raise:** stored `enforce`, process `report` → report; `mode show` reports the worker's `enforce` and the shell warning |
| I-REV-10c | Crash after `POST …/pulls` (PR created, not stored), then the installation token fails on the last attempt → the PR is adopted by the lookup: `revert_opened`, `revert_pr_number` set, counted by the cap; the next run labels it; one PR in total |
| I-REV-10d | The ref is created, no PR exists, the last attempt fails → `revert_outcome` stays null; after the job row expires, the next observe re-sends `guard.revert`, which resumes and opens one PR |
| I-REV-10e | Detected, then the clock passes `GRAFT_GUARD_REVERT_MAX_AGE_HOURS`, then confirmed now → plans and opens, not `stale` (step 5 review 2, finding B) |
| I-MCP-1b | The 0015 down keeps PR rows: one PR row and one claim before `migrateDownOne` → exactly the PR row after, and `is_nullable = 'NO'` for `pr_number` and `head_sha` (step 6 review 2, finding A) |
| I-MCP-1c | A row with `pr_number` null and a head → CHECK violation (nit D) |
| I-MCP-2 | (amended) `tools/list` asserts the annotations of all four tools, `report_provenance` included (D7) |
| I-MCP-6b | Unauthenticated `text/plain` → `401` (not `415`); unauthenticated 70 KiB body → `401` (not `413`); a foreign `Origin` with `text/plain` → `403`; with a valid token `text/plain` → `415` and a 70 KiB body → `413` (D5) |
| I-MCP-7b | With `GRAFT_TRUST_PROXY=127.0.0.1`: two clients behind the proxy (`X-Forwarded-For` 10.0.0.2 and 10.0.0.3) have separate failed-auth buckets; from an untrusted peer, `X-Forwarded-For` is ignored (D6) |
| I-MCP-11b | `pulls.create` answers 422 and the lookup returns a `renovate[bot]` PR → `existing: true`, no row; with `graft[bot]` for slug `graft-dev` → no row (nit E) |
| I-MCP-12c | A claim aged 59 minutes counts (the next call at the cap is `rate_limited`) and is not deleted (nit C) |
| I-MCP-14b | An MCP-opened PR with one unverified commit: `bob`'s approval does not count, `approvals.mcpExclusion = 'unverified'`, the policy section has the line; all commits verified → `bob` counts, `alice` (author) does not (D8) |
| I-ROLL-5 | The rollup deletes a claim aged 61 minutes, keeps one aged 59 minutes and every PR row (D9 b) |
| I-MODE-PUB-1 | `mode set --policy enforce` on a `private = false` repository → exit 1, no `mode_changes` row; with `--public` → the row; `--guard enforce` on it needs no flag |
| I-DOC-5 | Doctor `public_enforce` WARN for that repository; OK otherwise; exit 0 |
| I-GRD-MODE-1 | Events settled `ambiguous`, `no_culprit` and `flaky` by observe and confirm carry `guard_mode` (`report` under default modes, `enforce` with the ceiling and `--guard enforce`); a stored value is not overwritten by observe |
| I-DB-16 | Migration up/down/up for `0016`; `baseline --period phase1` stores a `phase1` run; the step-down tests step through `0016` |
| I-P1G-1 | Seeded five installations (changes, verdicts in both modes, guard events, review runs, incidents): every metric equals a hand-computed value; gate PASS, preview PASS |
| I-P1G-2 | Same seed with every verdict in report mode → gate INSUFFICIENT DATA (no measured rows), preview PASS; `--check` exits 4 |
| I-P1G-3 | Merge-head verdict: an older verdict for the head with `approved_by_policy` and a newer one with `approvals_missing` → class `would_fail`; a verdict for an older head is ignored |
| I-P1G-4 | Exclusions: an excluded author, a Graft revert PR (a guard event's `revert_pr_number`), a removed repository, a third installation → in no count |
| I-P1G-5 | M2 pairing: a repository with only a `phase1` run is left out; the newest run per period is used; projected zeros |
| I-P1G-6 | M4: an incident on a PR merged 10 days before `until` is not counted (lag); a null-culprit incident is `unlinked` |
| I-P1G-7 | MCP: a claim row and an adopted double row for one PR count one PR opened; open time from `changes.opened_at` (D9 a) |
| I-P1G-8 | `repositories[]`: `enforceSince` after enforce → report → enforce is the last enforce; `wouldFailAtMerge` by reason; `last7` |
| I-P1G-9 | Neither file nor stdout contains a seeded login, title, body or path (sentinels in every text column of the seed); `--out` writes mode 0600 |
| I-P1G-10 | `--phase 1 --allow-file x` → exit 2; `--phase 2` → exit 2 |
| I-LIVE-ENF-1 | Offline world, enforce sandbox, outsider token: `e01` passes with INV-1E; with the world's hook turning the final `graft/policy` neutral, INV-1E fails and the report names it |

Neutral suite: **N-17** (both profiles): `service_state('mode_ceiling')` set to `report` while the app runs with the profile's process ceiling (`enforce` in `max`). Every scenario of the suite runs again; the mutating requests are exactly the Phase 0 set (check runs neutral, the managed comment, guard comments), no feature client is created, and no refusal is logged. This is the old-worker case of D2.

## 14. HUMAN-TODO (add a section "Step 7: security review, pilots and gate" to `docs/phase-1/HUMAN-TODO.md`)

Also replace the step 2 item "To lower `GRAFT_MODE_CEILING`, stop every worker before starting the new one" with: "Until every server and worker runs the step 7 build, lower `GRAFT_MODE_CEILING` with a full stop. After that, a rolling restart is safe (step 7, D2)." And mark the step 2 public-repository item as decided by step 7 D10.

- [ ] **Read the security review** (`docs/phase-1/reviews/step-7-security-review.md`) and sign off its verdict before any repository leaves stage 2. Who: product owner.
- [ ] **Recruit three more pilot teams**, so five installations take part (development plan, "Where the 5 pilot teams come from"), and onboard each with Phase 0 onboarding and runbook stage 1. Who: product owner.
- [ ] **Set `GRAFT_TRUST_PROXY`** to the proxy's addresses on every server process, and check with two clients that one's bad tokens do not lock the other out. Who: operator.
- [ ] **Check on real GitHub** that `GET …/pulls/{n}/commits` returns `commit.verification.verified` for signed commits from an agent's SSH or GPG key, and `false` for unsigned ones (D8). Who: operator.
- [ ] **Have every agent that uses `open_change` sign its commits** (SSH signing key on the agent's GitHub account). Who: product owner, with each pilot.
- [ ] **Run the runbook per pilot repository** and keep its stage record outside git. Who: operator, repo admin, tech lead.
- [ ] **Weekly gate review**: `baseline --period phase1` per repository, `gate report --phase 1` for the five installations, the runbook's stage checks, a short note. Who: product owner and operator.
- [ ] **Calling the Phase 1 gate.** Call it at the first weekly review where the gate verdict (measured, not the preview) is PASS or FAIL and at least 4 weeks after the third pilot entered stage 3. If it is still INSUFFICIENT DATA 8 weeks after that, decide with the pilots whether to extend 2 weeks or record a FAIL for lack of enforcement. Judge pilot retention (reported, target 3 of 5) at the same time. Record the verdict, window, the four measured values, retention and the report's SHA-256 in `docs/plan/development-plan.md`. Who: product owner.
- [ ] **Run the enforce sandbox once**: add the sandbox entry with `"mode": "enforce"`, set the ceiling and `--policy enforce` for it, run `pnpm graft e2e run` (`e01`), then roll the sandbox back to report. Who: repo owner.
- [ ] **Run the step 7 manual smoke test** (§15) and record it in the PR description. Who: operator.

## 15. Tasks and definition of done

### Tasks

- **T1. Security review.** Write the document of D1 as you go; finish it last, after T2 to T9, with every probe re-run on the final commit.
- **T2. Ceiling (H1).** D2, I-CEIL, U-CEIL, N-17. `docs/features/modes.md` "Rolling back": the full-stop paragraph becomes the D2 rule and its residual. `docs/architecture.md` modes contract: the ceiling sentence.
- **T3. Mutation guard (H2).** D3, U-MG-21, U-MG-22.
- **T4. Revert job (H3).** D4 and the three tests; `docs/features/guard.md`'s "a revert whose writes already began is finished whatever its age" is now true; say so in decisions.md.
- **T5. MCP (H4, H5, H6, H7).** D5 to D9; `docs/features/mcp.md` (rate limits behind a proxy, verified commits, the two residual risks marked resolved), `docs/configuration.md` (`GRAFT_TRUST_PROXY`, `GITHUB_APP_SLUG` lowercased), `.env.example`.
- **T6. Public repositories (H8).** D10, the doctor check, `docs/features/modes.md`.
- **T7. Guard mode at settlement (H9).** D13.
- **T8. Phase 1 gate.** D14 to D19, §8, §10, §11; `docs/features/pilots-and-gate.md` gains "The Phase 1 gate" with the metric definitions in prose.
- **T9. Live e2e enforce sandbox.** D21, §12; `docs/e2e/runbook.md` gains the enforce sandbox section.
- **T10. Runbook.** D20, §9; onboarding §8 and §9 link to it.
- **T11. Docs.** `docs/decisions.md` "Phase 1 step 7: security review, pilots and gate" (every deviation, the accepted D11 and D12, the residual risks of §4); `docs/phase-1/HUMAN-TODO.md` (§14); `docs/phase-1/README.md` step 7 (deviations recorded in decisions.md); `docs/README.md` (the review and the runbook).

### Definition of done

From a clean clone with Docker running, and no network beyond install and the image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test                                  # every ID in §13 present and passing; all earlier IDs still passing
pnpm build
pnpm eval:ci                               # exit 0, baseline unchanged
pnpm db:migrate && pnpm db:status          # every migration up to 0016 applied
pnpm db:rollback && pnpm db:status && pnpm db:migrate   # only 0016 rolled back, then re-applied
grep -rnE "@ts-(ignore|expect-error)" src/ && exit 1 || true
grep -rn "{ feature: \"" src/ | grep -vE "src/modules/(policy/job|guard/revert|mcp/tools/open-change)\.ts" && exit 1 || true
grep -rnE "metrics_daily|rollup" src/pilot/gate-phase1.ts && exit 1 || true          # raw rows only (D14)
grep -n "^Verdict: READY FOR PILOT ENFORCEMENT" docs/phase-1/reviews/step-7-security-review.md   # one line
grep -rn "U-CEIL-\|I-CEIL-\|U-MG-2[12]\|I-REV-10[cde]\|U-RVC-1\|U-FCT-1\|U-CFG-4[01]\|U-P1G-\|I-P1G-\|U-DOC-3\|U-LIVE-ENF-\|I-LIVE-ENF-\|I-MCP-1[bc]\|I-MCP-6b\|I-MCP-7b\|I-MCP-11b\|I-MCP-12c\|I-MCP-14b\|I-ROLL-5\|I-MODE-PUB-1\|I-DOC-5\|I-GRD-MODE-1\|I-DB-16\|N-17" test/ | wc -l   # non-zero
```

**Manual smoke test** (record it in the PR description): with `pnpm dev:server` and `pnpm dev:worker` and the I-P1G seeder, run `pnpm graft gate report --phase 1 --installation <id> --since <date>`: the markdown prints, the preview line is there, and `--check` exits 4 on report-only data. Then start the worker with `GRAFT_MODE_CEILING=report` and the server with `enforce`, request `--mcp-write on` for the seeded repository, and call `open_change` through `curl`: `mcp_write_off` with reason `ceiling`.

**Mutation checks** (the reviewer reverts each one; the named tests must fail):

| Mutation | Caught by |
| --- | --- |
| The gate ignores the stored ceiling (D2 removed) | I-CEIL-1, N-17 |
| A missing `service_state` row read as `report` | I-CEIL-2 |
| The stored ceiling wins over a lower process ceiling | I-CEIL-3, U-CEIL-1 |
| `writePath` drops the query again | U-MG-21 |
| `recordPulls` uses `writePath` (list by head no longer recorded) | U-MG-22 |
| `settleFailedRun` settles `error` after writes began | I-REV-10c, I-REV-10d |
| `isStale` measures from `detected_at` | I-REV-10e |
| `authenticate` back in `preHandler` | I-MCP-6b |
| `trustProxy: true` | I-MCP-7b, U-CFG-40 |
| An unverified commit ignored in `listCommitLogins` | U-FCT-1, I-MCP-14b |
| MCP PR count without `pr_number IS NOT NULL` | I-P1G-7 |
| The rollup purge deletes claims of any age | I-ROLL-5 |
| `--public` not required | I-MODE-PUB-1 |
| Observe does not store `guard_mode` | I-GRD-MODE-1 |
| `flaky` with a null `confirm_reason` counted as a flake or a breakage | U-P1G-6 |
| M1 counts `break_glass` or `requirements_met` as no-human | U-P1G-1, I-P1G-1 |
| The merge-head verdict is the oldest, or any head's | I-P1G-3 |
| Graft revert PRs counted in M1 | I-P1G-4 |
| M2 projection applied to enforce rows | U-P1G-5 |
| M4 without the 14-day lag | I-P1G-6 |
| The gate verdict computed from projected values | I-P1G-2, U-P1G-9 |
| INV-1E accepts a neutral `graft/policy` | U-LIVE-ENF-2 |

**Also required:**
- Every non-GET request in every test log is a Phase 0 route with a neutral body, or a Phase 1 route through its feature client with the mode allowing it. No request path of a write carries a query.
- No log line, job payload, column, report or error message holds a token, a login of a reviewer or voter, PR text, a path list or YAML.
- The live e2e runner's INV-1 still holds with the default (report) sandbox.
- The security review's verdict is `READY FOR PILOT ENFORCEMENT`, and every finding has a status.
