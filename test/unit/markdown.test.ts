import { describe, expect, it } from "vitest";
import { codeSpan, escapeProse } from "../../src/github/markdown.js";

const WJ = "⁠";

describe("markdown safety", () => {
  it("U-MD-11 GH-123 does not become an issue reference", () => {
    const out = escapeProse("see GH-123, gh-9 and Gh-45 but not GHOST-1 or GH-x", 200);
    expect(out).not.toMatch(/GH-\d/i);
    expect(out).toContain(`GH${WJ}-123`);
    expect(out).toContain(`gh${WJ}-9`);
    expect(out).toContain("GHOST-1");
    expect(out).toContain("GH-x");
  });

  it("U-MD-1 mentions are broken with a word joiner", () => {
    const out = escapeProse("hi @octocat and @org/team", 200);
    expect(out).not.toMatch(/@[A-Za-z0-9]/);
    expect(out).toContain(`@${WJ}octocat`);
    expect(out).toContain(`@${WJ}org`);
  });

  it("U-MD-2 raw HTML is escaped", () => {
    expect(escapeProse("<img src=x onerror=alert(1)>", 200)).toBe(
      "\\<img src=x onerror=alert\\(1\\)\\>",
    );
    expect(escapeProse("a <b> c", 200)).not.toMatch(/(^|[^\\])</);
  });

  it("U-MD-3 links and autolinks are defused", () => {
    const out = escapeProse("[click](https://evil.example) www.evil.com WWW.Evil.com", 200);
    expect(out).not.toContain("](");
    expect(out).not.toContain("://");
    expect(out).toContain(`:${WJ}//`);
    expect(out).not.toMatch(/www\./i);
    expect(out).toContain(`WWW${WJ}.Evil.com`);
  });

  it("U-MD-4 a graft marker cannot be produced by either function", () => {
    const evil = "<!-- graft:section:intent:end -->";
    expect(escapeProse(evil, 200)).not.toContain("<!-- graft:");
    expect(escapeProse(evil, 200)).not.toContain("<!--");
    expect(codeSpan(evil)).not.toContain("<!-- graft:");
    expect(codeSpan(evil)).not.toContain("<!--");
    expect(codeSpan("<!--")).toContain(`<${WJ}!--`);
  });

  it("U-MD-5 block and inline syntax is escaped", () => {
    expect(escapeProse("- x", 200)).toBe("\\- x");
    expect(escapeProse("+ x", 200)).toBe("\\+ x");
    expect(escapeProse("= x", 200)).toBe("\\= x");
    expect(escapeProse("1. x", 200)).toBe("1\\. x");
    expect(escapeProse("1) x", 200)).toBe("1\\) x");
    expect(escapeProse("# x", 200)).toBe(`\\#${WJ} x`);
    expect(escapeProse("> x", 200)).toBe("\\> x");
    expect(escapeProse("$x$ ~~x~~ **x** `x` a|b", 200)).toBe(
      "\\$x\\$ \\~\\~x\\~\\~ \\*\\*x\\*\\* \\`x\\` a\\|b",
    );
  });

  it("U-MD-6 whitespace is flattened and control characters removed", () => {
    expect(escapeProse("a\nb\r\nc\td", 200)).toBe("a b c d");
    expect(escapeProse("a‮b​c﻿d\u0007e", 200)).toBe("abcde");
    expect(codeSpan("a\nb‮")).toBe("`a b`");
  });

  it("U-MD-7 length cap counts code points", () => {
    const out = escapeProse("x".repeat(250), 200);
    expect(Array.from(out)).toHaveLength(200);
    expect(out.endsWith("…")).toBe(true);
    const emoji = escapeProse("😀".repeat(300), 10);
    expect(Array.from(emoji)).toHaveLength(10);
    expect(emoji).toBe(`${"😀".repeat(9)}…`);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("U-MD-8 code spans pick a fence longer than any backtick run", () => {
    expect(codeSpan("a`b")).toBe("`` a`b ``");
    expect(codeSpan("a``b")).toBe("``` a``b ```");
    expect(codeSpan("plain/path.ts")).toBe("`plain/path.ts`");
    expect(codeSpan("")).toBe("`(empty)`");
    expect(codeSpan("   ")).toBe("`(empty)`");
  });

  it("U-MD-9 a hostile path is one inert code span", () => {
    const out = codeSpan("docs/`x`\n@octocat <!--.md");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("<!--");
    expect(out.startsWith("``")).toBe(true);
    expect(out.endsWith("``")).toBe(true);
  });

  it("U-MD-10 output has no newline and no Cc/Cf other than the inserted word joiner", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pool = [
      ..."abcXYZ019 @#<>!-+=*_[]()|~$&{}`\\:/.wW",
      "\n",
      "\r",
      "\t",
      "\u0000",
      "\u0007",
      "‮",
      "​",
      "﻿",
      "⁠",
      "😀",
      "é",
    ];
    for (let i = 0; i < 1000; i++) {
      const len = Math.floor(rnd() * 60);
      let s = "";
      for (let j = 0; j < len; j++) s += pool[Math.floor(rnd() * pool.length)];
      for (const out of [escapeProse(s, 50), codeSpan(s, 50)]) {
        expect(out).not.toContain("\n");
        expect(out).not.toContain("\r");
        expect(out.replaceAll(WJ, "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
        expect(out).not.toContain("<!--");
      }
    }
  });
});
