/**
 * Report (T13, §9): `report.json` (zod schema) and `report.md`. Everything goes through `redact`
 * and `toTerminalSafe`. Files are written atomically, mode 0600, in a 0700 directory.
 */
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { toTerminalSafe } from "../eval/terminal.js";
import { writeFileAtomic } from "../pilot/atomic-write.js";
import type { HumanTodoStatus } from "./assumptions.js";
import {
  type AssertionResult,
  type AssumptionResult,
  type Report,
  reportSchema,
  type ScenarioResult,
} from "./report-schema.js";
import type { SecretRegistry } from "./secrets.js";
import type { RunState } from "./state.js";

/** A model assertion that failed under `--lenient-model` is a warning, not a failure. */
export function assertionFails(a: AssertionResult, lenient: boolean): boolean {
  if (a.ok) return false;
  if (a.kind === "soft") return false;
  if (a.kind === "model") return !lenient;
  return true;
}

export function scenarioFails(s: ScenarioResult, lenient: boolean): boolean {
  return (
    s.error !== undefined ||
    s.assertions.some((a) => assertionFails(a, lenient)) ||
    s.invariants.some((i) => i.status === "fail")
  );
}

export function buildReport(
  state: RunState,
  o: {
    assumptions: AssumptionResult[];
    humanTodo: HumanTodoStatus[];
    exitCode: number;
    finishedAt: string;
  },
): Report {
  const planted = Object.keys(state.sentinels).length * 4;
  return reportSchema.parse({
    schemaVersion: 1,
    runId: state.runId,
    startedAt: state.startedAt,
    finishedAt: o.finishedAt,
    mode: {
      target: state.target,
      llm: state.llmMode ?? "none",
      interactive: state.options.interactive,
      dryRun: state.options.dryRun,
      lenientModel: state.options.lenientModel,
    },
    sandbox: state.sandbox,
    graft: state.graft,
    cost: {
      maxUsd: state.options.maxCostUsd,
      estimateUsd: state.options.estimateUsd,
      spentUsd: state.spentUsd,
      tokens: state.tokens,
    },
    scenarios: state.scenarios,
    assumptions: o.assumptions,
    sentinels: { planted, hits: state.sentinelHits },
    humanTodo: o.humanTodo,
    exitCode: o.exitCode,
  });
}

const cell = (v: unknown): string => {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return (text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
};

/** Failure types (§9.5) and where the runbook explains them. */
export const FAILURE_HINTS: Record<string, string> = {
  preflight: "preflight: see runbook section 11, preflight",
  guard_refusal: "guard refusal: a request was refused before it was sent (runbook section 11)",
  no_delivery:
    "no_delivery: check the tunnel, the hook URL and the App's events (runbook section 11)",
  signature: "signature: the server log shows invalid_signature; check the webhook secret",
  card_timeout: "card_timeout: is the worker running? is the LLM slow? is the budget used up?",
  llm_failure: "llm_failure: read the card's failure_reason (runbook section 11)",
  neutral_violation:
    "neutral_violation: a Graft check is not neutral; this is a bug, stop and report it",
  comment_ownership: "comment_ownership: set GITHUB_APP_SLUG and review decision D13",
  sentinel_leak:
    "sentinel_leak: privacy bug; stop, keep the report, purge with pilot purge if needed",
  doctor: "doctor: run pnpm graft pilot doctor and read the failing check",
  permission_403: "permission_403: raise with the product owner before adding a permission (A08)",
  rate_limit: "rate_limit: wait for the reset or lower the request volume",
  model_mismatch: "model_mismatch: look at the card on GitHub; prompt work goes through pnpm eval",
  budget: "budget: raise --max-cost-usd or GRAFT_LLM_DAILY_TOKEN_BUDGET deliberately",
};

/** Which failure types are present in a set of results. */
export function failureTypes(r: Report): string[] {
  const out = new Set<string>();
  for (const s of r.scenarios) {
    if (s.skipReason === "budget") out.add("budget");
    if (s.error) {
      if (s.error.name === "WaitTimeout") {
        out.add(/delivery/.test(s.error.message) ? "no_delivery" : "card_timeout");
      }
      if (s.error.name === "GuardRefusal") out.add("guard_refusal");
      if (s.error.name === "LlmStop") out.add("llm_failure");
    }
    for (const i of s.invariants) {
      if (i.status !== "fail") continue;
      if (i.id === "INV-1") out.add("neutral_violation");
      if (i.id === "INV-2") out.add("comment_ownership");
      if (i.id === "INV-3") out.add("sentinel_leak");
      if (i.id === "INV-4") out.add("doctor");
    }
    if (s.assertions.some((a) => a.kind === "model" && !a.ok)) out.add("model_mismatch");
  }
  for (const a of r.assumptions) {
    if (a.status !== "fail") continue;
    if (a.id === "A01" || a.id === "A02") out.add("comment_ownership");
    if (a.id === "A08") out.add("permission_403");
  }
  return [...out];
}

export function renderMarkdown(r: Report): string {
  const L: string[] = [];
  const seconds = Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000);
  L.push(`# Graft live e2e run ${r.runId}`, "");
  L.push(
    `- Mode: ${r.mode.target}, LLM ${r.mode.llm}${r.mode.interactive ? ", interactive" : ""}${r.mode.dryRun ? ", dry run" : ""}${r.mode.lenientModel ? ", lenient model checks" : ""}`,
    `- Sandbox: ${r.sandbox.repo} (${r.sandbox.visibility}, outsider mode: ${r.sandbox.outsiderMode}), installation ${r.sandbox.installationId}`,
    `- Graft: commit ${r.graft.gitCommit}${r.graft.dirty ? " (dirty)" : ""}, prompt ${r.graft.promptVersion}, prices verified ${r.graft.pricingVerifiedAt}`,
    `- Duration: ${seconds} s. Cost: $${r.cost.spentUsd.toFixed(4)} of $${r.cost.maxUsd.toFixed(2)} (bound $${r.cost.estimateUsd.toFixed(2)}), ${r.cost.tokens} tokens`,
    `- Exit code: ${r.exitCode}`,
    "",
  );

  L.push(
    "## Summary",
    "",
    "| Scenario | Status | PRs | Duration | Cost | Failed assertions |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const s of r.scenarios) {
    const failed = s.assertions.filter((a) => !a.ok && a.kind !== "soft").map((a) => a.id);
    const invFailed = s.invariants.filter((i) => i.status === "fail").map((i) => i.id);
    L.push(
      `| ${s.id} ${cell(s.title)} | ${s.status}${s.skipReason ? ` (${s.skipReason})` : ""} | ${
        s.prs.map((p) => `[#${p.number}](${p.url})`).join(" ") || "-"
      } | ${Math.round(s.durationMs / 1000)} s | $${s.costUsd.toFixed(4)} | ${cell([...failed, ...invFailed].join(", ") || "-")} |`,
    );
  }
  L.push("");

  for (const s of r.scenarios) {
    L.push(`## ${s.id}: ${cell(s.title)}`, "");
    if (s.status === "skipped") {
      L.push(`Skipped: ${s.skipReason ?? "not selected"}.`, "");
      continue;
    }
    if (s.error) L.push(`Error: ${cell(s.error.name)}: ${cell(s.error.message)}`, "");
    L.push(
      "| Assertion | Kind | Expected | Observed | Result |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const a of s.assertions) {
      const result = a.ok
        ? "ok"
        : a.kind === "soft"
          ? "WARN"
          : a.kind === "model" && r.mode.lenientModel
            ? "WARN"
            : "FAIL";
      L.push(`| ${a.id} | ${a.kind} | ${cell(a.expected)} | ${cell(a.observed)} | ${result} |`);
    }
    L.push("", "| Invariant | Status | Detail |", "| --- | --- | --- |");
    for (const i of s.invariants) L.push(`| ${i.id} | ${i.status} | ${cell(i.detail)} |`);
    L.push("");
  }

  L.push("## Assumptions", "", "| Id | Anchor | Status | Evidence |", "| --- | --- | --- | --- |");
  for (const a of r.assumptions) {
    L.push(`| ${a.id} | ${a.anchor ?? "-"} | ${a.status} | ${cell(a.evidence)} |`);
  }
  L.push("");

  const by = (c: string) => r.sentinels.hits.filter((h) => h.class === c).length;
  L.push(
    "## Sentinels",
    "",
    `Planted ${r.sentinels.planted}. Hits: echo ${by("echo")}, accounted ${by("accounted")}, fail ${by("fail")}.`,
    "",
  );
  for (const h of r.sentinels.hits.filter((x) => x.class !== "echo")) {
    L.push(
      `- ${h.class}: ${h.scenario} ${h.kind} in ${h.table}.${h.key}${h.deadline ? ` (until ${h.deadline})` : ""}`,
    );
  }
  L.push("");

  L.push("## HUMAN-TODO", "");
  const ready = r.humanTodo.filter((h) => h.resolvable && h.kind === "tick").map((h) => h.anchor);
  const noted = r.humanTodo.filter((h) => h.resolvable && h.kind === "note").map((h) => h.anchor);
  if (ready.length === 0 && noted.length === 0) L.push("No item can be updated from this run.", "");
  else {
    L.push(
      `Items this run proves (their boxes get ticked): ${ready.join(", ") || "none"}.`,
      `Items that are deployment or pilot actions (only an "observed in sandbox" note, box left alone): ${noted.join(", ") || "none"}.`,
      "",
      "```sh",
      `pnpm graft e2e report --run-id ${r.runId} --update-human-todo`,
      "```",
      "",
    );
  }

  L.push("## Skipped", "");
  const skipped = r.scenarios.filter((s) => s.status === "skipped");
  if (skipped.length === 0) L.push("Nothing was skipped.", "");
  else for (const s of skipped) L.push(`- ${s.id}: ${s.skipReason ?? "not selected"}`);
  L.push("");

  L.push("## Next steps", "");
  const types = failureTypes(r);
  if (types.length === 0) L.push("No failure type present.", "");
  else for (const t of types) L.push(`- ${FAILURE_HINTS[t] ?? t}`);
  L.push("");
  return L.join("\n");
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
}

export async function writeReport(
  runDir: string,
  report: Report,
  secrets: SecretRegistry,
): Promise<{ jsonPath: string; mdPath: string; md: string }> {
  await ensurePrivateDir(runDir);
  const json = `${secrets.redact(JSON.stringify(reportSchema.parse(report), null, 2))}\n`;
  const md = toTerminalSafe(secrets.redact(renderMarkdown(report)));
  const jsonPath = path.join(runDir, "report.json");
  const mdPath = path.join(runDir, "report.md");
  await writeFileAtomic(jsonPath, json);
  await writeFileAtomic(mdPath, md);
  return { jsonPath, mdPath, md };
}

// ---------------------------------------------------------------------------------------------
// HUMAN-TODO
// ---------------------------------------------------------------------------------------------

const ITEM_START = /^- \[[ x]\] /;
const VERIFIED = "Verified by live e2e run";
const OBSERVED = "Observed in sandbox on";

export interface TodoUpdate {
  anchor: string;
  /** `tick`: the item is the check. `note`: a deployment or pilot action, never ticked. */
  kind: "tick" | "note";
  assumptions?: readonly string[];
}

/**
 * Ticks every `tick` anchor: the item's `- [ ]` becomes `- [x]` and the anchor line gets
 * "Verified by live e2e run <id> (<date>)". A `note` anchor (an operational action that a sandbox
 * run cannot do) keeps its box and gets "Observed in sandbox on <date> (live e2e run <id>;
 * assumptions ...)". Idempotent; every other byte stays the same.
 */
export function tickHumanTodo(
  text: string,
  updates: readonly TodoUpdate[],
  o: { runId: string; date: string },
): { text: string; ticked: string[]; noted: string[] } {
  const lines = text.split("\n");
  const ticked: string[] = [];
  const noted: string[] = [];
  for (const u of updates) {
    const marker = `<!-- e2e:${u.anchor} -->`;
    const at = lines.findIndex((l) => l.includes(marker));
    if (at < 0) continue;
    const line = lines[at] as string;
    if (line.includes(VERIFIED) || line.includes(OBSERVED)) continue;
    if (u.kind === "tick") {
      let start = at;
      while (start >= 0 && !ITEM_START.test(lines[start] as string)) start--;
      if (start < 0) continue;
      lines[start] = (lines[start] as string).replace(/^- \[ \]/, "- [x]");
      lines[at] = `${lines[at]} ${VERIFIED} ${o.runId} (${o.date}).`;
      ticked.push(u.anchor);
    } else {
      const ids = u.assumptions && u.assumptions.length > 0 ? `; ${u.assumptions.join(", ")}` : "";
      lines[at] =
        `${line} ${OBSERVED} ${o.date} (live e2e run ${o.runId}${ids}); the action above is still to do.`;
      noted.push(u.anchor);
    }
  }
  return { text: lines.join("\n"), ticked, noted };
}

export async function updateHumanTodoFile(
  file: string,
  updates: readonly TodoUpdate[],
  o: { runId: string; date: string },
): Promise<{ ticked: string[]; noted: string[] }> {
  const text = await readFile(file, "utf8");
  const res = tickHumanTodo(text, updates, o);
  if (res.text !== text) await writeFileAtomic(file, res.text);
  return { ticked: res.ticked, noted: res.noted };
}
