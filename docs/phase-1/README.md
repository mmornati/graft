# Phase 1 — enforce, with report mode kept as the default

Phase 1 is the second half of the [development plan](../plan/development-plan.md#phase-1-enforce-weeks-712) (weeks 7–12): `graft/policy` becomes a check you can make required, approvals are counted for real (teams, stale approvals, break-glass), a post-merge guard watches `main` and opens revert PRs, and agents get a small MCP API. There is no Phase 2 work in it: grouping and ranking candidate PRs by task ID stays out of scope (spec fix 2).

**The rule that shapes this plan:** every Phase 1 feature ships with a **report mode**, and report mode is the default. In report mode Graft computes everything Phase 1 computes (team approvals, stale approvals, break-glass, culprits, revert plans) and *shows* what it would do, but it publishes the same neutral, non-blocking results Phase 0 does and makes no new kind of write to GitHub. A team can install the Phase 1 build next to its existing branch protection, watch it for weeks, and nothing changes for them until an operator turns enforcement on for that one repository.

Steps are built with the same loop as Phase 0 (spec → build → review → fix, see [phase-0/README.md](../phase-0/README.md)), and the [Phase 0 constraints](../phase-0/README.md#constraints-for-every-step) still bind: offline build and test, fakes for GitHub and Claude, no stored code or diffs, pnpm, Node 24, strict TypeScript.

## 1. Modes

Each repository has two independent modes, one per feature that can change outcomes on GitHub:

| Mode key | `report` (default) | `enforce` |
| --- | --- | --- |
| `policy_mode` | `graft/policy` concludes `neutral`, as in Phase 0. The summary adds "**In enforce mode this check would be: failure — needs 1 approval from `security`**". Break-glass labels are recorded and shown as "would bypass". | `graft/policy` concludes `success` or `failure` from the verdict and the approvals Graft counts. Break-glass turns it `success` for that head SHA. |
| `guard_mode` | On a red `main`, Graft records a guard event, finds the culprit and comments on the culprit PR "Graft would open a revert of this PR". No branch, no PR. | Graft opens the revert PR, notifies the author or agent, and (if the policy allows it) enables auto-merge on it. |

MCP writes are a third, separate switch (`mcp_write`, default off); MCP reads only need a token (§3, step 6).

**Who can turn enforcement on: two keys, both server-side.**

1. A server ceiling, `GRAFT_MODE_CEILING=report|enforce`, default `report`. With `report`, no repository on this deployment can enforce anything, whatever the database says. This is what a self-hoster who "just wants to try it" never touches.
2. A per-repository setting, changed only through the ops CLI and written to an audit table:

   ```sh
   pnpm graft mode show  --repo owner/name
   pnpm graft mode set   --repo owner/name --policy enforce --reason "pilot week 3"
   pnpm graft mode set   --repo owner/name --policy report --reason "rollback"  # republished within about a minute
   ```

Effective mode = the lower of the two. `graft.yaml` can **not** raise a mode: it lives in the repository and the people who merge to it are the people being gated. (It can carry settings that only matter once a mode is `enforce`, such as which risk classes may auto-merge reverts; in report mode they are evaluated and shown, never acted on.)

**Rollback is one command.** Setting a repository (or the ceiling) back to `report` fans out a re-evaluation of its open PRs, so every `graft/policy` check is republished as `neutral` within minutes. Branch protection is the human's to change; Graft never has `administration`.

**Missing permissions fall back to report, never to "allow".** Phase 1 asks for new permissions (§4). An installation whose owner has not accepted them yet keeps working: team constraints show as "cannot verify team" and are never satisfied, the guard runs detection only if it can read CI, and a repository set to `guard_mode: enforce` without `contents: write` behaves as `report` and says why in the ops CLI and the guard comment.

## 2. The neutral guarantee, as code

Report mode is only worth something if it is provably inert. Three mechanisms, all built in step 1 before any feature:

1. **A mutation guard on every installation Octokit client.** A request hook (same pattern as the e2e runner's sandbox hook, T6 of the [live e2e spec](../e2e/live-scenarios-spec.md)) classifies each non-GET route. Phase 0 routes (check runs, the managed comment) are always allowed. Phase 1 routes (`POST /git/refs`, `POST /git/commits`, `POST /pulls`, auto-merge GraphQL, review dismissal) throw before sending unless the effective mode for that repository allows them. A bug in a feature cannot leak a write in report mode; it fails a job instead.
2. **Computed vs published conclusion.** `policy_verdicts` gets `enforced_conclusion` (what enforce mode would publish) next to `check_conclusion` (what was published). Report mode publishes `neutral` and stores the would-be conclusion, so the pilot stats can measure "how often would enforce have blocked a PR that was then merged fine" before anyone enforces.
3. **A report-mode regression suite.** One integration test runs every Phase 1 scenario (team approval, stale approval, break-glass, red `main` with a culprit, MCP calls) with the default modes against the fake GitHub world and asserts that the set of mutating requests is exactly the Phase 0 set: check runs and the one managed comment per PR (plus guard comments on culprit PRs). It runs in `pnpm test` on every PR, so any later change that breaks neutrality fails CI.

The live e2e runner keeps its INV-1 invariant ("every Graft check is neutral") for the default sandbox, which stays in report mode. Enforce-mode scenarios run only against a second sandbox explicitly listed as `"mode": "enforce"` in `e2e/sandboxes.json`.

## 3. Steps

Seven steps over six weeks, in the order of the development plan. Each step's feature is usable in report mode at the end of that step, so pilots can watch it before the next one lands.

### Step 1 — Modes and safety rails (week 7, first half)

Detailed spec: [step-1-modes.md](step-1-modes.md). User-facing page: [features/modes.md](../features/modes.md). Human tasks: [HUMAN-TODO.md](HUMAN-TODO.md).


- `GRAFT_MODE_CEILING` in config; migration adding `repositories.policy_mode`, `guard_mode`, `mcp_write` (all defaulting to report/off) and a `mode_changes` audit table (repository, key, from, to, actor, reason, at).
- `pnpm graft mode show|set|history|refresh-permissions`; `set` writes the audit row, and a worker cron applies it by re-evaluating the repository's open PRs (the ops CLI never enqueues).
- `effectiveMode(repo, key)` in one place; every feature reads it from there.
- The Octokit mutation guard (§2.1) and the report-mode regression suite skeleton (§2.3), green on today's Phase 0 behaviour.
- Installation permissions stored from `GET /app/installations/{id}` (read on `installation.created`, `new_permissions_accepted`, daily and on demand; never from a payload), so features can ask "do we have `members: read`?" without a failing API call.
- **Done when:** with the ceiling at `report`, `mode set --policy enforce` succeeds but `mode show` reports the effective mode as `report (ceiling)`; the regression suite passes; no behaviour change on any PR.

### Step 2 — Approvals Graft can enforce (week 7–8)

Detailed spec: [step-2-approvals.md](step-2-approvals.md). It deviates from the bullets below in one place: team membership is checked per approver through the memberships API, with no cache across jobs (its D4).

- **Team membership** (`members: read`): resolve each required team to its members through the org teams API, cached per installation for a short TTL and invalidated on `membership` / `team` events. A team that does not exist, or that Graft cannot read, is "unverified" and never satisfies a constraint (fail closed).
- **Who counts:** an approval counts only from a user with write access or more on the repository (collaborator permission check, already used by the step 6 reviewer sync), not the PR author, not a bot. Approvals on an older head SHA are **stale**: shown, never counted. Graft does not dismiss them (no new write); the existing `countApprovals` split into current and stale is the base.
- **Re-evaluation** on push, review submitted/dismissed, label change, team membership change, and card or provenance completion (most triggers already exist from step 5).
- **Conclusion mapping** for enforce mode: `would_block` → `failure`; `would_require` with constraints unmet → `failure` ("needs 1 more approval from `security`"); all constraints met, or `would_approve` → `success`; `no_policy` / `policy_invalid` → `failure` (a repository that enforces must have a valid policy). A card that is still being written keeps the check `in_progress` up to a timeout, then evaluates with the conservative unknown-risk rules.
- **Report mode output:** the policy section and check summary show the would-be conclusion and the team-verified approval count.
- **Done when:** the policy fixtures of step 5 produce the documented enforce conclusions; with modes at default the check is still neutral everywhere and the regression suite is green.

### Step 3 — Break-glass and audit log (week 8)

Detailed spec: [step-3-break-glass.md](step-3-break-glass.md). It adds one rule the bullets below leave open: the break-glass binds to the head SHA in the signed `labeled` delivery, and is refused when the live head differs (its D4).

- Label `graft:break-glass` (name configurable). On `labeled`, Graft checks the **sender's** permission at that moment: only `maintain` or `admin` counts; anyone else's label is ignored and reported.
- A valid break-glass applies to the head SHA at the time of labelling; a new push needs a new label. It writes an `audit_log` row (repository, PR, head SHA, actor, at, mode), adds a line to the managed comment, and marks the PR for the post-merge guard as "merged under break-glass".
- Report mode: the row is written and the check summary says "would bypass"; the conclusion stays `neutral`.
- `pnpm graft audit list --repo owner/name [--since]` reads the log; pilot purge covers the new table.
- **Done when:** a break-glass by a maintainer flips an enforcing check to `success` for that SHA only; a triage-level label does nothing but log a warning.

### Step 4 — Post-merge guard: detection and culprit (week 9)

Detailed spec: [step-4-guard-detection.md](step-4-guard-detection.md). User-facing page: [features/guard.md](../features/guard.md). It deviates from the bullets below and from §4 in one place: CI results are read through the checks API (Actions jobs are check runs), so the guard needs `statuses: read` but not `actions: read` or the `workflow_run` event (its D2).

- New events: `check_suite` / `workflow_run` / `status` on the default branch (`actions: read`, `statuses: read`). Graft stores per-commit CI results for `main` (commit SHA, check name, conclusion; no logs).
- **Culprit from existing results** (spec fix 3, no re-runs): when a check that was green on commit N−1 is red on commit N and N is the merge of exactly one PR, that PR is the culprit. If several merges landed between the last green and the first red, the event is `ambiguous`: Graft lists the candidates and opens nothing. A check that fails on one commit and passes on the next without a revert is recorded as `flaky` and does not trigger a revert (configurable confirmation: wait for the next commit's result, default on).
- Guard events use the existing `guard_events` table (`detected` → `culprit_found` / `ambiguous` / `dismissed`).
- **Report mode (default):** a comment on the culprit PR ("CI check `test` went red on `main` at `abc1234` after this merge; Graft would open a revert") and an entry in the guard stats. This is the only new write report mode makes, and it is a comment on a PR Graft already comments on.
- **Done when:** fixture histories (single culprit, two merges, flaky, red-before-merge) give the right event and no revert path is reachable in report mode.

### Step 5 — Revert PRs and optional auto-merge (week 10)

Detailed spec: [step-5-revert-prs.md](step-5-revert-prs.md). It adds rules the bullets below leave open: a revert needs a confirmed culprit (never `flaky`, never with confirmation off), a change to `.github/workflows/` is `needs_human` because Graft does not request the `workflows` permission, open revert PRs are capped per repository, and auto-merge also stays off for a missing card or a revert of the policy file (its D3, D8, D13, D14).

- Enforce only, and only with `contents: write`. Graft builds the revert **without reading code**: for a squash or merge commit whose changed files were not touched by any later commit on `main`, the revert tree takes `main`'s tree and points each changed path back at its blob SHA from before the culprit (deleted files restored, added files removed). Blob SHAs pass through the Git Data API; no content is fetched or stored. If any changed file was touched later, Graft does not attempt a merge: it marks the event `needs_human` and comments with the conflict list.
- The revert PR has a fixed title and body, the `graft:revert` label, `Graft-Agent: graft-guard` trailers, and pings the culprit's author (or the agent's task link from provenance).
- **Auto-merge** of reverts, opt-in in `graft.yaml` (`guard: { auto_merge_reverts: [trivial, logic] }`, risk taken from the culprit's card): Graft enables GitHub auto-merge on the revert PR, so branch protection and required checks still decide. Never for `sensitive`; never when the culprit was merged under break-glass.
- **Done when:** in enforce mode on the fake world, a single-culprit failure yields a correct revert tree and PR; with `guard_mode: report` the mutation guard proves no `/git/*` or `/pulls` write is attempted.

### Step 6 — Minimal MCP server (week 11)

Detailed spec: [step-6-mcp-server.md](step-6-mcp-server.md). It uses the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` with `@modelcontextprotocol/node`, stateless streamable HTTP) and adds two rules the bullets below leave open: a `report_provenance` that disagrees with the trailers makes the author fact `unknown` (the strictest value the policy engine has), once per head; and the commit authors of a PR opened by `open_change` cannot approve it (its D13, D14, D19).

- Official TypeScript MCP SDK, streamable HTTP transport, mounted in the existing server under `/mcp`.
- **Per-repository tokens:** `pnpm graft mcp-token create|list|revoke --repo owner/name`; stored as a hash, shown once, scoped to one repository, rate-limited, logged without the token.
- Tools: `get_status` (card, provenance, policy verdict and would-be conclusion, guard events for a PR), `get_policy` (the parsed effective policy and modes for the repository), `report_provenance` (agent, model, task, session link for a PR head; stored as untrusted, exactly like trailers — it can tighten a verdict, never loosen it), `open_change` (open a PR from a branch the agent already pushed, with provenance attached).
- `open_change` creates a PR, so it is the one MCP write to GitHub: available only when `mcp_write` is on for the repository. Reads and `report_provenance` (Graft-side data only) work in report mode.
- **Done when:** an MCP client in an integration test reads status and policy with a valid token, is refused with a revoked or other-repo token, and `open_change` is refused while `mcp_write` is off.
- **Built with these deviations** (see [decisions.md](../decisions.md#phase-1-step-6-mcp-server)): a disagreeing report gives the stricter of the verdicts with the unknown author and with the trailers' author, because an unknown author alone can trade the policy's `default` for a looser `require` rule (D13's "never loosens" did not hold for every policy); the SDK answers a schema-refused argument with a tool error, not JSON-RPC `-32602`; user page: [features/mcp.md](../features/mcp.md).

### Step 7 — Security review, five pilots, gate (week 12)

Detailed spec: [step-7-security-pilots-gate.md](step-7-security-pilots-gate.md). Built: the [security review](reviews/step-7-security-review.md), the [rollout runbook](../pilots/phase-1-runbook.md) and `pnpm graft gate report --phase 1` ([pilots and the gates](../features/pilots-and-gate.md#the-phase-1-gate)); the deviations from the spec are recorded in [decisions.md](../decisions.md#phase-1-step-7-security-review-pilots-gate). It decides what the bullets below leave open: every process honours the lower of its own ceiling and the one the worker stored, so a rolling restart is safe (its D2); writes with a query string, an unauthenticated MCP body and unverified commits on MCP-opened PRs are refused or do not count (D3, D5, D8); enforcing `policy_mode` on a public repository needs `--public` (D10); and each Phase 1 metric is measured from enforce-mode rows and projected from report-mode rows, with the gate decided on the measured values only (D15, §8).

- Security review of everything that writes: the mutation guard, break-glass permission checks, revert tree construction, MCP auth, and the new permissions. Same format as the Phase 0 step 6 security reviews.
- Pilot rollout path per repository, written as a runbook: install with report modes → watch two weeks of would-be conclusions and guard comments → turn `policy_mode` to enforce → the team drops required reviewers and makes `graft/policy` required (spec fix 1, a human step) → later `guard_mode`.
- Extend `gate report` with the Phase 1 metrics from the [spec](../spec/mvp-spec.md#success-metrics-relevant-to-phase-0): share of PRs merged with no human (≥30%), review minutes per agent PR (−50% vs baseline), post-merge breakages caught (≥80%), escaped defects (no rise). In report mode the first three are reported as projections from would-be conclusions and guard events, so the gate can be previewed before anything is enforced. The step 7 spec must count `flaky` events with a null `confirm_reason` ("flaky (unconfirmed)": still undecided at the last confirm attempt) as neither caught breakages nor flakes (step 4 review 2, nit D). Step 5 stores what the metrics need: each event's revert outcome, reason and auto-merge state.

## 4. GitHub App permissions

| Permission / event | Step | Needed in report mode? |
| --- | --- | --- |
| `members: read` (organization) | 2 | Yes, to show verified team approvals. Without it teams are "unverified". |
| `membership`, `team` events | 2 | Yes (cache invalidation). |
| `actions: read`, `statuses: read`; `check_suite`, `workflow_run`, `status` events | 4 | Yes, for detection. |
| `contents: write` | 5 | **No.** Only for revert branches in enforce mode. |

Because GitHub Apps have one permission set, the repository will carry two manifests: `github/app-manifest.json` (full, for enforcing deployments) and `github/app-manifest.report.json` (Phase 0 permissions plus the read-only additions above, no `contents: write`). Someone who only wants to evaluate Graft registers the report manifest and can never be enforced on, by construction. `test/unit/manifest.test.ts` pins both.

## 5. What stays out of Phase 1

- Task grouping and candidate ranking (Phase 2).
- Bisecting with CI re-runs (spec fix 3; off, not built).
- Dismissing stale reviews, changing branch protection, merging non-revert PRs. Graft never requests `administration`.

## 6. Decisions to confirm before step 1

- [x] Modes are set by the operator (ceiling + ops CLI), not by `graft.yaml` (decided 2026-10-19).
- [x] Enforce mode with no or an invalid `graft.yaml` concludes `failure` rather than `neutral` (decided 2026-10-21).
- [x] The guard's only report-mode write is a comment on the culprit PR (decided 2026-10-21). Rejected alternative: no write at all, guard results only in `gate report` and the ops CLI.
- [x] The confirmation rule for flaky `main` checks (wait for the next commit's result) is on by default (decided 2026-10-21).
- [x] Two manifests (full and report-only) rather than one (built in step 1).
