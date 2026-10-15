import { describe, expect, it } from "vitest";
import { main } from "../../src/bin/graft.js";
import { e2eMain, parseRun, USAGE } from "../../src/e2e/cli.js";
import type { E2eDeps } from "../../src/e2e/types.js";

/** Deps that fail the test if anything touches them: usage errors must not get that far. */
const untouchable = new Proxy({} as E2eDeps, {
  get(_t, prop) {
    throw new Error(`usage errors must not touch the dependencies (${String(prop)})`);
  },
});

async function e2e(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await e2eMain(
    argv,
    { out: (s) => out.push(s), err: (s) => err.push(s) },
    untouchable,
  );
  return { code, out: out.join(""), err: err.join("") };
}

describe("e2e CLI", () => {
  it("U-LIVE-CLI-1 an unknown or missing subcommand prints usage and exits 2", async () => {
    for (const argv of [
      [],
      ["frobnicate"],
      ["run", "--nope"],
      ["setup", "extra-positional"],
      ["verify", "--run-id"],
    ]) {
      const r = await e2e(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toContain("usage:");
    }
    expect((await e2e(["frobnicate"])).err).toBe(USAGE);
  });

  it("U-LIVE-CLI-1 option validation: scenarios, --llm, numbers, cleanup's exclusive flags", async () => {
    for (const argv of [
      ["run", "--scenario", "s99"],
      ["run", "--llm", "maybe"],
      ["run", "--max-cost-usd", "0"],
      ["run", "--max-cost-usd", "lots"],
      ["run", "--timeout-scale", "-1"],
      ["cleanup"],
      ["cleanup", "--all", "--run-id", "e2e-20261015-abcdef"],
    ]) {
      const r = await e2e(argv);
      expect(r.code, argv.join(" ")).toBe(2);
    }
    const o = parseRun([
      "--scenario",
      "s01",
      "--scenario",
      "b2",
      "--llm",
      "none",
      "--interactive",
      "--capture",
      "--lenient-model",
      "--timeout-scale",
      "2",
      "--max-cost-usd",
      "1.5",
      "--confirm",
      "a/b",
      "--json",
    ]);
    expect(o).toMatchObject({
      scenarios: ["s01", "b2"],
      llm: "none",
      interactive: true,
      capture: true,
      lenientModel: true,
      timeoutScale: 2,
      maxCostUsd: 1.5,
      confirm: "a/b",
      json: true,
      dryRun: false,
      onlyOffline: false,
    });
    expect(parseRun([])).toMatchObject({
      llm: "auto",
      maxCostUsd: 5,
      timeoutScale: 1,
      scenarios: [],
    });
  });

  it("U-LIVE-CLI-1 --only-offline ignores every option except --scenario and --llm", () => {
    const o = parseRun([
      "--only-offline",
      "--scenario",
      "s08",
      "--llm",
      "none",
      "--interactive",
      "--dry-run",
      "--sandbox",
      "x/y",
      "--max-cost-usd",
      "99",
      "--capture",
      "--confirm",
      "x/y",
    ]);
    expect(o).toMatchObject({
      onlyOffline: true,
      scenarios: ["s08"],
      llm: "none",
      interactive: false,
      dryRun: false,
      capture: false,
      maxCostUsd: 5,
    });
    expect(o.sandbox).toBeUndefined();
    expect(o.confirm).toBeUndefined();
  });

  it("U-LIVE-CLI-1 the graft entry point routes e2e and keeps graft policy check independent of the environment", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) };
    expect(await main(["e2e", "frobnicate"], io)).toBe(2);
    expect(err.join("")).toContain("graft e2e setup");
    // U-CLI-6 stays true: the policy check runs without a configuration (no import of e2e).
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) delete process.env[k];
    try {
      out.length = 0;
      expect(await main(["policy", "check", "e2e/fixtures/graft.yaml"], io)).toBe(0);
      expect(out.join("")).toContain("OK (version 1, 3 rules");
      expect(await main(["policy", "check", "e2e/fixtures/graft.s09.yaml"], io)).toBe(0);
      expect(await main(["policy", "check", "e2e/fixtures/graft.s05.yaml"], io)).toBe(0);
    } finally {
      Object.assign(process.env, saved);
    }
  });
});

describe("--only-offline", () => {
  it("U-LIVE-CLI-4 the child gets only the offline variables, and its output is redacted and terminal-safe", async () => {
    const token = "ghp_ACTORsecret0123456789abcdefABCD";
    const calls: { command: string; args: string[]; env?: Record<string, string> | undefined }[] =
      [];
    const deps = {
      env: { GRAFT_E2E_ACTOR_TOKEN: token, PATH: "/bin" },
      now: () => new Date("2026-10-15T10:00:00Z"),
      outDir: "/tmp/e2e-runs",
      rootDir: "/repo",
      spawn: async (command: string, args: string[], o?: { env?: Record<string, string> }) => {
        calls.push({ command, args, env: o?.env });
        return { code: 1, stdout: `vitest saw ${token}\u001b[31m`, stderr: `and again ${token}` };
      },
    } as unknown as E2eDeps;
    const out: string[] = [];
    const err: string[] = [];
    const code = await e2eMain(
      ["run", "--only-offline", "--scenario", "s01", "--llm", "none"],
      { out: (s) => out.push(s), err: (s) => err.push(s) },
      deps,
    );
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "exec",
      "vitest",
      "run",
      "--project",
      "integration",
      "test/integration/live-e2e.test.ts",
    ]);
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual([
      "GRAFT_E2E_OFFLINE_LLM",
      "GRAFT_E2E_OFFLINE_OUT",
      "GRAFT_E2E_OFFLINE_SCENARIOS",
    ]);
    const text = out.join("") + err.join("");
    expect(text).not.toContain(token);
    expect(text).not.toContain("\u001b");
    expect(text).toContain("[REDACTED]");
  });
});
