# Provenance

[Docs index](../README.md) · [Intent cards](intent-cards.md) · [Policy](policy.md)

Provenance answers "who wrote this pull request?": an agent (which one, with which model, for which task, in which session) or a human. Graft shows the answer in the `provenance` section of its managed PR comment and in a `graft/provenance` check run (always `neutral` in Phase 0). The policy engine uses it as the `author` and `agent` facts.

## Provenance trailers for agents

Graft works out who wrote a PR from `Graft-*` git trailers in its commits, with the PR description as a fallback. Agents add them with `git commit --trailer`:

```sh
git commit -m "Fix the retry loop" \
  --trailer "Graft-Agent: claude-code" \
  --trailer "Graft-Model: claude-sonnet-5-5" \
  --trailer "Graft-Task: #42" \
  --trailer "Graft-Session: https://claude.ai/code/session/abc"
```

| Key | Value rule |
| --- | --- |
| `Graft-Agent` | `[A-Za-z0-9][A-Za-z0-9 ._:/@+()-]{0,99}` |
| `Graft-Model` | `[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}` |
| `Graft-Task` | `[A-Za-z0-9#][A-Za-z0-9._:/#@+-]{0,127}`; `#42` links issue 42 of the repo |
| `Graft-Session` | an `https` URL, at most 2,048 characters, no credentials, a plain LDH hostname (letters, digits, hyphen, dots; at least two labels; no IP, no `localhost`); `( ) [ ] \| \ `` ` `` `*` are percent-encoded |

Keys are case-insensitive. The trailers must be in the last paragraph of the message (git `interpret-trailers` rules, simplified; the subject alone never counts). A value that fails its rule is ignored and listed as a warning (the warning never repeats the value). **Precedence:** per field, the newest commit with a valid value wins, then older commits, then the PR description (same trailer syntax, last paragraph). If values disagree, the newest wins and all distinct values are shown. **Agent or human:** a PR is agent-authored if any of these holds, in this order: a resolved `Graft-Agent`; the PR author is a GitHub Bot account; the author login is in `GRAFT_AGENT_LOGINS`; a commit has a `Co-authored-by` with an email in `GRAFT_AGENT_COAUTHOR_EMAILS` (default `noreply@anthropic.com`, Claude Code's). Otherwise it is human. Graft stores parsed `Graft-*` values only; commit messages and e-mail addresses are read in memory and never stored.

## Adding trailers automatically

`scripts/pilot/prepare-commit-msg` is a git hook that adds the `Graft-*` trailers from the environment variables `GRAFT_AGENT` (required; the hook does nothing when it is unset or empty), `GRAFT_MODEL`, `GRAFT_TASK` and `GRAFT_SESSION` (optional), so any agent harness that can set environment variables gets provenance and humans are unaffected. Install it by copying it to `.git/hooks/prepare-commit-msg` (`chmod +x`) or by pointing `core.hooksPath` at a directory that holds it. It skips merge and squash messages and uses `git interpret-trailers --if-exists doNothing`, so an amend, a rebase or a second run never duplicates a trailer. Alternatively, instruct the harness to add the trailers itself (for Claude Code, in the project's `CLAUDE.md`); [docs/pilots/onboarding.md](../pilots/onboarding.md) has a snippet for pilot teams.

## What reviewers see

A fictional example of the section, as rendered by `renderProvenanceSection` (`src/modules/provenance/render.ts`):

```markdown
### Provenance

| | |
| --- | --- |
| **Authored by** | Agent (Graft trailers) |
| **Agent** | `claude-code` |
| **Model** | `claude-sonnet-5-5` |
| **Task** | `#128` |
| **Session** | [agents.example.com](https://agents.example.com/session/7f3a) |
| **Opened by** | `acme-agent[bot]` |

Head `4c9e1f2` · 2 commits, 2 with Graft trailers.
```

When commits disagree the row lists every distinct value (for example "commits disagree: `claude-sonnet-5-5`, `claude-haiku-5-5`"), a value taken from the PR description says so, invalid trailers are listed in a collapsed "provenance warnings" block (at most 10, then "…and K more"), and a PR without trailers gets the line "no `Graft-*` trailers found" with a hint on how to add them. Only the first 250 commits and the head commit are scanned; the footer says when a PR has more.

## Related

- Configuration: `GRAFT_AGENT_LOGINS`, `GRAFT_AGENT_COAUTHOR_EMAILS`, `GITHUB_APP_SLUG` in [configuration.md](../configuration.md).
- Implementation choices and deviations: [decisions.md, step 2](../decisions.md#step-2-provenance).
- The step spec: [docs/phase-0/step-2-provenance.md](../phase-0/step-2-provenance.md).
