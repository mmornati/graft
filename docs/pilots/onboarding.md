# Onboarding a pilot team

This is the runbook for the 60-minute onboarding session of one pilot team (see [HUMAN-TODO, step 6](../phase-0/HUMAN-TODO.md)). In Phase 0 Graft runs in **shadow mode**: it reports and measures, and it blocks and approves nothing.

## 1. Prerequisites

- A GitHub **org admin** to install the App, a **repo admin** for each pilot repository, and the pilot's **security owner** in the session.
- The **pilot agreement** is signed: it covers consent for diffs, PR text and linked issue text to be sent to Anthropic for card generation, the retention terms for that data (section 4), and, if the team agrees, the optional export of a sample of merged PRs to the encrypted evaluation store (see the [labeling guide](../phase-0/labeling-guide.md)).
- A **Graft deployment** is running (server and worker, migrated to the latest schema) with `ANTHROPIC_API_KEY` set and `GRAFT_LLM_DAILY_TOKEN_BUDGET` chosen. Without a key the service still runs and every card shows as unavailable.

## 2. What Graft reads

Through the GitHub API, with the permissions in the [README](../../README.md), section 6:

- pull request metadata, the list of changed files **and their patches** (read in memory, never stored);
- the commits and their messages (in memory; only the parsed `Graft-*` trailers are stored);
- the linked issue's text (in memory);
- reviews and requested reviewers, and the reactions on Graft's own comment;
- the issue timeline of past pull requests (the baseline only; numbers are stored, no text);
- `graft.yaml` from the **base branch** (only the hash of the parsed policy is stored).

## 3. What Graft stores

**No source code, diffs or patches are stored.** Rows hold ids, numbers, SHAs, file paths, counts, and the model's own prose. Logins of people are stored in exactly three places: `changes.author_login`, `intent_feedback.user_login` and `policy_verdicts.approvals` (at most 10 per verdict). The account that installed the App is stored too: `installations.account_login` (a user login for a personal-account install) and the owner part of `repositories.full_name`.

| Group | Tables | Content |
| --- | --- | --- |
| Installation | `installations`, `repositories` | ids, the account name, repository names, flags |
| Pull requests | `tasks`, `changes` | ids, PR numbers, SHAs, base branch, state, timestamps, the author login |
| Provenance | `provenance`, `change_provenance` | parsed `Graft-*` values (agent, model, task id, session URL), commit SHAs, counts, warning codes |
| Intent cards | `intent_cards`, `intent_displays`, `intent_spend` | model prose (goal, behavior changes, reasons), file paths, risk class, token counts, cost per model run |
| Feedback | `intent_feedback`, `pr_reviewers` | votes with the voter's id and login; reviewer ids (no logins) |
| Policy | `policy_verdicts`, `guard_events` | rule indices, reason codes, paths (at most 5 per reason), approver logins (at most 10), hashes. `guard_events` is not used in Phase 0 |
| Pilot metrics | `review_time_runs`, `review_time_prs`, `incidents`, `metrics_daily`, `pilot_purges` | numbers, flags and counters only: no titles, bodies, paths, logins or SHAs |
| Webhooks | `webhook_deliveries` | delivery id, event, action, installation and repository ids, status |

Webhook payloads, which include PR titles and bodies, sit in the job queue (pg-boss) only briefly: a `github.webhook` job is deleted **1 hour after it completes or finally fails**. A job that cannot run, for example because the worker is down, stays queued with its payload until pg-boss deletes it (14 days, but only while a worker is running: pg-boss maintenance runs in the worker, so with the worker down nothing is deleted). Other jobs keep ids, numbers and, for button votes, the voter's login for 7 days after they finish. Logs carry metadata only (ids, counts, codes), never PR text, voter logins or model output.

## 4. Data sent to Anthropic

For card generation only, Graft sends the diff, the PR title and description and the linked issue text to the Anthropic API. How long Anthropic keeps that data depends on the organisation's terms (standard retention or zero data retention, decided in HUMAN-TODO step 3). The retention terms must be named in the pilot agreement.

## 5. Install on selected repositories only

On the GitHub install screen choose **Only select repositories** and pick the pilot repositories. Add or remove a repository later under *Settings, Installed GitHub Apps, Configure*. A repository added later is picked up from the `installation_repositories` event; a removed one is marked `removed_at` and ignored. An installation with `repository_selection = 'all'` is a WARN in `pnpm graft pilot doctor`.

## 6. Starter `graft.yaml` per archetype

Pick one, copy it to `graft.yaml` on the default branch through a normal reviewed pull request, adjust paths and team slugs, and check it with `pnpm graft policy check graft.yaml`. The reference is [graft.yaml reference](../graft-yaml.md).

| Archetype | File | What it says |
| --- | --- | --- |
| Product service | [graft.service.yaml](graft.service.yaml) | trivial docs auto-approved; auth, billing and migrations need 1 human plus security; an agent on a sensitive change needs 2 |
| Platform and infrastructure | [graft.platform.yaml](graft.platform.yaml) | every infrastructure path needs the platform team; agent edits to `secrets/**` are blocked |
| Library | [graft.library.yaml](graft.library.yaml) | the public API surface `src/public/**` needs 2 humans; docs and tests rated trivial are auto-approved |

Each file starts with the `yaml-language-server` schema line and carries comments. In Phase 0 these rules only report what Graft *would* do.

## 7. Provenance trailers

Graft tells agent-written pull requests from human ones by `Graft-*` git trailers in the commits (see the README, "Provenance trailers for agents").

**Claude Code.** Add this block to the repository's `CLAUDE.md`, and optionally install the hook below:

```md
## Graft provenance
Every commit you create must end with these trailers (use `git commit --trailer`):
  Graft-Agent: claude-code
  Graft-Model: <the model id you are running as>
  Graft-Task: <issue reference such as #42, when the task has one>
```

**Other harnesses** (Codex, Cursor, Aider, the Copilot coding agent, custom scripts): install [scripts/pilot/prepare-commit-msg](../../scripts/pilot/prepare-commit-msg) as `.git/hooks/prepare-commit-msg` (or point `core.hooksPath` at a directory that holds it) and export `GRAFT_AGENT`, `GRAFT_MODEL`, `GRAFT_TASK` and `GRAFT_SESSION` in the agent's environment. The hook does nothing when `GRAFT_AGENT` is unset, so humans are unaffected.

**Harnesses that cannot run hooks:** put the same `Graft-*` lines in the last paragraph of the pull request description; Graft reads them as a fallback.

**Agent accounts.** If an agent opens pull requests from its own GitHub account (not a Bot), list the login in `GRAFT_AGENT_LOGINS` so it counts as an agent and its votes and approvals are never counted as reviewer input.

## 8. Shadow mode

- Every Graft check (`graft/provenance`, `graft/intent`, `graft/policy`) concludes **neutral**. Nothing blocks, nothing approves.
- Keep branch protection exactly as it is. Do **not** make a Graft check required.
- Phase 1: this is stage 1 and 2 of the [Phase 1 rollout runbook](phase-1-runbook.md). A repository leaves shadow mode only through that runbook, one stage at a time.
- Reviewers read the intent card instead of the description and rate it: 👍 or 👎 on Graft's comment, or the buttons **Card is accurate** and **Card is wrong** on the `graft/intent` check. Only votes from the following count toward the accuracy gate: **requested reviewers who hold triage or higher permission on the repository** (a request alone proves nothing: the author chooses who is requested), people who submitted an **approving or change-requesting review while being the repository's OWNER, MEMBER or COLLABORATOR and holding triage or higher permission** (on a public repository anyone can submit a review, and GitHub marks outsiders NONE or CONTRIBUTOR), and anyone on the allow-list the team hands over (matched by numeric GitHub user ID). A comment-only review does not make a vote eligible. Rows stored before these checks existed are `verified = false` and ignored until `pilot sync-reviewers` has re-checked them. The author's own votes never count. Eligibility is a union over time: someone requested after voting counts for the earlier vote too. A PASS must also hold without the single busiest voter, so the verdict cannot rest on one person.

## 9. Weekly ritual

Once a week, 30 minutes, the same day: `pnpm graft pilot doctor`, a shadow baseline, `pnpm graft gate report`, then read the verdict and the 👎 cards, and review the incidents recorded from labels with `pnpm graft incident list` (a label incident names its culprit from the fix PR's body, which anyone who can edit that PR can change; remove a wrong one with `pnpm graft incident remove`). The steps are in [HUMAN-TODO, step 6](../phase-0/HUMAN-TODO.md). In Phase 1 the weekly review adds `pnpm graft gate report --phase 1` and the stage checks of the [Phase 1 rollout runbook](phase-1-runbook.md#gate-review-weekly-product-owner-and-operator).

**The allow-list** matches people by their immutable numeric GitHub user ID, never by login (a login freed by a rename can be registered by someone else, who would inherit the votes). One entry per line, `#` starts a comment: `12345` or `alice:12345` (the login is a label for humans and is never matched). Collect logins from the team, then run `pnpm graft pilot allow-list resolve <file> --installation <id>`: it looks every login-only line up on GitHub (public data) and rewrites it as `login:id`, or stops without writing if a login does not exist. Check the resolved IDs against the people you mean, once, and keep the file outside git. A login-only line makes `gate report` stop with the line number (never the content). **A line of digits is always read as an ID**, although GitHub allows all-digit logins: write such a person as `@1234` (resolve turns it into `1234:<id>`) or as `1234:<id>`. Writing a numeric login bare would make the unrelated account with that ID eligible. `resolve` replaces the file atomically.

Commands used by the runbook and the ritual:

```sh
pnpm graft pilot doctor --installation 123
pnpm graft pilot sync-reviewers --installation 123 --since 2026-11-01
pnpm graft pilot sweep-feedback --installation 123   # poll the 👍/👎 reactions now instead of waiting for the 15-minute cron
pnpm graft pilot allow-list resolve ~/pilots/allow.txt --installation 123
pnpm graft baseline --repo acme/api --from 2026-08-01 --to 2026-10-31
pnpm graft baseline --repo acme/api --from 2026-11-01 --to 2026-11-29 --period shadow
pnpm graft gate report --installation 123 --installation 456 --since 2026-11-01 --allow-file ~/pilots/allow.txt --out ~/pilots/reports
pnpm graft metrics rollup --installation 123 --from 2026-11-01 --to 2026-11-29
pnpm graft incident add --repo acme/api --pr 812 --fix-pr 830 --severity 2
pnpm graft incident list --installation 123
pnpm graft incident remove --id <uuid>
pnpm graft pilot purge --installation 123 --confirm acme --dry-run
```

## 10. Offboarding and deletion

1. The org admin **uninstalls the App** on GitHub.
2. Confirm that `installations.deleted_at` is set for the installation.
3. Preview, then delete: `pnpm graft pilot purge --installation <id> --confirm <account login> --dry-run`, then the same command without `--dry-run`. This deletes every row of the installation (the foreign keys cascade from `installations`), its `webhook_deliveries` and the pg-boss jobs that name it, and writes one `pilot_purges` row (installation id, counts, time; no login).
4. Run `pnpm eval purge --set <dir> --confirm <setId>` on **every labeler machine** that holds an evaluation set for the pilot.
5. If the agreement says so, ask Anthropic to delete the data under the organisation's terms.
6. Record the `pilot_purges` id in the pilot agreement.
