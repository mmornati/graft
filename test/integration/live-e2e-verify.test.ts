/** verify, report and the sentinel scan against rows that really exist. */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { e2eMain } from "../../src/e2e/cli.js";
import { type Report, reportSchema } from "../../src/e2e/report-schema.js";
import { stateSchema } from "../../src/e2e/state.js";
import { createLiveEnv, type LiveEnv } from "../helpers/live-e2e-env.js";

let env: LiveEnv;
const SANDBOX = "mmornati/graft-sandbox";
beforeAll(async () => {
  env = await createLiveEnv();
});
afterAll(() => env.close());

const run = (argv: string[]) =>
  e2eMain(argv, { out: (s) => env.out.push(s), err: (s) => env.err.push(s) }, env.deps);
const output = () => env.out.join("") + env.err.join("");

async function runId(): Promise<string> {
  return (await readdir(env.outDir)).filter((n) => /^e2e-\d{8}-[a-z2-7]{6}$/.test(n))[0] as string;
}
const reportOf = async (id: string): Promise<Report> =>
  reportSchema.parse(JSON.parse(await readFile(path.join(env.outDir, id, "report.json"), "utf8")));

describe("verify and the sentinel scan", () => {
  it("U-LIVE-REP-3 verify --after-retention refuses before 3,900 s and turns remaining github.webhook hits into failures after; I-LIVE-SENT-1 a sentinel in policy_verdicts.errors fails INV-3 naming table and key", async () => {
    await env.newWorld();
    await env.install();
    expect(
      await run(["run", "--scenario", "s01", "--confirm", SANDBOX, "--timeout-scale", "0.1"]),
    ).toBe(0);
    const id = await runId();
    const state = stateSchema.parse(
      JSON.parse(await readFile(path.join(env.outDir, id, "state.json"), "utf8")),
    );
    const sentinel = state.sentinels.s01?.D as string;
    expect(sentinel).toMatch(/^ZQSNT[a-z2-7]{12}-D$/);

    // Too early for the retention check.
    env.out.length = 0;
    env.err.length = 0;
    expect(await run(["verify", "--after-retention", "--confirm", SANDBOX])).toBe(3);
    expect(output()).toContain("too early for --after-retention");

    // A plain verify passes: the webhook jobs are still within their hour (accounted).
    env.out.length = 0;
    expect(await run(["verify", "--confirm", SANDBOX])).toBe(0);
    const plain = await reportOf(id);
    const verify = plain.scenarios.find((s) => s.id === "verify");
    expect(verify?.status).toBe("pass");
    expect(verify?.invariants.find((i) => i.id === "INV-3")?.status).toBe("accounted");
    expect(plain.assumptions.find((a) => a.id === "A18")?.status).toBe("unverified");

    // Four thousand seconds later the same jobs may no longer be there: any that is, fails.
    const realNow = env.deps.now;
    env.deps.now = () => new Date(Date.now() + 4000 * 1000);
    try {
      env.out.length = 0;
      expect(await run(["verify", "--after-retention", "--confirm", SANDBOX])).toBe(1);
    } finally {
      env.deps.now = realNow;
    }
    const after = await reportOf(id);
    const inv3 = after.scenarios
      .find((s) => s.id === "verify")
      ?.invariants.find((i) => i.id === "INV-3");
    expect(inv3?.status).toBe("fail");
    expect(inv3?.detail).toContain("pgboss.job.data");
    expect(JSON.stringify(after)).not.toContain(sentinel);
    expect(after.assumptions.find((a) => a.id === "A18")?.status).toBe("fail");
    expect(after.exitCode).toBe(1);

    // I-LIVE-SENT-1: a planted sentinel in a column Graft must never fill.
    await sql`delete from pgboss.job where name = 'github.webhook'`.execute(env.t.db);
    await sql`delete from pgboss.job where data::text like ${`%${sentinel.slice(0, 17)}%`}`.execute(
      env.t.db,
    );
    env.out.length = 0;
    expect(await run(["verify", "--confirm", SANDBOX])).toBe(0);
    await sql`update policy_verdicts set errors = ${JSON.stringify([{ code: "x", note: sentinel }])}::jsonb`.execute(
      env.t.db,
    );
    env.out.length = 0;
    expect(await run(["verify", "--confirm", SANDBOX])).toBe(1);
    const planted = await reportOf(id);
    const bad = planted.scenarios
      .find((s) => s.id === "verify")
      ?.invariants.find((i) => i.id === "INV-3");
    expect(bad).toMatchObject({ status: "fail" });
    expect(bad?.detail).toContain("policy_verdicts.errors");
    expect(bad?.detail).not.toContain(sentinel);
    expect(
      planted.sentinels.hits.some(
        (h) => h.table === "policy_verdicts" && h.key === "errors" && h.class === "fail",
      ),
    ).toBe(true);
    expect(JSON.stringify(planted)).not.toContain(sentinel);

    // `report` re-renders from state.json with no network and ticks nothing here.
    env.out.length = 0;
    expect(await run(["report", "--run-id", id])).toBe(0);
    expect(output()).toContain("report:");
    await writeFile(path.join(env.outDir, "unused"), "");
  }, 180_000);
});
