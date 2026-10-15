/**
 * The real `GitPusher` (D2): `git clone --depth 1` of the public source, drop `.git` and the CI
 * directories, overlay the sandbox files, one commit, `git push` with a credential helper that
 * reads the token from the child's environment (never from argv, a URL or a file).
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MARKER_PATH } from "./guard.js";
import type { E2eDeps, GitPusher } from "./types.js";

/**
 * Askpass program for the push: prints the user name or the token (from the child environment).
 * No credential helper is used, and the token is in neither argv nor a URL nor a config file.
 */
export const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) echo x-access-token ;;
  *) echo "$GRAFT_E2E_GIT_TOKEN" ;;
esac
`;

/** Every git child ignores the user's and the system's git configuration. */
export const GIT_ISOLATION: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** The subcommand of a git argv: the first word that is not an option or a `-c` value. */
export function gitSubcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-c") {
      i++;
      continue;
    }
    if (!a.startsWith("-")) return a;
  }
  return "";
}

export class LfsRefused extends Error {
  constructor() {
    super("the source repository uses Git LFS");
    this.name = "LfsRefused";
  }
}

export function createGitPusher(spawn: E2eDeps["spawn"]): GitPusher {
  const git = async (args: string[], o: { cwd?: string; env?: Record<string, string> } = {}) => {
    const res = await spawn("git", args, { ...o, env: { ...GIT_ISOLATION, ...(o.env ?? {}) } });
    if (res.code !== 0) {
      // Never echo git's output: it can name URLs and paths.
      throw new Error(`git ${gitSubcommand(args)} failed (exit ${res.code})`);
    }
    return res.stdout;
  };
  return {
    async copyAndPush(o) {
      const root = await mkdtemp(path.join(os.tmpdir(), "graft-e2e-"));
      await chmod(root, 0o700);
      try {
        const dir = path.join(root, "tree");
        // Anonymous: the source is public, and no credential helper may answer.
        await git(
          [
            "-c",
            "credential.helper=",
            "clone",
            "--depth",
            "1",
            "--quiet",
            `https://github.com/${o.source}.git`,
            dir,
          ],
          {},
        );
        const sourceCommit = (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
        const attributes = await readFile(path.join(dir, ".gitattributes"), "utf8").catch(() => "");
        if (/filter=lfs/.test(attributes)) throw new LfsRefused();
        await rm(path.join(dir, ".git"), { recursive: true, force: true });
        for (const d of o.drop) await rm(path.join(dir, d), { recursive: true, force: true });
        const overlay = new Map(o.files);
        overlay.set(MARKER_PATH, `${o.marker(sourceCommit)}\n`);
        for (const [rel, text] of overlay) {
          const file = path.join(dir, rel);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, text);
        }
        await git(["init", "--quiet", "-b", "main"], { cwd: dir });
        await git(["add", "-A"], { cwd: dir });
        await git(
          [
            "-c",
            "user.name=Graft E2E",
            "-c",
            "user.email=graft-e2e@users.noreply.github.com",
            "commit",
            "--quiet",
            "-m",
            o.message,
          ],
          { cwd: dir },
        );
        const askpass = path.join(root, "askpass.sh");
        await writeFile(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
        await git(
          [
            "-c",
            "credential.helper=",
            "push",
            "--quiet",
            `https://github.com/${o.sandbox}.git`,
            "main:main",
          ],
          { cwd: dir, env: { GRAFT_E2E_GIT_TOKEN: o.token, GIT_ASKPASS: askpass } },
        );
        return { sourceCommit };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
