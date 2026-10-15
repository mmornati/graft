import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../../src/bin/graft.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXAMPLE = path.join(ROOT, "docs/examples/graft.yaml");
const fixture = (name: string) => path.join(ROOT, "test/fixtures/policy", name);

async function run(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
  });
  return { code, out, err };
}
const tmp = () => mkdtempSync(path.join(tmpdir(), "graft-cli-"));

describe("graft policy CLI", () => {
  it("U-CLI-1 a valid file exits 0 with the OK line", async () => {
    const r = await run("policy", "check", EXAMPLE);
    expect(r).toEqual({
      code: 0,
      out: `${EXAMPLE}: OK (version 1, 8 rules, 2 sensitive paths)\n`,
      err: "",
    });
    expect((await run("policy", "check", fixture("minimal.yaml"))).out).toContain(
      "OK (version 1, 0 rules, 0 sensitive paths)",
    );
  });

  it("U-CLI-2 an invalid file exits 1 with one line per error", async () => {
    const file = fixture("invalid-multi.yaml");
    const r = await run("policy", "check", file);
    expect(r.code).toBe(1);
    const lines = r.out.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines) {
      expect(line.startsWith(`${file}:`), line).toBe(true);
      expect(line, line).toMatch(/:\d+:\d+: error [a-z_]+ \S+: \S.*[^)]$/);
    }
    expect(r.out).toContain("error approve_untrusted_key rules[1].match.author:");
    expect(r.out).toContain("error unknown_key rules[5]: Unknown key `aprove`.");
    // No raw file text leaks into the lines.
    expect(r.out).not.toContain("secret-label");
    expect(r.out).not.toContain("dup-secret-name");
    const bomb = await run("policy", "check", fixture("alias-bomb.yaml"));
    expect(bomb.code).toBe(1);
    expect(bomb.out).toContain("error yaml_alias");
  });

  it("U-CLI-3 --json prints {ok, errors, warnings}", async () => {
    const ok = await run("policy", "check", EXAMPLE, "--json");
    expect(JSON.parse(ok.out)).toEqual({ ok: true, errors: [], warnings: [] });
    expect(ok.code).toBe(0);
    const bad = await run("policy", "check", fixture("duplicate-key.yaml"), "--json");
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toEqual({
      ok: false,
      errors: [{ code: "yaml_duplicate_key", location: null, line: 2, column: 1 }],
      warnings: [],
    });
  });

  it("U-CLI-4 usage errors and unreadable files exit 2; a symlink is file_not_regular", async () => {
    expect((await run("policy", "check", "/nonexistent/graft.yaml")).code).toBe(2);
    expect((await run("policy", "check")).code).toBe(2);
    expect((await run("policy", "check", "a", "b")).code).toBe(2);
    expect((await run("policy", "check", EXAMPLE, "--bogus")).code).toBe(2);
    const bad = await run("frobnicate");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("usage:");
    expect((await run()).code).toBe(2);
    expect((await run("policy", "explain")).code).toBe(2);

    const dir = tmp();
    const link = path.join(dir, "graft.yaml");
    symlinkSync(EXAMPLE, link);
    const r = await run("policy", "check", link);
    expect(r.code).toBe(1);
    expect(r.out).toContain("error file_not_regular");
    const asDir = await run("policy", "check", dir);
    expect(asDir.code).toBe(1);
    expect(asDir.out).toContain("error file_not_regular");
  });

  it("U-CLI-7 an oversized file is file_too_large and is never read", async () => {
    const dir = tmp();
    const big = path.join(dir, "graft.yaml");
    // 3 GB sparse: reading it would fail (exit 2); the size check answers first (exit 1).
    const fd = openSync(big, "w");
    ftruncateSync(fd, 3 * 1024 ** 3);
    closeSync(fd);
    const r = await run("policy", "check", big);
    expect(r.code).toBe(1);
    expect(r.out).toContain("error file_too_large");
    const small = path.join(dir, "small.yaml");
    writeFileSync(small, `version: 1\n#${"x".repeat(40_000)}\n`);
    expect((await run("policy", "check", small)).out).toContain("error file_too_large");
  });

  it("U-CLI-5 schema --check passes on the committed file and fails on a modified copy", async () => {
    expect((await run("policy", "schema", "--check")).code).toBe(0);
    const dir = tmp();
    const copy = path.join(dir, "schema.json");
    copyFileSync(path.join(ROOT, "schema/graft.v1.schema.json"), copy);
    expect((await run("policy", "schema", "--check", "--path", copy)).code).toBe(0);
    writeFileSync(copy, `${readFileSync(copy, "utf8")} `);
    const drift = await run("policy", "schema", "--check", "--path", copy);
    expect(drift.code).toBe(1);
    expect(drift.err).toContain("out of date");
    // --write repairs it; the printed form is the committed one.
    expect((await run("policy", "schema", "--write", "--path", copy)).code).toBe(0);
    expect((await run("policy", "schema", "--check", "--path", copy)).code).toBe(0);
    const printed = await run("policy", "schema");
    expect(printed.out).toBe(readFileSync(path.join(ROOT, "schema/graft.v1.schema.json"), "utf8"));
    expect((await run("policy", "schema", "--write", "--check")).code).toBe(2);
    expect(
      (await run("policy", "schema", "--check", "--path", path.join(dir, "missing"))).code,
    ).toBe(2);
  });

  it("U-CLI-6 runs with an empty env and imports nothing from modules, db, config or queue", () => {
    const tsx = path.join(ROOT, "node_modules/.bin/tsx");
    const res = spawnSync(tsx, ["src/bin/graft.ts", "policy", "check", EXAMPLE], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("OK (version 1");
    const bad = spawnSync(
      tsx,
      ["src/bin/graft.ts", "policy", "check", fixture("alias-bomb.yaml")],
      {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      },
    );
    expect(bad.status).toBe(1);

    // The static import closure of the CLI and of src/policy.
    const specifiers = (file: string): string[] => {
      const src = readFileSync(file, "utf8");
      const found = [...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map(
        (m) => m[1] as string,
      );
      return found;
    };
    const resolve = (from: string, spec: string): string | null =>
      spec.startsWith(".") ? path.resolve(path.dirname(from), spec).replace(/\.js$/, ".ts") : null;
    const closure = (entry: string): string[] => {
      const seen = new Set<string>();
      const walk = (f: string) => {
        if (seen.has(f)) return;
        seen.add(f);
        for (const s of specifiers(f)) {
          const r = resolve(f, s);
          if (r) walk(r);
        }
      };
      walk(entry);
      return [...seen];
    };
    const forbidden = ["src/modules/", "src/db/", "src/config/", "src/queue/"];
    const cli = closure(path.join(ROOT, "src/bin/graft.ts"));
    expect(cli.length).toBeGreaterThan(5);
    for (const f of cli) for (const bad of forbidden) expect(f, f).not.toContain(bad);

    // The library: only load.ts reaches outside, and only for error classes and the logger type.
    const policyDir = path.join(ROOT, "src/policy");
    for (const name of readdirSync(policyDir)) {
      const file = path.join(policyDir, name);
      for (const spec of specifiers(file)) {
        const r = resolve(file, spec);
        if (!r) continue;
        const rel = path.relative(ROOT, r);
        for (const bad of ["src/modules/", "src/db/", "src/config/"])
          expect(rel, `${name} -> ${rel}`).not.toContain(bad);
        if (rel.includes("src/queue/")) {
          expect(name).toBe("load.ts");
          expect(rel).toBe("src/queue/errors.ts");
        }
      }
    }
  });
  it("U-CLI-8 warnings print after the errors and never change the exit code; a lookalike glob fails", async () => {
    const file = fixture("non-ascii-glob.yaml");
    const r = await run("policy", "check", file);
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK (version 1, 1 rules, 0 sensitive paths)");
    expect(r.out).toContain(
      `${file}:4:22: warning glob_non_ascii rules[1].match.paths[1]: non-ASCII characters U+0440, U+0443, U+043A, U+043E, U+0432`,
    );
    // The glob text itself is never printed.
    expect(r.out).not.toContain("\u0440\u0443\u043a");

    const json = await run("policy", "check", file, "--json");
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out);
    expect(parsed).toMatchObject({ ok: true, errors: [] });
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatchObject({ code: "glob_non_ascii", line: 4 });

    const bad = await run("policy", "check", fixture("lookalike-glob.yaml"));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("error glob_invalid sensitive_paths[1]");
    expect(bad.out).toContain("mixes writing systems in one segment");
  });
});
