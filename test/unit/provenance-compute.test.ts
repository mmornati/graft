import { describe, expect, it } from "vitest";
import {
  type CommitInput,
  computeProvenance,
  type ProvenanceInput,
} from "../../src/modules/provenance/compute.js";
import { commitMessage, fakeSha } from "../helpers/github-builders.js";

const commit = (n: number, trailers: [string, string][] = [], subject = `c${n}`): CommitInput => ({
  sha: fakeSha(n),
  message: commitMessage(subject, undefined, trailers),
});

function input(over: Partial<ProvenanceInput> = {}): ProvenanceInput {
  const commits = over.commits ?? [];
  return {
    commits,
    commitsTotal: commits.length,
    truncated: false,
    prBody: null,
    prAuthor: { login: "graft-dev", type: "User" },
    agentLogins: [],
    agentCoauthorEmails: ["noreply@anthropic.com"],
    ...over,
  };
}

describe("computeProvenance", () => {
  it("U-PROV-1 the newest commit wins per field; an older commit fills a field the newest lacks", () => {
    const r = computeProvenance(
      input({
        commits: [
          commit(1, [
            ["Graft-Agent", "old-agent"],
            ["Graft-Model", "old-model"],
            ["Graft-Task", "T-1"],
          ]),
          commit(2, [["Graft-Agent", "new-agent"]]),
        ],
      }),
    );
    expect(r.fields.agent).toEqual({ value: "new-agent", source: "commit", commitSha: fakeSha(2) });
    expect(r.fields.model).toEqual({ value: "old-model", source: "commit", commitSha: fakeSha(1) });
    expect(r.fields.task?.commitSha).toBe(fakeSha(1));
  });

  it("U-PROV-2 the body fills only missing fields; a commit beats a different body value, which is a conflict", () => {
    const r = computeProvenance(
      input({
        commits: [commit(1, [["Graft-Agent", "from-commit"]])],
        prBody: "Text\n\nGraft-Agent: from-body\nGraft-Model: body-model",
      }),
    );
    expect(r.fields.agent).toMatchObject({ value: "from-commit", source: "commit" });
    expect(r.fields.model).toEqual({ value: "body-model", source: "pr_body" });
    expect(r.conflicts.agent).toEqual(["from-commit", "from-body"]);
    expect(r.conflicts.model).toBeUndefined();
    expect(r.prBodyFields).toEqual({ agent: "from-body", model: "body-model" });
  });

  it("U-PROV-3 different agents conflict newest first; a single distinct value has no entry", () => {
    const r = computeProvenance(
      input({
        commits: [
          commit(1, [
            ["Graft-Agent", "a"],
            ["Graft-Model", "m"],
          ]),
          commit(2, [
            ["Graft-Agent", "b"],
            ["Graft-Model", "m"],
          ]),
          commit(3, [["Graft-Agent", "a"]]),
        ],
      }),
    );
    expect(r.conflicts.agent).toEqual(["a", "b"]);
    expect(r.conflicts.model).toBeUndefined();
    expect(r.fields.agent?.value).toBe("a");
  });

  it("U-PROV-4 no trailers and a User author is human/none", () => {
    const r = computeProvenance(input({ commits: [commit(1)] }));
    expect([r.authorKind, r.authorKindReason]).toEqual(["human", "none"]);
    expect(r.prBodyFields).toBeNull();
  });

  it("U-PROV-5 no trailers and a Bot author is agent/bot_account", () => {
    const r = computeProvenance(
      input({ commits: [commit(1)], prAuthor: { login: "dependabot[bot]", type: "Bot" } }),
    );
    expect([r.authorKind, r.authorKindReason]).toEqual(["agent", "bot_account"]);
  });

  it("U-PROV-6 a configured login matches case-insensitively", () => {
    const r = computeProvenance(
      input({
        commits: [commit(1)],
        prAuthor: { login: "Claude-Bot", type: "User" },
        agentLogins: ["claude-bot"],
      }),
    );
    expect([r.authorKind, r.authorKindReason]).toEqual(["agent", "configured_login"]);
  });

  it("U-PROV-7 only an agent Co-authored-by gives agent_coauthor and a correct count", () => {
    const co = ["Co-authored-by", "Claude <noreply@anthropic.com>"] as [string, string];
    const r = computeProvenance(input({ commits: [commit(1, [co]), commit(2), commit(3, [co])] }));
    expect([r.authorKind, r.authorKindReason]).toEqual(["agent", "agent_coauthor"]);
    expect(r.counts.agentCoauthor).toBe(2);
    expect(r.perCommit).toEqual([]);
  });

  it("U-PROV-8 reason precedence: trailer beats a bot author", () => {
    const r = computeProvenance(
      input({
        commits: [commit(1, [["Graft-Agent", "claude-code"]])],
        prAuthor: { login: "x[bot]", type: "Bot" },
        agentLogins: ["x[bot]"],
      }),
    );
    expect(r.authorKindReason).toBe("trailer");
  });

  it("U-PROV-9 perCommit holds only commits with a valid field; withTrailers ignores invalid-only commits", () => {
    const r = computeProvenance(
      input({
        commits: [
          commit(1, [["Graft-Agent", "`bad`"]]),
          commit(2, [["Graft-Model", "m"]]),
          commit(3),
        ],
      }),
    );
    expect(r.perCommit).toEqual([{ sha: fakeSha(2), fields: { model: "m" } }]);
    expect(r.counts.withTrailers).toBe(1);
    expect(r.counts.scanned).toBe(3);
  });

  it("U-PROV-10 warnings carry commitSha and source, in commit order then body, capped at 50", () => {
    const bad = (n: number) => commit(n, [["Graft-Agent", "`x`"]]);
    const r = computeProvenance(
      input({ commits: [bad(1), bad(2)], prBody: "t\n\nGraft-Model: `y`" }),
    );
    expect(r.warnings).toEqual([
      { code: "invalid_value", field: "agent", commitSha: fakeSha(1), source: "commit" },
      { code: "invalid_value", field: "agent", commitSha: fakeSha(2), source: "commit" },
      { code: "invalid_value", field: "model", source: "pr_body" },
    ]);
    const many = computeProvenance(
      input({ commits: Array.from({ length: 80 }, (_, i) => bad(i + 1)) }),
    );
    expect(many.warnings).toHaveLength(50);
  });

  it("U-PROV-11 truncated input shows in counts.scanned versus total", () => {
    const r = computeProvenance(
      input({ commits: [commit(1), commit(2)], commitsTotal: 312, truncated: true }),
    );
    expect(r.counts).toMatchObject({ total: 312, scanned: 2 });
    expect(r.truncated).toBe(true);
  });

  it("U-PROV-12 is pure: same input twice gives deep-equal output and nothing is mutated", () => {
    const i = input({
      commits: [commit(1, [["Graft-Agent", "a"]]), commit(2, [["Graft-Agent", "b"]])],
      prBody: "x\n\nGraft-Model: m",
    });
    const copy = structuredClone(i);
    const a = computeProvenance(i);
    const b = computeProvenance(i);
    expect(a).toEqual(b);
    expect(i).toEqual(copy);
  });
});
