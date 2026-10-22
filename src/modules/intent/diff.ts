/**
 * Turns the file listing into what the model sees (T9). Pure; diff text lives in memory only.
 */
import { createHash } from "node:crypto";
import { GlobBudget } from "../../core/glob.js";
import type { ChangedFile } from "./inputs.js";
import {
  classifyFile,
  compareCodePoints,
  DOCS_GLOBS,
  type FloorConfig,
  fileMatches,
  globMatcher,
  matchesPathRule,
  TEST_GLOBS,
} from "./risk-floor.js";

export type OmitReason = "lockfile" | "binary" | "generated" | "no_patch_from_api" | "budget";

export const LIMITS = {
  titleChars: 300,
  bodyChars: 20_000,
  issueTitleChars: 300,
  issueBodyChars: 8_000,
  perFileChars: 12_000,
  totalChars: 120_000,
  minPartialChars: 2_000,
  fileListEntries: 300,
  pathChars: 1_000,
  /** Head-file context for the verifier (intent-v2). */
  contextTotalChars: 60_000,
  contextPerFileChars: 16_000,
  contextHunkLines: 20,
  contextRelatedLines: 2,
  contextRelatedMaxUses: 12,
  contextRelatedWindows: 30,
} as const;

/**
 * CRLF/CR → LF; other control characters (except LF and TAB) → U+FFFD; format characters (bidi
 * controls, zero-width, BOM) → the visible text `[U+XXXX]`; then cap at `maxChars`.
 */
export function neutralizeUntrusted(text: string, maxChars: number): string {
  const out = text.replace(/\r\n?/g, "\n").replace(/[\p{Cc}\p{Cf}]/gu, (ch) => {
    if (ch === "\n" || ch === "\t") return ch;
    if (/\p{Cc}/u.test(ch)) return "\uFFFD";
    return `[U+${(ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}]`;
  });
  if (out.length <= maxChars) return out;
  const points = Array.from(out);
  if (points.length <= maxChars) return out;
  const more = points.length - maxChars;
  return `${points.slice(0, maxChars).join("")}\n[Graft: truncated, ${more} more characters]`;
}

export interface FileView {
  file: ChangedFile;
  view: "full" | "truncated" | "omitted";
  omittedReason?: OmitReason;
  /** The neutralized, capped patch text that is shown (view full/truncated). */
  shown: string | null;
  shownLines: number;
  totalLines: number;
}

export interface PreparedDiff {
  views: FileView[];
  /** One JSON line per file (or per directory beyond the first 300). */
  fileListBlock: string;
  /** Diff block with the header nonce filled in. */
  renderDiff(nonce: string): string;
  /** Head-file context block for the verifier; "" when no file has context. */
  renderContext(nonce: string): string;
  contextFiles: number;
  partialPaths: string[];
  /**
   * The added lines (`+…`) of the patches shown, for the injection rule; the whole patch for a
   * file that has file context.
   */
  addedLines: string[];
  stats: {
    filesFull: number;
    filesPartial: number;
    filesOmitted: number;
    omitted: { path: string; reason: OmitReason }[];
  };
}

function group(f: ChangedFile, config: FloorConfig, budget: GlobBudget): 0 | 1 | 2 | 3 {
  if (matchesPathRule(f, config, budget)) return 0;
  if (fileMatches(globMatcher(TEST_GLOBS), f)) return 2;
  if (fileMatches(globMatcher(DOCS_GLOBS), f)) return 3;
  return 1;
}

function cutAtLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const idx = text.lastIndexOf("\n", limit);
  return idx > 0 ? text.slice(0, idx) : text.slice(0, limit);
}

const countLines = (t: string): number => (t === "" ? 0 : t.split("\n").length);

export function prepareDiff(files: readonly ChangedFile[], config: FloorConfig): PreparedDiff {
  const globBudget = new GlobBudget();
  const ordered = files
    .map((file) => ({ file, g: group(file, config, globBudget), cls: classifyFile(file) }))
    .sort((a, b) => a.g - b.g || compareCodePoints(a.file.path, b.file.path));
  const ruleMatched = new Set(ordered.filter((o) => o.g === 0).map((o) => o.file));

  let budget: number = LIMITS.totalChars;
  const views: FileView[] = [];
  for (const { file, cls } of ordered) {
    if (cls !== "candidate") {
      views.push({
        file,
        view: "omitted",
        omittedReason: cls,
        shown: null,
        shownLines: 0,
        totalLines: 0,
      });
      continue;
    }
    const full = neutralizeUntrusted(file.patch as string, Number.MAX_SAFE_INTEGER);
    const totalLines = countLines(full);
    let shown = cutAtLine(full, LIMITS.perFileChars);
    let truncated = shown.length < full.length;
    if (shown.length > budget) {
      if (budget >= LIMITS.minPartialChars) {
        shown = cutAtLine(shown, budget);
        truncated = true;
      } else {
        views.push({
          file,
          view: "omitted",
          omittedReason: "budget",
          shown: null,
          shownLines: 0,
          totalLines,
        });
        continue;
      }
    }
    budget -= shown.length;
    views.push({
      file,
      view: truncated ? "truncated" : "full",
      shown,
      shownLines: countLines(shown),
      totalLines,
    });
  }

  const header = (v: FileView) => ({
    path: neutralizeUntrusted(v.file.path, LIMITS.pathChars),
    previous_path:
      v.file.previousPath === null
        ? null
        : neutralizeUntrusted(v.file.previousPath, LIMITS.pathChars),
    status: v.file.status,
    additions: v.file.additions,
    deletions: v.file.deletions,
    view: v.view,
    ...(v.omittedReason ? { omitted_reason: v.omittedReason } : {}),
  });

  const listLines = views.slice(0, LIMITS.fileListEntries).map((v) => JSON.stringify(header(v)));
  const rest = views.slice(LIMITS.fileListEntries);
  if (rest.length > 0) {
    const dirs = new Map<string, { files: number; additions: number; deletions: number }>();
    for (const v of rest) {
      const slash = v.file.path.indexOf("/");
      const dir = slash > 0 ? v.file.path.slice(0, slash) : ".";
      const d = dirs.get(dir) ?? { files: 0, additions: 0, deletions: 0 };
      d.files += 1;
      d.additions += v.file.additions;
      d.deletions += v.file.deletions;
      dirs.set(dir, d);
    }
    for (const dir of [...dirs.keys()].sort(compareCodePoints)) {
      const d = dirs.get(dir) as { files: number; additions: number; deletions: number };
      listLines.push(
        JSON.stringify({
          summary_dir: neutralizeUntrusted(dir, LIMITS.pathChars),
          files: d.files,
          additions: d.additions,
          deletions: d.deletions,
        }),
      );
    }
  }

  const omittedViews = views.filter((v) => v.view === "omitted");
  const partialPaths = views
    .filter(
      (v) =>
        v.view === "truncated" ||
        (v.view === "omitted" && v.omittedReason !== "lockfile" && v.omittedReason !== "binary"),
    )
    .map((v) => v.file.path);

  const contexts: { header: Record<string, unknown>; body: string }[] = [];
  const withContext = new Set<ChangedFile>();
  let contextBudget: number = LIMITS.contextTotalChars;
  for (const v of views) {
    // No context for files the path rules call sensitive (secrets, CI, infra, ...): their
    // unchanged lines are not sent to the model.
    if (v.shown === null || v.file.headText == null || contextBudget <= 0) continue;
    if (ruleMatched.has(v.file)) continue;
    const c = fileContext(v.file.headText, v.file.patch ?? "", contextBudget);
    if (c === null) continue;
    contextBudget -= c.body.length;
    withContext.add(v.file);
    contexts.push({
      header: {
        path: neutralizeUntrusted(v.file.path, LIMITS.pathChars),
        lines: c.lines,
        view: c.view,
      },
      body: c.body,
    });
  }

  const addedLines: string[] = [];
  for (const v of views) {
    if (v.shown === null) continue;
    // A truncated patch's hidden added lines still reach the verifier through the file context,
    // so the injection rule reads the whole patch of every file that has context.
    const text = withContext.has(v.file)
      ? neutralizeUntrusted(v.file.patch ?? "", Number.MAX_SAFE_INTEGER)
      : v.shown;
    for (const line of text.split("\n")) if (line.startsWith("+")) addedLines.push(line);
  }

  return {
    views,
    fileListBlock: listLines.join("\n"),
    renderDiff(nonce: string): string {
      const out: string[] = [];
      for (const v of views) {
        out.push(`@@graft-file-${nonce} ${JSON.stringify(header(v))}`);
        if (v.shown !== null) out.push(v.shown);
      }
      return out.join("\n");
    },
    renderContext(nonce: string): string {
      return contexts
        .map((c) => `@@graft-context-${nonce} ${JSON.stringify(c.header)}\n${c.body}`)
        .join("\n");
    },
    contextFiles: contexts.length,
    partialPaths,
    addedLines,
    stats: {
      filesFull: views.filter((v) => v.view === "full").length,
      filesPartial: views.filter((v) => v.view === "truncated").length,
      filesOmitted: omittedViews.length,
      omitted: omittedViews
        .slice(0, 50)
        .map((v) => ({ path: v.file.path, reason: v.omittedReason as OmitReason })),
    },
  };
}

/** New-side line ranges (1-based, inclusive) of a patch's hunks. */
export function hunkRanges(patch: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    out.push([start, start + Math.max(len, 1) - 1]);
  }
  return out;
}

const NAME = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g;
const COMMON_NAMES = new Set(
  "this self true false null none undefined return const function async await import export from else elif while typeof instanceof string number boolean object class public private static void new delete default case break continue throw catch finally yield let var def pass lambda with module require".split(
    " ",
  ),
);

const MAX_CHANGED_NAMES = 200;

/** Names used on the changed lines, longest first: dotted names whole and by their last part. */
function changedNames(patch: string): string[] {
  const names = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!/^[+-]/.test(line)) continue;
    for (const m of line.slice(1).matchAll(NAME)) {
      // `state.replaying` is also looked up as `replaying`, where the property is declared.
      for (const n of new Set([m[0], m[0].slice(m[0].lastIndexOf(".") + 1)])) {
        if (n.length >= 4 && !COMMON_NAMES.has(n.toLowerCase())) names.add(n);
      }
    }
  }
  return [...names]
    .sort((a, b) => b.length - a.length || compareCodePoints(a, b))
    .slice(0, MAX_CHANGED_NAMES);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The verifier's view of one changed file at head (intent-v2): the whole file with line numbers
 * when it fits, else windows around the hunks plus short windows around other lines that use a
 * name the change touches (only names used at most 12 times, rarest first). Pure.
 */
export function fileContext(
  headText: string,
  patch: string,
  budget: number,
): { view: "whole" | "excerpts"; lines: number; body: string } | null {
  const lines = neutralizeUntrusted(headText, Number.MAX_SAFE_INTEGER).split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return null;
  const cap = Math.min(LIMITS.contextPerFileChars, budget);
  const numbered = (i: number) => `${i + 1}\t${lines[i]}`;
  const render = (keep: boolean[]): string => {
    const out: string[] = [];
    let gap = false;
    keep.forEach((k, i) => {
      if (!k) {
        gap = true;
        return;
      }
      if (gap && out.length > 0) out.push("…");
      gap = false;
      out.push(numbered(i));
    });
    if (gap && out.length > 0) out.push("…");
    return out.join("\n");
  };

  const whole = lines.map((_, i) => numbered(i)).join("\n");
  if (whole.length <= cap) return { view: "whole", lines: lines.length, body: whole };

  const keep = lines.map(() => false);
  const mark = (from: number, to: number) => {
    for (let i = Math.max(0, from); i <= Math.min(lines.length - 1, to); i++) keep[i] = true;
  };
  for (const [a, b] of hunkRanges(patch)) {
    mark(a - 1 - LIMITS.contextHunkLines, b - 1 + LIMITS.contextHunkLines);
  }
  let body = render(keep);
  if (body.length > cap) {
    body = cutAtLine(body, cap);
    return body === "" ? null : { view: "excerpts", lines: lines.length, body };
  }

  const related: { name: string; at: number[] }[] = [];
  for (const name of changedNames(patch)) {
    const re = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`);
    const at = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
    if (at.length > 0 && at.length <= LIMITS.contextRelatedMaxUses) related.push({ name, at });
  }
  related.sort((x, y) => x.at.length - y.at.length || compareCodePoints(x.name, y.name));
  let windows = 0;
  for (const r of related) {
    for (const i of r.at) {
      if (keep[i]) continue;
      if (windows >= LIMITS.contextRelatedWindows) break;
      const before = [...keep];
      mark(i - LIMITS.contextRelatedLines, i + LIMITS.contextRelatedLines);
      const next = render(keep);
      if (next.length > cap) {
        keep.splice(0, keep.length, ...before);
        continue;
      }
      body = next;
      windows++;
    }
  }
  return body === "" ? null : { view: "excerpts", lines: lines.length, body };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The nonce is `sha256("graft-nonce\0" + canonicalInputs + "\0" + k)` to 16 hex characters, with
 * `k = 0, 1, ...` until it occurs in no untrusted block. It depends on the author's own text, so
 * the author cannot predict it. `derive` is a test seam.
 */
export function chooseNonce(
  canonicalInputs: string,
  untrustedBlocks: readonly string[],
  derive: (canonical: string, k: number) => string = (c, k) =>
    sha256(`graft-nonce\u0000${c}\u0000${k}`).slice(0, 16),
): string {
  for (let k = 0; ; k++) {
    const nonce = derive(canonicalInputs, k);
    if (!untrustedBlocks.some((b) => b.includes(nonce))) return nonce;
  }
}
