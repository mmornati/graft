import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EvalCase } from "../../src/eval/case-schema.js";
import { generateKey, parseKey } from "../../src/eval/crypto.js";
import {
  type Estimate,
  EvalConfigError,
  type RunOptions,
  runEval,
} from "../../src/eval/harness.js";
import {
  type CaseSet,
  createSet,
  EvalCaseError,
  readCase,
  writeCase,
} from "../../src/eval/store.js";
import { createFakeLlm, forbiddenLlm } from "../../src/llm/fake.js";
import type { LlmClient } from "../../src/llm/types.js";
import {
  cardInputs,
  cf,
  cleanupTmpDirs,
  labelSet,
  pilotCase,
  REPO_ROOT,
  synCase,
  tmpDir,
  writerJson,
} from "../helpers/eval-fixtures.js";

cleanupTmpDirs();
const NOW = new Date("2026-10-20T09:00:00Z");
const MODELS = { fast: "claude-haiku-5-5", strong: "claude-sonnet-5-5" };

async function plainSet(cases: EvalCase[]): Promise<CaseSet> {
  const root = await tmpDir();
  const set = await createSet(
    path.join(root, "synthetic"),
    {
      setId: "synthetic",
      kind: "synthetic",
      description: "t",
      encrypted: false,
      consentRef: null,
      defaultFloorConfig: { extraSensitiveGlobs: [] },
    },
    { key: null, now: NOW },
  );
  for (const c of cases) await writeCase(set, c);
  return set;
}

function opts(set: CaseSet, over: Partial<RunOptions> = {}): RunOptions {
  return {
    set,
    mode: "fake",
    models: MODELS,
    timeoutMs: 120_000,
    concurrency: 4,
    maxCostUsd: 10,
    maxTokens: 5_000_000,
    useCache: true,
    confirm: async () => true,
    now: () => NOW,
    nowMs: () => NOW.getTime(),
    ...over,
  };
}

const named = (n: number, over: Partial<EvalCase> = {}, files = [cf("src/a.ts")]): EvalCase =>
  synCase(`syn-${String(n).padStart(3, "0")}-c`, {
    inputs: cardInputs(files, {
      pr: {
        number: 100 + n,
        title: `PR ${n}`,
        body: "",
        additions: 3,
        deletions: 1,
        changedFiles: files.length,
      },
    }),
    ...over,
  });

const liveReply = (json = writerJson().json, usage?: Record<string, number>) => ({
  json,
  ...(usage ? { usage } : {}),
});
const AGREE = "agree" as const;

/** A live fake client: every purpose answers with the same writer or an agreeing verifier. */
function liveClient(writerUsage?: Record<string, number>) {
  return createFakeLlm((req) => {
    if (req.purpose === "verifier") {
      const m =
        /<untrusted_data_[0-9a-f]+ kind="intent_card">\n([\s\S]*?)\n<\/untrusted_data_/.exec(
          req.user,
        );
      const card = JSON.parse(m?.[1] ?? '{"claims":[]}') as { claims: { id: string }[] };
      return {
        json: {
          claims: card.claims.map((c) => ({ id: c.id, verdict: "supported", reason: "ok" })),
          missing_behavior_changes: [],
          unexplained_files: [],
          risk_class: "trivial",
          risk_reason: "ok",
          instructions_in_data: false,
        },
      };
    }
    return liveReply(undefined, writerUsage);
  });
}

const toReply = (r: Awaited<ReturnType<LlmClient["complete"]>>) => {
  if (!r.ok) throw new Error("unexpected failure");
  return { json: r.value, usage: r.usage };
};

describe("eval harness", () => {
  it("U-HAR-1 fake mode never calls the injected client, never asks to confirm and never touches cache/", async () => {
    const set = await plainSet([named(1), named(2)]);
    const forbidden = forbiddenLlm();
    let confirmed = 0;
    const out = await runEval(
      opts(set, { llm: forbidden, confirm: async () => void confirmed++ as never }),
    );
    expect(out.aborted).toBe(false);
    expect(forbidden.calls).toHaveLength(0);
    expect(confirmed).toBe(0);
    await expect(fs.stat(path.join(set.dir, "cache"))).rejects.toThrow();
    if (!out.aborted) {
      expect(out.report.llm).toBe("fake");
      expect(out.report.metrics.scored).toBe(2);
    }
  });

  it("U-HAR-2 live mode asks once with the estimate; declining aborts without a call", async () => {
    const set = await plainSet([named(1), named(2), named(3)]);
    const client = liveClient();
    const confirm = vi.fn(async () => false);
    const out = await runEval(opts(set, { mode: "live", llm: client, confirm }));
    expect(out).toMatchObject({ aborted: true, reason: "declined" });
    expect(confirm).toHaveBeenCalledTimes(1);
    const estimate = (confirm.mock.calls as unknown as [Estimate][])[0]?.[0];
    expect(estimate).toMatchObject({ casesToCall: 3, casesCached: 0 });
    expect(estimate?.upperBoundUsd).toBeGreaterThan(0);
    expect(client.calls).toHaveLength(0);

    const ok = await runEval(opts(set, { mode: "live", llm: client, confirm: async () => true }));
    expect(ok.aborted).toBe(false);
    expect(client.calls.length).toBeGreaterThan(0);
  });

  it("U-HAR-3 an estimate over maxCostUsd aborts before the confirmation and before any call", async () => {
    const set = await plainSet([named(1), named(2)]);
    const client = liveClient();
    const confirm = vi.fn(async () => true);
    const out = await runEval(opts(set, { mode: "live", llm: client, confirm, maxCostUsd: 0.01 }));
    expect(out).toMatchObject({ aborted: true, reason: "over_budget" });
    expect(confirm).not.toHaveBeenCalled();
    expect(client.calls).toHaveLength(0);
    // a configured model without a price is refused up front
    await expect(
      runEval(
        opts(set, {
          mode: "live",
          llm: client,
          models: { fast: "claude-haiku-5-5", strong: "claude-mystery-1" },
        }),
      ),
    ).rejects.toBeInstanceOf(EvalConfigError);
  });

  it("U-HAR-4 the budget during the run: two of five cases run, three are skipped and the run is incomplete", async () => {
    const files = [cf("src/a.ts"), cf("package.json")]; // a sensitive floor: strong writer, no escalation
    const set = await plainSet([1, 2, 3, 4, 5].map((n) => named(n, {}, files)));
    // each writer call really costs about $0.80, far above its estimate
    const client = liveClient({ inputTokens: 400_000 });
    const out = await runEval(
      opts(set, { mode: "live", llm: client, concurrency: 1, maxCostUsd: 1.0 }),
    );
    if (out.aborted) throw new Error(`aborted: ${out.reason}`);
    const r = out.report;
    expect(r.cases.filter((c) => c.skipped === "budget")).toHaveLength(3);
    expect(r.cases.filter((c) => c.skipped === null)).toHaveLength(2);
    expect(r.run).toMatchObject({ complete: false, skippedBudget: 3 });
    expect(r.metrics.scored).toBe(2);
    expect(r.metrics.runCases).toBe(2);
  });

  it("U-HAR-11 in-flight cases reserve their estimate: concurrency cannot overshoot the budget", async () => {
    const files = [cf("src/a.ts"), cf("package.json")];
    const usage = { inputTokens: 400_000 };
    // Probe: what one case really costs, and what one estimate is.
    const probeSet = await plainSet([named(2, {}, files)]);
    const probe = await runEval(opts(probeSet, { mode: "live", llm: liveClient(usage) }));
    if (probe.aborted) throw new Error("probe aborted");
    const spent = probe.report.cases[0]?.costUsd ?? 0;
    const three = await plainSet([1, 2, 3].map((n) => named(n, {}, files)));
    let estimate: Estimate | undefined;
    await runEval(
      opts(three, {
        mode: "live",
        llm: liveClient(),
        maxCostUsd: 1000,
        confirm: async (e) => {
          estimate = e;
          return false;
        },
      }),
    );
    const one = (estimate?.upperBoundUsd ?? 0) / 3;
    // spent + one estimate fits, spent + two estimates does not, and three estimates fit up front.
    const cap = spent + 1.5 * one;
    expect(cap).toBeGreaterThanOrEqual(3 * one);

    // Case 1 is held open while case 2 finishes; case 3 then meets "spent + reserved + estimate".
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const inner = liveClient(usage);
    const client = createFakeLlm(async (req) => {
      if (req.purpose !== "verifier" && req.user.includes("PR 1")) await held;
      return inner.complete(req).then((r) => {
        if (!r.ok) throw new Error("unexpected failure");
        return { json: r.value, usage: r.usage };
      });
    });
    const out = await runEval(
      opts(three, {
        mode: "live",
        llm: client,
        concurrency: 2,
        maxCostUsd: cap,
        progress: (line) => {
          if (line.startsWith("syn-003")) release();
        },
      }),
    );
    if (out.aborted) throw new Error(`aborted: ${out.reason}`);
    const byId = Object.fromEntries(out.report.cases.map((c) => [c.id, c.skipped]));
    expect(byId).toEqual({ "syn-001-c": null, "syn-002-c": null, "syn-003-c": "budget" });
  });

  it("U-HAR-12 after an unexpected error no worker starts another case", async () => {
    const set = await plainSet([1, 2, 3, 4, 5, 6, 7, 8].map((n) => named(n)));
    const started = new Set<string>();
    const inner = liveClient();
    const client = createFakeLlm(async (req) => {
      if (req.purpose === "verifier") return inner.complete(req).then(toReply);
      started.add(req.user.match(/PR \d/)?.[0] ?? "?");
      if (started.size === 1) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 20));
      return inner.complete(req).then(toReply);
    });
    const err = await runEval(opts(set, { mode: "live", llm: client, concurrency: 2 })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EvalCaseError);
    await new Promise((r) => setTimeout(r, 300));
    expect(started.size).toBeLessThanOrEqual(2);
  });

  it("U-HAR-13 an unexpected error never carries its message for a pilot set or in live mode", async () => {
    const SECRET = "pilot-secret-label-text";
    const pilotRoot = await tmpDir();
    const key = parseKey(generateKey());
    const set = await createSet(
      path.join(pilotRoot, "pilot-acme"),
      {
        setId: "pilot-acme",
        kind: "pilot",
        description: "t",
        encrypted: true,
        consentRef: "T-1",
        defaultFloorConfig: { extraSensitiveGlobs: [] },
      },
      { key, now: NOW },
    );
    await writeCase(set, pilotCase("pilot-acme", 1));
    const client = createFakeLlm(() => {
      throw new Error(SECRET);
    });
    const err = (await runEval(opts(set, { mode: "live", llm: client })).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(EvalCaseError);
    expect(err.message).not.toContain(SECRET);
  });

  it("U-HAR-5 the cache: a second run makes no call; one edited patch re-runs one case; useCache false re-runs all", async () => {
    const set = await plainSet([named(1), named(2), named(3)]);
    const client = liveClient();
    const first = await runEval(opts(set, { mode: "live", llm: client }));
    if (first.aborted) throw new Error("aborted");
    const calls = client.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(first.report.run.cachedResults).toBe(0);

    const second = await runEval(opts(set, { mode: "live", llm: client }));
    if (second.aborted) throw new Error("aborted");
    expect(client.calls).toHaveLength(calls);
    expect(second.report.cases.every((c) => c.cached)).toBe(true);
    expect(second.report.run.cachedResults).toBe(3);
    expect(second.report.metrics.costUsdThisRun).toBe(0);
    expect(second.report.metrics.costUsd).toBe(first.report.metrics.costUsd);

    const edited = named(2, {}, [cf("src/a.ts", { patch: "@@ -1 +1 @@\n-x\n+an edited line" })]);
    await writeCase(set, edited);
    const perCase = calls / 3;
    const third = await runEval(opts(set, { mode: "live", llm: client }));
    if (third.aborted) throw new Error("aborted");
    expect(client.calls).toHaveLength(calls + perCase);
    expect(third.report.cases.filter((c) => !c.cached).map((c) => c.id)).toEqual([edited.id]);

    const before = client.calls.length;
    await runEval(opts(set, { mode: "live", llm: client, useCache: false }));
    expect(client.calls).toHaveLength(before + calls);
  });

  it("U-HAR-6 a retryable unavailable result is not cached, a too_large one is", async () => {
    const big = named(2, {}, []);
    big.inputs = {
      ...big.inputs,
      tooLarge: true,
      listingTruncated: true,
      pr: { ...big.inputs.pr, additions: 18000, deletions: 7000, changedFiles: 40 },
    };
    const set = await plainSet([named(1), big]);
    const client = createFakeLlm(() => ({ failure: "rate_limited" }));
    const out = await runEval(opts(set, { mode: "live", llm: client }));
    if (out.aborted) throw new Error("aborted");
    expect(out.report.cases.map((c) => [c.id, c.failureReason])).toEqual([
      [named(1).id, "llm_rate_limited"],
      [big.id, "too_large"],
    ]);
    expect(await fs.readdir(path.join(set.dir, "cache"))).toHaveLength(1);
    const again = await runEval(opts(set, { mode: "live", llm: client }));
    if (again.aborted) throw new Error("aborted");
    expect(again.report.cases.map((c) => c.cached)).toEqual([false, true]);
  });

  it("U-HAR-7 never more cases in flight than the concurrency", async () => {
    const set = await plainSet([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => named(n)));
    let inFlight = 0;
    let peak = 0;
    const gated = createFakeLlm(async (req) => {
      if (req.purpose === "writer" || req.purpose === "writer_escalated") {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return liveReply();
      }
      const m =
        /<untrusted_data_[0-9a-f]+ kind="intent_card">\n([\s\S]*?)\n<\/untrusted_data_/.exec(
          req.user,
        );
      const card = JSON.parse(m?.[1] ?? "{}") as { claims: { id: string }[] };
      return {
        json: {
          claims: card.claims.map((c) => ({ id: c.id, verdict: "supported", reason: "ok" })),
          missing_behavior_changes: [],
          unexplained_files: [],
          risk_class: "trivial",
          risk_reason: "ok",
          instructions_in_data: false,
        },
      };
    });
    const out = await runEval(opts(set, { mode: "live", llm: gated, concurrency: 3 }));
    expect(out.aborted).toBe(false);
    expect(peak).toBe(3);
  });

  it("U-HAR-8 each call is priced by its own model: fast writer, strong escalation and strong verifier", async () => {
    const writerLogic = writerJson({ risk_class: "logic" });
    const set = await plainSet([
      named(1, { fakeLlm: { writer: writerLogic, writerEscalated: writerLogic, verifier: AGREE } }),
    ]);
    const out = await runEval(opts(set));
    if (out.aborted) throw new Error("aborted");
    const row = out.report.cases[0];
    // 1000 in / 100 out per call: Haiku once, Sonnet twice
    const haiku = (1000 * 0.1 + 100 * 0.5) / 1e6;
    const sonnet = (1000 * 2 + 100 * 10) / 1e6;
    expect(row?.usage.calls).toBe(3);
    expect(row?.costUsd).toBeCloseTo(haiku + 2 * sonnet, 9);
    expect(row?.final).toBe("logic");
  });

  it("U-HAR-9 a case that fails validation aborts with its id before any call", async () => {
    const set = await plainSet([named(1)]);
    await fs.writeFile(
      path.join(set.dir, "cases/syn-002-bad.case.json"),
      JSON.stringify({ schemaVersion: 1, id: "syn-002-bad" }),
    );
    const forbidden = forbiddenLlm();
    const err = await runEval(opts(set, { llm: forbidden })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalCaseError);
    expect((err as EvalCaseError).caseId).toBe("syn-002-bad");
    expect(forbidden.calls).toHaveLength(0);
  });

  it("U-HAR-10 the case floorConfig reaches the floor (syn-011 is trivial without its glob)", async () => {
    const real = JSON.parse(
      await fs.readFile(
        path.join(REPO_ROOT, "eval/synthetic/cases/syn-011-configured-path.case.json"),
        "utf8",
      ),
    ) as EvalCase;
    const withGlob = await plainSet([real]);
    const w = real.fakeLlm?.writer;
    const without = await plainSet([
      {
        ...real,
        floorConfig: { extraSensitiveGlobs: [] },
        fakeLlm: { writer: w, writerEscalated: w, verifier: AGREE },
      },
    ]);
    const a = await runEval(opts(withGlob));
    const b = await runEval(opts(without));
    if (a.aborted || b.aborted) throw new Error("aborted");
    expect(a.report.cases[0]?.floor).toBe("sensitive");
    expect(a.report.cases[0]?.floorRules).toEqual(["configured_path"]);
    expect(b.report.cases[0]?.floor).toBe("trivial");
  });

  it("an unexpected exception in a case aborts the run with the case id", async () => {
    const set = await plainSet([named(1, { fakeLlm: {} })]);
    const err = await runEval(opts(set)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalCaseError);
    expect((err as EvalCaseError).caseId).toBe(named(1).id);
  });

  it("U-RPT-6 a pilot-set report holds no path, title, body or goal of its cases", async () => {
    const root = await tmpDir();
    const set = await createSet(
      path.join(root, "pilot-a"),
      {
        setId: "pilot-a",
        kind: "pilot",
        description: "",
        encrypted: true,
        consentRef: "x",
        defaultFloorConfig: { extraSensitiveGlobs: [] },
      },
      { key: parseKey(generateKey()), now: NOW },
    );
    const secrets = [
      "DISTINCT_PATH_QQ/engine.ts",
      "DISTINCT TITLE ZZ",
      "DISTINCT BODY WW",
      "DISTINCT GOAL XX",
      "DISTINCT_PREV_PATH.ts",
    ];
    for (let n = 1; n <= 3; n++) {
      const inputs = cardInputs(
        [cf(`${secrets[0]}${n}`, { previousPath: n === 2 ? (secrets[4] ?? null) : null })],
        {
          pr: {
            number: n,
            title: `${secrets[1]} ${n}`,
            body: `${secrets[2]} ${n}`,
            additions: 2,
            deletions: 1,
            changedFiles: 1,
          },
        },
      );
      await writeCase(
        set,
        pilotCase(
          "pilot-a",
          n,
          {
            labels: [labelSet({ goal: `${secrets[3]} ${n}`, risk: n === 1 ? "trivial" : "logic" })],
          },
          inputs,
        ),
      );
    }
    const out = await runEval(opts(set));
    if (out.aborted) throw new Error("aborted");
    const text = JSON.stringify(out.report);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(out.report.set).toMatchObject({ setId: "pilot-a", kind: "pilot", scored: 3 });
    // and the sealed cases still read back
    expect((await readCase(set, "pilot-a--shop-1")).inputs.pr.title).toContain(
      secrets[1] as string,
    );
  });
});
