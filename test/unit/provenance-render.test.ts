import { describe, expect, it } from "vitest";
import { computeProvenance, type ProvenanceInput } from "../../src/modules/provenance/compute.js";
import {
  renderCheckRunOutput,
  renderProvenanceSection,
} from "../../src/modules/provenance/render.js";
import { commitMessage, fakeSha, HEAD_SHA } from "../helpers/github-builders.js";
import { EXPECTED_SECTION, SCENARIO_BODY, scenarioInputs } from "../helpers/provenance-scenario.js";

const opts = { headSha: HEAD_SHA, authorLogin: "graft-dev" };

function run(over: Partial<ProvenanceInput> = {}) {
  const commits = over.commits ?? [];
  return computeProvenance({
    commits,
    commitsTotal: commits.length,
    truncated: false,
    prBody: null,
    prAuthor: { login: "graft-dev", type: "User" },
    agentLogins: [],
    agentCoauthorEmails: ["noreply@anthropic.com"],
    ...over,
  });
}
const commit = (n: number, trailers: [string, string][] = []) => ({
  sha: fakeSha(n),
  message: commitMessage(`c${n}`, undefined, trailers),
});

describe("provenance rendering", () => {
  it("U-REN-1 the §8 example renders byte-exact", () => {
    const r = run({ commits: scenarioInputs(), prBody: SCENARIO_BODY });
    expect(renderProvenanceSection(r, opts)).toBe(EXPECTED_SECTION);
  });

  it("U-REN-2 a human PR with no trailers: 'no Graft-* trailers found' line and Human", () => {
    const text = renderProvenanceSection(run({ commits: [commit(1)] }), opts);
    expect(text).toContain("| **Authored by** | Human |");
    expect(text).toContain("| **Agent** | not reported |");
    expect(text).not.toContain("**Session**");
    expect(text).toContain(
      "Head `ec26c3e` · no `Graft-*` trailers found. Agents can declare provenance with `Graft-Agent`, `Graft-Model`, `Graft-Task` and `Graft-Session` git trailers.",
    );
    expect(text).not.toContain("<details>");
  });

  it("U-REN-3 the truncated footer sentence, and singular 'commit'", () => {
    const t = run({
      commits: [commit(1, [["Graft-Agent", "a"]])],
      commitsTotal: 312,
      truncated: true,
    });
    expect(renderProvenanceSection(t, opts)).toContain(
      "Head `ec26c3e` · 312 commits, 1 with Graft trailers. Only the first 250 commits and the head commit were scanned.",
    );
    const one = run({ commits: [commit(1, [["Graft-Agent", "a"]])] });
    expect(renderProvenanceSection(one, opts)).toContain("· 1 commit, 1 with Graft trailers.");
  });

  it("U-REN-4 warnings: singular and plural summaries; more than 10 lists ten and '…and K more'", () => {
    const bad = (n: number) => commit(n, [["Graft-Agent", "`x`"]]);
    const one = renderProvenanceSection(run({ commits: [bad(1)] }), opts);
    expect(one).toContain("<summary>1 provenance warning</summary>");
    expect(one).toContain("- `0000000`: Graft-Agent ignored (invalid_value)");

    const many = renderProvenanceSection(
      run({ commits: Array.from({ length: 13 }, (_, i) => bad(i + 1)) }),
      opts,
    );
    expect(many).toContain("<summary>13 provenance warnings</summary>");
    expect(many.match(/^- `/gm)).toHaveLength(10);
    expect(many).toContain("- …and 3 more");

    const body = renderProvenanceSection(
      run({ commits: [commit(1)], prBody: "t\n\nGraft-Model: `y`" }),
      opts,
    );
    expect(body).toContain("- PR description: Graft-Model ignored (invalid_value)");

    const long = renderProvenanceSection(
      run({ commits: [{ sha: fakeSha(1), message: `${"x".repeat(20_000)}\n\nGraft-Agent: a` }] }),
      opts,
    );
    expect(long).toContain("message truncated before parsing");
  });

  it("U-REN-5 check-run title for agent, human and a 150-character agent", () => {
    const agent = run({
      commits: [
        commit(1, [
          ["Graft-Agent", "claude-code"],
          ["Graft-Model", "m1"],
        ]),
      ],
    });
    expect(renderCheckRunOutput(agent, opts).title).toBe("Agent: claude-code · Model: m1");
    const noModel = run({ commits: [commit(1, [["Graft-Agent", "claude-code"]])] });
    expect(renderCheckRunOutput(noModel, opts).title).toBe("Agent: claude-code · Model: unknown");
    const human = run({ commits: [commit(1)] });
    expect(renderCheckRunOutput(human, opts).title).toBe("Human-authored (no agent provenance)");
    const bot = run({ commits: [commit(1)], prAuthor: { login: "b[bot]", type: "Bot" } });
    expect(renderCheckRunOutput(bot, opts).title).toBe("Agent: unknown · Model: unknown");

    // The agent charset allows at most 100 characters, so build the long title from agent + model.
    const long = run({
      commits: [
        commit(1, [
          ["Graft-Agent", "a".repeat(100)],
          ["Graft-Model", "m".repeat(100)],
        ]),
      ],
    });
    const title = renderCheckRunOutput(long, opts).title;
    expect(title).toHaveLength(100);
    expect(title.endsWith("…")).toBe(true);
    expect(renderCheckRunOutput(agent, opts).summary).toBe(renderProvenanceSection(agent, opts));
  });

  it("U-REN-6 rendering is deterministic and has no dates", () => {
    const r = run({ commits: scenarioInputs(), prBody: SCENARIO_BODY });
    const a = renderProvenanceSection(r, opts);
    expect(renderProvenanceSection(r, opts)).toBe(a);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(renderCheckRunOutput(r, opts)).toEqual(renderCheckRunOutput(r, opts));
  });

  it("U-REN-7 an agent value with '@' renders only inside a code span; '@octo/bot' is rejected; no graft markers", () => {
    // The spec's literal example `@octo/bot` starts with '@', which the agent charset rejects.
    const rejected = run({ commits: [commit(1, [["Graft-Agent", "@octo/bot"]])] });
    expect(rejected.fields.agent).toBeUndefined();
    expect(renderProvenanceSection(rejected, opts)).not.toContain("@octo");

    const r = run({ commits: [commit(1, [["Graft-Agent", "octo@bot/@team"]])] });
    const text = renderProvenanceSection(r, opts);
    expect(text).toContain("`octo@bot/@team`");
    expect(text.replaceAll("`octo@bot/@team`", "")).not.toContain("@");
    expect(text).not.toContain("<!-- graft:");
    expect(renderCheckRunOutput(r, opts).summary).not.toContain("<!-- graft:");
  });

  it("U-REN-8 the session cell is exactly one well-formed link; hostile hosts and hrefs never reach the cell", () => {
    const sessionCell = (value: string) => {
      const r = run({ commits: [commit(1, [["Graft-Session", value]])] });
      const row = renderProvenanceSection(r, opts)
        .split("\n")
        .find((l) => l.startsWith("| **Session**"));
      return { r, row };
    };
    const ok = sessionCell("https://claude.ai/code/s_1");
    expect(ok.row).toBe("| **Session** | [claude.ai](https://claude.ai/code/s_1) |");
    expect(
      ok.row?.match(/^\| \*\*Session\*\* \| \[[a-z0-9.-]+\]\(https:\/\/[^\s`\\*|()[\]]+\) \|$/),
    ).not.toBeNull();

    // The reviewer's exploit never renders: the session is dropped and no Session row appears.
    const evil = sessionCell("https://a`b.com/https://evil.example/@octocat");
    expect(evil.r.fields.session).toBeUndefined();
    expect(evil.row).toBeUndefined();
    expect(renderProvenanceSection(evil.r, opts)).not.toContain("evil.example");

    // A trailing backslash is encoded, so it cannot escape the closing parenthesis.
    const bs = sessionCell("https://x.dev/?a\\");
    expect(bs.row).toBe("| **Session** | [x.dev](https://x.dev/?a%5C) |");
    const tick = sessionCell("https://x.dev/p`q*r");
    expect(tick.row).toBe("| **Session** | [x.dev](https://x.dev/p%60q%2Ar) |");
  });
});
