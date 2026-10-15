/**
 * `e2e-runs/<runId>/state.json` (T13): written atomically after every step, mode 0600, in a
 * directory with mode 0700. It holds ids, shas, counts and sentinels; never a secret or PR text.
 */
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../pilot/atomic-write.js";
import { assumptionSchema, type ScenarioResult, scenarioResultSchema } from "./report-schema.js";
import type { SecretRegistry } from "./secrets.js";

export const stateSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  target: z.enum(["github", "offline"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  sandbox: z.object({
    repo: z.string(),
    visibility: z.enum(["private", "public"]),
    outsiderMode: z.enum(["collaborator", "fork", "none"]),
    installationId: z.number(),
    repositoryId: z.number(),
  }),
  actor: z.object({ login: z.string(), id: z.number() }),
  outsider: z.object({ login: z.string(), id: z.number() }).nullable(),
  options: z.object({
    interactive: z.boolean(),
    dryRun: z.boolean(),
    lenientModel: z.boolean(),
    maxCostUsd: z.number(),
    estimateUsd: z.number(),
    llmFlag: z.enum(["auto", "live", "none"]),
    waitCron: z.boolean(),
    withSourceBaseline: z.boolean(),
  }),
  graft: z.object({
    appId: z.number(),
    gitCommit: z.string(),
    dirty: z.boolean(),
    promptVersion: z.string(),
    pricingVerifiedAt: z.string(),
  }),
  llmMode: z.enum(["live", "none"]).nullable(),
  /** Values stored by steps, keyed `s01.pr`, `s01.comment`, ... */
  scope: z.record(z.string(), z.unknown()),
  sentinels: z.record(
    z.string(),
    z.object({ T: z.string(), B: z.string(), C: z.string(), D: z.string() }),
  ),
  issueNumber: z.number().nullable(),
  scenarios: z.array(scenarioResultSchema),
  /** Assumption evidence collected by probes and scenarios, keyed by assumption id. */
  evidence: z.record(z.string(), z.unknown()),
  sentinelHits: z.array(
    z.object({
      scenario: z.string(),
      kind: z.string(),
      table: z.string(),
      key: z.string(),
      class: z.enum(["echo", "accounted", "fail"]),
      deadline: z.string().optional(),
    }),
  ),
  /** When the last webhook delivery of the run was seen (verify --after-retention). */
  lastDeliveryAt: z.string().nullable(),
  spentUsd: z.number(),
  tokens: z.number(),
  assumptions: z.array(assumptionSchema),
  exitCode: z.number().int().nullable(),
});
export type RunState = z.infer<typeof stateSchema>;
export type { ScenarioResult };

export const runDirOf = (outDir: string, runId: string): string => path.join(outDir, runId);

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function saveState(
  outDir: string,
  state: RunState,
  secrets: SecretRegistry,
): Promise<void> {
  const dir = runDirOf(outDir, state.runId);
  await ensureDir(outDir);
  await ensureDir(dir);
  await writeFileAtomic(
    path.join(dir, "state.json"),
    `${secrets.redact(JSON.stringify(state, null, 2))}\n`,
  );
}

export async function loadState(outDir: string, runId: string): Promise<RunState | null> {
  try {
    const text = await readFile(path.join(runDirOf(outDir, runId), "state.json"), "utf8");
    return stateSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The newest run directory (by name: run ids start with the date; ties by mtime). */
export async function newestRunId(outDir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    return null;
  }
  const runs: { name: string; mtime: number }[] = [];
  for (const name of names) {
    if (!/^e2e-\d{8}-[a-z2-7]{6}$/.test(name)) continue;
    try {
      const s = await stat(path.join(outDir, name, "state.json"));
      runs.push({ name, mtime: s.mtimeMs });
    } catch {
      // not a run directory
    }
  }
  runs.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  return runs[0]?.name ?? null;
}

/** `e2e-YYYYMMDD-xxxxxx`: six random base32 characters. */
export function newRunId(now: Date, random: (n: number) => Uint8Array): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = random(6);
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += alphabet[(bytes[i] as number) % 32];
  return `e2e-${ymd}-${suffix}`;
}
