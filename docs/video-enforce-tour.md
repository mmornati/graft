# Enforce mode, step by step (video)

[Docs index](README.md) · [Graft, explained](video.md) · [What a reviewer sees](video-reviewer-tour.md) · [Modes](features/modes.md) · [Rollout runbook](pilots/phase-1-runbook.md)

A narrated tour of Phase 1 in about two and a half minutes: the three mode keys and the server ceiling, approvals Graft counts in enforce mode, break-glass and the audit log, the post-merge guard and its revert pull requests, the MCP server for agents, and the staged rollout to the Phase 1 gate. Everything starts in report mode, and the video says so.

**The data is fictional.** The `acme` organisation, its people and its pull requests do not exist. The check titles, comment lines and CLI output follow Graft's renderers and the feature docs, but no Graft run produced them.

<div class="video-embed" markdown="0">
  <iframe src="../../videos/enforce-tour/?embed=1&amp;lang=en" title="Enforce mode, step by step: a narrated video" loading="lazy" allow="fullscreen; autoplay" allowfullscreen></iframe>
</div>

<p markdown="0"><a href="../../videos/enforce-tour/">Open the video on its own page</a> for chapters and subtitles (press <kbd>c</kbd>).</p>

## Chapters

| Chapter | What it shows | Read more |
| --- | --- | --- |
| Enforce mode | Phase 1 counts approvals, watches `main` and talks to agents, and still starts in report mode. | [Phase 1 plan](phase-1/README.md) |
| Modes and the ceiling | `policy_mode`, `guard_mode` and `mcp_write`, set only by the operator; `GRAFT_MODE_CEILING` and the lower of the two; the mutation guard refusing a write. | [Modes](features/modes.md) |
| Approvals that count | The would-be line in report mode; in enforce mode, write access, the current head and verified teams; a push makes approvals stale. | [Policy, enforce mode](features/policy.md#enforce-mode) |
| Break-glass | A maintainer's `graft:break-glass` label passes one commit; a triage user's label is ignored; `pnpm graft audit list`. | [Policy](features/policy.md) |
| The post-merge guard | A red check on `main`, confirmed by the next commit, and the guard comment on the culprit. | [Guard](features/guard.md) |
| Revert pull requests | The revert tree from blob SHAs, `needs_human` when a later commit touched the files, opt-in auto-merge never for `sensitive`. | [Guard, revert pull requests](features/guard.md#revert-pull-requests) |
| The MCP server | Four tools, per-repository tokens stored as hashes, provenance that only tightens, `open_change` behind `mcp_write` and signed commits. | [MCP server](features/mcp.md) |
| Rollout and the gate | Runbook stages 0 to 6 and the four Phase 1 gate metrics. | [Runbook](pilots/phase-1-runbook.md), [Pilots and the gates](features/pilots-and-gate.md#the-phase-1-gate) |

## About the video

Like the other two, the video is a web page drawn in JavaScript on a canvas over a synthetic voice-over (Kokoro, Apache-2.0 weights). Its sources are in [`website/videos/enforce-tour/`](../website/videos/enforce-tour/): the narration in `script.json`, the scenes in `scenes.js`. To embed it elsewhere, add `?embed=1` to its URL.
