/**
 * Cross-module signals (D15). The policy module imports intent and provenance, so they cannot
 * import it back; instead they emit a signal after a successful publish and any module may
 * listen. The registry collects the listeners from the `signalListeners` export of each module.
 */
import type { JobContext } from "./context.js";

export interface ChangeSignal {
  kind: "intent_published" | "provenance_published";
  installationId: number;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  changeId: string;
  headSha: string;
  /** `ctx.clock.now()` in milliseconds at emit. */
  atMs: number;
}

export type SignalListener = (s: ChangeSignal, ctx: JobContext) => Promise<void>;

export interface Signals {
  /** Calls the listeners in order; an error propagates to the caller. */
  emit(s: ChangeSignal, ctx: JobContext): Promise<void>;
}

export function createSignals(listeners: readonly SignalListener[]): Signals {
  const list = [...listeners];
  return {
    async emit(s, ctx) {
      for (const l of list) await l(s, ctx);
    },
  };
}

export const noSignals: Signals = { emit: async () => {} };
