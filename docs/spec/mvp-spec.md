# Agent-First Forge — MVP Spec

Copied from the "Agent-First Forge — MVP Spec" Claude Doc (2026-10-14). The doc is the source of truth; keep this copy in sync.

## Context and thesis

Build a git-compatible review and policy layer for agent-written code, shipped as a GitHub App plus an MCP server. Working name: **Graft**. "Scion" is taken twice, by Anthropic's internal system and by Google Cloud's agent orchestrator.

**Why now.** On 2026-10-13 Anthropic described replacing git with Scion, an in-house system. Its merges grew from about 2,500 a day in May to over 30,000 a day in September. Anthropic also says Scion is not a general git replacement, will not be offered externally, and expects other companies to hit the same problems within 6 to 12 months.

**The gap.** Anthropic's lessons fall into two layers:

- **Storage and transport.** A server-side history API, sparse and virtual checkouts, and content-addressed caches. GitHub and GitLab are best placed to adopt these.
- **Workflow.** Reviewing the intent of a change, semantic approval rules, post-merge testing instead of a strict merge queue, and agents that watch one component each. No forge offers this today.

**Thesis.** Leave storage to the forges and own the workflow layer. Graft sits on top of existing GitHub repositories, so a team can adopt it without migrating anything.

Source: https://www.anthropic.com/engineering/redesigning-source-control

## Target users and problems

The first customers are engineering teams of 20 to 500 people on GitHub where agents already open most pull requests. Their pain is review capacity, not storage.

| Persona | Pain today | What Graft gives them |
| --- | --- | --- |
| Tech lead or reviewer | Dozens of agent PRs a day, each read line by line | An intent summary, behavior changes and a risk class for each PR |
| Platform or security owner | No way to say "agents never touch `infra/`" short of CODEOWNERS | Path-level and semantic rules checked on every PR |
| Agent operator (a human running swarms) | Several agents solve the same issue and conflict | Grouped candidate PRs per task, with the best one picked |
| Agent (as a client) | Has to scrape the UI and logs to learn repo state | A typed MCP API for intent, review status, CI results and policy |

Out of scope as customers for now: monorepos at Anthropic's scale, where git storage itself is the bottleneck.

## MVP scope

The MVP ships on GitHub only and stores nothing that git already stores.

**In**

- Intent cards on pull requests: a goal, behavior changes and a risk class, written by an agent and checked against the diff
- Semantic approval policies in a `graft.yaml` file, enforced through a required GitHub check
- Provenance for each PR: which agent, which model, which task, and a link to the session
- Post-merge guard: watch the CI result on `main` after a merge, and open an auto-revert PR when it fails
- An MCP server so agents can read and write all of the above

**Out**

- Any replacement for git storage, transport or hosting
- GitLab and Bitbucket support (planned for phase 3)
- AST-level semantic merge
- Running agents. Graft judges and routes work; tools like Claude Code or Google's Scion run it
- A custom code browser or code search

## Core features

### 1. Intent cards

- Generated on every PR from its description, the linked issue and the diff.
- Fields: **goal** (one sentence), **behavior changes** (a list of observable effects), **risk class** (`trivial`, `logic`, `sensitive`), and **out-of-scope edits** (files the diff touches that the goal does not explain).
- A verifier agent checks the card against the diff. If they disagree, the PR is flagged.
- Shown as a pinned PR comment and stored in a check run, so they work in the normal GitHub UI.

### 2. Semantic approval policies

Rules live in `graft.yaml` at the repository root. For example:

```yaml
rules:
  - match: { risk: trivial }
    approve: auto
  - match: { paths: ["infra/**", "**/auth/**"] }
    require: { humans: 1, team: security }
  - match: { author: agent, risk: sensitive }
    require: { humans: 2 }
  - match: { paths: ["secrets/**"], author: agent }
    block: true
```

Graft reports one required check, `graft/policy`, so branch protection does the actual enforcement.

### 3. Provenance

- Agents report metadata through the MCP server or as git trailers (`Graft-Agent:`, `Graft-Model:`, `Graft-Task:`).
- The PR shows who wrote what, from which task, with a link to the session log when one exists.
- PRs that share a task ID are grouped as candidates. Graft ranks them by tests passed, diff size and policy result. (Grouping and ranking: phase 2.)

### 4. Post-merge guard

- Merges are not serialized behind a strict queue.
- After merge, Graft watches CI on `main`. When it fails, Graft finds the culprit among recent merges, opens a revert PR for it and notifies its author or agent.
- Teams can set reverts to merge automatically for `trivial` and `logic` risk classes.

## Architecture

GitHub keeps the code, pull requests and CI. Graft keeps only review metadata, so removing it leaves every repository intact.

Components inside Graft (a GitHub App and service):

- **Webhook receiver** — turns GitHub events into jobs
- **Intent service** — writer and verifier agents build the card
- **Policy engine** — reads `graft.yaml`, sets the policy check
- **Post-merge guard** — watches main, finds culprits, opens reverts
- **MCP server** — typed API: intents, status, policy
- **Store (Postgres)** — intents, provenance, verdicts. No code

Agents write to GitHub as usual and talk to Graft through MCP. Graft reports back to GitHub only through check runs, PR comments and revert PRs.

### Data model

| Entity | Key fields | Source of truth |
| --- | --- | --- |
| Task | ID, issue link, goal | Graft |
| Change | PR number, task ID, head SHA | GitHub (Graft keeps a reference) |
| Intent card | Goal, behavior changes, risk class, out-of-scope edits, verifier result | Graft |
| Provenance | Agent, model, session link | Git trailers or MCP |
| Policy verdict | Rules matched, approvals required, status | Graft, mirrored as a check run |
| Guard event | Failing SHA, culprit PR, revert PR | Graft |

## Success metrics (relevant to Phase 0)

| Metric | How it is measured | MVP target |
| --- | --- | --- |
| Human review minutes per agent PR | Time from review request to approval | −50% against the pilot baseline |
| Share of PRs merged with no human | `trivial` PRs auto-approved ÷ all PRs | 30% or more |
| Intent card accuracy | Reviewer thumbs-up on the card | 90% or more |
| Post-merge breakages caught | Failures reverted by Graft ÷ all failures on `main` | 80% or more |
| Escaped defects | Incidents traced to auto-approved PRs | No rise against the baseline |
| Pilot retention | Teams still using Graft after 30 days | 3 of 5 |

## Risks relevant to the build

- An intent card is wrong and a bad change is auto-approved → separate verifier agent, conservative default risk class, post-merge guard as backstop.
- Model cost per PR too high at volume → small models for `trivial` diffs, cached cards, repo-level budgets.
- Security review of a GitHub App with write access → least-privilege permissions; write access only where needed.
