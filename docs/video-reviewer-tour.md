# What a reviewer sees (video)

[Docs index](README.md) · [Graft, explained](video.md) · [Enforce mode, step by step](video-enforce-tour.md) · [Intent cards](features/intent-cards.md) · [Modes](features/modes.md)

A narrated tour, in about two and a quarter minutes, of a pull request once Graft is installed: the managed comment (intent card, provenance, policy), the three neutral check runs with the **Card is accurate** and **Card is wrong** buttons, and how card ratings are counted. It walks through four pull requests, from an agent typo fix that would be auto-approved to a description that tries to instruct AI reviewers.

**The data is simulated.** The pull requests come from an offline run of the live e2e suite (`e2e-20261021-ugrjhd`) against the fake GitHub world, with canned model answers. The comment and check text is what Graft's real renderers produced for them; no real GitHub or model call was made, and the sandbox repository shown does not exist yet.

<div class="video-embed" markdown="0">
  <iframe src="../../videos/reviewer-tour/?embed=1&amp;lang=en" title="What a reviewer sees: a narrated video" loading="lazy" allow="fullscreen; autoplay" allowfullscreen></iframe>
</div>

<p markdown="0"><a href="../../videos/reviewer-tour/">Open the video on its own page</a> for chapters and subtitles (press <kbd>c</kbd>).</p>

## Chapters

| Chapter | Pull request | What it shows | Read more |
| --- | --- | --- | --- |
| The managed comment | #2, scenario s01 | One comment kept up to date: the intent card, provenance from `Graft-*` trailers, and the policy verdict (`Would auto-approve`, report only). | [Intent cards](features/intent-cards.md), [Provenance](features/provenance.md) |
| Three neutral checks | #2, scenario s01 | `graft/intent`, `graft/provenance` and `graft/policy`, all `neutral`; the rating buttons on `graft/intent`. | [Architecture](architecture.md) |
| The verifier disagrees | #4, scenario s03 | A body that says "no behavior change" over a logic change: the verifier supports 0 of 4 claims and the card carries a warning. | [Intent cards](features/intent-cards.md) |
| Text aimed at AI reviewers | #5, scenario s04 | Instructions in the description are ignored; the card describes the real change and the risk floor is `logic`. | [Intent cards](features/intent-cards.md) |
| How ratings count | #8 (s08) and #2 (s01) | The approving reviewer's button click and 👍 become one counted rating; an outsider's click and the author's own 👍 are dropped. | [Pilots and the gate](features/pilots-and-gate.md) |
| Report mode | #4 | Every check stays `neutral` and nothing blocks a merge; only the operator sets a mode. | [Modes](features/modes.md) |

## About the video

Like [Graft, explained](video.md), the video is a web page drawn in JavaScript on a canvas over a synthetic voice-over (Kokoro, Apache-2.0 weights). Its sources are in [`website/videos/reviewer-tour/`](../website/videos/reviewer-tour/): the narration in `script.json`, the pull request data in `data.js`, the scenes in `scenes.js`. To embed it elsewhere, add `?embed=1` to its URL.
