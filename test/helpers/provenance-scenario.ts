import { commitMessage, fakeSha, HEAD_SHA, makeCommit } from "./github-builders.js";

/** The §8 example: 3 commits, 2 with trailers, a model conflict, the session from the body. */
export const OLD_SHA = `ab12cd3${fakeSha(1).slice(7)}`;
export const MID_SHA = fakeSha(2);

export const SCENARIO_BODY = "Adds the thing.\n\nGraft-Session: https://claude.ai/code/session/abc";

export function scenarioCommits() {
  return [
    makeCommit(
      OLD_SHA,
      commitMessage("First", undefined, [
        ["Graft-Agent", "claude-code"],
        ["Graft-Model", "claude-haiku-5-5"],
        ["Graft-Session", "http://insecure.example/s"],
      ]),
    ),
    makeCommit(MID_SHA, commitMessage("Second", "No trailers here.")),
    makeCommit(
      HEAD_SHA,
      commitMessage("Third", undefined, [
        ["Graft-Agent", "claude-code"],
        ["Graft-Model", "claude-sonnet-5-5"],
        ["Graft-Task", "#42"],
      ]),
    ),
  ];
}

export const EXPECTED_SECTION = `### Provenance

| | |
| --- | --- |
| **Authored by** | Agent (Graft trailers) |
| **Agent** | \`claude-code\` |
| **Model** | \`claude-sonnet-5-5\` · commits disagree: \`claude-sonnet-5-5\`, \`claude-haiku-5-5\` |
| **Task** | \`#42\` |
| **Session** | [claude.ai](https://claude.ai/code/session/abc) (from PR description) |
| **Opened by** | \`graft-dev\` |

Head \`ec26c3e\` · 3 commits, 2 with Graft trailers.

<details><summary>1 provenance warning</summary>

- \`ab12cd3\`: Graft-Session ignored (invalid_session_url)

</details>`;

export const EXPECTED_COMMENT = `<!-- graft:managed-comment v1 -->

## Graft

<!-- graft:section:provenance:start -->
${EXPECTED_SECTION}
<!-- graft:section:provenance:end -->

<sub>Maintained by Graft; edits to this comment are overwritten.</sub>`;

/** The scenario commits in the shape `computeProvenance` takes. */
export function scenarioInputs() {
  return scenarioCommits().map((c) => ({ sha: c.sha, message: c.commit.message }));
}
