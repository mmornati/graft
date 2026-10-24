/**
 * Fixture edits (T9). Every edit is a pure function of the base text with a precondition: a
 * failed precondition fails the scenario with "fixture drift: run setup --yes".
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type EditOp =
  | { op: "replace"; from: string; to: string }
  | { op: "appendLine"; line: string }
  | { op: "create"; content: string }
  | { op: "fixtureFile"; name: string };

export interface FileChange {
  path: string;
  ops: EditOp[];
}

export class FixtureDrift extends Error {
  constructor(readonly file: string) {
    super(`fixture drift in ${file}: run setup --yes`);
    this.name = "FixtureDrift";
  }
}

export function applyOps(
  file: string,
  base: string | null,
  ops: readonly EditOp[],
  fixtureFile: (name: string) => string,
): string {
  let text = base;
  for (const op of ops) {
    switch (op.op) {
      case "create":
        if (text !== null) throw new FixtureDrift(file);
        text = op.content;
        break;
      case "fixtureFile":
        text = fixtureFile(op.name);
        break;
      case "replace":
        if (text === null || !text.includes(op.from)) throw new FixtureDrift(file);
        text = text.replace(op.from, () => op.to);
        break;
      case "appendLine":
        if (text === null) throw new FixtureDrift(file);
        text = `${text.endsWith("\n") ? text : `${text}\n`}${op.line}\n`;
        break;
    }
  }
  if (text === null) throw new FixtureDrift(file);
  return text;
}

export const GUIDE = "graft-e2e/docs/guide.md";
export const PACE = "graft-e2e/src/pace.py";
export const ZONES = "graft-e2e/src/zones.py";
export const POLICY_FILE = "graft.yaml";

export const AGENT_NAME = "claude-code";
export const AGENT_MODEL = "claude-sonnet-5-5";

export function agentTrailers(issue: number): [string, string][] {
  return [
    ["Graft-Agent", AGENT_NAME],
    ["Graft-Model", AGENT_MODEL],
    ["Graft-Task", `#${issue}`],
  ];
}

/** Subject, blank, the sentinel paragraph, blank, then the trailers as the last paragraph. */
export function commitMessageOf(o: {
  subject: string;
  sentinel: string;
  trailers?: readonly [string, string][];
}): string {
  const parts = [o.subject, o.sentinel];
  if (o.trailers && o.trailers.length > 0) {
    parts.push(o.trailers.map(([k, v]) => `${k}: ${v}`).join("\n"));
  }
  return parts.join("\n\n");
}

/** `Graft E2E <id+login@users.noreply.github.com>`: never an @anthropic.com address. */
export function commitIdentity(user: { id: number; login: string }): {
  name: string;
  email: string;
} {
  return { name: "Graft E2E", email: `${user.id}+${user.login}@users.noreply.github.com` };
}

export const CI_WORKFLOW_YAML = [
  "name: graft-e2e",
  "on: workflow_dispatch",
  "jobs:",
  "  noop:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo graft-e2e",
  "",
].join("\n");

export const ciWorkflowPath = (runId: string): string => `.github/workflows/graft-e2e-${runId}.yml`;

// ---------------------------------------------------------------------------------------------
// Files on disk
// ---------------------------------------------------------------------------------------------

export const fixturesDir = (rootDir: string): string => path.join(rootDir, "e2e", "fixtures");

export async function readFixture(rootDir: string, name: string): Promise<string> {
  return readFile(path.join(fixturesDir(rootDir), name), "utf8");
}

/** The fixture directory copied to the sandbox: `graft-e2e/...` path to content. */
export async function readSandboxFixtureTree(rootDir: string): Promise<Map<string, string>> {
  const base = path.join(fixturesDir(rootDir), "sandbox");
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else
        out.set(path.relative(base, full).split(path.sep).join("/"), await readFile(full, "utf8"));
    }
  }
  await walk(base);
  return out;
}

/** The text of every fixture file an edit may name, loaded once. */
export async function loadFixtureFiles(rootDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of ["graft.yaml", "graft.s05.yaml", "graft.s09.yaml", "graft.enforce.yaml"]) {
    files.set(name, await readFixture(rootDir, name));
  }
  return files;
}
