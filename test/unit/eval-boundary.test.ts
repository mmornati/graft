import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../src/", import.meta.url).pathname;
const evalFiles = readdirSync(join(ROOT, "eval"))
  .filter((n) => n.endsWith(".ts"))
  .map((n) => join(ROOT, "eval", n));
const FILES = [...evalFiles, join(ROOT, "bin", "eval.ts")];

const importLines = (text: string): string[] =>
  text
    .split("\n")
    .filter((l) => /^\s*(import|export)\b.*\bfrom\s+"/.test(l) || /^\s*from\s+"/.test(l));

describe("eval boundaries", () => {
  it("U-BND-1 the eval tool imports no db, queue, webhooks, http or config, and other modules only through index.ts", () => {
    expect(FILES.length).toBeGreaterThan(15);
    for (const file of FILES) {
      for (const line of importLines(readFileSync(file, "utf8"))) {
        expect(line, file).not.toMatch(/from "\.\.\/(\.\.\/)?(db|queue|webhooks|http|config)\//);
        const mod = /from "\.\.\/(?:\.\.\/)?modules\/([a-z]+)\/([a-z-]+)\.js"/.exec(line);
        if (mod) expect(mod[2], `${file}: ${line}`).toBe("index");
      }
    }
  });

  it("U-BND-2 no console or logger call in the eval tool mentions case text (except terminal.ts)", () => {
    const forbidden = /\b(title|body|patch|goal|behaviorChanges|reason)\b/;
    const calls = (text: string): string[] => {
      const out: string[] = [];
      const re = /\b(?:console|log)\??\.(?:log|info|warn|error|debug|trace|fatal)\(/g;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const end = text.indexOf(");", m.index);
        out.push(text.slice(m.index, end === -1 ? undefined : end + 2));
      }
      return out;
    };
    for (const file of FILES) {
      if (file.endsWith("terminal.ts")) continue;
      for (const call of calls(readFileSync(file, "utf8")))
        expect(call, file).not.toMatch(forbidden);
    }
    // the scan itself works
    expect(calls("console.log(patch);")).toHaveLength(1);
  });
});
