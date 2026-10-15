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
  partialPaths: string[];
  /** The added lines (`+…`) of the patches shown, for the injection rule. */
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

  const addedLines: string[] = [];
  for (const v of views) {
    if (v.shown === null) continue;
    for (const line of v.shown.split("\n")) if (line.startsWith("+")) addedLines.push(line);
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
