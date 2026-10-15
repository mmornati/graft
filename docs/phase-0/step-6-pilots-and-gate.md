# Phase 0, Step 6: Pilots and gate

Spec for the developer agent. Implement exactly this. Where this spec is silent, choose the simplest option and record it in README §7 ("Step 6 deviations and additions"). The [Phase 0 README](README.md) constraints are binding: offline build and test, Postgres from `docker compose`, **no stored code, diffs or file contents**, pnpm, Node 24, strict TypeScript. The code after step 5 is described in the repo [README](../../README.md) §5 and §7; where this spec and the README disagree on an existing interface, the README wins.

Binding rules from earlier steps:
- **Payloads are triggers** (README §5, "Webhook replay"): handlers validate and enqueue; jobs write only from API data or data Graft computed.
- **Lock discipline**: no slow work inside `withChangeLock`. This step writes no PR output, so it takes no change lock.
- **Module graph**: modules import each other only through `index.ts`; a module that is imported by another (intent, provenance) reaches back only through **signals** (`src/core/signals.ts`).
- **Log hygiene**: logs, job data and errors carry ids, counts and codes, never PR text, logins of voters, or model output.
- **Phase 0 enforces nothing.** No code path in this step changes a check conclusion, a branch protection or a PR.

## 1. Goal

Onboarding the two pilot teams is human work (HUMAN-TODO). This step ships the tooling that makes it repeatable and measurable, and decides the Phase 0 gate from data:

1. **Onboarding kit**: `docs/pilots/onboarding.md`, three starter `graft.yaml` files, a trailer hook for agent harnesses, an offboarding procedure backed by `pnpm graft pilot purge`, and `pnpm graft pilot doctor`.
2. **Baseline**: `pnpm graft baseline` pulls historical PRs, reviews and timelines and stores per-PR **numbers** and aggregates of review time.
3. **Gate report**: `pnpm graft gate report` computes card accuracy from **eligible** reviewer votes with a Wilson interval and minimum N, plus the side metrics, and prints **PASS / FAIL / INSUFFICIENT DATA**.
4. **Ongoing metrics**: a daily rollup job writes additive counters into `metrics_daily`.
5. **Escaped defects**: `pnpm graft incident add` and label-based detection record incidents per culprit PR (Phase 1 needs the baseline).
6. **Deferred items**: step 3 review 2 nits 4 and 7, step 5 review 7 minor 1 and nit 2, and a lookalike-character defence for globs (T13 to T15).

## 2. Out of scope

Do not create stub code for any of these.

- Dashboards, charts, a web UI, or showing tallies on the PR. Markdown + JSON reports only.
- Business-hours or timezone-aware review time. Durations are wall clock minus paused intervals (§8.2).
- Automatic calibration of the step 4 `cardAcceptableRate` against thumbs (manual, HUMAN-TODO).
- Enforcement, team membership (`members: read`), MCP, post-merge guard (Phase 1).
- Expanding a team review request into its members (needs `members: read`). Team members are eligible only through their own review or the allow-list.
- Any manifest change. Everything here uses existing permissions: `pull_requests: read` (reviews, requested reviewers), `issues: read` (timeline), `contents: read`, and the already subscribed `pull_request` event (`review_requested`, `labeled`, `closed`).
- A baseline for repositories where the App is not installed (`--auth token`). Pilots install first, in shadow mode.
- Validating `pnpm eval init --sensitive-paths` with the new glob checks.

## 3. Decisions

| # | Area | Choice | Rationale |
| --- | --- | --- | --- |
| D1 | Layout | `src/modules/pilot/` (handlers, jobs, signal listener, stores) and `src/pilot/` (CLI-side libraries: baseline, gate, doctor, purge, stats, report rendering). `src/pilot` may import `db`, `config`, `github`, `core`, and modules through their `index.ts`; nothing imports `src/pilot` except `src/bin`. | Same split as `src/policy` / `modules/policy`: the CLI and the worker share code without cycles. |
| D2 | CLI entry | `src/bin/graft.ts` keeps `policy` exactly as is and dispatches `pilot`, `baseline`, `gate`, `incident`, `metrics` with a **dynamic** `await import("./graft-ops.js")`. | U-CLI-6 requires the static closure of `graft.ts` to stay free of `db`, `config` and `modules`; `graft policy check` must keep running with an empty env. |
| D3 | Baseline storage | **Database**, new tables `review_time_runs` and `review_time_prs` (FK to `repositories`, `ON DELETE CASCADE`). Rows hold PR numbers, author kind, size bucket, minutes, counts and flags. **No** titles, bodies, paths, logins (not even hashed), SHAs or code. | One purge path (installation cascade), the gate report joins in SQL without files on laptops, and nothing in it is sensitive. A JSON export would need the eval set's file discipline (outside git, encrypted, purged per laptop) for no gain. Hashed logins were considered and dropped: no metric needs a user identity once rounds and self-approvals are resolved in memory. |
| D4 | Shadow-period review time | The same extractor runs with `--period shadow` over the pilot window; the gate report compares the latest `shadow` run with the latest `baseline` run per repository. | One definition for both sides; numbers are comparable by construction. |
| D5 | Reviewer eligibility | A vote counts only if its voter is, for that PR: a **requested reviewer** (user ever requested while Graft watched), a user who **submitted a review** (any state), or on the report's **allow-list** (`--allow-file`). Always excluded: the PR author, `Bot` users (already dropped at ingest), logins ending `[bot]`, and `GRAFT_AGENT_LOGINS`. Eligibility is stored in `pr_reviewers` (user ids, no logins) by the `pilot.reviewers.sync` job. | Step 3 D20 deferred this. Collaborators who drive the agent, drive-by reactions and the author's own thumbs would bias accuracy upward. Storing ids at sync time keeps the report offline and cheap. |
| D6 | Accuracy unit | One **effective vote** per (displayed card version, user): the latest across reaction and button (existing rule). Only cards with `status = 'ok'`; votes made while an `unavailable` or `pending` display was shown were already dropped. Accuracy = up / (up + down) over eligible effective votes. | "Per displayed card version" is the card row (head, prompt, inputs); per-user dedupe is the existing effective-vote rule. |
| D7 | Gate decision | Wilson 95% interval. **INSUFFICIENT DATA** below N_min (§8.1.4). **FAIL** when the upper bound < 0.90 (N ≥ 50). **PASS** when p̂ ≥ 0.90 and lower bound ≥ 0.85 and the coverage conditions hold. Otherwise INSUFFICIENT DATA ("inconclusive"), unless N ≥ 400, where p̂ decides. | A point estimate on 40 votes is noise; a strict "lower bound ≥ 0.90" would need ~1,000 votes at p = 0.93. N = 400 bounds the wait. |
| D8 | Rollups | `metrics_daily (repository_id, day, counts jsonb, rollup_version)`, UTC days, **additive counters only**. Daily cron recomputes the last 7 days (idempotent upsert). **Retention 730 days**, pruned by the same job; purged with the installation. Accuracy and percentiles are always computed from raw rows at report time. | Counters sum over any window; votes (dedupe, eligibility changes) and percentiles do not. 730 days covers Phase 0, Phase 1 and a year-over-year look. jsonb lets Phase 1 add counters without a migration; a zod schema guards the keys. |
| D9 | Cost | Cost per model call is computed at spend time from `response.model` and stored in a new nullable `intent_spend.cost_usd`. `src/eval/pricing.ts` moves to `src/llm/pricing.ts` (eval re-exports it). Rows before 0006 or with an unknown model stay `NULL` and are reported as "unpriced". | Card rows only hold the last run's summed tokens across models, so cost cannot be recovered later. |
| D10 | Incidents | Table `incidents` keyed by repository and culprit **PR number** (not change id: baseline-period culprits have no change row). Sources: `cli` and `label`. Label detection reads the **live** PR body in a job (payload = trigger) and accepts only `Reverts <owner>/<repo>#N` (GitHub's revert button) or a line `Graft-Culprit: #N`. Stored: numbers, source, timestamps, severity. | Phase 1's "no rise in escaped defects" needs a per-PR baseline. Two strict link forms avoid guessing culprits from prose. |
| D11 | Purge | `pnpm graft pilot purge` deletes the `installations` row (every app table cascades from it, verified by I-PURGE-2), `webhook_deliveries` of the installation or its repositories, and pg-boss jobs whose data names the installation. Refused while the installation is active unless `--even-if-active`. Writes one `pilot_purges` row (installation id, counts, time; no login). | The cascade already exists; a test that enumerates `TABLE_NAMES` makes a future table without a purge path fail. |
| D12 | Doctor | DB-only health checks (no GitHub call) with OK/WARN/FAIL lines; exit 1 on any FAIL. | Runs anywhere the DB is reachable; safe for pilots' on-call. |
| D13 | Trailers for harnesses | A POSIX `prepare-commit-msg` hook in `scripts/pilot/` adds `Graft-*` trailers from env (`GRAFT_AGENT`, `GRAFT_MODEL`, `GRAFT_TASK`, `GRAFT_SESSION`) with `git interpret-trailers --if-exists doNothing`; it does nothing when `GRAFT_AGENT` is unset. | Harness-agnostic: any agent that can set env vars gets provenance; humans are unaffected. |
| D14 | Lookalikes in globs | Reject a glob segment whose letters mix scripts outside UTS #39 "highly restrictive" (`glob_invalid` detail 9). Warn (never fail) on any non-ASCII character (`glob_non_ascii`). Applies to `graft.yaml` globs, `sensitive_paths` and `GRAFT_INTENT_SENSITIVE_PATHS`. | `sеcrets/**` with a Cyrillic `е` reads right and never matches, which silently loosens a tightening rule. All-Cyrillic or Japanese paths are legitimate. |

## 4. Files

| File | Change |
| --- | --- |
| `src/db/migrations/0006_pilot.ts`, `index.ts`, `src/db/schema.ts` | New tables and column (§6); `TABLE_NAMES` gains 6 tables |
| `src/llm/pricing.ts` (moved), `src/eval/pricing.ts` | Move; eval re-exports everything unchanged |
| `src/github/rate-limit.ts` (moved), `src/eval/rate-limit.ts` | Move `installRateLimit`; rename `EvalAbort` to `RateLimitAbort`; eval re-exports `RateLimitAbort as EvalAbort` |
| `src/core/size.ts` | `sizeBucket(changedLines)` (the step 4 thresholds); `src/eval/sample.ts` re-exports it as `sizeStratum` |
| `src/core/signals.ts` | `ChangeSignal.kind` gains `"feedback_recorded"` |
| `src/modules/intent/*` | Spend cost (T3), feedback signal (T4), `effectiveVotes` export (T7), nits (T13) |
| `src/modules/policy/handlers.ts` | `onChangeSignal` ignores `feedback_recorded` |
| `src/modules/pilot/{index,handlers,reviewers,incidents,rollup,store}.ts` | New module (T4 to T6, T10) |
| `src/app/registry.ts` | Add `pilot` |
| `src/pilot/{baseline,timeline,stats,gate,gate-render,doctor,purge,incident-cli,allow-list}.ts` | CLI libraries |
| `src/bin/graft.ts`, `src/bin/graft-ops.ts` | Dispatch (D2) |
| `src/config/index.ts`, `src/bin/bootstrap.ts` | New env (§7), glob validation (T14) |
| `src/policy/globs.ts`, `errors.ts`, `parse.ts`, `src/modules/policy/render.ts`, `src/core/glob.ts` | T14, T15 |
| `scripts/pilot/prepare-commit-msg` | Hook (D13), executable |
| `docs/pilots/onboarding.md`, `docs/pilots/graft.{service,platform,library}.yaml` | Kit (T1) |
| `test/helpers/fake-github-api.ts` | Timeline, requested reviewers, `pulls.get` additions/deletions, labels on PRs |
| README, HUMAN-TODO | T16 |

## 5. Interfaces

```ts
// src/modules/intent/index.ts (new export)
export interface EffectiveVote {
  cardId: string; changeId: string; repositoryId: number; installationId: number;
  userId: number; userLogin: string; verdict: "up" | "down"; source: "reaction" | "check_action";
  reactedAt: Date; isPrAuthor: boolean; cardStatus: "ok" | "unavailable";
}
/** Effective vote per (card, user) = latest reacted_at across sources (ties: check_action first,
 *  as feedbackSummary); then filtered to reactedAt in [since, until). */
export function effectiveVotes(ex: Executor, o: { installationIds: number[]; since: Date; until: Date }): Promise<EffectiveVote[]>;

// src/pilot/stats.ts (pure)
export function wilson(up: number, n: number, z?: number): { lower: number; upper: number } | null; // null when n = 0
export function percentile(sorted: readonly number[], p: number): number | null;   // type 7 (linear)
export function summarize(values: readonly number[]): { n: number; p50: number | null; p75: number | null; p90: number | null };

// src/pilot/timeline.ts (pure)
export interface TimelineInput {
  createdAt: string; mergedAt: string | null; closedAt: string | null; draftNow: boolean;
  authorLogin: string; now: Date;
  events: readonly TimelineEvent[];   // normalized from issues.listEventsForTimeline, oldest first
  excludedReviewerLogins: readonly string[]; // lowercased agent logins
}
export type TimelineEvent =
  | { kind: "review_requested"; at: string; reviewer: { login: string; type: string } | null; team: boolean }
  | { kind: "ready_for_review" | "convert_to_draft" | "closed" | "reopened" | "merged"; at: string }
  | { kind: "reviewed"; at: string; user: { login: string; type: string } | null; state: string; commitId: string | null };
export interface PrReviewTimes {
  startBasis: "review_requested" | "ready_for_review" | "opened";
  minutesToFirstApproval: number | null; minutesToMerge: number | null;
  reviewRounds: number; mergedWithoutReview: boolean; pausedMinutes: number;
  excludedApprovals: { self: number; bot: number };
}
export function reviewTimes(i: TimelineInput): PrReviewTimes;

// src/pilot/gate.ts (pure core)
export type GateVerdict = "PASS" | "FAIL" | "INSUFFICIENT_DATA";
export function decideGate(o: GateInputs): { verdict: GateVerdict; reasons: GateReason[] };
```

`GateReason` is a code (`below_min_votes`, `below_min_prs`, `below_min_voters`, `pilot_below_min`, `fewer_than_two_pilots`, `window_too_short`, `inconclusive`, `upper_below_target`, `coverage_cards`, `coverage_provenance`, `point_estimate_decides`) plus numbers.

## 6. Schema (migration `0006_pilot`)

`up` (all `ON DELETE CASCADE` unless stated; no column name may match I-DB-4's regex):

```sql
ALTER TABLE intent_spend ADD COLUMN cost_usd numeric(14,8);            -- NULL = unpriced
CREATE TABLE pr_reviewers (
  change_id     uuid   NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  user_id       bigint NOT NULL,
  reason        text   NOT NULL CHECK (reason IN ('requested','reviewed')),
  first_seen_at timestamptz NOT NULL,
  PRIMARY KEY (change_id, user_id, reason));
CREATE TABLE review_time_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id  bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  period         text   NOT NULL CHECK (period IN ('baseline','shadow')),
  from_date      date   NOT NULL, to_date date NOT NULL CHECK (to_date > from_date),
  base_ref       text   NOT NULL,
  extractor_version integer NOT NULL,
  pr_count       integer NOT NULL, excluded_count integer NOT NULL,
  aggregates     jsonb  NOT NULL,                                       -- §8.2.6, validated by zod
  requests       integer NOT NULL,
  extracted_at   timestamptz NOT NULL);
CREATE INDEX review_time_runs_repo_idx ON review_time_runs (repository_id, period, extracted_at DESC);
CREATE TABLE review_time_prs (
  run_id        uuid    NOT NULL REFERENCES review_time_runs(id) ON DELETE CASCADE,
  pr_number     integer NOT NULL,
  state         text    NOT NULL CHECK (state IN ('merged','closed','open')),
  author_kind   text    NOT NULL CHECK (author_kind IN ('agent','human')),
  author_kind_reason text NOT NULL,
  size_bucket   text    NOT NULL CHECK (size_bucket IN ('S','M','L','XL')),
  start_basis   text    NOT NULL CHECK (start_basis IN ('review_requested','ready_for_review','opened')),
  minutes_to_first_approval numeric(12,1), minutes_to_merge numeric(12,1),
  review_rounds integer NOT NULL, merged_without_review boolean NOT NULL,
  paused_minutes numeric(12,1) NOT NULL,
  excluded_reason text CHECK (excluded_reason IN ('excluded_author','timeline_truncated','commits_truncated')),
  PRIMARY KEY (run_id, pr_number));
CREATE TABLE incidents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id      bigint  NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  culprit_pr_number  integer,                                           -- NULL: label without a link
  fix_pr_number      integer,
  source             text    NOT NULL CHECK (source IN ('cli','label')),
  severity           smallint CHECK (severity BETWEEN 1 AND 4),
  occurred_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (repository_id, culprit_pr_number, fix_pr_number));
CREATE TABLE metrics_daily (
  repository_id  bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  day            date   NOT NULL,
  rollup_version integer NOT NULL,
  counts         jsonb  NOT NULL,
  computed_at    timestamptz NOT NULL,
  PRIMARY KEY (repository_id, day));
CREATE TABLE pilot_purges (                                             -- no FK: outlives the purge
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id  bigint NOT NULL,
  rows_deleted     jsonb  NOT NULL,                                     -- {table: count}
  purged_at        timestamptz NOT NULL);
```

`down` drops the six tables (`IF EXISTS`) and the column. `pilot_purges` is in `TABLE_NAMES` but **not** purged (it holds no personal data; I-PURGE-2 lists it as the one exempt table).

## 7. Configuration (new env)

| Variable | Default | Rule |
| --- | --- | --- |
| `GRAFT_INCIDENT_LABEL` | `incident` | `off`, or 1-50 chars `[A-Za-z0-9 ._:/-]` |
| `GRAFT_METRICS_ROLLUP_CRON` | `15 2 * * *` | `cronOrOff` (as the feedback cron) |
| `GRAFT_METRICS_EXCLUDED_AUTHORS` | `dependabot[bot],renovate[bot]` | `loginList`; excluded from baseline, rollup PR counts and gate coverage (one constant source for both sides, D4) |

## 8. Metric definitions

All times UTC. A window `[since, until)` defaults `until` to the start of today. "Excluded authors" = `GRAFT_METRICS_EXCLUDED_AUTHORS`.

### 8.1 Card accuracy (the Phase 0 gate)

1. **Votes.** `effectiveVotes(installations, since, until)`, then keep only `cardStatus = 'ok'`.
2. **Eligibility** (D5). Keep a vote iff `!isPrAuthor`, the login does not end in `[bot]`, is not in `GRAFT_AGENT_LOGINS`, and (`(change_id, user_id)` is in `pr_reviewers` with any reason, or the lowercased login is in the allow-list). Count dropped votes per cause: `author`, `bot_or_agent`, `not_reviewer`.
3. **Statistic.** `n = up + down`, `p̂ = up / n`, Wilson 95% (`z = 1.959964`): `(p̂ + z²/2n ± z·sqrt(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)`.
4. **Minimum sample (N_min)**, all must hold: `n ≥ 150`; ≥ 50 distinct PRs with an eligible vote; ≥ 6 distinct voters; ≥ 2 installations, each with ≥ 40 eligible votes; window ≥ 14 days.
5. **Coverage conditions** over PRs opened in the window (not excluded authors, not closed within 10 minutes of opening): `card_coverage` = PRs with ≥ 1 display of any status / PRs ≥ 0.98; `provenance_coverage` = PRs with a `change_provenance` row / PRs ≥ 0.98.
6. **Decision** (D7), in order: if `n ≥ 50` and `upper < 0.90` → FAIL (`upper_below_target`). Else if any N_min condition fails → INSUFFICIENT_DATA (each failing condition is a reason). Else if a coverage condition fails → FAIL (`coverage_*`). Else if `n ≥ 400` → PASS iff `p̂ ≥ 0.90` (`point_estimate_decides`). Else PASS if `p̂ ≥ 0.90 and lower ≥ 0.85`, otherwise INSUFFICIENT_DATA (`inconclusive`). Installation ids that do not exist are a usage error (exit 2).
7. **Also reported** (not part of the decision): card-level accuracy (`feedbackSummary` rule: a card with any eligible down is inaccurate), per-installation accuracy and interval, votes by source, dropped votes by cause, `dominant_voter` warning when one voter casts > 40% of eligible votes, and "votes on PRs without a reviewer sync" (changes with votes but no `pr_reviewers` row).

Edge cases: a vote whose card was regenerated in place keeps its card id (step 3 rule); a user who reacted and pressed a button counts once (latest wins); a retracted reaction is gone after the next poll; a voter whose login changed matches the allow-list by the latest stored login; votes are windowed by the effective vote's `reacted_at`.

### 8.2 Review time (baseline and shadow)

1. **Population.** PRs of the repository with `created_at` in `[from, to)` and `base.ref` = `--base` (default: the repository's default branch). Listed with `pulls.list({state: "all", sort: "created", direction: "desc"})`, stopping at the first PR older than `from`.
2. **Per PR requests.** `pulls.get` (additions, deletions, draft, merged_at, user), `issues.listEventsForTimeline` (≤ 10 pages of 100, else `timeline_truncated`), `fetchPrCommits` + `computeProvenance` for author kind (truncated commits → still classified, `commits_truncated` only if the classifier cannot run). Excluded authors → row with `excluded_reason = 'excluded_author'`, no times.
3. **Paused intervals.** A PR is *paused* while draft or closed. Initially draft iff the first of `ready_for_review`/`convert_to_draft` in the timeline is `ready_for_review`, or there is none and `draftNow`. Draft runs from open (if initially draft) or each `convert_to_draft` to the next `ready_for_review`; closed runs from `closed` to the next `reopened`. A duration from S to T is `T − S − (paused time inside [S, T])`, floored at 0, in minutes with one decimal.
4. **Start S.** (a) the first `review_requested` event whose target is a team, or a user who is not the author, not `Bot`, not `[bot]` and not an agent login; a request made while paused takes effect when the pause ends; requests after merge are ignored; **re-requests never move S**. (b) Otherwise the first `ready_for_review` (PR opened as draft). (c) Otherwise `created_at`.
5. **Qualifying review**: a `reviewed` event by a user who is not the author (case-insensitive login; a *self-approval*, counted in `excludedApprovals.self`), not `Bot`, not `[bot]`, not an agent login (`excludedApprovals.bot`); state `pending` is ignored.
   - **First approval A** = the first qualifying review with state `approved`; `minutesToFirstApproval = dur(S, max(A, S))`, `null` if none.
   - **Merge**: `minutesToMerge = dur(S, merged_at)`, `null` unless merged.
   - **Review rounds** = number of distinct `commitId` among qualifying reviews submitted in `[S, A]` (or `[S, merged_at]`, or `[S, now]` when there is no approval); 0 when none. A review with a `null` commit counts as its own round.
   - **Merged without review** = merged and no qualifying review of any state before `merged_at`.
6. **Aggregates** (stored in `review_time_runs.aggregates`): for groups `all`, `agent`, `human`, and each `agent|human × S|M|L|XL`: `summarize()` of `minutesToFirstApproval` (non-null), of `minutesToMerge` (non-null), of `reviewRounds` (merged PRs), plus `prs`, `merged`, `mergedWithoutReview`, `open` (censored). Excluded rows are not in any group. A cell with `n < 5` is rendered as `n<5` in markdown but kept in JSON.
7. **Shadow comparison** (gate report): per group `all`, `agent`, `human`: baseline p50, shadow p50, `Δ% = (shadow − baseline) / baseline` for time to first approval and to merge. Labeled **"indicative: shadow mode, Graft blocks nothing"**. Phase 1 target shown alongside: agent `Δ%` of time to first approval ≤ −50%.

### 8.3 Side metrics (gate report)

| Metric | Formula | Source |
| --- | --- | --- |
| Would-auto-approve share | PRs merged in window whose **latest** verdict for the merge head (max `facts_read_at`) is `would_approve` / PRs merged in window; also split by author kind. MVP target ≥ 30% shown alongside. | rollup `merged_*` counters |
| Policy verdict distribution | Same population, counts of `would_approve`, `would_require`, `would_block`, `no_policy`, `policy_invalid`, `no_verdict` | rollup |
| Verifier disagreement rate | cards created `ok`: `disagree / (agree + disagree)`; `error` and `skipped` shares shown separately | rollup |
| Card unavailable rate | cards created: `unavailable / all`, plus per `failure_reason` (raw query); and per PR: PRs whose last non-pending display is `unavailable` / PRs with a display | rollup + raw |
| Cost per PR | Σ `intent_spend.cost_usd` with `spent_at` in window / distinct `change_id` of those rows; plus total tokens, `unpriced_runs`, `unpriced_tokens` | rollup |
| Escaped defects | incidents whose culprit PR was merged in the window (`changes.merged_at`) per 100 merged PRs, by author kind and by would-approve at merge; baseline rate = incidents on culprits in the latest baseline run's merged PRs per 100 of them | raw |

### 8.4 Rollup counters (`metrics_daily.counts`, `rollup_version = 1`)

Keys (all integers except `cost_usd`, a decimal string): `prs_opened`, `prs_opened_agent`, `prs_merged`, `prs_closed_unmerged` (by `opened_at` / `merged_at` / `closed_at` day; excluded authors left out), `cards_ok`, `cards_unavailable`, `verifier_agree`, `verifier_disagree`, `verifier_error`, `verifier_skipped` (by card `created_at`), `displays_ok`, `displays_unavailable`, `displays_pending`, `spend_runs`, `spend_tokens`, `cost_usd`, `unpriced_runs`, `unpriced_tokens` (by `spent_at`), `merged_would_approve`, `merged_would_require`, `merged_would_block`, `merged_no_policy`, `merged_policy_invalid`, `merged_no_verdict`, `merged_would_approve_agent`, `merged_agent`, `merged_trivial` (final ok card at merge head is `trivial`) (by `merged_at`), `incidents` (by `occurred_at`), `deliveries` (by `received_at`, matched on `repository_id`). Unknown keys fail the zod parse.

## 9. Tasks

### T1. Onboarding kit (docs + hook)

`docs/pilots/onboarding.md`, sections in this order:
1. **Prerequisites**: GitHub org admin for the install, a repo admin, the security owner, agreement signed (consent for diffs to Anthropic, optional eval-set export), Graft deployment running with `ANTHROPIC_API_KEY` and budget set.
2. **What Graft reads**: PR metadata, files list and patches (in memory), commits and messages (in memory), linked issue, reviews, reactions on Graft's comment, timeline (baseline), `graft.yaml` from the base branch.
3. **What Graft stores**: list every table by group with its content types (ids, numbers, SHAs, paths, model prose; logins only in `changes.author_login`, `intent_feedback.user_login`, `policy_verdicts.approvals` (≤ 10)). State plainly: **no source code or diffs are stored**; webhook payloads (which include PR titles and bodies) sit in the job queue until 7 days after their job finishes; logs carry metadata only.
4. **Data sent to Anthropic**: diffs, PR title/body, linked issue text, for card generation only; retention is the org's Anthropic terms (standard or ZDR, decided per HUMAN-TODO step 3) and must be named in the pilot agreement.
5. **Install on selected repositories only**: choose "Only select repositories" on the install screen; adding/removing a repo later; `repository_selection = 'all'` is a doctor WARN.
6. **Starter `graft.yaml` per archetype**: `docs/pilots/graft.service.yaml` (product service: trivial docs auto, auth/billing/migrations 1 human + security, agent+sensitive 2), `graft.platform.yaml` (infra/terraform/CI: every infra path requires the platform team, agent edits to `secrets/**` blocked), `graft.library.yaml` (public API surface `src/public/**` requires 2, docs/tests trivial auto). Each starts with the `yaml-language-server` schema line and comments.
7. **Provenance trailers**: Claude Code (a `CLAUDE.md` instruction block to copy, plus the hook), other harnesses (Codex, Cursor, Aider, Copilot coding agent, custom scripts): install `scripts/pilot/prepare-commit-msg` as `.git/hooks/prepare-commit-msg` (or via `core.hooksPath`) and export `GRAFT_AGENT`/`GRAFT_MODEL`/`GRAFT_TASK`/`GRAFT_SESSION` in the agent's environment; the PR-description fallback for harnesses that cannot run hooks; `GRAFT_AGENT_LOGINS` for agent accounts.
8. **Shadow mode**: every Graft check concludes `neutral`; nothing blocks or approves; keep branch protection as is; what reviewers do (read the card, vote 👍/👎 or the buttons; only requested reviewers and reviewers count).
9. **Weekly ritual** pointer to HUMAN-TODO.
10. **Offboarding and deletion**: uninstall the App → confirm `installations.deleted_at` → `pnpm graft pilot purge --installation <id> --confirm <account login> --dry-run`, then without `--dry-run` → `pnpm eval purge` on every labeler machine → ask Anthropic for deletion under the org terms if applicable → record the `pilot_purges` id in the pilot agreement.

`scripts/pilot/prepare-commit-msg` (POSIX `sh`, `set -eu`): exit 0 when `GRAFT_AGENT` is unset or empty, or when `$2` is `merge` or `squash`; otherwise append each set variable with `git interpret-trailers --in-place --if-exists doNothing --trailer "Graft-Agent: $GRAFT_AGENT"` (and the other three). No other side effect.

**AC:** U-DOC-1 (each starter file passes `parsePolicyText` with no warnings); U-DOC-2 (onboarding links resolve to existing files and names every command of §10); U-HOOK-1/2.

### T2. Migration 0006 and schema types

As §6; `schema.ts` interfaces; `TABLE_NAMES` + 6. **AC:** I-DB-2/3/7/8/9 updated to roll back and re-apply `0006`; I-DB-4 passes; I-DB-10 (new): `down` then `up` leaves `intent_spend` rows intact and `cost_usd` NULL.

### T3. Spend cost

Move pricing (D9). In the generation loop, accumulate `costUsd` per call with `cost(res.usage, res.model)`; a call with an unknown model makes the run's cost `null` (unpriced). `saveCard`'s ledger insert writes `cost_usd`. **AC:** U-GEN-30 (Haiku first pass + Sonnet writer + verifier → exact sum), U-GEN-31 (unknown model → `null`), I-INT-24 (ledger row has the cost); `pnpm eval:ci` unchanged.

### T4. Reviewer eligibility sync

- Signal `feedback_recorded` (installation, repository, owner, repo, prNumber, changeId, headSha = card head) emitted by `intent.feedback.record` after `recorded` and by `intent.feedback.poll` when it wrote ≥ 1 row. `onChangeSignal` in policy returns for this kind.
- Module `pilot`: handler on `pull_request.review_requested`, `pull_request.closed` and `pull_request_review.submitted` (validate, enqueue); listener on `feedback_recorded`. Both enqueue `pilot.reviewers.sync {installationId, repositoryId, owner, repo, prNumber}` with key `rev-sync:{repositoryId}:{prNumber}:{floor(now/3_600_000)}` for the listener and `rev-sync:{repositoryId}:{prNumber}:{deliveryId}` for webhooks.
- Job: active installation check; `getChangeByNumber`; `pulls.listRequestedReviewers` (users only) → `requested`; `pulls.listReviews` (≤ 3 pages) → `reviewed` for every non-null user; insert `ON CONFLICT DO NOTHING` with `first_seen_at = now`. Never deletes (union over time). 404 → permanent, ignored.
- `syncReviewers(ctx, …)` is exported for the CLI backfill (`pnpm graft pilot sync-reviewers`, T9).

**AC:** I-REV-1..5.

### T5. Incidents

- Handler `pull_request.labeled` (label name equals `GRAFT_INCIDENT_LABEL`, case-insensitive) and `pull_request.closed` (merged): enqueue `pilot.incident.detect` keyed `inc:{repoId}:{pr}:{updated_at}`. Off when the label is `off`.
- Job: `pulls.get`; return unless the live PR has the label. Parse the body in memory: lines `^Reverts ([\w.-]+)/([\w.-]+)#(\d+)\s*$` with owner/repo equal (case-insensitive) to this repository, and `^Graft-Culprit:\s*#(\d+)\s*$`; at most 5 distinct numbers, excluding the PR itself. For each, insert `{culprit, fix = this PR, source 'label', occurred_at = PR created_at}` `ON CONFLICT DO NOTHING`; with none, insert one row with `culprit_pr_number NULL`. Log counts only.
- CLI (T9): `incident add --repo o/r --pr N [--fix-pr M] [--occurred-at ISO] [--severity 1-4]`, `incident list --installation <id> [--json]`, `incident remove --id <uuid>`. `add` warns (stderr) when N is in neither `changes` nor any `review_time_prs` row; a label row with NULL culprit for the same fix PR is updated in place.

**AC:** U-INC-1/2, I-INC-1..4.

### T6. Daily rollup

`pilot.metrics.rollup` scheduled by the worker from `GRAFT_METRICS_ROLLUP_CRON` (as the feedback cron; `off` unschedules). Data `{}` (strict). For each repository of an active installation: compute §8.4 for each day in `[today − 7, today)` with SQL, upsert, then delete rows with `day < today − 730`. `rollupRange(ctx, {installationId, from, to})` is exported for `pnpm graft metrics rollup`. Uses `ctx.clock`. **AC:** I-ROLL-1..4, U-ROLL-1.

### T7. Gate report

`src/pilot/gate.ts` gathers inputs (DB only), `decideGate` decides, `gate-render.ts` writes markdown (§11) and JSON (zod `gateReportSchema`, `schemaVersion: 1`). `effectiveVotes` lives in intent's store. Allow-list file: one login per line, `#` comments, validated as `loginList`; the report records only its count and SHA-256. **AC:** U-GATE-1..12, I-GATE-1..6.

### T8. Baseline extraction

`src/pilot/baseline.ts`: resolve the repository row by full name (case-insensitive, not removed) → installation token → `installRateLimit` (`minRemaining 100`, `--max-wait` default 15 min, `--max-requests` default 5,000, injected `now`/`sleep`). List, fetch, compute with `reviewTimes` and `computeProvenance` (config agent logins and co-author emails), aggregate, then write one run + its rows in one transaction (nothing written on abort). `--dry-run` prints the aggregates and writes nothing. Output: a summary table of the aggregates; never titles or logins. Exit 3 on `RateLimitAbort`. **AC:** U-BASE-1..14, I-BASE-1..5.

### T9. CLI (`graft-ops.ts`)

Every command loads `.env` + `loadConfig` (ConfigError → exit 2, message only), opens the DB, checks pending migrations (exit 2 `run pnpm db:migrate`), and closes the DB. Commands needing GitHub build the client factory from config. `sync-reviewers` and `metrics rollup` run the job functions inline with a CLI `JobContext` (`noSignals`, a queue that throws if used). Exit codes: 0 ok, 1 check failed (doctor FAIL; `gate report --check` FAIL), 2 usage/config, 3 aborted (rate-limit wait, max requests, purge confirmation mismatch), 4 `gate report --check` INSUFFICIENT_DATA. All terminal output passes through `toTerminalSafe` (from `src/eval/terminal.ts`).

### T10. Doctor

Checks (each `OK | WARN | FAIL` + one line; `--json` gives `{checks: [{id, status, detail}]}`):

| id | FAIL | WARN |
| --- | --- | --- |
| `installation` | missing, deleted or suspended | `repository_selection = 'all'` |
| `repositories` | 0 active | — (lists names and count) |
| `deliveries` | none in 7 days | none in 72 h |
| `jobs_failed` | > 10 failed in 24 h | ≥ 1 (counts by job name) |
| `cards` | PRs opened in 7 days but 0 cards | unavailable share > 20% (7 days), by reason |
| `feedback` | — | 0 votes in 7 days while cards were shown; votes without a reviewer sync |
| `policy` | — | latest verdict per repo `policy_invalid` or `no_policy` |
| `budget` | today's tokens ≥ budget for a repo | ≥ 80% |
| `rollup` | — | no `metrics_daily` row for yesterday |
| `crons` | — | feedback or rollup schedule missing in pg-boss |

Failed jobs: rows of `${pgbossSchema}.job` with `state = 'failed'` and `data->>'installationId' = $1` (verify the v12 table and column names in `node_modules` and record them in README §7). **AC:** I-DOC-1..3.

### T11. Purge

`purgeInstallation(db, {installationId, schema, now, dryRun})`: one transaction; counts rows per table first (dry run returns them), then deletes `webhook_deliveries` (by `installation_id` or `repository_id` in the installation's repositories), pg-boss jobs where `data->>'installationId' = $1 OR data->'payload'->'installation'->>'id' = $1` (every pg-boss table that holds job rows), then the `installations` row; inserts `pilot_purges`. CLI: `--confirm` must equal `account_login` (case-insensitive) else exit 3; active installation without `--even-if-active` → exit 3. **AC:** I-PURGE-1..4.

### T12. Fake GitHub API

Add: `GET /issues/{n}/timeline` (paged, from `state.timelines`), `GET /pulls/{n}/requested_reviewers`, `pulls.get` with `additions`, `deletions`, `draft`, `labels`, `body` settable per PR, and `state=all` listing with `created_at` ordering. Rate-limit headers already exist.

### T13. Step 3 review 2 nits 4 and 7

- Nit 4: fix `markPublished`'s doc comment (the time is taken right **after** the comment write since step 4) and add the line: "`shown_at` is our clock a few hundred ms after GitHub accepted the write; GitHub's `created_at` on reactions can be skewed against it by up to clock skew, which is negligible for attribution."
- Nit 7: `sweepFeedback` windows on `max(intent_displays.shown_at)` (any status) instead of `max(intent_cards.published_at)`. **AC:** I-FB-11.

### T14. Environment globs validated (step 5 review 7 minor 1)

`globList` for `GRAFT_INTENT_SENSITIVE_PATHS` runs `validateGlob` on each glob; a failure is `GRAFT_INTENT_SENSITIVE_PATHS: glob <index> is invalid (<GLOB_REASONS[detail]>)` and never echoes the value; the process exits at startup (ConfigError). `bootstrap` logs one warning per glob with non-ASCII characters (`{index, codePoints}`). README §7 and HUMAN-TODO note it. **AC:** U-CFG-30..32.

### T15. Glob lookalikes and the exact-text shortcut

1. **Mixed scripts (D14), `glob_invalid` detail 9** — "mixes writing systems in one segment (lookalike letters?)". Per `/`-segment, the script set of its letters (`\p{L}`), ignoring `Common` and `Inherited` (digits, punctuation, `*?[]`, combining marks), using `\p{Script=…}` for Latin, Greek, Cyrillic, Armenian, Hebrew, Arabic, Han, Hiragana, Katakana, Hangul, Bopomofo, Thai, Devanagari, Georgian; any other letter is its own script `Other:<script>` (detect with `\p{Script=X}` for the remaining scripts the engine names, or treat as one unknown bucket that never combines). Allowed: a single script, or a subset of `{Latin, Han, Hiragana, Katakana}`, `{Latin, Han, Bopomofo}` or `{Latin, Han, Hangul}`. Everything else returns 9. Runs after detail 2 and before the cost checks. `GLOB_REASONS[9]` added; JSON Schema unaffected (description only).
2. **Warning `glob_non_ascii`.** `ParseResult` ok variant gains `warnings: PolicyWarning[]` (`{code: "glob_non_ascii", location, line, column, codePoints: string[] /* "U+0435", at most 5 */}`) for every glob in `rules[*].match.paths|only_paths` and `sensitive_paths` with a code point > 0x7F. Never the glob text. The policy hash is unchanged. `graft policy check`: human output prints `file:line:col: warning glob_non_ascii <location>: non-ASCII characters U+0435` after errors; `--json` adds `warnings`; the exit code ignores warnings. The `graft/policy` check-run `output.text` gains a "Warnings" list (same text, through `escapeProse`), not the comment section; `LoadedPolicy` carries the warnings through the cache.
3. **Exact-text shortcut (step 5 review 7 nit 2).** Model picomatch 4.0.7's `input === pattern` fast path in `src/core/glob.ts`: read `lib/picomatch.js` `test()` in `node_modules`, replicate exactly which strings are compared (normalized glob text, case handling), charge one unit per compared character, and record the reading in README §7. U-PG-7's generator adds paths equal to the glob text.

**AC:** U-PG-21..25, U-PY-11/12, U-CLI-8, I-POL-22.

### T16. Docs

README: §1 (step 6 line), §5 (module `pilot`, `src/pilot`, the `feedback_recorded` signal, purge), new "Pilots and gate" section with the CLI table, §6 (no permission change; timeline and requested reviewers use existing reads), §7 "Step 6 deviations and additions". HUMAN-TODO (§14). `docs/plan/development-plan.md`: nothing.

## 10. CLI usage

```sh
pnpm graft pilot doctor --installation 123 [--json]
pnpm graft pilot sync-reviewers --installation 123 --since 2026-11-01
pnpm graft pilot purge --installation 123 --confirm acme [--dry-run] [--even-if-active]
pnpm graft baseline --repo acme/api --from 2026-08-01 --to 2026-10-31 [--period baseline|shadow] [--base main]
                    [--max-requests 5000] [--max-wait 15m] [--dry-run]
pnpm graft gate report --installation 123 --installation 456 --since 2026-11-01 [--until 2026-11-29]
                       [--allow-file ~/pilots/allow.txt] [--out ~/pilots/reports] [--json] [--check]
pnpm graft metrics rollup --installation 123 --from 2026-11-01 --to 2026-11-29
pnpm graft incident add --repo acme/api --pr 812 [--fix-pr 830] [--occurred-at 2026-11-12T09:00:00Z] [--severity 2]
pnpm graft incident list --installation 123 [--json]
pnpm graft incident remove --id <uuid>
```

`--out` writes `gate-<until>.md` and `gate-<until>.json` (mode 0600); without it markdown goes to stdout (`--json` prints JSON instead). Dates are `YYYY-MM-DD` (UTC midnight); `--to`/`--until` are exclusive.

## 11. Report markdown sketch

```md
# Graft Phase 0 gate — 2026-11-01 to 2026-11-29

**Verdict: INSUFFICIENT DATA** — below_min_votes (128 of 150), pilot_below_min (inst 456: 31 of 40)

Installations: 123 (acme, 2 repos), 456 (globex, 1 repo). Data through 2026-11-28. Allow-list: 3 logins (sha256 1a2b…).

## Card accuracy (eligible reviewer votes)
| Scope | 👍 | 👎 | n | Accuracy | Wilson 95% | PRs | Voters |
| All | 118 | 10 | 128 | 92.2% | 86.2–95.7% | 61 | 9 |
| 123 | 90 | 7 | 97 | 92.8% | … | … | … |
Dropped votes: author 14, bot/agent 0, not a reviewer 22. Card-level accuracy: 88.5% (52 of 59 cards).
Coverage: cards 99.1% (≥ 98%), provenance 100% (≥ 98%).
Warnings: none.

## Policy (merged PRs) | Would approve 34% (target ≥ 30%) | require 58% | block 2% | no policy 6% | …
## Cards | verifier disagrees 7.9% | unavailable 2.1% (budget_exceeded 3, llm_timeout 1) | cost/PR $0.042 (unpriced runs 0)
## Review time (indicative: shadow mode, Graft blocks nothing)
| Group | First approval p50 baseline → shadow | Δ | Merge p50 baseline → shadow | Δ |
| agent | 312 → 240 min | −23% (Phase 1 target ≤ −50%) | … |
## Escaped defects | 1 incident per 100 merged PRs (baseline 0.8) | on would-approve PRs: 0
```

## 12. Test plan

Offline: fake GitHub API, fake LLM, real Postgres and pg-boss for `I-`. Test names carry the IDs.

**Unit**

| ID | Asserts |
| --- | --- |
| U-GATE-1 | `wilson(0,0)` is null; `wilson(9,10)` and `wilson(118,128)` equal pinned values to 1e-9; `wilson(n,n).upper` = 1 |
| U-GATE-2 | Eligibility: author vote dropped (`author`); `[bot]` and `GRAFT_AGENT_LOGINS` dropped (`bot_or_agent`); a non-reviewer dropped (`not_reviewer`); requested-only, reviewed-only and allow-listed (case-insensitive) kept |
| U-GATE-3 | Per-user dedupe: reaction 👍 at t1 then button 👎 at t2 → one 👎; same user on two card versions → two votes |
| U-GATE-4 | Votes on `unavailable` cards are not counted |
| U-GATE-5 | N_min: 149 votes → INSUFFICIENT_DATA `below_min_votes`; 150 with 49 PRs → `below_min_prs`; 5 voters → `below_min_voters`; one installation → `fewer_than_two_pilots`; window 13 days → `window_too_short` |
| U-GATE-6 | 40 of 50 up (upper < 0.90) → FAIL `upper_below_target` even though N_min fails |
| U-GATE-7 | 150 votes, p̂ 0.94 → PASS; p̂ 0.90 at n 150 (lower < 0.85) → INSUFFICIENT_DATA `inconclusive` |
| U-GATE-8 | n 400, p̂ 0.905 → PASS `point_estimate_decides`; p̂ 0.895 → FAIL |
| U-GATE-9 | Coverage 0.97 with good accuracy → FAIL `coverage_cards`; provenance 0.97 → FAIL `coverage_provenance` |
| U-GATE-10 | `dominant_voter` warning at 41%, not at 40% |
| U-GATE-11 | Markdown rendering byte-for-byte for a fixed input; the JSON parses with `gateReportSchema`; neither contains any voter login (sentinel logins) |
| U-GATE-12 | Allow-file parsing: comments and blanks skipped; an invalid login → usage error naming the line number only |
| U-BASE-1 | No request, not draft: S = created_at, approval and merge minutes exact |
| U-BASE-2 | Opened as draft, `ready_for_review` at +2 h, request at +3 h: S = request; request made while draft takes effect at `ready_for_review` |
| U-BASE-3 | `convert_to_draft` / `ready_for_review` after S: paused minutes subtracted from both durations |
| U-BASE-4 | Re-request after changes requested does not move S |
| U-BASE-5 | Request for a team counts; request for the author or a bot does not |
| U-BASE-6 | Self-approval (author login, other case) ignored and counted; bot and agent-login approvals ignored and counted |
| U-BASE-7 | Merged without any review → `mergedWithoutReview`, approval null, merge minutes set |
| U-BASE-8 | Rounds = distinct commit ids of qualifying reviews in [S, A]; reviews after A ignored; null commit counts as a round |
| U-BASE-9 | Approval before S → 0 minutes; request after merge ignored |
| U-BASE-10 | Closed then reopened then merged: closed interval subtracted |
| U-BASE-11 | Open at `now`: censored, approval null when none, `open` counted |
| U-BASE-12 | `percentile` type 7 on [1..10] (p50 5.5, p90 9.1); `summarize([])` → n 0 and nulls |
| U-BASE-13 | Aggregates group by author kind × size; excluded rows are in no group; `n<5` cells rendered as `n<5` |
| U-BASE-14 | `sizeBucket` boundaries 50/51, 300/301, 1500/1501 equal step 4's `sizeStratum` |
| U-ROLL-1 | `metricsCountsSchema` rejects an unknown key and a negative count |
| U-INC-1 | Body parsing: `Reverts acme/api#812` (same repo) → 812; other repo → none; `Graft-Culprit: #9` → 9; self number dropped; 7 links → first 5 |
| U-INC-2 | Label config `off` → handler enqueues nothing; label match is case-insensitive |
| U-DOC-1 | The three starter files parse with no errors and no warnings |
| U-DOC-2 | Every relative link in `docs/pilots/onboarding.md` exists; every command of §10 appears |
| U-HOOK-1 | In a temp git repo with the hook and `GRAFT_AGENT=claude-code GRAFT_TASK=#4` set, `git commit -m x` yields both trailers once; amending does not duplicate them |
| U-HOOK-2 | Without `GRAFT_AGENT` the message is unchanged; a merge commit is unchanged |
| U-GEN-30/31 | T3 |
| U-PG-21 | `validateGlob("sеcrets/**")` (Cyrillic U+0435) → 9; `"**/pаyments/**"` (U+0430) → 9; Greek `ο` in `infο/**` → 9 |
| U-PG-22 | Allowed: `docs/руководство/**` (all Cyrillic), `ドキュメント/設定/**` (Katakana + Han), `src/한글v2/**` (Hangul + Latin), `café/**` (Latin with combining or precomposed accent), `src/日本語_ja/*.md` |
| U-PG-23 | Mixing is per segment: `руководство/docs/**` is valid |
| U-PG-24 | The exact-text shortcut: a path equal to an anchored class glob's text (`/[0-9]` vs `[0-9]`) matches like picomatch; the cost is charged |
| U-PG-25 | U-PG-7's differential still has zero unexpected mismatches with text-equal paths added |
| U-PY-11 | A policy with `paths: ["docs/руководство/**"]` → ok with one `glob_non_ascii` warning, `codePoints` capped at 5, no glob text in the warning; hash equals the same policy parsed before this step |
| U-PY-12 | `sensitive_paths: ["sеcrets/**"]` → `glob_invalid` detail 9 at `sensitive_paths[0]` with line and column |
| U-CLI-8 | `graft policy check` on the warning file: exit 0, prints the warning line; `--json` has `warnings`; on the Cyrillic-`е` file exit 1 with detail 9's text |
| U-CFG-30 | `GRAFT_INTENT_SENSITIVE_PATHS="a/**,/**.pem"` → ConfigError naming glob 2 and the reason, not the value |
| U-CFG-31 | `GRAFT_INTENT_SENSITIVE_PATHS="sеcrets/**"` → ConfigError (detail 9) |
| U-CFG-32 | New env defaults and rules (§7): label `off`, bad label chars, cron `off` |
| U-CLI-6 | Unchanged and passing (the static closure of `graft.ts` is still clean) |

**Integration**

| ID | Asserts |
| --- | --- |
| I-REV-1 | `pull_request.review_requested` → one sync job; it stores `requested` for the requested user |
| I-REV-2 | A review then the sync → `reviewed`; a second sync adds nothing and deletes nothing after the request is removed |
| I-REV-3 | A button vote emits `feedback_recorded` → one sync job per change per hour; policy enqueues **no** `policy.evaluate` for it |
| I-REV-4 | A reaction poll that writes rows emits the signal; a poll writing nothing does not |
| I-REV-5 | Suspended installation → no GitHub call; 404 on the PR → permanent, no rows |
| I-GATE-1 | Seeded two installations (cards, displays, feedback, reviewers, provenance, verdicts, rollups): the report numbers equal hand-computed values; PASS |
| I-GATE-2 | Same seed with the reviewer rows removed → every vote `not_reviewer`, INSUFFICIENT_DATA; with an allow-file of all voters → PASS again |
| I-GATE-3 | A third installation's votes do not leak into a report for the first two |
| I-GATE-4 | Shadow vs baseline runs: latest run per period is used; Δ% exact; section labelled indicative |
| I-GATE-5 | Escaped defects: incidents on merged PRs in window and on baseline PRs give the two rates; would-approve split correct |
| I-GATE-6 | `--out` writes both files with mode 0600; `--check` exit codes 0/1/4 |
| I-BASE-1 | Fake API with 30 PRs over 3 list pages (page size 10): only PRs in `[from, to)` on the base branch are stored; per-PR numbers equal U-BASE expectations |
| I-BASE-2 | Rate limit: `remaining` hits the floor → one wait of `reset − now` on the injected clock; a wait above `--max-wait` → exit 3 and **no** run row |
| I-BASE-3 | Author kind from trailers (agent) and from a human PR; an excluded author is stored with `excluded_reason` and no times |
| I-BASE-4 | Stored rows and aggregates contain no title, body, login or SHA (sentinel strings searched in every column of both tables) |
| I-BASE-5 | `--dry-run` writes nothing; `--period shadow` stores `shadow` |
| I-ROLL-1 | Seeded day: every §8.4 counter equals a hand count, including verdict at merge head (latest `facts_read_at`) and excluded authors left out |
| I-ROLL-2 | Re-running the rollup is idempotent; a late incident within 7 days updates the day |
| I-ROLL-3 | Rows older than 730 days are deleted; rows of removed repositories are not recomputed |
| I-ROLL-4 | The worker schedules the rollup cron; `off` unschedules it |
| I-INC-1 | Labeled revert PR whose body says `Reverts <repo>#7` → one incident (culprit 7, fix = the PR, source label); replay → still one |
| I-INC-2 | Label without a link → one row with NULL culprit; `incident add --fix-pr` for that PR fills it in place |
| I-INC-3 | The payload's body is ignored: payload says `#7`, live body says `#9` → culprit 9 |
| I-INC-4 | CLI add/list/remove; unknown culprit warns on stderr |
| I-DOC-1 | Healthy seed → all OK, exit 0 |
| I-DOC-2 | Failed pg-boss jobs, no deliveries in 8 days, over-budget repo → the matching FAILs, exit 1; `--json` shape |
| I-DOC-3 | Deleted installation → `installation` FAIL and no other query errors |
| I-PURGE-1 | Seed installations A and B in every table (incl. `webhook_deliveries`, pg-boss jobs with top-level and payload installation ids, all 0006 tables); purge A → zero rows for A everywhere; B unchanged; one `pilot_purges` row with counts |
| I-PURGE-2 | Every table in `TABLE_NAMES` except `pilot_purges` is covered by the purge's verification map; adding a fake table name to the list fails the check (the test enumerates `TABLE_NAMES`) |
| I-PURGE-3 | Active installation without `--even-if-active` → exit 3, nothing deleted; wrong `--confirm` → exit 3 |
| I-PURGE-4 | `--dry-run` prints counts and deletes nothing |
| I-FB-11 | A card first shown 40 days ago and shown again yesterday (A→B→A) is polled by the sweep |
| I-INT-24 | T3 |
| I-POL-22 | A base `graft.yaml` with a non-ASCII glob → the check-run `output.text` has the Warnings list; the managed comment section is unchanged |
| I-DB-10 | T2 |

## 13. Mutation checks

| Mutation | Caught by |
| --- | --- |
| Eligibility filter removed (all votes count) | U-GATE-2, I-GATE-2 |
| PR-author exclusion removed | U-GATE-2 |
| Votes on `unavailable` cards counted | U-GATE-4 |
| Wilson replaced by the normal approximation | U-GATE-1, U-GATE-7 |
| N_min check removed | U-GATE-5 |
| Coverage conditions ignored | U-GATE-9 |
| Paused (draft) time not subtracted | U-BASE-3 |
| Re-request moves S | U-BASE-4 |
| Self-approval counted | U-BASE-6 |
| Requests during draft take effect immediately | U-BASE-2 |
| Rounds count reviews instead of commit ids | U-BASE-8 |
| Run written before the abort check (partial run on abort) | I-BASE-2 |
| Purge skips pg-boss jobs | I-PURGE-1 |
| Purge skips `webhook_deliveries` | I-PURGE-1 |
| `onChangeSignal` no longer ignores `feedback_recorded` | I-REV-3 |
| Incident culprit taken from the payload body | I-INC-3 |
| Rollup verdict uses the first instead of the latest `facts_read_at` | I-ROLL-1 |
| Sweep window back on `intent_cards.published_at` | I-FB-11 |
| Detail 9 check removed | U-PG-21, U-PY-12, U-CFG-31 |
| Env globs not passed to `validateGlob` | U-CFG-30 |
| Warnings change the CLI exit code | U-CLI-8 |

## 14. HUMAN-TODO additions (append as "## Step 6: Pilots and gate")

- [ ] **Recruit two pilot teams** (20-500 engineers, agents open most PRs, GitHub, willing to vote on cards for 4+ weeks). Who: product owner. Produces: names, contacts, signed agreement (consent for diffs to Anthropic, retention terms, optional eval export) → `docs/plan/development-plan.md` decision "Where the pilot teams come from".
- [ ] **Onboarding session per pilot** (60 min) following `docs/pilots/onboarding.md`: install on selected repos, pick a starter `graft.yaml`, install the trailer hook in each agent harness, explain shadow mode and voting, collect the allow-list (reviewers who review without being requested). Who: repo owner with the pilot's tech lead. Produces: installation id, allow-file (stored outside git), `pilot doctor` all OK.
- [ ] **Baseline**: right after install, `pnpm graft baseline --repo <r> --from <today − 12 weeks> --to <install date>` per pilot repo (at least 4 weeks of history; 2-4 weeks only if history is short). Ask each pilot to list incidents in that period and record them with `pnpm graft incident add`. Who: repo owner.
- [ ] **Backfill eligibility** once after deploying step 6: `pnpm graft pilot sync-reviewers --installation <id> --since <install date>`.
- [ ] **Weekly gate review** (30 min, same day each week): `pnpm graft pilot doctor` per pilot; `pnpm graft baseline --period shadow --from <pilot start> --to <today>` per repo; `pnpm graft gate report --installation A --installation B --since <pilot start> --allow-file … --out ~/graft-reports`; read verdict, 👎 cards (open them on GitHub), unavailable reasons, cost; adjust prompts through `pnpm eval run` before shipping any change. Who: repo owner + product owner. Produces: the report files and a short note per week.
- [ ] **Calling the gate.** Call it at the first weekly review where the report says PASS or FAIL, and no earlier than 2 weeks of pilot data; if still INSUFFICIENT DATA after 6 weeks, decide with the pilots whether to extend 2 weeks or record a FAIL for lack of engagement. PASS → start Phase 1. FAIL → prompt work against the eval set, then a fresh 2-week window (`--since` reset). Record the verdict, window, n, interval and report hash in `docs/plan/development-plan.md`. Who: product owner.
- [ ] **Compare the eval proxy**: for PRs in both the pilot eval set and the gate window, compare `cardAcceptableRate` with the thumbs by hand and note the gap. Who: repo owner.
- [ ] **Incident label**: agree the label name with each pilot (`GRAFT_INCIDENT_LABEL`) and ask them to put `Reverts owner/repo#N` (the GitHub revert button does) or `Graft-Culprit: #N` in fix PRs. Who: product owner.
- [ ] **Check `GRAFT_INTENT_SENSITIVE_PATHS`** still loads after deploy (startup now rejects globs the matcher does not model and mixed-script segments). Who: repo owner.
- [ ] **Offboarding**: when a pilot leaves, follow the onboarding doc's deletion procedure and record the `pilot_purges` id. Who: repo owner.

## 15. Definition of done

From a clean clone with Docker running, and no network beyond install and the image pull:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm lint
pnpm typecheck
pnpm test                                   # every ID in §12 present and passing; earlier IDs still passing
pnpm build
pnpm eval:ci                                # exit 0, baseline unchanged
pnpm graft policy schema --check            # exit 0
pnpm graft policy check docs/examples/graft.yaml                       # exit 0
for f in docs/pilots/graft.*.yaml; do pnpm graft policy check "$f" || exit 1; done
pnpm graft policy check test/fixtures/policy/alias-bomb.yaml; test $? -eq 1
pnpm db:migrate && pnpm db:status           # 0001..0006 applied
pnpm db:rollback && pnpm db:status && pnpm db:migrate   # only 0006 rolled back, then re-applied
grep -rnE "@ts-(ignore|expect-error)" src/ && exit 1 || true
grep -rn "modules/" src/db/ src/policy/ && exit 1 || true
grep -nE "from \"\.\./(db|config|modules|pilot)" src/bin/graft.ts && exit 1 || true
grep -rn "U-GATE-\|U-BASE-\|I-GATE-\|I-BASE-\|I-PURGE-\|I-REV-\|I-ROLL-\|I-INC-\|U-PG-2[1-5]" test/ | wc -l   # non-zero
```

**Manual smoke** (record in the PR description): with `dev:server` and `dev:worker` running, send `installation.created` then `pull_request.opened`; `pnpm graft pilot doctor --installation <fixture id>` prints the checks (GitHub-dependent ones WARN offline); `pnpm graft metrics rollup` for the fixture installation writes a row; `pnpm graft pilot purge --installation <id> --confirm <login> --dry-run` lists counts.

**Also required:** no column, job payload, log line, report or error message holds PR text, code, globs or voter logins (I-BASE-4, U-GATE-11 and code reading); README and HUMAN-TODO updated per T16; `github/app-manifest.json` unchanged (U-MAN-1 unchanged).
