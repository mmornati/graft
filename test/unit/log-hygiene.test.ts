import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const ROOT = new URL("../../src/", import.meta.url).pathname;
const FILES = [...sources(join(ROOT, "llm")), ...sources(join(ROOT, "modules/intent"))];

/** Every logger call, from `log.<level>(` to the matching `);`. */
function logCalls(text: string): string[] {
  const calls: string[] = [];
  const re = /\blog(?:\?)?\.(?:trace|debug|info|warn|error|fatal)\(/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const end = text.indexOf(");", m.index);
    calls.push(text.slice(m.index, end === -1 ? undefined : end + 2));
  }
  return calls;
}

describe("log hygiene", () => {
  it("U-LOG-2 no logger call in the LLM client or the intent module touches prompts, diffs, PR text or model output", () => {
    const forbidden =
      /\b(patch|writerUser|verifierData|req\.user|req\.system|\.system\b|\.user\b|\.value\b|\.title\b|\.body\b|inputs\b|res\.content|text\b|diff\b|prompt)/;
    let seen = 0;
    for (const file of FILES) {
      for (const call of logCalls(readFileSync(file, "utf8"))) {
        seen++;
        expect(call, file).not.toMatch(forbidden);
        // an error object is never logged raw from these modules (it may carry a request body)
        expect(call, file).not.toMatch(/\{\s*err\b|\berr,/);
      }
    }
    expect(seen).toBeGreaterThan(5);
  });
});
