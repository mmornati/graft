# Graft, explained (video)

[Docs index](README.md) · [Provenance](features/provenance.md) · [Intent cards](features/intent-cards.md) · [Policy](features/policy.md)

A narrated tour of Graft in two and a half minutes: the review problem, the three roles (the agent, the reviewer, the platform owner), how a pull request flows from the webhook to three check runs and one managed comment, the four answers Graft gives, and what changes in a reviewer's day. Every organisation, person and pull request shown is fictional.

<div class="video-embed" markdown="0">
  <iframe src="../../videos/graft-explained/?embed=1&amp;lang=en" title="Graft, explained: a narrated video" loading="lazy" allow="fullscreen; autoplay" allowfullscreen></iframe>
</div>

<p markdown="0"><a href="../../videos/graft-explained/">Open the video on its own page</a> for chapters and subtitles (press <kbd>c</kbd>).</p>

A second video, [What a reviewer sees](video-reviewer-tour.md), walks through four simulated pull requests as GitHub would show them.

## Chapters

| Chapter | What it covers | Read more |
| --- | --- | --- |
| The problem | Agent pull requests outpace review, and the description comes from the agent being judged. | [README](../README.md#why-graft) |
| Who is involved | The agent writes the code, the reviewer decides what merges, the platform owner sets the rules. GitHub stays as it is. | [MVP spec](spec/mvp-spec.md) |
| How it works | Signed webhook, server, queue, worker, writer and verifier, check runs and the managed comment. | [Architecture](architecture.md) |
| Who wrote it | `Graft-*` trailers, the commit hook, bot accounts and agent co-authors. | [Provenance](features/provenance.md) |
| What it claims | The intent card, and a verifier that sees only the diff, the file list and the card. | [Intent cards](features/intent-cards.md) |
| The risk floor | Fixed rules set `trivial`, `logic` or `sensitive`; a model can only raise the class. | [Intent cards](features/intent-cards.md) |
| The policy | `graft.yaml` from the base branch only: block wins, then require, then approve. | [Policy](features/policy.md) |
| A new way of working | Reviewers read the card before the diff; agents keep working, plus a few trailers. | [Pilot onboarding](pilots/onboarding.md) |
| Privacy and shadow mode | What is never stored, what is stored, what is sent to Anthropic; neutral checks and the 90% gate. | [Pilots and the gate](features/pilots-and-gate.md) |

## About the video

The video is a web page, not a video file: every frame is drawn in JavaScript on a canvas from the elapsed time, over a synthetic voice-over (Kokoro, Apache-2.0 weights). Its sources are in [`website/videos/graft-explained/`](../website/videos/graft-explained/): the narration in `script.json`, the scenes in `scenes.js`. To embed it elsewhere, add `?embed=1` to its URL.
