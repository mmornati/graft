/** Builders for the eval tests: cases, label sets, report rows, temp directories (outside the repo). */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll } from "vitest";
import type { EvalCase, LabelSet } from "../../src/eval/case-schema.js";
import type { CaseRow } from "../../src/eval/report-schema.js";
import type { CardInputs, ChangedFile } from "../../src/modules/intent/index.js";

export const REPO_ROOT = new URL("../../", import.meta.url).pathname;

const dirs: string[] = [];
/** A fresh directory under the OS temp dir (never inside the working tree); removed after the file. */
export async function tmpDir(prefix = "graft-eval-test-"): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
export function cleanupTmpDirs(): void {
  afterAll(async () => {
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });
}

export function cf(p: string, o: Partial<Omit<ChangedFile, "path">> = {}): ChangedFile {
  const additions = o.additions ?? 2;
  const deletions = o.deletions ?? 1;
  return {
    path: p,
    previousPath: o.previousPath ?? null,
    status: o.status ?? "modified",
    additions,
    deletions,
    patch:
      o.patch === undefined
        ? `@@ -1,${deletions} +1,${additions} @@\n${"-old line\n".repeat(deletions)}${"+new line\n".repeat(additions)}`.trimEnd()
        : o.patch,
  };
}

export function cardInputs(
  files: ChangedFile[] = [cf("src/a.ts")],
  over: Partial<CardInputs> = {},
): CardInputs {
  return {
    repositoryFullName: "fictional-org/shop-demo",
    pr: {
      number: 101,
      title: "Fix the thing",
      body: "Fixes a thing.",
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      changedFiles: files.length,
    },
    issue: null,
    files,
    listingTruncated: false,
    tooLarge: false,
    ...over,
  };
}

export function labelSet(over: Partial<LabelSet> = {}): LabelSet {
  return {
    labeler: "ada",
    labeledAt: "2026-10-15T00:00:00Z",
    guideVersion: "lg-1",
    risk: "trivial",
    outOfScope: [],
    goal: "Does a thing.",
    keyBehaviorChanges: ["A thing happens."],
    shouldFlag: false,
    confidence: "high",
    notes: "",
    ...over,
  };
}

const TRIVIAL_WRITER = {
  goal: "Does a thing.",
  behavior_changes: ["A thing happens."],
  risk_class: "trivial",
  risk_reason: "Small.",
  out_of_scope_edits: [],
  instructions_in_data: false,
};
export const writerJson = (over: Record<string, unknown> = {}) => ({
  json: { ...TRIVIAL_WRITER, ...over },
});

/** A synthetic case with a trivial writer and an agreeing verifier unless told otherwise. */
export function synCase(id = "syn-900-x", over: Partial<EvalCase> = {}): EvalCase {
  return {
    schemaVersion: 1,
    id,
    source: { kind: "synthetic", author: "tests", createdAt: "2026-10-15" },
    tags: [],
    floorConfig: { extraSensitiveGlobs: [] },
    inputs: cardInputs(),
    labels: [labelSet({ labeler: "graft-synthetic" })],
    adjudicated: null,
    fakeLlm: { writer: writerJson(), verifier: "agree" },
    ...over,
  };
}

export function pilotCase(
  setId: string,
  n: number,
  over: Partial<EvalCase> = {},
  inputs: CardInputs = cardInputs(),
): EvalCase {
  return {
    schemaVersion: 1,
    id: `${setId}--shop-${n}`,
    source: {
      kind: "pilot",
      setId,
      repository: inputs.repositoryFullName,
      prNumber: inputs.pr.number,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      mergedAt: "2026-09-01T10:00:00Z",
      exportedAt: "2026-10-15T10:00:00Z",
      exportTool: "graft-eval-export/1",
      authorKind: "agent",
      authorKindReason: "trailer",
      agent: "claude-code",
      model: null,
      redactions: [],
    },
    tags: [],
    floorConfig: { extraSensitiveGlobs: [] },
    inputs,
    labels: [],
    adjudicated: null,
    fakeLlm: null,
    ...over,
  };
}

export function row(over: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "r1",
    tags: [],
    gold: { risk: "logic", shouldFlag: false, outOfScopeCount: 0 },
    floor: "logic",
    model: "logic",
    final: "logic",
    status: "ok",
    failureReason: null,
    verifierStatus: "agree",
    raisedBy: [],
    floorRules: [],
    instructionsInData: false,
    oos: { tp: 0, fp: 0, fn: 0 },
    flag: "tn",
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 2,
    },
    costUsd: 0.003,
    cached: false,
    skipped: null,
    ...over,
  };
}

/** A writable that collects everything written to it. */
export function sink(): Writable & { text(): string } {
  let buf = "";
  const w = new Writable({
    write(chunk, _enc, cb) {
      buf += String(chunk);
      cb();
    },
  }) as Writable & { text(): string };
  w.text = () => buf;
  return w;
}

/** A readable that yields the given lines, then ends. */
export function linesIn(lines: string[]): PassThrough {
  const p = new PassThrough();
  p.end(`${lines.join("\n")}\n`);
  return p;
}

export const randomHex = (n = 6): string => randomBytes(n).toString("hex");
