# Connecting a real GitHub App

[Docs index](README.md) · [Getting started](getting-started.md) · [Configuration](configuration.md)

The [quickstart](getting-started.md#quickstart-offline) runs with a throwaway key and signed fixtures. To see Graft on real pull requests you register your own GitHub App from the manifest in this repository, point its webhook at your laptop through a tunnel, and install it on a sandbox organisation. Use a sandbox: Phase 0 Graft reports only, but it still writes check runs and a comment on every pull request it sees.

## Which manifest

Two manifests live in `github/`:

- `app-manifest.json`: the full permission set. Register this one for a deployment that may enforce.
- `app-manifest.report.json`: the permission set for a deployment that only ever evaluates Graft (name and description say "report only"). In this version both carry the Phase 0 permissions; from step 2 on, later steps add read permissions to both and `contents: write` to the full manifest only. `test/unit/manifest.test.ts` (U-MAN-2) pins that the report manifest never has a write permission other than `checks` and `pull_requests`, so an evaluating deployment cannot be enforced on by construction.

Registering the report manifest is the safest default. See [Modes](features/modes.md).

## Register the App

1. Pick the manifest (see above) and edit it (name, `url`, `hook_attributes.url`). Create a channel at <https://smee.io/new> and use its URL as the hook URL.
2. Serve `github/register-app.html` (for example `cd github && python3 -m http.server 8080`, then open <http://localhost:8080/register-app.html>), enter the org name and submit. GitHub redirects to `redirect_url` with `?code=...`.
3. Convert the code: `gh api -X POST /app-manifests/<code>/conversions`. The response has the App `id`, `pem` and `webhook_secret`.
4. Put the PEM in a file outside the repo and fill `.env`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`; also set `SMEE_URL`.
5. Run `pnpm tunnel` (smee) next to `pnpm dev:server` and `pnpm dev:worker`, then install the App on a sandbox org.

`gh webhook forward` does **not** work for GitHub App webhooks (it only supports repository and organization webhooks). Use smee, or ngrok / cloudflared pointed at `http://localhost:3000/webhooks/github`.

After registering, record the App's **slug** too. Setting `GITHUB_APP_SLUG` enables the `<slug>[bot]` fallback that recognises Graft's own comment when `performed_via_github_app` is missing from the comments API (decision D13; see [architecture.md](architecture.md#managed-pr-comment)). Install the App on **selected** repositories only; [docs/pilots/onboarding.md](pilots/onboarding.md) explains why and lists what Graft reads and stores.

The human steps (sandbox org, test repositories, smee channel, registration, install checks) are tracked in [docs/phase-0/HUMAN-TODO.md](phase-0/HUMAN-TODO.md).

## Permissions and events

`github/app-manifest.json` is the source of truth; `test/unit/manifest.test.ts` pins it. Changing a permission means updating the test and this table together.

| Permission / event | Level | Phase 0 use |
| --- | --- | --- |
| `metadata` | read | Mandatory for every App; repository listing. |
| `contents` | read | Read `graft.yaml` from the base branch (step 5, now used) and commit data for trailers (step 2); `git.getCommit` for the head commit when a PR has more than 250 commits. |
| `issues` | read | Read the linked issue for the intent writer (now used, step 3). No write: comments go through `pull_requests: write`. |
| `pull_requests` | write | Read PRs, files, diffs, commits and reviews (steps 2, 3, 6); list PR commits (step 2); list PR files and patches (step 3); list comment reactions (step 3). Write is only for creating and updating the pinned card comment, since the issue-comments API accepts `pull_requests: write`. |
| `checks` | write | Create `graft/provenance` (step 2), `graft/intent` with Accurate/Wrong buttons (`requested_action`, step 3) and `graft/policy` check runs (step 5). |
| `pull_request` event | — | Trigger provenance, intent and policy on opened, synchronize, reopened, edited and closed; `labeled` and `unlabeled` re-run the policy (step 5). |
| `pull_request_review` event | — | `submitted` and `dismissed` refresh the approval count in the policy section (step 5). No new permission: reviews are covered by `pull_requests`. |
| `push` event | — | A push to a branch that changes `graft.yaml` (or a forced or 20-commit push) re-evaluates the open PRs of that branch, at most 100 (step 5). No new permission: covered by `contents: read`. |
| `check_run` event | — | `rerequested` re-runs our checks; `requested_action` delivers the card buttons (step 3). |
| `installation`, `installation_repositories` | — | Delivered to every App without a subscription; drive the installations module. |

**Deferred** (not requested in Phase 0):

- `members: read` (team approvals, Phase 1).
- `contents: write` (revert branches and PRs, Phase 1).
- `statuses: read` and `actions: read`, plus the `status`, `workflow_run` and `check_suite` events (post-merge guard, Phase 1).
- `administration`: never.

Comment reactions have no webhook; step 3 polls them every 15 minutes using `pull_requests: read`.

**Step 6 changes no permission or event** (`github/app-manifest.json` is unchanged, U-MAN-1). The reviewer sync's permission check (`GET /repos/{owner}/{repo}/collaborators/{username}/permission`) needs, per GitHub's documentation, only the repository permission `Metadata: read`, which the manifest already has; the OpenAPI types in `node_modules` do not record permissions, so this could not be confirmed offline (HUMAN-TODO verifies it on a real PR). If the App lacked access the check would answer 403 and requested users would silently be ineligible (fail closed); no permission was added. The review-time baseline reads the issue timeline (`issues: read`), reviews and requested reviewers (`pull_requests: read`) and commits (`contents: read`); the incident and reviewer jobs use the already subscribed `pull_request` (`review_requested`, `labeled`, `closed`) and `pull_request_review` events.
