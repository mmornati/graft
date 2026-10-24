/**
 * Phase 1 step 7 (D21, I-LIVE-ENF-1): the live e2e runner against an `enforce` sandbox in the
 * offline world. Graft runs with the ceiling `enforce` and the real mode gate; the human's part
 * (the ceiling and `--policy enforce`) is done in the database before the run, as the runner
 * never changes a mode.
 */
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { e2eMain } from "../../src/e2e/cli.js";
import { type Report, reportSchema } from "../../src/e2e/report-schema.js";
import {
  createLiveEnv,
  type LiveEnv,
  ROOT,
  SANDBOX_OWNER,
  SANDBOX_REPO,
  sandboxSeed,
} from "../helpers/live-e2e-env.js";

const SANDBOX = `${SANDBOX_OWNER}/${SANDBOX_REPO}`;
let env: LiveEnv;
let root: string;

beforeAll(async () => {
  // A repository root whose sandboxes.json marks the sandbox `enforce`.
  root = await mkdtemp(path.join(os.tmpdir(), "graft-e2e-enforce-root-"));
  await cp(path.join(ROOT, "e2e"), path.join(root, "e2e"), { recursive: true });
  await cp(path.join(ROOT, "github"), path.join(root, "github"), { recursive: true });
  const cfg = JSON.parse(await readFile(path.join(root, "e2e", "sandboxes.json"), "utf8"));
  cfg.sandboxes[0].mode = "enforce";
  await writeFile(path.join(root, "e2e", "sandboxes.json"), JSON.stringify(cfg, null, 2));
  env = await createLiveEnv({
    realGate: true,
    rootDir: root,
    extraConfig: { GRAFT_MODE_CEILING: "enforce", GRAFT_POLICY_CARD_WAIT_SECONDS: "0" },
  });
});
afterAll(async () => {
  await env.close();
  await rm(root, { recursive: true, force: true });
});

async function lastReport(): Promise<Report> {
  const names = (await readdir(env.outDir)).filter((n) => /^e2e-\d{8}-[a-z2-7]{6}$/.test(n));
  const dated = await Promise.all(
    names.map(async (n) => ({ n, t: (await stat(path.join(env.outDir, n))).mtimeMs })),
  );
  const dir = path.join(env.outDir, dated.sort((a, b) => b.t - a.t)[0]?.n ?? "");
  return reportSchema.parse(JSON.parse(await readFile(path.join(dir, "report.json"), "utf8")));
}

const run = (argv: string[]) =>
  e2eMain(argv, { out: (s) => env.out.push(s), err: (s) => env.err.push(s) }, env.deps);

/** The human's part: the enforce starter on main, the worker's ceiling and `--policy enforce`. */
async function enforceWorld(): Promise<void> {
  const seed = await sandboxSeed();
  seed.set(
    "graft.yaml",
    await readFile(path.join(ROOT, "e2e/fixtures/graft.enforce.yaml"), "utf8"),
  );
  await env.newWorld({ seedFiles: seed });
  await env.install();
  await env.t.db
    .insertInto("service_state")
    .values({ key: "mode_ceiling", value: "enforce", updated_at: new Date() })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: "enforce" }))
    .execute();
  await env.t.db.updateTable("repositories").set({ policy_mode: "enforce" }).execute();
  // The installation's permissions are read by a job after installation.created.
  for (let i = 0; i < 200; i++) {
    const row = await env.t.db
      .selectFrom("installations")
      .select("permissions_read_at")
      .executeTakeFirst();
    if (row?.permissions_read_at) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the installation's permissions were not read");
}

const common = ["--confirm", SANDBOX, "--timeout-scale", "0.1"];

describe("live e2e runner, enforce sandbox (Phase 1 step 7, D21)", () => {
  it("I-LIVE-ENF-1 e01 passes with INV-1E; with the final graft/policy turned neutral, INV-1E fails and the report names it", async () => {
    env.setLlm("live");
    await enforceWorld();
    // s01 is refused against an enforce sandbox (exit 2), before anything is written.
    expect(await run(["run", "--scenario", "s01", ...common])).toBe(2);

    const code = await run(["run", ...common]);
    const report = await lastReport();
    const e01 = report.scenarios.find((s) => s.id === "e01");
    const problems = [
      ...(e01?.assertions ?? [])
        .filter((a) => !a.ok)
        .map((a) => `${a.id} ${JSON.stringify(a.observed)}`),
      ...(e01?.invariants ?? [])
        .filter((i) => i.status === "fail")
        .map((i) => `${i.id} ${i.detail}`),
      ...(e01?.error ? [e01.error.message] : []),
    ];
    expect(problems, env.err.join("")).toEqual([]);
    expect(report.scenarios.map((s) => s.id)).toEqual(["e01"]);
    expect(e01?.status).toBe("pass");
    expect(e01?.invariants.map((i) => i.id)).toContain("INV-1E");
    expect(e01?.invariants.map((i) => i.id)).not.toContain("INV-1");
    expect(code).toBe(0);

    // The same run with graft/policy listed as neutral: INV-1E fails and says why.
    await enforceWorld();
    env.world.rewriteCheckConclusion = (r) => (r.name === "graft/policy" ? "neutral" : undefined);
    try {
      expect(await run(["run", ...common])).toBe(1);
    } finally {
      env.world.rewriteCheckConclusion = null;
    }
    const bad = (await lastReport()).scenarios.find((s) => s.id === "e01");
    const inv = bad?.invariants.find((i) => i.id === "INV-1E");
    expect(inv?.status).toBe("fail");
    expect(inv?.detail).toContain("graft/policy is neutral");
  }, 600_000);
});
