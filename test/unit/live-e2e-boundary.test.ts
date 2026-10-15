import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git" || name === "e2e-runs")
      continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

const imports = (text: string): string[] =>
  [...text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1] as string);

/** Resolves a relative import to a path under src (no extension, `.js` stripped). */
function resolveSrc(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const target = path.resolve(path.dirname(from), spec.replace(/\.js$/, ""));
  return path.relative(path.join(ROOT, "src"), target);
}

const ALLOWED = [
  /^config\//,
  /^core\//,
  /^db\/client$/,
  /^db\/migrator$/,
  /^github\/(client-factory|errors|rate-limit|managed-comment)$/,
  /^llm\/pricing$/,
  /^pilot\/baseline$/,
  /^pilot\/atomic-write$/,
  /^policy\/parse$/,
  /^eval\/terminal$/,
  /^modules\/[a-z]+\/index$/,
  /^e2e\//,
];

describe("live e2e import boundary", () => {
  it("U-LIVE-BOUND-1 src/e2e imports only the allowed modules, only src/bin/graft.ts imports src/e2e, and GRAFT_E2E_ stays inside the e2e files", () => {
    const e2e = files(path.join(ROOT, "src/e2e"), [".ts"]);
    expect(e2e.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const f of e2e) {
      for (const spec of imports(readFileSync(f, "utf8"))) {
        if (!spec.startsWith(".")) continue;
        const rel = resolveSrc(f, spec);
        if (rel === null) continue;
        if (rel.startsWith("..")) offenders.push(`${path.relative(ROOT, f)} -> ${spec}`);
        else if (!ALLOWED.some((re) => re.test(rel)))
          offenders.push(`${path.relative(ROOT, f)} -> ${spec}`);
        // Only normalizeEvent of src/pilot may be used: the rest of src/pilot is the CLI's.
      }
    }
    expect(offenders).toEqual([]);

    // Nobody but src/bin/graft.ts imports src/e2e.
    const importers: string[] = [];
    for (const f of files(path.join(ROOT, "src"), [".ts"])) {
      if (f.startsWith(path.join(ROOT, "src/e2e"))) continue;
      if (imports(readFileSync(f, "utf8")).some((s) => /(^|\/)e2e\//.test(s)))
        importers.push(path.relative(ROOT, f));
    }
    expect(importers).toEqual(["src/bin/graft.ts"]);

    // GRAFT_E2E_ is mentioned only in src/e2e, src/bin/graft.ts, test/ and docs/ (and e2e/ fixtures).
    const mentions: string[] = [];
    for (const dir of ["src", "scripts", "github", "schema", "eval"]) {
      for (const f of files(path.join(ROOT, dir), [
        ".ts",
        ".json",
        ".html",
        ".md",
        ".yaml",
        ".yml",
        ".sh",
      ])) {
        const rel = path.relative(ROOT, f);
        if (rel.startsWith("src/e2e/") || rel === "src/bin/graft.ts") continue;
        if (readFileSync(f, "utf8").includes("GRAFT_E2E_")) mentions.push(rel);
      }
    }
    for (const f of ["package.json", "README.md", ".env.example", "docker-compose.yml"]) {
      try {
        // README documents the runner; it is documentation like docs/.
        if (f !== "README.md" && readFileSync(path.join(ROOT, f), "utf8").includes("GRAFT_E2E_"))
          mentions.push(f);
      } catch {
        // file absent
      }
    }
    expect(mentions).toEqual([]);
  });

  it("src/e2e uses only normalizeEvent from src/pilot/baseline", () => {
    for (const f of files(path.join(ROOT, "src/e2e"), [".ts"])) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*["'][^"']*pilot\/baseline\.js["']/g,
      )) {
        expect(
          (m[1] as string)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ).toEqual(["normalizeEvent"]);
      }
    }
  });
});
