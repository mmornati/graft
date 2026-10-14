# Step 3 review 1

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted working tree on top of `84f30c9` (step 2), checked against [step-3-intent-service.md](../step-3-intent-service.md), the [Phase 0 README](../README.md) constraints and the safety rule in the development plan. No real Anthropic call was made.

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `build` | all ok (Biome checked 131 files) |
| `pnpm test` | 39 files, 329 tests, all pass |
| Every §11 test ID present as an `it(...)` title prefix (script over the spec table) | all 150 present (U-RISK-2..6 via `it.each`) |
| `db:migrate` → `db:status` → `db:rollback` → `db:status` → `db:migrate` | only `0003_intent` rolls back and re-applies |
| DoD greps (`@ts-ignore`, `modules/` in `src/db`, sampling params in `src/llm`, test-ID count) | no hits, no hits, no hits, 69 |
| Prompts and schemas compared byte-for-byte with §7/§10 | identical |
| Adversarial probes through `createFakeLlm` + `renderIntentSection`, `escapeProse`/`codeSpan` probes, a pino serialization probe of an Octokit `RequestError` (throwaway scripts, deleted) | see findings |
| Mutation checks in a throwaway copy (deleted) | table below |

The manual smoke test was not repeated.

### Mutation checks

| Mutation | Tests that fail |
| --- | --- |
| In-lock head check removed in `intent/job.ts` (only the `pr_updated_at` half kept) | I-INT-9 |
| `combineRisk` floor term dropped | U-RISK-17, U-RISK-18, U-INJ-1 (+ U-GEN-4, -13, -20) |
| PR body appended to the verifier data | U-GEN-15 |
| `<!--` rewrite removed from both functions in `markdown.ts` | U-MD-4, U-MD-9, U-INJ-2, U-INJ-4 |
| **In-lock head check removed in `provenance/job.ts`** (the unverified README claim) | **I-PROV-10c fails** — the claim holds |

## What is good

- Safety rule: `combineRisk` takes `max(floor, …)` over every source; every unavailable path (`unavailableResult`, writer/escalation failure, deadline, budget, too large, not configured) goes through `combineRisk({ unavailable: true })`, so nothing that was not checked can be `trivial`. Floor rules match path **and** previous path, case-insensitively, with `dot: true`; R3 covers every lockfile that is stripped of its patch.
- Verifier isolation is real (probe: the verifier message has no title, body, issue, writer `risk_class` or `risk_reason`).
- The nonce cannot be forged: it is a hash over the author's own text and is re-drawn on collision; the card block escapes `<`, so a writer that echoes the nonce cannot close a data block (probe: exactly 3 real closing tags in the verifier message with an obedient, tag-forging writer).
- `escapeProse`/`codeSpan` hold up against mentions, autolinks (`HTTPS://`, `WwW.`), HTML, entities (`&#64;`), comment openers (also hidden with U+200B), list/heading starters and backtick runs.
- LLM work and the card write are outside the lock; the lock only re-checks freshness and publishes. Keys follow D8 and the queue's deterministic-id semantics.
- `requested_action` is verified through `checks.get` (app id, name, `external_id` → card → repo) before any write; bots are dropped in both channels.

The README §7 deviations are all sound (the `<` escape and the `Cf` stripping in R15 are improvements). One remark on "Floor reasons": capping the check-run text at 5 paths per rule throws information away that the spec wanted in `text` (nit 13).

## Findings

### 1. major — The daily budget loses spend when an `unavailable` card is regenerated, so re-runs can bypass it

`src/modules/intent/store.ts:155-159`, `src/modules/intent/store.ts:246-256`, `src/modules/intent/job.ts:200-214`

`saveCard`'s `ON CONFLICT … DO UPDATE` writes the new result's token counters over the old ones, and `created_at` keeps its first value. `tokensUsedToday` sums the counters of rows created today. So:

- every regeneration of an `unavailable` row (auto-retry at +5/+10 min, every Re-run, every new event with the same inputs) deletes the tokens the previous attempt spent from the budget. Failures that spend real tokens are exactly the ones that repeat: `invalid_output` (two paid calls), `llm_refusal`, a failed escalation after a paid fast pass. A PR that makes the model refuse can be re-run once a minute, and the budget only ever sees the last attempt;
- a row created yesterday and regenerated today counts today's spend on yesterday;
- when two concurrent jobs both miss the cache and both write `ok`, the second save is dropped and its tokens never count.

D21 is the repo-level cost guard the plan asks for, and it does not hold on the failure paths.

Required fix: account spend per attempt, not per surviving row. For example, in the `DO UPDATE` add the old counters (`input_tokens = intent_cards.input_tokens + excluded.input_tokens`, same for output, cache write/read and `llm_calls`) and keep a separate "last attempt" usage if the card should show only that; or keep a small spend ledger (repo, day, tokens) written next to every `saveCard`, including the dropped-`ok` case. Add an integration test: an `unavailable`/`invalid_output` card, re-run with the same inputs, and `tokensUsedToday` includes both attempts; plus one for the regenerated-next-day case.

### 2. major — A GitHub failure while publishing logs (and persists) the rendered card, i.e. model output

`src/modules/intent/job.ts:282-285`, `src/github/errors.ts:59`, `src/queue/worker.ts:25-29`

`toJobError` returns the original Octokit `RequestError` for retryable failures (and wraps it as `cause` for permanent ones). The worker logs it as `{ err }`, and pino's error serializer copies the enumerable `request` field, including `request.body`. I checked this with a throwaway script: a `RequestError` for a `POST …/check-runs` whose body contains a canary is logged with the canary. In the publish step that body is the whole rendered card (`output.summary`, `output.text`: goal, behavior changes, verifier reasons) or the whole managed comment. pg-boss also stores the thrown error with `serialize-error` in `pgboss.job.output`, so the same text is kept for the job's retention period.

README §5's LLM contract says no model output is ever logged and logs carry metadata only. I-INT-12 (the forced 500 on check-run POST) does not look for model text in the logs, and I-INT-5's canary is in the diff, not in the model output, so nothing catches this.

Required fix: never let a raw Octokit error leave the job. In `toJobError` (or in the worker before logging and rethrowing), build a new error that carries only `{ what, status, classification, request method + URL path }`, with no `request.body`, `response.data` or `cause` that holds them. Extend I-INT-12 with a model-output canary in the fake writer's goal and assert it is absent from the captured logs and from `pgboss.job.output`. Step 2's provenance publish uses the same path, so the fix covers both.

### 3. minor — Reactions can be attributed to a card that was not on screen when they were made

`src/modules/intent/job.ts:101`, `src/modules/intent/job.ts:281`, `src/modules/intent/store.ts:219`

- `published_at` uses `now`, taken at job start, before the file listing and up to 600 s of model calls. For a same-head update (a description edit, so no D11 note) the old card stays visible during generation, and reactions to it in that window go to the new card. Take the timestamp inside the lock (`ctx.clock.now()` just before `markPublished`).
- Spec interaction (D9 + T14.3): an `unavailable` row is regenerated in place, keeping its id and its first `published_at`. A 👎 on the "card unavailable" notice therefore counts against the `ok` card that replaced it 5 to 10 minutes later. The same happens for A→B→A: the re-published card A keeps its old `published_at`, so reactions after the re-publish go to B. Record each display, for example a `last_published_at` that `attributeReactions` uses together with the other cards' displays, or reset `published_at` when the status changes from `unavailable` to `ok`. Settle this with the spec owner if you prefer, but the step 6 accuracy gate depends on it.

### 4. minor — The 600 s deadline does not bound wall time, because SDK retries multiply the per-call timeout

`src/llm/anthropic.ts:106`, `src/modules/intent/generate.ts:360-366`

`timeoutMs = min(o.timeoutMs, remaining)` is per attempt, and the SDK retries timeouts up to `maxRetries` times with backoff. One call can therefore take `(maxRetries + 1) × timeout` (360 s with the defaults). Add the repair call, the escalation, the verifier and the time spent before `runCard` (listing up to 30 pages, the D11 note), and the worst case passes the 900 s `expireInSeconds` that D6 says it stays under. Pass an `AbortSignal.timeout(remaining)` (or `signal`) on the request so the whole call, retries included, ends at the deadline, and start the deadline at job start.

### 5. minor — The server-side fallback response is read as one text stream

`src/llm/anthropic.ts:137-146`

With `fallbacks: "default"`, the response `content` can hold a `fallback` block that "marks the point in content where one model's output gives way to the next" (SDK typings, `BetaFallbackBlock`). The code joins every `text` block. If the declining model produced partial JSON before it declined, the result is invalid JSON, a paid repair call, and probably `invalid_output`. That is safe, but D5 then does not rescue the card. Use only the text blocks after the last `fallback` block, and add a U-LLM-2 case with a fallback-shaped response (`[text "{\"go", fallback, text <valid json>]`). `response.model` is relabeled to the serving model (see `BetaMessageStream`), so the model handling is fine.

### 6. minor — "Graft retries automatically" can be shown when no retry was queued

`src/modules/intent/job.ts:218-219`, `src/modules/intent/job.ts:291-300`

`retryScheduled` is decided before `queue.send`, and the `null` result of a deduplicated send is ignored. The retry key `intent-retry:{change}:{head}:{hash16}:{n}` lives for 7 days, including completed jobs. A later event with the same head and inputs that fails again (for example after a description edit and revert) publishes "retries automatically", but its send is dropped. Either include something unique to the triggering run in the key (its `deliveryId`), or render the section after the send and fall back to the "Re-run" text when it returns `null`.

### 7. nit — Model strings that are only format characters pass validation and render as empty items

`src/modules/intent/output.ts:15-29`

`String.prototype.trim` does not remove U+200B and friends. A goal or behavior change of `"​"` passes `min(1)`, and `escapeProse` then turns it into `**Goal:** ` or a bare `- ` (probe). Strip `Cf` before the emptiness check.

### 8. nit — R15 is easy to sidestep with whitespace, and paths are not scanned

`src/modules/intent/risk-floor.ts:269-278`, `src/modules/intent/generate.ts:178-183`

The spec patterns use single literal spaces, so `ignore  previous instructions`, or one with a line break inside, does not match. File paths are untrusted too and are not in `untrustedTexts`. This is a spec-level choice, and R15 is only one of the defences. Consider `\s+` in place of the spaces and adding the paths (a spec change).

### 9. nit — `GH-123` autolinks and back-references issues

`src/github/markdown.ts:36`

GitHub turns `GH-<n>` into an issue reference (with a timeline back-reference), and `escapeProse` leaves it alone. The system prompt forbids issue references, but model output is untrusted. Break it like `#`, for example with a word joiner after `GH`, case-insensitively.

### 10. nit — The button vote goes to the card the check run shows now, not the card that was clicked

`src/modules/intent/feedback.ts:118`

`checks.get` returns the current `external_id`. If the check run was PATCHed with a newer card between the click and the job, the vote goes to the newer card. A cheap guard: if the payload's `check_run.external_id` differs from the fetched one, log `feedback_rejected` (the payload can only narrow, never widen, what is accepted).

### 11. nit — Every pure rename raises the floor to `logic`

`src/modules/intent/risk-floor.ts:339`

A `renamed` file with `patch: null` and 0/0 lines is classified `no_patch_from_api`, so it goes into `partialPaths` and triggers R13. That is safe but noisy for rename-only refactors. Consider treating a pure rename (0/0, no patch) as `full` with an empty patch.

### 12. nit — The settings hook will need more than `repositoryId` in step 5

`src/modules/intent/settings.ts:9-12`

Reading `graft.yaml` needs an installation client and a ref (the base, so the PR cannot edit its own policy). The hook has `ctx` but no installation id, owner/repo or base SHA. Widening the signature now (`{ installationId, owner, repo, baseSha }`) saves a refactor of the job in step 5. `generateCard` itself is fine as the step 4 eval hook: it is pure apart from `llm`, and it is exported from `index.ts` with `cardInputsSchema`, the fakes and the types.

### 13. nit — The check-run text shows at most 5 paths per floor rule

`src/modules/intent/risk-floor.ts:383-384`, `src/modules/intent/render.ts:302`

T13 asks for "up to 50 paths each" in `text`. Because `FloorReason.paths` is capped at 5, the check run shows no more than the comment does. If the 5-path cap must stay in the stored reasons, carry a separate list of up to 50 paths for the check output.

## Required before approval

Findings 1 and 2, each with the tests named there. Findings 3 to 6 should be fixed in the same pass if you can; they are cheap and two of them affect what the step 6 gate measures.
