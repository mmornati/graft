import { describe, expect, it } from "vitest";
import { extractGraftFields, validateSessionUrl } from "../../src/modules/provenance/fields.js";

const emails = ["noreply@anthropic.com"];
const one = (key: string, value: string) =>
  extractGraftFields([{ key, value }], { agentCoauthorEmails: emails });

describe("graft field validation", () => {
  it("U-FLD-1 backticks and HTML are rejected as invalid_value", () => {
    const r = one("Graft-Agent", "`rm -rf` <img>");
    expect(r.fields).toEqual({});
    expect(r.warnings).toEqual([{ code: "invalid_value", field: "agent" }]);
  });

  it("U-FLD-2 a bidi control character (U+202E) is rejected", () => {
    const r = one("Graft-Agent", "claude‮edoc");
    expect(r.fields).toEqual({});
    expect(r.warnings[0]?.code).toBe("invalid_value");
  });

  it("U-FLD-3 an http: session URL is rejected", () => {
    const r = one("Graft-Session", "http://x.dev/s/1");
    expect(r.fields).toEqual({});
    expect(r.warnings).toEqual([{ code: "invalid_session_url", field: "session" }]);
  });

  it("U-FLD-4 a session URL with credentials is rejected", () => {
    expect(one("Graft-Session", "https://u:p@x.dev/s").warnings[0]?.code).toBe(
      "invalid_session_url",
    );
    expect(validateSessionUrl("https://u@x.dev/s")).toBeNull();
  });

  it("U-FLD-5 an IPv4 session host is rejected (including odd spellings)", () => {
    expect(validateSessionUrl("https://10.0.0.1/s")).toBeNull();
    expect(validateSessionUrl("https://2130706433/s")).toBeNull();
    expect(validateSessionUrl("https://0x7f.1/s")).toBeNull();
  });

  it("U-FLD-6 an IPv6 session host is rejected", () => {
    expect(validateSessionUrl("https://[::1]/s")).toBeNull();
  });

  it("U-FLD-7 localhost and *.localhost are rejected", () => {
    expect(validateSessionUrl("https://localhost/s")).toBeNull();
    expect(validateSessionUrl("https://app.localhost/s")).toBeNull();
  });

  it("U-FLD-8 ( ) [ ] | in a session URL are percent-encoded", () => {
    expect(validateSessionUrl("https://claude.ai/code/s(1)")).toBe(
      "https://claude.ai/code/s%281%29",
    );
    expect(validateSessionUrl("https://claude.ai/a[1]?q=a|b")).toBe(
      "https://claude.ai/a%5B1%5D?q=a%7Cb",
    );
    expect(one("Graft-Session", "https://claude.ai/code/s(1)").fields.session).toBe(
      "https://claude.ai/code/s%281%29",
    );
  });

  it("U-FLD-14 a session host must be plain LDH: backtick, asterisk, underscore, tilde and friends are rejected", () => {
    for (const host of [
      "a`b.com",
      "a*b_c`d.com",
      "a*b.com",
      "a_b.com",
      "a~b.com",
      "a!b.com",
      "a$b.com",
      "a'b.com",
      "a{b}.com",
      "a=b.com",
      "a&b.com",
    ]) {
      expect(validateSessionUrl(`https://${host}/s`), host).toBeNull();
    }
    // The reviewer's exploit: a backtick host followed by a smuggled URL and mention.
    const r = one("Graft-Session", "https://a`b.com/https://evil.example/@octocat");
    expect(r.fields).toEqual({});
    expect(r.warnings).toEqual([{ code: "invalid_session_url", field: "session" }]);
    // Single-label, over-long labels and leading/trailing hyphen labels are rejected too.
    expect(validateSessionUrl("https://intranet/s")).toBeNull();
    expect(validateSessionUrl(`https://${"a".repeat(64)}.com/s`)).toBeNull();
    expect(validateSessionUrl("https://-a.com/s")).toBeNull();
    expect(validateSessionUrl("https://a-.com/s")).toBeNull();
    expect(validateSessionUrl("https://claude.ai/s")).toBe("https://claude.ai/s");
    expect(validateSessionUrl("https://sub-1.claude.ai./s")).toBe("https://sub-1.claude.ai./s");
  });

  it("U-FLD-15 backslash, backtick and asterisk in the path, query and fragment are percent-encoded", () => {
    expect(validateSessionUrl("https://x.dev/?a\\")).toBe("https://x.dev/?a%5C");
    expect(validateSessionUrl("https://x.dev/p`q?r`s#t`u")).toBe("https://x.dev/p%60q?r%60s#t%60u");
    expect(validateSessionUrl("https://x.dev/a*b?c*d")).toBe("https://x.dev/a%2Ab?c%2Ad");
    const href = validateSessionUrl("https://x.dev/a\\b?q=`*|(\\)");
    expect(href).not.toMatch(/[\\`*|()]/);
  });

  it("U-FLD-16 localhost with a trailing dot is rejected", () => {
    expect(validateSessionUrl("https://localhost./s")).toBeNull();
    expect(validateSessionUrl("https://app.localhost./s")).toBeNull();
  });

  it("U-FLD-17 only space and tab are whitespace: U+00A0 / U+FEFF in a value are not stripped or normalized", () => {
    expect(one("Graft-Agent", "claude\u00a0code").warnings[0]?.code).toBe("invalid_value");
    expect(one("Graft-Agent", "claude\ufeffcode").warnings[0]?.code).toBe("invalid_value");
    expect(one("Graft-Agent", "claude \t code").fields.agent).toBe("claude code");
  });

  it("U-FLD-9 a 2,049 character value is value_too_long", () => {
    const r = one("Graft-Task", `T${"x".repeat(2048)}`);
    expect(r.fields).toEqual({});
    expect(r.warnings).toEqual([{ code: "value_too_long", field: "task" }]);
  });

  it("U-FLD-10 an empty value is empty_value", () => {
    expect(one("Graft-Agent", "").warnings).toEqual([{ code: "empty_value", field: "agent" }]);
  });

  it("U-FLD-11 the same key twice: last distinct wins with duplicate_key; identical repeats are silent", () => {
    const dup = extractGraftFields(
      [
        { key: "Graft-Agent", value: "a" },
        { key: "Graft-Agent", value: "b" },
      ],
      { agentCoauthorEmails: emails },
    );
    expect(dup.fields.agent).toBe("b");
    expect(dup.warnings).toEqual([{ code: "duplicate_key", field: "agent" }]);
    const same = extractGraftFields(
      [
        { key: "Graft-Agent", value: "a" },
        { key: "graft-agent", value: "a" },
      ],
      { agentCoauthorEmails: emails },
    );
    expect(same.warnings).toEqual([]);
  });

  it("U-FLD-12 unknown graft-* keys warn with the code only", () => {
    expect(one("Graft-Agentx", "a")).toMatchObject({
      fields: {},
      warnings: [{ code: "unknown_graft_key" }],
    });
    expect(one("Graft-Foo", "a").warnings).toEqual([{ code: "unknown_graft_key" }]);
    expect(one("Reviewed-by", "a").warnings).toEqual([]);
  });

  it("U-FLD-13 warnings never contain the rejected value", () => {
    const secrets = ["SECRET`<b>", "http://leak.example/SECRET", "x".repeat(2049)];
    const r = extractGraftFields(
      [
        { key: "Graft-Agent", value: secrets[0] ?? "" },
        { key: "Graft-Session", value: secrets[1] ?? "" },
        { key: "Graft-Model", value: secrets[2] ?? "" },
        { key: "Graft-SECRETKEY", value: "v" },
      ],
      { agentCoauthorEmails: emails },
    );
    const text = JSON.stringify(r.warnings);
    expect(r.warnings).toHaveLength(4);
    for (const s of [...secrets, "SECRETKEY"]) expect(text).not.toContain(s);
  });
});
