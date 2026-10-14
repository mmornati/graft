import { describe, expect, it } from "vitest";
import { extractGraftFields } from "../../src/modules/provenance/fields.js";
import { parseTrailerBlock } from "../../src/modules/provenance/trailers.js";

const emails = ["noreply@anthropic.com"];

/** Parse a commit message (or PR body) the way the job does. */
function read(text: string, hasTitle = true) {
  const block = parseTrailerBlock(text, { hasTitle });
  return { block, ...extractGraftFields(block.trailers, { agentCoauthorEmails: emails }) };
}
const nl = (...lines: string[]) => lines.join("\n");

describe("trailer parser (§6.4 examples)", () => {
  it("U-TRL-1 a trailer block after the subject yields the fields", () => {
    const r = read(nl("Fix bug", "", "Graft-Agent: claude-code", "Graft-Model: claude-sonnet-5-5"));
    expect(r.fields).toEqual({ agent: "claude-code", model: "claude-sonnet-5-5" });
  });

  it("U-TRL-2 a single paragraph is only a subject: nothing", () => {
    const r = read("Graft-Agent: claude-code");
    expect(r.block.trailers).toEqual([]);
    expect(r.fields).toEqual({});
  });

  it("U-TRL-3 keys are case-insensitive", () => {
    expect(read(nl("Fix", "", "graft-agent: x", "GRAFT-MODEL: y")).fields).toEqual({
      agent: "x",
      model: "y",
    });
  });

  it("U-TRL-4 spaces before the colon are allowed", () => {
    expect(read(nl("Fix", "", "Graft-Agent : claude-code")).fields).toEqual({
      agent: "claude-code",
    });
  });

  it("U-TRL-5 continuation lines are unfolded", () => {
    const r = read(nl("Fix", "", "Graft-Task: ABC-1", "Graft-Agent: claude", "  code"));
    expect(r.fields).toEqual({ task: "ABC-1", agent: "claude code" });
  });

  it("U-TRL-6 a prose last paragraph means no trailers", () => {
    expect(read(nl("Fix", "", "Graft-Agent: a", "", "Some prose after")).fields).toEqual({});
  });

  it("U-TRL-7 a mixed block with >=25% trailer lines and a known key is accepted; prose is skipped", () => {
    const r = read(
      nl("Fix", "", "Body text", "Graft-Agent: a", "Signed-off-by: X <x@y>", "more", "text"),
    );
    expect(r.fields).toEqual({ agent: "a" });
    expect(r.block.trailers.map((t) => t.key)).toEqual(["Graft-Agent", "Signed-off-by"]);
  });

  it("U-TRL-8 a mixed block under 25% without a known key is rejected", () => {
    const r = read(nl("Fix", "", "note: one", "prose", "prose", "prose", "prose"));
    expect(r.block.trailers).toEqual([]);
  });

  it("U-TRL-9 a Graft trailer plus an agent Co-authored-by", () => {
    const r = read(
      nl("Fix", "", "Graft-Agent: a", "Co-authored-by: Claude <noreply@anthropic.com>"),
    );
    expect(r.fields).toEqual({ agent: "a" });
    expect(r.agentCoauthor).toBe(true);
  });

  it("U-TRL-10 only a Co-Authored-By (any case): no fields, agentCoauthor", () => {
    const r = read(nl("Fix", "", "Co-Authored-By: Claude <NoReply@Anthropic.com>"));
    expect(r.fields).toEqual({});
    expect(r.agentCoauthor).toBe(true);
    expect(JSON.stringify(r)).not.toContain("anthropic");
  });

  it("U-TRL-11 CRLF line endings", () => {
    expect(read("Fix\r\n\r\nGraft-Agent: a\r\n").fields).toEqual({ agent: "a" });
  });

  it("U-TRL-12 a message over 16,384 characters is cut from the front and flagged", () => {
    const r = read(`${"x".repeat(20_000)}\n\nGraft-Agent: a`);
    expect(r.fields).toEqual({ agent: "a" });
    expect(r.block.truncated).toBe(true);
  });

  it("U-TRL-13 a PR body (hasTitle: false) with one paragraph is parsed", () => {
    expect(read("Graft-Agent: a", false).fields).toEqual({ agent: "a" });
  });

  it("U-TRL-14 a candidate block of 101 lines is ignored and flagged (P7)", () => {
    const lines = Array.from({ length: 101 }, (_, i) => `Graft-Agent: a${i}`);
    const r = parseTrailerBlock(nl("Fix", "", ...lines), { hasTitle: true });
    expect(r.trailers).toEqual([]);
    expect(r.blockTooLong).toBe(true);
    const ok = parseTrailerBlock(nl("Fix", "", ...lines.slice(0, 100)), { hasTitle: true });
    expect(ok.trailers).toHaveLength(100);
  });

  it("U-TRL-15 whitespace-only lines separate paragraphs", () => {
    expect(read(nl("Fix", "  \t", "Graft-Agent: a")).fields).toEqual({ agent: "a" });
  });

  it("U-TRL-16 a continuation may start with a tab", () => {
    expect(read(nl("Fix", "", "Graft-Task: T-1", "Graft-Agent: claude", "\tcode")).fields).toEqual({
      task: "T-1",
      agent: "claude code",
    });
  });

  it("U-TRL-17 empty and blank input give no trailers", () => {
    expect(parseTrailerBlock("", { hasTitle: true }).trailers).toEqual([]);
    expect(parseTrailerBlock("\n \n\t\n", { hasTitle: false }).trailers).toEqual([]);
  });

  it("U-TRL-18 a non-trailer line inside an accepted block is skipped, order and case are kept", () => {
    const r = parseTrailerBlock(
      nl("Fix", "", "Reviewed-by: Z", "oops no colon", "graft-Model: m"),
      {
        hasTitle: true,
      },
    );
    expect(r.trailers).toEqual([
      { key: "Reviewed-by", value: "Z" },
      { key: "graft-Model", value: "m" },
    ]);
  });
});
