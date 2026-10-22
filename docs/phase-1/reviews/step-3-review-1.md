# Step 3 review 1: Break-glass and audit log

**Verdict: CHANGES REQUESTED**

Reviewer: senior engineer (Opus). Scope: the 7 commits `6e5885b..da43d1c` (PR mmornati/graft#25, merged to `main` as `de2d9fc`): 35 files, +3033/−21. I judged them against `docs/phase-1/step-3-break-glass.md` (binding), the Phase 1 plan, the step 1 and step 2 specs and their reviews, the Phase 0 constraints, and the "Phase 1 step 3: break-glass" section of `docs/decisions.md`.

## Summary

The step is complete and well built. All 9 tasks and all 12 decisions are implemented. Every §10 test ID exists. The definition of done is green. All 10 spec mutations are killed, and so are 5 of the 7 extra mutations I added.

What holds:
- **Report mode is inert.**
  - `break_glass` reaches GitHub only through `publishedCheck`, which still returns `completed` + `neutral` outside enforce mode.
  - The mutation guard has no diff.
  - N-10, N-11, N-1 to N-3 and N-6 pass.
- **Payload use is limited.** The one payload value used is the D4 head, as a 40-hex equality filter that only refuses.
- **The actor and the role come from the API.** `evaluateSchema` even strips a `sender` that a handler tries to pass through. The first attempt at M1 had no effect until I widened the schema.
- **Lock discipline holds.** All API reads happen in `resolveBreakGlass`, outside the lock. Under the lock there are only database reads and the insert.
- **The audit row commits with the verdict.**
- **Logins stay where they belong.** They appear only in `audit_log`, the comment, the check and the CLI. The step 2 route sanitiser already templates `collaborators/<login>`.

The authorization model has two gaps, and both are major. Neither is a coding slip. The developer implemented D2, D6 and D9 as written, so the defects are in the spec. I proved each one with a red test against the fake GitHub world:

1. **The actor is not bound to the label action that queued the run.** The job takes the newest `labeled` event in the issue events API and compares it with nothing. If the API lags behind the webhook, an older label by a maintainer authorises a newer label by someone else. Nothing compares the event with the delivery's `sender`, and nothing checks that the newest label event is a `labeled` one rather than an `unlabeled` one.
2. **Revocation drifts.** An `applied` row for a (change, head) keeps the bypass while a label is present. It does not matter who added that label or when.
   - A removal that Graft never evaluates is lost. That happens when the `unlabeled` webhook is missed or late and the label is re-added before the job runs.
   - A `removed` row ends the bypass only for the head where it was written. A force push back to the old head revives it.
   - In both cases the audit log does not record the re-add at all.

The other findings are three minors and three nits:
- a push does not end the bypass for good;
- a label-triggered verification can be dropped silently;
- the lost-race path has no test;
- the nits are about the dedup index, the event cap and the fakes.

## What was checked

### Definition of done (spec §12), run by me

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK |
| `pnpm db:up` | Not run. I reused the shared container on 127.0.0.1:55432 and started or stopped no container. |
| `pnpm lint` | OK (324 files, no fixes) |
| `pnpm typecheck` | OK |
| `pnpm test` (`TEST_DATABASE_URL=…/graft_test_review3`) | OK: 95 files, **1044** tests passed |
| `pnpm build` | OK |
| `pnpm eval:ci` | exit 0; every threshold passes, `matchBaseline: 1` |
| `db:migrate && db:status` (scratch DB `graft_review_s3`) | 0001..0010 applied |
| `db:rollback && db:status && db:migrate` | Only `0010_audit_log` rolled back (`pending`), then re-applied |
| `@ts-ignore` / `@ts-expect-error` grep | Clean |
| `src/policy/enforce.ts` import grep | Clean |
| `conclusion: "(success\|failure\|action_required)"` in `src/modules/` | Clean |
| `sender` in `break-glass.ts` | Clean |
| Test ID grep | 34 lines. I also checked each §10 ID one by one (U-BG-1..4, I-BG-1..15, N-10, N-11): none is missing. |
| `git diff 6e5885b..da43d1c -- src/github/mutation-guard.ts` | Empty |

I dropped both scratch databases afterwards. I did not run the manual smoke test or the live e2e runner, because both need a real or tunnelled App. INV-1's scenario unit tests (`live-e2e-scenarios.test.ts`) pass. The HUMAN-TODO item that checks the issue events API on a real PR matters more after finding 1: its answer decides how likely the lag is.

### Mutation checks (spec §12)

I applied each mutation alone with a script, ran the named test files, then ran `git checkout -- src`. `git status` was clean after each one.

| # | Mutation (how I applied it) | Result |
| --- | --- | --- |
| M1 | Actor from the payload `sender`: the handler copies `sender` into the job data, `evaluateSchema` keeps it, and `resolveBreakGlass` uses it instead of the event | Killed: I-BG-4. Without the schema change the mutation is inert, because `z.object` strips the field (defence in depth). |
| M2 | `write` accepted (`atLeast(role, "write")`) | Killed: I-BG-3 |
| M3 | Bots accepted (`false && ev.actor.bot`) | Killed: I-BG-9 |
| M4 | D4 equality check removed | Killed: I-BG-5, I-BG-14 |
| M5 | Kept after a push (`activeBreakGlass` ignores `head_sha`) | Killed: I-BG-6, I-BG-13, I-BG-14, N-10, N-11 |
| M6 | Break-glass checked after `blocked` | Killed: U-BG-1, I-BG-2 (also I-BG-1, 6, 7, 8, 10, 11, U-BG-4) |
| M7 | `publishedCheck` lets `break_glass` through in report mode | Killed: I-BG-8, N-10 |
| M8a | `ignored` dedup removed (the store check and `ON CONFLICT DO NOTHING`), as the developer applied it | Killed: I-BG-3, I-BG-9 |
| M8b | `ignored` dedup removed (the store check, and `audit_log_ignored_once` made non-unique) | Killed: I-BG-3, I-BG-9 |
| M9 | `breakGlass` removed from `policyFactsHash` | Killed: I-BG-2, by the direct hash assertion only (see the deviations) |
| M10 | `removed` row not written (`auditRowFor` returns null) | Killed: I-BG-7, I-BG-13 |

Extra mutations (mine):

| # | Mutation | Result |
| --- | --- | --- |
| X1 | The 1000-event cap ignored (`if (truncated)` removed) | Killed: I-BG-9 |
| X2 | `self` always false on `applied` | Killed: I-BG-10 |
| X3 | Role 403/404 treated as a role (`role_unverified` branch removed) | Killed: I-BG-9 |
| X4 | Tie rule: `removed` at the same `created_at` no longer ends the bypass (`>=` → `>`) | **Survives** (nit 7) |
| X5 | The lost-race path writes no audit row (`recordAudit` in the stale branch removed) | **Survives** (I-BG suite and I-POL suite; finding 5) |
| X6 | No dedup for the unknown actor (`actor_id IS NULL` check disabled) | Killed: I-BG-9 |
| X7 | No `removed` when the label is gone (`!onPr` always `none`) | Killed: I-BG-7, I-BG-13 |

### Extra probes: the authorization model

Each probe was a red test in a scratch file, `test/integration/zz-review3-scratch.test.ts`. It used the same setup as `break-glass.test.ts`: enforce mode, a `block` policy, maya (maintain) and tom (triage). All five **failed** on `main`. I deleted the file afterwards.

| ID | Scenario | Expected | Observed |
| --- | --- | --- | --- |
| R3-A1 | Events: `labeled` maya, `unlabeled` maya. Tom re-adds the label: `pulls.get` shows it, but the events API has not listed tom's event yet. The labeled run (D4 head = live head) | Not applied | **`success`**, an `applied` row naming maya (finding 1) |
| R3-A2 | Events: `labeled` maya only. The unlabel and tom's re-label both lag. The run carries tom's id as the delivery sender | Not applied | **`success`** by maya. Nothing reads the sender (finding 1). |
| R3-B1 | maya labels → applied. maya removes the label, but no run sees it (the webhook is lost, or its job runs after the next step). Tom re-adds the label; labeled run | Normal `failure`; `mergedUnderBreakGlass` false | **`success`**. `mergedUnderBreakGlass(HEAD)` true. No `removed` row, and no row for tom (finding 2). |
| R3-B2 | maya labels at A → applied. Push B → `failure`. maya removes the label at B (evaluated: no `removed` row, because nothing is active for B). Tom re-adds at B → `ignored`. Force push back to A | `failure` on A; `mergedUnderBreakGlass(A)` false | **`success`** on A (`break_glass`, run `unchanged`). Rows: `applied A`, `ignored B` (finding 2). |
| R3-B3 | maya labels at A → applied. Push B, then push A again; the label is untouched | `failure` ("a new push ends it") | **`success`** on A (finding 3) |

Other probes, by reading the code (no scratch test):
- **Dedup with NULL actors.** `audit_log_ignored_once` treats NULL `actor_id` as distinct. The store deduplicates `actor_unknown` under the change lock (`store.ts:113-126`), and X6 is killed. Every writer holds the lock today (nit 7).
- **The 1000-event cap.**
  - It fails closed (`break-glass.ts:106`), and X1 is killed.
  - A tenth page that is exactly full counts as truncated, which is conservative.
  - Each label trigger costs up to 10 reads (nit 8).
- **Self-use** is compared by user id (`break-glass.ts:235`), and X2 is killed.
- **Bots.** Only `actor.type === "Bot"` counts as a bot. A user-to-server action (`performed_via_github_app` set, `type: User`) counts as the user. That is acceptable, because the user authorised the App.
- **403 vs 404.** Both give `role_unverified` (`break-glass.ts:228`), as the spec asks. A custom role based on `maintain` reports `permission: write` and a custom `role_name`, so `roleFrom` gives `write`, which is ignored. That fails closed. Operators should know it (I added no finding; it is worth a line in `docs/features/policy.md`).
- **The lost-race re-evaluation** (`job.ts:487,611-624`).
  - The run that lost writes its row only after `fresh()` passed for the same head.
  - A newer snapshot whose labels differ makes `catchUp` fail (`verdictInputsKey` includes the labels), so a run that read the label before its removal writes nothing.
  - A run that writes a `removed` row and loses the race is safe too: the re-evaluation shows the normal conclusion.
  - Correct, but untested (finding 5).
- **Logins outside the allowed places.**
  - The job data holds only `breakGlassHeadSha`, and I-BG-4 asserts no login in it.
  - Errors on the role check go through `routeTemplate`, which replaces the segment after `collaborators` (`src/queue/errors.ts:46`).
  - The issue events route has only numbers.
  - No log line in `break-glass.ts` or `src/modules/audit/` carries a login.
- **Report-mode inertness.** N-10, N-11, N-1 to N-3 and N-6 pass in the full run. M7 is killed by I-BG-8 and N-10.

### Safety review

- **Report mode cannot publish `success` for break-glass.**
  - `enforcedConclusion` returns `success`/`break_glass` in every mode, as the spec asks, so that `enforced_conclusion` records it.
  - `publishedCheck` (`enforce.ts:184-190`) is unchanged and maps every mode but `enforce` to `completed` + `neutral`.
  - The guard and the gate are untouched and still refuse a non-neutral body in report mode.
- **No new GitHub write.** `mutation-guard.ts` has no diff. The job adds GETs only (`issues/{n}/events`, `collaborators/{u}/permission`). Graft never removes the label.
- **Spec fix 1.** Break-glass changes the check only. It does not approve, dismiss reviews or touch branch protection.
- **Payloads.** `breakGlassHeadSha` is set only for `labeled` deliveries of the configured label (`handlers.ts:121-129`). The schema checks it as 40-hex, and it is used only as an equality filter (`break-glass.ts:201`). An `unlabeled` delivery carries nothing. This is the right shape, and finding 1 asks to use the delivery's sender the same refuse-only way.
- **Fail closed.**
  - Unknown actor, cap reached, bot, 403/404, recycled login (`collaborator.ts:66`) and a role below maintain: none of them applies the bypass.
  - A D4 mismatch is refused before any read.
  - With `GRAFT_BREAK_GLASS_LABEL=off`, nothing resolves, so old `applied` rows stop applying.
  - Findings 1 and 2 are the two places where the model fails **open**.
- **No stored code.** `audit_log` holds ids, a login, a role, a SHA, the mode and timestamps. `pilot purge` removes it (I-PURGE-1/2, I-BG-14).
- **D12 bounds.** PRs without the label make no new request (I-BG-12). With the label: one events read (up to 10 pages) and one role read on the label trigger. Other triggers make none (I-BG-11). The removal path makes one events read (deviation 1).

### Regressions against step 2

- **`src/policy/enforce.ts`.** The only change is the new first rule and `constraintsOf`. Every other rule keeps its order, and U-BG-2 runs the U-ENF cases unchanged. The import grep is clean.
- **The same-head catch-up (PR #23).** `git diff 6e5885b..da43d1c` does not touch `catchUp`, `verdictInputsKey`, `underFreshLock` or `MAX_CATCH_UPS`. Step 3 only adds `recordAudit` calls inside the existing branches. I-POL-25 and I-POL-26 pass.
- **The step 2 review fixes** are intact. Step 3 does not touch `src/github/`, `src/queue/`, `team-fanout.ts` or `approvals.ts`:
  - the trailing-edge fan-out (`team-fanout.ts:8-15`);
  - the guard's POST rule;
  - the route sanitiser;
  - the `!res.data.user` check (`collaborator.ts:66`).

### Developer-reported deviations

| Deviation | Judgement |
| --- | --- |
| 1. D12/D9: when the label was removed while applied, one events read records who removed it | **Accepted.** D9 needs the actor, and the read happens once per removal. After that, `active` is false. |
| 2. M9 is caught only by I-BG-2's direct hash check, because for `applied` the term is redundant with the reason and the text | **Accepted**, as for step 2's I-ENF-9. The term matters for `ignored` and `stale`. U-BG-4b checks that every state hashes differently. |
| 3. I-BG-3 also labels as a `write` user | Accepted, and needed: M2 is killed only because of it. |
| 4. N-11 restated for a profile whose normal conclusion is `failure` | **Accepted.** The restatement is stricter than the spec's literal wording. M5 is killed by N-11. |
| 5. The I-BG-14 doctor case lives in `pilot-ops.test.ts` | Accepted. |
| 6. Earlier tests updated (step-down tests, I-DB-1/3, fixtures, I-DOC-1/3, I-PURGE-1, I-ENF-9) | Accepted. Each change is the count or the seed of the new table or check. |
| Choices: removal on any trigger; stale needs no read; ties go to `removed`; dedup in the store; the lost-race re-evaluation; `off` case-insensitive; rendering details | Accepted. Each one fails closed or is presentation. "Removal on any trigger" is right, but it is not enough on its own (finding 2). The tie rule has no test (nit 7). The lost-race path has no test (finding 5). |
| "Between label events, verify nothing" (§6.2: "Do not re-verify on other triggers") | Accepted for other triggers. It also applies to the label's **own** trigger when a row is already active (`break-glass.ts:167-178` runs before the D4 branch). That is how R3-B1 keeps maya's bypass when tom labels (finding 2). |
| Known limit: a PR with more than 1000 events cannot be break-glassed | Accepted (fail closed), see nit 8. |
| T1 from documentation only | Accepted for the review, with the HUMAN-TODO item. When the operator checks it on a real PR, they should also check how quickly a `labeled` event appears after the webhook (finding 1). |

## Findings

### 1. major: the actor is not bound to the label action that triggered the run

`latestLabelEvent` reads every page and returns the newest `labeled` event for the label name (`src/modules/policy/break-glass.ts:107-120`). `resolveBreakGlass` uses its actor (`:203-236`). Two checks are missing:
- **Newest of what.** The scan skips `unlabeled` events. When the newest label event is an `unlabeled` one while `pulls.get` shows the label, the events API is visibly behind GitHub's label state. The code still returns the older `labeled` event (R3-A1).
- **Which action.** Nothing ties the event to the delivery that queued the run. The delivery's `sender.id` is in the signed payload, but the handler drops it (`handlers.ts:121-129`), so even an API that lags behind both the unlabel and the re-label goes unnoticed (R3-A2).

The issue events API is listed oldest first, has no `since` (T1), and is not guaranteed to be consistent with webhook delivery. The job runs within seconds of the webhook. The developer could not check the lag offline (HUMAN-TODO).

**How it can be exploited.** It needs a `labeled` event by a maintainer anywhere in the PR's history, for example an earlier break-glass on an older head.
1. The PR author (write, so they can push and label) pushes new code.
2. They remove and re-add the label in a loop.
3. Each re-add queues a labeled run whose D4 head is the live head.
4. Any run that reads the events before the author's own event is listed applies a bypass in the maintainer's name.

With finding 2, one win is enough: the `applied` row then survives every later label change on that head. The audit row and the comment name the maintainer, so the trail itself is wrong.

The step's own rule is that payloads can only refuse, and the Phase 1 plan (README step 3) speaks of checking the **sender's** permission. A sender check used only to refuse fits both.

**Fix:**
1. In the handler, for a `labeled` delivery of the label, add `breakGlassActorId: p.sender.id` to the job data. Add `sender: z.looseObject({ id: z.number().int().positive() })` to `pullRequestPayload` and an optional positive int to `evaluateSchema`. Name it without "sender" in `break-glass.ts`, so the §12 grep keeps its meaning.
2. In `latestLabelEvent`, scan newest first over `labeled` **and** `unlabeled` events for the label. If the newest one has the other kind (an `unlabeled` event when looking for `labeled`), return not found.
3. In `resolveBreakGlass`, when `breakGlassActorId` is set and differs from the event's `actor.id`, return `ignored`/`actor_unknown` before the role read. The actor, login and role still come from the API.
4. Better still, when either check fails on the label trigger, throw a retryable error once (the events may simply be late) before recording `actor_unknown`.
5. Record the D2 amendment in decisions.md.

**Tests:**
- R3-A1 as I-BG-16: not applied, no `applied` row.
- R3-A2 as I-BG-17: a mismatched delivery actor → `ignored actor_unknown`, no role read.
- Add the matching actor to I-BG-2 (still applied).
- I-BG-4's expectation becomes `actor_unknown`. Keep its point with a second case where the sender and the events both say tom → `role_too_low`.

### 2. major: revocation drifts: an applied row outlives the label action that created it

`activeBreakGlass` (`src/modules/audit/store.ts:39-66`) keeps an `applied` row active for (change, head) until a `removed` row **for the same head** exists. `resolveBreakGlass` returns that row on every trigger while any label of that name is present (`break-glass.ts:167-178`). On the label's own trigger, this happens before D4 and before any read. A `removed` row is written only when an evaluation sees the label absent **and** an active row for the **current** head (`break-glass.ts:153-163`, `store.ts:112`). Three effects follow:

- **A removal Graft never sees is lost (R3-B1).**
  1. A maintainer removes the label to end the bypass.
  2. A triage user re-adds it before the `unlabeled` job runs, or the `unlabeled` webhook is lost.
  3. Every later evaluation still sees the label, and the old row keeps the bypass in the maintainer's name.
  4. The re-adder is never checked or recorded: tom's label writes no `ignored` row.
  5. The removal is never recorded either. `mergedUnderBreakGlass` says true, so step 5 would treat the merge as a break-glass merge that the team had revoked.
- **A removal at another head does not end the bypass for the old head (R3-B2).**
  1. A maintainer bypasses commit A.
  2. The author pushes B.
  3. The maintainer removes the label, and no `removed` row is written, because nothing is active for B.
  4. Anyone re-adds the label (tom's label is `ignored` for B).
  5. The author force-pushes back to A, and A is `success` again.
  6. `mergedUnderBreakGlass(A)` is true.
- **The audit trail is incomplete** in both cases, while D7 says every request writes a row.

D9 says "taking the label off is how a team ends the bypass early", and `docs/features/policy.md` promises it. The developer implemented D6 literally ("an applied row … **and** the label is still on the PR"), so the defect is in the spec. It fails open, and it needs no race in the attacker's favour, only a removal that Graft does not evaluate in time.

**Fix:**
1. **Bind the row to the label event.** Add `label_event_id bigint` to `audit_log`, written on `applied` rows from the issue event's `id`.
   - On a `labeled` delivery (the job carries `breakGlassHeadSha`) where a row is active, read the events once (within D12).
   - If the newest `labeled` event is not the stored one, first write `removed` (actor from the newest `unlabeled` event), then verify the new label as usual.
   - Other triggers still make no read, so I-BG-11 is unchanged.
2. **Make `unlabeled` a refuse-only signal.** For an `unlabeled` delivery of the label, the handler sets `breakGlassUnlabeled: true`. The job then writes `removed` for every active row of the change, whatever `pulls.get` says now.
3. **Scope revocation to the change.** In `activeBreakGlass`, a `removed` row for the change on **any** head at or after the `applied` row ends it. The job writes `removed` when the label is absent and any `applied` row of the change is still active, not only the current head's. That is a database read only. `mergedUnderBreakGlass` follows.
4. Record the D6, D8 and D9 amendments in decisions.md.

**Tests:**
- R3-B1 as I-BG-18: `failure`, a `removed` row for maya, an `ignored` row for tom, and `mergedUnderBreakGlass` false.
- R3-B2 as I-BG-19: `failure` on A after the force push, and `mergedUnderBreakGlass(A)` false.
- A variant of R3-B1 where the `unlabeled` job runs after the re-label: `removed` written from the flag.
- Extend I-BG-13 with a removal on another head.

### 3. minor: a push does not end the bypass for good

R3-B3: a force push back to the labelled commit, with the label untouched, revives `success` (the run is even `unchanged`). §1 says "A new push ends it". The managed comment says "this check passes for this commit only. A new push needs the label again", and `docs/features/policy.md` says the same. The code applies the bypass only to the exact commit the maintainer verified, so the risk is small. But the promise is broken, and step 5 sees `mergedUnderBreakGlass` true for a PR whose bypass the team thought had ended.

**Fix:** when an evaluation sees the label on the PR and an active `applied` row of the change for a head other than the current one, write a `removed` row for that head inside the lock, with a null actor. That is a database read only, and it fits finding 2's change-scoped rule. Alternatively, change the spec, the comment and the docs to "for this commit" without "a new push ends it". Test: R3-B3 as I-BG-20.

### 4. minor: a label-triggered verification can be dropped silently

Only a run with `breakGlassHeadSha` verifies (`break-glass.ts:182-199`). Two paths end such a run without a row or a retry:
- **Early stale** (`job.ts:257`). The maintainer adds the break-glass label and, a moment later, another label. The second label's job stores a newer snapshot first. `catchUp` then fails, because `verdictInputsKey` includes the labels.
- **A mode rollback** that throws `ModeChangedDuringEvaluation` (`job.ts:602`). It rolls back the audit row with the verdict, and `auditWrittenWhileStale` stays false.

The next evaluation is not the label trigger, so it shows nothing. The label sits on the PR with no line and no row, and in an emergency the maintainer has to guess that they should re-label. This fails closed, but it is the opposite of "every break-glass request writes one row".

**Fix:** when a run that carries `breakGlassHeadSha` ends `stale` for the **same** head without having written its row, re-send `policy.evaluate` with `breakGlassHeadSha` kept, singleton `policy:breakglass:<change>:<head>:<deliveryId>`. This is safe, because the field only refuses. Test: a fake hook that adds a label and bumps `updated_at` after the run's first `pulls.get`; assert that a re-run is queued and applies.

### 5. minor: the lost-race path has no test

X5 survives: removing `recordAudit` from the "a later evaluation already published" branch (`job.ts:482-489`) fails no test. Without it, a label verified by a run that lost the race is dropped silently, which is the case the developer added the branch for.

**Fix:** an I-BG case. Publish a `review` run with a later clock first, then run the labeled job with an earlier clock (its `factsReadAt` is older). Assert one `applied` row and one queued `policy:breakglass:…` job. Then run that job and assert `success`.

### 6. nit: the fakes cannot express findings 1 and 2

The fake world has no `DELETE …/labels/{name}` route, so it cannot unlabel. It always records `actor.type: "User"`, even for an App actor (`fake-github-world.ts:969-981`), and it has no way to delay the events list. The integration tests write `state.issueEvents` by hand, which is fine. But N-10 and N-11 cannot run the removal or a bot label through the world. Add an unlabel route that records an `unlabeled` event, give the actor its real `type`, and add a switch that hides the last N events (a lag), for the tests of findings 1 and 2.

### 7. nit: let the database enforce the unknown-actor dedup, and test the tie rule

`audit_log_ignored_once` (`0010_audit_log.ts:34`) treats NULL actors as distinct, so `actor_unknown` rows are deduplicated only by the store under the lock. On Postgres 17, `CREATE UNIQUE INDEX … (change_id, head_sha, actor_id) NULLS NOT DISTINCT WHERE kind = 'ignored'` makes the index enforce it too, and `ON CONFLICT DO NOTHING` then covers it. The tie rule (`removed` at the same `created_at` ends the bypass, `store.ts:59`) has no test: X4 survives. Add a store-level case with equal timestamps.

### 8. nit: the 1000-event cap is both a cost and a lever

Every label trigger without an active row reads up to 10 pages (`break-glass.ts:88-101`). A triage user who churns any label 1000 times disables break-glass on that PR for good (`actor_unknown`). That fails closed, but it disables the emergency tool. Reading the `Link: rel="last"` page first and walking backwards (the option T1 set aside) gives the newest events in one or two requests and removes the lever. Otherwise, note the limit in `docs/features/policy.md` next to "Known limits".

## Required before approval

Findings 1 and 2, with their decisions.md amendments to D2, D6, D8 and D9, and the red tests above (R3-A1, R3-A2, R3-B1, R3-B2) turned into I-BG cases that pass. The guard in step 5 will trust `mergedUnderBreakGlass`, so finding 2 should land before step 5 starts. I recommend findings 3, 4 and 5 as well. Each one is a few lines, and they make "a push ends it" and "every request writes a row" true. Nits 6 to 8 are optional, but nit 6 makes the tests for findings 1 and 2 easier to write.
