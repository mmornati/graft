/**
 * The revert plan (Phase 1 step 5, §6, D5–D9, D14). Pure: the only I/O is the `TreeReader` the
 * caller passes, which reads Git Data tree and commit objects (names, modes, SHAs), never content.
 * No database, GitHub or module import.
 *
 * A revert restores, at the default branch tip, the entry every path the culprit changed had
 * before it. That is exact only when the tip still has the culprit's entry for every such path
 * (D7): then restoring `before` gives the pre-culprit state of those paths and leaves every other
 * path of the tip alone.
 */
import type { RiskClass } from "../policy/schema.js";

export interface Entry {
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

export interface TreeReader {
  commit(sha: string): Promise<{ tree: string; parents: string[] }>;
  tree(sha: string): Promise<{ entries: { name: string; entry: Entry }[]; truncated: boolean }>;
}

export interface Change {
  path: string;
  before: Entry | null;
  after: Entry | null;
}

export type NeedsHumanReason =
  | "touched_later"
  | "workflow_files"
  | "submodule"
  | "type_change"
  | "too_large"
  | "history_incomplete";

export interface NeedsHuman {
  kind: "needs_human";
  reason: NeedsHumanReason;
  /** The paths behind the reason (the conflicting paths for `touched_later`). */
  conflicts: string[];
}

export type Plan =
  | { kind: "revert"; changes: Change[]; touchesPolicyFile: boolean }
  | NeedsHuman
  | { kind: "skipped"; reason: "already_reverted" };

export interface Limits {
  /** D8: more changes than this is `too_large`. */
  maxPaths: number;
  /** D8: more distinct tree objects read than this is `too_large`. */
  maxTreeReads: number;
}

/**
 * Thrown by a reader (or the budget wrapper below) when a plan needs more tree reads than its
 * budget; `planRevert` turns it into `needs_human` / `too_large`.
 */
export class TreeReadBudgetExceeded extends Error {
  constructor() {
    super("tree read budget exceeded");
    this.name = "TreeReadBudgetExceeded";
  }
}

const needsHuman = (reason: NeedsHumanReason, conflicts: string[] = []): NeedsHuman => ({
  kind: "needs_human",
  reason,
  conflicts,
});

export const sameEntry = (a: Entry | null, b: Entry | null): boolean =>
  a === null || b === null ? a === b : a.mode === b.mode && a.type === b.type && a.sha === b.sha;

/** A name the tree API can never return on real GitHub, and that must not reach a tree write. */
const badName = (name: string): boolean =>
  name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\u0000");

/**
 * Wraps a reader: tree objects are read once (memoised) and at most `max` distinct trees are read.
 * Commits are memoised too and do not count.
 */
export function budgetedReader(r: TreeReader, max: number): TreeReader & { treeReads(): number } {
  const trees = new Map<string, ReturnType<TreeReader["tree"]>>();
  const commits = new Map<string, ReturnType<TreeReader["commit"]>>();
  return {
    treeReads: () => trees.size,
    commit(sha) {
      let hit = commits.get(sha);
      if (!hit) {
        hit = r.commit(sha);
        commits.set(sha, hit);
      }
      return hit;
    },
    tree(sha) {
      let hit = trees.get(sha);
      if (!hit) {
        if (trees.size >= max) return Promise.reject(new TreeReadBudgetExceeded());
        hit = r.tree(sha);
        trees.set(sha, hit);
      }
      return hit;
    },
  };
}

type TreeMap = Map<string, Entry>;

async function readTree(r: TreeReader, sha: string): Promise<TreeMap | NeedsHuman> {
  const t = await r.tree(sha);
  if (t.truncated) return needsHuman("too_large");
  const out: TreeMap = new Map();
  for (const { name, entry } of t.entries) {
    if (badName(name) || out.has(name)) return needsHuman("too_large");
    out.set(name, entry);
  }
  return out;
}

/**
 * D6: one change per path whose entry differs between the two trees. Only subtrees whose SHAs
 * differ are read; a directory added or deleted whole is one change on its entry.
 */
export async function diffTrees(
  r: TreeReader,
  baseTree: string,
  headTree: string,
  limits: Limits,
): Promise<Change[] | NeedsHuman> {
  const changes: Change[] = [];
  const walk = async (prefix: string, a: string, b: string): Promise<NeedsHuman | null> => {
    if (a === b) return null;
    const ta = await readTree(r, a);
    if (!(ta instanceof Map)) return ta;
    const tb = await readTree(r, b);
    if (!(tb instanceof Map)) return tb;
    const names = [...new Set([...ta.keys(), ...tb.keys()])].sort();
    for (const name of names) {
      const before = ta.get(name) ?? null;
      const after = tb.get(name) ?? null;
      if (sameEntry(before, after)) continue;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (before?.type === "tree" && after?.type === "tree") {
        const inner = await walk(path, before.sha, after.sha);
        if (inner) return inner;
        continue;
      }
      changes.push({ path, before, after });
      if (changes.length > limits.maxPaths) return needsHuman("too_large");
    }
    return null;
  };
  try {
    const stop = await walk("", baseTree, headTree);
    if (stop) return stop;
  } catch (err) {
    if (err instanceof TreeReadBudgetExceeded) return needsHuman("too_large");
    throw err;
  }
  return changes;
}

const WORKFLOWS = ".github/workflows";

/** D8: a change under `.github/workflows/`, or a directory that contains it. */
function touchesWorkflows(c: Change): boolean {
  if (c.path === WORKFLOWS || c.path.startsWith(`${WORKFLOWS}/`)) return true;
  const isTree = c.before?.type === "tree" || c.after?.type === "tree";
  return isTree && WORKFLOWS.startsWith(`${c.path}/`);
}

const isSubmodule = (e: Entry | null): boolean =>
  e !== null && (e.type === "commit" || e.mode === "160000");

/** D8, checked before any write. The first reason (in this order) wins; its paths are listed. */
export function notRevertible(changes: readonly Change[]): NeedsHuman | null {
  const rules: [NeedsHumanReason, (c: Change) => boolean][] = [
    ["workflow_files", touchesWorkflows],
    ["submodule", (c) => isSubmodule(c.before) || isSubmodule(c.after)],
    [
      "type_change",
      (c) =>
        c.before !== null &&
        c.after !== null &&
        (c.before.type === "tree") !== (c.after.type === "tree"),
    ],
  ];
  for (const [reason, hit] of rules) {
    const paths = changes.filter(hit).map((c) => c.path);
    if (paths.length > 0) return needsHuman(reason, paths);
  }
  return null;
}

/** The entry at `path` under `treeSha` (null when a segment is missing or not a directory). */
export async function entryAt(r: TreeReader, treeSha: string, path: string): Promise<Entry | null> {
  const segments = path.split("/");
  let cur = treeSha;
  for (let i = 0; i < segments.length; i++) {
    const t = await r.tree(cur);
    if (t.truncated) throw new TreeReadBudgetExceeded();
    const hit = t.entries.find((e) => e.name === segments[i])?.entry ?? null;
    if (hit === null || i === segments.length - 1) return hit;
    if (hit.type !== "tree") return null;
    cur = hit.sha;
  }
  return null;
}

/** Whether a change path is a policy file, or a directory holding one. */
function touchesPolicy(changes: readonly Change[], policyPaths: readonly string[]): boolean {
  return changes.some((c) => policyPaths.some((p) => p === c.path || p.startsWith(`${c.path}/`)));
}

/**
 * §6: the D6 diff (and its `too_large`), D8 per change, the D7 tip lookups, then
 * `already_reverted`. `policyPaths` are the files the policy loader reads.
 */
export async function planRevert(
  reader: TreeReader,
  i: { baseTree: string; headTree: string; tipTree: string; policyPaths: readonly string[] },
  limits: Limits,
): Promise<Plan> {
  const r = budgetedReader(reader, limits.maxTreeReads);
  const changes = await diffTrees(r, i.baseTree, i.headTree, limits);
  if (!Array.isArray(changes)) return changes;
  // An empty diff (the culprit changed nothing): there is nothing to restore.
  if (changes.length === 0) return { kind: "skipped", reason: "already_reverted" };
  const blocked = notRevertible(changes);
  if (blocked) return blocked;
  let atTip: (Entry | null)[];
  try {
    atTip = [];
    for (const c of changes) atTip.push(await entryAt(r, i.tipTree, c.path));
  } catch (err) {
    if (err instanceof TreeReadBudgetExceeded) return needsHuman("too_large");
    throw err;
  }
  // D7: every path already back to its pre-culprit entry: nothing to revert.
  if (changes.every((c, k) => sameEntry(atTip[k] ?? null, c.before))) {
    return { kind: "skipped", reason: "already_reverted" };
  }
  const conflicts = changes
    .filter((c, k) => !sameEntry(atTip[k] ?? null, c.after))
    .map((c) => c.path);
  if (conflicts.length > 0) return needsHuman("touched_later", conflicts);
  return { kind: "revert", changes, touchesPolicyFile: touchesPolicy(changes, i.policyPaths) };
}

/**
 * D9: the entries of `POST …/git/trees` (with `base_tree` = the tip's tree). A path the culprit
 * added is deleted (`sha: null`); every other path gets its `before` entry back.
 */
export function revertTreeEntries(
  changes: readonly Change[],
): { path: string; mode: string; type: string; sha: string | null }[] {
  return changes.map((c) =>
    c.before !== null
      ? { path: c.path, mode: c.before.mode, type: c.before.type, sha: c.before.sha }
      : {
          path: c.path,
          mode: (c.after as Entry).mode,
          type: (c.after as Entry).type,
          sha: null,
        },
  );
}

// ---------------------------------------------------------------------------------------------
// D5: the culprit's commits on the default branch
// ---------------------------------------------------------------------------------------------

export interface RangeCommit {
  sha: string;
  parentSha: string | null;
  seq: number;
  chainBreak: boolean;
  /** The commit belongs to the culprit PR. */
  culprit: boolean;
}

/**
 * D5. `commits` are the tracked commits from the culprit's first commit to the tip (any order).
 * The culprit's commits must be contiguous in `seq` and linked by first parents, with no chain
 * break after the first of them; base = the first one's parent, head = the last one.
 */
export function culpritRange(
  commits: readonly RangeCommit[],
): { base: string; head: string; commits: number } | NeedsHuman {
  const sorted = [...commits].sort((a, b) => a.seq - b.seq);
  const firstIdx = sorted.findIndex((c) => c.culprit);
  if (firstIdx < 0) return needsHuman("history_incomplete");
  let lastIdx = firstIdx;
  while (lastIdx + 1 < sorted.length && (sorted[lastIdx + 1] as RangeCommit).culprit) lastIdx++;
  const first = sorted[firstIdx] as RangeCommit;
  if (first.parentSha === null) return needsHuman("history_incomplete");
  // Contiguous: no culprit commit after the run.
  if (sorted.slice(lastIdx + 1).some((c) => c.culprit)) return needsHuman("history_incomplete");
  for (let k = firstIdx + 1; k < sorted.length; k++) {
    const c = sorted[k] as RangeCommit;
    if (c.chainBreak) return needsHuman("history_incomplete");
    if (k <= lastIdx && c.parentSha !== (sorted[k - 1] as RangeCommit).sha) {
      return needsHuman("history_incomplete");
    }
  }
  return {
    base: first.parentSha,
    head: (sorted[lastIdx] as RangeCommit).sha,
    commits: lastIdx - firstIdx + 1,
  };
}

// ---------------------------------------------------------------------------------------------
// D14: auto-merge eligibility
// ---------------------------------------------------------------------------------------------

export type AutoMergeReason =
  | "opened"
  | "not_configured"
  | "policy_invalid"
  | "card_missing"
  | "risk_not_listed"
  | "sensitive"
  | "break_glass"
  | "policy_file"
  | "repo_setting_off";

export type AutoMergeInput = {
  opened: boolean;
  listed: RiskClass[] | "not_configured" | "policy_invalid";
  card: { status: "ok" | "unavailable"; risk: RiskClass } | null;
  breakGlass: boolean;
  touchesPolicyFile: boolean;
  repoAllowsAutoMerge: boolean;
};

/** D14, in the stated order: the first rule that fails is the reason. */
export function autoMergeEligibility(
  i: AutoMergeInput,
): { eligible: true; risk: RiskClass } | { eligible: false; reason: AutoMergeReason } {
  const no = (reason: AutoMergeReason) => ({ eligible: false as const, reason });
  if (!i.opened) return no("opened");
  if (i.listed === "not_configured" || i.listed === "policy_invalid") return no(i.listed);
  if (i.card === null || i.card.status !== "ok") return no("card_missing");
  if (!i.listed.includes(i.card.risk)) return no("risk_not_listed");
  if (i.card.risk === "sensitive") return no("sensitive");
  if (i.breakGlass) return no("break_glass");
  if (i.touchesPolicyFile) return no("policy_file");
  if (!i.repoAllowsAutoMerge) return no("repo_setting_off");
  return { eligible: true, risk: i.card.risk };
}
