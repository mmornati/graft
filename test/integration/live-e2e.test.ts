/**
 * The live e2e runner against the fake GitHub world, the fake LLM and the test database
 * (I-LIVE-RUN-1..5). `pnpm graft e2e run --only-offline` runs exactly this file with
 * GRAFT_E2E_OFFLINE_OUT (where the report is copied), GRAFT_E2E_OFFLINE_LLM and
 * GRAFT_E2E_OFFLINE_SCENARIOS; under a plain `pnpm test` the report goes to a temp directory.
 */
import { copyFile, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { e2eMain } from "../../src/e2e/cli.js";
import { type Report, reportSchema } from "../../src/e2e/report-schema.js";
import { ACTOR, createLiveEnv, type LiveEnv, OUTSIDER } from "../helpers/live-e2e-env.js";

const OFFLINE_OUT = process.env.GRAFT_E2E_OFFLINE_OUT;
const OFFLINE_LLM = process.env.GRAFT_E2E_OFFLINE_LLM;
const OFFLINE_SCENARIOS = (process.env.GRAFT_E2E_OFFLINE_SCENARIOS ?? "")
  .split(",")
  .filter(Boolean);
const SANDBOX = "mmornati/graft-sandbox";

let env: LiveEnv;
beforeAll(async () => {
  env = await createLiveEnv();
});
afterAll(() => env.close());
beforeEach(() => {
  env.out.length = 0;
  env.err.length = 0;
});

async function run(argv: string[]): Promise<number> {
  return e2eMain(argv, { out: (s) => env.out.push(s), err: (s) => env.err.push(s) }, env.deps);
}

async function lastReport(): Promise<{ report: Report; dir: string }> {
  const names = (await readdir(env.outDir)).filter((n) => /^e2e-\d{8}-[a-z2-7]{6}$/.test(n));
  const dated = await Promise.all(
    names.map(async (n) => ({ n, t: (await stat(path.join(env.outDir, n))).mtimeMs })),
  );
  const dir = path.join(env.outDir, dated.sort((a, b) => b.t - a.t)[0]?.n ?? "");
  const report = reportSchema.parse(
    JSON.parse(await readFile(path.join(dir, "report.json"), "utf8")),
  );
  return { report, dir };
}

const scenarioArgs = (ids: string[]) => ids.flatMap((s) => ["--scenario", s]);
const common = ["--confirm", SANDBOX, "--timeout-scale", "0.1"];

function prOf(scenario: string): number {
  for (const pr of env.world.prs.values()) {
    if (new RegExp(`^\\[graft-e2e e2e-\\d{8}-[a-z2-7]{6} ${scenario}\\] `).test(pr.title))
      return pr.number;
  }
  throw new Error(`no PR for ${scenario}`);
}

const failures = (r: Report) =>
  r.scenarios.flatMap((s) => [
    // The observed value says why (s10.stable: which fingerprint keys changed, and how).
    ...s.assertions
      .filter((a) => !a.ok && a.kind !== "soft")
      .map((a) => `${s.id}:${a.id} observed ${JSON.stringify(a.observed)}`),
    ...s.invariants.filter((i) => i.status === "fail").map((i) => `${s.id}:${i.id}`),
    ...(s.error ? [`${s.id}:error ${s.error.message}`] : []),
  ]);

describe("live e2e runner, offline", () => {
  const live = OFFLINE_LLM !== "none";
  // `--only-offline` without --llm runs the live suite only (D17); a plain `pnpm test` also runs
  // the none variant, on the scenarios whose none expectations differ.
  const none = OFFLINE_LLM === "none" || (OFFLINE_LLM === undefined && OFFLINE_OUT === undefined);
  const noneScenarios =
    OFFLINE_SCENARIOS.length > 0 || OFFLINE_OUT !== undefined
      ? OFFLINE_SCENARIOS
      : ["s01", "s05", "s06", "s07", "s08", "s09", "s10", "b1"];

  it.runIf(live)(
    "I-LIVE-RUN-1 full suite with a live card, an outsider and interactive buttons: every scenario passes",
    async () => {
      env.setLlm("live");
      await env.newWorld({ rateLimit: true });
      await env.install();
      env.deps.prompt = async (question) => {
        if (question.includes('"Card is wrong"')) {
          const check = env.world.checkRunOf(prOf("s01"), "graft/intent");
          await env.world.clickButton(OUTSIDER, check?.id ?? 0, "card_down");
          return "clicked";
        }
        if (question.includes("Card is accurate")) {
          const check = env.world.checkRunOf(prOf("s08"), "graft/intent");
          await env.world.clickButton(ACTOR, check?.id ?? 0, "card_up");
          return "y";
        }
        return "y";
      };
      const code = await run([
        "run",
        ...scenarioArgs(OFFLINE_SCENARIOS),
        "--interactive",
        "--capture",
        "--with-source-baseline",
        ...common,
      ]);
      const { report, dir } = await lastReport();
      expect(failures(report)).toEqual([]);
      expect(code).toBe(0);
      expect(report.mode).toMatchObject({ target: "offline", llm: "live", interactive: true });
      if (OFFLINE_SCENARIOS.length === 0) {
        expect(report.scenarios.map((s) => `${s.id}:${s.status}`)).toEqual([
          "s01:pass",
          "s02:pass",
          "s03:pass",
          "s04:pass",
          "s05:pass",
          "s06:pass",
          "s07:pass",
          "s08:pass",
          "s09:pass",
          "s10:pass",
          "b1:pass",
          "b2:pass",
        ]);
        const notPass = report.assumptions
          .filter((a) => a.status !== "pass")
          .map((a) => `${a.id}:${a.status}`);
        expect(notPass).toEqual(["A04:unverified", "A18:unverified"]);
      }
      // No invariant failed; INV-3 is accounted (webhook jobs are still within their hour).
      for (const s of report.scenarios) {
        for (const i of s.invariants) expect(i.status, `${s.id} ${i.id}`).not.toBe("fail");
      }
      expect(env.logged()).not.toContain("payload_shape_mismatch");
      // The capture holds every file kind, and no token anywhere in the run directory.
      expect(await readdir(path.join(dir, "capture"))).toEqual(
        expect.arrayContaining(["api", "webhooks", "manifest.json", "index.jsonl"]),
      );
      const text = await allText(dir);
      for (const secret of [ACTOR.token, OUTSIDER.token]) {
        expect(text).not.toContain(secret);
        expect(env.out.join("") + env.err.join("")).not.toContain(secret);
      }
      await publishReport(dir);
    },
    600_000,
  );

  it.runIf(none)(
    "I-LIVE-RUN-2 no model configured: s01-s07, s09, s10 and b1 pass with the none expectations; s08 is skipped",
    async () => {
      env.setLlm("none");
      env.resetLlmCalls();
      await env.newWorld();
      await env.install();
      const code = await run(["run", ...scenarioArgs(noneScenarios), ...common]);
      const { report, dir } = await lastReport();
      expect(failures(report)).toEqual([]);
      expect(code).toBe(0);
      expect(report.mode.llm).toBe("none");
      const s08 = report.scenarios.find((s) => s.id === "s08");
      const full = noneScenarios.length === 0;
      if (full || noneScenarios.includes("s08")) {
        expect(s08).toMatchObject({ status: "skipped", skipReason: "needs_live_llm" });
      }
      if (full) {
        expect(report.scenarios.filter((s) => s.status === "pass").map((s) => s.id)).toEqual([
          "s01",
          "s02",
          "s03",
          "s04",
          "s05",
          "s06",
          "s07",
          "s09",
          "s10",
          "b1",
        ]);
      } else if (OFFLINE_SCENARIOS.length === 0) {
        expect(report.scenarios.filter((s) => s.status === "pass").map((s) => s.id)).toEqual([
          "s01",
          "s05",
          "s06",
          "s07",
          "s09",
          "s10",
          "b1",
        ]);
      }
      // No model is configured: nothing may even try to call one.
      expect(env.llmCalls()).toBe(0);
      await publishReport(dir);
    },
    600_000,
  );

  describe.skipIf(OFFLINE_OUT !== undefined)("variants", () => {
    it("I-LIVE-RUN-3 no outsider token: s08 is skipped (needs_outsider) with a notice", async () => {
      env.setLlm("live");
      await env.newWorld({ outsider: false });
      await env.install();
      const saved = env.deps.env.GRAFT_E2E_OUTSIDER_TOKEN;
      delete env.deps.env.GRAFT_E2E_OUTSIDER_TOKEN;
      try {
        const code = await run(["run", "--scenario", "s08", ...common]);
        const { report } = await lastReport();
        expect(code).toBe(0);
        expect(report.scenarios.find((s) => s.id === "s08")).toMatchObject({
          status: "skipped",
          skipReason: "needs_outsider",
        });
        expect(env.out.join("")).toContain("s08: skipped, needs an outsider token");
      } finally {
        env.deps.env.GRAFT_E2E_OUTSIDER_TOKEN = saved;
      }
    }, 300_000);

    it("I-LIVE-RUN-4 comments without performed_via_github_app: A01 fails with evidence; the slug keeps INV-2 and A02 passing", async () => {
      env.setLlm("live");
      await env.newWorld({ omitPerformedViaApp: true });
      await env.install();
      const code = await run(["run", "--scenario", "s01", ...common]);
      const { report } = await lastReport();
      const a01 = report.assumptions.find((a) => a.id === "A01");
      expect(a01?.status).toBe("fail");
      expect(JSON.stringify(a01?.evidence)).toContain("null");
      expect(report.assumptions.find((a) => a.id === "A02")?.status).toBe("pass");
      const inv2 = report.scenarios
        .find((s) => s.id === "s01")
        ?.invariants.find((i) => i.id === "INV-2");
      expect(inv2?.status).toBe("pass");
      expect(code).toBe(0);
    }, 300_000);

    it("I-LIVE-RUN-5 a check run that is no longer neutral fails INV-1, the scenario and the run", async () => {
      env.setLlm("live");
      await env.newWorld();
      await env.install();
      env.world.rewriteCheckConclusion = (r) => (r.name === "graft/policy" ? "success" : undefined);
      const code = await run(["run", "--scenario", "s01", ...common]);
      const { report } = await lastReport();
      expect(code).toBe(1);
      const s01 = report.scenarios.find((s) => s.id === "s01");
      expect(s01?.status).toBe("fail");
      const inv1 = s01?.invariants.find((i) => i.id === "INV-1");
      expect(inv1?.status).toBe("fail");
      expect(inv1?.detail).toContain("graft/policy");
      expect(report.exitCode).toBe(1);
    }, 300_000);
  });
});

async function allText(dir: string): Promise<string> {
  let out = "";
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out += await readFile(path.join(e.parentPath, e.name), "utf8");
  }
  return out;
}

/** `pnpm graft e2e run --only-offline` prints this path. */
async function publishReport(dir: string): Promise<void> {
  if (OFFLINE_OUT === undefined) return;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(OFFLINE_OUT, { recursive: true, mode: 0o700 });
  await copyFile(path.join(dir, "report.md"), path.join(OFFLINE_OUT, "report.md"));
  await copyFile(path.join(dir, "report.json"), path.join(OFFLINE_OUT, "report.json"));
}
