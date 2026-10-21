# Phase 1, Step 2: Approvals Graft can enforce

Spec for the developer agent. Implement exactly this. Where it is silent, choose the simplest option and record it in [docs/decisions.md](../decisions.md) under a new heading "Phase 1 step 2: approvals". The [Phase 0 constraints](../phase-0/README.md#constraints-for-every-step) are binding: offline build and test, Postgres from `docker compose`, **no stored code, diffs or file contents**, pnpm, Node 24, strict TypeScript. The code as it is after step 1 is described in [docs/architecture.md](../architecture.md) (including "Modes contract (Phase 1 step 1)") and [docs/decisions.md](../decisions.md). Where this spec and those documents disagree on an existing interface, they win and you record the difference. The plan for the whole phase is [phase-1/README.md](README.md). Step 1 is [step-1-modes.md](step-1-modes.md).

Binding rules from earlier steps:
- **Payloads are triggers** ([architecture.md](../architecture.md#webhook-replay)). Team, membership and review facts are read from the API inside the job, never from a webhook payload.
- **Lock discipline**: no slow work inside `withChangeLock`. Every API call in this step (permissions, teams, memberships) happens before the lock.
- **Spec fix 1** (development plan): a passing `graft/policy` check is not a human approval. Graft never submits a review and never dismisses one.
- **Report mode is the default and stays inert.** With default modes, every Graft check still concludes `neutral` and the set of GitHub writes is still exactly the Phase 0 set (step 1 T10).
- **Fail closed.** Anything Graft cannot verify (a team, a permission, a review list that is too long) never counts toward satisfying a constraint.

## 1. Goal

Make `graft/policy` a check that can be made required, for repositories whose effective `policy_mode` is `enforce`, and show what it would conclude everywhere else:

- **Counted approvals.** An approval counts only if it is the reviewer's latest review, it was submitted on the current head SHA, and the reviewer has write access or more on the repository. The reviewer must also not be the PR author and not a bot. Approvals on an older head are **stale**: shown, never counted, never dismissed (§5).
- **Team constraints.** A `require: { team: … }` constraint is satisfied only by counted approvers whose active membership in one of the named teams Graft verified through the API (`members: read`). A team that does not exist, cannot be read, belongs to a user account, or that Graft has no permission to read is **unverified** and never satisfied (§6).
- **Outstanding change requests.** A reviewer with write access whose latest review is `CHANGES_REQUESTED` makes the enforce conclusion `failure` until they approve or the review is dismissed. This replaces the branch protection rule the team turns off (D5).
- **The enforce conclusion.** One pure function maps the policy state, the verdict and the counted approvals to `success`, `failure` or `pending` (§7). It is computed and stored in every mode as `enforced_conclusion`. It is published only when the effective `policy_mode` is `enforce`.
- **Waiting for the card.** In enforce mode, while the intent card for the head is still being written, the check is published `in_progress` for at most `GRAFT_POLICY_CARD_WAIT_SECONDS`. After that it is evaluated with the conservative rules that already apply to a pending card (D9).
- **The guard learns about conclusions.** A check run write whose body is not `completed` + `neutral` becomes a Phase 1 write. It is allowed only for `graft/policy`, only through a client made for the `policy` feature, and only when the effective `policy_mode` is `enforce` (§8).
- **Re-evaluation** on team and membership changes, in addition to the existing triggers (§10).
- **Modes reset on transfer.** A repository that moves to another installation, or comes back after removal, returns to report/off with an audit row (D13, the follow-up from step 1 review 2).

## 2. Out of scope

Do not create stub code for any of these.

- Break-glass, the `audit_log` table, `graft audit list` (step 3).
- Guard detection, revert PRs, `actions`, `statuses`, `contents: write` (steps 4 and 5).
- The MCP server (step 6). `get_status` will read `enforced_conclusion`. Nothing here is built for it.
- Gate metrics from would-be conclusions, the rollout runbook and enforce-mode live e2e scenarios (step 7). This step only stores `enforced_conclusion` so that step 7 can measure it.
- Dismissing stale reviews, submitting reviews, requesting reviewers, changing branch protection. Graft never requests `administration`.
- Merge queues (`merge_group` events). A repository that uses a merge queue must stay in report mode (HUMAN-TODO).
- Excluding the last pusher or commit co-authors from approving. Approvals are counted like GitHub counts them (the PR author is excluded, nobody else). Record it in decisions.md as a known limit.
- Re-evaluating on collaborator permission changes (`member` event). A permission change is picked up at the next trigger. Record it.
- Any change to `graft.yaml` syntax. Teams and `humans` already exist (Phase 0 step 5).

## 3. Decisions

| # | Area | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | Missing or invalid policy in enforce mode | `no_policy` and `policy_invalid` conclude `failure` (confirmed 2026-10-21). The check says how to fix it. | A repository that enforces must have a valid policy. A broken file must not open the gate. |
| D2 | Who counts | The latest review per user (Phase 0 D13 rules) whose state is `APPROVED` on the current head, from a user who is not the PR author, not `type: Bot`, and whose collaborator role is `admin`, `maintain` or `write`, or a custom role whose base permission is `admin` or `write`. A 403 or 404 on the permission check means "does not count". | Same bar as GitHub's own required reviews. The triage bar used for reviewer votes (Phase 0 step 6) is too low to approve a merge. |
| D3 | Stale approvals | An approval whose `commit_id` is not the head is stale. It is shown in the comment and the details, never counted, and never dismissed. | Equivalent to "dismiss stale approvals on push" without a new write. |
| D4 | Team verification | Per job, with no cache across jobs. For each team named in a constraint: `GET /orgs/{org}/teams/{team_slug}` once. Then for each counted approver, `GET /orgs/{org}/teams/{team_slug}/memberships/{username}`, stopping as soon as the constraint is met. Only `state: "active"` counts. `{org}` is the repository owner. At most 100 membership requests per job. Past the cap, the remaining checks are `unverified` (`check_limit`). | The plan proposed listing team members with a TTL cache. Checking only the approvers costs a few requests per evaluation, needs no stored team data (team slugs are never stored, Phase 0 D19), and cannot go stale. This is a deviation from README §3 step 2. Record it. |
| D5 | Change requests | A user with write access (D2) whose latest review is `CHANGES_REQUESTED`, on any commit, makes the enforce conclusion `failure` (`changes_requested`). `DISMISSED` or a later `APPROVED` clears it. The PR author and bots are ignored. | Pilot repositories drop required reviewers from branch protection (spec fix 1). Without this rule, a "request changes" would stop blocking anything. |
| D6 | Satisfying constraints | Each constraint of a `would_require` verdict is checked on its own. One approver may satisfy several constraints. A constraint with `teams: []` is met by `humans` counted approvers. A team constraint is met by `humans` counted approvers who are each verified active members of at least one of its teams. The verdict is satisfied when every constraint is met. | Matches CODEOWNERS semantics, where one owner can cover several paths. `humans` on the verdict is already the max over constraints, so the "anyone" constraint covers it. |
| D7 | Truncated reviews | If `listReviews` is truncated (more than 300 reviews), the enforce conclusion is `failure` (`reviews_truncated`). | A later review that was not read could be a dismissal or a change request. Never loosen on missing data. |
| D8 | Conclusion mapping | §7, in one pure function `enforcedConclusion()` in `src/policy/enforce.ts`. Order: `no_policy`, `policy_invalid`, `would_block`, card wait, `reviews_truncated`, `changes_requested`, then `would_approve` → `success`, `would_require` → `success` when all constraints are met, otherwise `failure`. | One place for the semantics. Block and policy errors win over everything. |
| D9 | Card wait | Enforce mode only, on the publish side. When `risk.source` is `card_pending` and the head was first evaluated less than `GRAFT_POLICY_CARD_WAIT_SECONDS` ago (default 600, range 0–3600, 0 = never wait), the enforce conclusion is `pending` and the check is published with `status: "in_progress"` and no conclusion. A `policy.evaluate` with trigger `card_wait` is scheduled at the deadline in every mode. `card_unavailable` never waits. | A pending card is already evaluated on the strict side (Phase 0 D12). Waiting only avoids a `failure` that flips to `success` a minute later and the notification it sends. |
| D10 | Published vs computed | `enforced_conclusion` (`success`, `failure`, `pending`) and `enforced_reason` are stored on every verdict row in every mode. `check_conclusion` stores what was published: `neutral` in report mode, otherwise the enforced conclusion. `pending` is stored there when the check was published `in_progress`. | Pilot stats (step 7) compare "would have failed" with what happened, before anyone enforces. |
| D11 | Guard on check runs | A `POST …/check-runs` or `PATCH …/check-runs/{n}` whose body has `status` other than `completed`, or `conclusion` other than `neutral`, is classified `phase1 [policy]`. It needs `body.name === "graft/policy"`, a client made with `{ feature: "policy" }`, and a gate that allows it (effective `policy_mode` `enforce`). Neutral bodies stay `phase0` and never query the database. | Step 1 guarded routes. Here the same route can block a merge or not depending on its body, so the guard reads the body. Provenance and intent can never block a merge, by construction. |
| D12 | Mode race | The policy job reads the mode before the lock. If the gate refuses the check write with `mode_report` (a rollback committed in between), the job catches `MutationRefusedError`, logs `mode changed during evaluation` at `info` and returns `stale`. The rollback fan-out republishes. Any other refusal still fails the job. | A rollback must not produce error-level noise or retries. Correctness comes from the fan-out (step 1 D6, D7). |
| D13 | Transfer and re-add | When `upsertRepositories` (or any path that reactivates a repository) finds an existing row whose `installation_id` differs from the new one, or whose `removed_at` is set, and any mode key is above its floor, it resets `policy_mode`, `guard_mode` and `mcp_write` to report/report/off in the same statement or transaction. It writes one `mode_changes` row per key that changed, with actor `system` and reason `installation changed` or `repository re-added`, and `applied_at` NULL so `modes.apply` republishes. A rename within the same installation keeps the modes. | Resolves step 1 review 2's follow-up. An `enforce` set for one owner must not follow the repository to another. |
| D14 | Team and membership events | `membership` (added/removed) and `team` (deleted, edited, added_to_repository, removed_from_repository) enqueue one `policy.team_fanout { installationId }` per installation. The singleton key is `policy:team:<installationId>:<floor(now/300 s)>`, with `startAfterSeconds: 60`. The fan-out re-evaluates the open changes of the installation's active repositories whose latest verdict has a constraint with `teamCount > 0` (`jsonb_path_exists`), capped at `FANOUT_MAX`, staggered like the other fan-outs, with trigger `team`. | Payloads are triggers. Team slugs are not stored, so every team-constrained PR of the installation is re-evaluated. Membership changes are rare, and the debounce bounds the cost. |
| D15 | Permission for teams | `members: read` (organization) is added to both manifests (it is read-only). `PERMISSION_NEEDS.policy_mode` stays empty (step 1 D4). Without the permission, team constraints are `unverified` (`no_permission`) and no team request is made. `mode show` and `pilot doctor` say so. | An installation that has not accepted the new permission keeps working. It fails closed only on team constraints. |
| D16 | Collaborator role helper | The permission check in `src/modules/pilot/reviewers.ts` moves to `src/github/collaborator.ts` as `collaboratorRole(octokit, { owner, repo, user })`. It returns `{ role: "admin" \| "maintain" \| "write" \| "triage" \| "read" \| "none", denied: 403 \| 404 \| null }` with the same recycled-login check. Reviewers keep "triage or above" and policy uses "write or above". Step 3 will use "maintain or above". | One implementation of a subtle check (role names, custom roles, recycled logins). |
| D17 | Bounds | At most 20 approvers are permission-checked per job, in login order. The rest are `unverified` (`check_limit`). At most 20 distinct teams are looked up per job, and the rest are `unverified` (`check_limit`). At most 100 membership requests per job. | The cost of one evaluation stays bounded (about 140 GET requests at worst, usually fewer than 10). |
| D18 | Rendering in report mode | Unchanged title. The section gains one line, `**In enforce mode this check would be:** …` (§9). The footer and the approvals line change wording (§9). The details gain an "Approvals counted" block. | Reviewers see exactly what enforcement would do before it is turned on. |

## 4. Files

New:

| File | What |
| --- | --- |
| `src/policy/enforce.ts` | Pure: `ApproverFacts`, `ConstraintStatus`, `satisfyConstraints()`, `enforcedConclusion()`. No `db`, `github` or `modules` imports. |
| `src/github/collaborator.ts` | `collaboratorRole()` (D16), `atLeast(role, min)`. |
| `src/modules/policy/approvals.ts` | `resolveApprovers(octokit, …)`: permission checks, team lookups and memberships within the D17 bounds. Returns `ApproverFacts`. |
| `src/modules/policy/team-fanout.ts` | The `membership` and `team` handlers and the `policy.team_fanout` job (D14). |
| `src/db/migrations/0009_enforce.ts` | §11. |
| `test/unit/policy-enforce.test.ts`, `test/unit/collaborator.test.ts` | §13. |
| `test/integration/policy-enforce.test.ts` | §13. |
| `test/fixtures/webhooks/membership.added.json`, `team.deleted.json` | Trigger fixtures. |

Changed: `src/policy/evaluate.ts` (`countApprovals` returns more, §5), `src/modules/policy/job.ts`, `render.ts`, `store.ts`, `facts.ts`, `handlers.ts`, `index.ts`, `src/modules/pilot/reviewers.ts` (uses the helper), `src/github/mutation-guard.ts`, `src/github/client-factory.ts` (feature `policy`), `src/modules/modes/effective.ts` (gate maps `policy`), `src/modules/modes/cli.ts` (`show` note), `src/modules/installations/store.ts` (D13), `src/config/index.ts`, `src/db/schema.ts`, `src/db/migrations/index.ts`, `src/app/registry.ts`, `src/pilot/doctor.ts`, `github/app-manifest.json`, `github/app-manifest.report.json`, `test/unit/manifest.test.ts`, `test/integration/neutral.test.ts`, the GitHub fakes (`test/helpers/fake-github-api.ts`, `fake-github-world.ts`), and the docs in T12.

## 5. Approvals (`countApprovals`, extended)

`countApprovals` keeps its Phase 0 rules (latest per user among `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`, with bots, null users and the author excluded) and its existing fields. It gains:

```ts
export interface ApprovalCount {
  current: number;
  stale: number;
  users: string[];            // unchanged: current approvers, login order, at most 10
  truncated: boolean;
  /** New: every current approver, login order (the D17 bound is applied later). */
  currentApprovers: { id: number; login: string }[];
  /** New: users whose latest counted review is CHANGES_REQUESTED, any commit, login order. */
  changesRequested: { id: number; login: string }[];
}
```

`resolveApprovers` (in `src/modules/policy/approvals.ts`) turns that into:

```ts
export type Unverified = "no_permission" | "owner_not_org" | "team_not_found" | "team_unreadable" | "check_limit";

export interface ApproverFacts {
  /** Current approvers with write access or more (D2), login order. */
  counted: { id: number; login: string }[];
  /** Current approvers that did not count, with why. Logins only, at most 10 shown. */
  notCounted: { login: string; why: "no_write_access" | "permission_denied" | "check_limit" }[];
  /** Change requesters with write access (D5). */
  changesRequestedBy: string[];
  /** Per team slug: verified active members among `counted`, or why the team is unverified. */
  teams: Record<string, { members: string[] } | { unverified: Unverified }>;
  reviewsTruncated: boolean;
}
```

The team map is built only for teams named in the verdict's constraints, and only when the verdict is `would_require`. The role check happens once per user per job, and a change requester who is also checked as an approver is not checked twice. Owner type comes from `installations.account_type` (not `Organization` → every team `owner_not_org`). Missing `members: read` in the stored installation permissions, or permissions never read, → every team `no_permission`, with no request. A 404 on the team lookup → `team_not_found`. A 403 → `team_unreadable`. A 404 on a membership → not a member. Rate limits and 5xx throw through `toJobError` so the job retries.

`ApproverFacts` is computed in **every** mode, so that report mode shows verified counts. It is computed outside the lock.

## 6. Constraints (`satisfyConstraints`)

```ts
export interface ConstraintStatus {
  humans: number;
  teams: string[];
  rules: number[];
  /** Counted approvers that satisfy it, login order. */
  approvedBy: string[];
  met: boolean;
  /** Teams of this constraint that could not be verified, with why. */
  unverified: { team: string; why: Unverified }[];
}
export function satisfyConstraints(constraints: readonly Constraint[], a: ApproverFacts): ConstraintStatus[];
```

D6, literally. For a team constraint, an approver qualifies if `a.teams[t]` has them in `members` for at least one `t` of `teams`. An unverified team contributes nobody. `approvedBy` is truncated to 10 for display, but `met` uses the full count.

## 7. Enforce conclusion (`enforcedConclusion`)

```ts
export type EnforcedReason =
  | "approved_by_policy" | "requirements_met"                       // success
  | "no_policy" | "policy_invalid" | "blocked" | "reviews_truncated"
  | "changes_requested" | "approvals_missing"                        // failure
  | "card_pending";                                                  // pending
export interface Enforced {
  conclusion: "success" | "failure" | "pending";
  reason: EnforcedReason;
  constraints: ConstraintStatus[];   // [] unless would_require
}
export function enforcedConclusion(i: {
  state: "ok" | "missing" | "invalid";
  verdict: PolicyVerdict | null;
  approvers: ApproverFacts | null;   // null when state !== "ok"
  cardWait: boolean;                 // D9: card_pending and inside the window
}): Enforced;
```

In order, the first that applies:

1. `state === "missing"` → `failure`, `no_policy`.
2. `state === "invalid"` → `failure`, `policy_invalid`.
3. `would_block` → `failure`, `blocked`.
4. `cardWait` → `pending`, `card_pending`.
5. `approvers.reviewsTruncated` → `failure`, `reviews_truncated`.
6. `approvers.changesRequestedBy.length > 0` → `failure`, `changes_requested`.
7. `would_approve` → `success`, `approved_by_policy`.
8. `would_require`: all constraints met → `success`, `requirements_met`. Otherwise → `failure`, `approvals_missing`.

`cardWait` is computed by the job as `config.policyCardWaitSeconds > 0 && verdict.effectiveRisk.source === "card_pending" && now < headFirstEvaluatedAt + wait`. `headFirstEvaluatedAt` is `MIN(policy_verdicts.created_at)` for (change, head), or `factsReadAt` when no row exists yet.

The Phase 0 step 5 examples E1 to E14 each get an expected `Enforced` with no approvals, and a second one with approvals that satisfy them (U-ENF-1). That table goes in the test file, not in this spec.

## 8. Mutation guard extension

- `Feature` becomes `"guard" | "mcp" | "policy"`. `mutationGate` maps `policy` → effective `policy_mode` must be `enforce`, else `mode_report`.
- The route table rows for `POST /repos/{o}/{r}/check-runs` and `PATCH /repos/{o}/{r}/check-runs/{n}` stay `phase0`. A new body rule runs in the hook after classification, for these two routes only. It reads `options.status`, `options.conclusion` and `options.name` from the request options (the body fields Octokit sends). If `status` is present and not `"completed"`, or `conclusion` is present and not `"neutral"`, the request is treated as `phase1 [policy]`:
  - `options.name !== "graft/policy"` → refuse `feature_not_allowed`;
  - no feature on the client → `no_feature`; a feature other than `policy` → `feature_not_allowed`;
  - otherwise the gate decides.
- T1 checks that these fields are visible in `hook.before("request")` for `octokit.rest.checks.create`, `checks.update` and `octokit.request("PATCH …")`. If they are nested (for example under `data` or `body`), read them from there and record it. If a body field cannot be read reliably, the write is refused (`unknown_route`): never assume neutral.
- The error message still never contains the body (step 1 D13). It names the route template and adds `(non-neutral check run)`.
- The policy job always uses `ctx.github.forInstallation(id, { feature: "policy" })`. Provenance and intent keep the default client, so a non-neutral body from them is refused in every mode.

## 9. Policy job and rendering

**Job** (`evaluatePolicyJobRun`), in addition to step 1:

- After `countApprovals`, call `resolveApprovers` (only when `loaded.status === "ok"`). Then `satisfyConstraints` and `enforcedConclusion`, still outside the lock.
- `published = modes.policy.effective === "enforce" ? enforced : null`. The check body:
  - report: unchanged, `status: "completed"`, `conclusion: "neutral"`, keeping the existing comment that says it is never derived from the outcome;
  - enforce, `pending`: `status: "in_progress"`, no `conclusion`, no `completed_at`;
  - enforce, `success` or `failure`: `status: "completed"`, `conclusion: enforced.conclusion`.
  The only place that names a non-neutral conclusion is `src/policy/enforce.ts`. The job passes the value through (DoD grep).
- `factsHash` gains `enforced` (conclusion, reason, constraint `met` and counts) and `published` (the status and conclusion actually sent). A mode flip with frozen rendering must still republish (I-ENF-9).
- `VerdictValues` gains `enforcedConclusion`, `enforcedReason` and `checkConclusion` (D10). `approvals` stores `{ ...ApprovalCount minus currentApprovers/changesRequested, counted: n, notCounted: n, changesRequested: n, constraints: [{ humans, teamCount, met, approved: n, unverified: [why…] }] }`. Counts only: no team slugs (Phase 0 D19 storage rule) and no logins beyond the existing `users`.
- After publishing (or on `unchanged`), if `cardWait`, send `policy.evaluate` with trigger `card_wait`, `startAfterSeconds` = seconds left (at least 1), singleton `policy:cardwait:<changeId>:<headSha>`. This happens in every mode.
- D12: catch `MutationRefusedError` with `refusal === "mode_report"` around the publish → `stale`.
- `POLICY_TRIGGERS` gains `"team"` and `"card_wait"`.

**Rendering** (`render.ts`). Report-mode titles do not change. Enforce mode changes the title:

| Enforced | Enforce-mode title |
| --- | --- |
| success, `approved_by_policy` | `Policy satisfied: no review required` |
| success, `requirements_met` | `Policy satisfied: required approvals present` |
| failure, `approvals_missing` | `Needs 1 more approval from @acme/security` (the existing team wording; several constraints: `Needs approvals: 1 from @acme/security, 1 more from anyone`) |
| failure, `changes_requested` | `Changes requested by alice` (first login, `and N more`) |
| failure, `blocked` | the existing `Would block` title without "Would": `Blocked by rule 3` |
| failure, `no_policy` / `policy_invalid` / `reviews_truncated` | `No valid graft.yaml on main` / same / `Too many reviews to count (over 300)` |
| pending | `Waiting for the intent card` |

- **Mode line** (first line of `output.text`). The report line is unchanged. The enforce line becomes `Graft mode: enforce. This check passes or fails on this policy; a passing check is not a review approval.`
- **Section footer** (the Phase 0 `PHASE0` constant). Report: `Graft mode: report. Graft approves and blocks nothing here.` Enforce: `Graft mode: enforce. This check is required only if branch protection says so.` The ` · report only` headline suffix stays in report mode and is dropped in enforce mode.
- **Would-be line**, report mode only, right after the headline: `**In enforce mode this check would be:** \`failure\`, needs 1 more approval from \`@acme/security\`.` For success: `` `success` (no review required) `` or `` `success` (required approvals present) ``. For pending: `` `pending` (waiting for the intent card) ``. Same wording source as the enforce title.
- **Approvals line**: `**Approvals so far:** 2 on this head (\`alice\`, \`bob\`), 1 on an older commit; 1 counts (write access).` The Phase 0 sentence "Team membership is not checked in Phase 0." is removed. When a change request is outstanding, add `Changes requested by \`carol\`.`
- **Details** gain an `**Approvals counted**` block after "Facts used", one bullet per constraint: `- 1 of 2 from \`@acme/security\`: \`alice\`` / `- 1 of 1 from anyone: \`bob\`` / `- 0 of 1 from \`@acme/infra\`: cannot verify \`@acme/infra\` (the App has no members: read permission)`. One bullet per `notCounted` reason group: `- not counted: \`dave\` (no write access)`. Team names are always code spans (Phase 0 D19). Logins go through `codeSpan`.

Changing the footer and the approvals line changes the rendered text, and so the facts hash, of every open PR. Each PR is republished once, at its next evaluation (not proactively). Record this in decisions.md.

## 10. Triggers

Existing, unchanged: PR opened/synchronize/reopened/edited/labeled/unlabeled, review submitted/dismissed, `check_run.rerequested`, base push fan-out, card and provenance signals, mode fan-outs. New: `card_wait` (§9) and `team` (D14). `team-fanout.ts` registers handlers for `membership.added`, `membership.removed`, `team.deleted`, `team.edited`, `team.added_to_repository` and `team.removed_from_repository`. They parse only `installation.id`, check the installation is active, and enqueue. The fan-out job selects:

```sql
SELECT c.repository_id, r.full_name, c.pr_number
FROM changes c JOIN repositories r ON r.id = c.repository_id
WHERE r.installation_id = $1 AND r.removed_at IS NULL AND c.state = 'open'
  AND EXISTS (SELECT 1 FROM policy_verdicts v
              WHERE v.change_id = c.id AND v.head_sha = c.head_sha
                AND jsonb_path_exists(v.required, '$.constraints[*] ? (@.teamCount > 0)'))
ORDER BY c.pr_updated_at DESC NULLS LAST, c.pr_number DESC
LIMIT 101
```

## 11. Schema (migration `0009_enforce`)

```sql
ALTER TABLE policy_verdicts
  ADD COLUMN enforced_conclusion text CHECK (enforced_conclusion IN ('success','failure','pending')),
  ADD COLUMN enforced_reason     text CHECK (enforced_reason IN (
    'approved_by_policy','requirements_met','no_policy','policy_invalid','blocked',
    'reviews_truncated','changes_requested','approvals_missing','card_pending')),
  ADD CHECK ((enforced_conclusion IS NULL) = (enforced_reason IS NULL));

-- check_conclusion gains 'pending' (published in_progress). The 0005 CHECK is inline and unnamed,
-- so Postgres named it policy_verdicts_check_conclusion_check; the migration asserts that name.
ALTER TABLE policy_verdicts DROP CONSTRAINT policy_verdicts_check_conclusion_check;
ALTER TABLE policy_verdicts ADD CONSTRAINT policy_verdicts_check_conclusion_check
  CHECK (check_conclusion IN ('neutral','success','failure','action_required','pending'));
```

Rows written before this migration keep `enforced_*` NULL ("computed before step 2"). `down` restores the old CHECK. It fails if a `pending` row exists, and the rollback test covers that it runs on a table without one. No new table, so the purge map is unchanged (I-PURGE-2 still passes).

## 12. Tasks

### T1. Library and API verification

Record the answers in decisions.md: (a) where `status`, `conclusion` and `name` appear in the `hook.before("request")` options for `checks.create`, `checks.update` and a raw `request("PATCH …")`; (b) the response shapes, from GitHub's REST docs, of `GET /orgs/{org}/teams/{team_slug}` (404 vs 403) and `GET /orgs/{org}/teams/{team_slug}/memberships/{username}` (`state`, child-team behaviour, 404 for non-members); (c) the payload shape of the `membership` and `team` events, for the handlers' zod schemas (installation id only). The fakes implement what (b) records.

### T2. Config

`GRAFT_POLICY_CARD_WAIT_SECONDS` (integer 0–3600, default 600) → `config.policyCardWaitSeconds`. `.env.example` and `docs/configuration.md`.

### T3. Migration and schema types

§11, plus `PolicyVerdictsTable` types. Rollback test as in earlier steps.

### T4. Pure enforcement

`src/policy/enforce.ts` per §6 and §7. `countApprovals` per §5. No I/O.

### T5. Collaborator helper and approvers

D16 extraction, with no behaviour change for reviewers (their existing tests stay green unchanged). `resolveApprovers` per §5 and D17.

### T6. Guard

§8, plus U-MG cases. The step 1 route table rows do not change.

### T7. Policy job, store, render

§9. `upsertVerdict` writes the new columns.

### T8. Triggers

§10, the `membership` and `team` events in both manifests, and registration in `src/app/registry.ts`.

### T9. Transfer reset

D13 in `src/modules/installations/store.ts`, in the transaction of the installation handler that calls it. `mode history` shows `system` rows like any other.

### T10. Ops and doctor

- `mode show`: when the installation lacks `members: read` (or permissions were never read) and the effective `policy_mode` is `enforce`, add `note: team constraints cannot be verified (no members:read); they will fail`.
- `pilot doctor`: one `warn`, never `fail`: "repositories enforcing policy without members:read". It still reads only the database.

### T11. Neutral suite and manifests

- `test/integration/neutral.test.ts` adds, to the scripted flow of both profiles: a policy with a team constraint, an approval from a team member with write access, an approval from a non-member, an approval on an older head, a `CHANGES_REQUESTED` that is then dismissed, a `membership.added` event, a card that arrives after the PR, and a repository transfer.
- **Default profile:** N-1 to N-3 unchanged. **N-6:** every `policy_verdicts` row has `check_conclusion = 'neutral'` and a non-null `enforced_conclusion`.
- **Max profile:** N-2 becomes **N-2b**. `graft/provenance` and `graft/intent` are always `neutral`. Every non-neutral or `in_progress` check-run write is named `graft/policy` and was sent through a `policy` feature client. N-1 still holds: no route outside the Phase 0 set.
- **N-7** (separate case): a test-only job that sends `checks.create({ name: "graft/policy", conclusion: "failure" })` through the default client is refused (`no_feature`) under both profiles. Through a `policy` client it is refused (`mode_report`) under `default` and sent under `max`. `{ name: "graft/intent", conclusion: "failure" }` through a `policy` client is refused (`feature_not_allowed`) under `max`.
- Manifests: `members: read` in both, events `membership` and `team` in both. U-MAN-2 and U-MAN-3 still pass. **U-MAN-4:** `members` is never above `read`.

### T12. Docs

- `docs/features/policy.md`: what enforce mode concludes and why (§7 table in prose), who counts, stale approvals, change requests, teams and `members: read`, the card wait.
- `docs/features/modes.md`: replace "enforcement is not active in this version" with what enforce now does, plus transfer reset.
- `docs/architecture.md`: extend the modes contract with D11 (the guard reads check-run bodies) and D10.
- `docs/configuration.md`: T2.
- `docs/github-app.md`: the new permission and events, and accepting them on existing installations.
- `docs/decisions.md`: "Phase 1 step 2: approvals" with the T1 answers, the D4 deviation, the known limits from §2 and any other deviation.
- `docs/phase-1/HUMAN-TODO.md`: §14.

## 13. Test plan

Unit (`test/unit/policy-enforce.test.ts`):

| ID | Case |
| --- | --- |
| U-ENF-1 | E1–E14 of Phase 0 step 5 → expected `Enforced` with no approvals and with satisfying approvals |
| U-ENF-2 | `missing` → `failure no_policy`; `invalid` → `failure policy_invalid`, whatever the approvals |
| U-ENF-3 | `would_block` with satisfying approvals and `cardWait` → `failure blocked` |
| U-ENF-4 | `cardWait` with `would_approve` → `pending`; `cardWait` false → `success` |
| U-ENF-5 | Truncated reviews → `failure reviews_truncated` even for `would_approve` |
| U-ENF-6 | One change requester → `failure changes_requested` for `would_approve` and for a met `would_require` |
| U-ENF-7 | Two constraints (`security` ×1, anyone ×2): one security member approves alone → anyone unmet; plus a non-member → both met (one approver counts twice, D6) |
| U-ENF-8 | A team constraint whose only team is unverified is never met, whatever the approvers |
| U-ENF-9 | Constraint with two teams, approver in the second → met |
| U-ENF-10 | Property test: adding an approver never turns `success` into `failure`. Adding a change requester, a block rule match or an unverified team never turns `failure` into `success`. |

Unit (`test/unit/policy-evaluate.test.ts`, additions):

| ID | Case |
| --- | --- |
| U-PA-6 | `currentApprovers` lists every current approver; `users` still capped at 10 |
| U-PA-7 | `changesRequested`: latest review wins; a later `APPROVED` or `DISMISSED` clears; author and bots ignored; any commit counts |

Unit (`test/unit/collaborator.test.ts`):

| ID | Case |
| --- | --- |
| U-COL-1 | `role_name` admin/maintain/write/triage/read map to roles; custom role with base `write` → `write` |
| U-COL-2 | 404 → `none, denied 404`; 403 → `none, denied 403`; 5xx throws a retryable job error |
| U-COL-3 | Response user id differs from the requested id → `none` |
| U-COL-4 | `atLeast` ordering; triage is not write; maintain is write |

Unit (`test/unit/mutation-guard.test.ts`, additions):

| ID | Case |
| --- | --- |
| U-MG-12 | `checks.create` neutral/completed through the default client → passes, gate not called |
| U-MG-13 | `conclusion: "failure"`, `"success"`, `"action_required"`, or `status: "in_progress"` through the default client → `no_feature` |
| U-MG-14 | Same through a `policy` client: gate denies → `mode_report`; allows → sent; gate called once per request |
| U-MG-15 | Non-neutral body with `name` other than `graft/policy`, or no `name` → `feature_not_allowed` |
| U-MG-16 | `guard` or `mcp` client sending a non-neutral check → `feature_not_allowed` |
| U-MG-17 | The refusal message has no body text and no conclusion value |

Unit (`test/unit/policy-render.test.ts`, additions):

| ID | Case |
| --- | --- |
| U-REN-9 | Report mode: titles equal Phase 0 fixtures; the would-be line for each `EnforcedReason` |
| U-REN-10 | Enforce mode: each title of the §9 table; no ` · report only`; the enforce footer and mode line |
| U-REN-11 | Approvals counted block: met, unmet, unverified (each `Unverified` reason), not counted; team names are code spans; no `@` outside code spans |

Integration (`test/integration/policy-enforce.test.ts`, fake GitHub world):

| ID | Case |
| --- | --- |
| I-ENF-1 | Migration up/down/up |
| I-ENF-2 | Report mode: a team-constrained PR with one member approval → check `neutral`, row `enforced_conclusion = success`, `check_conclusion = neutral`, would-be line in the comment |
| I-ENF-3 | Enforce mode (ceiling and repository enforce): same PR → check `success`. A push → new head, the old approval is stale → `failure approvals_missing` |
| I-ENF-4 | Enforce: approver without write access (triage) → not counted, `failure` |
| I-ENF-5 | Enforce: installation without `members: read` → no team request in the fake's log, `failure`, details say why |
| I-ENF-6 | Enforce: team 404 and team 403 → `team_not_found` / `team_unreadable`, `failure` |
| I-ENF-7 | Enforce: `CHANGES_REQUESTED` by a writer → `failure`. `pull_request_review.dismissed` → re-evaluated → `success` |
| I-ENF-8 | Enforce: card pending → `in_progress`. A `card_wait` job is scheduled at the deadline. The card arrives earlier → completed. With no card, the deadline job concludes on the strict facts |
| I-ENF-9 | With `renderPolicyDetails` and `renderPolicySection` frozen (as I-MODE-10 does), a mode flip enforce → report republishes `neutral` (the `published` term of the hash) |
| I-ENF-10 | Rollback race: the mode is set to report between the job's mode read and the publish → job `stale`, no error log, the apply fan-out republishes `neutral` |
| I-ENF-11 | `membership.added` → one `policy.team_fanout` per installation per 5-minute window. Only team-constrained open PRs are re-evaluated, with trigger `team` |
| I-ENF-12 | D17 bounds: 25 approvers → 20 permission checks, 5 `check_limit`. 150 possible memberships → 100 requests |
| I-ENF-13 | Enforce: `no_policy` and `policy_invalid` → `failure` with the fix text. Report mode → `neutral` |
| I-ENF-14 | Truncated reviews (301 in the fake) → `failure reviews_truncated` |
| I-MODE-14 | Transfer: `installation_repositories.added` on a new installation for a repository at enforce → modes reset, three `mode_changes` rows with actor `system`, `applied_at` NULL. Re-add after removal → same with `repository re-added`. Rename in the same installation → modes kept, no row |
| I-MODE-15 | `mode show` prints the `members:read` note. Doctor shows the new warning and still exits 0 |
| I-REV-14 | Reviewer sync after the D16 extraction: its existing outcomes are unchanged (the I-REV suite passes as is) |

Neutral suite: N-1 to N-3, N-2b, N-6, N-7 (T11). Manifest: U-MAN-4.

## 14. HUMAN-TODO (add a section "Step 2: approvals" to `docs/phase-1/HUMAN-TODO.md`)

- [ ] **Accept the new `members: read` permission and the `membership` and `team` events** on every installation, then run `pnpm graft mode refresh-permissions --installation <id>` and check the permissions line. Who: org owner, then operator.
- [ ] **Before any repository enforces:** make `graft/policy` required with the Graft App as the expected source (branch protection "required status checks", source app set). With "any source", a commit status or check named `graft/policy` from another app or a workflow could satisfy it. Who: repo admin.
- [ ] **Do not enforce on a repository that uses a merge queue.** `merge_group` is not handled in Phase 1. Who: operator.
- [ ] **On a sandbox repository with the ceiling at `enforce`:** set `--policy enforce` and check, on one PR, a `failure` with no approval, a `success` after a team member approves, a `failure` after a push (stale), and a `neutral` within about a minute of `mode set --policy report`. Who: repo owner.

## 15. Definition of done

From a clean clone with Docker running, and no network beyond install and the image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test                                  # every ID in §13 present and passing; all earlier IDs still passing
pnpm build
pnpm eval:ci                               # exit 0, baseline unchanged
pnpm db:migrate && pnpm db:status          # 0001..0009 applied
pnpm db:rollback && pnpm db:status && pnpm db:migrate   # only 0009 rolled back, then re-applied
grep -rnE "@ts-(ignore|expect-error)" src/ && exit 1 || true
grep -rnE "from \"\.\./(db|github|modules)" src/modes/ src/policy/enforce.ts && exit 1 || true
grep -rn "new Octokit\|Octokit.defaults" src/ | grep -v src/github/client-factory.ts && exit 1 || true
grep -rnE "conclusion: \"(success|failure|action_required)\"" src/modules/ && exit 1 || true
grep -rnE "\"(success|failure)\" as const" src/modules/ && exit 1 || true
grep -rn "getCollaboratorPermissionLevel" src/ | grep -v src/github/collaborator.ts && exit 1 || true
grep -rn "U-ENF-\|U-COL-\|I-ENF-\|U-MG-1[2-7]\|U-REN-\(9\|1[01]\)\|N-2b\|N-[67]\|U-MAN-4\|I-MODE-1[45]" test/ | wc -l   # non-zero
```

**Manual smoke test** (record it in the PR description):
1. `pnpm dev:server` and `pnpm dev:worker` with `GRAFT_MODE_CEILING` unset. Send `pull_request.opened` and `pull_request_review.submitted` for the fixture repository with a team-constrained `graft.yaml`. The check is `neutral`, and the comment has the would-be line.
2. Restart the worker with `GRAFT_MODE_CEILING=enforce`, then `pnpm graft mode set --repo <fixture> --policy enforce --reason "smoke"`. Within a minute the check is republished with a non-neutral conclusion (offline: the fake or the logged request).
3. `pnpm graft mode set --repo <fixture> --policy report --reason "rollback"`. Within a minute it is `neutral` again.

**Mutation checks** (the reviewer reverts each one; the named tests must fail):

| Mutation | Caught by |
| --- | --- |
| Stale approvals counted | I-ENF-3, U-ENF-1 |
| Triage counts as write | U-COL-4, I-ENF-4 |
| Unverified team treated as satisfied | U-ENF-8, I-ENF-5, I-ENF-6 |
| Change requests ignored | U-ENF-6, I-ENF-7 |
| `no_policy` concludes `success` or `neutral` in enforce | U-ENF-2, I-ENF-13 |
| Truncated reviews ignored | U-ENF-5, I-ENF-14 |
| Guard ignores the body (non-neutral check passes as `phase0`) | U-MG-13, N-7 |
| Guard lets a non-`graft/policy` check be non-neutral | U-MG-15, N-7 |
| Conclusion published from `enforced` in report mode | N-2, N-6, I-ENF-2 |
| `published` removed from `factsHash` | I-ENF-9 |
| `MutationRefusedError` rethrown on `mode_report` | I-ENF-10 |
| Modes kept on transfer | I-MODE-14 |
| Team fan-out ignores `teamCount` | I-ENF-11 |

N-4 note for the reviewer (step 1 review finding 6): the mode line is still rendered into the details, so N-4 still cannot isolate `policyMode` in the hash. I-MODE-10 remains its catcher, and I-ENF-9 catches the new `published` term the same way.

**Also required:**
- No log line, job payload, column or error message holds a token, a request body, PR text, YAML or a team slug. Logins appear only where Phase 0 already stores them (`approvals.users`) and in rendered output.
- With default modes, no PR anywhere changes conclusion. Only the wording of the policy section and details changes (§9).
- The Phase 0 live e2e runner's INV-1 still holds with the default sandbox (no runner change in this step).
