import { describe, expect, it } from "vitest";
import { classifyGitHubError } from "../../src/github/errors.js";
import { fetchIntentInputs } from "../../src/modules/intent/fetch.js";
import { findLinkedIssue } from "../../src/modules/intent/inputs.js";
import { fakeGitHubFactory } from "../helpers/app.js";
import { createFakeGitHubApi } from "../helpers/fake-github-api.js";
import {
  makeFile,
  makeIssue,
  makePull,
  OWNER,
  PR_NUMBER,
  REPO,
} from "../helpers/github-builders.js";

const o: { owner: string; repo: string; prNumber: number; taskIssueNumber: number | null } = {
  owner: "graft-sandbox",
  repo: "sample-ts",
  prNumber: 2,
  taskIssueNumber: null,
};
const link = (body: string, over: Partial<typeof o> = {}) =>
  findLinkedIssue(body, { ...o, ...over });

describe("findLinkedIssue", () => {
  it("U-LINK-1 closing keywords in every form", () => {
    expect(link("Fixes #42")).toEqual({ number: 42, source: "closing_keyword" });
    expect(link("closes: #7")).toEqual({ number: 7, source: "closing_keyword" });
    expect(link("RESOLVED #9")).toEqual({ number: 9, source: "closing_keyword" });
    expect(link("fixed graft-sandbox/sample-ts#11")).toEqual({
      number: 11,
      source: "closing_keyword",
    });
    expect(link("Resolves https://github.com/graft-sandbox/sample-ts/issues/12")).toEqual({
      number: 12,
      source: "closing_keyword",
    });
  });

  it("U-LINK-2 a cross-repo reference is ignored", () => {
    expect(link("Fixes other-org/other#3")).toBeNull();
    expect(link("Fixes other-org/other#3", { taskIssueNumber: 5 })).toEqual({
      number: 5,
      source: "task",
    });
    expect(link("Fixes https://github.com/other-org/other/issues/3\nsee #8")).toEqual({
      number: 8,
      source: "reference",
    });
  });

  it("U-LINK-3 the task issue is used without a keyword; a keyword beats the task", () => {
    expect(link("nothing here", { taskIssueNumber: 5 })).toEqual({ number: 5, source: "task" });
    expect(link("Fixes #42", { taskIssueNumber: 5 })).toEqual({
      number: 42,
      source: "closing_keyword",
    });
  });

  it("U-LINK-4 a bare #N is a reference, a mid-word or entity one is not", () => {
    expect(link("see #8")).toEqual({ number: 8, source: "reference" });
    expect(link("abc#8")).toBeNull();
    expect(link("&#8;")).toBeNull();
  });

  it("U-LINK-5 fenced code blocks are ignored", () => {
    expect(link("```\nFixes #42\n```")).toBeNull();
    expect(link("```\nFixes #42\n```\nsee #9")).toEqual({ number: 9, source: "reference" });
  });

  it("U-LINK-6 self reference and out-of-range numbers are ignored", () => {
    expect(link("Fixes #2")).toBeNull();
    expect(link("Fixes #0")).toBeNull();
    expect(link("Fixes #9999999999")).toBeNull();
    expect(link("Fixes #2 and Fixes #4")).toEqual({ number: 4, source: "closing_keyword" });
  });

  it("U-LINK-7 owner and repo match case-insensitively", () => {
    expect(link("Fixes Graft-Sandbox/Sample-TS#11")).toEqual({
      number: 11,
      source: "closing_keyword",
    });
  });

  it("U-LINK-8 empty body and no task gives null", () => {
    expect(link("")).toBeNull();
  });
});

describe("fetchIntentInputs", () => {
  async function setup(pull = makePull({ changed_files: 230 })) {
    const api = createFakeGitHubApi();
    const octokit = await fakeGitHubFactory(api).forInstallation(1);
    return { api, octokit, pull };
  }

  it("U-FETCH-4 230 files are read over 3 pages; a missing patch is null", async () => {
    const { api, octokit, pull } = await setup();
    const files = Array.from({ length: 230 }, (_, i) =>
      makeFile({ path: `src/f${i}.ts`, patch: i === 5 ? null : undefined }),
    );
    api.state.files.set(PR_NUMBER, files);
    const out = await fetchIntentInputs(octokit, {
      owner: OWNER,
      repo: REPO,
      pull: pull as never,
      taskIssueNumber: null,
    });
    expect(api.find("GET", /\/pulls\/2\/files$/)).toHaveLength(3);
    expect(out.files).toHaveLength(230);
    expect(out.listingTruncated).toBe(false);
    expect(out.tooLarge).toBe(false);
    expect(out.files[5]?.patch).toBeNull();
    expect(Object.keys(out.files[0] ?? {}).sort()).toEqual(
      ["additions", "deletions", "patch", "path", "previousPath", "status"].sort(),
    );
  });

  it("U-FETCH-5 a huge PR makes no /files request but still reads the issue", async () => {
    const { api, octokit } = await setup();
    const pull = makePull({ changed_files: 1200, body: "Fixes #42" });
    api.state.issues.set(42, makeIssue(42));
    const out = await fetchIntentInputs(octokit, {
      owner: OWNER,
      repo: REPO,
      pull: pull as never,
      taskIssueNumber: null,
    });
    expect(out.tooLarge).toBe(true);
    expect(out.files).toEqual([]);
    expect(out.listingTruncated).toBe(true);
    expect(api.find("GET", /\/files$/)).toHaveLength(0);
    expect(out.issue?.number).toBe(42);
    // additions + deletions over 20,000 is huge too
    const big = makePull({ additions: 15_000, deletions: 5_001 });
    const out2 = await fetchIntentInputs(octokit, {
      owner: OWNER,
      repo: REPO,
      pull: big as never,
      taskIssueNumber: null,
    });
    expect(out2.tooLarge).toBe(true);
  });

  it("U-FETCH-6 issue 404 or a pull request gives null; a 502 throws", async () => {
    const { api, octokit } = await setup();
    api.state.files.set(PR_NUMBER, [makeFile({ path: "a.ts" })]);
    const run = (body: string) =>
      fetchIntentInputs(octokit, {
        owner: OWNER,
        repo: REPO,
        pull: makePull({ body, changed_files: 1 }) as never,
        taskIssueNumber: null,
      });
    expect((await run("Fixes #42")).issue).toBeNull(); // 404
    api.state.issues.set(42, makeIssue(42, { isPull: true }));
    expect((await run("Fixes #42")).issue).toBeNull();
    api.state.issues.set(42, makeIssue(42, { title: "T", body: null }));
    expect((await run("Fixes #42")).issue).toEqual({ number: 42, title: "T", body: "" });
    api.failNext("GET", /\/issues\/42$/, 502);
    const err = await run("Fixes #42").catch((e: unknown) => e);
    expect(classifyGitHubError(err)).toBe("transient");
  });
});
