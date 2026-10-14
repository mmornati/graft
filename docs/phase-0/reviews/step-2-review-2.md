# Step 2 review 2

Verdict: APPROVED

Reviewer: senior engineer (Opus). Scope: the uncommitted working tree after the fixes for [review 1](step-2-review-1.md), checked against [step-2-provenance.md](../step-2-provenance.md).

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `db:up`, `lint`, `typecheck`, `build` | all ok (Biome checked 96 files) |
| `pnpm test` | 27 files, 180 tests, all pass. No `skip`, `only` or `todo`. |
| `db:migrate` → `db:rollback` → `db:status` → `db:migrate` | `0002_provenance` alone rolls back and re-applies |
| `@ts-ignore` grep; `I-SEC-/U-PAY-/U-TRL-/I-PROV-` grep | no hits; 44 |
| Manual smoke test (server and worker, `installation.created`, then `pull_request.opened` as `smoke-2` and `smoke-3`, API pointed at a dead port) | Both PR deliveries returned `202 enqueued`. There is exactly one `provenance.refresh` job (`retry`), so a replay with the same `updated_at` still deduplicates. The token failure is logged as retryable, and the worker does not crash. |
| The review-1 fuzz inputs, plus new ones, against the new `validateSessionUrl` / parser (throwaway script, not committed) | See finding 1 below. |
| Mutation checks in a throwaway copy of the tree: each fix reverted on its own, then the relevant tests run | See the table below. |

I deleted the scratch copy, `.env`, `dev.pem` and the smoke rows and jobs afterwards, and stopped both processes.

### Do the new tests fail without the fix?

| Fix reverted | Tests that fail |
| --- | --- |
| LDH host check removed | U-FLD-14, U-REN-8 (and U-FLD-6: the LDH rule now also rejects bracketed IPv6) |
| `\` encoding removed | U-FLD-15, U-REN-8 |
| `` ` `` encoding removed | U-FLD-15 |
| `*` encoding removed | U-FLD-15, U-REN-8 |
| `updated_at` dropped from the dedup key | I-CHG-6b, I-CHG-6c, I-CHG-5, the closed/reopened test |
| In-lock `pr_updated_at` check disabled | I-PROV-10b |
| In-lock head check removed | **none** (see finding 3) |

## Verification of the review-1 findings

| # | Finding | Status |
| --- | --- | --- |
| 1 (major) | Session link injection | **Fixed.** `fields.ts:37-69`: the hostname must be LDH with at least two labels and at most 253 characters, and one trailing dot is stripped before the checks. `\`, `` ` `` and `*` are percent-encoded, along with `( ) [ ] \|`. Fuzz results: the review-1 exploit ``https://a`b.com/https://evil.example/@octocat`` → `null`; `a*b_c`d.com` → `null`; `-a.com`, `a-.com`, single-label `x`, `ÉXAMPLE.com`, `127.0.0.1.` and `localhost.` / `app.localhost.` → `null`; `?a\` → `?a%5C`; ``?x=`@octo` `` → `?x=%60@octo%60`. Every accepted URL renders as exactly one well-formed link. `_`, `~`, `'`, `&` and entities can remain in the destination, but they are inert because the link always forms. |
| 2 (major) | A→B→A swallowed by dedup | **Fixed.** `updated_at` is now required (`z.string().min(1)`) and is part of every key (`handlers.ts:63-72`). I-CHG-6b (body X→Y→X) and I-CHG-6c (head H1→H2→H1) each assert three jobs, and that a replay with the same `updated_at` adds none. I-SEC-1 and the smoke test confirm replays still collapse. |
| 3 (major) | Body-only race inside the lock | **Fixed.** `job.ts:176-181` returns `stale` when the stored `pr_updated_at` is newer than the live snapshot. I-PROV-10b pauses job A in the commit fetch, lets B publish body Y, then releases A. It asserts that A sends no PATCH and that the comment and `change_provenance` stay on Y. This test fails with the check disabled. |
| 4 | Deterministic output errors retried | **Fixed.** `managed-comment.ts` throws `PermanentJobError("…", "invalid_output")` for the marker, section-size and body-size cases. `toJobError` returns it unchanged (it has no HTTP status), so the worker completes the job. The U-MC test asserts the name and reason. |
| 5 | Head-moved branch untested | **Partly.** I-PROV-10c exists, but it does not isolate the branch it names (finding 3 below). |
| 6 | Rerequest replay | **Documented** in README §5 "Webhook replay". Accepted for Phase 0; see the assessment below. |
| 7 | `localhost.` and Unicode whitespace | **Fixed.** `trimWs` and `[ \t]` give git parity: an NBSP-only line no longer splits paragraphs, and U+FEFF or NBSP inside an agent value is now `invalid_value`. |
| 8 | Warning types and wording | **Fixed.** `StoredWarning.code` is `WarningCode`, and `unknown_graft_key` renders as "unknown Graft key ignored". |
| 9 | Lock note for step 3 | **Fixed.** The `managed-comment.ts` contract item 6 now says to do no slow work inside `withChangeLock`. |

## Assessment of the two accepted limitations

**One-second `updated_at` resolution.** This leaves two narrow windows:
- Two changes to the same PR in the same wall-clock second, where one job's `pulls.get` lands between them. If that job also takes the lock last, the in-lock check sees equal timestamps and publishes the older snapshot.
- Two changes in the same second that produce the same key, for example a title edit and a close with an unchanged head and body. The second job is deduplicated, and the first job's snapshot may predate the close.

In both cases the output is corrected by the next event or a Re-run. Ordering inside one second is impossible with GitHub's data, short of re-fetching after publishing. The failure is self-healing and needs sub-second coincidences, so this is **acceptable** and documented in README §7. One small wording issue is finding 1 below.

**Rerequest replay, documented only.** Exploiting it needs a captured, correctly signed `check_run.rerequested` body, which requires a leaked webhook secret or access to delivery logs. The impact is cost only: idempotent refreshes that cannot forge state. The realistic worst case is draining the installation's rate limit, and the resulting 403/429 responses are retryable rather than fatal. That is **acceptable for Phase 0**. Revisit with a per-PR re-run throttle when pilots start (finding 2).

## Findings

No blockers or majors.

### 1. nit: the README overstates the self-healing in the one-second note

`README.md:162`

The note says "the later job still refreshes on the next event". More precisely, the **next** event (or a Re-run) refreshes, and until then the published output can be one same-second change behind. Also mention the second window: a same-second change with an unchanged head and body (for example title edit + close) shares a key. Adding the `action` to the key would close that second window cheaply, at no cost to replay protection. This is optional.

### 2. minor (follow-up): throttle rerequest re-runs before pilots

`src/modules/provenance/handlers.ts` (`prov-rerun:{deliveryId}`)

As assessed above, this is fine for now. Add a HUMAN-TODO item, or a step 6 note, for a coarse per-PR cap, for example a key of `prov-rerun:{repo}:{pr}:{minute}`.

### 3. nit: I-PROV-10c does not isolate the head-moved branch

`test/integration/provenance.test.ts:428`

With the head check at `job.ts:172` removed, I-PROV-10c still passes. Job B also stored a newer `updated_at`, so the new `pr_updated_at` guard catches job A first. The branch now only defends against impossible or legacy rows, where `pr_updated_at` is NULL or equal while the head differs. To pin it down, null out `changes.pr_updated_at` before releasing A. Otherwise, rename the test so it does not claim to cover that specific branch.

### 4. nit: `db/schema.ts` imports a type from a module

`src/db/schema.ts:2`

`import type { WarningCode } from "../modules/provenance/fields.js"` makes the shared `db` layer depend on a feature module, which reverses the README §5 layering. It is type-only, so there is no runtime effect. When convenient, move `WarningCode` (and `GraftField`) into `db/schema.ts` or a shared types file and re-export them from `fields.ts`.

Step 2 is ready to commit.
