/**
 * An in-memory git object store of trees and commits (Phase 1 step 5): the same semantics the fake
 * GitHub API serves for `GET/POST …/git/trees` and `…/git/commits`, and a `TreeReader` for the
 * pure plan's unit tests. Objects are content-addressed, so the same tree written twice has the
 * same SHA, as on GitHub. No blob has content: a blob is only its SHA.
 */
import { createHash } from "node:crypto";
import type { Entry, TreeReader } from "../../src/guard/revert-plan.js";

export type GitEntry = Entry;

const hash = (kind: string, value: unknown): string =>
  createHash("sha1")
    .update(`${kind}\u0000${JSON.stringify(value)}`)
    .digest("hex");

export const blobSha = (label: string): string => hash("blob", label);
export const FILE = "100644";
export const EXEC = "100755";
export const LINK = "120000";
export const DIR = "040000";
export const GITLINK = "160000";

/** What a test describes: a file's blob label, or a full entry for a symlink, gitlink or mode. */
export type FileSpec = string | { mode: string; type?: "blob" | "commit"; sha: string };

export interface NewTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string | null;
}

export class TreeWriteError extends Error {}

export function createGitStore() {
  const trees = new Map<string, Map<string, GitEntry>>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  /** Trees served with `truncated: true`. */
  const truncated = new Set<string>();
  /**
   * Step 5 review 1, finding 2: how `POST …/git/trees` may differ from the documented API.
   * `keepNullTrees`: a `sha: null` entry of `type: "tree"` is ignored (the directory stays), as
   * GitHub might do. `extra`: entries written after the request's own, as if GitHub changed a path
   * the request did not name.
   */
  const quirks = { keepNullTrees: false, extra: [] as NewTreeEntry[] };

  function putTree(entries: Map<string, GitEntry>): string {
    const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sha = hash("tree", sorted);
    if (!trees.has(sha)) trees.set(sha, new Map(sorted));
    return sha;
  }

  /** A tree from flat paths: `{ "src/a.ts": "a1", "bin/run": { mode: EXEC, sha } }`. */
  function treeOf(files: Record<string, FileSpec>): string {
    interface Node {
      dirs: Map<string, Node>;
      leaves: Map<string, GitEntry>;
    }
    const root: Node = { dirs: new Map(), leaves: new Map() };
    for (const [path, spec] of Object.entries(files)) {
      const parts = path.split("/");
      let node = root;
      for (const dir of parts.slice(0, -1)) {
        let next = node.dirs.get(dir);
        if (!next) {
          next = { dirs: new Map(), leaves: new Map() };
          node.dirs.set(dir, next);
        }
        node = next;
      }
      const leaf: GitEntry =
        typeof spec === "string"
          ? { mode: FILE, type: "blob", sha: blobSha(spec) }
          : {
              mode: spec.mode,
              type: spec.type ?? (spec.mode === GITLINK ? "commit" : "blob"),
              sha: spec.sha,
            };
      node.leaves.set(parts.at(-1) as string, leaf);
    }
    const write = (n: Node): string => {
      const entries = new Map(n.leaves);
      for (const [name, d] of n.dirs) entries.set(name, { mode: DIR, type: "tree", sha: write(d) });
      return putTree(entries);
    };
    return write(root);
  }

  function getTree(sha: string): Map<string, GitEntry> {
    const t = trees.get(sha);
    if (!t) throw new TreeWriteError(`unknown tree ${sha}`);
    return t;
  }

  /**
   * `POST …/git/trees` with `base_tree`: each entry sets (or, with `sha: null`, deletes) the entry
   * at its path, creating intermediate directories; a directory left empty disappears. Deleting a
   * path that does not exist is an error (GitHub answers 422).
   */
  function applyEntries(baseTree: string | null, entries: readonly NewTreeEntry[]): string {
    const set = (treeSha: string | null, parts: string[], e: NewTreeEntry): string | null => {
      const current = new Map(treeSha === null ? [] : getTree(treeSha));
      const [name, ...rest] = parts as [string, ...string[]];
      if (rest.length === 0) {
        if (e.sha === null) {
          if (!current.has(name)) throw new TreeWriteError("delete of a missing path");
          current.delete(name);
        } else {
          current.set(name, { mode: e.mode, type: e.type as GitEntry["type"], sha: e.sha });
        }
      } else {
        const child = current.get(name);
        if (child !== undefined && child.type !== "tree") {
          if (e.sha === null) throw new TreeWriteError("delete of a missing path");
          current.delete(name);
        }
        const inner = set(child?.type === "tree" ? child.sha : null, rest, e);
        if (inner === null) current.delete(name);
        else current.set(name, { mode: DIR, type: "tree", sha: inner });
      }
      return current.size === 0 ? null : putTree(current);
    };
    let tree = baseTree;
    for (const e of entries) tree = set(tree, e.path.split("/"), e);
    return tree ?? putTree(new Map());
  }

  /** `POST …/git/trees` as the fake API serves it: `applyEntries` with the `quirks`. */
  function writeTree(baseTree: string | null, entries: readonly NewTreeEntry[]): string {
    return applyEntries(baseTree, [
      ...entries.filter((e) => !(quirks.keepNullTrees && e.sha === null && e.type === "tree")),
      ...quirks.extra,
    ]);
  }

  /** Every leaf (non-tree entry) under a tree, by path. */
  function flatten(treeSha: string, prefix = ""): Map<string, GitEntry> {
    const out = new Map<string, GitEntry>();
    for (const [name, e] of getTree(treeSha)) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (e.type === "tree") for (const [p, x] of flatten(e.sha, path)) out.set(p, x);
      else out.set(path, e);
    }
    return out;
  }

  function entryAt(treeSha: string, path: string): GitEntry | null {
    let cur = treeSha;
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const e = getTree(cur).get(parts[i] as string) ?? null;
      if (e === null || i === parts.length - 1) return e;
      if (e.type !== "tree") return null;
      cur = e.sha;
    }
    return null;
  }

  function commit(
    tree: string,
    parents: string[],
    message = "GRAFT_CANARY_COMMIT_MESSAGE",
  ): string {
    const sha = hash("commit", { tree, parents, message });
    commits.set(sha, { tree, parents, message });
    return sha;
  }

  /** A reader over this store, logging every call. */
  function reader(): TreeReader & { log: string[] } {
    const log: string[] = [];
    return {
      log,
      async commit(sha) {
        log.push(`commit ${sha}`);
        const c = commits.get(sha);
        if (!c) throw new Error(`unknown commit ${sha}`);
        return { tree: c.tree, parents: c.parents };
      },
      async tree(sha) {
        log.push(`tree ${sha}`);
        return {
          truncated: truncated.has(sha),
          entries: [...getTree(sha).entries()].map(([name, entry]) => ({ name, entry })),
        };
      },
    };
  }

  return {
    trees,
    commits,
    truncated,
    quirks,
    putTree,
    treeOf,
    getTree,
    applyEntries,
    writeTree,
    flatten,
    entryAt,
    commit,
    reader,
  };
}

export type GitStore = ReturnType<typeof createGitStore>;
