# graft.yaml reference (version 1)

`graft.yaml` tells Graft how a repository wants its pull requests reviewed. **In Phase 0 Graft only reports.** For every open pull request it evaluates the file and shows what it *would* do (auto-approve, require reviewers, block) in a `graft/policy` check run and in the `policy` section of the Graft comment. The check always concludes `neutral`: it approves nothing, blocks nothing, and is not a replacement for required reviewers. Keep your branch protection as it is, and do not make `graft/policy` a required check.

Teams are **not checked** until Phase 1. Phase 0 shows which teams a rule would require, and counts approvals from anyone.

## Where the file lives, and whom Graft trusts

- The file is `graft.yaml` at the repository root, on the **base branch** of the pull request. Graft reads it at the commit the base branch points to when it evaluates, never from the pull request's own branch.
- A pull request that changes `graft.yaml` (or `graft.yml`, or anything under `.graft/`) is flagged. Its version of the file is ignored, its risk is at least `sensitive`, and it can never be would-approved: at least one human is needed.
- A missing file gives the verdict "No policy". A file that cannot be used (too large, not a regular file, invalid) gives "Policy invalid: no decision". Neither is ever would-approved.
- Only the hash of the parsed policy is stored. Graft keeps no file contents, rule names, globs or team names.

## Example

The valid example is [docs/examples/graft.yaml](examples/graft.yaml):

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/mmornati/graft/main/schema/graft.v1.schema.json
version: 1

# Extra paths that set the intent risk floor to `sensitive` (step 3 rule R7).
sensitive_paths:
  - services/billing/**
  - "**/payments/**"

# Used when no rule matches. Must be a `require`. Defaults to 1 human.
default:
  require: { humans: 1 }

rules:
  - name: docs-only
    match: { risk: trivial, only_paths: ["docs/**", "*.md"] }
    approve: auto

  - name: trivial
    match: { risk: trivial }
    approve: auto

  - name: infra-and-auth
    match: { paths: ["infra/**", "**/auth/**"] }
    require: { humans: 1, team: security }

  - name: agent-sensitive
    match: { author: agent, risk: sensitive }
    require: { humans: 2 }

  - name: no-agent-secrets
    match: { paths: ["secrets/**"], author: agent }
    block: true

  - name: big-change
    match: { size: { min_lines: 1000 } }
    require: { humans: 2 }

  - name: preview-agent
    match: { agent: [codex-preview] }
    require: { humans: 1, team: [platform, security] }

  - name: hotfix
    match: { labels: [hotfix] }
    require: { humans: 1, team: oncall }
```

## Keys

| Key | Type | Rule |
| --- | --- | --- |
| `version` | `1` | Required. Any other value: `version_unsupported`. |
| `sensitive_paths` | list of globs | Optional, at most 50. A change to one of these paths has risk `sensitive` at least. Case-insensitive. |
| `default` | `{ require: {...} }` | Optional. Only `require` is allowed (`default_invalid`). Default `{ humans: 1 }`. |
| `rules` | list of rules | Optional (default `[]`), at most 200. |
| rule `name` | string | Optional, `^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,79}$`. Unique within the file. |
| rule `match` | mapping | Required and non-empty. Keys are combined with **AND**. |
| rule action | one of `approve: auto`, `require: {...}`, `block: true` | Exactly one. |
| `match.risk` | class or list | `trivial`, `logic` or `sensitive`; a list is any-of. |
| `match.paths` | list of globs | **Any-of**: true when at least one changed file (new or previous name) matches one glob. 1 to 50 entries. Case-insensitive. Not allowed with `approve`. |
| `match.only_paths` | list of globs | **All-of**: true when the file list is complete, there is at least one file, and every file's path **and** previous path match some glob. **Case-sensitive.** 1 to 50 entries. |
| `match.author` | `agent` or `human` | Who wrote the pull request, from provenance. Not allowed with `approve`. |
| `match.agent` | name or list | Case-insensitive exact match on the `Graft-Agent` trailer. Implies `author: agent`. At most 20. Not allowed with `approve`. |
| `match.labels` | list | Any-of, case-insensitive exact, 1 to 50 characters each, at most 20. Not allowed with `approve`. |
| `match.size` | mapping | `min_lines`, `max_lines`, `min_files`, `max_files`: integers from 0 to 1,000,000, at least one, with min not above max. Inclusive bounds on additions plus deletions and on changed files. |
| `require.humans` | integer | 1 to 10. Default 1. |
| `require.team` | slug or list | `^[a-z0-9][a-z0-9_-]{0,99}$`: a team slug in the repository owner's organisation, without `@` or `org/`. A list is any-of. At most 10. `require: {}` is invalid. |
| `approve` | `auto` | Anything else: `approve_invalid`. |
| `block` | `true` | Anything else, `false` included: `block_invalid`. |

| `guard` | mapping | Optional (Phase 1 step 4). Only `checks` and `auto_merge_reverts` are allowed (`unknown_key`). The policy engine ignores it. |
| `guard.checks` | list of strings | Optional, 1 to 50 exact check names or status contexts, 1 to 200 characters each, no control characters, case-sensitive. When present, only these checks can open a [post-merge guard](features/guard.md) event. It is read from the last green commit before the candidates, never from the commit that went red. An empty list, a long name or a control character: `wrong_type`; more than 50: `too_many_items`. |
| `guard.auto_merge_reverts` | list | Optional (Phase 1 step 5), 1 or 2 of `trivial` and `logic` (a repeated item counts once). When the culprit's intent card has one of these risk classes, Graft enables GitHub auto-merge on its [revert pull request](features/guard.md#revert-pull-requests), so branch protection and required checks still decide. Read from the last green commit before the culprit, never from the culprit's own commit. `sensitive`: `auto_merge_sensitive` ("Reverts of sensitive changes are never auto-merged; remove sensitive."); another item: `risk_invalid`; an empty list or a scalar: `wrong_type`; three items: `too_many_items`. |

Unknown keys at any level are errors (`unknown_key`).

`approve: auto` may use only `risk`, `only_paths` and `size`. `author`, `agent` and `labels` are controlled by whoever writes the pull request (trailers can be forged, and anyone with triage access can add labels), and `paths` is any-of, so they can only tighten: use them in `require` and `block` rules.

### Globs

A glob is 1 to 200 characters of letters, combining marks, digits (Unicode) and ``_ . - / * ? [ ] @ + = ~ # % ,`` and space. No `!` (negation), `{` `}` (braces), `(` `)` `|` `\` `^` `$`. No `..` segment and no empty segment (only a single leading `/`). At most 4 `**` segments, at most 3 `*` in a segment, balanced `[...]` with no `/` inside, no run of three or more `*`, no `]+`, no `**` glued to other characters (use `**/x` or `x/**`), and it must compile. To bound the work of one match, a segment has at most 48 characters other than `*` and the whole glob at most 96 (`**` segments and `*` do not count); a longer glob is `glob_invalid` ("too costly").

- **Lookalike letters.** The letters of one `/`-separated segment must come from one writing system, or from a set that is normal together: Latin with Han, Hiragana and Katakana (Japanese), Latin with Han and Bopomofo (Chinese), Latin with Han and Hangul (Korean). `secrets/**` written with a Cyrillic `е` (U+0435) instead of the Latin `e` reads right and never matches, which would silently loosen a rule that is meant to tighten, so a segment that mixes writing systems is `glob_invalid` ("mixes writing systems in one segment"). All-Cyrillic or all-Japanese paths are fine, and mixing is judged per segment (`руководство/docs/**` is valid). Digits, punctuation and combining marks belong to no script. Invisible characters, a combining mark that does not follow a letter, and compatibility characters (fullwidth or mathematical letters, the Kelvin sign, CJK compatibility ideographs, halfwidth katakana, superscripts) are rejected too, the last with the message "contains a compatibility character".
- **Non-ASCII warning.** A valid file with a non-ASCII character in a glob (`paths`, `only_paths`, `sensitive_paths`) is accepted with a `glob_non_ascii` warning that lists the code points (`U+0435`, at most 5), never the glob. `pnpm graft policy check` prints it after the errors (`file:line:col: warning glob_non_ascii ...`, and `warnings` in `--json`) and the exit code ignores it; the `graft/policy` check run lists it under "Warnings". The policy hash does not change.
- A glob without `/` matches at any depth: `*.md` matches `docs/a.md`.
- A leading `/` anchors it at the repository root: `/graft.yaml`.
- Dot files match.
- At most 500 globs in the file.
- Matching never backtracks, so a hostile path cannot stall Graft. A changed path longer than 1,024 characters or with more than 128 segments is not matched at all: it counts as matching every `sensitive_paths` and every `paths` glob of a `require` or `block` rule, and as matching no `only_paths` rule. The output says `path_too_long`; it is not reported as a change to `graft.yaml`, but it is treated like an incomplete file list (an approve rule is overridden by the 1-human built-in). All globs of one evaluation share a fixed work budget (60 million work units per job, sized from the legal maximum of 500 globs x 1,000 files x 2 paths and from path depth, with a margin of at least 1.5 on the worst ordinary case), counted in work units so that it is the same on every machine: when it is spent, the remaining `paths` rules count as matching (unknown), approve rules do not match, and the output says `budget_exhausted`. Ordinary policies never come near the budget.

## How a verdict is decided

1. Every rule is evaluated, in file order. A rule matches when all keys in its `match` hold.
2. **Block wins.** If any matching rule is `block`, the verdict is `would_block`.
3. Otherwise, **any matching `require` wins over `approve`.** The verdict is `would_require`. Each matching `require` rule is a constraint "at least *n* approvals from members of these teams" (no team means anyone). All constraints must hold, and one approval can satisfy several. Constraints with the same team set merge by the largest *n*. The headline count is the largest *n*.
4. Otherwise, if a rule that approves matches, the verdict is `would_approve`, unless the pull request changes `graft.yaml`, or the file list is incomplete so that it may: then at least 1 human is needed.
5. When nothing matches, `default` applies.

Rule order does not matter. Adding a rule can only add constraints or approve more narrowly described changes.

**An unknown fact never loosens.** If the intent card for the head is not ready, the risk is not known: it is at least `logic`, and a `require` or `block` rule that depends on it counts as matching (marked "unknown" in the output), while an `approve` rule matches only if it would hold for every possible value. The same holds for an author whose provenance is not computed yet, an agent whose name was not reported, and an incomplete file list.

**Effective risk.** The risk comes from the intent card for the current head. If a changed path matches `sensitive_paths`, or the pull request touches the policy file, the risk is raised to `sensitive`.

### Worked examples (the example policy above)

| Change | Result |
| --- | --- |
| E1: `docs/a.md`, card `trivial`, written by a human | Would auto-approve (rules 1 and 2). |
| E3: `infra/main.tf`, card `sensitive`, by an agent | Would require 2 humans, one of them from `security` (rules 3 and 4). |
| E4: `secrets/prod.env`, card `sensitive`, by an agent | Would block: rule 5 (rule 4 is overridden). |
| E5: `src/x.ts`, card not ready, by an agent | Would require 2 humans: rule 4 applies as "unknown"; rule 2 does not match because the risk could be higher. |
| E7: the pull request edits `graft.yaml` | Would require 1 human: the policy on the base branch applies, and an edit to the policy is never auto-approved. |
| E9: `src/x.ts`, card `trivial`, by a human, label `hotfix` | Would require 1 human from `oncall`: rule 8 beats the approving rule 2. |

## Limits and errors

| Limit | Value |
| --- | --- |
| File size | 32,768 bytes |
| Flow nesting (`[`, `{`) | 16 |
| Rules | 200 |
| Globs, whole file | 500 |
| Errors reported | 50 |
| Anchors, aliases and tags | none allowed |

The file must be one YAML 1.2 document in valid UTF-8, and a regular file (not a symlink, directory or submodule). Anchors and aliases (`&`, `*`) and tags (`!`) are rejected outright; they are never resolved.

| Code | Meaning |
| --- | --- |
| `file_too_large`, `file_not_regular`, `file_not_utf8` | The file as a file. |
| `yaml_syntax`, `yaml_alias`, `yaml_tag`, `yaml_duplicate_key`, `yaml_multiple_documents`, `yaml_too_deep` | YAML-level errors. |
| `not_a_mapping`, `version_missing`, `version_unsupported`, `unknown_key`, `wrong_type` | Structure. |
| `too_many_rules`, `too_many_globs`, `too_many_items`, `too_many_errors` | Limits. |
| `match_missing`, `action_missing`, `action_conflict`, `approve_invalid`, `block_invalid`, `require_empty`, `default_invalid` | Rules and actions. |
| `humans_invalid`, `team_invalid`, `risk_invalid`, `author_invalid`, `agent_invalid`, `label_invalid`, `size_invalid`, `name_invalid`, `name_duplicate`, `glob_invalid` | Values. |
| `approve_untrusted_key`, `approve_any_path` | `approve: auto` using a key it may not use. |
| `auto_merge_sensitive` | `guard.auto_merge_reverts` lists `sensitive` (Phase 1 step 5). |

Messages never repeat text from your file, except the name of an unknown key.

## Check the file locally and in CI

```sh
pnpm graft policy check graft.yaml          # exit 0 valid, 1 invalid, 2 usage or unreadable file
pnpm graft policy check graft.yaml --json   # {"ok": false, "errors": [...]}
pnpm graft policy schema --check            # is schema/graft.v1.schema.json up to date
```

For editor completion and validation, start the file with the `yaml-language-server` comment shown in the example, pointing at `schema/graft.v1.schema.json`. The JSON Schema cannot express every rule (for example the `approve` restrictions); `pnpm graft policy check` can.

Lint the file in your own CI with this workflow. It uses `pull_request`, never `pull_request_target`, and the file is only parsed, never executed.

```yaml
# .github/workflows/graft-yaml.yml
name: graft.yaml
on:
  pull_request:
    paths: ["graft.yaml"]
permissions:
  contents: read
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4                 # pin to a commit SHA per your org policy
      - uses: actions/checkout@v4
        with:
          repository: mmornati/graft
          ref: <pinned commit SHA>
          path: .graft-tool
          token: ${{ secrets.GRAFT_TOOL_TOKEN }}  # only while the Graft repo is private
      - uses: pnpm/action-setup@v4
        with: { package_json_file: .graft-tool/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm, cache-dependency-path: .graft-tool/pnpm-lock.yaml }
      - run: pnpm install --frozen-lockfile --dir .graft-tool
      - run: pnpm --dir .graft-tool graft policy check "$GITHUB_WORKSPACE/graft.yaml"
```

Placeholders you fill in: `<pinned commit SHA>` is the Graft commit you want to lint with (pin a full SHA, not a branch), and `GRAFT_TOOL_TOKEN` is a repository secret in your repository holding a fine-grained, read-only token for `mmornati/graft`; it is needed only while the Graft repository is private, so drop the `token:` line once it is public.

## What Phase 0 does not do

- It decides nothing: the check is `neutral`, and a would-approve is not an approval.
- It does not check team membership (Phase 1, needs the `members: read` permission).
- It does not dismiss stale approvals, offer a break-glass label, or keep an audit log (Phase 1).
- It reads only `graft.yaml`; `graft.yml` and `.graft/` are flagged as policy files but never read.
