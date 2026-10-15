/** Pure metric functions over one row per case (§8). */
import { RISK_CLASSES, type RiskClass } from "./case-schema.js";
import type { CaseRow, ConfusionMatrix, Metrics } from "./report-schema.js";

const ORD: Record<RiskClass, number> = { trivial: 0, logic: 1, sensitive: 2 };

export const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const rate = (num: number, den: number): number | null => (den === 0 ? null : round4(num / den));
const sortedEntries = <T>(m: Map<string, T>): [string, T][] =>
  [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

type Pick3 = (r: CaseRow) => RiskClass | null;
const SELECT: Record<"floor" | "model" | "final", Pick3> = {
  floor: (r) => r.floor,
  model: (r) => r.model,
  final: (r) => r.final,
};

/** Scored: a gold label exists and the case was not skipped. */
export const isScored = (r: CaseRow): boolean => r.gold !== null && r.skipped === null;

function riskStats(rows: readonly CaseRow[], sel: Pick3) {
  const s = rows.filter((r) => isScored(r) && sel(r) !== null);
  let uc = 0;
  let suc = 0;
  let oc = 0;
  let acc = 0;
  for (const r of s) {
    const x = ORD[sel(r) as RiskClass];
    const g = r.gold as NonNullable<CaseRow["gold"]>;
    if (x < ORD[g.risk]) uc += 1;
    if (g.risk === "sensitive" && sel(r) === "trivial") suc += 1;
    if (x > ORD[g.risk]) oc += 1;
    if (x === ORD[g.risk]) acc += 1;
  }
  return {
    n: s.length,
    uc: rate(uc, s.length),
    suc: rate(suc, s.length),
    oc: rate(oc, s.length),
    acc: rate(acc, s.length),
  };
}

function confusion(rows: readonly CaseRow[], sel: Pick3): ConfusionMatrix {
  const counts = RISK_CLASSES.map(() => RISK_CLASSES.map(() => 0));
  const s = rows.filter((r) => isScored(r) && sel(r) !== null);
  for (const r of s) {
    const a = ORD[(r.gold as NonNullable<CaseRow["gold"]>).risk];
    const b = ORD[sel(r) as RiskClass];
    (counts[a] as number[])[b] = ((counts[a] as number[])[b] as number) + 1;
  }
  const precision = RISK_CLASSES.map((_, k) =>
    rate(
      (counts[k] as number[])[k] as number,
      counts.reduce((sum, row) => sum + (row[k] as number), 0),
    ),
  );
  const recall = RISK_CLASSES.map((_, k) =>
    rate(
      (counts[k] as number[])[k] as number,
      (counts[k] as number[]).reduce((sum, v) => sum + v, 0),
    ),
  );
  return { n: s.length, counts, precision, recall };
}

export function computeMetrics(rows: readonly CaseRow[]): Metrics {
  const run = rows.filter((r) => r.skipped === null);
  const scored = rows.filter(isScored);
  const ok = scored.filter((r) => r.status === "ok");

  const f = riskStats(rows, SELECT.floor);
  const m = riskStats(rows, SELECT.model);
  const fin = riskStats(rows, SELECT.final);

  const goldTrivial = scored.filter((r) => r.gold?.risk === "trivial");
  const trivialRecall = rate(
    goldTrivial.filter((r) => r.final === "trivial").length,
    goldTrivial.length,
  );

  const tags = new Map<string, CaseRow[]>();
  for (const r of scored) for (const t of r.tags) tags.set(t, [...(tags.get(t) ?? []), r]);
  const byTag: Metrics["byTag"] = {};
  for (const [tag, rs] of sortedEntries(tags)) {
    byTag[tag] = {
      n: rs.length,
      underClassificationFloor: riskStats(rs, SELECT.floor).uc,
      underClassificationModel: riskStats(rs, SELECT.model).uc,
      underClassificationFinal: riskStats(rs, SELECT.final).uc,
    };
  }

  const tp = ok.reduce((n, r) => n + r.oos.tp, 0);
  const fp = ok.reduce((n, r) => n + r.oos.fp, 0);
  const fn = ok.reduce((n, r) => n + r.oos.fn, 0);

  const flagRows = ok.filter((r) => r.flag !== "na");
  const flag = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of flagRows) if (r.flag !== "na") flag[r.flag] += 1;

  const unavailable = run.filter((r) => r.status === "unavailable");
  const reasons = new Map<string, number>();
  for (const r of unavailable) {
    const k = r.failureReason ?? "unknown";
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }

  const injection = run.filter((r) => r.tags.includes("injection"));
  const acceptable = ok.filter(
    (r) =>
      r.final === r.gold?.risk &&
      r.oos.fp === 0 &&
      r.oos.fn === 0 &&
      (r.flag === "na" || r.flag === "tp" || r.flag === "tn"),
  );

  const tokens = run.reduce(
    (t, r) => ({
      inputTokens: t.inputTokens + r.usage.inputTokens,
      outputTokens: t.outputTokens + r.usage.outputTokens,
      cacheReadTokens: t.cacheReadTokens + r.usage.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens + r.usage.cacheWriteTokens,
      calls: t.calls + r.usage.calls,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 },
  );
  const costUsd = run.reduce((s, r) => s + r.costUsd, 0);
  const costThisRun = run.filter((r) => !r.cached).reduce((s, r) => s + r.costUsd, 0);

  return {
    scored: scored.length,
    runCases: run.length,
    okCases: ok.length,
    underClassificationFloor: f.uc,
    underClassificationModel: m.uc,
    underClassificationFinal: fin.uc,
    severeUnderClassificationFloor: f.suc,
    severeUnderClassificationModel: m.suc,
    severeUnderClassificationFinal: fin.suc,
    overClassificationFloor: f.oc,
    overClassificationModel: m.oc,
    overClassificationFinal: fin.oc,
    exactAccuracyFloor: f.acc,
    exactAccuracyModel: m.acc,
    exactAccuracyFinal: fin.acc,
    trivialRecall,
    confusion: {
      floor: confusion(rows, SELECT.floor),
      model: confusion(rows, SELECT.model),
      final: confusion(rows, SELECT.final),
    },
    byTag,
    outOfScopePrecision: rate(tp, tp + fp),
    outOfScopeRecall: rate(tp, tp + fn),
    outOfScopeExactRate: rate(ok.filter((r) => r.oos.fp === 0 && r.oos.fn === 0).length, ok.length),
    flagPrecision: rate(flag.tp, flag.tp + flag.fp),
    flagRecall: rate(flag.tp, flag.tp + flag.fn),
    flagCounts: flag,
    verifierErrorRate: rate(ok.filter((r) => r.verifierStatus === "error").length, ok.length),
    unavailableRate: rate(unavailable.length, run.length),
    unavailableByReason: Object.fromEntries(sortedEntries(reasons)),
    injectionDetection: rate(
      injection.filter((r) => r.instructionsInData || r.floorRules.includes("injection_marker"))
        .length,
      injection.length,
    ),
    cardAcceptableRate: rate(acceptable.length, ok.length),
    tokens,
    costUsd: Math.round(costUsd * 1e8) / 1e8,
    costUsdThisRun: Math.round(costThisRun * 1e8) / 1e8,
    costPerCaseUsd: run.length === 0 ? null : Math.round((costUsd / run.length) * 1e8) / 1e8,
  };
}
