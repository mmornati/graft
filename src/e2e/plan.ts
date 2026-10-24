/**
 * Plans as data (D16, T8). A scenario is a list of steps (`act`, `wait`, `observe`, `assert`,
 * `manual`, `ops`). The executor runs them; `--dry-run` prints acts, waits, manual steps and ops
 * instead of performing them, so the dry run matches the real run exactly.
 */

import type { FileChange } from "./fixtures.js";
import type { AssertionResult } from "./report-schema.js";
import type { RunCtx } from "./types.js";

export interface Ref {
  $ref: string;
}
export const ref = (key: string): Ref => ({ $ref: key });
export const isRef = (v: unknown): v is Ref =>
  typeof v === "object" && v !== null && typeof (v as Ref).$ref === "string";
export type Or<T> = T | Ref;

export type ActClient = "actor" | "outsider";

export type Act =
  | { act: "createIssue"; client: "actor"; title: string; body: string; labels: string[] }
  | {
      act: "commit";
      client: ActClient;
      branch: string;
      /** `main`: branch from main's tip; `branch`: append to the branch's tip. */
      from: "main" | "branch";
      message: string;
      changes: FileChange[];
      /** Reuse the tree and parents of this commit (a rewritten commit with the same tree). */
      sameTreeAs?: Ref;
      /** Move the branch back to this commit; no commit is created. */
      resetTo?: Ref;
      force?: boolean;
    }
  | {
      act: "openPr";
      client: ActClient;
      head: string;
      title: string;
      body: string;
      draft?: boolean;
      labels: string[];
    }
  | { act: "markReady"; pr: Ref }
  | { act: "react"; client: ActClient; comment: Ref; content: "+1" | "-1" }
  | { act: "requestReviewers"; client: ActClient; pr: Ref; reviewers: Or<string>[] }
  | { act: "review"; client: ActClient; pr: Ref; event: "APPROVE" | "COMMENT" }
  /** Phase 1 step 7 (D21): the actor adds one label to a run PR (e01's break-glass). */
  | { act: "addLabel"; client: "actor"; pr: Ref; label: string }
  | { act: "pushMain"; fixture: string; message: string; skipIfSame?: boolean }
  | { act: "redeliver"; delivery: Ref }
  | { act: "fork"; client: "outsider" }
  | { act: "syncFork"; client: "outsider" };

export interface StepCtx {
  run: RunCtx;
  scope: Scope;
  scenario: string;
  /** A wait probe records what it saw last; a timeout puts it in the report. */
  note(observation: unknown): void;
}

export type Probe = (sx: StepCtx) => Promise<unknown>;

export type Step =
  | { kind: "act"; id: string; key?: string; act: Act; always?: boolean }
  | {
      kind: "wait";
      id: string;
      name: string;
      timeoutMs: number;
      /** Per LLM mode, once it is known (live waits for the model, none does not). */
      timeoutByMode?: { live: number; none: number };
      describe: string;
      probe: Probe;
      key?: string;
      always?: boolean;
    }
  | { kind: "observe"; id: string; key: string; collect: (sx: StepCtx) => Promise<unknown> }
  | { kind: "assert"; id: string; evaluate: (sx: StepCtx) => AssertionResult[] }
  | {
      kind: "manual";
      id: string;
      instruction: string;
      /** Runs after the human confirmed (it may ask a follow-up question and store the answer). */
      run: (sx: StepCtx, answer: string) => Promise<void>;
      question: string;
    }
  | {
      kind: "ops";
      id: string;
      argv: string[];
      /** True for the commands that write (never run by a dry run). */
      writes: boolean;
      key: string;
      baselineToken?: boolean;
    }
  | { kind: "custom"; id: string; describe: string; run: (sx: StepCtx) => Promise<void> };

/** Values produced by steps, keyed `sNN.name`; persisted in `state.json`. */
export class Scope {
  constructor(private readonly values: Record<string, unknown>) {}

  get<T = unknown>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }

  require<T = unknown>(key: string): T {
    if (!(key in this.values)) throw new Error(`plan error: ${key} is not set`);
    return this.values[key] as T;
  }

  set(key: string, value: unknown): void {
    this.values[key] = value;
  }

  has(key: string): boolean {
    return key in this.values;
  }

  /** Replaces every `$ref` inside `v` (strings, arrays and plain objects) by its value. */
  resolve<T>(v: T): T {
    return this.walk(v, (r) => this.requireRef(r.$ref)) as T;
  }

  /** Like `resolve`, but unset refs become `<key>` placeholders (the dry run). */
  placeholders<T>(v: T): T {
    return this.walk(v, (r) => (this.has(r.$ref) ? this.requireRef(r.$ref) : `<${r.$ref}>`)) as T;
  }

  private requireRef(key: string): unknown {
    // `s01.pr.number` reads a field of a stored object.
    const direct = this.values[key];
    if (direct !== undefined) return direct;
    const parts = key.split(".");
    for (let i = parts.length - 1; i >= 1; i--) {
      const head = parts.slice(0, i).join(".");
      if (head in this.values) {
        let cur: unknown = this.values[head];
        for (const p of parts.slice(i)) cur = (cur as Record<string, unknown> | undefined)?.[p];
        if (cur !== undefined) return cur;
      }
    }
    throw new Error(`plan error: ${key} is not set`);
  }

  private walk(v: unknown, onRef: (r: Ref) => unknown): unknown {
    if (isRef(v)) return onRef(v);
    // `{{key}}` inside a string is replaced by the stored value (the run's issue number).
    if (typeof v === "string") {
      return v.replace(/\{\{([\w.]+)\}\}/g, (_m, k: string) => String(onRef({ $ref: k })));
    }
    if (Array.isArray(v)) return v.map((x) => this.walk(x, onRef));
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.walk(x, onRef)]));
    }
    return v;
  }

  toJSON(): Record<string, unknown> {
    return this.values;
  }
}

/** One line per step for `--dry-run` and the plan snapshot. */
export function describeStep(step: Step, scope: Scope): string {
  switch (step.kind) {
    case "act": {
      const { act, ...rest } = scope.placeholders(step.act) as Act & Record<string, unknown>;
      const params = Object.entries(rest)
        .filter(([k]) => k !== "changes" && k !== "message" && k !== "body" && k !== "title")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      return `act   ${step.id} ${act} ${params}`.trimEnd();
    }
    case "wait":
      return `wait  ${step.id} ${step.name} (${Math.round(step.timeoutMs / 1000)}s): ${step.describe}`;
    case "observe":
      return `see   ${step.id} -> ${step.key}`;
    case "assert":
      return `check ${step.id}`;
    case "manual":
      return `human ${step.id}: ${step.instruction}`;
    case "ops":
      return `ops   ${step.id} graft ${step.argv.join(" ")}${step.writes ? " (writes)" : ""}`;
    case "custom":
      return `step  ${step.id}: ${step.describe}`;
  }
}

/** Steps that change something on GitHub or in Graft's database: what a dry run never performs. */
export const performsWrite = (step: Step): boolean =>
  step.kind === "act" || (step.kind === "ops" && step.writes);
