/** s10: GitHub redelivers PR 1's `opened` webhook; Graft treats it as a duplicate. */
import { readFile } from "node:fs/promises";
import { sql } from "kysely";
import { type DeliveryItem, findPrDelivery } from "../hooks.js";
import { changeRow, graftChecks, prComments } from "../observe.js";
import { ref, type Step, type StepCtx } from "../plan.js";
import type { AssertionResult } from "../report-schema.js";
import { TIMEOUTS } from "../waiters.js";
import { assertion, type EvalEnv, type PlanContext, type ScenarioDef, truthy } from "./common.js";
import { envOfCtx } from "./env.js";

export type Fingerprint = Record<string, unknown>;

/**
 * Clock-driven queues: the crons and the jobs they fan out to. A cron firing inside the window
 * (the feedback sweep runs every 15 minutes and sends one `intent.feedback.poll` per carded
 * change, PR 1's included) is not something the redelivery caused.
 */
const CRON_QUEUES = [
  "intent.feedback.sweep",
  "intent.feedback.poll",
  "pilot.metrics.rollup",
  "modes.apply",
  "installations.refresh_permissions_all",
  "installations.refresh_permissions",
];
/** A vote recorded by a feedback poll syncs reviewers under this hourly key (pilot/reviewers.ts). */
const VOTE_SYNC_KEY = "rev-sync:%";

/** What must not change. `withDeliveryCounts` is false when the redelivery has a new guid. */
export async function fingerprint(
  sx: StepCtx,
  o: { prNumber: number; since: Date; withDeliveryCounts: boolean },
): Promise<Fingerprint> {
  const { run } = sx;
  const fp: Fingerprint = {};
  const ch = await changeRow(run, o.prNumber);
  const schema = run.config.pgbossSchema;
  if (o.withDeliveryCounts) {
    // Only the opened deliveries (and their jobs) created since the redelivery: late check_run
    // deliveries of earlier scenarios, and pg-boss deleting old jobs, are not Graft's doing.
    const d = await run.db
      .selectFrom("webhook_deliveries")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("installation_id", "=", run.installationId)
      .where("event", "=", "pull_request")
      .where("action", "=", "opened")
      .where("received_at", ">=", o.since)
      .executeTakeFirst();
    fp.deliveriesSince = Number(d?.n ?? 0);
    const j = await sql<{ n: string }>`
      select count(*)::text as n from ${sql.table(`${schema}.job`)}
      where name = 'github.webhook' and data->>'installationId' = ${String(run.installationId)}
        and data->>'event' = 'pull_request' and data->>'action' = 'opened'
        and created_on >= ${o.since}`.execute(run.db);
    fp.webhookJobsSince = Number(j.rows[0]?.n ?? 0);
  }
  if (ch) {
    const count = async (
      table: "intent_cards" | "intent_displays" | "policy_verdicts" | "intent_spend",
    ) => {
      const r = await run.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("change_id", "=", ch.id)
        .executeTakeFirst();
      return Number(r?.n ?? 0);
    };
    fp.cards = await count("intent_cards");
    fp.displays = await count("intent_displays");
    fp.verdicts = await count("policy_verdicts");
    fp.spend = await count("intent_spend");
    const p = await run.db
      .selectFrom("change_provenance")
      .select("updated_at")
      .where("change_id", "=", ch.id)
      .executeTakeFirst();
    fp.provenanceUpdatedAt = p?.updated_at.toISOString() ?? null;
    const comments = await prComments(run, o.prNumber);
    fp.commentUpdatedAt = comments.find((c) => c.id === ch.graft_comment_id)?.updated_at ?? null;
    const checks = await graftChecks(run, ch.head_sha);
    fp.checks = checks.map((c) => `${c.id}:${c.completedAt ?? ""}`).sort();
  }
  // Per queue, so that a failure names the job that appeared.
  const jobs = await sql<{ name: string; n: string }>`
    select name, count(*)::text as n from ${sql.table(`${schema}.job`)}
    where created_on >= ${o.since}
      and name <> 'github.webhook' and name <> all(${sql.val(CRON_QUEUES)}::text[])
      and data->>'installationId' = ${String(run.installationId)}
      and not (name = 'pilot.reviewers.sync' and coalesce(singleton_key, '') like ${VOTE_SYNC_KEY})
    group by name order by name`.execute(run.db);
  fp.jobsSince = jobs.rows.map((r) => `${r.name}:${r.n}`);
  return fp;
}

export interface S10Obs {
  attempt: { redelivery: boolean; statusCode: number; sameGuid: boolean } | null;
  fingerprintStable: boolean;
  changed: string[];
  /** For each changed key: its value before the redelivery and the first different value seen. */
  changes?: Record<string, { before: unknown; after: unknown }>;
  /** With --server-log: a duplicate line for the original guid was found (null: not checked). */
  logDuplicate: boolean | null;
}

export function evaluateS10(o: S10Obs, _env: EvalEnv): AssertionResult[] {
  return [
    assertion(
      "system",
      "s10.attempt",
      { redelivery: true, status: "2xx" },
      o.attempt,
      Boolean(o.attempt?.redelivery && o.attempt.statusCode >= 200 && o.attempt.statusCode < 300),
    ),
    assertion(
      "system",
      "s10.stable",
      "the fingerprint does not change over the window",
      o.changed.length === 0 ? "unchanged" : { changed: o.changed, values: o.changes ?? {} },
      o.fingerprintStable,
    ),
    ...(o.logDuplicate === null
      ? []
      : [
          truthy(
            "system",
            "s10.log.duplicate",
            "the server log shows outcome duplicate",
            o.logDuplicate,
          ),
        ]),
  ];
}

export function diffFingerprints(a: Fingerprint, b: Fingerprint): string[] {
  return Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

async function serverLogHasDuplicate(file: string, guid: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    if (!line.includes(guid)) continue;
    try {
      const o = JSON.parse(line) as { deliveryId?: string; outcome?: string };
      if (o.deliveryId === guid && o.outcome === "duplicate") return true;
    } catch {
      // not a JSON line
    }
  }
  return false;
}

export const s10: ScenarioDef = {
  id: "s10",
  title: "Webhook redelivery",
  needs: ["s01"],
  modelRuns: 0,
  plan(_pc: PlanContext): Step[] {
    return [
      {
        kind: "custom",
        id: "s10.find",
        describe: "find PR 1's pull_request.opened delivery in GitHub's delivery log",
        run: async (sx) => {
          const pr1 = sx.scope.require<{ number: number }>("s01.pr").number;
          const d = await findPrDelivery(sx.run.clients.app, {
            event: "pull_request",
            action: "opened",
            installationId: sx.run.installationId,
            repositoryId: sx.run.repositoryId,
            prNumber: pr1,
            redelivery: false,
          });
          if (!d) throw new Error("PR 1's opened delivery is not in the delivery log");
          sx.scope.set("s10.delivery", { id: d.id, guid: d.guid });
        },
      },
      {
        kind: "wait",
        id: "s10.quiet",
        name: "stability",
        timeoutMs: 180_000,
        describe: "nothing has changed PR 1 for a quiet window",
        probe: async (sx) => {
          const pr1 = sx.scope.require<{ number: number }>("s01.pr").number;
          const since = new Date(sx.run.clock.now());
          const fp = await fingerprint(sx, { prNumber: pr1, since, withDeliveryCounts: false });
          const mem = sx.scope.get<{ fp: Fingerprint; at: number }>("s10.quietMemo");
          const now = sx.run.clock.now();
          if (!mem || diffFingerprints(mem.fp, fp).length > 0) {
            sx.scope.set("s10.quietMemo", { fp, at: now });
            sx.note({ restarted: true });
            return false;
          }
          const windowMs = Math.round(15_000 * sx.run.opts.timeoutScale);
          sx.note({ quietForMs: now - mem.at, windowMs });
          return now - mem.at >= windowMs;
        },
      },
      {
        kind: "custom",
        id: "s10.fp0",
        describe: "fingerprint before the redelivery",
        run: async (sx) => {
          const pr1 = sx.scope.require<{ number: number }>("s01.pr").number;
          const since = sx.run.deps.now();
          sx.scope.set("s10.since", since.toISOString());
          sx.scope.set(
            "s10.fp0",
            await fingerprint(sx, { prNumber: pr1, since, withDeliveryCounts: true }),
          );
        },
      },
      {
        kind: "act",
        id: "s10.redeliver",
        act: { act: "redeliver", delivery: ref("s10.delivery") },
      },
      {
        kind: "wait",
        id: "s10.attempt",
        name: "redelivery",
        timeoutMs: TIMEOUTS.redelivery,
        describe: "the delivery log lists a newer attempt",
        probe: async (sx) => {
          const pr1 = sx.scope.require<{ number: number }>("s01.pr").number;
          const original = sx.scope.require<{ id: number; guid: string }>("s10.delivery");
          const d: DeliveryItem | null = await findPrDelivery(sx.run.clients.app, {
            event: "pull_request",
            action: "opened",
            installationId: sx.run.installationId,
            repositoryId: sx.run.repositoryId,
            prNumber: pr1,
            redelivery: true,
            exceptId: original.id,
          });
          sx.note({ found: d !== null });
          if (!d) return false;
          sx.scope.set("s10.attemptItem", {
            redelivery: d.redelivery,
            statusCode: d.statusCode,
            sameGuid: d.guid === original.guid,
          });
          return true;
        },
      },
      {
        kind: "custom",
        id: "s10.window",
        describe: "stability window: the fingerprint does not change",
        run: async (sx) => {
          const pr1 = sx.scope.require<{ number: number }>("s01.pr").number;
          const attempt = sx.scope.require<{ sameGuid: boolean }>("s10.attemptItem");
          const since = new Date(sx.scope.require<string>("s10.since"));
          const withCounts = attempt.sameGuid;
          const baseline = await fingerprint(sx, {
            prNumber: pr1,
            since,
            withDeliveryCounts: withCounts,
          });
          const fp0 = sx.scope.require<Fingerprint>("s10.fp0");
          const expected: Fingerprint = {};
          for (const [k, v] of Object.entries(fp0)) {
            if (withCounts || (k !== "deliveriesSince" && k !== "webhookJobsSince"))
              expected[k] = v;
          }
          const changes: Record<string, { before: unknown; after: unknown }> = {};
          const record = (next: Fingerprint) => {
            for (const k of diffFingerprints(expected, next)) {
              changes[k] ??= { before: expected[k] ?? null, after: next[k] ?? null };
            }
          };
          record(baseline);
          const windowMs = Math.round(TIMEOUTS.stability * sx.run.opts.timeoutScale);
          const step = Math.max(250, Math.min(5000, Math.round(windowMs / 6)));
          const end = sx.run.clock.now() + windowMs;
          while (sx.run.clock.now() < end) {
            await sx.run.clock.sleep(Math.min(step, Math.max(end - sx.run.clock.now(), 1)));
            const next = await fingerprint(sx, {
              prNumber: pr1,
              since,
              withDeliveryCounts: withCounts,
            });
            record(next);
          }
          sx.scope.set("s10.changed", Object.keys(changes));
          sx.scope.set("s10.changes", changes);
        },
      },
      {
        kind: "custom",
        id: "s10.log",
        describe: "look for the duplicate line in the server log",
        run: async (sx) => {
          const file = sx.run.opts.serverLog;
          const original = sx.scope.require<{ guid: string }>("s10.delivery");
          sx.scope.set(
            "s10.logDuplicate",
            file === undefined ? null : await serverLogHasDuplicate(file, original.guid),
          );
        },
      },
      {
        kind: "assert",
        id: "s10.assert",
        evaluate: (sx) => {
          const changed = sx.scope.require<string[]>("s10.changed");
          return evaluateS10(
            {
              attempt: sx.scope.get<S10Obs["attempt"]>("s10.attemptItem") ?? null,
              fingerprintStable: changed.length === 0,
              changed,
              changes: sx.scope.get<S10Obs["changes"]>("s10.changes") ?? {},
              logDuplicate: sx.scope.get<boolean | null>("s10.logDuplicate") ?? null,
            },
            envOfCtx(sx.run),
          );
        },
      },
    ];
  },
};
