# Phase 1, Step 3: Break-glass and audit log

Spec for the developer agent. Implement exactly this. Where it is silent, choose the simplest option and record it in [docs/decisions.md](../decisions.md) under a new heading "Phase 1 step 3: break-glass". The [Phase 0 constraints](../phase-0/README.md#constraints-for-every-step) are binding: offline build and test, Postgres from `docker compose`, **no stored code, diffs or file contents**, pnpm, Node 24, strict TypeScript. The code as it is after step 2 is described in [docs/architecture.md](../architecture.md) and [docs/decisions.md](../decisions.md) ("Phase 1 step 1: modes", "Phase 1 step 2: approvals", including the review fixes). Where this spec and those documents disagree on an existing interface, they win and you record the difference. The plan for the whole phase is [phase-1/README.md](README.md). The previous step is [step-2-approvals.md](step-2-approvals.md).

Binding rules from earlier steps:
- **Payloads are triggers** ([architecture.md](../architecture.md#webhook-replay)). Who applied the label, and their permission, are read from the API. The one payload field this step uses (the head SHA at labelling time, D4) can only **refuse** a break-glass, never grant one.
- **Lock discipline**: no slow work inside `withChangeLock`.
- **Spec fix 1**: a passing `graft/policy` check is not a human approval. Break-glass makes the check pass. It does not approve the PR, dismiss reviews or change branch protection.
- **Report mode stays inert.** With default modes, every check is still `neutral` and the GitHub writes are still exactly the Phase 0 set (N-1 to N-3, N-6).
- **Fail closed.** A break-glass Graft cannot verify is not applied. It is recorded and explained.
- **No new GitHub write.** This step adds no route to the mutation guard's table.

## 1. Goal

Give maintainers a way to merge in an emergency when the policy would block, and make every use visible:

- **The label.** `graft:break-glass` (name set by the operator, `GRAFT_BREAK_GLASS_LABEL`, D1) on a PR is a request to bypass the policy for the PR's **current head commit**.
- **Who counts.** The user who applied the label, read from the PR's issue events, must have `maintain` or `admin` on the repository at verification time (D3). A label applied by anyone else, or by a bot, is ignored and reported.
- **One commit.** A valid break-glass binds to the head SHA the PR had when it was labelled (D4). A new push ends it. A new one needs the label removed and applied again.
- **Effect.** In enforce mode, `graft/policy` concludes `success` with reason `break_glass` for that SHA, whatever the verdict (D5). In report mode the check stays `neutral` and says "would bypass". `enforced_conclusion` stores `success` / `break_glass` in both modes.
- **Audit log.** Every break-glass request (applied, ignored, stale, removed) writes one `audit_log` row. The managed comment and the check details say who did it, on which commit and with what role. `pnpm graft audit list` reads the log (D7).
- **For the guard.** Step 5 must never auto-merge a revert of a PR that was merged under break-glass. It finds out from `audit_log` (D8). This step only guarantees the row exists.

## 2. Out of scope

Do not create stub code for any of these.

- Removing the label after a push, or any other label write. Graft adds no GitHub write in this step (D6).
- Break-glass for the guard (stopping a revert) or for MCP. Those steps decide their own rules.
- Notifications beyond the managed comment (Slack, email).
- Setting the label name in `graft.yaml`. The operator sets it (D1).
- Expiring a break-glass by time. It ends with a push or with the label's removal.
- Any change to approval counting, team checks or the guard rules of step 2.

## 3. Decisions

| # | Area | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | Label name | `GRAFT_BREAK_GLASS_LABEL`, default `graft:break-glass`, 1–50 characters, matched case-insensitively against label names. `off` disables the feature: the label is then an ordinary label and nothing is audited. Not configurable from `graft.yaml`. | Turning on a bypass is an operator decision, like modes (step 1 D1). A name in the repository would let the gated people rename the bypass. |
| D2 | Who applied it | The actor of the **latest** `labeled` event for that label name on the PR, from `GET /repos/{o}/{r}/issues/{n}/events` (paginated, at most 10 pages of 100, read newest first if the API allows, otherwise all pages up to the cap). If the label is no longer on the PR (from `pulls.get` `labels`) there is no break-glass. If the cap is reached without finding the event: not applied, `actor_unknown`. | The webhook's `sender` is payload data. The issue events API is GitHub's record of who did it. |
| D3 | Permission | `collaboratorRole` (step 2 D16) for the actor at verification time, `atLeast(role, "maintain")`. `type: Bot` actors never count. The PR author may break-glass their own PR. The audit row records `self = true`. A 403 or 404 on the role check → not applied, `role_unverified`. | Break-glass is an emergency tool for the people who own the repository settings. Self-use is allowed, because that is what emergencies look like, but it is visible. |
| D4 | Binding to a commit | The `pull_request.labeled` handler, when the label matches D1, adds `breakGlassHeadSha` (the payload's `pull_request.head.sha`, 40-hex) to the `policy.evaluate` job. The job applies the break-glass only if the live head from `pulls.get` **equals** it. If they differ, the head moved between labelling and evaluation, so the row is `stale` and the comment asks to re-apply. The binding is stored as `audit_log.head_sha` = the live head (API data). | GitHub gives no API for "head at the moment of the label". The signed payload is the only snapshot of that moment. Used only as an equality filter, it can refuse a break-glass, never grant one for a commit the API does not show as the head. |
| D5 | Effect on the conclusion | `enforcedConclusion` gains `breakGlass: { applied: true } \| null`. When applied for the current head it returns `success`, reason `break_glass`, **before every other rule**, including `no_policy`, `policy_invalid`, `blocked`, the card wait, truncated reviews and change requests. | It is a bypass. If it did not bypass a block, it would not be needed. |
| D6 | Persistence | A verified break-glass is an `audit_log` row (`kind = 'applied'`, `change_id`, `head_sha`). Every later evaluation of the PR (any trigger) treats break-glass as active iff such a row exists for (change, current head) **and** the label is still on the PR **and** no later `removed` row exists for that (change, head). A push changes the head, so the row stops matching. No GitHub write is made to remove the label. | One source of truth that survives restarts. The label staying after a push is harmless: it only counts for the SHA it was verified on. |
| D7 | Audit log | Table `audit_log` (§5). Kinds: `applied`, `ignored` (role too low, bot, role unverified, actor unknown), `stale` (D4 mismatch), `removed` (label taken off while applied). At most one `ignored` row per (change, head, actor) and one `stale` row per (change, head). Repeated labelling does not flood the table. Rows are never updated or deleted except by `pilot purge`. | An audit trail is append-only. The dedup bounds what an attacker with triage rights can write. |
| D8 | Guard handoff | Step 5 reads "was the merge commit's PR merged under break-glass?" as: an `applied` row exists for the PR's change and its **final** head SHA (the head at merge), with no later `removed` row. This step adds the store function `mergedUnderBreakGlass(db, changeId, headSha)` and a test. Step 5 calls it. | Keeps the rule next to the data. Step 5 does not reinvent it. |
| D9 | Unlabel | `pull_request.unlabeled` for the break-glass label already re-runs the policy (existing trigger). If an `applied` row matches the current head, the job writes a `removed` row (actor from the latest `unlabeled` event, D2 rules, `actor_unknown` allowed). The check goes back to the normal conclusion. | Taking the label off is how a team ends the bypass early. |
| D10 | Facts hash | `factsHash` gains `breakGlass` (`applied` / `none` / `stale` / `ignored`, the actor id and the head SHA). | A break-glass changes the conclusion, so it must republish even if nothing else changed. |
| D11 | Rendering | §7. The actor's login is always a code span (no @-mention). The role is shown. | Visible and auditable. Never notifies anyone by accident. |
| D12 | Bounds | One issue-events read (D2 cap) and one role check per evaluation that has the break-glass label on the PR. Evaluations of PRs without the label make no new API call. | The common path costs nothing new. |

## 4. Files

New:

| File | What |
| --- | --- |
| `src/modules/policy/break-glass.ts` | `resolveBreakGlass(octokit, db, …)`: reads issue events, checks the role, applies D4 and D6, returns `BreakGlassFacts`. Writes no rows (the job writes them inside the lock). |
| `src/modules/audit/store.ts` | `insertAuditRow` (with the D7 dedup), `listAudit`, `activeBreakGlass(db, changeId, headSha)`, `mergedUnderBreakGlass(db, changeId, headSha)`. |
| `src/modules/audit/cli.ts` | `graft audit list` (§8). |
| `src/modules/audit/index.ts` | Module exports. |
| `src/db/migrations/00NN_audit_log.ts` | §5. `NN` is the next free number when the branch is merged. Step 4 may land first, so renumber before merging if needed (the migrator refuses migrations out of order). |
| `test/unit/break-glass.test.ts`, `test/integration/break-glass.test.ts` | §10. |
| `test/fixtures/webhooks/pull_request.labeled.break-glass.json` | Trigger fixture. |

Changed: `src/policy/enforce.ts` (D5), `src/modules/policy/job.ts`, `handlers.ts` (D4), `render.ts`, `store.ts`, `src/config/index.ts`, `src/db/schema.ts`, `src/db/migrations/index.ts`, `src/bin/graft-ops.ts` and `src/bin/graft.ts` (the `audit` group), `src/pilot/purge.ts`, `src/pilot/doctor.ts`, `test/integration/neutral.test.ts`, the GitHub fakes (issue events with actors), and the docs in T9.

## 5. Schema (migration `00NN_audit_log`)

```sql
CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id   bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  change_id       uuid   NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  pr_number       integer NOT NULL,
  head_sha        text   NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  kind            text   NOT NULL CHECK (kind IN ('applied','ignored','stale','removed')),
  reason          text   CHECK (reason IN ('role_too_low','bot','role_unverified','actor_unknown','head_moved')),
  actor_id        bigint,
  actor_login     text   CHECK (char_length(actor_login) <= 100),
  actor_role      text   CHECK (actor_role IN ('admin','maintain','write','triage','read','none')),
  self            boolean NOT NULL DEFAULT false,
  policy_mode     text   NOT NULL CHECK (policy_mode IN ('report','enforce')),
  label_event_at  timestamptz,
  created_at      timestamptz NOT NULL,
  CHECK ((kind IN ('ignored','stale')) = (reason IS NOT NULL))
);
CREATE INDEX audit_log_change_idx ON audit_log (change_id, head_sha, created_at);
CREATE INDEX audit_log_repo_idx   ON audit_log (repository_id, created_at DESC);
CREATE UNIQUE INDEX audit_log_ignored_once ON audit_log (change_id, head_sha, actor_id) WHERE kind = 'ignored';
CREATE UNIQUE INDEX audit_log_stale_once   ON audit_log (change_id, head_sha)           WHERE kind = 'stale';
```

`policy_verdicts.enforced_reason`'s CHECK gains `'break_glass'` (replace the constraint by name, as 0009 did). `down` drops exactly what `up` adds and restores the CHECK. It fails if a `break_glass` row exists, and the rollback test runs on a table without one. The label name is not stored (it is configuration). Logins are stored here because an audit trail must say who. They are covered by `pilot purge` like `approvals.users`.

## 6. The job

`evaluatePolicyJobRun`, in addition to step 2:

1. `evaluateSchema` gains `breakGlassHeadSha?: string` (40-hex). The `labeled` / `unlabeled` handler sets it only when `label.name` matches D1.
2. After `pulls.get`: if D1 is not `off` and the PR carries the label, call `resolveBreakGlass`, outside the lock. It returns one of:
   - `{ state: "applied", actor, role, self, headSha, labelEventAt }`. Either a new verification passed (D2, D3, and D4 when `breakGlassHeadSha` is set), or an existing `applied` row matches the current head (D6). Do not re-verify on other triggers.
   - `{ state: "ignored", reason, actor?, role? }`, `{ state: "stale" }` (D4 mismatch), or `{ state: "none" }`.
   - When the label is absent and an `applied` row matches the current head: `{ state: "removed", actor? }` (D9).
3. `enforcedConclusion({ …, breakGlass })` (D5). Report mode publishes `neutral` as before. `enforced_conclusion` / `enforced_reason` = `success` / `break_glass` when applied.
4. Inside the lock, in the same transaction as `upsertVerdict`, insert the audit row the state calls for (`applied` only when newly verified, never again for the same head). If the publish rolls back, so does the row, and the retry writes it again (D7 dedup indexes make that safe).
5. `factsHash` gains D10.

A break-glass verification never blocks or delays the normal evaluation. If the issue events or role read fails with a retryable error, the job retries like any other GitHub read.

## 7. Rendering

- **Policy section** (managed comment), right after the headline:
  - applied, enforce: `**Break-glass** by \`alice\` (maintain) on \`abc1234\`: this check passes for this commit only. A new push needs the label again.`
  - applied, report: the same with `Graft would bypass the policy for this commit (report mode).`
  - self: append ` (on their own pull request)`.
  - ignored: `**Break-glass label ignored:** applied by \`bob\` (triage). Only maintain or admin can bypass the policy.` Use `(a bot)`, `(role could not be verified)` or `(who applied it could not be determined)` for the other reasons.
  - stale: `**Break-glass not applied:** the pull request changed after the label was added. Remove and re-apply the label.`
  - removed: no line. The section returns to normal.
- **Enforce-mode title** for `break_glass`: `Bypassed by break-glass (alice)`. Report-mode titles do not change. The would-be line reads `` `success` (break-glass by `alice`) ``.
- **Details:** a `**Break-glass**` block with the actor, role, commit, label time and whether it is self-use. The normal verdict and approvals are still shown below it, so reviewers see what was bypassed.

## 8. Operator CLI

Added to `src/bin/graft-ops.ts` as the group `audit`, with the same conventions as `mode` (exit codes 0 / 1 / 2, pending migrations exit 2, terminal-safe output).

```
graft audit list --repo <owner/repo> [--since <ISO date>] [--kind applied|ignored|stale|removed] [--limit <1..500, default 50>] [--json]
```

One line per row, newest first: `created_at  kind  #pr  head(7)  actor (role)  [self]  mode  reason`. `--json` prints `{ entries: [{ createdAt, kind, prNumber, headSha, actorLogin, actorRole, self, policyMode, reason, labelEventAt }] }`.

## 9. Tasks

- **T1. API verification.** Record in decisions.md: the shape and ordering of `GET /repos/{o}/{r}/issues/{n}/events` for `labeled` / `unlabeled` (actor, label name, created_at, whether newest-first is available), and that it works for PR numbers with `issues: read` / `pull_requests: read`. Make the fakes match.
- **T2. Config.** `GRAFT_BREAK_GLASS_LABEL` (D1) → `config.breakGlassLabel` (`string | null` for `off`). `.env.example` and `docs/configuration.md`.
- **T3. Migration and types.** §5, `src/db/schema.ts`, `TABLE_NAMES`. Rollback test.
- **T4. Pure rule.** D5 in `src/policy/enforce.ts`.
- **T5. Resolve and store.** §6 steps 1–2, `src/modules/audit/store.ts`, D8.
- **T6. Job and render.** §6 steps 3–5, §7.
- **T7. CLI, purge, doctor.** §8. `audit_log` in the purge map through `repositories`. `pilot doctor` gains one `warn`: "break-glass applied in the last 7 days" (count per repository), so operators notice bypasses.
- **T8. Neutral suite.** Add a break-glass scenario to both profiles: label by a maintainer, by a triage user, a push after labelling, then removal. **N-10:** under `default`, the check stays `neutral` throughout and the only writes are Phase 0 routes. **N-11:** under `max`, the only non-neutral conclusion is `success` on the labelled head through the policy feature client, and the next head goes back to the normal conclusion.
- **T9. Docs.** `docs/features/policy.md` (a "Break-glass" section: who, what it bypasses, one commit, the audit log, how to end it), `docs/features/modes.md` (report vs enforce behaviour), `docs/configuration.md`, `docs/architecture.md` (the audit log, D4 and D6), `docs/decisions.md` ("Phase 1 step 3: break-glass", with the T1 answers and any deviation), `docs/phase-1/HUMAN-TODO.md` (§11).

## 10. Test plan

Unit (`test/unit/break-glass.test.ts` and additions to `policy-enforce.test.ts`):

| ID | Case |
| --- | --- |
| U-BG-1 | `enforcedConclusion` with `breakGlass.applied`: `success break_glass` for each of `no_policy`, `policy_invalid`, `blocked`, card wait, truncated reviews, change requests, approvals missing |
| U-BG-2 | Without break-glass: every U-ENF case unchanged |
| U-BG-3 | Label matching: case-insensitive; `off` disables; a 51-character name rejected by config |
| U-BG-4 | Render: each §7 line; logins are code spans; no `@` outside code spans; enforce title; report would-be line |

Integration (`test/integration/break-glass.test.ts`, fake GitHub world):

| ID | Case |
| --- | --- |
| I-BG-1 | Migration up/down/up |
| I-BG-2 | Enforce: a maintainer labels a `would_block` PR → `success`, one `applied` row with the live head and `policy_mode = enforce` |
| I-BG-3 | Enforce: a triage user labels → normal `failure`, one `ignored role_too_low` row. Labelling again → no second row |
| I-BG-4 | The actor comes from the issue events API, not the payload `sender`: payload says maintainer, events say triage → ignored |
| I-BG-5 | D4: the payload head differs from the live head → `stale` row, not applied, comment asks to re-apply |
| I-BG-6 | After an `applied` break-glass, a push → the new head gets the normal conclusion. The label is still on the PR and no new row is written |
| I-BG-7 | Unlabel while applied → `removed` row, normal conclusion |
| I-BG-8 | Report mode: the same as I-BG-2 → check `neutral`, "would bypass" line, `enforced_conclusion = success`, `enforced_reason = break_glass` |
| I-BG-9 | Role check 403 → `ignored role_unverified`. A bot actor → `ignored bot`. Event not found within the cap → `ignored actor_unknown` |
| I-BG-10 | Self-use: the PR author is a maintainer → applied, `self = true`, comment says so |
| I-BG-11 | A later trigger (review, intent) on the same head keeps the break-glass without a new events or role read (fake's request log) |
| I-BG-12 | PRs without the label make no issue-events or role request |
| I-BG-13 | `mergedUnderBreakGlass` true for the merged head with an `applied` row, false after `removed`, false for another head |
| I-BG-14 | `graft audit list` text and `--json`. `pilot purge` removes the rows (I-PURGE-2 passes). Doctor warning with exit 0 |
| I-BG-15 | `GRAFT_BREAK_GLASS_LABEL=off` → the label is ignored and no audit row is written |

Neutral suite: N-10, N-11 (T8).

## 11. HUMAN-TODO (add a section "Step 3: break-glass" to `docs/phase-1/HUMAN-TODO.md`)

- [ ] **Create the `graft:break-glass` label** in each pilot repository, with a description saying it bypasses the Graft policy for one commit and is audited. Who: repo admin.
- [ ] **Tell the team who can use it** (maintain or admin) and that every use appears in the PR comment and in `pnpm graft audit list`. Who: product owner.
- [ ] **On a sandbox PR in enforce mode:** label as a maintainer → `success`; push → back to the normal conclusion; label as a triage user → ignored. Then run `pnpm graft audit list --repo …` and check all three rows. Who: repo owner.

## 12. Definition of done

From a clean clone with Docker running, and no network beyond install and the image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test                                  # every ID in §10 present and passing; all earlier IDs still passing
pnpm build
pnpm eval:ci                               # exit 0, baseline unchanged
pnpm db:migrate && pnpm db:status          # every migration up to 00NN applied
pnpm db:rollback && pnpm db:status && pnpm db:migrate   # only 00NN rolled back, then re-applied
grep -rnE "@ts-(ignore|expect-error)" src/ && exit 1 || true
grep -rnE "from \"\.\./(db|github|modules)" src/policy/enforce.ts && exit 1 || true
grep -rnE "conclusion: \"(success|failure|action_required)\"" src/modules/ && exit 1 || true
grep -rn "sender" src/modules/policy/break-glass.ts && exit 1 || true     # the actor never comes from the payload
grep -rn "U-BG-\|I-BG-\|N-1[01]" test/ | wc -l   # non-zero
```

**Mutation checks** (the reviewer reverts each one; the named tests must fail):

| Mutation | Caught by |
| --- | --- |
| Actor taken from the payload `sender` | I-BG-4 |
| `write` accepted as enough | I-BG-3 |
| Bots accepted | I-BG-9 |
| D4 equality check removed | I-BG-5 |
| Break-glass kept after a push | I-BG-6, N-11 |
| Break-glass evaluated after `blocked` instead of before | U-BG-1, I-BG-2 |
| Conclusion published in report mode | I-BG-8, N-10 |
| `ignored` dedup removed | I-BG-3 |
| `breakGlass` removed from `factsHash` | I-BG-2 (no republish on the label trigger) |
| `removed` row not written on unlabel | I-BG-7, I-BG-13 |

**Also required:**
- No log line, job payload or error message holds a token, PR text or YAML. Actor logins appear only in `audit_log`, the rendered comment and check, and the CLI.
- No new route in the mutation guard's table (`git diff` of `src/github/mutation-guard.ts` is empty).
- The live e2e runner's INV-1 still holds with the default sandbox.
