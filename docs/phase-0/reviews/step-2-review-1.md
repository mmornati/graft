# Step 2 review 1

Verdict: CHANGES REQUESTED

Reviewer: senior engineer (Opus). Scope: the uncommitted working tree on top of the step 1 commit (`3988222`), checked against [step-2-provenance.md](../step-2-provenance.md) and the [Phase 0 constraints](../README.md).

## What I ran

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `pnpm db:up` | ok |
| `pnpm lint` | ok (Biome checked 96 files, no fixes) |
| `pnpm typecheck` | ok |
| `pnpm test` | 27 files, 170 tests, all pass (about 25 s). No `skip`, `only` or `todo`. |
| `pnpm build` | ok |
| `db:migrate` → `db:status` → `db:rollback` → `db:status` → `db:migrate` | `0002_provenance` alone rolls back (`0001` stays applied), status shows it `pending`, and `up` re-applies it |
| `grep -rnE "@ts-(ignore\|expect-error)" src/` | no hits |
| `grep -rn "I-SEC-\|U-PAY-\|U-TRL-\|I-PROV-" test/ \| wc -l` | 42 |
| Every §9 test ID | present as an `it(...)` prefix, including U-TRL-1..18, U-FLD-1..13, U-PROV-1..12, U-REN-1..7, U-MC-1..8 (plus 9 and 10), U-GHE-1..4, U-FETCH-1..3, U-PAY-1..5, I-PROV-1..12, I-SEC-1..4, I-CHG-1..7, I-LOCK-1, I-Q-4, I-DB-7 and I-E2E-2 |
| Manual smoke test (`.env` from the example, throwaway `dev.pem`, `GITHUB_API_URL=http://127.0.0.1:9`; server and worker; `installation.created`, then `pull_request.opened` as `smoke-2` and `smoke-3`) | Both PR deliveries returned `202 enqueued`. `pgboss.job` holds exactly one `provenance.refresh` job, so replay dedup works. The worker logged the token failure as a retryable `RequestError` with state `retry`, and did not crash. The authorization header in the log is `bearer [REDACTED]`. |

I then deleted `.env`, `dev.pem` and the smoke rows (installations, repositories, deliveries, pg-boss jobs). The dev database was empty before the test.

I also fed nasty inputs to `parseTrailerBlock`, `extractGraftFields` and `validateSessionUrl` with a throwaway script, which I did not commit. Findings 1 and 7 come from that run.

## Overall

This is solid work. The structure follows D18. Handlers only validate and enqueue; I checked that no `pull_request` or `check_run` handler calls `insertInto`, `updateTable` or Octokit. The job writes only values from the live API. Commit messages, bodies and emails are never stored or logged, and warnings carry codes only (U-FLD-13, U-PAY-5). The error classification and `PermanentJobError` match D16, and the managed-comment contract is clean. U-REN-1, U-MC-1 and I-PROV-1 compare against hand-written expected strings from §8, not against renderer output, so they are not tautologies. The concurrency tests drive real Postgres locks.

Three problems need fixing before commit: a markdown-injection gap in the session link, and two places where published provenance can go stale.

## Deviations (README §7): my assessment

| Deviation | Verdict |
| --- | --- |
| Dedup key adds `updated_at` for `closed`/`reopened` | **Sound, but incomplete.** The same "swallowed by an earlier key" problem hits every action; see finding 2. |
| `db:rollback` reverts one migration | Sound. T1's AC requires it, and the test helper still goes to zero. |
| Comment published before the check run | Sound. This is the order I-PROV-8 describes, and a failure rolls back either way. |
| Early stop when the snapshot is not applied | Sound and actually necessary: without it, an older snapshot with the same head would republish over a newer one. It covers only half of the race, though; see finding 3. |
| `blockTooLong`, `truncated`, `repositoryFullName` | Sound. These are the minimum fields needed to implement P7, the footer and the issue URL. |
| `\|` percent-encoded in session URLs | Sound. GFM splits table cells on `\|` even inside a link destination. It is not enough on its own; see finding 1. |
| Truncation sentence also on the no-trailers footer | Sound. Otherwise the information would be lost. |
| U-REN-7 uses `octo@bot/@team` | Sound. `@octo/bot` cannot pass the agent character set, and the test also checks that it is rejected. |
| I-SEC-3 posts the body twice (as-is, then with `action: opened`) | Sound. The as-is body never reaches the handler, so the second post is what really exercises `parsePayload`. |
| I-Q-4 asserts `state = retry` rather than `retry_count` | Acceptable. pg-boss 12 only increments `retry_count` on the next fetch, and the permanent side still asserts `completed` with `retry_count = 0`. |
| `GITHUB_APP_SLUG` bot-login fallback (D13) | Sound. A human account cannot have a `[bot]` login, the check also requires `type === "Bot"`, it is opt-in, and it is tested both ways (U-MC-9/10, I-PROV-9). HUMAN-TODO records it. |

## Findings

### 1. major: the session link can carry markdown, autolink and mention injection (D14)

`src/modules/provenance/fields.ts:51-61`, `src/modules/provenance/render.ts:28-35`

`validateSessionUrl` checks the protocol, credentials and IP and localhost hosts. It does not restrict the hostname's characters. WHATWG `URL` accepts `` ` ``, `*`, `_`, `~`, `!`, `$`, `&`, `'`, `{`, `}` and `=` in a special-scheme host, and these all survive into both the link text (`hostname`) and `href`. The query and fragment also keep `\` and `` ` `` as they are. Verified results:

- `https://a*b_c`d.com/s` → accepted, hostname `a*b_c`d.com`
- `https://x.dev/?a\` → accepted, href `https://x.dev/?a\`

Exploit: `Graft-Session: https://a`b.com/https://evil.example/@octocat` renders as

```
| **Session** | [a`b.com](https://a`b.com/https://evil.example/@octocat) |
```

Code spans bind more tightly than link brackets, so the code span runs from the backtick in the link text to the backtick in the destination, and the link never forms. What is left is literal `b.com/https://evil.example/@octocat)`. GFM autolinks `https://evil.example/...`, which puts a phishing link into Graft's own comment. Variants put `@user` after a non-word character, which mentions and notifies that user from the App's comment, or add `**…**` emphasis. A trailing `\` in the query escapes the closing `)` and breaks the cell the same way. D14 promises that every value is rendered "inside a code span or as a link with an encoded destination"; the destination is encoded here, but the link text and the breakout are not.

Required fix:
- After parsing, require the hostname to be plain LDH. For example, every label matches `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`, there are at least two labels, and the total length is at most 253. WHATWG already lowercases and punycodes the host.
- Also percent-encode `\` and `` ` `` in `href`. Encoding `*`, `_` and `~` too is cheap belt and braces.
- Add U-FLD cases (a backtick host, a `*` host, a trailing `\` in the query) and a U-REN case asserting that the rendered session cell is exactly one well-formed link.

### 2. major: an A→B→A change within 7 days is deduplicated away, leaving stale provenance

`src/modules/provenance/handlers.ts:62-75`

The D6 key for `opened`, `synchronize` and `edited` is `prov:{repo}:{pr}:{head}:{base}:{bodyHash}`. When a PR returns to an earlier state, the key equals a key whose job already completed, so `send` returns `null` and no refresh runs. Examples:
- the body is edited X → Y → X (for example, a trailer is removed from the description and then restored);
- a force-push is reverted (head H1 → H2 → H1).

The comment, the check run and `change_provenance` (including `author_kind`, which step 5 policies consume) stay at state B until some unrelated event arrives. The developer found exactly this failure mode for `closed`/`reopened` and patched only those two actions.

Required fix: add `pull_request.updated_at` to the key for **every** action, and make `updated_at` required in `pullRequestPayload`. A replayed body carries the same `updated_at`, so I-SEC-1 and the replay half of I-CHG-6 still hold. The cost is that title-only edits enqueue a redundant job. That job is idempotent (the comment comes back `unchanged` and the check run gets one PATCH), so it is acceptable. Update README §7 and D6's wording, and add a handler test for the X → Y → X body sequence.

### 3. major: the in-lock staleness check ignores body-only changes

`src/modules/provenance/job.ts:170-175`

Inside the lock the job treats a run as stale only when `changes.head_sha !== pull.head.sha`. Two jobs on the **same head** with different live bodies (two quick `edited` events, or `edited` plus `rerequested`) can interleave like this:

1. A runs `pulls.get` (T1, body X) and its upsert applies.
2. B runs `pulls.get` (T2, body Y) and its upsert applies.
3. B takes the lock first, because A is still in `fetchPrCommits`, and publishes Y.
4. A takes the lock, the head still matches, and A publishes X over Y.

The early stop added at line 137 does not help, because both upserts applied. The body supplies the fallback `session`/`task`/`model` values and can decide `author_kind`, so the final output can be older than the PR, which D5 and T9.3 rule out.

Required fix: inside the lock, also return `stale` when `current.pr_updated_at` is newer than `new Date(pull.updated_at)`. Add an I-PROV-10 variant with the same head and a different body. That variant also covers the in-lock "head moved" branch, which no test reaches today (see finding 5).

### 4. minor: deterministic output errors are retried 8 times

`src/github/managed-comment.ts:108-110,149`, `src/modules/provenance/job.ts:214-216`

`upsertManagedSection` throws a plain `Error` when a section contains the marker, is longer than 20,000 characters, or when the whole body would exceed 65,536 characters. `toJobError` classifies a non-HTTP error as `transient`, so the same deterministic failure is retried 8 times. It can happen for real: a maintainer can edit the bot comment and leave a large unknown section. Throw a `PermanentJobError` with reason `invalid_output`, or a typed error that the job maps to one.

### 5. minor: the in-lock "head moved" branch has no test

`src/modules/provenance/job.ts:172-175`

I-PROV-3 reaches the early `applied: false` stop. I-PROV-10 holds job A inside the PATCH after its head check, so neither test executes the in-lock stale path. Pause job A before it takes the lock (block `GET …/pulls/2/commits`) while job B runs to completion, then assert that A publishes nothing. This can be the same test as the one in finding 3.

### 6. minor: rerequest replays are unbounded and undocumented

`src/modules/provenance/handlers.ts:139-151`, README §5 "Webhook replay"

The re-run key is `prov-rerun:{deliveryId}`. A captured `check_run.rerequested` body replayed under fresh delivery IDs therefore enqueues a full refresh (`pulls.get`, commit pages and two writes) every time, with no 7-day window. That is by design (D6), but the README's residual-risk sentence ("extra API calls after the 7-day window") understates it. Say so in the README. Optionally, collapse re-runs per `{repo}:{pr}:{minute}`.

### 7. nit: `localhost.` and Unicode whitespace

`src/modules/provenance/fields.ts:52,68`, `src/modules/provenance/trailers.ts:34,40`

- `https://localhost./s` is accepted, because of the trailing dot. Strip one trailing `.` before the host checks. The LDH rule from finding 1 makes this easy.
- JS `\s` and `trim()` are Unicode-aware. A line containing only U+00A0 counts as a paragraph separator, which git would not do. A U+FEFF inside an agent value is normalized to a plain space instead of being rejected as §6.3 says. The output stays ASCII, so this is harmless, but use `[ \t]` for git parity.

### 8. nit: warning types and wording

`src/db/schema.ts` (`StoredWarning.code: string`), `src/modules/provenance/render.ts:62`

- T1 asks that the `Json<T>` columns use the T5 types. Type `code` as `WarningCode`, or reuse `ProvenanceWarning`.
- `unknown_graft_key` renders as "trailer block ignored", but only that one key was ignored. Prefer "unknown Graft key ignored (unknown_graft_key)".

### 9. nit: a note for step 3 in the managed-comment contract

`src/github/managed-comment.ts:20-21`

The lock is a transaction that holds a pooled connection for the whole time a comment or check request is in flight. Add one sentence: *"Do no slow work (LLM calls, diff fetches) inside `withChangeLock`; compute first, then lock, re-check freshness and publish."* Step 3 will otherwise be tempted to call the model inside the lock. Apart from this, the contract fits step 3 well: `SectionName` already includes `intent` and orders it first, other sections are preserved byte-for-byte, and `upsertManagedSection` returns the ID to mirror into `intent_cards.comment_id`.

## Summary of required changes

1. Restrict session hostnames to LDH and encode `\` and `` ` `` in the href, with tests (finding 1).
2. Put `updated_at` in every refresh dedup key, with a test (finding 2).
3. Inside the lock, treat a newer stored `pr_updated_at` as stale, with a same-head concurrency test (findings 3 and 5).

Findings 4 and 6–9 are optional, but cheap to do in the same pass.
