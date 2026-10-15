/** Inter-labeler agreement (§8.1, T11). Pure. */
import { type EvalCase, type LabelSet, RISK_CLASSES, type RiskClass } from "./case-schema.js";

export function cohenKappa<T extends string>(
  a: readonly T[],
  b: readonly T[],
  categories: readonly T[],
): number | null {
  const n = a.length;
  if (n === 0 || b.length !== n) return null;
  let agree = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) agree += 1;
  const po = agree / n;
  let pe = 0;
  for (const k of categories) {
    const pa = a.filter((x) => x === k).length / n;
    const pb = b.filter((x) => x === k).length / n;
    pe += pa * pb;
  }
  if (Math.abs(1 - pe) < 1e-12) return po === 1 ? 1 : null;
  return (po - pe) / (1 - pe);
}

/** Linear weights `|ord(a) - ord(b)| / 2`: trivial/sensitive counts twice trivial/logic. */
export function weightedKappa(a: readonly RiskClass[], b: readonly RiskClass[]): number | null {
  const n = a.length;
  if (n === 0 || b.length !== n) return null;
  const idx = (c: RiskClass) => RISK_CLASSES.indexOf(c);
  let observed = 0;
  let expected = 0;
  for (let i = 0; i < 3; i++) {
    const pa = a.filter((x) => idx(x) === i).length / n;
    for (let j = 0; j < 3; j++) {
      const w = Math.abs(i - j) / 2;
      const pb = b.filter((x) => idx(x) === j).length / n;
      const o = a.filter((x, t) => idx(x) === i && idx(b[t] as RiskClass) === j).length / n;
      observed += w * o;
      expected += w * pa * pb;
    }
  }
  if (expected === 0) return observed === 0 ? 1 : null;
  return 1 - observed / expected;
}

const round = (x: number | null): number | null => (x === null ? null : Math.round(x * 1e4) / 1e4);

export interface PairAgreement {
  a: string;
  b: string;
  n: number;
  risk: { agreement: number; kappa: number | null; weightedKappa: number | null };
  shouldFlag: { agreement: number; kappa: number | null };
  outOfScope: { decisions: number; agreement: number; kappa: number | null };
  disagreeing: string[];
}

export const MIN_SHARED_CASES = 5;

/** Each labeler's own sets (not the adjudication), pairs with at least 5 shared cases. */
export function computeAgreement(cases: readonly EvalCase[]): PairAgreement[] {
  const labelers = [...new Set(cases.flatMap((c) => c.labels.map((l) => l.labeler)))].sort();
  const out: PairAgreement[] = [];
  for (let i = 0; i < labelers.length; i++) {
    for (let j = i + 1; j < labelers.length; j++) {
      const a = labelers[i] as string;
      const b = labelers[j] as string;
      const shared: { c: EvalCase; la: LabelSet; lb: LabelSet }[] = [];
      for (const c of cases) {
        const la = c.labels.find((l) => l.labeler === a);
        const lb = c.labels.find((l) => l.labeler === b);
        if (la && lb) shared.push({ c, la, lb });
      }
      if (shared.length < MIN_SHARED_CASES) continue;
      const riskA = shared.map((s) => s.la.risk);
      const riskB = shared.map((s) => s.lb.risk);
      const flagA = shared.map((s) => String(s.la.shouldFlag));
      const flagB = shared.map((s) => String(s.lb.shouldFlag));
      const oosA: string[] = [];
      const oosB: string[] = [];
      const disagreeing: string[] = [];
      for (const s of shared) {
        let differs = s.la.risk !== s.lb.risk || s.la.shouldFlag !== s.lb.shouldFlag;
        for (const f of s.c.inputs.files) {
          const x = s.la.outOfScope.includes(f.path) ? "out" : "in";
          const y = s.lb.outOfScope.includes(f.path) ? "out" : "in";
          oosA.push(x);
          oosB.push(y);
          if (x !== y) differs = true;
        }
        if (differs) disagreeing.push(s.c.id);
      }
      const rate = (x: readonly string[], y: readonly string[]) =>
        x.length === 0 ? 1 : x.filter((v, t) => v === y[t]).length / x.length;
      out.push({
        a,
        b,
        n: shared.length,
        risk: {
          agreement: round(rate(riskA, riskB)) as number,
          kappa: round(cohenKappa(riskA, riskB, RISK_CLASSES)),
          weightedKappa: round(weightedKappa(riskA, riskB)),
        },
        shouldFlag: {
          agreement: round(rate(flagA, flagB)) as number,
          kappa: round(cohenKappa(flagA, flagB, ["true", "false"])),
        },
        outOfScope: {
          decisions: oosA.length,
          agreement: round(rate(oosA, oosB)) as number,
          kappa: round(cohenKappa(oosA, oosB, ["in", "out"])),
        },
        disagreeing: disagreeing.sort(),
      });
    }
  }
  return out;
}
