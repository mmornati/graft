/** Loading `e2e/sandboxes.json` (zod-validated; refusals are in guard.ts). */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSandboxConfig, type SandboxConfig, SandboxConfigError } from "./guard.js";

export const SANDBOXES_FILE = path.join("e2e", "sandboxes.json");

export async function loadSandboxConfig(rootDir: string): Promise<SandboxConfig> {
  let text: string;
  try {
    text = await readFile(path.join(rootDir, SANDBOXES_FILE), "utf8");
  } catch {
    throw new SandboxConfigError("e2e/sandboxes.json cannot be read");
  }
  return parseSandboxConfig(text);
}
