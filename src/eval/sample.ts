/** Stratified, seeded sampling (E12, T6). Pure. */
import {
  type ChangedFile,
  computeRiskFloor,
  DOCS_GLOBS,
  type FloorConfig,
  globMatcher,
  TEST_GLOBS,
} from "../modules/intent/index.js";

export type SizeStratum = "S" | "M" | "L" | "XL";
export type PathStratum = "sensitive" | "tests" | "docs" | "source";

export function sizeStratum(changedLines: number): SizeStratum {
  if (changedLines <= 50) return "S";
  if (changedLines <= 300) return "M";
  if (changedLines <= 1500) return "L";
  return "XL";
}

/** Rules R1 to R8: the path rules (R9 and later look at counts, patches or the listing). */
const PATH_RULES = new Set([
  "ci_config",
  "policy_file",
  "dependency_manifest",
  "infra",
  "auth_secrets",
  "migration",
  "configured_path",
  "test_deleted",
]);

export type StageFile = Pick<
  ChangedFile,
  "path" | "previousPath" | "status" | "additions" | "deletions"
>;

export function pathStratum(files: readonly StageFile[], config: FloorConfig): PathStratum {
  const listed: ChangedFile[] = files.map((f) => ({ ...f, patch: null }));
  const { reasons } = computeRiskFloor(
    {
      files: listed,
      pr: { additions: 0, deletions: 0, changedFiles: 0 },
      listingTruncated: false,
      tooLarge: false,
      partialPaths: [],
      untrustedTexts: [],
    },
    config,
  );
  if (reasons.some((r) => PATH_RULES.has(r.rule))) return "sensitive";
  if (files.length > 0) {
    const test = globMatcher(TEST_GLOBS);
    if (files.every((f) => test(f.path))) return "tests";
    const docs = globMatcher(DOCS_GLOBS);
    if (files.every((f) => docs(f.path))) return "docs";
  }
  return "source";
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/**
 * How many to take from each stratum: at least `minPer` (capped by its size) from every
 * non-empty one, the rest proportional to stratum size by largest remainder, never more than a
 * stratum holds. The result sums to `min(n, total)`.
 */
export function allocate(
  sizes: Readonly<Record<string, number>>,
  n: number,
  minPer: number,
): Record<string, number> {
  const keys = Object.keys(sizes)
    .filter((k) => (sizes[k] as number) > 0)
    .sort();
  const total = keys.reduce((s, k) => s + (sizes[k] as number), 0);
  const alloc: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  if (n >= total) {
    for (const k of keys) alloc[k] = sizes[k] as number;
    return alloc;
  }
  const base = Object.fromEntries(keys.map((k) => [k, Math.min(minPer, sizes[k] as number)]));
  const baseSum = keys.reduce((s, k) => s + (base[k] as number), 0);
  if (baseSum >= n) {
    // Not enough room for the minimum everywhere: rarest strata first, one at a time.
    const order = [...keys].sort(
      (a, b) => (sizes[a] as number) - (sizes[b] as number) || (a < b ? -1 : 1),
    );
    let left = n;
    while (left > 0) {
      let gave = false;
      for (const k of order) {
        if (left > 0 && (alloc[k] as number) < (base[k] as number)) {
          alloc[k] = (alloc[k] as number) + 1;
          left--;
          gave = true;
        }
      }
      if (!gave) break;
    }
    return alloc;
  }
  for (const k of keys) alloc[k] = base[k] as number;
  let rest = n - baseSum;
  while (rest > 0) {
    const open = keys.filter((k) => (alloc[k] as number) < (sizes[k] as number));
    if (open.length === 0) break;
    const openTotal = open.reduce((s, k) => s + (sizes[k] as number), 0);
    const quotas = open.map((k) => {
      const exact = (rest * (sizes[k] as number)) / openTotal;
      return { k, exact, floor: Math.floor(exact) };
    });
    let given = 0;
    for (const q of quotas) {
      const g = Math.min(q.floor, (sizes[q.k] as number) - (alloc[q.k] as number));
      alloc[q.k] = (alloc[q.k] as number) + g;
      given += g;
    }
    rest -= given;
    const byRemainder = [...quotas].sort(
      (a, b) =>
        b.exact - b.floor - (a.exact - a.floor) ||
        (sizes[b.k] as number) - (sizes[a.k] as number) ||
        (a.k < b.k ? -1 : 1),
    );
    for (const q of byRemainder) {
      if (rest <= 0) break;
      if ((alloc[q.k] as number) < (sizes[q.k] as number)) {
        alloc[q.k] = (alloc[q.k] as number) + 1;
        rest--;
      }
    }
  }
  return alloc;
}

export interface SampleCandidate {
  repository: string;
  prNumber: number;
  size: SizeStratum;
  path: PathStratum;
}

export const stratumKey = (c: Pick<SampleCandidate, "size" | "path">): string =>
  `${c.size}/${c.path}`;

const byPr = (a: SampleCandidate, b: SampleCandidate): number =>
  a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : a.prNumber - b.prNumber;

export function sample<T extends SampleCandidate>(
  candidates: readonly T[],
  o: { n: number; minPerStratum: number; seed: number },
): { picked: T[]; strata: Record<string, { size: number; picked: number }> } {
  const sorted = [...candidates].sort(byPr);
  const groups = new Map<string, T[]>();
  for (const c of sorted) {
    const k = stratumKey(c);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const sizes = Object.fromEntries([...groups].map(([k, v]) => [k, v.length]));
  const alloc = allocate(sizes, o.n, o.minPerStratum);
  const rand = mulberry32(o.seed);
  const picked: T[] = [];
  const strata: Record<string, { size: number; picked: number }> = {};
  for (const k of [...groups.keys()].sort()) {
    const members = groups.get(k) as T[];
    const take = alloc[k] ?? 0;
    picked.push(...shuffle(members, rand).slice(0, take));
    strata[k] = { size: members.length, picked: take };
  }
  return { picked: picked.sort(byPr), strata };
}
