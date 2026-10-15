/**
 * Glob semantics shared by the risk floor, `GRAFT_INTENT_SENSITIVE_PATHS` and `graft.yaml` (D2).
 *
 * The semantics are those of picomatch with `{ dot: true }` for the character set `validateGlob`
 * allows: `*` and `?` stay inside one path segment, `[abc]` and `[a-c]` are classes, a segment
 * that is exactly `**` matches zero or more whole segments, and `**` inside a longer segment acts
 * like `*`. A pattern without a slash is matched as `**` + `/` + pattern (any depth); a leading
 * slash is stripped (anchored at the repository root). Matching is case-insensitive by default
 * (tightening matches); pass `{ nocase: false }` for loosening ones.
 *
 * Why not picomatch's regular expressions: they backtrack, and a pull request author controls the
 * paths. This matcher never backtracks over the input, and its cost model is structural:
 *  - the matcher is a forward NFA over path segments: it keeps only the set of live pattern
 *    positions (`**` may stay or skip), stops as soon as the set is empty (an anchored prefix dies
 *    at the first mismatching segment) and accepts at once when a trailing `**` is reached; glob
 *    prefilters (required literal segments or runs, the literal tail) reject most pairs for a few
 *    units, so an ordinary glob costs O(1) per path and only a glob that really walks the path
 *    pays O(segments);
 *  - every inner step (one character comparison, one class test, one live position) costs exactly 1 work
 *    unit, because classes are compiled once into a table lookup with case folding already applied
 *    and each path is split and case-folded once per evaluation (cached in the `GlobBudget`);
 *    setup is charged in proportion to its size (one unit per path character, one per live position and segment);
 *  - a `GlobBudget` is shared by everything in one evaluation (policy and risk floor): a work
 *    budget in units, and nothing else bounds it (the number of glob x path pairs is only a statistic). When it is spent every later call
 *    answers `onLimit` (the strict side) and `exhausted` is set;
 *  - the budget is sized to run out well before any realistic wall clock, so results do not depend
 *    on machine load. The wall clock (checked on a shared counter) is only a guard against bugs.
 */

export function normalizeGlob(g: string): string {
  if (g.startsWith("/")) return g.slice(1);
  return g.includes("/") ? g : `**/${g}`;
}

export type PathMatcher = (path: string) => boolean;

/** Paths over these caps are never matched; the answer is `onLimit`. */
export const PATH_LIMITS = { chars: 1_024, segments: 128 } as const;
/** Work units one matcher call may spend (one glob list against one path). */
export const MATCH_FUEL = 200_000;
/**
 * Work units one job (risk floor + policy evaluation) may spend. Derived from the legal maximum
 * and from path depth (reviews 4 and 5), then given a margin of at least 1.5:
 *  - the spec allows 500 globs per file and 1,000 listed files; a rename is matched on `path` and
 *    `previousPath`: 500 x 1,000 x 2 = 1,000,000 glob x path pairs, plus the floor's fixed globs
 *    (about 264,000 pairs when the card is pending and the floor shares the job);
 *  - the forward matcher makes an ordinary glob cost O(1) per pair (anchored prefix dies at the
 *    first segment; prefilters reject floating globs), and O(segments) only when the glob really
 *    walks the path. Measured with an unlimited budget on 161 rules x 3 globs (1,244,000 pairs
 *    with the floor), 1,000 renames, depths 4 / 15 / 30 segments (paths up to about 900
 *    characters), pending and final cards (millions of units):
 *      shape                         depth 4   depth 15   depth 30
 *      anchored `areaN/partM/**`        6.1       6.5        6.7
 *      floating `**` + `/xN/` + `**`   5.1       5.5        5.7
 *      extension `**` + `/*.eN`         6.1       8.4        9.6
 *      name part `**` + `/*partN*` ..  6.1       8.4        9.6
 *      every glob matches (worst)    7.6/14.8    22.4/19.9  30.0/35.0
 *    The worst ordinary case is 35.0 M (all 483 globs match a 30-segment path, so every pair
 *    walks the path); 35.0 M x 1.7 = 60 M.
 *  - A hostile policy (class, class above code 255, literal that defeats the prefilters, mixed,
 *    `**` on 127-segment paths) exhausts 60 M in about 0.4 to 0.5 s per job, so this is also the
 *    worst-case time whatever the policy says.
 * The pair count is not capped: pairs cost at least a few units, so the units already bound them.
 */
export const EVALUATION_FUEL = 60_000_000;
/** A guard against bugs, never reached by the work budget: seconds of wall clock. */
export const EVALUATION_WALL_MS = 10_000;

let backstopHook: ((what: string) => void) | null = null;
/** Called (once per budget) if the wall-clock guard ever fires; the worker logs it. */
export function setGlobBackstopHook(fn: ((what: string) => void) | null): void {
  backstopHook = fn;
}

export const pathOverLimit = (path: string): boolean =>
  path.length > PATH_LIMITS.chars || path.split("/").length > PATH_LIMITS.segments;

interface Prepared {
  segs: string[];
  folded: string[] | null;
  foldedSet?: Set<string>;
  origSet?: Set<string>;
  path: string;
  foldedPath?: string;
}

/** One shared, deterministic work budget; create one per job and pass it to every matcher. */
export class GlobBudget {
  fuel: number;
  /** Glob x path comparisons made so far (a statistic; the fuel is the only work limit). */
  pairsUsed = 0;
  readonly deadline: number;
  /** True once the fuel, the pair cap or the guard ran out: later calls answer `onLimit` at once. */
  exhausted = false;
  /** True when some path was over the length caps and was answered with `onLimit`. */
  pathLimitHit = false;
  /** How many answers so far were `onLimit` because of a limit, not because of the facts. */
  limitHits = 0;
  /** Work units since the last wall-clock check (shared by all calls). */
  since = 0;
  readonly prepared = new Map<string, Prepared>();
  constructor(fuel: number = EVALUATION_FUEL, wallMs: number = EVALUATION_WALL_MS) {
    this.fuel = fuel;
    this.deadline = performance.now() + wallMs;
  }
}

export interface GlobOptions {
  /** Default true. */
  nocase?: boolean;
  /**
   * The answer for a path over the length caps, or for a call that exhausts its budget. Use `true`
   * where a match tightens (sensitive and require rules: "assume it matches") and `false`
   * (default) where a match loosens (approve rules, test or docs classification).
   */
  onLimit?: boolean;
  /** Shared across calls; see `GlobBudget`. */
  budget?: GlobBudget;
}

// ---------------------------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------------------------

const LIT = 0;
const ANY = 1;
const STAR = 2;
const SET = 3;

interface SetData {
  /** Membership of the code units 0..255, case folding already applied. */
  table: Uint8Array;
  ranges: [number, number][];
  nocase: boolean;
  /** Memo for code units above 255 (filled on demand, bounded). */
  more: Map<number, boolean>;
  /**
   * The class's source text (`[ab]`), folded when case-insensitive. picomatch compiles `[ab]` to
   * `(?:\[ab\]|[ab])`, so the text itself also matches there (D2); the matcher models it.
   */
  text: number[];
}

type Tok =
  | { k: typeof LIT; c: number }
  | { k: typeof ANY }
  | { k: typeof STAR }
  | { k: typeof SET; set: SetData };

type Part =
  | { globstar: true; zeroOk: boolean }
  | {
      globstar: false;
      toks: Tok[];
      minLen: number;
      hasStar: boolean;
      /** Holds a class: matched by the character-level NFA below. */
      hasSet: boolean;
      nodes: SegNode[];
      start: number;
    };

const canon = (ch: string): string => {
  const u = ch.toUpperCase();
  // Same rule as a case-insensitive RegExp without the `u` flag.
  if (u.length !== 1) return ch;
  if (ch.charCodeAt(0) >= 128 && u.charCodeAt(0) < 128) return ch;
  return u;
};
const foldString = (s: string): string => {
  let out = "";
  for (let i = 0; i < s.length; i++) out += canon(s[i] as string);
  return out;
};

/** The reference class test: the character, its lower and upper case, or its fold is in a range. */
function slowSetTest(ranges: readonly [number, number][], nocase: boolean, code: number): boolean {
  const inRanges = (c: number) => ranges.some(([lo, hi]) => c >= lo && c <= hi);
  if (inRanges(code)) return true;
  if (!nocase) return false;
  const ch = String.fromCharCode(code);
  const l = ch.toLowerCase();
  const u = ch.toUpperCase();
  return (
    (l.length === 1 && inRanges(l.charCodeAt(0))) ||
    (u.length === 1 && inRanges(u.charCodeAt(0))) ||
    inRanges(canon(ch).charCodeAt(0))
  );
}

function makeSet(ranges: [number, number][], nocase: boolean, text: string): SetData {
  const table = new Uint8Array(256);
  for (let c = 0; c < 256; c++) table[c] = slowSetTest(ranges, nocase, c) ? 1 : 0;
  // picomatch adds the literal alternative unless the body holds one of - * ? + . (probed).
  const codes: number[] = [];
  if (!/[-*?+.]/.test(text.slice(1, -1))) {
    for (const ch of text) codes.push((nocase ? canon(ch) : ch).charCodeAt(0));
  }
  return { table, ranges, nocase, more: new Map(), text: codes };
}

function parseSegment(seg: string, nocase: boolean): Part {
  if (seg === "**") return { globstar: true, zeroOk: true };
  const toks: Tok[] = [];
  const lit = (c: string): Tok => ({
    k: LIT,
    c: (nocase ? canon(c) : c).charCodeAt(0),
  });
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] as string;
    if (c === "*") {
      if (toks[toks.length - 1]?.k !== STAR) toks.push({ k: STAR });
    } else if (c === "?") {
      toks.push({ k: ANY });
    } else if (c === "[") {
      const end = seg.indexOf("]", i + 1);
      if (end < 0) {
        toks.push(lit(c));
        continue;
      }
      const body = seg.slice(i + 1, end);
      const ranges: [number, number][] = [];
      for (let j = 0; j < body.length; j++) {
        const lo = body.charCodeAt(j);
        if (body[j + 1] === "-" && j + 2 < body.length) {
          ranges.push([lo, body.charCodeAt(j + 2)]);
          j += 2;
        } else {
          ranges.push([lo, lo]);
        }
      }
      toks.push({ k: SET, set: makeSet(ranges, nocase, seg.slice(i, end + 1)) });
      i = end;
    } else {
      toks.push(lit(c));
    }
  }
  return makePart(toks);
}

/** A node of the character-level NFA of a part with classes. */
interface SegNode {
  k: number;
  c: number;
  set?: SetData;
  next: number;
  /** Alternative entry (a class's literal text), or -1. */
  alt: number;
}
const N_MATCH = 4;

function makePart(toks: Tok[]): Part {
  const hasSet = toks.some((t) => t.k === SET);
  const nodes: SegNode[] = [];
  let start = 0;
  if (hasSet) {
    nodes.push({ k: N_MATCH, c: 0, next: -1, alt: -1 });
    let entry = 0;
    for (let i = toks.length - 1; i >= 0; i--) {
      const t = toks[i] as Tok;
      if (t.k === SET) {
        let chain = entry;
        for (let q = t.set.text.length - 1; q >= 0; q--) {
          nodes.push({ k: LIT, c: t.set.text[q] as number, next: chain, alt: -1 });
          chain = nodes.length - 1;
        }
        nodes.push({
          k: SET,
          c: 0,
          set: t.set,
          next: entry,
          alt: t.set.text.length > 0 ? chain : -1,
        });
      } else if (t.k === LIT) {
        nodes.push({ k: LIT, c: t.c, next: entry, alt: -1 });
      } else {
        nodes.push({ k: t.k, c: 0, next: entry, alt: -1 });
      }
      entry = nodes.length - 1;
    }
    start = entry;
  }
  return {
    globstar: false,
    toks,
    minLen: toks.filter((t) => t.k !== STAR).length,
    hasStar: toks.some((t) => t.k === STAR),
    hasSet,
    nodes,
    start,
  };
}

interface Compiled {
  /**
   * The text picomatch compares the input with before it runs the regular expression:
   * `picomatch.test` sets `match = input === glob`, with `glob` the pattern as given (here the
   * normalized glob), case-sensitively and whatever `nocase` says (picomatch 4.0.7,
   * `lib/picomatch.js`). A path equal to it matches even when the compiled pattern would not read
   * the text that way (for example `./a`, whose leading `./` the compiled pattern drops).
   */
  exact: string;
  parts: Part[];
  nocase: boolean;
  /** Non-globstar parts: a path with fewer segments cannot match. */
  minSegs: number;
  /** Literal-only, star-free segments the path must contain (folded when nocase). */
  reqLits: string[];
  /** Literal runs (inside parts with stars) that must occur somewhere in the path. */
  reqRuns: string[];
  /** The literal tail the last path segment must end with (when the last part is not `**`). */
  suffix: string | null;
  /** The last part is `**`: once the live set reaches the end, everything after is accepted. */
  absorbing: boolean;
}

const litString = (toks: readonly Tok[]): string | null => {
  let out = "";
  for (const t of toks) {
    if (t.k !== LIT) return null;
    out += String.fromCharCode(t.c);
  }
  return out;
};

function compile(glob: string, nocase: boolean): Compiled {
  const parts: Part[] = [];
  let segs = normalizeGlob(glob).split("/");
  // picomatch drops a leading `./`.
  while (segs.length > 1 && segs[0] === ".") segs = segs.slice(1);
  for (const seg of segs) {
    const p = parseSegment(seg, nocase);
    // `**/**` is `**`.
    if (p.globstar && parts[parts.length - 1]?.globstar) continue;
    parts.push(p);
  }
  // picomatch quirk: a trailing `**` matches zero segments (`docs/**` matches `docs`) unless the
  // segment before it ends in a star (`*/**`, `a*/**` need at least one more segment). That case
  // becomes "any one segment, then `**`", so every `**` below may match zero segments.
  const last = parts[parts.length - 1];
  const before = parts[parts.length - 2];
  if (last?.globstar && before && !before.globstar) {
    const end = before.toks[before.toks.length - 1];
    if (end?.k === STAR) {
      parts.pop();
      parts.push(makePart([{ k: STAR }]));
      parts.push({ globstar: true, zeroOk: true });
    }
  }
  // Prefilters, computed once per glob.
  const reqLits: string[] = [];
  for (const p of parts) {
    if (!p.globstar && !p.hasStar) {
      const l = litString(p.toks);
      if (l !== null && !reqLits.includes(l)) reqLits.push(l);
    }
  }
  // The longest literal run of each part that has a star (`part3` of `*part3*`).
  const reqRuns: string[] = [];
  for (const p of parts) {
    if (p.globstar || !p.hasStar) continue;
    let best = "";
    let run = "";
    for (const t of p.toks) {
      if (t.k === LIT) {
        run += String.fromCharCode(t.c);
        if (run.length > best.length) best = run;
      } else run = "";
    }
    if (best.length >= 2 && !reqRuns.includes(best)) reqRuns.push(best);
  }
  let suffix: string | null = null;
  const tail = parts[parts.length - 1];
  if (tail && !tail.globstar) {
    let k = tail.toks.length;
    while (k > 0 && tail.toks[k - 1]?.k === LIT) k--;
    const run = litString(tail.toks.slice(k));
    if (run !== null && run.length > 0) suffix = run;
  }
  return {
    exact: normalizeGlob(glob),
    parts,
    nocase,
    minSegs: parts.filter((p) => !p.globstar).length,
    reqLits,
    reqRuns,
    suffix,
    absorbing: parts[parts.length - 1]?.globstar === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

class OutOfBudget extends Error {}

interface Call {
  /** Fuel of this call. */
  fuel: number;
  shared: GlobBudget | null;
}

function spend(b: Call, n: number): void {
  b.fuel -= n;
  if (b.fuel < 0) throw new OutOfBudget();
  const sh = b.shared;
  if (sh === null) return;
  sh.fuel -= n;
  sh.since += n;
  if (sh.fuel < 0) {
    sh.exhausted = true;
    throw new OutOfBudget();
  }
  if (sh.since >= 16_384) {
    sh.since = 0;
    if (performance.now() > sh.deadline) {
      sh.exhausted = true;
      backstopHook?.("wall clock");
      throw new OutOfBudget();
    }
  }
}

function prepare(path: string, b: Call): Prepared {
  const sh = b.shared;
  const hit = sh?.prepared.get(path);
  if (hit) return hit;
  spend(b, path.length + 1);
  const made: Prepared = { segs: path.split("/"), folded: null, path };
  if (sh && sh.prepared.size < 5_000) sh.prepared.set(path, made);
  return made;
}

function foldedOf(p: Prepared, b: Call): string[] {
  if (p.folded === null) {
    spend(b, p.segs.length + 1);
    p.folded = p.segs.map(foldString);
  }
  return p.folded;
}

export const MEMO_PER_CLASS = 4_096;
export const MEMO_TOTAL = 100_000;
let memoTotal = 0;
const memoOwners = new Set<SetData>();
function clearMemos(): void {
  for (const o of memoOwners) o.more.clear();
  memoOwners.clear();
  memoTotal = 0;
}
/** For tests: how many above-255 entries are memoised in all classes. */
export const memoEntries = (): number => memoTotal;

function inSet(set: SetData, code: number, b: Call): boolean {
  if (code < 256) return set.table[code] === 1;
  const known = set.more.get(code);
  if (known !== undefined) return known;
  // A miss is real work (up to four range scans), so it is charged: 4 units per range.
  spend(b, set.ranges.length * 4);
  const v = slowSetTest(set.ranges, set.nocase, code);
  if (set.more.size < MEMO_PER_CLASS) {
    // One global bound over every class of every cached matcher: when it is reached, all memos
    // are dropped together (a later miss simply pays its charge again).
    if (memoTotal >= MEMO_TOTAL) clearMemos();
    set.more.set(code, v);
    memoTotal++;
    memoOwners.add(set);
  }
  return v;
}

/**
 * Character-level NFA for a part with classes: a class is "one character in the set" or "the
 * class's own source text" (picomatch's `(?:\[ab\]|[ab])`). Only live positions are charged.
 */
function segMatchNfa(
  p: Extract<Part, { globstar: false }>,
  orig: string,
  folded: string,
  nocase: boolean,
  b: Call,
): boolean {
  const nodes = p.nodes;
  growSeg(nodes.length);
  const mark = segMark;
  const cmp = nocase ? folded : orig;
  let cur = segListA;
  let next = segListB;
  let curN = 0;
  let nextN = 0;
  const add = (n: number): void => {
    if (n < 0 || mark[n] === 1) return;
    mark[n] = 1;
    next[nextN++] = n;
    const nd = nodes[n] as SegNode;
    if (nd.k === STAR) add(nd.next);
    if (nd.alt >= 0) add(nd.alt);
  };
  try {
    add(p.start);
    for (let si = 0; si < orig.length; si++) {
      spend(b, 1);
      [cur, next] = [next, cur];
      curN = nextN;
      nextN = 0;
      for (let k = 0; k < curN; k++) mark[cur[k] as number] = 0;
      for (let k = 0; k < curN; k++) {
        spend(b, 1);
        const n = cur[k] as number;
        const nd = nodes[n] as SegNode;
        if (nd.k === LIT) {
          if (cmp.charCodeAt(si) === nd.c) add(nd.next);
        } else if (nd.k === ANY) {
          add(nd.next);
        } else if (nd.k === SET) {
          if (inSet(nd.set as SetData, orig.charCodeAt(si), b)) add(nd.next);
        } else if (nd.k === STAR) {
          add(n);
        }
      }
      if (nextN === 0) return false;
    }
    return mark[0] === 1;
  } finally {
    for (let k = 0; k < nextN; k++) mark[next[k] as number] = 0;
  }
}

/** Classic two-pointer wildcard match of one path segment (no classes); `*` stays in the segment. */
function segMatch(
  p: Extract<Part, { globstar: false }>,
  orig: string,
  folded: string,
  nocase: boolean,
  b: Call,
): boolean {
  const n = orig.length;
  const toks = p.toks;
  const m = toks.length;
  spend(b, 1);
  if (n < p.minLen) return false;
  if (p.hasSet) return segMatchNfa(p, orig, folded, nocase, b);
  if (!p.hasStar && n !== p.minLen) return false;
  const cmp = nocase ? folded : orig;
  let ti = 0;
  let si = 0;
  let starT = -1;
  let starS = 0;
  while (si < n) {
    spend(b, 1);
    const t = toks[ti];
    if (t !== undefined && t.k === STAR) {
      starT = ti;
      starS = si;
      ti++;
    } else if (
      t !== undefined &&
      (t.k === ANY ||
        (t.k === LIT ? cmp.charCodeAt(si) === t.c : inSet(t.set, orig.charCodeAt(si), b)))
    ) {
      ti++;
      si++;
    } else if (starT >= 0) {
      ti = starT + 1;
      starS++;
      si = starS;
    } else {
      return false;
    }
  }
  while (ti < m && toks[ti]?.k === STAR) ti++;
  return ti === m;
}

function segmentSet(p: Prepared, nocase: boolean, segs: string[], b: Call): Set<string> {
  const have = nocase ? p.foldedSet : p.origSet;
  if (have) return have;
  spend(b, segs.length);
  const made = new Set(segs);
  if (nocase) p.foldedSet = made;
  else p.origSet = made;
  return made;
}

function foldedPathOf(p: Prepared, foldedSegs: string[], b: Call): string {
  if (p.foldedPath !== undefined) return p.foldedPath;
  spend(b, p.path.length >> 4);
  p.foldedPath = foldedSegs.join("/");
  return p.foldedPath;
}

// Scratch for the two NFAs. They hold no counter: a "mark" is a 0/1 flag that is cleared again
// (in a `finally`) for every entry that was set, so nothing can wrap, go stale or leak between
// calls, even when a call stops on a spent budget. The arrays grow to the largest glob seen.
let partMark = new Uint8Array(256);
let partListA = new Int32Array(256);
let partListB = new Int32Array(256);
let segMark = new Uint8Array(512);
let segListA = new Int32Array(512);
let segListB = new Int32Array(512);

function growPart(n: number): void {
  if (n <= partMark.length) return;
  partMark = new Uint8Array(n);
  partListA = new Int32Array(n);
  partListB = new Int32Array(n);
}
function growSeg(n: number): void {
  if (n <= segMark.length) return;
  segMark = new Uint8Array(n);
  segListA = new Int32Array(n);
  segListB = new Int32Array(n);
}
/** For tests: no flag of either NFA is left set after a call. */
export const matcherScratchClean = (): boolean =>
  partMark.every((x) => x === 0) && segMark.every((x) => x === 0);

/**
 * Forward matching: the set of live pattern positions is advanced one path segment at a time and
 * matching stops as soon as it is empty (an anchored prefix dies at the first mismatching
 * segment) or the glob can only end in `**` (everything after is accepted). Only the work
 * actually done is charged: one unit per live position per segment, plus the segment match.
 */
function matchCompiled(
  c: Compiled,
  prep: Prepared,
  origSegs: string[],
  foldedSegs: string[],
  b: Call,
): boolean {
  const parts = c.parts;
  const P = parts.length;
  const S = origSegs.length;
  spend(b, 1);
  if (S < c.minSegs) return false;
  // Prefilters (a few units each): required literal segments and the literal tail.
  // Only for floating globs: an anchored glob dies at its first segment anyway, which is cheaper
  // than building the segment set.
  if (c.reqLits.length > 0 && parts[0]?.globstar) {
    const set = segmentSet(prep, c.nocase, c.nocase ? foldedSegs : origSegs, b);
    for (const l of c.reqLits) {
      spend(b, 1);
      if (!set.has(l)) return false;
    }
  }
  if (c.reqRuns.length > 0) {
    // One native substring search per run over the whole (folded) path; charged by length.
    const hay = c.nocase ? foldedPathOf(prep, foldedSegs, b) : prep.path;
    for (const r of c.reqRuns) {
      spend(b, 1 + (hay.length >> 5));
      if (!hay.includes(r)) return false;
    }
  }
  if (c.suffix !== null) {
    spend(b, 1);
    if (!(c.nocase ? foldedSegs : origSegs)[S - 1]?.endsWith(c.suffix)) return false;
  }
  // Live positions, deduplicated with flags; `add` also follows `**` taking zero segments.
  growPart(P + 1);
  const mark = partMark;
  let cur = partListA;
  let next = partListB;
  let curN = 0;
  let nextN = 0;
  const add = (state: number): void => {
    let st = state;
    for (;;) {
      if (mark[st] === 1) return;
      mark[st] = 1;
      next[nextN++] = st;
      if (st < P && parts[st]?.globstar) st++;
      else return;
    }
  };
  try {
    add(0);
    if (next[nextN - 1] === P && c.absorbing) return true;
    for (let j = 0; j < S; j++) {
      // Every iteration is charged, so units track time even when the live set is empty.
      spend(b, 1);
      [cur, next] = [next, cur];
      curN = nextN;
      nextN = 0;
      for (let k = 0; k < curN; k++) mark[cur[k] as number] = 0;
      for (let k = 0; k < curN; k++) {
        spend(b, 1);
        const i = cur[k] as number;
        if (i >= P) continue;
        const part = parts[i] as Part;
        if (part.globstar) {
          add(i);
        } else if (segMatch(part, origSegs[j] as string, foldedSegs[j] as string, c.nocase, b)) {
          add(i + 1);
        }
      }
      if (nextN === 0) return false;
      if (c.absorbing && mark[P] === 1) return true;
    }
    return mark[P] === 1;
  } finally {
    for (let k = 0; k < nextN; k++) mark[next[k] as number] = 0;
  }
}

type CoreMatcher = (path: string, shared: GlobBudget | null) => boolean;

function build(globs: readonly string[], nocase: boolean, onLimit: boolean): CoreMatcher {
  const compiled = globs.map((g) => compile(g, nocase));
  return (path, shared) => {
    const limited = (): boolean => {
      if (shared) shared.limitHits++;
      return onLimit;
    };
    if (shared?.exhausted) return limited();
    if (path.length > PATH_LIMITS.chars) {
      if (shared) shared.pathLimitHit = true;
      return limited();
    }
    const call: Call = { fuel: MATCH_FUEL, shared };
    try {
      const prep = prepare(path, call);
      if (prep.segs.length > PATH_LIMITS.segments) {
        if (shared) shared.pathLimitHit = true;
        return limited();
      }
      const folded = nocase ? foldedOf(prep, call) : prep.segs;
      for (const c of compiled) {
        if (shared) shared.pairsUsed++;
        spend(call, 2);
        // picomatch's `input === pattern` fast path: a string comparison costs one unit per
        // character compared (only equal lengths are compared character by character).
        spend(call, path.length === c.exact.length ? path.length : 1);
        if (path === c.exact) return true;
        if (matchCompiled(c, prep, prep.segs, folded, call)) return true;
      }
      return false;
    } catch (e) {
      if (e instanceof OutOfBudget) return limited();
      throw e;
    }
  };
}

const matcherCache = new Map<string, PathMatcher>();
const coreCache = new Map<string, CoreMatcher>();

export function globMatcher(globs: readonly string[], opts: GlobOptions = {}): PathMatcher {
  if (globs.length === 0) return () => false;
  const nocase = opts.nocase ?? true;
  const onLimit = opts.onLimit ?? false;
  const key = JSON.stringify([nocase, onLimit, globs]);
  let core = coreCache.get(key);
  if (!core) {
    core = build(globs, nocase, onLimit);
    if (coreCache.size > 200) {
      clearMemos();
      coreCache.clear();
      matcherCache.clear();
    }
    coreCache.set(key, core);
  }
  const shared = opts.budget ?? null;
  if (shared !== null) {
    const c = core;
    return (path) => c(path, shared);
  }
  let m = matcherCache.get(key);
  if (!m) {
    const c = core;
    m = (path) => c(path, null);
    matcherCache.set(key, m);
  }
  return m;
}
