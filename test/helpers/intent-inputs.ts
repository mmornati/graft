/** Builders for pure intent tests (no GitHub, no database). */
import type { FakeReply } from "../../src/llm/fake.js";
import { defaultGenerateOptions, type GenerateOptions } from "../../src/modules/intent/generate.js";
import type { CardInputs, ChangedFile } from "../../src/modules/intent/inputs.js";
import { testConfig } from "./config.js";

export type FakeLlmReply = FakeReply;

export function file(path: string, o: Partial<Omit<ChangedFile, "path">> = {}): ChangedFile {
  const additions = o.additions ?? 3;
  const deletions = o.deletions ?? 1;
  return {
    path,
    previousPath: o.previousPath ?? null,
    status: o.status ?? "modified",
    additions,
    deletions,
    patch:
      o.patch === undefined
        ? `@@ -1,${deletions} +1,${additions} @@\n${"-old\n".repeat(deletions)}${"+new\n".repeat(additions)}`.trimEnd()
        : o.patch,
    ...(o.headText !== undefined ? { headText: o.headText } : {}),
  };
}

export function inputs(over: Partial<CardInputs> & { files?: ChangedFile[] } = {}): CardInputs {
  const files = over.files ?? [file("src/retry.ts")];
  return {
    repositoryFullName: "graft-sandbox/sample-ts",
    pr: {
      number: 2,
      title: "Fix the retry loop",
      body: "Retries failed deliveries.",
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      changedFiles: files.length,
      ...over.pr,
    },
    issue: over.issue ?? null,
    files,
    listingTruncated: over.listingTruncated ?? false,
    tooLarge: over.tooLarge ?? false,
  };
}

export function genOptions(over: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    ...defaultGenerateOptions(testConfig(), { extraSensitiveGlobs: [] }),
    nowMs: () => 1_000_000,
    ...over,
  };
}
