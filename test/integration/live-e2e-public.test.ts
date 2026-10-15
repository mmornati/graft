/** Public (fork) mode: the outsider forks the sandbox, opens its PR from the fork, and cleanup follows. */
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { e2eMain } from "../../src/e2e/cli.js";
import { type Report, reportSchema } from "../../src/e2e/report-schema.js";
import { createLiveEnv, type LiveEnv, OUTSIDER, ROOT } from "../helpers/live-e2e-env.js";

let env: LiveEnv;
let root: string;
const SANDBOX = "mmornati/graft-sandbox";
beforeAll(async () => {
  env = await createLiveEnv();
  // A root whose sandbox is public; fixtures and the manifest are copied from the repository.
  root = await mkdtemp(path.join(os.tmpdir(), "graft-e2e-public-"));
  await cp(path.join(ROOT, "e2e"), path.join(root, "e2e"), { recursive: true });
  await cp(path.join(ROOT, "github"), path.join(root, "github"), { recursive: true });
  const file = path.join(root, "e2e", "sandboxes.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  config.sandboxes[0].visibility = "public";
  await writeFile(file, JSON.stringify(config));
});
afterAll(async () => {
  await env.close();
  await rm(root, { recursive: true, force: true });
});

const run = (argv: string[]) =>
  e2eMain(
    argv,
    { out: (s) => env.out.push(s), err: (s) => env.err.push(s) },
    { ...env.deps, rootDir: root },
  );

describe("public sandbox", () => {
  it("I-LIVE-PUBLIC-1 s08 runs from a fork, and cleanup deletes the fork's branches with the outsider's client", async () => {
    env.setLlm("live");
    await env.newWorld({ private: false });
    await env.install();
    const w = env.world;
    const code = await run([
      "run",
      "--scenario",
      "s08",
      "--confirm",
      SANDBOX,
      "--timeout-scale",
      "0.1",
    ]);
    if (code !== 0) {
      const d = (await readdir(env.outDir)).find((n) => n.startsWith("e2e-"));
      const rep = d
        ? await readFile(path.join(env.outDir, d, "report.md"), "utf8").catch(() => "")
        : "";
      throw new Error(
        `exit ${code}\n${env.out.join("")}${env.err.join("")}\n${rep
          .split("\n")
          .filter((l) => /FAIL|Error|fail/.test(l))
          .join("\n")}`,
      );
    }
    const names = (await readdir(env.outDir)).filter((n) => /^e2e-\d{8}-[a-z2-7]{6}$/.test(n));
    const dir = path.join(env.outDir, names[0] as string);
    const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8")) as Report;
    reportSchema.parse(report);
    expect(report.sandbox).toMatchObject({ visibility: "public", outsiderMode: "fork" });
    expect(report.scenarios.find((s) => s.id === "s08")?.status).toBe("pass");
    // The PR came from the fork; there is no requested-reviewer evidence (a fork author cannot request).
    const pr8 = [...w.prs.values()].find((p) => / s08\] /.test(p.title));
    expect(pr8?.headRepo).toBe(`${OUTSIDER.login}/graft-sandbox`.toLowerCase());
    expect(w.log.some((r) => r.method === "POST" && /\/forks$/.test(r.path))).toBe(true);
    expect(w.log.some((r) => /merge-upstream$/.test(r.path))).toBe(true);
    const forkRefs = [...(w.refs(`${OUTSIDER.login}/graft-sandbox`)?.keys() ?? [])];
    expect(forkRefs.some((r) => r.startsWith("heads/graft-e2e/e2e-"))).toBe(true);
    // Nothing was written to the sandbox's git data by the outsider.
    const runId = names[0] as string;

    env.out.length = 0;
    env.err.length = 0;
    expect(await run(["cleanup", "--run-id", runId, "--yes", "--confirm", SANDBOX])).toBe(0);
    const after = [...(w.refs(`${OUTSIDER.login}/graft-sandbox`)?.keys() ?? [])];
    expect(after.some((r) => r.includes(runId))).toBe(false);
    expect(after).toContain("heads/main");
    expect(w.prs.get(pr8?.number as number)?.state).toBe("closed");
  }, 300_000);
});
