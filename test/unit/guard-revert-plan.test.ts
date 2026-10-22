/**
 * The revert plan (Phase 1 step 5, §6, §16): every case runs against an in-memory tree store.
 */
import { describe, expect, it } from "vitest";
import {
  type AutoMergeInput,
  autoMergeEligibility,
  culpritRange,
  diffTrees,
  type Entry,
  type Limits,
  planRevert,
  type RangeCommit,
  revertTreeEntries,
  type TreeReader,
} from "../../src/guard/revert-plan.js";
import {
  blobSha,
  createGitStore,
  DIR,
  EXEC,
  FILE,
  type FileSpec,
  GITLINK,
  LINK,
} from "../helpers/git-trees.js";

const LIMITS: Limits = { maxPaths: 300, maxTreeReads: 200 };
const blob = (label: string, mode = FILE): Entry => ({ mode, type: "blob", sha: blobSha(label) });

/** base, head and tip trees from flat file maps, and a plan over them. */
function world(
  base: Record<string, FileSpec>,
  head: Record<string, FileSpec>,
  tip: Record<string, FileSpec> = head,
) {
  const git = createGitStore();
  const t = { base: git.treeOf(base), head: git.treeOf(head), tip: git.treeOf(tip) };
  const reader = git.reader();
  const plan = (limits: Limits = LIMITS, policyPaths: readonly string[] = ["graft.yaml"]) =>
    planRevert(reader, { baseTree: t.base, headTree: t.head, tipTree: t.tip, policyPaths }, limits);
  return { git, t, reader, plan };
}

describe("revert plan: the diff and the entries (D6, D9)", () => {
  it("U-RVP-1 a squash merge modifying two files: two changes; the entries restore the before SHAs and modes", async () => {
    const w = world(
      { "src/a.ts": "a1", "src/b.ts": "b1", "README.md": "r" },
      { "src/a.ts": "a2", "src/b.ts": "b2", "README.md": "r" },
      { "src/a.ts": "a2", "src/b.ts": "b2", "README.md": "r", "later.txt": "l" },
    );
    const plan = await w.plan();
    expect(plan).toEqual({
      kind: "revert",
      touchesPolicyFile: false,
      changes: [
        { path: "src/a.ts", before: blob("a1"), after: blob("a2") },
        { path: "src/b.ts", before: blob("b1"), after: blob("b2") },
      ],
    });
    if (plan.kind !== "revert") throw new Error("no plan");
    expect(revertTreeEntries(plan.changes)).toEqual([
      { path: "src/a.ts", mode: FILE, type: "blob", sha: blobSha("a1") },
      { path: "src/b.ts", mode: FILE, type: "blob", sha: blobSha("b1") },
    ]);
  });

  it("U-RVP-2 an added file is deleted (sha null); a deleted file comes back with its old mode; an executable bit flip is restored", async () => {
    const w = world(
      { "bin/run": { mode: EXEC, sha: blobSha("run") }, "tool.sh": "t" },
      { "new.ts": "n", "tool.sh": { mode: EXEC, sha: blobSha("t") } },
    );
    const plan = await w.plan();
    if (plan.kind !== "revert") throw new Error(JSON.stringify(plan));
    expect(revertTreeEntries(plan.changes)).toEqual([
      // bin/ was deleted whole: restored as the directory it was.
      { path: "bin", mode: DIR, type: "tree", sha: w.git.entryAt(w.t.base, "bin")?.sha },
      { path: "new.ts", mode: FILE, type: "blob", sha: null },
      { path: "tool.sh", mode: FILE, type: "blob", sha: blobSha("t") },
    ]);
    // A single deleted file next to others is restored with its mode too.
    const one = world(
      { "src/run.sh": { mode: EXEC, sha: blobSha("r") }, "src/keep.ts": "k" },
      { "src/keep.ts": "k" },
    );
    const p1 = await one.plan();
    if (p1.kind !== "revert") throw new Error("no plan");
    expect(revertTreeEntries(p1.changes)).toEqual([
      { path: "src/run.sh", mode: EXEC, type: "blob", sha: blobSha("r") },
    ]);
  });

  it("U-RVP-3 a rename is one deletion and one restoration; a symlink is a blob change", async () => {
    const w = world(
      { "src/old.ts": "x", link: { mode: LINK, sha: blobSha("t1") } },
      {
        "src/new.ts": "x",
        link: { mode: LINK, sha: blobSha("t2") },
      },
    );
    const plan = await w.plan();
    if (plan.kind !== "revert") throw new Error(JSON.stringify(plan));
    expect(plan.changes.map((c) => [c.path, c.before?.sha ?? null, c.after?.sha ?? null])).toEqual([
      ["link", blobSha("t1"), blobSha("t2")],
      ["src/new.ts", null, blobSha("x")],
      ["src/old.ts", blobSha("x"), null],
    ]);
    expect(plan.changes[0]?.before).toEqual({ mode: LINK, type: "blob", sha: blobSha("t1") });
    expect(revertTreeEntries(plan.changes)).toEqual([
      { path: "link", mode: LINK, type: "blob", sha: blobSha("t1") },
      { path: "src/new.ts", mode: FILE, type: "blob", sha: null },
      { path: "src/old.ts", mode: FILE, type: "blob", sha: blobSha("x") },
    ]);
  });

  it("U-RVP-4 a directory added whole is one change on its entry; one deleted whole is restored with its tree SHA", async () => {
    const added = world({ "a.ts": "a" }, { "a.ts": "a", "lib/x.ts": "x", "lib/deep/y.ts": "y" });
    const p1 = await added.plan();
    if (p1.kind !== "revert") throw new Error("no plan");
    expect(p1.changes).toEqual([
      { path: "lib", before: null, after: added.git.entryAt(added.t.head, "lib") },
    ]);
    expect(revertTreeEntries(p1.changes)).toEqual([
      { path: "lib", mode: DIR, type: "tree", sha: null },
    ]);
    const removed = world({ "a.ts": "a", "lib/x.ts": "x" }, { "a.ts": "a" });
    const p2 = await removed.plan();
    if (p2.kind !== "revert") throw new Error("no plan");
    const lib = removed.git.entryAt(removed.t.base, "lib") as Entry;
    expect(revertTreeEntries(p2.changes)).toEqual([
      { path: "lib", mode: DIR, type: "tree", sha: lib.sha },
    ]);
  });

  it("U-RVP-5 subtrees with equal SHAs are never read", async () => {
    const big = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`vendor/pkg${i}/index.js`, `v${i}`]),
    );
    const w = world({ ...big, "src/a.ts": "1" }, { ...big, "src/a.ts": "2" });
    await w.plan();
    const vendor = w.git.entryAt(w.t.base, "vendor") as Entry;
    expect(w.reader.log).not.toContain(`tree ${vendor.sha}`);
    for (let i = 0; i < 50; i++) {
      const pkg = w.git.entryAt(w.t.base, `vendor/pkg${i}`) as Entry;
      expect(w.reader.log).not.toContain(`tree ${pkg.sha}`);
    }
    // base root, head root, both src/, and the tip lookups (cached reads count once).
    expect(new Set(w.reader.log).size).toBeLessThanOrEqual(4);
  });
});

describe("revert plan: the tip (D7)", () => {
  it("U-RVP-6 a changed path modified again at the tip conflicts; a path changed and changed back does not", async () => {
    const base = { "a.ts": "a1", "b.ts": "b1", "c.ts": "c1" };
    const head = { "a.ts": "a2", "b.ts": "b2", "c.ts": "c1" };
    const touched = await world(base, head, { "a.ts": "a3", "b.ts": "b2", "c.ts": "c9" }).plan();
    expect(touched).toEqual({ kind: "needs_human", reason: "touched_later", conflicts: ["a.ts"] });
    // b.ts went to b3 and back to b2 on main: its entry at the tip equals the culprit's.
    const back = await world(base, head, { "a.ts": "a2", "b.ts": "b2", "c.ts": "c9" }).plan();
    expect(back.kind).toBe("revert");
    // A path deleted at the tip, or moved into a directory that replaced its parent, conflicts.
    const gone = await world(base, head, { "b.ts": "b2", "c.ts": "c1" }).plan();
    expect(gone).toEqual({ kind: "needs_human", reason: "touched_later", conflicts: ["a.ts"] });
  });

  it("U-RVP-7 every tip entry equals the one before the culprit: skipped already_reverted", async () => {
    const base = { "a.ts": "a1", "b.ts": "b1" };
    expect(await world(base, { "a.ts": "a2", "b.ts": "b2", "new.ts": "n" }, base).plan()).toEqual({
      kind: "skipped",
      reason: "already_reverted",
    });
  });
});

describe("revert plan: what Graft does not revert (D8)", () => {
  it("U-RVP-8 workflows, a gitlink, a file that became a directory, 301 changes, the read budget and a truncated tree", async () => {
    const wf = await world(
      { ".github/workflows/ci.yml": "c1", "a.ts": "a" },
      { ".github/workflows/ci.yml": "c2", "a.ts": "b" },
    ).plan();
    expect(wf).toEqual({
      kind: "needs_human",
      reason: "workflow_files",
      conflicts: [".github/workflows/ci.yml"],
    });
    // A whole .github directory added (it holds workflows) is refused too.
    const wfDir = await world(
      { "a.ts": "a" },
      { "a.ts": "a", ".github/workflows/x.yml": "x" },
    ).plan();
    expect(wfDir).toMatchObject({ kind: "needs_human", reason: "workflow_files" });

    const sub = await world(
      { "vendor/lib": { mode: GITLINK, sha: blobSha("s1") } },
      { "vendor/lib": { mode: GITLINK, sha: blobSha("s2") } },
    ).plan();
    expect(sub).toEqual({ kind: "needs_human", reason: "submodule", conflicts: ["vendor/lib"] });

    const typeChange = await world({ conf: "c" }, { "conf/a.yml": "a" }).plan();
    expect(typeChange).toEqual({ kind: "needs_human", reason: "type_change", conflicts: ["conf"] });

    const many = (v: string) =>
      Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`f${i}.ts`, `${v}${i}`]));
    expect(await world(many("a"), many("b")).plan()).toEqual({
      kind: "needs_human",
      reason: "too_large",
      conflicts: [],
    });
    expect((await world(many("a"), many("b")).plan({ maxPaths: 301, maxTreeReads: 10 })).kind).toBe(
      "revert",
    );

    const deep = (v: string) => ({ "a/b/c/d/e.ts": v, "x/y/z.ts": v });
    expect(await world(deep("1"), deep("2")).plan({ maxPaths: 300, maxTreeReads: 5 })).toEqual({
      kind: "needs_human",
      reason: "too_large",
      conflicts: [],
    });
    expect((await world(deep("1"), deep("2")).plan({ maxPaths: 300, maxTreeReads: 30 })).kind).toBe(
      "revert",
    );

    const trunc = world({ "src/a.ts": "1" }, { "src/a.ts": "2" });
    trunc.git.truncated.add(trunc.t.head);
    expect(await trunc.plan()).toEqual({ kind: "needs_human", reason: "too_large", conflicts: [] });
    // Step 5 review 1, finding 8: a truncated tree in the diff itself (the base), with a tip that
    // is not the head, so no tip lookup can catch it.
    const truncBase = world(
      { "src/a.ts": "1" },
      { "src/a.ts": "2" },
      { "src/a.ts": "2", "later.ts": "l" },
    );
    truncBase.git.truncated.add(truncBase.t.base);
    expect(await truncBase.plan()).toEqual({
      kind: "needs_human",
      reason: "too_large",
      conflicts: [],
    });
  });

  it("U-RVP-8b a tree entry name with a slash, '.' or '..' never reaches a tree write", async () => {
    for (const name of ["a/b", ".", ".."]) {
      const git = createGitStore();
      const base = git.treeOf({ "ok.ts": "1" });
      // A hand-made tree object the real API could never return.
      const head = git.putTree(new Map([[name, { mode: FILE, type: "blob", sha: blobSha("x") }]]));
      const plan = await planRevert(
        git.reader(),
        { baseTree: base, headTree: head, tipTree: head, policyPaths: [] },
        LIMITS,
      );
      expect(plan, name).toEqual({ kind: "needs_human", reason: "too_large", conflicts: [] });
    }
  });

  it("U-RVP-8c the policy file is flagged for auto-merge", async () => {
    const plan = await world({ "graft.yaml": "p1" }, { "graft.yaml": "p2" }).plan();
    expect(plan).toMatchObject({ kind: "revert", touchesPolicyFile: true });
  });
});

describe("revert plan: the culprit range (D5)", () => {
  const C = (n: number) => n.toString(16).padStart(40, "0");
  const row = (n: number, culprit: boolean, o: Partial<RangeCommit> = {}): RangeCommit => ({
    sha: C(n),
    parentSha: C(n - 1),
    seq: n,
    chainBreak: false,
    culprit,
    ...o,
  });

  it("U-RVP-9 a rebase merge of three commits: base is the first one's parent, head the last one; the plan restores all three", async () => {
    expect(culpritRange([row(4, false), row(1, true), row(3, true), row(2, true)])).toEqual({
      base: C(0),
      head: C(3),
      commits: 3,
    });
    // A squash merge is one row.
    expect(culpritRange([row(5, true), row(6, false)])).toEqual({
      base: C(4),
      head: C(5),
      commits: 1,
    });
    // Not contiguous, a chain break after the first one, a broken first-parent link, no parent.
    const incomplete = { kind: "needs_human", reason: "history_incomplete", conflicts: [] };
    expect(culpritRange([row(1, true), row(2, false), row(3, true)])).toEqual(incomplete);
    expect(culpritRange([row(1, true), row(2, false, { chainBreak: true })])).toEqual(incomplete);
    expect(culpritRange([row(1, true), row(2, true, { parentSha: C(9) })])).toEqual(incomplete);
    expect(culpritRange([row(1, true, { parentSha: null })])).toEqual(incomplete);
    expect(culpritRange([row(1, false)])).toEqual(incomplete);
    // The first culprit commit may itself start a chain (its parent is still a git parent).
    expect(culpritRange([row(1, true, { chainBreak: true })])).toMatchObject({ base: C(0) });

    // Three commits, each changing a file: the diff from base to head holds all three.
    const git = createGitStore();
    const t0 = git.treeOf({ "a.ts": "a0", "b.ts": "b0" });
    const t1 = git.treeOf({ "a.ts": "a1", "b.ts": "b0" });
    const t2 = git.treeOf({ "a.ts": "a1", "b.ts": "b1" });
    const t3 = git.treeOf({ "a.ts": "a1", "b.ts": "b1", "c.ts": "c1" });
    const changes = await diffTrees(git.reader(), t0, t3, LIMITS);
    expect(Array.isArray(changes) && changes.map((c) => c.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    void t1;
    void t2;
  });
});

describe("revert plan: auto-merge (D14)", () => {
  it("U-RVP-10 one case per reason, in the stated order; all satisfied is eligible", () => {
    const ok: AutoMergeInput = {
      opened: true,
      listed: ["logic"],
      card: { status: "ok", risk: "logic" },
      breakGlass: false,
      touchesPolicyFile: false,
      repoAllowsAutoMerge: true,
    };
    expect(autoMergeEligibility(ok)).toEqual({ eligible: true, risk: "logic" });
    const cases: [Partial<AutoMergeInput>, string][] = [
      [{ opened: false, listed: "not_configured" }, "opened"],
      [{ listed: "not_configured", card: null }, "not_configured"],
      [{ listed: "policy_invalid", card: null }, "policy_invalid"],
      [{ card: null, breakGlass: true }, "card_missing"],
      [{ card: { status: "unavailable", risk: "logic" } }, "card_missing"],
      [{ card: { status: "ok", risk: "trivial" }, breakGlass: true }, "risk_not_listed"],
      // The parser refuses a listed `sensitive`; the rule still holds if one gets through.
      [{ listed: ["sensitive" as never], card: { status: "ok", risk: "sensitive" } }, "sensitive"],
      [{ breakGlass: true, touchesPolicyFile: true }, "break_glass"],
      [{ touchesPolicyFile: true, repoAllowsAutoMerge: false }, "policy_file"],
      [{ repoAllowsAutoMerge: false }, "repo_setting_off"],
    ];
    for (const [over, reason] of cases) {
      expect(autoMergeEligibility({ ...ok, ...over }), reason).toEqual({ eligible: false, reason });
    }
    // A sensitive card with the list the parser allows: not listed.
    expect(
      autoMergeEligibility({
        ...ok,
        listed: ["trivial", "logic"],
        card: { status: "ok", risk: "sensitive" },
      }),
    ).toEqual({ eligible: false, reason: "risk_not_listed" });
  });
});

describe("revert plan: property", () => {
  /** A small deterministic PRNG (mulberry32). */
  function rng(seed: number) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const DIRS = ["", "src", "src/lib", "docs", "bin", "pkg/a/b"];
  const MODES = [FILE, FILE, FILE, EXEC, LINK];

  it("U-RVP-11 applying the entries to the tip restores `before` on every change path and leaves every other tip path unchanged", async () => {
    let reverts = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      const name = (i: number) => {
        const d = pick(DIRS);
        return d === "" ? `f${i}.txt` : `${d}/f${i}.txt`;
      };
      const base: Record<string, FileSpec> = {};
      for (let i = 0; i < 6 + Math.floor(r() * 10); i++) {
        base[name(i)] = { mode: pick(MODES), sha: blobSha(`b${seed}-${i}`) };
      }
      // The culprit: modify, add, delete, flip a mode, delete or add a whole directory.
      const head: Record<string, FileSpec> = { ...base };
      const keys = Object.keys(base);
      for (const k of keys) {
        const x = r();
        if (x < 0.2) head[k] = { mode: pick(MODES), sha: blobSha(`h${seed}-${k}`) };
        else if (x < 0.3) delete head[k];
      }
      for (let i = 0; i < Math.floor(r() * 3); i++) {
        head[`new${seed}/${i}.ts`] = { mode: FILE, sha: blobSha(`n${seed}-${i}`) };
      }
      if (r() < 0.3) head[name(100 + seed)] = { mode: FILE, sha: blobSha(`add${seed}`) };
      // The tip: the culprit plus unrelated later changes (other paths only).
      const tip: Record<string, FileSpec> = { ...head };
      for (let i = 0; i < Math.floor(r() * 4); i++) {
        tip[`later/${seed}-${i}.md`] = { mode: FILE, sha: blobSha(`l${seed}-${i}`) };
      }
      const git = createGitStore();
      const t = { base: git.treeOf(base), head: git.treeOf(head), tip: git.treeOf(tip) };
      const plan = await planRevert(
        git.reader() as TreeReader,
        { baseTree: t.base, headTree: t.head, tipTree: t.tip, policyPaths: [] },
        LIMITS,
      );
      if (plan.kind !== "revert") {
        // Only a culprit that changed nothing, or a file turned into a directory, stops here.
        expect(["skipped", "needs_human"], `seed ${seed}`).toContain(plan.kind);
        if (plan.kind === "needs_human") expect(plan.reason).toBe("type_change");
        continue;
      }
      reverts++;
      const reverted = git.applyEntries(t.tip, revertTreeEntries(plan.changes));
      for (const c of plan.changes) {
        expect(git.entryAt(reverted, c.path), `seed ${seed} ${c.path}`).toEqual(c.before);
      }
      const under = (p: string) =>
        plan.changes.some((c) => p === c.path || p.startsWith(`${c.path}/`));
      const before = git.flatten(t.tip);
      const after = git.flatten(reverted);
      for (const [p, e] of before)
        if (!under(p)) expect(after.get(p), `seed ${seed} ${p}`).toEqual(e);
      for (const [p, e] of after)
        if (!under(p)) expect(before.get(p), `seed ${seed} ${p}`).toEqual(e);
      // And on the changed paths the result is exactly the base.
      const baseFlat = git.flatten(t.base);
      for (const [p, e] of after)
        if (under(p)) expect(baseFlat.get(p), `seed ${seed} ${p}`).toEqual(e);
    }
    expect(reverts).toBeGreaterThan(100);
  });
});
