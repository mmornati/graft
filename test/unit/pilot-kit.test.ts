import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsePolicyText } from "../../src/policy/parse.js";

const ROOT = path.resolve(new URL("../../", import.meta.url).pathname);
const PILOTS = path.join(ROOT, "docs/pilots");
const HOOK = path.join(ROOT, "scripts/pilot/prepare-commit-msg");

describe("onboarding kit", () => {
  it("U-DOC-1 the three starter files parse with no errors and no warnings", () => {
    const files = readdirSync(PILOTS)
      .filter((n) => /^graft\..+\.yaml$/.test(n))
      .sort();
    expect(files).toEqual(["graft.library.yaml", "graft.platform.yaml", "graft.service.yaml"]);
    for (const f of files) {
      const text = readFileSync(path.join(PILOTS, f), "utf8");
      expect(text.split("\n")[0], f).toMatch(/^# yaml-language-server: \$schema=/);
      const res = parsePolicyText(Buffer.from(text));
      expect(res.ok, f).toBe(true);
      if (res.ok) expect(res.warnings, f).toEqual([]);
    }
  });

  it("U-DOC-2 every relative link of the onboarding doc exists and every command of the spec appears", () => {
    const file = path.join(PILOTS, "onboarding.md");
    const text = readFileSync(file, "utf8");
    const links = [...text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)(?:#[^)]*)?\)/g)].map(
      (m) => m[1] as string,
    );
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) {
      expect(existsSync(path.resolve(path.dirname(file), link)), link).toBe(true);
    }
    for (const cmd of [
      "pnpm graft pilot doctor",
      "pnpm graft pilot sync-reviewers",
      "pnpm graft pilot purge",
      "pnpm graft baseline",
      "pnpm graft gate report",
      "pnpm graft metrics rollup",
      "pnpm graft incident add",
      "pnpm graft incident list",
      "pnpm graft incident remove",
    ]) {
      expect(text, cmd).toContain(cmd);
    }
    // The section order of the spec (T1).
    const headings = [...text.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
    expect(headings.map((h) => h.split(".")[0])).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
    // T1, section 3: the retention of webhook payloads is stated accurately.
    expect(text).toMatch(/1 hour after it completes or finally fails/);
    expect(text).not.toMatch(/until 7 days after their job finishes/);
  });
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repoWithHook(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "graft-hook-"));
  dirs.push(dir);
  git(dir, {}, "init", "-q", "-b", "main");
  copyFileSync(HOOK, path.join(dir, ".git/hooks/prepare-commit-msg"));
  spawnSync("chmod", ["+x", path.join(dir, ".git/hooks/prepare-commit-msg")]);
  return dir;
}

function git(dir: string, env: Record<string, string>, ...argv: string[]) {
  const res = spawnSync("git", argv, {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
      ...env,
    },
  });
  expect(res.status, `git ${argv.join(" ")}: ${res.stderr}`).toBe(0);
  return res.stdout;
}

const message = (dir: string) => git(dir, {}, "log", "-1", "--format=%B").trimEnd();
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("prepare-commit-msg hook", () => {
  it("U-HOOK-1 adds the trailers once, and an amend does not duplicate them", () => {
    const dir = repoWithHook();
    const env = { GRAFT_AGENT: "claude-code", GRAFT_TASK: "#4" };
    git(dir, env, "commit", "-q", "--allow-empty", "-m", "x");
    const first = message(dir);
    expect(first.split("\n")[0]).toBe("x");
    expect(occurrences(first, "Graft-Agent: claude-code")).toBe(1);
    expect(occurrences(first, "Graft-Task: #4")).toBe(1);
    expect(first).not.toContain("Graft-Model");
    expect(first).not.toContain("Graft-Session");

    git(
      dir,
      { ...env, GRAFT_MODEL: "claude-sonnet-5-5" },
      "commit",
      "-q",
      "--amend",
      "--no-edit",
      "--allow-empty",
    );
    const amended = message(dir);
    expect(occurrences(amended, "Graft-Agent: claude-code")).toBe(1);
    expect(occurrences(amended, "Graft-Task: #4")).toBe(1);
    // A variable that is new on the amend is still added, once.
    expect(occurrences(amended, "Graft-Model: claude-sonnet-5-5")).toBe(1);
  });

  it("U-HOOK-2 does nothing without GRAFT_AGENT, and not for a merge commit", () => {
    const dir = repoWithHook();
    git(dir, {}, "commit", "-q", "--allow-empty", "-m", "plain");
    expect(message(dir)).toBe("plain");
    git(
      dir,
      { GRAFT_AGENT: "", GRAFT_TASK: "#9" },
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "empty agent",
    );
    expect(message(dir)).toBe("empty agent");

    git(dir, {}, "checkout", "-q", "-b", "side");
    git(dir, {}, "commit", "-q", "--allow-empty", "-m", "on side");
    git(dir, {}, "checkout", "-q", "main");
    git(dir, {}, "commit", "-q", "--allow-empty", "-m", "on main");
    git(dir, { GRAFT_AGENT: "claude-code" }, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    expect(message(dir)).toBe("merge side");
  });
});
